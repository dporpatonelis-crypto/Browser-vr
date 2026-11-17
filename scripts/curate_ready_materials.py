#!/usr/bin/env python3
"""Build a private, repeatable ready-material package from a teacher-reviewed manifest.

The manifest and payloads stay in storage/ or another private directory. Catalogue
identities are references, not copies of source lessons. No OCR is performed.
"""
import argparse
import base64
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from lesson_canvas import asset_metadata, validate_document


def stable(key):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'browser-vr:ready-materials:' + key))


def build(manifest_path, source_root, output, registry_path=None):
    manifest_path, source_root, output = map(lambda p: Path(p).resolve(), (manifest_path, source_root, output))
    if any(output.is_relative_to(ROOT/p) for p in ('public', 'site')):
        raise ValueError('Το ιδιωτικό πακέτο αποθηκεύεται εκτός δημόσιων φακέλων.')
    registry_path = registry_path or ROOT/'site/data/scenario-registry.json'
    registry = json.loads(Path(registry_path).read_text())
    manifest = json.loads(manifest_path.read_text())
    scenarios = {s['scenario_id']: s for s in registry['scenarios']}
    js = "const m=await import(process.argv[1]);console.log(JSON.stringify({workspace_id:m.LM_WORKSPACE_ID,canvas:m.lmNewCanvas()}));"
    template = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', js, (ROOT/'public/lesson-map-domain.mjs').as_uri()], text=True))
    workspace_id = manifest.get('workspace_id', template['workspace_id'])
    uuid.UUID(workspace_id)
    assets, documents, placements = {}, [], []
    for lesson in manifest['lessons']:
        did = lesson.get('canvas_id') or stable(manifest['key'] + ':' + lesson['key'])
        if lesson.get('reference_only'):
            uuid.UUID(did)
            placements.append({'id': stable('placement:' + workspace_id + ':' + did), 'canvas_id': did, 'theme_id': lesson['theme_id']})
            continue
        doc = json.loads(json.dumps(template['canvas']))
        doc.update(title=lesson['title'], grade=manifest['grade'], registered=True,
                   scenario_id=lesson.get('scenario_id') or 'notes:' + did)
        buildings = {b['id']: b for b in doc['buildings']}
        first_source = None
        related = set()
        for entry in lesson['materials']:
            material = {'id': '', 'label': entry['label'], 'type': 'image', 'text': '', 'url': '',
                        'asset_id': '', 'activity_id': '', 'source_scenario_id': '', 'page_start': 1, 'page_end': 1}
            if 'file' in entry:
                path = (source_root/entry['file']).resolve()
                if not path.is_relative_to(source_root):
                    raise ValueError('Το αρχείο υλικού πρέπει να βρίσκεται στον κατάλογο πηγών.')
                payload = path.read_bytes()
                provenance = entry['provenance']
                key = '|'.join(str(provenance.get(k, '')) for k in ('drive_id', 'page', 'variant'))
                aid = stable('asset:' + key + ':' + hashlib.sha256(payload).hexdigest())
                mime = mimetypes.guess_type(path.name)[0]
                name = entry.get('asset_name', path.name)
                metadata = asset_metadata(aid, name, mime, payload)
                if not mime.startswith('image/'):
                    raise ValueError('Η κατανομή έτοιμων εικόνων δέχεται μόνο εικόνες· όχι ολόκληρα βιβλία.')
                assets[aid] = {**metadata, 'base64': base64.b64encode(payload).decode()}
                material.update(id=entry.get('material_id') or stable('material:' + key), asset_id=aid, provenance=provenance)
                first_source = first_source or metadata
            else:
                sid, activity_id = entry['scenario_id'], entry['activity_id']
                activity = next(a for a in scenarios[sid]['activities'] if a['id'] == activity_id)
                if activity['kind'] not in ('html', 'quiz') or not activity.get('url'):
                    raise ValueError('Η επιλεγμένη δραστηριότητα πρέπει να είναι υπάρχον έτοιμο HTML.')
                material.update(id=stable('activity:' + sid + ':' + activity_id), type='html',
                                activity_id=activity_id, source_scenario_id=sid)
                related.add(sid)
            buildings[entry['building']]['materials'].append(material)
        if not any(b['materials'] for b in doc['buildings']):
            raise ValueError('Η πόλη χρειάζεται τουλάχιστον ένα έτοιμο υλικό.')
        if not lesson.get('scenario_id'):
            if first_source is None:
                raise ValueError('Ένα νέο ιδιωτικό μάθημα χρειάζεται την εικόνα προέλευσής του.')
            doc['import_source'] = {'asset_id': first_source['id'], 'sha256': first_source['sha256'],
                                    'name': first_source['name'], 'type': 'image', 'extraction': 'manual',
                                    'page_start': 1, 'page_end': 1, 'total_pages': 1, 'focus': '',
                                    'keywords': [], 'related_scenario_ids': sorted(related), 'exercise_regions': []}
        doc = validate_document('canvas', doc, registry, did)
        documents.append([did, {'kind': 'canvas', 'document': doc}])
        placements.append({'id': stable('placement:' + (workspace_id + ':' if workspace_id != template['workspace_id'] else '') + did), 'canvas_id': did, 'theme_id': lesson['theme_id']})
    bundle = {'format': 'lesson-map-transfer', 'schema_version': 1, 'documents': documents,
              'assets': list(assets.values()), 'curation': {'workspace_id': workspace_id,
                                                         'themes': manifest['themes'], 'placements': placements,
                                                         **{k: manifest[k] for k in ('title', 'grade', 'visual_theme', 'lesson_relations') if k in manifest}}}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + '.tmp')
    temporary.write_text(json.dumps(bundle, ensure_ascii=False))
    os.chmod(temporary, 0o600)
    verify = "import fs from 'node:fs';const m=await import(process.argv[1]);m.lmValidateTransfer(JSON.parse(fs.readFileSync(process.argv[2])));"
    try:
        subprocess.run(['node', '--input-type=module', '-e', verify, (ROOT/'public/lesson-map-domain.mjs').as_uri(), str(temporary)], check=True)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    return {'canvases': len(documents), 'assets': len(assets), 'bytes': output.stat().st_size}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--registry', type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.manifest, args.source_root, args.output, args.registry)))
