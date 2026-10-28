"""Read the published, self-contained concept canvases without executing lesson HTML."""
from __future__ import annotations
import hashlib
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import parse_qs

RELATIVE_ROOT = Path('apps/animated-concept-canvas')

def catalog_digest(data):
    return hashlib.sha256(json.dumps(data,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()

class JsonScripts(HTMLParser):
    def __init__(self):
        super().__init__(); self.scripts = {}; self.current = None
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'script' and attrs.get('type') == 'application/json' and attrs.get('id'):
            self.current = attrs['id']; self.scripts[self.current] = ''
    def handle_data(self, data):
        if self.current is not None: self.scripts[self.current] += data
    def handle_endtag(self, tag):
        if tag == 'script': self.current = None

def extract_embedded_canvases(text):
    """Read all units from a supplied Drive HTML, preserving its access boundary."""
    parser=JsonScripts();parser.feed(text)
    if 'embedded-catalog' not in parser.scripts: return []
    primary=json.loads(parser.scripts['embedded-catalog'])
    if primary.get('schemaVersion')!=1 or not primary.get('activities'): return []
    options=json.loads(parser.scripts.get('builtin-options','{}'))
    packs=[('embedded',primary)]+[(item['key'],item['catalog']) for item in options.get('catalogs',[])]
    return [{'id':data['id'],'title':data['title'],'concept_canvas':True,'catalog_key':key,
             'catalog_digest':catalog_digest(data),'activity_count':len(data['activities']),
             'activity_ids':[a['id'] for a in data['activities']],
             'activity_titles':[a['title'] for a in data['activities']]} for key,data in packs]


def inspect_concept_canvases(book_root, public_url):
    """Return independently launchable units with content/hash-verified provenance."""
    root = Path(book_root)/RELATIVE_ROOT
    path = root/'catalog.json'
    if not path.is_file(): return []
    manifest = json.loads(path.read_text())
    if manifest.get('schema_version') != 1 or manifest.get('app_id') != 'animated-concept-canvas':
        raise ValueError('Μη υποστηριζόμενος κατάλογος αναλογίων.')
    scripts = {}; hashes = {}
    for filename, expected in manifest.get('files', {}).items():
        if not re.fullmatch(r'[a-z0-9][a-z0-9.-]*\.html', filename) or '..' in filename:
            raise ValueError('Μη ασφαλές όνομα αρχείου αναλογίου.')
        file = root/filename
        content = file.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if digest != expected.get('sha256') or len(content) != expected.get('bytes'):
            raise ValueError('Το δημοσιευμένο αναλόγιο διαφέρει από τον κατάλογό του: '+filename)
        parser = JsonScripts(); parser.feed(content.decode('utf-8'))
        scripts[filename] = parser.scripts; hashes[filename] = digest
    entries = []; ids = set(); urls = set()
    for entry in manifest.get('entries', []):
        filename = entry.get('file', '')
        if filename not in scripts: raise ValueError('Αναλόγιο χωρίς επαληθευμένο HTML: '+filename)
        if entry.get('id') in ids: raise ValueError('Διπλή ενότητα αναλογίου.')
        ids.add(entry.get('id'))
        try: data = json.loads(scripts[filename][entry['script_id']])
        except (KeyError, ValueError) as error: raise ValueError('Λείπουν έγκυρα ενσωματωμένα δεδομένα αναλογίου.') from error
        key = entry.get('catalog_key')
        if key:
            data = next((item['catalog'] for item in data.get('catalogs', []) if item.get('key') == key), None)
        if not isinstance(data, dict) or data.get('id') != entry.get('catalog_id'):
            raise ValueError('Η ενότητα δεν αντιστοιχεί στο ενσωματωμένο πακέτο.')
        activities = data.get('activities', [])
        activity_ids = [a.get('id') for a in activities]
        if not activities or activity_ids != entry.get('activity_ids') or len(activity_ids) != len(set(activity_ids)):
            raise ValueError('Οι δραστηριότητες του καταλόγου διαφέρουν από το HTML.')
        for activity in activities:
            if len(activity.get('slots', [])) != len(activity.get('revealLayers', [])) or not activity.get('art', {}).get('image', '').startswith(('data:image/webp;base64,','data:image/png;base64,')):
                raise ValueError('Λείπει ενσωματωμένη εικόνα ή στοχευμένη αποκάλυψη.')
        fragment = entry.get('fragment', '')
        if fragment:
            options = json.loads(scripts[filename].get('builtin-options','{}'))
            unit = parse_qs(fragment).get('unit', [None])[0]
            expected_key = key or 'embedded'
            if not unit or options.get('units', {}).get(unit) != expected_key:
                raise ValueError('Ο σύνδεσμος δεν ανοίγει τη δηλωμένη ενότητα.')
        url = public_url.rstrip('/')+'/'+RELATIVE_ROOT.as_posix()+'/'+filename+('#'+fragment if fragment else '')
        if entry.get('url') != url: raise ValueError('Ο σύνδεσμος αναλογίου δεν αντιστοιχεί στη δημοσιευμένη θέση του.')
        if url in urls: raise ValueError('Διπλός προορισμός αναλογίου.')
        urls.add(url)
        entries.append({**entry, 'url': url, 'path': str(root/filename),
                        'manifest_path': str(path), 'sha256': hashes[filename],
                        'exercise_count': len(activities), 'artwork_count': len(activities),
                        'catalog_digest': catalog_digest(data),
                        'activity_titles': [a['title'] for a in activities]})
    return entries
