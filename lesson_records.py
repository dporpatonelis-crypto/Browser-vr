"""Private lesson plans and material snapshots, independent of catalogue refreshes."""
import json
import re
import uuid
from datetime import date, datetime, timezone


def identity(value):
    try:
        return str(uuid.UUID(value))
    except (ValueError, TypeError, AttributeError):
        raise ValueError('Χρειάζεται έγκυρο μοναδικό αναγνωριστικό.')


def context_fields(data):
    profile = data.get('class_profile', '')
    slot = data.get('time_slot', '')
    day = data.get('lesson_date', '')
    if not isinstance(profile, str) or len(profile) > 240 or any(ord(c) < 32 for c in profile):
        raise ValueError('Η περιγραφή τμήματος δέχεται έως 240 χαρακτήρες, χωρίς ονόματα μαθητών.')
    if slot not in ('', 'morning', 'midday'):
        raise ValueError('Επίλεξε πρωινή ώρα ή προς το μεσημέρι.')
    if not isinstance(day, str):
        raise ValueError('Μη έγκυρη ημερομηνία μαθήματος.')
    if day:
        try:
            date.fromisoformat(day)
            if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
                raise ValueError()
        except ValueError:
            raise ValueError('Μη έγκυρη ημερομηνία μαθήματος.')
    return {'class_profile': profile.strip(), 'time_slot': slot, 'lesson_date': day}


def material_snapshot(activity):
    return {k: activity.get(k, '') for k in ('id', 'kind', 'label', 'url', 'room', 'native_id')}


def select_materials(ids, scenario, plan=None):
    choices = {a['id']: a for a in (plan or {}).get('planned_materials', [])}
    choices.update({a['id']: material_snapshot(a) for a in scenario['activities']})
    if not isinstance(ids, list) or len(ids) > 100 or any(not isinstance(i, str) or i not in choices for i in ids):
        raise ValueError('Επίλεξε μέσα από το συγκεκριμένο μάθημα ή το αποθηκευμένο σχέδιο.')
    return [choices[i] for i in dict.fromkeys(ids)]


class PlanStore:
    def __init__(self, evaluation_store):
        self.store = evaluation_store
        self.directory = evaluation_store.directory / 'plans'
        self.directory.mkdir(parents=True, exist_ok=True)

    def read(self):
        rows = []
        for path in self.directory.glob('*.json'):
            try:
                row = json.loads(path.read_text())
                if not isinstance(row, dict) or not all(k in row for k in ('id', 'plan_id', 'created_at', 'scenario_id', 'planned_materials')) or not isinstance(row['planned_materials'], list):
                    raise ValueError()
                rows.append(row)
            except (ValueError, OSError):
                raise ValueError(f'Δεν διαβάζεται το σχέδιο {path.name}. Διατηρείται για ανάκτηση.')
        return sorted(rows, key=lambda r: (r['created_at'], r['id']), reverse=True)

    def version(self, version_id):
        key = identity(version_id)
        row = next((r for r in self.read() if r['id'] == key), None)
        if not row:
            raise ValueError('Δεν βρέθηκε η αποθηκευμένη έκδοση του σχεδίου.')
        return row

    def append(self, data, registry, models):
        if not isinstance(data, dict):
            raise ValueError('Μη έγκυρο σχέδιο.')
        request_id = identity(data.get('request_id'))
        plan_id = identity(data.get('plan_id') or request_id)
        previous = identity(data['previous_version_id']) if data.get('previous_version_id') else ''
        scenario = next((s for s in registry['scenarios'] if s['scenario_id'] == data.get('scenario_id')), None)
        model = next((m for m in models['models'] if m['id'] == data.get('model_id')), None)
        if not scenario or not model:
            raise ValueError('Επίλεξε υπάρχον μάθημα και παιδαγωγικό μοντέλο.')
        grade, section = data.get('grade', ''), data.get('section', '')
        if grade not in ['', *registry['grades']] or not isinstance(section, str) or len(section) > 40 or any(ord(c) < 32 for c in section) or (section.strip() and not grade):
            raise ValueError('Επίλεξε έγκυρη τάξη και σύντομο τμήμα.')
        notes = data.get('notes', '')
        if not isinstance(notes, str) or len(notes) > 2000:
            raise ValueError('Το σχέδιο δέχεται έως 2.000 χαρακτήρες σημειώσεων.')
        import fcntl
        with self.store.lock, (self.directory / '.append.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            versions = self.read()
            old = next((r for r in versions if r['id'] == request_id), None)
            base = next((r for r in versions if r['id'] == previous), None)
            ancestors = {r['previous_version_id'] for r in versions}
            latest = next((r for r in versions if r['plan_id'] == plan_id and r['id'] not in ancestors), None)
            if base and base['scenario_id'] != scenario['scenario_id']:
                raise ValueError('Το σχέδιο ανήκει σε άλλο μάθημα.')
            row = {'schema_version': 2, 'id': request_id, 'plan_id': plan_id, 'previous_version_id': previous,
                   'scenario_id': scenario['scenario_id'], 'scenario_title': scenario['title'],
                   'grade': grade, 'section': section.strip(), 'model_id': model['id'], 'model_title': model['title'],
                   **context_fields(data), 'notes': notes.strip(),
                   'planned_materials': select_materials(data.get('planned_material_ids'), scenario, base),
                   'objectives': scenario['objectives'], 'duration': scenario.get('duration'),
                   'route': [s for s in model['steps'] if not s.get('requires') or any(a['kind'] == s['requires'] for a in scenario['activities'])]}
            if old:
                keys = ['plan_id', 'previous_version_id', 'scenario_id', 'grade', 'section', 'model_id', 'class_profile', 'time_slot', 'lesson_date', 'notes']
                if any(old.get(k) != row[k] for k in keys) or [a['id'] for a in old['planned_materials']] != list(dict.fromkeys(data['planned_material_ids'])):
                    raise ValueError('Το αναγνωριστικό χρησιμοποιήθηκε για διαφορετικό σχέδιο.')
                return old, False
            if latest and (not base or base['id'] != latest['id'] or base['plan_id'] != plan_id):
                raise ValueError('Το σχέδιο άλλαξε από άλλη συσκευή. Άνοιξε την τελευταία έκδοση· οι επιλογές σου διατηρούνται.')
            if not latest and (previous or plan_id != request_id):
                raise ValueError('Δεν βρέθηκε το αρχικό σχέδιο.')
            row['created_at'] = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
            self.store.write_atomic(self.directory / f'{request_id}.json', row)
            return row, True
