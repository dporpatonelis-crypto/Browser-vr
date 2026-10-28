"""Discover teaching data from current Unity scenes, not from a cached topic map."""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path

ROOMS = {'Room_jerusalem': 'Ιεροσόλυμα', 'Room_christianity': 'Χριστιανισμός',
         'Room_byzantium': 'Βυζάντιο', 'Room_agora_classical': 'Κλασική Αγορά',
         'Room_world_religions': 'Θρησκείες του κόσμου'}
ROOMS['Room_chronology'] = 'Παρατηρητήριο του Χρόνου'
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
        self.synthetic_id = -10**20

    def resolve(self, ref):
        match = re.search(r'guid: ([a-f0-9]{32})', ref)
        return self.guid_paths.get(match[1]) if match else None

    def json(self, path):
        try:
            return json.loads(self.read_text(path))
        except (ValueError, OSError) as error:
            self.warnings.append({'path': str(path), 'message': str(error)})
            return {}

    def prefab_parts(self, document, scene):
        """Resolve saved prefab instances, including data/enabled overrides.

        Local file IDs are namespaced numerically so repeated prefab instances do
        not share components. External asset GUID references remain untouched.
        """
        parts = blocks(document)
        origins = {key: [] for key in parts}
        queue = [(key, (), 0) for key in parts]
        while queue:
            instance_id, chain, depth = queue.pop(0)
            instance = parts[instance_id]
            prefab = self.resolve(reference(instance, 'm_SourcePrefab'))
            if not prefab or prefab.suffix != '.prefab':
                continue
            if prefab in chain or depth >= 12:
                self.warnings.append({'path': str(scene), 'message': 'Κυκλική ή υπερβολικά βαθιά αναφορά prefab.'})
                continue
            if not prefab.is_file():
                self.warnings.append({'path': str(scene), 'message': 'Λείπει το συνδεδεμένο prefab '+str(prefab)})
                continue
            children = blocks(self.read_text(prefab))
            for override in re.finditer(r'^    - target: \{([^}]+)\}\n(.*?)(?=^    - target:|^    m_Removed|^  [A-Za-z_]+:|\Z)', instance, re.M | re.S):
                target = re.search(r'fileID: (-?\d+)', override[1])
                prop = re.search(r'^      propertyPath: (.+)$', override[2], re.M)
                if not target or target[1] not in children or not prop:
                    continue
                name = prop[1]
                if '.' in name:
                    if name.startswith(('initialLesson.', 'availableScenarios.', 'definitionJson.', 'scenario.')):
                        self.warnings.append({'path': str(scene), 'message': 'Μη υποστηριζόμενη σύνθετη αλλαγή δεδομένων prefab: '+name})
                    continue
                value = re.search(r'^      value:([^\n]*)', override[2], re.M)
                obj = re.search(r'^      objectReference: (\{[^}]+\})', override[2], re.M)
                replacement = value[1].strip() if value else ''
                if not replacement and obj:
                    replacement = obj[1]
                children[target[1]] = re.sub(r'^  '+re.escape(name)+r':[^\n]*$',
                                              lambda _: '  '+name+': '+replacement, children[target[1]], flags=re.M)
            mapping = {}
            for key in children:
                self.synthetic_id -= 1
                mapping[key] = str(self.synthetic_id)
            parent = reference(instance, 'm_TransformParent')
            for key, content in children.items():
                def remap(match):
                    ref = match[1]
                    if 'guid:' in ref:
                        return match[0]
                    return '{'+re.sub(r'fileID: (-?\d+)', lambda m: 'fileID: '+mapping.get(m[1], m[1]), ref)+'}'
                content = re.sub(r'\{([^{}]+)\}', remap, content)
                if parent and reference(content, 'm_Father') == 'fileID: 0':
                    content = content.replace('  m_Father: {fileID: 0}', '  m_Father: {'+parent+'}')
                synthetic = mapping[key]
                parts[synthetic] = content
                origins[synthetic] = list(chain)+( [prefab] )
                queue.append((synthetic, chain+(prefab,), depth+1))
        return parts, origins

    def scan(self):
        if not self.assets.is_dir():
            self.warnings.append({'path': str(self.assets), 'message': 'Το Unity project δεν είναι προσβάσιμο.'})
            return self
        for pattern in ('*.json.meta', '*.asset.meta', '*.prefab.meta', '*.cs.meta', '*.mp4.meta'):
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
            native = data.get('lesson_id') or data.get('id') or data.get('scenarioId')
            if native and any(key in data for key in ('items', 'exercises', 'phases', 'intro', 'rounds', 'activities')):
                self.candidates.append(path)
                self.json_by_id.setdefault(native, []).append((path, data))
        for scene in sorted((self.assets/'Scenes').glob('*.unity')):
            document = self.read_text(scene)
            parts, origins = self.prefab_parts(document, scene)
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
            for component_id, component in parts.items():
                cls = field(component, 'm_EditorClassIdentifier')
                if field(component, 'm_Enabled', '1') == '0':
                    continue
                game = re.search(r'fileID: (-?\d+)', reference(component, 'm_GameObject'))
                # Selector alternatives may be inactive until selected; the selector itself must be active.
                if game and not active(game[1]):
                    continue
                before = len(self.records)
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
                elif cls.endswith('.ConcentricPuzzleController'):
                    path = self.resolve(reference(component, 'initialLesson'))
                    data = self.json(path) if path and path.is_file() else {}
                    native = data.get('scenarioId')
                    if not native or not data.get('rounds'):
                        self.warnings.append({'path': str(scene), 'message': 'Λείπει ο συνδεδεμένος κατάλογος των ομόκεντρων δακτυλίων.'})
                        continue
                    self.records.append({'mechanism': 'concentric-rings', 'native_id': native,
                                         'path': path, 'data': {**data, 'topic_count': len(data['rounds'])},
                                         'scene': scene, 'evidence': [path], 'room': ROOMS.get(scene.stem, scene.stem)})
                    bindings.append(native)
                elif cls.endswith('.ChronologyRoomController'):
                    video_id = re.search(r'fileID: (-?\d+)', reference(component, 'rearVideo'))
                    player = parts.get(video_id[1], '') if video_id else ''
                    clip = self.resolve(reference(player, 'm_VideoClip'))
                    self.records.append({'mechanism': 'room-preview', 'native_id': 'chronology_observatory',
                                         'path': scene, 'scene': scene, 'evidence': [clip] if clip else [],
                                         'data': {'title': 'Παρατηρητήριο του Χρόνου', 'topic_count': 0,
                                                  'video_bound': bool(clip and clip.is_file()),
                                                  'play_on_entry': field(component, 'playOnEntry') == '1'},
                                         'room': ROOMS.get(scene.stem, scene.stem)})
                    bindings.append('chronology_observatory')
                elif cls.endswith('.InterpretationController'):
                    catalog = self.resolve(reference(component, 'catalog'))
                    catalog_text = self.read_text(catalog) if catalog and catalog.is_file() else ''
                    refs = re.search(r'^  scenarios:\n(.*?)(?=^  [A-Za-z_]+:|\Z)', catalog_text, re.M | re.S)
                    scenario_paths = [self.guid_paths.get(guid) for guid in re.findall(r'guid: (\w+)', refs[1] if refs else '')]
                    if not scenario_paths:
                        self.warnings.append({'path': str(scene), 'message': 'Λείπει ο συνδεδεμένος κατάλογος πατερικών ερμηνειών.'})
                    for path in scenario_paths:
                        text = self.read_text(path) if path and path.is_file() else ''
                        native = field(text, 'id')
                        source = self.resolve(reference(text, 'sourceLessonJson'))
                        source_data = self.json(source) if source and source.is_file() else {}
                        if not native or not source_data:
                            self.warnings.append({'path': str(catalog), 'message': 'Ελλιπές συνδεδεμένο σενάριο πατερικών ερμηνειών.'})
                            continue
                        self.records.append({'mechanism': 'interpretation-threads', 'native_id': native,
                                             'path': path, 'scene': scene, 'room': ROOMS.get(scene.stem, scene.stem),
                                             'evidence': [path, catalog, source],
                                             'data': {'title': field(text, 'title'),
                                                      'topic_count': len(re.findall(r'^  - id:', text, re.M)),
                                                      'source_lesson_id': source_data.get('id')}})
                        bindings.append(native)
                elif cls.endswith('.InteractiveWebBookController'):
                    path = self.resolve(reference(component, 'lessonProfile'))
                    text = self.read_text(path) if path and path.is_file() else ''
                    native = field(text, 'lessonId')
                    if native:
                        self.records.append({'mechanism': 'web-book', 'native_id': native,
                                             'path': path, 'scene': scene, 'room': ROOMS.get(scene.stem, scene.stem),
                                             'evidence': [path], 'data': {'title': field(text, 'lessonTitle'), 'topic_count': 2}})
                        bindings.append(native)
                for record in self.records[before:]:
                    record['evidence'] += origins.get(component_id, [])
                    script = self.resolve(reference(component, 'm_Script'))
                    if script:
                        self.read_text(script)
                        record['evidence'].append(script)
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
