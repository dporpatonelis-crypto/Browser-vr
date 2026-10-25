import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from scripts.build_registry import Builder
from scripts.refresh_sources import blob_sha, evidence_errors
from scripts.unity_inventory import UnityInventory


class RefreshRegressionTests(unittest.TestCase):
    def test_book_link_and_verified_local_source_become_one_activity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root/'snapshot.json'
            source.write_text('{"discoveries": [1]}')
            config = {key: folder for key in ('sacred_blueprint_root', 'apps_root', 'book_root', 'unity_root')}
            builder = Builder(config)
            scenario = builder.scenario('book:test', 'Test')
            url = 'https://example.org/Interactive-sculpture/?scenario=slides-discovery'
            first = builder.activity(scenario, 'html', 'Book reference', url, media_id='WEB-001')
            builder.activity(scenario, 'html', 'Verified source', url, path=source,
                             app='interactive-sculpture', native_id='slides-discovery', note='Read now')
            self.assertEqual(1, len(scenario['activities']))
            self.assertEqual(first['id'], scenario['activities'][0]['id'])
            self.assertEqual('WEB-001', first['media_id'])
            self.assertEqual('Read now', first['note'])
            self.assertTrue(first['source_key'])

    def test_new_scene_and_source_directory_are_discovered_without_a_topic_map(self):
        with tempfile.TemporaryDirectory() as folder:
            assets = Path(folder)
            (assets/'Scenes').mkdir()
            (assets/'NewTeachingMechanism').mkdir()
            scenario = assets/'NewTeachingMechanism/NewLesson.asset'
            scenario.write_text('--- !u!114 &11400000\nMonoBehaviour:\n  scenarioId: new_lesson\n  displayTitle: New lesson\n  topics:\n  - stationId: first\n    slotId: one\n')
            scenario.with_suffix('.asset.meta').write_text('guid: '+('a'*32))
            scene = assets/'Scenes/Room_new.unity'
            scene.write_text('--- !u!1 &1\nGameObject:\n  m_IsActive: 1\n--- !u!114 &2\nMonoBehaviour:\n  m_GameObject: {fileID: 1}\n  m_Enabled: 1\n  m_EditorClassIdentifier: Test.CircularManuscriptController\n  initialScenario: {fileID: 11400000, guid: '+('a'*32)+', type: 2}\n')
            scan = UnityInventory(assets).scan()
            self.assertEqual(['new_lesson'], [r['native_id'] for r in scan.records])
            self.assertEqual([], scan.warnings)
            scene.write_text(scene.read_text().replace('m_IsActive: 1', 'm_IsActive: 0'))
            self.assertEqual([], UnityInventory(assets).scan().records)

    def test_fresh_metadata_cannot_certify_stale_or_truncated_copies(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root/'imports/github/app').mkdir(parents=True)
            (root/'imports/github-trees').mkdir()
            (root/'imports/google-drive.json').write_text('{"files": [], "html_files": []}')
            target = root/'imports/github/app/data.json'
            content = b'{"id":"current"}'
            target.write_bytes(content)
            receipt = {'run_id': 'new', 'started_at': '2026-10-25T10:00:00Z'}
            tree = {'sha': 'tree', 'truncated': False, 'tree': [{'path': 'data.json', 'type': 'blob', 'sha': blob_sha(content)}]}
            (root/'imports/github-trees/app.json').write_text(json.dumps(tree))
            state = {'run_id': 'new', 'repositories': {'app': {'head': 'head', 'tree': 'tree', 'checked_at': '2026-10-25T10:00:01Z',
                     'truncated': False, 'files': [{'path': 'data.json', 'sha': blob_sha(content)}]}},
                     'drive': {'checked_at': '2026-10-25T10:00:01Z', 'recursive_complete': True, 'files': []}}
            with patch('scripts.refresh_sources.ROOT', root), patch('scripts.refresh_sources.LAYOUT', {'app': ('apps_root', 'app', 'published')}):
                check_time = datetime(2026, 10, 25, 10, 1, tzinfo=timezone.utc)
                errors = lambda: evidence_errors(receipt, state, check_time)
                self.assertEqual([], errors())
                tree['tree'].append({'path': 'new-lesson.json', 'type': 'blob', 'sha': 'new-blob'})
                (root/'imports/github-trees/app.json').write_text(json.dumps(tree))
                self.assertTrue(errors())
                tree['tree'].pop()
                (root/'imports/github-trees/app.json').write_text(json.dumps(tree))
                target.write_text('{"id":"stale"}')
                self.assertTrue(errors())
                target.write_bytes(content)
                state['repositories']['app']['truncated'] = True
                self.assertTrue(errors())
                state['repositories']['app']['truncated'] = False
                state['run_id'] = 'old'
                self.assertTrue(errors())
                state['run_id'] = 'new'
                self.assertTrue(evidence_errors(receipt, state, datetime(2026, 10, 26, 10, 1, tzinfo=timezone.utc)))


if __name__ == '__main__':
    unittest.main()
