"""Discover teaching data from current Unity scenes, not from a cached topic map."""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

ROOMS = {'Room_jerusalem': 'Ιεροσόλυμα', 'Room_christianity': 'Χριστιανισμός',
         'Room_byzantium': 'Βυζάντιο', 'Room_agora_classical': 'Κλασική Αγορά',
         'Room_world_religions': 'Θρησκείες του κόσμου'}
IGNORED = {'Validation', 'Tests', 'Editor', 'ProductionArchive~', 'Source~', 'Backups~'}


def field(text, name, default=''):
    match = re.search(r'^  '+re.escape(name)+r':[^\S\n]*(.*)$', text, re.M)
    if not match:
        return default
    value = match[1].strip()
    if value.startswith('"'):
        tail = text[match.end():]
        while not value.endswith('"') and tail:
            line, _, tail = tail.partition('\n')
            if line.strip():
                value += ' '+line.strip()
        try:
            return ast.literal_eval(value)
        except (ValueError, SyntaxError):
            return value
    return value


def blocks(text):
    return {m[2]: m[3] for m in re.finditer(
        r'^--- !u!(\d+) &(-?\d+)[^\n]*\n(.*?)(?=^--- !u!|\Z)', text, re.M | re.S)}


def reference(text, name):
    match = re.search(r'^  '+re.escape(name)+r': \{([^}]+)\}', text, re.M)
    return match[1] if match else ''


