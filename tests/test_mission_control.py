from __future__ import annotations

import concurrent.futures
import json
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import EvaluationStore, MissionServer, relevant_history
from scripts.build_registry import Builder, ROOT


class RegistryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.builder = Builder()
        cls.registry = cls.builder.build()
        cls.scenarios = {s['scenario_id']:s for s in cls.registry['scenarios']}

    def test_single_identity_across_retained_aliases(self):
        for alias, canonical in self.builder.config['lesson_aliases'].items():
            self.assertNotIn('sb:'+alias, self.scenarios)
            self.assertIn(alias, self.scenarios['sb:'+canonical]['aliases'])
        for s in self.scenarios.values():
            identities = [a['identity'] for a in s['activities']]
            self.assertEqual(len(identities),len(set(identities)),s['scenario_id'])
        aids = [a['id'] for s in self.scenarios.values() for a in s['activities']]
        self.assertEqual(len(aids),len(set(aids)))

    def test_drive_slides_connect_by_exact_id_to_book_sections(self):
        s=self.scenarios['book:abraham-journey']
        a=next(a for a in s['activities'] if a.get('drive_id')=='1obhHzxFimu8ecB2zpNyAu73Ogv7RB3CuJaeOn0yxmcg')
        self.assertEqual(7,a['slide_count'])
        self.assertTrue(a['content_preview'][0]['slide_id'])
        self.assertTrue(any('#section-abraham-journey' in a['url'] for a in s['activities']))
        ids={a.get('drive_id') for s in self.scenarios.values() for a in s['activities']}
        snapshot=json.loads((ROOT/'imports/google-drive.json').read_text())
        self.assertTrue({f['id'] for f in snapshot['files']} <= ids)

    def test_html_embedded_scenarios_are_not_duplicate_container_records(self):
        self.assertFalse(any(s.startswith('html:') for s in self.scenarios))
        expected={'book:lesson-004':'revelation_map','sculpture:spiritual-freedom':'spiritual_healing',
                  'book:lesson-005':'two_ways_of_knowing','sb:20261002_palaia-kai-kaini-diathiki-enotita':'dentro_diathikis',
                  'unity:jerusalem_pentecost_hymn':'jerusalem_pentecost_hymn','unity:byzantium_fall_restoration':'byzantium_fall_restoration',
                  'unity:jerusalem_theotokos_hymn':'jerusalem_theotokos_hymn'}
        for sid,native in expected.items():
            self.assertTrue(any(a.get('app')=='drive-html' and a['native_id']==native for a in self.scenarios[sid]['activities']),sid)

    def test_missing_metadata_stays_unconfirmed(self):
        s=self.scenarios['book:abraham-journey']
        self.assertEqual([],s['grades'])
        self.assertIsNone(s['duration'])
        self.assertIsNone(s['technical_difficulty'])
        s=self.scenarios['sb:eleftheria-kai-dogmatiki-syneidisi']
        self.assertEqual([],s['grades'])  # source explicitly calls its age an assumption
        self.assertEqual('unconfirmed',s['duration_status'])

    def test_actual_master_modules_available_without_copies(self):
        s=self.scenarios['sb:vivlos-dialogos-kai-drasi']
        self.assertEqual(['Α΄ Γυμνασίου'],s['grades'])
        self.assertTrue(any(a.get('source_module')=='investigation' for a in s['activities']))
        self.assertTrue(any(a.get('source_module')=='timeline' for a in s['activities']))
        self.assertEqual(4,s['cognitive_difficulty'])

    def test_rebuild_preserves_scenario_ids_and_reads_only_sources(self):
        again=Builder().build()
        self.assertEqual(set(self.scenarios),{s['scenario_id'] for s in again['scenarios']})
        import hashlib
        for path,digest in self.builder.audit.items():
            self.assertEqual(digest,hashlib.sha256(Path(path).read_bytes()).hexdigest(),path)


class ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        cls.storage=Path(cls.temp.name)/'evaluations'
        cls.start_server()
        cls.registry=cls.server.registry

    @classmethod
    def start_server(cls):
        cls.server=MissionServer(('127.0.0.1',0),storage=cls.storage,refresh=False)
        cls.thread=threading.Thread(target=cls.server.serve_forever,daemon=True)
        cls.thread.start()
        cls.base=f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def stop_server(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    @classmethod
    def tearDownClass(cls):
        cls.stop_server()
        cls.temp.cleanup()

    def request(self,path,body=None,origin=True):
        headers={}
        if body is not None:
            headers={'Content-Type':'application/json','X-Mission-Control':'teacher-action'}
            if origin:
                headers['Origin']=self.base
        req=Request(self.base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers)
        try:
            with urlopen(req,timeout=20) as r:
                data=r.read()
                return r.status,json.loads(data) if r.headers.get_content_type()=='application/json' else data,r.headers
        except HTTPError as r:
            with r:
                return r.code,json.loads(r.read()),r.headers

    def payload(self,sid='book:abraham-journey',**kwargs):
        return {'request_id':str(uuid.uuid4()),'scenario_id':sid,'grade':'Β΄ Λυκείου','section':'Β1',
                'model_id':'guided-exploration','flags':['worked-well','more-time'],'cognitive_difficulty':4,**kwargs}

    def test_three_scenarios_and_history_survive_restart(self):
        ids=['sb:vivlos-dialogos-kai-drasi','book:abraham-journey','unity:byzantium_fall_restoration']
        saved=[]
        for sid,grade in zip(ids,['Α΄ Γυμνασίου','Β΄ Λυκείου','Γ΄ Γυμνασίου']):
            p=self.payload(sid,grade=grade)
            code,data,_=self.request('/api/evaluations',p)
            self.assertEqual(201,code,data)
            saved.append(data['record'])
            code,retry,_=self.request('/api/evaluations',p)
            self.assertEqual(200,code)
            self.assertEqual(data['record'],retry['record'])
        self.stop_server()
        self.start_server()
        _,data,_=self.request('/api/evaluations')
        for row in saved:
            self.assertIn(row,data['records'])
            self.assertIn('date',row)
            self.assertEqual('Europe/Athens',row['timezone'])
        self.assertEqual(len(data['records']),len({r['id'] for r in data['records']}))

    def test_new_evaluation_appends_and_same_section_has_priority(self):
        sid='sb:i-ypothesi-tou-areiou'
        p=self.payload(sid,flags=['more-guidance'])
        _,first,_=self.request('/api/evaluations',p)
        self.request('/api/evaluations',self.payload(sid,section='Β2',flags=['worked-well']))
        self.request('/api/evaluations',self.payload(sid,grade='Γ΄ Λυκείου',section='Γ1',flags=['too-difficult']))
        from urllib.parse import urlencode
        _,history,_=self.request('/api/evaluations?'+urlencode({'scenario_id':sid,'grade':'Β΄ Λυκείου','section':'Β1'}))
        self.assertEqual('section',history['scope'])
        self.assertEqual(first['record'],history['latest'])
        self.assertEqual(3,history['summary']['total'])
        self.assertEqual(1,history['summary']['positive'])
        self.assertEqual(1,history['summary']['increased_difficulty'])
        _,history,_=self.request('/api/evaluations?'+urlencode({'scenario_id':sid,'grade':'Β΄ Λυκείου','section':'Β3'}))
        self.assertEqual('grade',history['scope'])
        self.assertEqual('Β2',history['latest']['section'])

    def test_validation_and_cross_origin_write_rejection(self):
        code,_,_=self.request('/api/evaluations',self.payload(),origin=False)
        self.assertEqual(403,code)
        for changed in [{'scenario_id':'missing'},{'flags':['made-up']},{'flags':[]},{'cognitive_difficulty':6},{'cognitive_difficulty':True},{'grade':'invented'},{'grade':'','section':'Β1'}]:
            code,_,_=self.request('/api/evaluations',self.payload(**changed))
            self.assertEqual(400,code,changed)

    def test_concurrent_saves_do_not_lose_records(self):
        rows=[self.payload('book:david-journey') for _ in range(12)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            codes=list(pool.map(lambda p:self.request('/api/evaluations',p)[0],rows))
        self.assertEqual([201]*12,codes)
        records=EvaluationStore(self.storage).read()
        self.assertTrue({p['request_id'] for p in rows}<={r['id'] for r in records})

    def test_private_storage_is_not_static_and_has_no_cors(self):
        for path in ['/storage/evaluations','/config.json','/../server.py','/sources/unknown']:
            self.assertEqual(404,self.request(path)[0],path)
        _,_,headers=self.request('/api/evaluations')
        self.assertIsNone(headers.get('Access-Control-Allow-Origin'))
        _,export,_=self.request('/api/export')
        self.assertIsInstance(export['evaluations'],list)

    def test_existing_apps_open_the_selected_data(self):
        pairs=[('sb:vivlos-dialogos-kai-drasi','idea-weaver-board'),
               ('sb:20261002_palaia-kai-kaini-diathiki-enotita','mind-palace-cases'),
               ('sb:to-schedio-tis-theias-oikonomias','Map-Timeline')]
        for sid,app in pairs:
            s=next(s for s in self.registry['scenarios'] if s['scenario_id']==sid)
            a=next(a for a in s['activities'] if a.get('app')==app)
            with urlopen(self.base+a['local_url'],timeout=20) as r:
                html=r.read().decode()
                self.assertIn('<html',html.lower())
                import re
                script=re.search(r'<script[^>]+src="([^"]+)"',html)
                if script:
                    from urllib.parse import urljoin
                    with urlopen(urljoin(r.url,script.group(1)),timeout=20) as asset:
                        self.assertEqual(200,asset.status)
                        self.assertNotEqual('text/html',asset.headers.get_content_type())
                        asset.read()
                data_url=parse_qs(urlsplit(r.url).query)['dataUrl'][0]
            with urlopen(data_url,timeout=20) as r:
                data=json.load(r)
                self.assertEqual('*',r.headers.get('Access-Control-Allow-Origin'))
            if app=='idea-weaver-board':
                self.assertIn('βιβλικ',data['topic'].lower())
                self.assertTrue(data['clues'])
            elif app=='mind-palace-cases':
                self.assertEqual('palaia-kai-kaini-diathiki-enotita',data['case_id'])
            else:
                self.assertIsInstance(data,list)
                self.assertTrue(data)


if __name__=='__main__':
    unittest.main(verbosity=2)
