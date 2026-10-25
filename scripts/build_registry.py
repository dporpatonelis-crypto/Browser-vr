#!/usr/bin/env python3
"""Read existing teaching sources; write only the additional Mission Control index."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit

try:
    from .unity_inventory import UnityInventory
    from .refresh_sources import blob_sha, mirror_root, summary as refresh_summary
except ImportError:
    from unity_inventory import UnityInventory
    from refresh_sources import blob_sha, mirror_root, summary as refresh_summary

ROOT = Path(__file__).resolve().parents[1]
GRADES = ['Α΄ Γυμνασίου', 'Β΄ Γυμνασίου', 'Γ΄ Γυμνασίου', 'Α΄ Λυκείου', 'Β΄ Λυκείου', 'Γ΄ Λυκείου']
APP_INFO = {
    'investigation': ('idea-weaver-board', 'Πίνακας διερεύνησης', 'https://idea-weaver-board.vercel.app/'),
    'timeline': ('Map-Timeline', 'Χρονολόγιο', 'https://dporpatonelis-crypto.github.io/Map-Timeline/'),
    'history3d': ('history-explorer-3d', 'History Explorer', 'https://history-explorer-3d.vercel.app/'),
    'mindpalace': ('mind-palace-cases', 'Mind Palace', 'https://dporpatonelis-crypto.github.io/mind-palace-cases/'),
    'personalpage': ('personal-page', 'Κείμενο και προσωπικό τετράδιο', ''),
}
OUTPUTS = {
    'investigation': ['investigation_output.json', 'investigation_board_output.json'],
    'timeline': ['timeline_output.json', 'timeline_item_output.json'],
    'history3d': ['history3d_output.json'],
    'mindpalace': ['mindpalace_output.json', 'mind_palace_output.json'],
    'personalpage': ['personalpage_output.json', 'personal_page_output.json'],
}


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def norm(value):
    value = unicodedata.normalize('NFD', str(value).lower())
    return ''.join(c for c in value if not unicodedata.combining(c)).replace('ς', 'σ')


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
        temporary = f.name
    os.replace(temporary, path)


class Builder:
    def __init__(self, config=None):
        self.config = config or json.loads((ROOT / 'config.json').read_text())
        self.sb = Path(self.config['sacred_blueprint_root'])
        self.apps = Path(self.config['apps_root'])
        self.book = Path(self.config['book_root'])
        self.unity = Path(self.config['unity_root'])
        self.scenarios = {}
        self.sources = {}
        self.audit = {}
        self.warnings = []
        self.deck_targets = {}
        self.coverage = []
        self.unity_scan = None
        self.refresh = refresh_summary()
        self.rules = self.read(ROOT/'source-rules.json', {})
        self.classified_exclusions = []

    def app_dir(self, name):
        repository = 'Interactive-sculpture' if name == 'interactive-sculpture' else name
        remote = mirror_root(repository)
        return remote if remote.is_dir() else self.apps/name

    def read_text(self, path):
        content = Path(path).read_bytes()
        self.audit[str(Path(path).resolve())] = hashlib.sha256(content).hexdigest()
        return content.decode('utf-8', errors='replace')

    def read(self, path, default=None):
        path = Path(path)
        if not path.is_file():
            return default
        try:
            content = path.read_bytes()
            self.audit[str(path.resolve())] = hashlib.sha256(content).hexdigest()
            return json.loads(content)
        except (ValueError, OSError) as e:
            self.warnings.append({'path': str(path), 'message': str(e)})
            return default

    def source(self, path, system, native_id='', locator=''):
        path = Path(path).resolve()
        key = hashlib.sha256(str(path).encode()).hexdigest()[:20]
        if path.is_file():
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.audit[str(path)] = digest
        else:
            digest = None
        item = {'key': key, 'system': system, 'native_id': native_id, 'path': str(path),
                'sha256': digest, 'locator': locator, 'href': f'/sources/{key}'}
        self.sources[key] = item
        return item

    def scenario(self, sid, title='', subject='Θρησκευτικά', **fields):
        if sid not in self.scenarios:
            self.scenarios[sid] = {
                'scenario_id': sid, 'title': title or sid, 'subject': subject,
                'grades': [], 'grade_status': 'unconfirmed', 'audience_source': None,
                'objectives': [], 'modes': [], 'formats': [], 'sources': [],
                'activities': [], 'duration': None, 'duration_status': 'unconfirmed',
                'cognitive_difficulty': None, 'cognitive_status': 'unconfirmed',
                'technical_difficulty': None, 'technical_status': 'unconfirmed',
                'readiness': 'available', 'readiness_note': '',
                'pedagogical_application': None, 'application_status': 'proposal',
                'aliases': [], 'notes': [], 'source_groups': [],
            }
        item = self.scenarios[sid]
        item.update(fields)
        return item

    def add_source(self, s, path, system, native_id='', locator=''):
        src = self.source(path, system, native_id, locator)
        if not any(x['key'] == src['key'] and x['locator'] == locator for x in s['sources']):
            s['sources'].append(src)
        if system not in s['source_groups']:
            s['source_groups'].append(system)
        return src

    def activity(self, s, kind, label, url='', path=None, app=None, native_id='', note='', identity_key=None, **extra):
        identity = url or f'{app}:{path}:{native_id}'
        if path and (not url or app in {x[0] for x in APP_INFO.values()} or app == 'drive-html'):
            identity = f'{app or kind}:{native_id}:{hashlib.sha256(Path(path).read_bytes()).hexdigest()}'
        # A Google presentation has one identity despite edit/preview URL variations.
        deck = re.search(r'docs\.google\.com/presentation/d/([^/\?#]+)', url)
        if deck:
            identity = 'slides:' + deck.group(1)
        if identity_key:
            identity = identity_key
        existing = next((a for a in s['activities'] if a.get('identity') == identity), None)
        if existing:
            existing.update(extra)
            if path:
                src = self.add_source(s, path, app or kind, native_id)
                existing.update(source_key=src['key'], app=app, native_id=native_id,
                                local_url=f'/launch/{existing["id"]}' if app else src['href'])
            if note:
                existing['note'] = note
            if app:
                existing['label'] = label
                existing['kind'] = kind
            return existing
        aid = hashlib.sha256((s['scenario_id'] + '|' + identity).encode()).hexdigest()[:20]
        a = {'id': aid, 'identity': identity, 'kind': kind, 'label': label, 'url': url,
             'note': note, 'app': app, 'native_id': native_id, **extra}
        if path:
            src = self.add_source(s, path, app or kind, native_id)
            a['source_key'] = src['key']
            a['local_url'] = f'/launch/{aid}' if app else src['href']
        if deck:
            a['drive_id'] = deck.group(1)
            self.deck_targets.setdefault(deck.group(1), s['scenario_id'])
        s['activities'].append(a)
        fmt = {'book': 'Digital Book', 'slides': 'Slides', 'vr': 'Unity VR', 'html': 'HTML', 'quiz': 'HTML', 'text': 'Κείμενο', 'model': '3D μοντέλο'}.get(kind)
        if fmt and fmt not in s['formats']:
            s['formats'].append(fmt)
        return a

    def set_audience(self, s, text):
        if not isinstance(text, str) or not text:
            return
        s['audience_source'] = text
        if 'παραδοχ' in norm(text) or 'προς ελεγχο' in norm(text):
            return
        if 'όλες τις τάξεις' in text or 'δευτεροβάθμιας' in text or 'έως Γ΄ Λυκείου' in text:
            s['grades'] = GRADES[:]
        else:
            for grade in GRADES:
                if norm(grade) in norm(text.replace("'", '΄').replace('’', '΄')):
                    s['grades'].append(grade)
        if s['grades']:
            s['grade_status'] = 'source'

    def lessons(self):
        base = self.sb / 'lessons'
        self.coverage.append({'system': 'Sacred Blueprint', 'path': str(base), 'available': base.is_dir()})
        if not base.is_dir():
            return
        aliases = self.config.get('lesson_aliases', {})
        folders = sorted((d for d in base.iterdir() if d.is_dir() and not d.name.startswith('.')), key=lambda p: (p.name in aliases, p.name))
        for folder in folders:
            meta = self.read(folder / 'meta.json', {})
            plan = self.read(folder / 'lesson_plan.json', {})
            master = self.read(folder / 'master_output.json', {})
            lesson = plan.get('lesson', {})
            canonical = aliases.get(folder.name, folder.name)
            sid = 'sb:' + canonical
            title = lesson.get('title') or meta.get('topic') or master.get('title') or folder.name
            s = self.scenario(sid, title)
            if folder.name != canonical:
                if folder.name not in s['aliases']:
                    s['aliases'].append(folder.name)
                note = self.config.get('alias_evidence', {}).get(folder.name)
                if note and note not in s['notes']:
                    s['notes'].append(note)
            for name in ['meta.json', 'lesson_plan.json', 'master_output.json']:
                if (folder/name).exists():
                    self.add_source(s, folder/name, 'Sacred Blueprint', folder.name)
            if not s['objectives']:
                s['objectives'] = lesson.get('objectives', [])
            if not s['audience_source']:
                self.set_audience(s, lesson.get('audience'))
            if lesson.get('duration') and not s['duration']:
                s['duration'] = lesson['duration']
                s['duration_status'] = 'unconfirmed' if 'παραδοχ' in norm(s['duration']) else 'source'
            if (folder/'source.txt').is_file():
                self.activity(s, 'text', 'Κείμενο μαθήματος', path=folder/'source.txt')
            for kind, names in OUTPUTS.items():
                path = next((folder/n for n in names if (folder/n).is_file()), None)
                source_module = None
                data = self.read(path) if path else None
                if not data and master.get(kind):
                    path = folder/'master_output.json'
                    data = master[kind]
                    source_module = kind
                if not data:
                    continue
                app_name, label, live = APP_INFO[kind]
                if kind == 'investigation' and isinstance(data, dict) and data.get('clues'):
                    topic = data.get('topic', '')
                    s['inquiry_question'] = s.get('inquiry_question') or topic
                    if not s['objectives'] and topic:
                        s['objectives'] = [topic]
                        s['objective_status'] = 'inquiry_question'
                    s['modes'] += ['διερεύνηση', 'συσχέτιση', 'συζήτηση']
                elif kind == 'timeline':
                    s['modes'] += ['εξερεύνηση', 'αντιστοίχιση']
                elif kind in ['history3d', 'mindpalace']:
                    s['modes'] += ['εξερεύνηση', 'ερμηνεία']
                native = data.get('case_id', canonical) if isinstance(data, dict) else canonical
                if kind == 'timeline' and not isinstance(data, list):
                    target = self.app_dir(app_name)/'data'/f'{folder.name}.json'
                    candidate = self.read(target)
                    if isinstance(candidate, list):
                        path, data, source_module = target, candidate, None
                    elif not (isinstance(data,dict) and isinstance(data.get('timeline'),list)):
                        self.add_source(s,path,app_name,native)
                        continue
                # Use supported dataUrl consumers with local read-only source files.
                if kind == 'personalpage':
                    self.add_source(s, path, app_name, native)
                    continue  # Its existing build predates dataUrl. Original text remains available.
                if kind == 'history3d' and not (isinstance(data, dict) and all(k in data for k in ['characters', 'dialogs', 'facts', 'props', 'screens'])):
                    self.add_source(s, path, app_name, native)
                    s['notes'].append('Το παλαιότερο History3D JSON χρειάζεται τον υπάρχοντα μετατροπέα της εφαρμογής.')
                    target = self.app_dir(app_name)/'public/data'/f'{folder.name}.json'
                    data = self.read(target)
                    if not isinstance(data, dict) or not all(k in data for k in ['characters', 'dialogs', 'facts', 'props', 'screens']):
                        continue
                    path = target
                    source_module = None
                self.activity(s, 'html', label, live, path=path, app=app_name, native_id=native,
                              note='Ανοίγει το συγκεκριμένο υπάρχον υλικό, χωρίς αλλαγή του τρέχοντος μαθήματος.',source_module=source_module)
            if meta.get('status') == 'draft':
                s['readiness'] = 'source-draft'
                s['readiness_note'] = 'Υπάρχει διαθέσιμο υλικό· το σχέδιο μαθήματος έχει ένδειξη προσχεδίου.'
            for sub, kind in [('Quiz', 'quiz'), ('Media/Slides', 'slides')]:
                if (folder/sub).is_dir():
                    for f in sorted((folder/sub).iterdir()):
                        if f.suffix.lower() in {'.pdf','.docx','.pptx','.html'}:
                            self.activity(s, kind, f.stem, path=f, note='Υπάρχον αρχείο δραστηριότητας.')

    def unity_lessons(self):
        assets = self.unity/'Assets'
        self.coverage.append({'system':'Unity VR', 'path':str(self.unity), 'available':assets.is_dir(), 'check':'Στατική ανάγνωση· χωρίς δοκιμή Quest.'})
        if not assets.is_dir():
            return
        for f in sorted((assets/'LessonSystem/LessonJson/Generated').glob('*.json')):
            if f.name.startswith(('scene_', 'enhancer_', 'questions_', 'course_')) or '.current.' in f.name:
                continue
            data = self.read(f, {})
            native = data.get('lesson_id')
            if not native or not any(k in data for k in ['intro', 'outro', 'phases']):
                continue
            sid = 'sb:' + self.config.get('lesson_aliases',{}).get(native,native)
            if sid not in self.scenarios:
                sid = 'unity:' + native
            fallback_titles = {
                'lesson_logos_concept_map': 'Εννοιολογικός χάρτης του Λόγου',
                'lesson_proximity_comparison_ladder': 'Σύγκριση και κλίμακα διερεύνησης',
            }
            s = self.scenario(sid, data.get('title') or fallback_titles.get(native, 'Τοπική αποστολή Unity · τίτλος προς επιβεβαίωση'))
            if native in fallback_titles:
                s['notes'].append('Περιγραφικός τίτλος από το όνομα του τοπικού αρχείου. Η διδακτική ετοιμότητα χρειάζεται επιβεβαίωση.')
            self.activity(s,'vr','Τοπική αποστολή Unity',path=f,app='Unity VR',native_id=native,
                          note='Υπάρχει τοπικό JSON μαθήματος. Η ενεργοποίηση και η χρήση γίνονται από την υπάρχουσα διαδικασία Unity. Δεν ελέγχθηκε σε Quest.',room='Room_library / Room_temple')
        for f in sorted((assets/'QuizSystem/Scenarios').glob('*.json')):
            data = self.read(f,{})
            native = data.get('id')
            if not native:
                continue
            s = self.scenario('unity:'+native,data.get('title',native))
            s['modes'] += ['quiz','αντιστοίχιση','αιτιολόγηση']
            sections = data.get('sections',[])
            s['objectives'] = [sections[0]['text']] if sections and sections[0].get('text') else []
            self.activity(s,'vr','Αποστολή αντικειμένων στο Unity',path=f,app='Unity VR',native_id=native,
                          note='Διαθέσιμο τοπικό quiz. Ray, τόξο και τοποθέτηση χρησιμοποιούνται όπου έχουν οριστεί. Δεν ελέγχθηκε σε Quest.',
                          room=data.get('roomSceneName') or 'Ιεροσόλυμα · ανάθεση προς επιβεβαίωση', exercise_count=len(data.get('exercises',[])))
        manifest = self.read(assets/'Resources/Scenarios/manifest.json',{})
        for item in manifest.get('scenarios',[]):
            if item.get('status') != 'available' or not item.get('case_resource'):
                continue
            f=assets/'Resources'/(item['case_resource']+'.json')
            if not f.exists():
                continue
            data=self.read(f,{})
            native=item['scenario_id']
            s=self.scenario('unity:'+native,item['title'])
            s['objectives']=[item.get('description','')]
            s['modes']+=['διερεύνηση','συζήτηση','ερμηνεία']
            self.activity(s,'vr','Σενάριο διερεύνησης στο Unity',path=f,app='Unity VR',native_id=native,
                          room=', '.join(r.get('scene_name','') for r in item.get('rooms',[])),
                          note='Καταχωρισμένο ως διαθέσιμο στο τοπικό manifest. Δεν ελέγχθηκε σε Quest.')

    def covenant_tree(self):
        """Follow current scene references for every image/reconstruction mechanism."""
        scan = self.unity_scan = UnityInventory(self.unity/'Assets', self.read_text).scan()
        self.warnings.extend(scan.warnings)
        self.coverage.append({'system': 'Unity · μηχανισμοί σκηνών', 'path': str(self.unity/'Assets/Scenes'),
                              'available': bool(scan.scenes), 'scene_count': len(scan.scenes)})
        for record in scan.records:
            data, native = record['data'], record['native_id']
            sid = self.config.get('html_scenario_links', {}).get(native) or 'unity:'+native
            title = data.get('short_title') or data.get('title') or native
            s = self.scenarios.get(sid) or self.scenario(sid, data.get('title') or title)
            for evidence in [record['scene']]+record['evidence']:
                self.add_source(s, evidence, 'Unity VR', native, record['mechanism'])
            items, stages = data.get('items', []), data.get('stages', [])
            count = data.get('topic_count') or len(items)
            exercises = sum(len(stage.get('items', [])) for stage in stages) if stages else count
            if record['mechanism'] == 'reconstruction':
                label = 'Unity VR · Κυκλικό αναλόγιο · '+title
                note = (f"Στο δωμάτιο {record['room']} ο μαθητής στοχεύει τα {count} χειρόγραφα με το τόξο, "
                        'διαβάζει τις πηγές που αποκαλύπτονται και μεταφέρει τα χειρόγραφα από το αναλόγιο στις σωστές θέσεις της εικόνας. '
                        'Η συλλογή και οι σωστές τοποθετήσεις μετρώνται χωριστά. Κάθε σωστή σύνδεση φωτίζει τη δική της περιοχή.')
                modes = ['στόχευση χειρογράφων', 'συλλογή', 'ανασύνθεση εικόνας', 'αιτιολόγηση']
            elif record['mechanism'] == 'circular-discovery':
                label = 'Unity VR · Κυκλικό αναλόγιο · '+title
                note = (f"Στο δωμάτιο {record['room']} ο μαθητής στοχεύει τα {count} χειρόγραφα και μελετά τις θεματικές πηγές που αποκαλύπτονται. "
                        'Η επιλογή διατίθεται από την εναλλαγή σεναρίου του κυκλικού αναλογίου.')
                modes = ['στόχευση χειρογράφων', 'μελέτη πηγών', 'συζήτηση']
            else:
                label = 'Unity VR · Σταδιακή αποκάλυψη εικόνας · '+title
                phases = f' σε {len(stages)} φάσεις' if stages else ''
                note = (f"Στα {record['room']} υπάρχει επιλογή «Σταδιακή αποκάλυψη εικόνας». "
                        f'Ο μαθητής συλλέγει τους {count} παπύρους{phases}, μελετά το περιεχόμενο και τις υποδείξεις, '
                        'στοχεύει με τόξο τις αντίστοιχες περιοχές της εικόνας και απαντά στο ερώτημα ολοκλήρωσης. '
                        'Η δραστηριότητα και η συλλογή της είναι ανεξάρτητες από το κανονικό quiz του δωματίου.')
                if native == 'two_ways_of_knowing':
                    note += ' Οι έξι συνδέσεις αφορούν: '+', '.join(item['name'] for item in items if item.get('name'))+'.'
                modes = ['συλλογή παπύρων', 'σταδιακή αποκάλυψη εικόνας', 'αντιστοίχιση', 'αιτιολόγηση']
            note += ' Επιβεβαιώθηκε από τα τρέχοντα αρχεία και την ανάθεση στη σκηνή· δεν ελέγχθηκε σε φυσικό Quest.'
            self.activity(s, 'vr', label, path=record['path'], app='Unity VR', native_id=native, note=note,
                          identity_key='unity:'+record['scene'].stem+':'+record['mechanism']+':'+native,
                          room=record['room'], scene_name=record['scene'].stem, exercise_count=exercises,
                          stage_count=len(stages), reveal_mode=record['mechanism'], availability_status='scene-bound')
            s['modes'] += modes
            if not s['objectives'] and data.get('subtitle'):
                s['objectives'] = [data['subtitle']]
        for support in scan.support_records:
            native = support['native_id']
            sid = self.config.get('html_scenario_links', {}).get(native) or self.rules.get('unity_support_links', {}).get(native)
            if sid in self.scenarios:
                self.read_text(support['path'])
                self.add_source(self.scenarios[sid], support['path'], 'Unity · υποστήριξη δραστηριότητας', native, support['class'])
            else:
                self.warnings.append({'path': str(support['path']), 'message': 'Προφίλ Unity χωρίς τεκμηριωμένη σύνδεση: '+native})
        indexed = {a.get('native_id') for s in self.scenarios.values() for a in s['activities'] if a['kind'] == 'vr'}
        for path in scan.candidates:
            data = self.read(path, {})
            native = data.get('lesson_id') or data.get('id')
            if native not in indexed:
                relative = str(path.relative_to(self.unity/'Assets'))
                exclusion = self.rules.get('unity_exclusions', {}).get(relative, {})
                bound = any(relative in scene['bindings'] for scene in scan.scenes)
                if not bound and exclusion.get('sha256') == hashlib.sha256(path.read_bytes()).hexdigest():
                    self.classified_exclusions.append({'path': str(path), 'reason': exclusion['reason']})
                    continue
                self.warnings.append({'path': str(path), 'message': 'Νέα παιδαγωγική πηγή Unity χωρίς ταξινόμηση: '+str(native)})

    def light_up_legacy(self):
        base = self.app_dir('light-up-legacy')
        models = self.read(base/'public/sculptures.json', {})
        contributions = self.read(base/'public/contributions.json', {})
        self.coverage.append({'system': 'Light Up Legacy', 'path': str(base), 'available': bool(models),
                              'check': 'Κατάλογος μοντέλων και πραγματικό τρέχον θέμα ελέγχονται χωριστά.'})
        s = self.scenarios.get('book:lesson-004')
        if not s:
            return
        model = next((m for m in models.get('models', []) if m.get('id') == 'tree-revelation'), None)
        activity = next((a for a in s['activities'] if '/light-up-legacy/' in a.get('url', '')), None)
        if activity and model:
            self.add_source(s, base/'public/sculptures.json', 'Light Up Legacy', model['id'])
            self.add_source(s, base/'public/contributions.json', 'Light Up Legacy', 'current-contributions')
            activity.update(kind='model', app='light-up-legacy', native_id=model['id'],
                            label='Light Up Legacy · μοντέλο «Δέντρο της Αποκάλυψης»', availability_status='model-only',
                            note='Υπάρχει το τρισδιάστατο μοντέλο με έξι περιοχές. Στην εφαρμογή πάτησε «Γλυπτό μαθήματος» και επίλεξε «Δέντρο της Αποκάλυψης». '
                                 'Δεν είναι έτοιμο σενάριο Αποκάλυψης: το δημοσιευμένο περιεχόμενο συνεισφορών αφορά «'+contributions.get('topic', 'θέμα προς επιβεβαίωση')+'».')
        elif activity:
            activity.update(kind='model', availability_status='unverified', url='',
                            note='Ο σύνδεσμος υπάρχει στο βιβλίο, αλλά το αντίστοιχο μοντέλο δεν επαληθεύτηκε στον τρέχοντα κατάλογο.')
            self.warnings.append({'path': str(base), 'message': 'Μη επαληθευμένο μοντέλο Light Up Legacy.'})

    def books(self):
        published_book = mirror_root('interactive-books')/'Digital_Lessons/book.json'
        f=published_book if published_book.is_file() else self.book/'Digital_Lessons/book.json'
        book=self.read(f,{})
        self.coverage.append({'system':'Digital Book','path':str(f),'available':bool(book),'revision':book.get('revision')})
        self.book_revision=book.get('revision')
        self.book_url=book.get('publishing',{}).get('public_url','')
        for lesson in book.get('lessons',[]):
            lid=lesson['id']
            primary=self.config.get('book_lesson_links',{}).get(lid,'book:'+lid)
            split=lid in {'lesson-003','lesson-church-fathers'}
            general=None if split else self.scenario(primary,lesson.get('short_title') or lesson['title'])
            for section in lesson.get('sections',[]):
                secid=section['id']
                if 'teacher-answers' in secid:
                    continue
                sid=self.config.get('book_section_links',{}).get(secid)
                if not sid:
                    sid='book:'+secid if split or secid.endswith('-journey') else primary
                if lid=='lesson-foundations':
                    sid=self.config['book_section_links'].get(secid,primary)
                s=self.scenario(sid,section['title'] if sid.startswith('book:') and sid!='book:'+lid else lesson.get('short_title') or lesson['title'])
                src=self.add_source(s,f,'Digital Book',lid,f"lessons/{lid}/sections/{secid}")
                url=self.book_url+'#section-'+quote(secid)
                self.activity(s,'book','Digital Book · '+section['title'],url,section_id=secid,book_lesson_id=lid)
                s['modes'] += ['ανάγνωση','συζήτηση']
                if lid=='lesson-foundations':
                    self.set_audience(s,'Για όλες τις τάξεις')
                if not s['objectives']:
                    s['objective_status']='unconfirmed'
                for media in section.get('media',[]):
                    if media.get('type')=='slides' and media.get('url'):
                        self.activity(s,'slides',media.get('title') or 'Διαφάνειες',media['url'],media_id=media.get('media_id'))
            if general and not general['activities']:
                del self.scenarios[primary]
            if general:
                for link in lesson.get('app_links',[]):
                    url=link.get('url','')
                    if not url:
                        continue
                    supported = [v[2] for v in APP_INFO.values() if v[2]] + [
                        'https://docs.google.com/presentation/',
                        'https://dporpatonelis-crypto.github.io/Interactive-sculpture/',
                        'https://dporpatonelis-crypto.github.io/light-up-legacy/']
                    if not any(url.startswith(prefix) for prefix in supported):
                        self.warnings.append({'path': str(f), 'message': 'Νέα συνδεδεμένη εφαρμογή χωρίς έλεγχο πηγής: '+url})
                    kind = 'model' if '/light-up-legacy/' in url else 'slides' if 'docs.google.com/presentation' in url else 'html'
                    self.activity(general,kind,link.get('label','Εφαρμογή'),url,
                                  note='Σύνδεση που υπάρχει ήδη στο Digital Book.',media_id=link.get('media_id'))

    def sculpture(self):
        base=self.app_dir('interactive-sculpture')
        self.coverage.append({'system':'Interactive Sculpture','path':str(base),'available':base.is_dir()})
        for f in sorted((base/'scenarios').glob('*.json')):
            d=self.read(f,{})
            if not d.get('id'):
                continue
            s=self.scenario('sculpture:'+d['id'],d.get('title'),d.get('subject') or 'Θρησκευτικά')
            s['objectives']=[d['description']] if d.get('description') else []
            s['modes']+=['εξερεύνηση','ερμηνεία','συζήτηση']
            url='https://dporpatonelis-crypto.github.io/Interactive-sculpture/?scenario='+quote(d['id'])
            self.activity(s,'html','Interactive Sculpture',url,path=f,app='interactive-sculpture',native_id=d['id'])
            pres=d.get('sourcePresentation')
            if isinstance(pres,dict):
                pid=pres.get('presentationId') or pres.get('id')
                url=pres.get('url') or ('https://docs.google.com/presentation/d/'+pid+'/edit' if pid else '')
                if url:
                    self.activity(s,'slides','Παρουσίαση αναφοράς',url)
        snap=base/'data/slides-discoveries.json'
        data=self.read(snap,{})
        if data.get('discoveries'):
            sid='book:lesson-004' if 'book:lesson-004' in self.scenarios and 'αποκαλυψη' in norm(data.get('topic','')) else 'sculpture:slides-discovery'
            s=self.scenario(sid,data.get('topic','Ανακαλύψεις της τάξης'))
            self.add_source(s,snap,'Interactive Sculpture','slides-discovery')
            self.activity(s,'html','Interactive Sculpture · έξι ανακαλύψεις',
                          'https://dporpatonelis-crypto.github.io/Interactive-sculpture/?scenario=slides-discovery',
                          path=snap,app='interactive-sculpture',native_id='slides-discovery',
                          note='Περιεχόμενο από το υπάρχον Slides snapshot, '+data.get('source',{}).get('syncedAt',''))
            s['modes']+=['εξερεύνηση','ερμηνεία']

    def drive(self):
        cache=self.read(ROOT/'imports/google-drive.json',{})
        self.drive_checked=cache.get('checked_at')
        self.drive_folder=cache.get('folder')
        for f in cache.get('files',[]):
            sid=self.config.get('drive_links',{}).get(f['id']) or self.deck_targets.get(f['id']) or 'drive:'+f['id']
            s=self.scenario(sid,f['title'])
            self.add_source(s,ROOT/'imports/google-drive.json','Google Drive',f['id'],f"files/{f['id']}")
            a=self.activity(s,'slides',f['title'],f['url'],drive_id=f['id'],slide_count=len(f.get('slides',[])),
                            checked_at=self.drive_checked,modified_at=f.get('modified_time'),access_note='Ανοίγει με τα υπάρχοντα δικαιώματα Google Drive.')
            a['content_preview']=[{'title':slide['text'].split('\n')[0],'text':slide['text'],'slide_id':slide['id'],'url':f['url'].split('?')[0]+'#slide=id.'+slide['id']} for slide in f.get('slides',[])]
            s['modes']+=['παρατήρηση','συζήτηση']
            if not s['objectives']:
                s['objective_status']='unconfirmed'
            evidence=self.config.get('drive_link_evidence',{}).get(f['id'])
            if evidence:
                s['notes'].append(evidence)
        for f in cache.get('html_files',[]):
            local=ROOT/'imports/html'/f"{f['id']}.html"
            if not local.is_file() and f['title']=='jerusalem-quiz.html':
                local=self.apps/'jerusalem-shadow-fulfillment-quiz/jerusalem-quiz.html'
            embedded=[]
            if local.is_file():
                self.source(local,'Drive HTML',f['id'])
                text=local.read_text()
                for tag in ['lesson-data','initial-scenario','additional-scenarios']:
                    match=re.search(r'<script[^>]*id=[\"\x27]'+tag+r'[\"\x27][^>]*>(.*?)</script>',text,re.S)
                    if not match:
                        continue
                    try:
                        data=json.loads(match.group(1))
                        embedded += data.get('scenarios',[]) if tag=='lesson-data' else data if isinstance(data,list) else [data]
                    except ValueError:
                        self.warnings.append({'path':str(local),'message':'Δεν διαβάζεται το ενσωματωμένο JSON '+tag})
            if not embedded:
                embedded=[{'id':f['id'],'title':f['title']}]
            for data in embedded:
                native=data.get('lesson_id') or data.get('id')
                sid=self.config.get('html_scenario_links',{}).get(native)
                if not sid:
                    sid='unity:'+native if 'unity:'+native in self.scenarios else 'html:'+f['id']+':'+native
                s=self.scenario(sid,data.get('title') or f['title'])
                self.add_source(s,ROOT/'imports/google-drive.json','Drive HTML',f['id'],f"html_files/{f['id']}")
                label=data.get('title') or f['title']
                self.activity(s,'quiz' if data.get('exercises') else 'html','HTML · '+label,f['url'],path=local if local.is_file() else None,
                              app='drive-html' if local.is_file() else None,native_id=native,modified_at=f.get('modified_time'),
                              note='Από το μενού «Σενάρια» επίλεξε «'+label+'». Το αρχείο διατηρεί τον δικό του επιλογέα και όλους τους υπάρχοντες χειρισμούς.' if local.is_file() else 'Για εκτέλεση HTML, κατέβασε το αρχείο και άνοιξέ το στον browser. Η προεπισκόπηση Drive δεν το εκτελεί.',
                              drive_id=f['id'],drive_html=True,download_url='https://drive.google.com/uc?export=download&id='+f['id'])
                s['modes']+=['αντιστοίχιση','αιτιολόγηση']
                if not s['objectives'] and data.get('subtitle'):
                    s['objectives']=[data['subtitle']]
                evidence=self.config.get('html_link_evidence',{}).get(native)
                if evidence:
                    s['notes'].append(evidence)
                s['notes'].append('Το HTML παραμένει ενεργή εργασία. Αντίγραφο ανάγνωσης της έκδοσης '+str(f.get('modified_time','προς επιβεβαίωση'))+'.')

    def local_app_catalogs(self):
        # Inspect real app libraries even when their scenario already has a Sacred Blueprint source.
        locations={
            'idea-weaver-board':'src/data/library', 'Map-Timeline':'data',
            'history-explorer-3d':'public/data', 'mind-palace-cases':'cases',
            'personal-page':'public/data/lessons',
        }
        for name,relative in locations.items():
            base=self.app_dir(name)
            self.coverage.append({'system':name,'path':str(base),'available':base.is_dir()})
            titles = {}
            for catalog in [base/'catalog.json', base/relative/'manifest.json', base/relative/'index.json']:
                entries = self.read(catalog, {})
                entries = entries.get('scenarios', entries.get('lessons', [])) if isinstance(entries, dict) else entries
                for entry in entries if isinstance(entries, list) else []:
                    if isinstance(entry, dict) and entry.get('title'):
                        key = entry.get('id') or Path(entry.get('file', entry.get('dataFile', ''))).stem
                        titles[key] = entry['title']
            for p in sorted((base/relative).glob('*.json')):
                if p.stem in {'manifest','catalog','index','active-scenario'}:
                    self.read(p)
                    continue
                data=self.read(p)
                if not data:
                    continue
                mapping = self.rules.get('app_scenario_links', {}).get(name+':'+p.stem, {})
                if mapping and mapping.get('reviewed_blob_sha') != blob_sha(p.read_bytes()):
                    self.warnings.append({'path': str(p), 'message': 'Άλλαξε το περιεχόμενο τεκμηριωμένης αντιστοίχισης: '+name+':'+p.stem})
                    mapping = {}
                if mapping.get('scenario_id') in self.scenarios:
                    s = self.scenarios[mapping['scenario_id']]
                    self.add_source(s, p, name, p.stem)
                    info = next(v for v in APP_INFO.values() if v[0] == name)
                    self.activity(s, 'html', info[1], info[2], path=p, app=name, native_id=p.stem,
                                  note='Ελεγμένο δημοσιευμένο υλικό για το συγκεκριμένο μάθημα.')
                    s['notes'].append(mapping['evidence'])
                    continue
                candidates=[s for s in self.scenarios.values() if s['scenario_id']=='sb:'+self.config.get('lesson_aliases',{}).get(p.stem,p.stem) or
                            any(a.get('native_id')==p.stem and a.get('app')==name for a in s['activities'])]
                if candidates:
                    self.add_source(candidates[0],p,name,p.stem)
                else:
                    title = titles.get(p.stem) or (data.get('title') or data.get('topic') if isinstance(data, dict) else None) or p.stem
                    s=self.scenario('app:'+name+':'+p.stem, title)
                    self.add_source(s,p,name,p.stem)
                    info=next((v for v in APP_INFO.values() if v[0]==name),None)
                    if info and name!='personal-page':
                        self.activity(s,'html',info[1],info[2],path=p,app=name,native_id=p.stem)

    def finish(self):
        if self.warnings:
            self.refresh['status'] = 'partial'
        for s in self.scenarios.values():
            s['modes']=list(dict.fromkeys(s['modes']))
            s['grades']=list(dict.fromkeys(s['grades']))
            if not s['pedagogical_application']:
                if 'διερεύνηση' in s['modes']:
                    s['pedagogical_application']='Πρόταση: ξεκινήστε από το υπάρχον ερώτημα, συνδέστε δύο τεκμήρια και ζητήστε αιτιολόγηση.'
                elif 'quiz' in s['modes']:
                    s['pedagogical_application']='Πρόταση: η τάξη αιτιολογεί την αντιστοίχιση πριν επιλεγεί η απάντηση. Συζητήστε μία επιλογή μετά τον γύρο.'
                else:
                    s['pedagogical_application']='Πρόταση: παρατηρήστε το διαθέσιμο υλικό, κρατήστε ένα ερώτημα και επιστρέψτε στο κείμενο για συζήτηση.'
            if not s['activities']:
                s['readiness']='needs-confirmation'
                s['readiness_note']='Εντοπίστηκε πηγή· χρειάζεται επιβεβαίωση της διαθέσιμης δραστηριότητας.'
            s['notes']=list(dict.fromkeys(s['notes']))
        # Extensible metadata overlays never change the original app schemas.
        overlay=self.read(ROOT/'pedagogical-overrides.json',{})
        allowed={'grades','grade_status','objectives','cognitive_difficulty','cognitive_status','technical_difficulty','technical_status','duration','duration_status','pedagogical_application','application_status','subject'}
        for sid,fields in overlay.get('scenarios',{}).items():
            if sid in self.scenarios:
                self.scenarios[sid].update({k:v for k,v in fields.items() if k in allowed})
        for sid,fields in overlay.get('display',{}).items():
            if sid in self.scenarios:
                s=self.scenarios[sid]
                if fields.get('title'):
                    s['title']=fields['title']
                if fields.get('note'):
                    s['notes'].append(fields['note'])
        skills=[]
        for name in ['prepare-lesson-materials','sacred-blueprint-current-lesson','sacred-blueprint-lesson-sync','digital-book-studio','unity-lesson-timeline','update-media-library','unity-object-quiz-scenarios']:
            p=Path.home()/'.codex/skills'/name/'SKILL.md'
            if p.is_file():
                skills.append({'name':name,'path':str(p)})
        studio=Path.home()/'.codex/plugins/cache/personal/sacred-blueprint-studio/0.1.0+codex.20260809153518/skills/lesson-studio/SKILL.md'
        if studio.is_file():
            skills.append({'name':'sacred-blueprint-studio:lesson-studio','path':str(studio)})
        scenarios=sorted(self.scenarios.values(),key=lambda s:norm(s['title']))
        return {'schema_version':1,'generated_at':now(),'scenarios':scenarios,'grades':GRADES,
                'integrations':{'digital_book':{'url':getattr(self,'book_url',''),'revision':getattr(self,'book_revision',None)},
                                'google_drive':{'checked_at':getattr(self,'drive_checked',None),'folder':getattr(self,'drive_folder',None),'mode':'connector-snapshot'},
                                'skills':skills,'source_refresh':self.refresh},
                'inventory':{'coverage':self.coverage,'warnings':self.warnings,'source_count':len(self.audit),'scenario_count':len(scenarios),
                             'unity_scenes':self.unity_scan.scenes if self.unity_scan else [],
                             'unity_candidates':[str(p) for p in self.unity_scan.candidates] if self.unity_scan else [],
                             'classified_exclusions':self.classified_exclusions},
                'source_files':list(self.sources.values())}

    def build(self):
        self.lessons()
        self.unity_lessons()
        self.books()
        self.sculpture()
        self.drive()
        self.local_app_catalogs()
        self.covenant_tree()
        self.light_up_legacy()
        return self.finish()


def build_and_save(root=ROOT):
    builder=Builder()
    result=builder.build()
    write_json(Path(root)/'public/data/scenario-registry.json',result)
    write_json(Path(root)/'docs/source-hashes.json',builder.audit)
    return result


if __name__=='__main__':
    result=build_and_save()
    print(json.dumps({'scenarios':len(result['scenarios']),'source_files':result['inventory']['source_count'],'warnings':result['inventory']['warnings']},ensure_ascii=False))
