import copy
import json
import shutil
import subprocess
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from lesson_canvas import CanvasStore, CanvasConflict, validate_document
from lesson_records import PlanStore
from server import EvaluationStore, MissionServer
from scripts.export_site import portable_registry, copy_public_ui
from scripts.export_lesson_map_transfer import export_transfer

ROOT=Path(__file__).resolve().parents[1]


class MapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.registry=json.loads((ROOT/'site/data/scenario-registry.json').read_text())
        cls.models=json.loads((ROOT/'site/data/pedagogical-models.json').read_text())
        code="const m=await import(process.argv[1]);console.log(JSON.stringify(m.lmNewCanvas('Δοκιμή','book:lesson-004')));"
        cls.canvas=json.loads(subprocess.check_output(['node','--input-type=module','-e',code,(ROOT/'public/lesson-map-domain.mjs').as_uri()],text=True))

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.evaluations=EvaluationStore(Path(self.temp.name)/'evaluations')
        self.maps=CanvasStore(self.evaluations)

    def payload(self,**changes):
        return {'request_id':str(uuid.uuid4()),'document_id':str(uuid.uuid4()),'kind':'canvas','document':copy.deepcopy(self.canvas),**changes}

    def test_versions_retries_restart_and_conflict_preserve_both_edits(self):
        data=self.payload();first,created=self.maps.save(data,self.registry)
        self.assertTrue(created);self.assertFalse(self.maps.save(data,self.registry)[1])
        edit=self.payload(document_id=first['document_id'],previous_version_id=first['id'])
        edit['document']['title']='Αναθεώρηση'
        second,_=self.maps.save(edit,self.registry)
        with self.assertRaises(CanvasConflict):self.maps.save({**edit,'request_id':str(uuid.uuid4())},self.registry)
        with self.assertRaises(CanvasConflict):self.maps.save({**data,'document':edit['document']},self.registry)
        restored=CanvasStore(EvaluationStore(self.evaluations.directory))
        self.assertEqual(2,len(restored.read()))
        self.assertEqual('Αναθεώρηση',list(restored.latest())[0]['document']['title'])
        self.assertEqual('Δοκιμή',restored.read()[0]['document']['title'])
        self.assertEqual(first['id'],second['previous_version_id'])
        self.assertEqual([],self.evaluations.read())

    def test_version_chain_wins_when_timestamps_equal(self):
        data=self.payload(request_id='ffffffff-ffff-4fff-8fff-ffffffffffff');first,_=self.maps.save(data,self.registry)
        update=self.payload(request_id='00000000-0000-4000-8000-000000000001',document_id=first['document_id'],previous_version_id=first['id']);second,_=self.maps.save(update,self.registry)
        second['created_at']=first['created_at'];self.evaluations.write_atomic(self.maps.directory/f"{second['id']}.json",second)
        self.assertEqual(second['id'],list(self.maps.latest())[0]['id'])
        self.maps.save(self.payload(document_id=first['document_id'],previous_version_id=second['id']),self.registry)

    def test_bad_coordinates_pages_urls_and_missing_nodes_rejected(self):
        cases=[]
        for field,value in [('x',float('nan')),('w',0),('y',9)]:
            d=copy.deepcopy(self.canvas);d['buildings'][0]['box'][field]=value;cases.append(d)
        d=copy.deepcopy(self.canvas);d['buildings'].pop();cases.append(d)
        d=copy.deepcopy(self.canvas);d['schema_version']=2;cases.append(d)
        d=copy.deepcopy(self.canvas);d['connections']=[{'id':str(uuid.uuid4()),'from':'missing','to':'text'}];cases.append(d)
        base={'id':str(uuid.uuid4()),'type':'pdf','label':'PDF','page_start':3,'page_end':1}
        for change in [{},{'page_end':3,'url':'javascript:alert(1)'},{'page_end':3,'url':'https://user:pass@example.com/a'}]:
            d=copy.deepcopy(self.canvas);d['buildings'][0]['materials']=[{**base,**change}];cases.append(d)
        for d in cases:
            with self.subTest(d=d),self.assertRaises(ValueError):self.maps.save(self.payload(document=d),self.registry)
        self.assertEqual([],self.maps.read())

    def test_assets_are_separate_immutable_and_keep_original_bytes(self):
        aid=str(uuid.uuid4());html=b'<!doctype html><html><body>private payload</body></html>'
        m=self.maps.upload(aid,'activity.html','text/html',html)
        self.assertEqual(html,self.maps.asset(aid)[1].read_bytes())
        self.assertEqual(m,self.maps.upload(aid,'activity.html','text/html',html))
        with self.assertRaises(CanvasConflict):self.maps.upload(aid,'activity.html','text/html',html+b'x')
        with self.assertRaises(ValueError):self.maps.upload(str(uuid.uuid4()),'image.png','image/png',html)
        with self.assertRaises(ValueError):self.maps.asset('../outside')
        doc=copy.deepcopy(self.canvas);doc['buildings'][3]['materials']=[{'id':str(uuid.uuid4()),'type':'html','label':'Private','asset_id':aid}]
        row,_=self.maps.save(self.payload(document=doc),self.registry)
        self.assertNotIn('private payload',json.dumps(row));self.assertNotIn('base64',json.dumps(row))

    def test_image_annotations_stay_normalized_and_source_stays_unchanged(self):
        aid=str(uuid.uuid4());image=b'\x89PNG\r\n\x1a\noriginal';self.maps.upload(aid,'map.png','image/png',image)
        doc=copy.deepcopy(self.canvas);mid=str(uuid.uuid4());doc['buildings'][2]['materials']=[{'id':mid,'type':'image','label':'Map','asset_id':aid}]
        doc['annotations']=[{'id':str(uuid.uuid4()),'material_id':mid,'kind':'relation','points':[{'x':.12,'y':.2},{'x':.8,'y':.9}],'verb':'ερμηνεύει'}]
        first,_=self.maps.save(self.payload(document=doc),self.registry)
        doc['buildings'][2]['box']['w']=.6
        second,_=self.maps.save(self.payload(document_id=first['document_id'],previous_version_id=first['id'],document=doc),self.registry)
        self.assertEqual(first['document']['annotations'],second['document']['annotations']);self.assertEqual(image,self.maps.asset(aid)[1].read_bytes())
        doc['annotations'][0]['points'][0]['x']=1.1
        with self.assertRaises(ValueError):validate_document('canvas',doc,self.registry)

    def test_drive_and_pdf_provenance_survives_storage_export_and_invalid_sources_fail(self):
        aid=str(uuid.uuid4());self.maps.upload(aid,'worksheet.png','image/png',b'\x89PNG\r\n\x1a\noriginal')
        doc=copy.deepcopy(self.canvas)
        source={'drive_id':'source_id_1234567890','name':'source.pdf','page':39,'variant':'FXX5.png'}
        doc['buildings'][2]['materials']=[{'id':str(uuid.uuid4()),'type':'image','label':'Χάρτης','asset_id':aid,'provenance':source}]
        row,_=self.maps.save(self.payload(document=doc),self.registry)
        self.assertEqual(source,row['document']['buildings'][2]['materials'][0]['provenance'])
        output=Path(self.temp.name)/'private.lessonmap.json';export_transfer(self.evaluations.directory,output)
        transferred=json.loads(output.read_text())['documents'][0][1]['document']
        self.assertEqual(source,transferred['buildings'][2]['materials'][0]['provenance'])
        for bad in [{**source,'page':0},{**source,'drive_id':'../outside'},None]:
            doc['buildings'][2]['materials'][0]['provenance']=bad
            with self.assertRaises(ValueError):validate_document('canvas',doc,self.registry)

    def test_registration_adds_private_activity_and_pins_evaluation_version(self):
        doc=copy.deepcopy(self.canvas);doc['registered']=True
        row,_=self.maps.save(self.payload(document=doc),self.registry)
        registry=self.maps.registry(self.registry);scenario=next(s for s in registry['scenarios'] if s['scenario_id']=='book:lesson-004')
        activity=next(a for a in scenario['activities'] if a['kind']=='canvas')
        self.assertNotIn(activity['id'],json.dumps(self.registry))
        plans=PlanStore(self.evaluations)
        p,_=plans.append({'request_id':str(uuid.uuid4()),'scenario_id':scenario['scenario_id'],'model_id':'guided-exploration','planned_material_ids':[activity['id']]},registry,self.models)
        self.assertEqual(row['id'],p['planned_materials'][0]['canvas_version_id'])
        usage={'confirmed':True,'canvas_id':row['document_id'],'version_id':row['id'],'used_building_ids':['text','images'],'guidance_building_ids':['images'],'note':'More discussion'}
        evaluation={'request_id':str(uuid.uuid4()),'scenario_id':scenario['scenario_id'],'model_id':'guided-exploration','flags':['worked-well'],'plan_version_id':p['id'],'media_usage_recorded':True,'used_material_ids':[activity['id']],'canvas_usage':usage}
        saved,_=self.evaluations.append(evaluation,registry,self.models,plans,self.maps)
        self.assertEqual(row['id'],saved['canvas_usage']['version_id']);self.assertFalse(self.evaluations.append(evaluation,registry,self.models,plans,self.maps)[1])
        with self.assertRaises(ValueError):self.evaluations.append({**evaluation,'canvas_usage':{**usage,'note':'Changed'}},registry,self.models,plans,self.maps)
        with self.assertRaises(ValueError):self.maps.usage({**usage,'confirmed':False},scenario['scenario_id'])
        with self.assertRaises(ValueError):self.maps.usage(usage,'other')
        with self.assertRaises(ValueError):self.maps.usage({**usage,'used_building_ids':['foreign']},scenario['scenario_id'])

    def test_public_export_excludes_registrations_assets_and_private_fields(self):
        doc=copy.deepcopy(self.canvas);doc['registered']=True;doc['class_profile']='NEVER PUBLIC';doc['private_note']='NEVER PUBLIC'
        row,_=self.maps.save(self.payload(document=doc),self.registry)
        self.assertNotIn('class_profile',row['document']);self.assertNotIn('private_note',row['document'])
        public=portable_registry(self.maps.registry(self.registry),Path(self.temp.name)/'public','https://example.com/')
        self.assertFalse(any(a['kind']=='canvas' for s in public['scenarios'] for a in s['activities']))
        out=Path(self.temp.name)/'ui';copy_public_ui(out)
        self.assertFalse((out/'storage').exists());self.assertFalse((out/'imports').exists())
        self.assertTrue((out/'assets/lesson-map/library.webp').exists())
        self.assertNotIn('NEVER PUBLIC',json.dumps(public))

    def test_notes_create_private_scenario_and_keep_exercise_image_and_source_separate(self):
        original=str(uuid.uuid4());crop=str(uuid.uuid4());image=b'\x89PNG\r\n\x1a\nsource';info=self.maps.upload(original,'notes.png','image/png',image)
        self.maps.upload(crop,'exercise.png','image/png',image+b'crop')
        did=str(uuid.uuid4());doc=copy.deepcopy(self.canvas);doc['scenario_id']='notes:'+did;doc['registered']=True
        doc['import_source']={'asset_id':original,'sha256':info['sha256'],'name':'notes.png','type':'image','extraction':'ocr','page_start':1,'page_end':1,'total_pages':1,'focus':'Ερώτημα','keywords':['παρακοή'],'related_scenario_ids':[], 'exercise_regions':[{'asset_id':crop,'page':1,'x':.1,'y':.2,'w':.5,'h':.5}]}
        doc['buildings'][1]['materials']=[{'id':str(uuid.uuid4()),'type':'image','label':'Άσκηση με κενά','asset_id':crop}]
        row,_=self.maps.save(self.payload(document_id=did,document=doc),self.registry)
        private=self.maps.registry(self.registry);scenario=next(s for s in private['scenarios'] if s['scenario_id']=='notes:'+did)
        self.assertTrue(scenario['private']);self.assertEqual('canvas',scenario['activities'][0]['kind']);self.assertEqual('Ερώτημα',scenario['inquiry_question'])
        public=portable_registry(private,Path(self.temp.name)/'public','https://example.com/')
        self.assertNotIn('notes:'+did,json.dumps(public));self.assertNotIn(info['sha256'],json.dumps(public))
        restarted=CanvasStore(EvaluationStore(self.evaluations.directory));self.assertEqual(row['document']['import_source'],list(restarted.latest())[0]['document']['import_source'])
        transfer=Path(self.temp.name)/'notes-transfer.json';export_transfer(self.evaluations.directory,transfer)
        self.assertEqual({original,crop},{a['id'] for a in json.loads(transfer.read_text())['assets']})
        invalid=copy.deepcopy(doc);invalid['import_source']['sha256']='0'*64
        with self.assertRaises(ValueError):self.maps.save(self.payload(document_id=did,previous_version_id=row['id'],document=invalid),self.registry)
        self.assertEqual(1,len(self.maps.read()))

    def test_workspace_must_reference_saved_canvas_and_keeps_detached_maps(self):
        theme=str(uuid.uuid4());cid=str(uuid.uuid4())
        doc={'schema_version':1,'title':'A','grade':'Α΄ Γυμνασίου','verbs':[],'themes':[{'id':theme,'title':'Πρώτο','icon':'📖','box':{'x':0,'y':0,'w':.3,'h':.4}}],
             'lessons':[{'id':str(uuid.uuid4()),'theme_id':theme,'title':'Sample','scenario_id':None,'canvas_id':cid}],'connections':[]}
        data=self.payload(kind='workspace',document=doc)
        with self.assertRaises(ValueError):self.maps.save(data,self.registry)
        self.maps.save(self.payload(document_id=cid),self.registry)
        row,_=self.maps.save(data,self.registry)
        doc['themes']=[];doc['lessons']=[]
        self.maps.save(self.payload(kind='workspace',document_id=row['document_id'],previous_version_id=row['id'],document=doc),self.registry)
        self.assertTrue(any(r['document_id']==cid for r in self.maps.latest()))


    def test_transfer_contains_latest_maps_and_only_their_private_assets(self):
        aid=str(uuid.uuid4());payload=b'<!doctype html><html><body>PRIVATE</body></html>'
        self.maps.upload(aid,'activity.html','text/html',payload)
        self.maps.upload(str(uuid.uuid4()),'unused.html','text/html',payload+b'unused')
        doc=copy.deepcopy(self.canvas);doc['buildings'][3]['materials']=[{'id':str(uuid.uuid4()),'type':'html','label':'Original','asset_id':aid}]
        first,_=self.maps.save(self.payload(document=doc),self.registry)
        doc['title']='Latest';self.maps.save(self.payload(document_id=first['document_id'],previous_version_id=first['id'],document=doc),self.registry)
        target=Path(self.temp.name)/'transfer.json'
        result=export_transfer(self.evaluations.directory,target)
        transfer=json.loads(target.read_text())
        self.assertEqual(1,result['documents']);self.assertEqual(1,result['assets'])
        self.assertEqual('Latest',transfer['documents'][0][1]['document']['title'])
        self.assertEqual(aid,transfer['assets'][0]['id'])
        self.assertNotIn('evaluations',transfer);self.assertNotIn('plans',transfer)
        with self.assertRaises(ValueError):export_transfer(self.evaluations.directory,ROOT/'site/private.json')


class MapHTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);root=Path(self.temp.name)
        (root/'public/data').mkdir(parents=True);(root/'config.json').write_text('{}')
        for name in ['scenario-registry.json','pedagogical-models.json']:shutil.copyfile(ROOT/'site/data'/name,root/'public/data'/name)
        self.server=MissionServer(('127.0.0.1',0),directory=root,refresh=False)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)
        self.base=f'http://127.0.0.1:{self.server.server_port}'

    def test_asset_upload_exceeds_old_metadata_limit_and_is_not_publicly_served(self):
        aid=str(uuid.uuid4());payload=b'<!doctype html><html><body>'+b'x'*70000+b'</body></html>'
        request=Request(self.base+'/api/canvas-assets',payload,headers={'Origin':self.base,'Content-Type':'text/html','X-Mission-Control':'teacher-action','X-Asset-ID':aid,'X-Asset-Name':'test.html'})
        with urlopen(request) as response:self.assertEqual(201,response.status)
        with urlopen(self.base+'/api/canvas-assets/'+aid) as response:
            self.assertEqual(payload,response.read());self.assertIn('sandbox',response.headers['Content-Security-Policy'])
        with self.assertRaises(HTTPError) as denied:urlopen(self.base+'/storage/evaluations/lesson-maps/assets/'+aid+'.bin')
        self.assertEqual(404,denied.exception.code)
        denied.exception.close()
        request=Request(self.base+'/api/canvas-assets',payload,headers={'Origin':'https://unrelated.example','Content-Type':'text/html','X-Mission-Control':'teacher-action','X-Asset-ID':str(uuid.uuid4()),'X-Asset-Name':'test.html'})
        with self.assertRaises(HTTPError) as denied:urlopen(request)
        self.assertEqual(403,denied.exception.code)
        denied.exception.close()


if __name__=='__main__':unittest.main()
