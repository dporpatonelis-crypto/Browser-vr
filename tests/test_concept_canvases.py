import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from scripts.build_registry import Builder
from scripts.concept_canvas_inventory import inspect_concept_canvases, extract_embedded_canvases, catalog_digest
from scripts.refresh_sources import tree_files

class ConceptCanvasInventoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.book=Path(self.tmp.name);self.root=self.book/'apps/animated-concept-canvas';self.root.mkdir(parents=True)
        self.url='https://example.org/books/Digital_Lessons/'
        def pack(id):
            return {'schemaVersion':1,'id':id,'title':id,'activities':[{'id':'puzzle-a','title':'A puzzle','slots':[{'id':'a'}],'revealLayers':[{'slotId':'a'}],'art':{'image':'data:image/webp;base64,YQ=='}}]}
        self.primary=pack('advanced');self.basic=pack('basic')
        options={'units':{'basics':'embedded:basics','advanced':'embedded'},'catalogs':[{'key':'embedded:basics','catalog':self.basic}]}
        html='<script type="application/json" id="embedded-catalog">'+json.dumps(self.primary)+'</script><script type="application/json" id="builtin-options">'+json.dumps(options)+'</script>'
        (self.root/'index.html').write_text(html)
        data=(self.root/'index.html').read_bytes()
        self.manifest={'schema_version':1,'app_id':'animated-concept-canvas','files':{'index.html':{'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}},'entries':[]}
        for id,fragment,script,key,catalog in [('basic','unit=basics','builtin-options','embedded:basics','basic'),('advanced','unit=advanced','embedded-catalog',None,'advanced')]:
            item={'id':id,'file':'index.html','fragment':fragment,'script_id':script,'catalog_id':catalog,'activity_ids':['puzzle-a'],'url':self.url+'apps/animated-concept-canvas/index.html#'+fragment}
            if key:item['catalog_key']=key
            self.manifest['entries'].append(item)
        self.save()
    def save(self):
        (self.root/'catalog.json').write_text(json.dumps(self.manifest))
    def test_two_units_in_one_html_have_distinct_launches_and_verified_content(self):
        entries=inspect_concept_canvases(self.book,self.url)
        self.assertEqual(['basic','advanced'],[e['catalog_id'] for e in entries])
        self.assertEqual(2,len({e['url'] for e in entries}))
        self.assertTrue(all(e['exercise_count']==1 and e['activity_titles']==['A puzzle'] for e in entries))
    def test_changed_html_fails_instead_of_reusing_old_metadata(self):
        with (self.root/'index.html').open('a') as f:f.write('changed')
        with self.assertRaisesRegex(ValueError,'διαφέρει'):inspect_concept_canvases(self.book,self.url)
    def test_wrong_unit_hash_is_not_accepted_as_a_valid_launch(self):
        self.manifest['entries'][0]['fragment']='unit=advanced';self.save()
        with self.assertRaisesRegex(ValueError,'σύνδεσμος'):inspect_concept_canvases(self.book,self.url)
    def test_mismatched_embedded_catalog_is_rejected(self):
        self.manifest['entries'][0]['catalog_id']='different';self.save()
        with self.assertRaisesRegex(ValueError,'ενσωματωμένο'):inspect_concept_canvases(self.book,self.url)
    def test_missing_puzzle_is_not_silently_indexed(self):
        self.manifest['entries'][0]['activity_ids']=[];self.save()
        with self.assertRaisesRegex(ValueError,'δραστηριότητες'):inspect_concept_canvases(self.book,self.url)
    def test_refresh_scope_covers_the_manifest_and_both_html_files(self):
        paths=['Digital_Lessons/book.json','Digital_Lessons/data.json','Digital_Lessons/apps/animated-concept-canvas/catalog.json','Digital_Lessons/apps/animated-concept-canvas/index.html','Digital_Lessons/apps/animated-concept-canvas/creation-concepts.html']
        tree={'tree':[{'path':p,'type':'blob','sha':str(i)} for i,p in enumerate(paths)]+[{'path':'Digital_Lessons/assets/movie.mp4','type':'blob','sha':'ignored'}]}
        self.assertEqual(set(paths),set(tree_files('interactive-books',tree)))

    def test_drive_html_extraction_reads_all_units_without_executing_script(self):
        html=(self.root/'index.html').read_text()+'<script>throw new Error("must not execute")</script>'
        units=extract_embedded_canvases(html)
        self.assertEqual(['advanced','basic'],[u['id'] for u in units])
        self.assertEqual(catalog_digest(self.basic),units[1]['catalog_digest'])
        self.assertEqual([],extract_embedded_canvases('<html>No lesson here</html>'))

    def test_drive_mirror_merges_only_when_catalog_content_matches(self):
        imports=self.book/'imports';(imports/'html').mkdir(parents=True)
        (imports/'html/drive-a.html').write_text((self.root/'index.html').read_text())
        (imports/'google-drive.json').write_text(json.dumps({'files':[],'html_files':[{
            'id':'drive-a','title':'Classroom.html','url':'https://drive.google.com/file/d/drive-a/view'}]}))
        config={k:str(self.book) for k in ('sacred_blueprint_root','apps_root','book_root','unity_root')}
        for matches in (True,False):
            with self.subTest(matches=matches),patch('scripts.build_registry.ROOT',self.book):
                builder=Builder(config)
                builder.rules={'concept_canvas_lesson_links':{'basic':'book:trinity','advanced':'book:trinity'}}
                scenario=builder.scenario('book:trinity','Trinity')
                builder.concept_canvas_entries={'basic':{'catalog_id':'basic','catalog_digest':catalog_digest(self.basic) if matches else 'older-content'}}
                activity=builder.activity(scenario,'html','Basic','https://example.org/index.html#unit=basics',app='animated-concept-canvas',native_id='basic')
                builder.drive()
                basics=[a for a in scenario['activities'] if a.get('native_id')=='basic']
                self.assertEqual(1 if matches else 2,len(basics))
                self.assertEqual('drive-a' if matches else None,activity.get('drive_id'))
                self.assertEqual('https://example.org/index.html#unit=basics',activity['url'])

if __name__=='__main__':unittest.main()
