import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from scripts.build_registry import Builder
from scripts.lesson_html_inventory import extract_lessons
from scripts.unity_inventory import UnityInventory


class CatalogueAdditionTests(unittest.TestCase):
    def test_window_data_keeps_both_reading_modes_without_executing_runtime_aliases(self):
        data = {'id': 'letter-hymn', 'title': 'Letter and hymn', 'levels': {
            'letter': {'scenes': [{'id': 'one'}, {'id': 'two'}]},
            'hymn': {'scenes': [{'id': 'three'}]}}}
        source = '<script>window.LESSON_CONTENT='+json.dumps(data)+'; const LESSON=CONTENT.stations; throw Error("never execute");</script>'
        units = extract_lessons(source)
        self.assertEqual(['letter-hymn'], [u['id'] for u in units])
        self.assertEqual(3, units[0]['activity_count'])
        self.assertFalse(units[0]['audio_available'])
        self.assertEqual({'letter', 'hymn'}, set(units[0]['levels']))

    def test_resource_bundle_extracts_the_lesson_and_confirms_audio_separately(self):
        source = '<script id="resource-data" type="application/json">'+json.dumps({
            'lesson': {'lesson_id': 'nativity', 'title': 'Nativity', 'phrases': [{'id': 'a'}, {'id': 'b'}, {'id': 'c'}]},
            'audioCurrent': 'data:audio/mp3;base64,AA=='})+'</script>'
        unit, = extract_lessons(source)
        self.assertEqual('meaning-melody', unit['mechanism'])
        self.assertEqual(3, unit['activity_count'])
        self.assertTrue(unit['audio_available'])

    def test_assigned_data_rejects_calls_instead_of_evaluating_them(self):
        for source in ['window.LESSON_CONTENT=fetch("secret");',
                       'window.LESSON_CONTENT={id:"x",scenes:dangerous()};']:
            with self.subTest(source=source), self.assertRaises(ValueError):
                extract_lessons('<script>'+source+'</script>')

    def test_mode_selector_indexes_its_hidden_journey_but_not_an_unassigned_one(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/'Scenes').mkdir()
            definition = root/'Journey.asset'
            definition.write_text('  scenarioId: assigned\n  title: Assigned journey\n  stations:\n  - id: one\n    title: First station\n')
            Path(str(definition)+'.meta').write_text('guid: '+('a'*32))
            scene = root/'Scenes/Room_chronology.unity'
            document = ('--- !u!1 &1\nGameObject:\n  m_IsActive: 0\n'
                        '--- !u!114 &2\nMonoBehaviour:\n  m_GameObject: {fileID: 1}\n  m_EditorClassIdentifier: Test.ChronologyJourneyController\n'
                        '  definition: {fileID: 1, guid: '+('a'*32)+', type: 2}\n'
                        '--- !u!114 &3\nMonoBehaviour:\n  m_EditorClassIdentifier: Test.ChronologyExperienceController\n  journey: {fileID: 2}\n')
            scene.write_text(document)
            records = UnityInventory(root).scan().records
            self.assertEqual(['assigned'], [r['native_id'] for r in records])
            self.assertEqual(1, records[0]['data']['topic_count'])
            scene.write_text(document.replace('  journey: {fileID: 2}', '  journey: {fileID: 0}'))
            self.assertEqual([], UnityInventory(root).scan().records)

    def test_book_download_and_current_drive_unit_share_one_canonical_card(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); book = root/'book/Digital_Lessons'; book.mkdir(parents=True)
            imports = root/'imports'; (imports/'html').mkdir(parents=True)
            (book/'book.json').write_text(json.dumps({'publishing': {'public_url': 'https://example.org/book/'}, 'lessons': [
                {'id': 'lesson-foundations', 'title': 'Foundations', 'sections': [
                    {'id': 'rings-overview', 'title': 'Rings', 'media': [
                        {'type': 'drive', 'download_only': True, 'drive_id': 'drive-one', 'native_id': 'rings',
                         'title': 'Download rings', 'url': 'https://drive.google.com/file/d/drive-one/view'}]}]}]}))
            (imports/'html/drive-one.html').write_text('<script id="lesson-data" type="application/json">'+json.dumps({'id': 'rings', 'title': 'Rings', 'rounds': [{}]})+'</script>')
            (imports/'google-drive.json').write_text(json.dumps({'html_files': [
                {'id': 'drive-one', 'title': 'rings.html', 'url': 'https://drive.google.com/file/d/drive-one/view', 'teacher_download_only': True}]}))
            config = {key: str(root) for key in ('sacred_blueprint_root', 'apps_root', 'book_root', 'unity_root')}
            config.update(book_root=str(root/'book'), book_section_links={})
            with patch('scripts.build_registry.ROOT', root), patch('scripts.build_registry.mirror_root', lambda name: root/'empty'/name):
                builder = Builder(config); builder.rules = {'html_lesson_links': {'rings': 'unity:world'}}
                builder.books(); builder.drive()
            cards = [a for s in builder.scenarios.values() for a in s['activities'] if a.get('native_id') == 'rings']
            self.assertEqual(1, len(cards))
            self.assertEqual(cards[0], next(a for a in builder.scenarios['unity:world']['activities'] if a.get('native_id') == 'rings'))
            self.assertTrue(cards[0]['download_only'])

    def test_reference_section_does_not_replace_the_canonical_lesson_title(self):
        with tempfile.TemporaryDirectory() as folder:
            config = {key: folder for key in ('sacred_blueprint_root', 'apps_root', 'book_root', 'unity_root')}
            builder = Builder(config)
            target = builder.scenario('book:creation', 'HTML activities overview')
            target['title_pending'] = True
            canonical = builder.scenario('book:creation', 'Creation of the world')
            self.assertEqual('Creation of the world', canonical['title'])


if __name__ == '__main__':
    unittest.main()
