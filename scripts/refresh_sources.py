#!/usr/bin/env python3
"""Verify fresh connector evidence and content-addressed read-only source mirrors."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAYOUT = {
    'sacred-blueprint': ('sacred_blueprint_root', '', 'local-authoring'),
    'idea-weaver-board': ('apps_root', 'idea-weaver-board', 'published'),
    'Map-Timeline': ('apps_root', 'Map-Timeline', 'published'),
    'history-explorer-3d': ('apps_root', 'history-explorer-3d', 'published'),
    'mind-palace-cases': ('apps_root', 'mind-palace-cases', 'published'),
    'personal-page': ('apps_root', 'personal-page', 'published'),
    'Interactive-sculpture': ('apps_root', 'interactive-sculpture', 'published'),
    'interactive-books': ('book_root', '', 'published'),
    'light-up-legacy': ('apps_root', 'light-up-legacy', 'published'),
}
SOURCE_SCOPES = {
    'sacred-blueprint': r'^lessons/.+/(?:meta|lesson_plan|master_output|.*output)\.json$',
    'idea-weaver-board': r'^src/data/(?:library/.*|clues)\.json$',
    'Map-Timeline': r'^(?:data/.*|catalog|active_lesson)\.json$',
    'history-explorer-3d': r'^public/data/.*\.json$',
    'mind-palace-cases': r'^(?:cases/.*|catalog|active_lesson)\.json$',
    'personal-page': r'^public/data/lessons/.*\.json$',
    'Interactive-sculpture': r'^(?:data|scenarios)/.*\.json$',
    'interactive-books': r'^Digital_Lessons/(?:book|data)\.json$',
    'light-up-legacy': r'^public/(?:sculptures|contributions)\.json$',
}


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def load(path, default=None):
    return json.loads(Path(path).read_text()) if Path(path).is_file() else default


def write(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n')


def blob_sha(content):
    return hashlib.sha1(b'blob '+str(len(content)).encode()+b'\0'+content).hexdigest()


def mirror_root(name):
    return ROOT/'imports/github'/name


def tree_files(name, tree):
    pattern = SOURCE_SCOPES.get(name, r'\.json$')
    return {item['path']: item['sha'] for item in tree.get('tree', [])
            if item.get('type') == 'blob' and re.search(pattern, item['path'])}


def safe_path(base, relative):
    path = (Path(base)/relative).resolve()
    if not path.is_relative_to(Path(base).resolve()):
        raise ValueError('Unsafe source path: '+relative)
    return path


def evidence_errors(receipt, state, current_time=None):
    errors = []
    if not receipt or not state or receipt.get('run_id') != state.get('run_id'):
        return ['Λείπει αποδεικτικό ελέγχου για την τρέχουσα ανανέωση.']
    start = datetime.fromisoformat(receipt['started_at'].replace('Z', '+00:00'))
    current_time = current_time or datetime.now(timezone.utc)
    def fresh(value):
        try:
            checked = datetime.fromisoformat(value.replace('Z', '+00:00'))
            return start <= checked <= current_time+timedelta(minutes=5) and current_time-checked <= timedelta(hours=2)
        except (ValueError, TypeError, AttributeError):
            return False
    repos = state.get('repositories', {})
    for name in LAYOUT:
        record = repos.get(name, {})
        if not fresh(record.get('checked_at')) or not record.get('head') or record.get('truncated', True):
            errors.append('Δεν ελέγχθηκε ο πλήρης σημερινός κατάλογος GitHub: '+name)
            continue
        if not record.get('files'):
            errors.append('Κενός κατάλογος πηγών: '+name)
        tree = load(ROOT/'imports/github-trees'/(name+'.json'), {})
        if not tree or tree.get('sha') != record.get('tree') or tree.get('truncated', True):
            errors.append('Λείπει το πλήρες τρέχον δέντρο πηγών: '+name)
        elif tree_files(name, tree) != {f['path']: f['sha'] for f in record.get('files', [])}:
            errors.append('Η απογραφή παραλείπει ή προσθέτει αρχεία σε σχέση με το τρέχον δέντρο GitHub: '+name)
        if LAYOUT[name][2] == 'local-authoring':
            continue
        for item in record.get('files', []):
            path = safe_path(mirror_root(name), item['path'])
            if not path.is_file() or blob_sha(path.read_bytes()) != item['sha']:
                errors.append('Το αντίγραφο δεν συμφωνεί με το τρέχον GitHub: '+name+'/'+item['path'])
    drive = state.get('drive', {})
    if not fresh(drive.get('checked_at')) or not drive.get('recursive_complete'):
        errors.append('Δεν ολοκληρώθηκε ο σημερινός έλεγχος του Drive και των υποφακέλων.')
    cache = load(ROOT/'imports/google-drive.json', {})
    current = {f['id']: f.get('modified_time') for f in drive.get('files', [])
               if f.get('index_as') in {'slides', 'html'}}
    imported = {f['id']: f.get('modified_time') for f in cache.get('files', [])+cache.get('html_files', [])}
    for key, modified in current.items():
        if imported.get(key) != modified:
            errors.append('Το Drive snapshot χρειάζεται ανανέωση: '+key)
    if set(imported)-set(current):
        errors.append('Το snapshot περιέχει αρχεία που λείπουν από τη σημερινή απογραφή Drive.')
    return errors


def prepare_mirrors(config, state):
    missing, differences = [], []
    for name, record in state.get('repositories', {}).items():
        key, child, authority = LAYOUT[name]
        local = Path(config[key])/child
        for item in record.get('files', []):
            source = safe_path(local, item['path'])
            same = source.is_file() and blob_sha(source.read_bytes()) == item['sha']
            if not same:
                differences.append({'repository': name, 'path': item['path'], 'authority': authority})
            if authority == 'local-authoring':
                continue
            target = safe_path(mirror_root(name), item['path'])
            if target.is_file() and blob_sha(target.read_bytes()) == item['sha']:
                continue  # Reused bytes have just been checked against the new remote tree.
            if same:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
            else:
                missing.append({'repository': name, 'path': item['path'], 'sha': item['sha'], 'ref': record['head']})
        # Removed remote files must not survive in the read-only mirror.
        allowed = {item['path'] for item in record.get('files', [])}
        base = mirror_root(name)
        if authority != 'local-authoring' and base.exists():
            for path in base.rglob('*.json'):
                if str(path.relative_to(base)) not in allowed:
                    path.unlink()
    return {'fetch': missing, 'local_published_differences': differences}


def summary():
    receipt = load(ROOT/'imports/refresh-receipt.json', {})
    state = load(ROOT/'imports/remote-state.json', {})
    errors = evidence_errors(receipt, state)
    files = state.get('drive', {}).get('files', [])
    return {'run_id': receipt.get('run_id'), 'started_at': receipt.get('started_at'),
            'checked_at': state.get('checked_at'), 'status': 'partial' if errors else 'verified',
            'github_repositories': len(state.get('repositories', {})),
            'drive_folders': len(state.get('drive', {}).get('folders', [])),
            'drive_slides': sum(f.get('index_as') == 'slides' for f in files),
            'drive_html': sum(f.get('index_as') == 'html' for f in files), 'errors': errors}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['begin', 'plan', 'verify'])
    parser.add_argument('--registry', type=Path)
    args = parser.parse_args()
    if args.action == 'begin':
        receipt = {'run_id': str(uuid.uuid4()), 'started_at': now()}
        write(ROOT/'imports/refresh-receipt.json', receipt)
        print(json.dumps(receipt))
        return
    config = load(ROOT/'config.json')
    state = load(ROOT/'imports/remote-state.json', {})
    plan = prepare_mirrors(config, state)
    write(ROOT/'imports/source-refresh-plan.json', plan)
    if args.action == 'plan':
        print(json.dumps(plan, ensure_ascii=False))
        return
    result = summary()
    if args.registry:
        registry = load(args.registry)
        if registry.get('integrations', {}).get('source_refresh', {}).get('run_id') != result['run_id']:
            result['errors'].append('Ο κατάλογος προέρχεται από άλλη ανανέωση.')
        hashes = load(ROOT/'docs/source-hashes.json', {})
        for filename, expected in hashes.items():
            path = Path(filename)
            if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                result['errors'].append('Η πηγή άλλαξε μετά τον έλεγχο: '+filename)
        try:
            from .unity_inventory import UnityInventory
        except ImportError:
            from unity_inventory import UnityInventory
        scan = UnityInventory(Path(config['unity_root'])/'Assets').scan()
        if {str(p) for p in scan.candidates} != set(registry.get('inventory', {}).get('unity_candidates', [])):
            result['errors'].append('Προστέθηκαν ή αφαιρέθηκαν παιδαγωγικά δεδομένα Unity μετά το build.')
        if {s['path'] for s in scan.scenes} != {s['path'] for s in registry.get('inventory', {}).get('unity_scenes', [])}:
            result['errors'].append('Ο κατάλογος σκηνών Unity άλλαξε μετά το build.')
        for source in registry.get('source_files', []):
            path = Path(source['path'])
            if source.get('sha256') and (not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != source['sha256']):
                result['errors'].append('Η πηγή άλλαξε μετά τη δημιουργία του καταλόγου: '+str(path))
        for scenario in registry['scenarios']:
            targets = [a['url'] for a in scenario['activities'] if a.get('url') and a.get('app') not in {'drive-html', 'idea-weaver-board', 'Map-Timeline', 'history-explorer-3d', 'mind-palace-cases'}]
            if len(targets) != len(set(targets)):
                result['errors'].append('Διπλός προορισμός δραστηριότητας: '+scenario['scenario_id'])
        result['errors'] += [w['message'] for w in registry.get('inventory', {}).get('warnings', [])]
        result['unity_scenes'] = registry.get('inventory', {}).get('unity_scenes', [])
        result['scenario_count'] = len(registry['scenarios'])
    result['status'] = 'partial' if result['errors'] else 'verified'
    result['local_published_differences'] = plan['local_published_differences']
    write(ROOT/'docs/source-refresh-report.json', result)
    print(json.dumps(result, ensure_ascii=False))
    if result['errors']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
