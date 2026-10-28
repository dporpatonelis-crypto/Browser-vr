#!/usr/bin/env python3
"""Small local, disk-backed teacher service; original projects stay read-only."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import mimetypes
import os
import socket
import tempfile
import threading
import uuid
import webbrowser
from datetime import datetime, timezone
from functools import partial
from http.server import BaseHTTPRequestHandler, SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit
from zoneinfo import ZoneInfo

from scripts.build_registry import ROOT, build_and_save
from lesson_records import PlanStore, context_fields, select_materials


def relevant_history(rows, scenario_id, grade='', section=''):
    rows = sorted((r for r in rows if r['scenario_id'] == scenario_id), key=lambda r: (r['created_at'], r['id']), reverse=True)
    latest, scope = None, 'general'
    if grade and section:
        latest = next((r for r in rows if r.get('grade') == grade and r.get('section', '').casefold() == section.casefold()), None)
        if latest:
            scope = 'section'
    if latest is None and grade:
        latest = next((r for r in rows if r.get('grade') == grade), None)
        if latest:
            scope = 'grade'
    if latest is None and rows:
        latest = rows[0]
    return {'records': rows, 'latest': latest, 'scope': scope,
            'summary': {'total': len(rows), 'positive': sum('worked-well' in r['flags'] for r in rows),
                        'increased_difficulty': sum('too-difficult' in r['flags'] for r in rows)}}


class EvaluationStore:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def read(self):
        rows = []
        for f in sorted(self.directory.glob('*.json')):
            try:
                r = json.loads(f.read_text(encoding='utf-8'))
                if not isinstance(r, dict) or not all(k in r for k in ['id', 'created_at', 'scenario_id', 'flags']):
                    raise ValueError('invalid record')
                rows.append(r)
            except (OSError, ValueError) as e:
                raise ValueError(f'Δεν διαβάζεται η καταγραφή {f.name}. Διατηρείται ανέπαφη για ανάκτηση.') from e
        return rows

    def append(self, data, registry, models, plans=None):
        if not isinstance(data, dict):
            raise ValueError('Μη έγκυρη καταγραφή.')
        try:
            request_id = str(uuid.UUID(data.get('request_id', '')))
        except (ValueError, TypeError, AttributeError):
            raise ValueError('Η καταγραφή χρειάζεται έγκυρο μοναδικό αναγνωριστικό.')
        scenario = next((s for s in registry['scenarios'] if s['scenario_id'] == data.get('scenario_id')), None)
        model = next((m for m in models['models'] if m['id'] == data.get('model_id')), None)
        if scenario is None or model is None:
            raise ValueError('Επίλεξε υπάρχον σενάριο και παιδαγωγικό μοντέλο.')
        flags = data.get('flags')
        permitted = {f['id'] for f in models['flags']}
        if not isinstance(flags, list) or not flags or any(not isinstance(f, str) or f not in permitted for f in flags):
            raise ValueError('Επίλεξε τουλάχιστον μία από τις διαθέσιμες επισημάνσεις.')
        grade = data.get('grade') or ''
        section = data.get('section') or ''
        if not isinstance(grade, str) or grade not in ['', *registry['grades']]:
            raise ValueError('Μη έγκυρη τάξη.')
        if not isinstance(section, str) or len(section) > 40 or any(ord(c) < 32 for c in section):
            raise ValueError('Το τμήμα πρέπει να είναι σύντομο, έως 40 χαρακτήρες.')
        if section.strip() and not grade:
            raise ValueError('Επίλεξε τάξη για να καταγραφεί και τμήμα.')
        difficulty = data.get('cognitive_difficulty', scenario.get('cognitive_difficulty'))
        if difficulty is not None and (type(difficulty) is not int or difficulty not in range(1, 6)):
            raise ValueError('Η γνωστική δυσκολία παίρνει τιμές 1–5 ή παραμένει κενή.')
        lesson_plan = plans.version(data['plan_version_id']) if data.get('plan_version_id') and plans else None
        if data.get('plan_version_id') and not lesson_plan:
            raise ValueError('Δεν βρέθηκε το σχέδιο.')
        if lesson_plan and lesson_plan['scenario_id'] != scenario['scenario_id']:
            raise ValueError('Το σχέδιο ανήκει σε άλλο μάθημα.')
        usage_recorded = data.get('media_usage_recorded', False)
        if type(usage_recorded) is not bool or ('used_material_ids' in data and not usage_recorded):
            raise ValueError('Επιβεβαίωσε ποια μέσα χρησιμοποιήθηκαν.')
        used = select_materials(data.get('used_material_ids'), scenario, lesson_plan) if usage_recorded else []
        timestamp = datetime.now(timezone.utc)
        row = {'schema_version': 2, 'id': request_id, 'scenario_id': scenario['scenario_id'], 'scenario_title': scenario['title'],
               'created_at': timestamp.isoformat().replace('+00:00', 'Z'), 'date': timestamp.astimezone(ZoneInfo('Europe/Athens')).date().isoformat(),
               'timezone': 'Europe/Athens', 'grade': grade, 'section': section.strip(),
               'model_id': model['id'], 'model_title': model['title'], 'flags': list(dict.fromkeys(flags)),
               'flag_labels': {f['id']: f['label'] for f in models['flags'] if f['id'] in flags},
               'cognitive_difficulty': difficulty, 'technical_difficulty': scenario.get('technical_difficulty'),
               **context_fields(data), 'media_usage_recorded': usage_recorded, 'used_materials': used,
               'lesson_plan': lesson_plan}
        with self.lock, (self.directory / '.append.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            target = self.directory / f'{request_id}.json'
            if target.exists():
                old = json.loads(target.read_text())
                keys = ['scenario_id', 'grade', 'section', 'model_id', 'flags', 'cognitive_difficulty']
                if any(old[k] != row[k] for k in keys):
                    raise ValueError('Το αναγνωριστικό έχει ήδη χρησιμοποιηθεί για διαφορετική καταγραφή.')
                defaults = {'class_profile':'', 'time_slot':'', 'lesson_date':'', 'media_usage_recorded':False, 'used_materials':[], 'lesson_plan':None}
                if any(old.get(k, default) != row[k] for k, default in defaults.items()):
                    raise ValueError('Το αναγνωριστικό έχει ήδη χρησιμοποιηθεί για διαφορετική καταγραφή.')
                return old, False
            self.write_atomic(target, row)
        return row, True

    @staticmethod
    def write_atomic(target, row):
        fd, temporary = tempfile.mkstemp(prefix='.pending-', dir=target.parent)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                json.dump(row, f, ensure_ascii=False, indent=2)
                f.write('\n')
                f.flush()
                os.fsync(f.fileno())
            os.replace(temporary, target)
            directory_fd = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


class AppHandler(SimpleHTTPRequestHandler):
    """Serve an existing application in its own origin, without editing its build."""
    def __init__(self, *args, root, spa=False, prefix='', **kwargs):
        self.app_root = Path(root).resolve()
        self.spa = spa
        self.prefix = prefix
        super().__init__(*args, directory=str(root), **kwargs)

    def do_GET(self):
        route = unquote(urlsplit(self.path).path)
        if self.prefix and (route == self.prefix or route.startswith(self.prefix + '/')):
            route = route[len(self.prefix):] or '/'
            split = urlsplit(self.path)
            self.path = route + ('?' + split.query if split.query else '')
        if any(part.startswith('.') or part == '..' for part in route.split('/') if part):
            self.send_error(404)
            return
        file = (self.app_root / route.lstrip('/')).resolve()
        if not file.is_relative_to(self.app_root):
            self.send_error(404)
            return
        if self.spa and not file.is_file() and not Path(route).suffix:
            self.path = '/index.html'
        if route != '/' and file.is_file() and file.suffix.lower() in {'.py', '.sh', '.toml', '.env', '.md', '.yml'}:
            self.send_error(404)
            return
        super().do_GET()

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, *args):
        pass


class MissionServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, directory=ROOT, storage=None, refresh=True):
        self.root = Path(directory)
        if refresh:
            build_and_save(self.root)
        self.registry = json.loads((self.root/'public/data/scenario-registry.json').read_text())
        self.models = json.loads((self.root/'public/data/pedagogical-models.json').read_text())
        self.store = EvaluationStore(storage or self.root/'storage/evaluations')
        self.plans = PlanStore(self.store)
        self.preview_servers = {}
        self.preview_lock = threading.Lock()
        self.refresh_lock = threading.Lock()
        self.config = json.loads((self.root/'config.json').read_text())
        self.allowed_hosts = {'localhost', '127.0.0.1', '[::1]'}
        try:
            self.allowed_hosts.update(socket.gethostbyname_ex(socket.gethostname())[2])
        except OSError:
            pass
        super().__init__(address, MissionHandler)

    def launch_url(self, activity, base_url):
        if activity.get('download_only'):
            return activity.get('download_url') or activity.get('url')
        src = next((s for s in self.registry['source_files'] if s['key'] == activity.get('source_key')), None)
        if src is None:
            return activity.get('url')
        app = activity.get('app')
        if app == 'Unity VR':
            raise ValueError('Η αποστολή Unity ανοίγει μέσα από το υπάρχον τοπικό project.')
        path = Path(src['path'])
        if app in {'idea-weaver-board', 'history-explorer-3d'}:
            prepared = self.root/'storage/app-builds'/app
            if app == 'idea-weaver-board' and not (prepared/'index.html').is_file():
                raise ValueError('Άνοιξε το Πιλοτήριο από το start.command για να ετοιμαστεί ο Πίνακας Διερεύνησης.')
            root = prepared if (prepared/'index.html').is_file() else Path(self.config['apps_root'])/app/'dist'
            spa = True
            entry = '/idea-weaver-board/' if app == 'idea-weaver-board' and root != prepared else '/'
        elif app in {'Map-Timeline', 'mind-palace-cases', 'interactive-sculpture'}:
            root = Path(self.config['apps_root'])/app
            spa = False
            entry = '/'
        elif app == 'drive-html':
            root = path.parent
            spa = False
            entry = '/' + quote(path.name)
        else:
            return base_url + src['href']
        if not (root/'index.html').is_file() and app != 'drive-html':
            raise ValueError('Δεν βρέθηκε έτοιμη τοπική εφαρμογή. Χρησιμοποίησε τον υπάρχοντα σύνδεσμο.')
        key = str(root)
        with self.preview_lock:
            if key not in self.preview_servers:
                prefix = '/idea-weaver-board' if entry == '/idea-weaver-board/' else ''
                server = ThreadingHTTPServer((self.server_address[0], 0), partial(AppHandler, root=root, spa=spa, prefix=prefix))
                server.daemon_threads = True
                threading.Thread(target=server.serve_forever, daemon=True).start()
                self.preview_servers[key] = server
            port = self.preview_servers[key].server_port
        hostname = urlsplit(base_url).hostname
        url = f'http://{hostname}:{port}' + entry
        if app == 'interactive-sculpture':
            return url + '?' + urlencode({'scenario': activity['native_id']})
        if app != 'drive-html':
            source_url = base_url + src['href']
            if activity.get('source_module'):
                source_url += '?' + urlencode({'module': activity['source_module']})
            return url + '?' + urlencode({'dataUrl': source_url})
        return url

    def server_close(self):
        for s in self.preview_servers.values():
            s.shutdown()
            s.server_close()
        super().server_close()


class MissionHandler(BaseHTTPRequestHandler):
    server_version = 'TeachingMissionControl/1.0'

    def log_message(self, fmt, *args):
        if self.command != 'GET' or self.path.startswith('/launch/'):
            print(f'[mission] {self.command} {self.path.split("?")[0]} {args[1] if len(args)>1 else ""}', flush=True)

    def body(self, content, content_type='application/json; charset=utf-8', status=200, headers=None):
        if isinstance(content, (dict, list)):
            content = json.dumps(content, ensure_ascii=False).encode('utf-8')
        elif isinstance(content, str):
            content = content.encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(content)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        for k,v in (headers or {}).items():
            self.send_header(k,v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(content)

    def fail(self, text, status=400):
        self.body({'ok': False, 'error': text}, status=status)

    def valid_host(self):
        try:
            return urlsplit('http://' + self.headers.get('Host', '')).hostname in self.server.allowed_hosts
        except ValueError:
            return False

    def do_GET(self):
        if not self.valid_host():
            self.fail('Μη έγκυρη διεύθυνση τοπικής υπηρεσίας.', 403)
            return
        split = urlsplit(self.path)
        path = unquote(split.path)
        query = parse_qs(split.query)
        try:
            if path == '/api/health':
                self.body({'ok': True, 'service':'teaching-mission-control','storage':'disk','schema_version':1})
            elif path == '/api/registry':
                self.body(self.server.registry)
            elif path == '/api/models':
                self.body(self.server.models)
            elif path == '/api/evaluations':
                rows = self.server.store.read()
                sid = query.get('scenario_id', [''])[0]
                self.body(relevant_history(rows, sid, query.get('grade', [''])[0], query.get('section', [''])[0]) if sid else {'records':rows})
            elif path == '/api/plans':
                self.body({'plans':self.server.plans.read()})
            elif path == '/api/export':
                self.body({'schema_version':2,'exported_at':datetime.now(timezone.utc).isoformat(),'evaluations':self.server.store.read(),'plans':self.server.plans.read()},
                          headers={'Content-Disposition':'attachment; filename="teaching-evaluations.json"'})
            elif path.startswith('/sources/'):
                key = path.removeprefix('/sources/')
                src = next((s for s in self.server.registry['source_files'] if s['key']==key), None)
                if not src or not Path(src['path']).is_file():
                    self.fail('Δεν βρέθηκε η συγκεκριμένη πηγή.',404)
                    return
                f=Path(src['path'])
                module=query.get('module',[''])[0]
                if module:
                    if module not in {'investigation','timeline','mindpalace','history3d','personalpage'}:
                        self.fail('Δεν υπάρχει αυτή η ενότητα.',404)
                        return
                    data=json.loads(f.read_text())
                    if not isinstance(data,dict) or module not in data:
                        self.fail('Δεν βρέθηκε η ενότητα στο υπάρχον JSON.',404)
                        return
                    self.body(data[module],headers={'Access-Control-Allow-Origin':'*'})
                    return
                mime=mimetypes.guess_type(f.name)[0] or 'application/octet-stream'
                self.body(f.read_bytes(), mime+('; charset=utf-8' if mime.startswith('text/') else ''),headers={'Access-Control-Allow-Origin':'*'})
            elif path.startswith('/launch/'):
                aid=path.removeprefix('/launch/')
                activity=next((a for s in self.server.registry['scenarios'] for a in s['activities'] if a['id']==aid),None)
                if not activity:
                    self.fail('Δεν βρέθηκε η δραστηριότητα.',404)
                    return
                target=self.server.launch_url(activity,'http://'+self.headers['Host'])
                if not target or urlsplit(target).scheme not in {'http','https'}:
                    self.fail('Ο σύνδεσμος χρειάζεται επιβεβαίωση.')
                    return
                self.body('', 'text/plain', 302, {'Location':target})
            else:
                relative = 'index.html' if path=='/' else path.lstrip('/')
                base=(self.server.root/'public').resolve()
                f=(base/relative).resolve()
                if not f.is_relative_to(base) or any(x.startswith('.') for x in Path(relative).parts) or not f.is_file():
                    self.fail('Δεν βρέθηκε η σελίδα.',404)
                    return
                self.body(f.read_bytes(),mimetypes.guess_type(f.name)[0] or 'application/octet-stream')
        except (ValueError, OSError) as e:
            self.fail(str(e),500)

    def do_HEAD(self):
        self.do_GET()

    def do_OPTIONS(self):
        if self.path.startswith('/sources/'):
            self.body('', 'text/plain',204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET, HEAD, OPTIONS','Access-Control-Allow-Headers':'Cache-Control, Pragma'})
        else:
            self.fail('Η πρόσβαση επιτρέπεται μόνο από το ίδιο Πιλοτήριο.',403)

    def do_POST(self):
        origin=self.headers.get('Origin','')
        if not self.valid_host() or origin != 'http://'+self.headers.get('Host','') or self.headers.get('X-Mission-Control') != 'teacher-action':
            self.fail('Η καταγραφή επιτρέπεται από το ίδιο το Πιλοτήριο.',403)
            return
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0 < length < 64000 or self.headers.get('Content-Type','').split(';')[0] != 'application/json':
                raise ValueError('Μη έγκυρο μέγεθος ή περιεχόμενο αιτήματος.')
            data=json.loads(self.rfile.read(length))
            path=urlsplit(self.path).path
            if path=='/api/evaluations':
                row,created=self.server.store.append(data,self.server.registry,self.server.models,self.server.plans)
                self.body({'ok':True,'record':row,'created':created},status=201 if created else 200)
            elif path=='/api/plans':
                row,created=self.server.plans.append(data,self.server.registry,self.server.models)
                self.body({'ok':True,'plan':row,'created':created},status=201 if created else 200)
            elif path=='/api/refresh':
                with self.server.refresh_lock:
                    self.server.registry=build_and_save(self.server.root)
                self.body({'ok':True,'registry':self.server.registry})
            else:
                self.fail('Δεν υπάρχει αυτή η ενέργεια.',404)
        except (ValueError, TypeError) as e:
            self.fail(str(e))
        except OSError:
            self.fail('Η εγγραφή στον δίσκο απέτυχε. Οι επιλογές σου παραμένουν στην οθόνη· δοκίμασε ξανά.',500)


def main():
    parser=argparse.ArgumentParser(description='Τοπικό Πιλοτήριο τάξης')
    parser.add_argument('--port',type=int,default=8788)
    parser.add_argument('--host',default='127.0.0.1')
    parser.add_argument('--open',action='store_true')
    parser.add_argument('--storage',type=Path)
    args=parser.parse_args()
    from scripts.prepare_apps import prepare_board
    prepare_board()
    server=MissionServer((args.host,args.port),storage=args.storage)
    address='127.0.0.1' if args.host=='0.0.0.0' else args.host
    url=f'http://{address}:{server.server_port}/'
    print(f'Πιλοτήριο τάξης: {url}',flush=True)
    print(f'Αξιολογήσεις: {server.store.directory}',flush=True)
    if args.host=='0.0.0.0':
        for ip in sorted(server.allowed_hosts-{'localhost','127.0.0.1','[::1]'}):
            print(f'Tablet στο ίδιο δίκτυο: http://{ip}:{server.server_port}/',flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__=='__main__':
    main()
