import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from scripts.build_registry import Builder
from scripts.refresh_sources import blob_sha, evidence_errors
from scripts.unity_inventory import UnityInventory
from scripts.lesson_html_inventory import declared_literal, extract_lessons
from scripts.export_site import portable_registry
from server import MissionServer


class RefreshRegressionTests(unittest.TestCase):
    def test_literal_lesson_reader_accepts_authored_data_and_rejects_code(self):
        script="const LESSON = [{id:'pain', word:'Πόνος', at:[31,46], enabled:true, note:null,},];"
        self.assertEqual('Πόνος',declared_literal(script,'LESSON')[0]['word'])
        for source in ["const LESSON = fetch('https://example.org');", "const LESSON = [{id:window.secret}];", "const LESSON = [] + dangerous();"]:
            with self.subTest(source=source),self.assertRaises(ValueError):declared_literal(source,'LESSON')

    def test_new_html_families_exclude_templates_and_keep_every_container_lesson(self):
        source='<script id="default-scenario" type="application/json">'+json.dumps({'scenarioId':'rings','title':'Rings','rounds':[{},{}]})+'</script>'
        source+='<script id="scenario-template" type="application/json">'+json.dumps({'scenarioId':'new_lesson','title':'Template','rounds':[{}]})+'</script>'
        source+='<script id="lesson-data" type="application/json">'+json.dumps({'scenarios':[{'lesson_id':'one','title':'One','items':[{}]},{'lesson_id':'two','title':'Two','items':[{},{}]}]})+'</script>'
        source+="<script>const STORAGE_KEY='map.v1'; const LESSON=[{id:'a',word:'A'},{id:'b',word:'B'}]; throw new Error('must not execute');</script>"
        units=extract_lessons(source)
        self.assertEqual(['rings','one','two','map'],[u['id'] for u in units])
        self.assertEqual([2,1,2,2],[u['activity_count'] for u in units])
        self.assertEqual('concentric-rings',units[0]['mechanism'])

    def test_single_lesson_data_object_is_not_lost(self):
        source='<script type="application/json" id="lesson-data">'+json.dumps({'lesson_id':'care','title':'Care','items':[{},{}]})+'</script>'
        self.assertEqual(['care'],[u['id'] for u in extract_lessons(source)])

    def test_private_download_does_not_start_a_local_playable_proxy(self):
        activity={'download_only':True,'url':'https://drive.google.com/file/d/private-id/view','download_url':'https://drive.google.com/uc?export=download&id=private-id'}
        self.assertEqual(activity['download_url'],MissionServer.launch_url(None,activity,'http://127.0.0.1:9999'))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);private=root/'source.html';private.write_text('PRIVATE_LESSON_SENTINEL')
            registry={'schema_version':1,'generated_at':'today','grades':[],
                      'integrations':{'digital_book':{},'google_drive':{}},
                      'source_files':[{'key':'private','path':str(private)}],
                      'scenarios':[{'scenario_id':'lesson','title':'Lesson','sources':[],
                                    'activities':[{'id':'download','kind':'html','app':'drive-html','source_key':'private',
                                                   'private_payload':'PRIVATE_LESSON_SENTINEL','local_url':'/launch/private',**activity}]}]}
            public=portable_registry(registry,root/'out','https://example.org/')
            self.assertTrue(public['scenarios'][0]['activities'][0]['download_only'])
            self.assertNotIn('PRIVATE_LESSON_SENTINEL',json.dumps(public))
            self.assertNotIn('local_url',json.dumps(public))
            self.assertFalse((root/'out/source.html').exists())

    def test_progression_requires_an_existing_target_and_matching_content(self):
        with tempfile.TemporaryDirectory() as folder:
            config={key:folder for key in ('sacred_blueprint_root','apps_root','book_root','unity_root')}
            b=Builder(config);s=b.scenario('one','One')
            html=b.activity(s,'html','Classroom','https://drive.google.com/file/d/private/view',native_id='rings')
            target=b.activity(s,'vr','Unity rings',app='Unity VR',native_id='rings-vr',reveal_mode='concentric-rings')
            rule={'target_native_id':'rings-vr','mechanism':'concentric-rings','relationship':'Same activity','note':'Continue in VR','equivalence':'concentric-content'}
            b.rules={'lesson_progressions':{'rings':[rule]}}
            b.html_units[html['id']]={'rounds':[{'id':'a'}],'referenceSections':[{'id':'source'}]}
            b.unity_scan=SimpleNamespace(records=[{'native_id':'rings-vr','mechanism':'concentric-rings','data':dict(b.html_units[html['id']])}])
            b.link_unity_progressions()
            self.assertEqual(target['id'],html['unity_counterparts'][0]['activity_id'])
            self.assertIn('?material='+target['id'],html['unity_counterparts'][0]['url'])
            html.pop('unity_counterparts');b.unity_scan.records[0]['data']['rounds']=[{'id':'changed'}]
            b.link_unity_progressions()
            self.assertNotIn('unity_counterparts',html)
            self.assertTrue(b.warnings)

    def test_prefab_data_and_disabled_overrides_follow_the_saved_scene(self):
        with tempfile.TemporaryDirectory() as folder:
            assets=Path(folder);(assets/'Scenes').mkdir()
            original=assets/'one.json';alternative=assets/'two.json';prefab=assets/'Mechanism.prefab'
            for path,guid in [(original,'a'*32),(alternative,'b'*32),(prefab,'c'*32)]:Path(str(path)+'.meta').write_text('guid: '+guid)
            original.write_text('{"scenarioId":"one","rounds":[{}]}');alternative.write_text('{"scenarioId":"two","rounds":[{}]}')
            prefab.write_text('--- !u!1 &1\nGameObject:\n  m_IsActive: 1\n--- !u!114 &2\nMonoBehaviour:\n  m_GameObject: {fileID: 1}\n  m_Enabled: 1\n  m_EditorClassIdentifier: Test.ConcentricPuzzleController\n  initialLesson: {fileID: 1, guid: '+('a'*32)+', type: 3}\n')
            scene=assets/'Scenes/Room_world_religions.unity'
            instance='--- !u!1001 &99\nPrefabInstance:\n  m_Modification:\n    m_Modifications:\n    - target: {fileID: 2, guid: '+('c'*32)+', type: 3}\n      propertyPath: initialLesson\n      value: \n      objectReference: {fileID: 1, guid: '+('b'*32)+', type: 3}\n  m_SourcePrefab: {fileID: 100100000, guid: '+('c'*32)+', type: 3}\n'
            scene.write_text(instance)
            scan=UnityInventory(assets).scan()
            self.assertEqual(['two'],[r['native_id'] for r in scan.records])
            self.assertIn(prefab,scan.records[0]['evidence'])
            scene.write_text(instance.replace('propertyPath: initialLesson\n      value: ', 'propertyPath: m_Enabled\n      value: 0'))
            self.assertEqual([],UnityInventory(assets).scan().records)

    def test_concept_board_follows_its_actual_catalog_and_activity_bindings(self):
        with tempfile.TemporaryDirectory() as folder:
            assets=Path(folder);(assets/'Scenes').mkdir()
            scenario=assets/'Lesson.asset';definition=assets/'Definition.asset';catalog=assets/'catalog.json'
            for path,guid in [(scenario,'a'*32),(definition,'b'*32),(catalog,'c'*32)]:
                Path(str(path)+'.meta').write_text('guid: '+guid)
            scenario.write_text('  scenarioId: creation\n  displayTitle: Creation\n  topics:\n  - stationId: first\n    activityId: puzzle-a\n  conceptLesson: {fileID: 1, guid: '+('b'*32)+', type: 2}\n')
            definition.write_text('  catalog: {fileID: 1, guid: '+('c'*32)+', type: 3}\n')
            catalog.write_text(json.dumps({'activities':[{'id':'puzzle-a','title':'One puzzle'}]}))
            (assets/'Scenes/Room_christianity.unity').write_text('--- !u!114 &1\nMonoBehaviour:\n  m_EditorClassIdentifier: Test.CircularManuscriptController\n  initialScenario: {fileID: 1, guid: '+('a'*32)+', type: 2}\n')
            scan=UnityInventory(assets).scan()
            self.assertEqual([],scan.warnings)
            self.assertEqual('concept-canvas',scan.records[0]['mechanism'])
            self.assertEqual(1,scan.records[0]['data']['activity_count'])
            self.assertIn(catalog,scan.records[0]['evidence'])
            catalog.write_text('{"activities":[{"id":"other-puzzle"}]}')
            self.assertTrue(UnityInventory(assets).scan().warnings)

    def test_cosmology_is_indexed_only_from_an_enabled_scene_controller(self):
        with tempfile.TemporaryDirectory() as folder:
            assets=Path(folder);(assets/'Scenes').mkdir();scenario=assets/'World.asset'
            Path(str(scenario)+'.meta').write_text('guid: '+('a'*32))
            scenario.write_text('  scenarioId: world\n  title: World narratives\n  traditions:\n  - cardId: card-a\n    stationId: station-a\n    displayName: Tradition A\n    statement: A source statement\n    sourceLabel: Source A\n    sourceUrl: https://example.org/a\n')
            scene=assets/'Scenes/Room_world_religions.unity'
            scene.write_text('--- !u!114 &1\nMonoBehaviour:\n  m_Enabled: 1\n  m_EditorClassIdentifier: Test.CosmologyController\n  scenario: {fileID: 1, guid: '+('a'*32)+', type: 2}\n')
            scan=UnityInventory(assets).scan()
            self.assertEqual([],scan.warnings)
            self.assertEqual('cosmology-comparison',scan.records[0]['mechanism'])
            self.assertEqual('Tradition A',scan.records[0]['data']['traditions'][0]['displayName'])
            scene.write_text(scene.read_text().replace('m_Enabled: 1','m_Enabled: 0'))
            self.assertEqual([],UnityInventory(assets).scan().records)

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
