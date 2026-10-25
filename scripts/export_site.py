#!/usr/bin/env python3
"""Export a portable site, without local paths, teacher records or Drive copies."""
from __future__ import annotations

import argparse
import copy
import json
import re
import shutil
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
SCENARIO_FIELDS = {
    'scenario_id', 'title', 'subject', 'grades', 'grade_status', 'audience_source',
    'objectives', 'modes', 'formats', 'duration', 'duration_status',
    'cognitive_difficulty', 'cognitive_status', 'technical_difficulty', 'technical_status',
    'readiness', 'readiness_note', 'pedagogical_application', 'application_status',
    'aliases', 'notes', 'source_groups', 'inquiry_question',
}
ACTIVITY_FIELDS = {
    'id', 'kind', 'label', 'url', 'note', 'app', 'native_id', 'drive_id', 'download_url',
    'drive_html', 'section_id', 'book_lesson_id', 'media_id', 'slide_count',
    'checked_at', 'modified_at', 'access_note', 'room', 'exercise_count',
}
NATIVE_APPS = {'idea-weaver-board', 'Map-Timeline', 'history-explorer-3d', 'mind-palace-cases'}


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def without_paths(value):
    if isinstance(value, str):
        return re.sub(r'/Users/[^\s<>"\']+', 'τοπική πηγή', value)
    if isinstance(value, list):
        return [without_paths(x) for x in value]
    if isinstance(value, dict):
        return {k: without_paths(v) for k, v in value.items()}
    return value


def https_link(value):
    try:
        parsed = urlsplit(value or '')
        return value if parsed.scheme == 'https' and parsed.netloc and not parsed.username else ''
    except ValueError:
        return ''


def portable_registry(registry, output, site_url, cloud_url=''):
    output = Path(output)
    sources = {s['key']: s for s in registry.get('source_files', [])}
    result = {k: copy.deepcopy(registry[k]) for k in ('schema_version', 'generated_at', 'grades')}
    result['publication'] = {'mode': 'catalogue', 'site_url': site_url, 'cloud_url': https_link(cloud_url)}
    result['integrations'] = {k: copy.deepcopy(registry['integrations'][k]) for k in ('digital_book', 'google_drive')}
    result['source_files'] = []
    result['scenarios'] = []
    for source_scenario in registry['scenarios']:
        scenario = {k: copy.deepcopy(v) for k, v in source_scenario.items() if k in SCENARIO_FIELDS}
        scenario['sources'] = [{'system': s['system'], 'path': Path(s.get('path', '')).name,
                                'locator': s.get('locator', '')} for s in source_scenario['sources']]
        scenario['activities'] = []
        for original in source_scenario['activities']:
            activity = {k: copy.deepcopy(v) for k, v in original.items() if k in ACTIVITY_FIELDS}
            activity['url'] = https_link(activity.get('url'))
            source = sources.get(original.get('source_key'))
            if activity.get('app') in NATIVE_APPS and source:
                data = json.loads(Path(source['path']).read_text(encoding='utf-8'))
                if original.get('source_module'):
                    data = data[original['source_module']]
                relative = f'data/activities/{activity["id"]}.json'
                write_json(output / relative, without_paths(data))
                activity['lesson_download_url'] = site_url + relative
                parts = urlsplit(activity['url'])
                query = dict(parse_qsl(parts.query))
                query['dataUrl'] = activity['lesson_download_url']
                activity['url'] = urlunsplit(parts._replace(query=urlencode(query)))
                activity['note'] = (activity.get('note', '') + ' Το αρχείο του συγκεκριμένου μαθήματος είναι διαθέσιμο και για εισαγωγή στην εφαρμογή.').strip()
            if activity.get('app') == 'drive-html':
                activity['note'] = (activity.get('note', '') + ' Στην online έκδοση ανοίγει το αρχικό αρχείο στο Drive. Για εκτέλεση, κατέβασε το HTML και διάλεξε το αντίστοιχο σενάριο μέσα του.').strip()
            if activity['url'] or activity.get('kind') == 'vr':
                scenario['activities'].append(activity)
        result['scenarios'].append(scenario)
    return without_paths(result)


def export_site(output, site_url, cloud_url=''):
    output = Path(output)
    if output.resolve() in {ROOT.resolve(), (ROOT/'public').resolve()}:
        raise ValueError('Η εξαγωγή χρειάζεται χωριστό φάκελο.')
    if urlsplit(site_url).scheme != 'https' or not site_url.endswith('/'):
        raise ValueError('Η διεύθυνση δημοσίευσης πρέπει να είναι HTTPS και να τελειώνει σε /.')
    output.mkdir(parents=True, exist_ok=True)
    # Remove obsolete educational payloads as part of a repeat export, never source files.
    if (output/'data/activities').is_dir():
        shutil.rmtree(output/'data/activities')
    for filename in ('index.html', 'styles.css', 'app.mjs', 'domain.mjs', 'icon.svg'):
        shutil.copyfile(ROOT/'public'/filename, output/filename)
    registry = json.loads((ROOT/'public/data/scenario-registry.json').read_text())
    portable = portable_registry(registry, output, site_url, cloud_url)
    write_json(output/'data/scenario-registry.json', portable)
    shutil.copyfile(ROOT/'public/data/pedagogical-models.json', output/'data/pedagogical-models.json')
    html = (output/'index.html').read_text()
    html = html.replace('<script type="module"', '<meta name="mission-mode" content="catalogue">\n  <script type="module"')
    (output/'index.html').write_text(html, encoding='utf-8')
    (output/'.nojekyll').touch()
    return portable


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Εξαγωγή Πιλοτηρίου για GitHub Pages')
    parser.add_argument('--output', type=Path, default=ROOT/'site')
    parser.add_argument('--site-url', default='https://dporpatonelis-crypto.github.io/Browser-vr/')
    parser.add_argument('--cloud-url', default='')
    args = parser.parse_args()
    result = export_site(args.output, args.site_url, args.cloud_url)
    print(f'Εξήχθησαν {len(result["scenarios"])} μαθήματα στο {args.output}.')
