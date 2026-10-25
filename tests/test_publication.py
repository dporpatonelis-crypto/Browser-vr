import json
import re
import tempfile
import unittest
from urllib.parse import urlsplit
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.export_site import portable_registry


class PublicationTests(unittest.TestCase):
    def test_public_catalogue_contains_no_private_cache_or_machine_paths(self):
        text = (ROOT/'site/data/scenario-registry.json').read_text()
        registry = json.loads(text)
        self.assertGreater(len(registry['scenarios']), 0)
        self.assertEqual(len(registry['scenarios']), len({s['scenario_id'] for s in registry['scenarios']}))
        self.assertEqual([], registry['source_files'])
        self.assertNotIn('/Users/', text)
        self.assertNotIn('127.0.0.1', text)
        self.assertNotIn('local_url', text)
        self.assertNotIn('content_preview', text)
        self.assertNotIn('evaluations', registry)
        self.assertFalse((ROOT/'site/storage').exists())
        self.assertFalse((ROOT/'site/imports').exists())
        fresh = registry['integrations']['source_refresh']
        self.assertEqual('verified', fresh['status'])
        self.assertEqual(fresh['drive_slides'], len({a['drive_id'] for s in registry['scenarios'] for a in s['activities'] if a.get('kind') == 'slides' and a.get('drive_id') and a.get('checked_at')}))

    def test_revelation_launches_are_unique_and_availability_is_honest(self):
        registry = json.loads((ROOT/'site/data/scenario-registry.json').read_text())
        scenario = next(s for s in registry['scenarios'] if s['scenario_id'] == 'book:lesson-004')
        sculpture = [a for a in scenario['activities'] if 'Interactive-sculpture/' in a.get('url', '')]
        self.assertEqual(1, len(sculpture))
        reconstruction = next(a for a in scenario['activities'] if a.get('native_id') == 'revelation_map' and a['kind'] == 'vr')
        self.assertEqual('Room_christianity', reconstruction['scene_name'])
        self.assertEqual(6, reconstruction['exercise_count'])
        model = next(a for a in scenario['activities'] if a.get('app') == 'light-up-legacy')
        self.assertEqual('model', model['kind'])
        self.assertEqual('model-only', model['availability_status'])

    def test_export_extracts_exact_module_and_keeps_drive_material_in_drive(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root/'lesson.json'
            source.write_text(json.dumps({'timeline': [{'id': 'event-1', 'title': 'one'}], 'private': 'unrelated'}))
            registry = {'schema_version': 1, 'generated_at': 'now', 'grades': [],
                        'integrations': {'digital_book': {}, 'google_drive': {}},
                        'source_files': [{'key': 'key', 'path': str(source)}],
                        'scenarios': [{'scenario_id': 's', 'title': 'one', 'sources': [], 'activities': [
                            {'id': 'test-activity', 'app': 'Map-Timeline', 'kind': 'html', 'url': 'https://example.com/', 'source_key': 'key', 'source_module': 'timeline'},
                            {'id': 'drive', 'app': 'drive-html', 'kind': 'html', 'drive_html': True, 'url': 'https://drive.google.com/file/d/exact-id/view', 'local_url': '/launch/private'}]}]}
            public = portable_registry(registry, root/'out', 'https://example.org/Browser-vr/')
            activity = public['scenarios'][0]['activities'][0]
            self.assertIn('dataUrl=https%3A%2F%2Fexample.org', activity['url'])
            self.assertEqual([{'id': 'event-1', 'title': 'one'}], json.loads((root/'out/data/activities/test-activity.json').read_text()))
            self.assertEqual('https://drive.google.com/file/d/exact-id/view', public['scenarios'][0]['activities'][1]['url'])
            self.assertNotIn('local_url', json.dumps(public))

    def test_portable_activity_targets_all_match_exported_payloads(self):
        registry = json.loads((ROOT/'site/data/scenario-registry.json').read_text())
        for scenario in registry['scenarios']:
            for activity in scenario['activities']:
                url = activity.get('lesson_download_url')
                if url:
                    filename = url.removeprefix(registry['publication']['site_url'])
                    self.assertRegex(filename, r'^data/activities/[0-9a-f]{20}\.json$')
                    data = (ROOT/'site'/filename).read_text()
                    self.assertNotIn('/Users/', data)
                    self.assertIsNotNone(json.loads(data))

    def test_hosted_board_entry_and_its_compiled_assets_exist(self):
        root = ROOT/'site'
        html = (root/'apps/investigation/index.html').read_text()
        for value in re.findall(r'(?:src|href)="([^"]+)"', html):
            if value.startswith('/Browser-vr/apps/investigation/'):
                self.assertTrue((root/value.removeprefix('/Browser-vr/')).is_file(), value)
        registry = json.loads((root/'data/scenario-registry.json').read_text())
        for s in registry['scenarios']:
            for a in s['activities']:
                if a.get('app') == 'idea-weaver-board':
                    self.assertEqual('/Browser-vr/apps/investigation/', urlsplit(a['url']).path)


if __name__ == '__main__':
    unittest.main()
