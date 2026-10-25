#!/usr/bin/env python3
"""Bundle the approved UI and catalogue for an owner-only Google web app."""
import argparse
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build_cloud(owner, site=ROOT/'site', output=ROOT/'cloud/generated'):
    site, output = Path(site), Path(output)
    registry = json.loads((site/'data/scenario-registry.json').read_text())
    # Preserve slide text only in the owner-only service, never in the public export.
    local_registry = ROOT/'public/data/scenario-registry.json'
    if local_registry.is_file():
        originals = {a['id']: a for s in json.loads(local_registry.read_text())['scenarios'] for a in s['activities']}
        for scenario in registry['scenarios']:
            for activity in scenario['activities']:
                original = originals.get(activity['id'], {})
                if activity.get('kind') == 'slides' and original.get('content_preview'):
                    activity['content_preview'] = copy.deepcopy(original['content_preview'])
    models = json.loads((site/'data/pedagogical-models.json').read_text())
    css = (site/'styles.css').read_text()
    domain = (site/'domain.mjs').read_text().replace('export function ', 'function ')
    app = (site/'app.mjs').read_text().replace("import {filterScenarios, relevantHistory} from './domain.mjs';", '')
    scripts = (domain + '\n' + app).replace('</script', '<\\/script')
    html = (site/'index.html').read_text()
    html = html.replace('<link rel="stylesheet" href="styles.css">', '<style>'+css+'</style>')
    html = html.replace('href="icon.svg"', 'href="'+registry['publication']['site_url']+'icon.svg"')
    html = html.replace('<script type="module" src="app.mjs"></script>',
                        '<script>window.__MISSION_CLOUD__=__MISSION_BOOTSTRAP__;</script>\n<script type="module">'+scripts+'</script>')
    backend = (ROOT/'cloud/Code.gs').read_text()
    for marker, value in [('__CATALOG__', registry), ('__MODELS__', models), ('__PRIVATE_PAGE__', html)]:
        backend = backend.replace(marker, json.dumps(value, ensure_ascii=False))
    backend = backend.replace('__OWNER_EMAIL__', owner)
    output.mkdir(parents=True, exist_ok=True)
    (output/'Code.gs').write_text(backend, encoding='utf-8')
    (output/'appsscript.json').write_text((ROOT/'cloud/appsscript.json').read_text(), encoding='utf-8')
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--owner', required=True)
    args = parser.parse_args()
    print(build_cloud(args.owner))
