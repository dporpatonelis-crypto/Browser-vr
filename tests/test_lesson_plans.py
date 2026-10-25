import copy
import json
import tempfile
import unittest
import uuid
from pathlib import Path

from lesson_records import PlanStore
from server import EvaluationStore

ROOT = Path(__file__).resolve().parents[1]


class PlanTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = EvaluationStore(self.temp.name)
        self.plans = PlanStore(self.store)
        self.registry = json.loads((ROOT/'site/data/scenario-registry.json').read_text())
        self.models = json.loads((ROOT/'site/data/pedagogical-models.json').read_text())
        self.scenario = next(s for s in self.registry['scenarios'] if s['scenario_id'] == 'book:lesson-004')
        self.ids = [a['id'] for a in self.scenario['activities']]

    def plan_data(self, **changes):
        return {'request_id':str(uuid.uuid4()), 'scenario_id':self.scenario['scenario_id'], 'grade':'Β΄ Λυκείου', 'section':'Β2',
                'model_id':'guided-exploration', 'class_profile':'Χρειάζεται χρόνο για συζήτηση', 'time_slot':'midday',
                'lesson_date':'2026-10-25', 'notes':'Ερώτημα → VR → συζήτηση', 'planned_material_ids':self.ids[:2], **changes}

    def test_revisions_retry_restart_and_optimistic_concurrency(self):
        data = self.plan_data()
        first, created = self.plans.append(data,self.registry,self.models)
        self.assertTrue(created)
        self.assertFalse(self.plans.append(data,self.registry,self.models)[1])
        edit = self.plan_data(plan_id=first['plan_id'],previous_version_id=first['id'],notes='Νέα πορεία')
        second,_ = self.plans.append(edit,self.registry,self.models)
        self.assertFalse(self.plans.append(edit,self.registry,self.models)[1])
        with self.assertRaisesRegex(ValueError,'άλλη συσκευή'):
            self.plans.append({**edit,'request_id':str(uuid.uuid4())},self.registry,self.models)
        restored = PlanStore(EvaluationStore(self.temp.name))
        self.assertEqual(2,len(restored.read()))
        self.assertEqual(data['notes'],restored.version(first['id'])['notes'])
        self.assertEqual(first['id'],second['previous_version_id'])
        self.assertEqual([],self.store.read())

    def test_saved_plan_and_actual_usage_survive_catalogue_removal(self):
        plan,_ = self.plans.append(self.plan_data(),self.registry,self.models)
        original = copy.deepcopy(plan)
        self.scenario['activities'] = [a for a in self.scenario['activities'] if a['id'] != self.ids[0]]
        data = {'request_id':str(uuid.uuid4()),'scenario_id':self.scenario['scenario_id'],'model_id':'guided-exploration',
                'flags':['worked-well'],'plan_version_id':plan['id'],'media_usage_recorded':True,
                'used_material_ids':[self.ids[0],self.ids[2]],'class_profile':'Συμμετοχικό','time_slot':'morning','lesson_date':'2026-10-25'}
        row,_ = self.store.append(data,self.registry,self.models,self.plans)
        self.assertEqual(original,row['lesson_plan'])
        self.assertEqual([self.ids[0],self.ids[2]],[a['id'] for a in row['used_materials']])
        self.assertEqual('morning',row['time_slot'])
        self.assertEqual('midday',row['lesson_plan']['time_slot'])
        self.assertFalse(self.store.append(data,self.registry,self.models,self.plans)[1])
        with self.assertRaises(ValueError):
            self.store.append({**data,'used_material_ids':[self.ids[1]]},self.registry,self.models,self.plans)

    def test_invalid_materials_context_and_dates_are_rejected(self):
        for change in [{'planned_material_ids':['unknown']},{'time_slot':'night'},{'lesson_date':'2026-02-30'},{'class_profile':'x'*241},{'notes':'x'*2001}]:
            with self.subTest(change=change),self.assertRaises(ValueError):
                self.plans.append(self.plan_data(**change),self.registry,self.models)
        self.assertEqual([],self.plans.read())

    def test_legacy_record_distinguishes_unknown_usage_from_explicit_empty(self):
        data={'request_id':str(uuid.uuid4()),'scenario_id':self.scenario['scenario_id'],'model_id':'guided-exploration','flags':['worked-well']}
        old,_ = self.store.append(data,self.registry,self.models)
        legacy={k:v for k,v in old.items() if k not in ['class_profile','time_slot','lesson_date','used_materials','media_usage_recorded','lesson_plan']}
        legacy['schema_version']=1
        (Path(self.temp.name)/f"{old['id']}.json").write_text(json.dumps(legacy))
        self.assertEqual(legacy,self.store.append(data,self.registry,self.models)[0])
        new,_ = self.store.append({**data,'request_id':str(uuid.uuid4()),'media_usage_recorded':True,'used_material_ids':[]},self.registry,self.models)
        self.assertTrue(new['media_usage_recorded'])
        self.assertEqual([],new['used_materials'])