class UnityInventory:
    def __init__(self, assets, read_text=None):
        self.assets = Path(assets)
        self.read_text = read_text or (lambda p: Path(p).read_text(encoding='utf-8', errors='replace'))
        self.records, self.warnings, self.scenes, self.candidates = [], [], [], []
        self.guid_paths = {}
        self.json_by_id = {}
        self.asset_candidates = {}
        self.support_records = []

    def resolve(self, ref):
        match = re.search(r'guid: ([a-f0-9]{32})', ref)
        return self.guid_paths.get(match[1]) if match else None

    def json(self, path):
        try:
            return json.loads(self.read_text(path))
        except (ValueError, OSError) as error:
            self.warnings.append({'path': str(path), 'message': str(error)})
            return {}

    def scan(self):
        if not self.assets.is_dir():
            self.warnings.append({'path': str(self.assets), 'message': 'Το Unity project δεν είναι προσβάσιμο.'})
            return self
        for pattern in ('*.json.meta', '*.asset.meta'):
            for meta in self.assets.rglob(pattern):
                if any(part in IGNORED or part.endswith('~') for part in meta.parts):
                    continue
                match = re.search(r'^guid: (\w+)', meta.read_text(errors='replace'), re.M)
                if match:
                    self.guid_paths[match[1]] = Path(str(meta)[:-5])
        # New pedagogical JSON anywhere in Assets must be classified by the builder.
        for path in sorted(self.assets.rglob('*.json')):
            if any(part in IGNORED or part.endswith('~') for part in path.parts):
                continue
            try:
                data = json.loads(path.read_bytes())
            except (ValueError, OSError):
                continue
            if not isinstance(data, dict):
                continue
            native = data.get('lesson_id') or data.get('id')
            if native and any(key in data for key in ('items', 'exercises', 'phases', 'intro')):
                self.candidates.append(path)
                self.json_by_id.setdefault(native, []).append((path, data))
        for scene in sorted((self.assets/'Scenes').glob('*.unity')):
            document = self.read_text(scene)
            parts = blocks(document)
            parents = {}
            for component in parts.values():
                game = re.search(r'fileID: (-?\d+)', reference(component, 'm_GameObject'))
                parent = re.search(r'fileID: (-?\d+)', reference(component, 'm_Father'))
                if game and parent:
                    parents[game[1]] = parent[1]
            def active(game_id, visited=None):
                visited = set() if visited is None else visited
                if game_id in visited:
                    return False
                visited.add(game_id)
                if field(parts.get(game_id, ''), 'm_IsActive', '1') == '0':
                    return False
                parent = parts.get(parents.get(game_id), '')
                grandparent = re.search(r'fileID: (-?\d+)', reference(parent, 'm_GameObject'))
                return not grandparent or active(grandparent[1], visited)
            bindings = []
            for component in parts.values():
                cls = field(component, 'm_EditorClassIdentifier')
                if field(component, 'm_Enabled', '1') == '0':
                    continue
                game = re.search(r'fileID: (-?\d+)', reference(component, 'm_GameObject'))
                # Selector alternatives may be inactive until selected; the selector itself must be active.
                if game and not active(game[1]):
                    continue
                if cls.endswith('.CovenantScenarioSelector'):
                    for option in re.finditer(r'^  - id: ([\w-]+)\n(.*?)(?=^  - id:|^  [A-Za-z_]+:|\Z)', component, re.M | re.S):
                        activity = re.search(r'activity: \{fileID: (-?\d+)\}', option[2])
                        controller = parts.get(activity[1], '') if activity else ''
                        path = self.resolve(reference(controller, 'definitionJson'))
                        if not path or not path.is_file():
                            self.warnings.append({'path': str(scene), 'message': 'Λείπουν τα συνδεδεμένα δεδομένα '+option[1]})
                            continue
                        data = self.json(path)
                        if data.get('lesson_id') != option[1]:
                            self.warnings.append({'path': str(path), 'message': 'Το ID δεδομένων διαφέρει από τον επιλογέα της σκηνής.'})
                            continue
                        self.records.append({'mechanism': 'image-reveal', 'native_id': option[1],
                                             'path': path, 'data': data, 'scene': scene, 'evidence': [path],
                                             'room': ROOMS.get(scene.stem, scene.stem)})
                        bindings.append(option[1])
                elif cls.endswith('.CircularManuscriptController'):
                    refs = re.search(r'^  availableScenarios:\n(.*?)(?=^  [A-Za-z_]+:|\Z)', component, re.M | re.S)
                    guids = re.findall(r'guid: (\w+)', (refs[1] if refs else '')+reference(component, 'initialScenario'))
                    for guid in dict.fromkeys(guids):
                        path = self.guid_paths.get(guid)
                        if not path or not path.is_file():
                            self.warnings.append({'path': str(scene), 'message': 'Λείπει σενάριο κυκλικού αναλογίου '+guid})
                            continue
                        text = self.read_text(path)
                        native = field(text, 'scenarioId')
                        if not native:
                            self.warnings.append({'path': str(path), 'message': 'Σενάριο αναλογίου χωρίς scenarioId.'})
                            continue
                        matches = self.json_by_id.get(native, [])
                        data = dict(matches[0][1]) if len(matches) == 1 else {}
                        data.update(title=field(text, 'displayTitle') or data.get('title') or native,
                                    instructions=field(text, 'instructions'),
                                    topic_count=len(re.findall(r'^  - stationId:', text, re.M)))
                        reconstruction = self.resolve(reference(text, 'reconstruction'))
                        concept = self.resolve(reference(text, 'conceptLesson'))
                        evidence = [path]+([matches[0][0]] if len(matches) == 1 else [])
                        for child_guid in re.findall(r'guid: (\w+)', text):
                            child = self.guid_paths.get(child_guid)
                            if child and child.suffix == '.asset':
                                self.read_text(child)
                                evidence.append(child)
                        if concept:
                            definition = self.read_text(concept)
                            catalog = self.resolve(reference(definition, 'catalog'))
                            content = self.json(catalog) if catalog and catalog.is_file() else {}
                            activities = content.get('activities', [])
                            topic_ids = re.findall(r'^    activityId: (.+)$', text, re.M)
                            if not activities or set(topic_ids) != {a.get('id') for a in activities}:
                                self.warnings.append({'path': str(concept), 'message': 'Τα θέματα αναλογίου διαφέρουν από τον συνδεδεμένο κατάλογο παζλ.'})
                            data.update(activities=activities, activity_count=len(activities))
                            if catalog:
                                evidence.append(catalog)
                        self.records.append({'mechanism': 'concept-canvas' if concept else 'reconstruction' if reconstruction else 'circular-discovery',
                                             'native_id': native, 'path': path, 'data': data, 'scene': scene,
                                             'evidence': evidence, 'room': ROOMS.get(scene.stem, scene.stem)})
                        bindings.append(native)
                elif cls.endswith('.CosmologyController'):
                    path = self.resolve(reference(component, 'scenario'))
                    if not path or not path.is_file():
                        self.warnings.append({'path': str(scene), 'message': 'Λείπει το συνδεδεμένο σενάριο κοσμολογιών.'})
                        continue
                    text = self.read_text(path)
                    native = field(text, 'scenarioId')
                    traditions = []
                    for item in re.finditer(r'^  - cardId: (.*?)(?=^  - cardId:|^  [A-Za-z_]+:|\Z)', text, re.M | re.S):
                        normalized = '  cardId: '+item[1]
                        normalized = re.sub(r'^    ', '  ', normalized, flags=re.M)
                        traditions.append({key: field(normalized, key) for key in
                                           ('cardId', 'stationId', 'displayName', 'cardTitle', 'statement',
                                            'sourceLabel', 'sourceUrl', 'hint', 'interpretation')})
                    if not native or not traditions or any(not t['cardId'] or not t['stationId'] for t in traditions):
                        self.warnings.append({'path': str(path), 'message': 'Ελλιπή δεδομένα συνδεδεμένου σεναρίου κοσμολογιών.'})
                        continue
                    self.records.append({'mechanism': 'cosmology-comparison', 'native_id': native,
                                         'path': path, 'scene': scene, 'evidence': [path],
                                         'room': ROOMS.get(scene.stem, scene.stem),
                                         'data': {'title': field(text, 'title'), 'instructions': field(text, 'instructions'),
                                                  'reflection': field(text, 'reflection'), 'traditions': traditions,
                                                  'topic_count': len(traditions)}})
                    bindings.append(native)
                # Find JSON attached to any component, including future directories/adapters.
                for guid in re.findall(r'guid: (\w+)', component):
                    path = self.guid_paths.get(guid)
                    if path and path in self.candidates:
                        bindings.append(str(path.relative_to(self.assets)))
                    elif path and path.suffix == '.asset':
                        with path.open(encoding='utf-8', errors='replace') as source:
                            header = source.read(8192)
                        native = field(header, 'scenarioId') or field(header, 'lessonId')
                        if native:
                            self.asset_candidates[path] = native
                            asset_class = field(header, 'm_EditorClassIdentifier')
                            if asset_class.endswith(('.TeacherSupportProfile', '.BookWebLessonProfile')):
                                self.support_records.append({'path': path, 'native_id': native, 'scene': scene,
                                                             'class': asset_class})
            self.scenes.append({'path': str(scene), 'bindings': list(dict.fromkeys(bindings))})
        handled = {p for record in self.records for p in record['evidence']} | {r['path'] for r in self.support_records}
        for path, native in self.asset_candidates.items():
            if path not in handled:
                self.warnings.append({'path': str(path), 'message': 'Σενάριο δεμένο σε σκηνή χωρίς προσαρμογέα: '+native})
        return self
