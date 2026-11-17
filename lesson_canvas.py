"""Versioned lesson maps in the existing private teacher store.

Only catalogue references and teacher-authored map content live in documents.
Uploaded payloads are immutable, separately stored assets; none are exported.
"""
from __future__ import annotations

import copy
import fcntl
import hashlib
import json
import math
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

from lesson_records import identity

BUILDINGS = ('text', 'images', 'mindmap', 'html', 'synthesis')
MAX_DOCUMENT = 1024 * 1024
MAX_ASSET = 25 * 1024 * 1024
MIMES = {'image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'text/html'}


class CanvasConflict(ValueError):
    pass


def short(value, maximum=240):
    if not isinstance(value, str) or len(value) > maximum or '\x00' in value:
        raise ValueError('Μη έγκυρο κείμενο χάρτη.')
    return value


def point(value, bounds=(0, 1)):
    if not isinstance(value, dict):
        raise ValueError('Μη έγκυρες συντεταγμένες.')
    result = {}
    for key in ('x', 'y'):
        number = value.get(key)
        if type(number) not in (float, int) or not math.isfinite(number) or not bounds[0] <= number <= bounds[1]:
            raise ValueError('Μη έγκυρες συντεταγμένες.')
        result[key] = number
    return result


def box(value):
    result = point(value, (-5, 5))
    for key in ('w', 'h'):
        number = value.get(key)
        if type(number) not in (float, int) or not math.isfinite(number) or not .05 <= number <= 2:
            raise ValueError('Μη έγκυρο μέγεθος.')
        result[key] = number
    return result


def items(value, maximum=500):
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError('Μη έγκυρη λίστα χάρτη.')
    return value


def links(value, nodes):
    result = []
    for row in items(value):
        if not isinstance(row, dict) or row.get('from') not in nodes or row.get('to') not in nodes or row['from'] == row['to']:
            raise ValueError('Η σύνδεση χρειάζεται δύο υπαρκτά στοιχεία.')
        result.append({'id': identity(row.get('id')), 'from': row['from'], 'to': row['to'],
                       'verb': short(row.get('verb', ''), 100), 'phrase': short(row.get('phrase', ''), 600),
                       'visible': row.get('visible', True) is not False})
    if len({r['id'] for r in result}) != len(result):
        raise ValueError('Διπλή ταυτότητα σύνδεσης.')
    return result


def validate_import_source(data, registry):
    if not isinstance(data, dict) or data.get('type') not in ('pdf', 'image'):
        raise ValueError('Μη έγκυρη πηγή σημειώσεων.')
    sha = short(data.get('sha256', ''), 64)
    if not re.fullmatch('[0-9a-f]{64}', sha):
        raise ValueError('Μη έγκυρη ταυτότητα αρχείου σημειώσεων.')
    if data.get('extraction') not in ('pdf-text', 'ocr', 'mixed', 'manual'):
        raise ValueError('Μη έγκυρη ανάγνωση σημειώσεων.')
    start, end, total = (data.get(k) for k in ('page_start', 'page_end', 'total_pages'))
    if any(type(n) is not int for n in (start, end, total)) or not 1 <= start <= end <= total <= 10000 or end-start >= 20:
        raise ValueError('Επίλεξε έγκυρο εύρος έως 20 σελίδων.')
    known = {s['scenario_id'] for s in registry['scenarios']}
    related = items(data.get('related_scenario_ids', []), 100)
    if any(s not in known for s in related):
        raise ValueError('Δεν βρέθηκε το σχετικό μάθημα.')
    regions = []
    for r in items(data.get('exercise_regions', []), 40):
        p = point(r)
        w, h, page = r.get('w'), r.get('h'), r.get('page')
        if type(page) is not int or not start <= page <= end or any(type(n) not in (float, int) or not math.isfinite(n) or not .001 < n <= 1 for n in (w, h)) or p['x']+w > 1.001 or p['y']+h > 1.001:
            raise ValueError('Μη έγκυρο απόσπασμα άσκησης.')
        regions.append({'asset_id': identity(r.get('asset_id')), 'page': page, **p, 'w': w, 'h': h})
    return {'asset_id': identity(data.get('asset_id')), 'sha256': sha, 'name': short(data.get('name', ''), 180),
            'type': data['type'], 'extraction': data['extraction'], 'page_start': start, 'page_end': end, 'total_pages': total,
            'focus': short(data.get('focus', ''), 1000), 'keywords': [short(t, 100) for t in items(data.get('keywords', []), 12)],
            'related_scenario_ids': list(dict.fromkeys(related)), 'exercise_regions': regions}


def validate_provenance(data):
    if not isinstance(data, dict):
        raise ValueError('Μη έγκυρη προέλευση υλικού.')
    drive_id = short(data.get('drive_id', ''), 200)
    if not re.fullmatch(r'[A-Za-z0-9_-]{10,200}', drive_id):
        raise ValueError('Μη έγκυρη ταυτότητα πηγής Drive.')
    result = {'drive_id': drive_id, 'name': short(data.get('name', ''), 180)}
    if 'page' in data:
        page = data['page']
        if type(page) is not int or not 1 <= page <= 10000:
            raise ValueError('Μη έγκυρη σελίδα πηγής.')
        result['page'] = page
    if 'variant' in data:
        result['variant'] = short(data['variant'], 120)
    return result


def validate_document(kind, data, registry, document_id=None):
    if not isinstance(data, dict) or len(json.dumps(data, ensure_ascii=False).encode()) > MAX_DOCUMENT:
        raise ValueError('Μη έγκυρο μέγεθος ή περιεχόμενο χάρτη.')
    if data.get('schema_version', 1) != 1:
        raise ValueError('Η έκδοση αυτού του χάρτη χρειάζεται νεότερη εφαρμογή. Το αρχείο διατηρείται.')
    result = {'schema_version': 1, 'title': short(data.get('title', '')), 'grade': short(data.get('grade', ''), 60)}
    if not result['title'].strip():
        raise ValueError('Δώσε τίτλο στον χάρτη.')
    scenarios = {s['scenario_id']: s for s in registry['scenarios']}
    verbs = [short(v, 100) for v in items(data.get('verbs', []), 80)]
    result['verbs'] = list(dict.fromkeys(verbs))
    if kind == 'workspace':
        themes = []
        for t in items(data.get('themes', []), 80):
            themes.append({'id': identity(t.get('id')), 'title': short(t.get('title', '')), 'icon': short(t.get('icon', '📚'), 20), 'box': box(t.get('box'))})
        ids = {t['id'] for t in themes}
        if len(ids) != len(themes):
            raise ValueError('Διπλή ταυτότητα θεματικής.')
        lessons = []
        for l in items(data.get('lessons', [])):
            sid = l.get('scenario_id') or None
            if l.get('theme_id') not in ids or (sid and sid not in scenarios):
                raise ValueError('Επίλεξε υπαρκτή θεματική και μάθημα.')
            lessons.append({'id': identity(l.get('id')), 'theme_id': l['theme_id'], 'title': short(l.get('title', '')),
                            'scenario_id': sid, 'canvas_id': identity(l['canvas_id']) if l.get('canvas_id') else None})
        if len({l['id'] for l in lessons}) != len(lessons):
            raise ValueError('Διπλή ταυτότητα μαθήματος.')
        result.update(themes=themes, lessons=lessons, connections=links(data.get('connections', []), ids))
        if 'visual_theme' in data:
            if data['visual_theme'] not in ('default', 'jerusalem', 'mediterranean'):
                raise ValueError('Άγνωστη εικονογράφηση χάρτη.')
            result['visual_theme'] = data['visual_theme']
        if 'lesson_relations' in data:
            relations = []
            for r in items(data['lesson_relations'], 500):
                if r.get('status') not in ('proposed', 'confirmed', 'dismissed') or r.get('from_canvas_id') == r.get('to_canvas_id'):
                    raise ValueError('Μη έγκυρη διδακτική σύνδεση.')
                relations.append({'id': identity(r.get('id')), 'from_canvas_id': identity(r.get('from_canvas_id')),
                                  'to_canvas_id': identity(r.get('to_canvas_id')), 'status': r['status'],
                                  'verb': short(r.get('verb', ''), 100), 'phrase': short(r.get('phrase', ''), 600),
                                  'evidence': short(r.get('evidence', ''), 2000),
                                  'evidence_refs': [{'canvas_id': identity(ref.get('canvas_id')), 'material_id': identity(ref.get('material_id'))} for ref in items(r.get('evidence_refs', []), 20)]})
            if len({r['id'] for r in relations}) != len(relations):
                raise ValueError('Διπλή διδακτική σύνδεση.')
            result['lesson_relations'] = relations
    elif kind == 'canvas':
        sid = data.get('scenario_id') or None
        imported = validate_import_source(data['import_source'], registry) if data.get('import_source') is not None else None
        own_notes = imported and document_id and sid == 'notes:' + document_id
        if sid and sid not in scenarios and not own_notes:
            raise ValueError('Επίλεξε υπάρχον σενάριο για τη σύνδεση.')
        if imported and not own_notes:
            raise ValueError('Το μάθημα σημειώσεων διατηρεί τη δική του ταυτότητα.')
        registered = data.get('registered', False) is True
        if registered and not sid:
            raise ValueError('Η καταχώριση χρειάζεται υπάρχον μάθημα.')
        buildings = []
        material_ids = set()
        for b in items(data.get('buildings', []), 5):
            if b.get('id') not in BUILDINGS:
                raise ValueError('Άγνωστος τύπος οικοδομήματος.')
            materials = []
            for m in items(b.get('materials', []), 100):
                if m.get('type') not in ('text', 'image', 'pdf', 'html'):
                    raise ValueError('Άγνωστος τύπος υλικού.')
                mid = identity(m.get('id'))
                if mid in material_ids:
                    raise ValueError('Διπλή ταυτότητα υλικού.')
                material_ids.add(mid)
                url = short(m.get('url', ''), 4096)
                if url and (urlsplit(url).scheme != 'https' or not urlsplit(url).netloc or urlsplit(url).username or urlsplit(url).password):
                    raise ValueError('Ο σύνδεσμος πρέπει να είναι πλήρης διεύθυνση HTTPS.')
                activity_id = short(m.get('activity_id', ''), 200)
                source_sid = m.get('source_scenario_id') or ''
                if activity_id and not any(a['id'] == activity_id for a in scenarios.get(source_sid, {}).get('activities', [])):
                    raise ValueError('Δεν βρέθηκε το συγκεκριμένο υλικό στον κατάλογο.')
                page_start, page_end = m.get('page_start', 1), m.get('page_end', 1)
                if type(page_start) is not int or type(page_end) is not int or not 1 <= page_start <= page_end <= 10000:
                    raise ValueError('Μη έγκυρο εύρος σελίδων.')
                materials.append({'id': mid, 'type': m['type'], 'label': short(m.get('label', '')),
                                  'text': short(m.get('text', ''), 100000), 'url': url,
                                  'asset_id': identity(m['asset_id']) if m.get('asset_id') else '',
                                  'activity_id': activity_id, 'source_scenario_id': source_sid,
                                  'page_start': page_start, 'page_end': page_end,
                                  **({'provenance': validate_provenance(m['provenance'])} if 'provenance' in m else {})})
            buildings.append({'id': b['id'], 'title': short(b.get('title', '')), 'icon': short(b.get('icon', ''), 20),
                              'box': box(b.get('box')), 'hidden': b.get('hidden', False) is True, 'materials': materials})
        if {b['id'] for b in buildings} != set(BUILDINGS) or len(buildings) != 5:
            raise ValueError('Κάθε μάθημα χρειάζεται τους πέντε τύπους οικοδομημάτων.')
        annotations = []
        for a in items(data.get('annotations', []), 1000):
            if a.get('material_id') not in material_ids or a.get('kind') not in ('stroke', 'relation', 'region'):
                raise ValueError('Μη έγκυρη σημείωση εικόνας.')
            points = [point(p) for p in items(a.get('points'), 2000)]
            if len(points) < 2:
                raise ValueError('Η σημείωση χρειάζεται τουλάχιστον δύο σημεία.')
            annotations.append({'id': identity(a.get('id')), 'material_id': a['material_id'], 'kind': a['kind'],
                                'points': points, 'verb': short(a.get('verb', ''), 100), 'phrase': short(a.get('phrase', ''), 600)})
        presentation = data.get('presentation', {})
        order = items(presentation.get('reveal_order', list(BUILDINGS)), 5)
        if len(order) != 5 or set(order) != set(BUILDINGS):
            raise ValueError('Η σειρά εμφάνισης χρειάζεται τα πέντε οικοδομήματα.')
        result.update(scenario_id=sid, registered=registered, buildings=buildings, annotations=annotations,
                      connections=links(data.get('connections', []), set(BUILDINGS)),
                      presentation={'reveal_order': order, 'hide_empty': presentation.get('hide_empty', True) is not False})
        if imported:
            result['import_source'] = imported
    else:
        raise ValueError('Άγνωστος τύπος χάρτη.')
    return result


def asset_metadata(asset_id, name, mime, payload):
    identity(asset_id)
    if mime not in MIMES or not 0 < len(payload) <= MAX_ASSET:
        raise ValueError('Επίλεξε εικόνα, PDF ή αυτοτελές HTML έως 25 MB.')
    valid = {'image/png': payload.startswith(b'\x89PNG\r\n\x1a\n'),
             'image/jpeg': payload.startswith(b'\xff\xd8\xff'),
             'image/webp': payload[:4] == b'RIFF' and payload[8:12] == b'WEBP',
             'application/pdf': payload.startswith(b'%PDF-'),
             'text/html': bool(re.search(br'<(?:!doctype\s+html|html|head|body)\b', payload[:4096], re.I))}[mime]
    if not valid:
        raise ValueError('Το περιεχόμενο δεν αντιστοιχεί στον τύπο αρχείου.')
    return {'id': asset_id, 'name': short(Path(name).name, 180), 'mime': mime, 'size': len(payload),
            'sha256': hashlib.sha256(payload).hexdigest()}


class CanvasStore:
    def __init__(self, evaluation_store):
        self.store = evaluation_store
        self.directory = self.store.directory / 'lesson-maps'
        self.assets = self.directory / 'assets'
        self.assets.mkdir(parents=True, exist_ok=True)

    def read(self):
        rows = []
        for file in sorted(self.directory.glob('*.json')):
            try:
                row = json.loads(file.read_text())
                if row['kind'] not in ('workspace', 'canvas') or not isinstance(row['document'], dict):
                    raise ValueError()
                identity(row['id']); identity(row['document_id'])
                rows.append(row)
            except (KeyError, TypeError, ValueError, OSError) as e:
                raise ValueError(f'Ο χάρτης {file.name} χρειάζεται έλεγχο. Διατηρήθηκε για ανάκτηση.') from e
        return sorted(rows, key=lambda r: (r['created_at'], r['id']))

    def latest(self):
        rows = self.read()
        superseded = {r['previous_version_id'] for r in rows if r.get('previous_version_id')}
        return {r['document_id']: r for r in rows if r['id'] not in superseded}.values()

    def save(self, data, registry):
        rid, did = identity(data.get('request_id')), identity(data.get('document_id'))
        previous = identity(data['previous_version_id']) if data.get('previous_version_id') else ''
        kind = data.get('kind')
        doc = validate_document(kind, data.get('document'), self.registry(registry), did)
        with self.store.lock, (self.directory / '.append.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            rows = self.read()
            old = next((r for r in rows if r['id'] == rid), None)
            if old:
                if any(old[k] != v for k, v in {'document_id':did, 'kind':kind, 'previous_version_id':previous, 'document':doc}.items()):
                    raise CanvasConflict('Το αναγνωριστικό χρησιμοποιήθηκε για διαφορετική αλλαγή.')
                return old, False
            superseded = {r['previous_version_id'] for r in rows if r.get('previous_version_id')}
            latest = next((r for r in reversed(rows) if r['document_id'] == did and r['id'] not in superseded), None)
            if (latest and (latest['id'] != previous or latest['kind'] != kind)) or (not latest and previous):
                raise CanvasConflict('Ο χάρτης άλλαξε από άλλη συσκευή. Άνοιξε την τελευταία έκδοση· οι αλλαγές σου διατηρούνται.')
            if latest and latest['document'].get('registered') and latest['document'].get('scenario_id') != doc.get('scenario_id'):
                raise ValueError('Ο καταχωρισμένος χάρτης παραμένει στο ίδιο μάθημα. Δημιούργησε αντίγραφο.')
            if doc.get('import_source'):
                source = doc['import_source']
                info, _ = self.asset(source['asset_id'])
                if info['sha256'] != source['sha256'] or (source['type'] == 'pdf') != (info['mime'] == 'application/pdf') or not info['mime'].startswith(('image/', 'application/pdf')):
                    raise ValueError('Το πρωτότυπο δεν αντιστοιχεί στις σημειώσεις.')
                if any(not self.asset(r['asset_id'])[0]['mime'].startswith('image/') for r in source['exercise_regions']):
                    raise ValueError('Η άσκηση χρειάζεται εικόνα.')
            for b in doc.get('buildings', []):
                for m in b['materials']:
                    if m['asset_id']:
                        self.asset(m['asset_id'])
            if kind == 'workspace':
                canvas_ids = {r['document_id'] for r in rows if r['kind'] == 'canvas'}
                if any(l['canvas_id'] and l['canvas_id'] not in canvas_ids for l in doc['lessons']):
                    raise ValueError('Αποθήκευσε πρώτα τα μαθήματα του χάρτη.')
                latest = {r['document_id']: r['document'] for r in self.latest() if r['kind'] == 'canvas'}
                for relation in doc.get('lesson_relations', []):
                    endpoints = {relation['from_canvas_id'], relation['to_canvas_id']}
                    if not endpoints.issubset(latest):
                        raise ValueError('Δεν βρέθηκαν τα μαθήματα της διδακτικής σύνδεσης.')
                    for ref in relation['evidence_refs']:
                        if ref['canvas_id'] not in endpoints or not any(m['id'] == ref['material_id'] for r in rows if r['kind'] == 'canvas' and r['document_id'] == ref['canvas_id'] for b in r['document']['buildings'] for m in b['materials']):
                            raise ValueError('Δεν βρέθηκε το υλικό τεκμηρίωσης της σύνδεσης.')
            row = {'schema_version':1, 'id':rid, 'document_id':did, 'previous_version_id':previous, 'kind':kind,
                   'created_at':datetime.now(timezone.utc).isoformat().replace('+00:00','Z'), 'document':doc}
            self.store.write_atomic(self.directory / f'{rid}.json', row)
            return row, True

    def upload(self, asset_id, name, mime, payload):
        metadata = asset_metadata(asset_id, name, mime, payload)
        with self.store.lock, (self.directory / '.assets.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            target = self.assets / f'{asset_id}.bin'
            info = self.assets / f'{asset_id}.json'
            if info.exists():
                old = json.loads(info.read_text())
                if old != metadata:
                    raise CanvasConflict('Το αρχείο έχει ήδη διαφορετικό περιεχόμενο.')
                return old
            fd, temporary = tempfile.mkstemp(prefix='.upload-', dir=self.assets)
            try:
                with os.fdopen(fd, 'wb') as f:
                    f.write(payload); f.flush(); os.fsync(f.fileno())
                os.replace(temporary, target)
                self.store.write_atomic(info, metadata)
            finally:
                if os.path.exists(temporary): os.unlink(temporary)
        return metadata

    def asset(self, asset_id):
        key = identity(asset_id)
        info = self.assets / f'{key}.json'
        if not info.is_file():
            raise ValueError('Δεν βρέθηκε το ιδιωτικό αρχείο.')
        return json.loads(info.read_text()), self.assets / f'{key}.bin'

    def registry(self, original):
        result = copy.deepcopy(original)
        scenarios = {s['scenario_id']: s for s in result['scenarios']}
        latest = self.latest()
        grades = {}
        for row in latest:
            if row['kind'] == 'workspace':
                for lesson in row['document']['lessons']:
                    grades.setdefault(lesson['canvas_id'], set()).add(row['document']['grade'])
        for row in latest:
            d = row['document']
            if row['kind'] == 'canvas' and d.get('registered') and d.get('import_source') and d.get('scenario_id') == 'notes:' + row['document_id']:
                source = d['import_source']
                references = {(m['source_scenario_id'], m['activity_id']) for b in d['buildings'] for m in b['materials'] if m.get('activity_id')}
                activities = [copy.deepcopy(a) for s in original['scenarios'] for a in s['activities'] if (s['scenario_id'], a['id']) in references]
                scenario = {'scenario_id': d['scenario_id'], 'title': d['title'], 'subject': 'Θρησκευτικά',
                            'grades': [d['grade']] if d['grade'] in original.get('grades', []) else [], 'grade_status': 'confirmed',
                            'objectives': [], 'inquiry_question': source['focus'], 'modes': ['μελέτη πηγής', 'σύνδεση εννοιών'],
                            'formats': list(dict.fromkeys(['PDF' if source['type'] == 'pdf' else 'Εικόνα', 'HTML'])),
                            'duration': None, 'cognitive_difficulty': None, 'technical_difficulty': None, 'readiness': 'available',
                            'pedagogical_application': source['focus'] or 'Μελέτη των σημειώσεων και σύνδεση με επιλεγμένα μέσα.',
                            'application_status': 'teacher-confirmed', 'aliases': [], 'notes': [], 'source_groups': ['Samsung Notes'],
                            'sources': [{'system': 'Samsung Notes', 'path': source['name'], 'locator': ''}], 'activities': activities, 'private': True}
                result['scenarios'] = [s for s in result['scenarios'] if s['scenario_id'] != d['scenario_id']]
                result['scenarios'].append(scenario)
                scenarios[d['scenario_id']] = scenario
            if row['kind'] == 'canvas' and d.get('registered') and d.get('scenario_id') in scenarios:
                scenario = scenarios[d['scenario_id']]
                for grade in {d['grade'], *grades.get(row['document_id'], set())}:
                    if grade in original.get('grades', []) and grade not in scenario.get('grades', []):
                        scenario['grades'] = [*scenario.get('grades', []), grade]
                        scenario['grade_status'] = 'confirmed'
                scenarios[d['scenario_id']]['activities'].append({
                    'id':'canvas:'+row['document_id'], 'kind':'canvas', 'label':'Χάρτης · '+d['title'],
                    'url':'#canvas/'+row['document_id'], 'canvas_id':row['document_id'], 'canvas_version_id':row['id'],
                    'note':'Ιδιωτικός χάρτης μαθήματος · πέντε οικοδομήματα γνώσης', 'app':'lesson-map'})
        for row in latest:
            if row['kind'] != 'canvas' or not row['document'].get('registered'):
                continue
            d = row['document']
            for sid in {m.get('source_scenario_id') for b in d['buildings'] for m in b['materials']}:
                if sid not in scenarios:
                    continue
                scenario = scenarios[sid]
                for grade in {d['grade'], *grades.get(row['document_id'], set())}:
                    if grade in original.get('grades', []) and grade not in scenario.get('grades', []):
                        scenario['grades'] = [*scenario.get('grades', []), grade]
                        scenario['grade_status'] = 'confirmed'
        return result

    def listing(self):
        metadata = {}
        for row in self.latest():
            for b in row['document'].get('buildings', []):
                for m in b['materials']:
                    if m.get('asset_id') and m['asset_id'] not in metadata:
                        try:
                            metadata[m['asset_id']] = self.asset(m['asset_id'])[0]
                        except ValueError:
                            pass  # Missing payloads retain their existing viewer error and identity.
        return {'versions': self.read(), 'asset_metadata': metadata}

    def usage(self, data, scenario_id):
        if data is None:
            return None
        if not isinstance(data, dict) or data.get('confirmed') is not True:
            raise ValueError('Επιβεβαίωσε τη χρήση του χάρτη.')
        row = next((r for r in self.read() if r['id'] == data.get('version_id') and r['document_id'] == data.get('canvas_id') and r['kind'] == 'canvas'), None)
        if not row or row['document']['scenario_id'] != scenario_id:
            raise ValueError('Δεν βρέθηκε η συγκεκριμένη έκδοση χάρτη για το μάθημα.')
        doc = row['document']
        permitted = {'used_building_ids':set(BUILDINGS), 'guidance_building_ids':set(BUILDINGS),
                     'effective_material_ids':{m['id'] for b in doc['buildings'] for m in b['materials']},
                     'effective_connection_ids':{c['id'] for c in doc['connections']}}
        result = {'canvas_id':row['document_id'], 'version_id':row['id'], 'title':doc['title'], 'confirmed':True,
                  'note':short(data.get('note',''),2000)}
        if data.get('workspace_id'):
            wid = identity(data['workspace_id'])
            workspace = next((r['document'] for r in self.latest() if r['document_id'] == wid and r['kind'] == 'workspace'), None)
            if not workspace or not any(l['canvas_id'] == row['document_id'] for l in workspace['lessons']) or data.get('grade') != workspace['grade']:
                raise ValueError('Επίλεξε τον χάρτη και την τάξη χρήσης του μαθήματος.')
            result.update(workspace_id=wid, grade=workspace['grade'])
        for key, valid in permitted.items():
            chosen = items(data.get(key, []))
            if any(not isinstance(i, str) or i not in valid for i in chosen):
                raise ValueError('Επίλεξε στοιχεία της συγκεκριμένης έκδοσης χάρτη.')
            result[key] = list(dict.fromkeys(chosen))
        return result
