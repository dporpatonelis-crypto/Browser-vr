import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createHash,randomUUID} from 'node:crypto';
import {lmNewCanvas,lmNewWorkspace} from '../public/lesson-map-domain.mjs';

const owner='teacher@example.com';
const catalog=JSON.parse(readFileSync(new URL('../site/data/scenario-registry.json',import.meta.url)));
const models=JSON.parse(readFileSync(new URL('../site/data/pedagogical-models.json',import.meta.url)));
const source=(readFileSync(new URL('../cloud/Code.gs',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../cloud/LessonMaps.gs',import.meta.url),'utf8'))
  .replace('__OWNER_EMAIL__',owner).replace('__CATALOG__',JSON.stringify(catalog))
  .replace('__MODELS__',JSON.stringify(models)).replace('__PRIVATE_PAGE__',JSON.stringify('<html>__MISSION_BOOTSTRAP__</html>'));
function iterator(rows){let i=0;return {hasNext:()=>i<rows.length,next:()=>rows[i++]};}
function environment(storage={files:[],properties:new Map()},active=owner,effective=owner){
  const folder={getId:()=> 'private-folder',getSharingAccess:()=> 'PRIVATE',getEditors:()=>[],getViewers:()=>[],getOwner:()=>({getEmail:()=>owner}),
    getFiles:()=>iterator(storage.files),getFilesByName:name=>iterator(storage.files.filter(f=>f.getName()===name)),
    createFile:blob=>{const f={getName:()=>blob.name,getBlob:()=>blob};storage.files.push(f);return f;}};
  const context=vm.createContext({Session:{getActiveUser:()=>({getEmail:()=>active}),getEffectiveUser:()=>({getEmail:()=>effective})},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>storage.properties.get(k),setProperty:(k,v)=>storage.properties.set(k,v)})},
    LockService:{getScriptLock:()=>({waitLock:()=>{},releaseLock:()=>{}})},DriveApp:{Access:{PRIVATE:'PRIVATE'},createFolder:()=>folder,getFolderById:()=>folder},
    Utilities:{newBlob:(data,type,name)=>({data,type,name,getName:()=>name,getContentType:()=>type,getBytes:()=>[...Buffer.from(Array.isArray(data)?data.map(b=>b&255):data)],getDataAsString:()=>Array.isArray(data)?Buffer.from(data.map(b=>b&255)).toString('utf8'):data}),formatDate:d=>d.toISOString().slice(0,10),DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(algorithm,data)=>[...createHash(algorithm).update(Buffer.from(data.map(b=>b&255))).digest()],base64Encode:data=>Buffer.from(data.map(b=>b&255)).toString('base64')},
    HtmlService:{createHtmlOutput:s=>({setTitle:()=>({addMetaTag:()=>s})})}});
  vm.runInContext(source,context);
  return {context,storage,folder};
}
const payload=(overrides={})=>({request_id:'7ed3a50f-991a-4eb9-964a-f2e5458a5de0',scenario_id:'book:abraham-journey',model_id:'guided-exploration',grade:'Β΄ Λυκείου',section:'Β1',flags:['worked-well'],cognitive_difficulty:3,...overrides});
test('private cloud rejects anonymous, other accounts and mismatched execution identity',()=>{
  for(const [active,effective] of [['',owner],['other@example.com',owner],[owner,'other@example.com']]){
    const {context}=environment(undefined,active,effective);
    for(const name of ['doGet','listEvaluations','saveEvaluation','listPlans','savePlan','exportEvaluations','verifyPrivateStorage','listLessonMaps','saveLessonMap','registerLessonCanvas','uploadCanvasAsset','readCanvasAsset']) assert.throws(()=>context[name](payload()),/ιδιωτικός χώρος/);
  }
});

const scenario=catalog.scenarios.find(s=>s.scenario_id==='book:lesson-004');
const ids=scenario.activities.map(a=>a.id);
const planPayload=(overrides={})=>({request_id:'a1111111-1111-4111-8111-111111111111',scenario_id:scenario.scenario_id,model_id:'guided-exploration',grade:'Β΄ Λυκείου',section:'Β2',class_profile:'Συμμετοχικό, χρειάζεται χρόνο για διάλογο',time_slot:'midday',lesson_date:'2026-10-25',notes:'Ερώτημα → διαφάνειες → VR → συζήτηση',planned_material_ids:ids.slice(0,2),...overrides});
test('private plans persist, revise without overwriting, and protect concurrent edits',()=>{
  const {context,storage}=environment();
  const first=context.savePlan(planPayload()).plan;
  assert.equal(first.planned_materials.length,2);
  assert.equal(context.savePlan(planPayload()).created,false);
  const update=planPayload({request_id:'a2222222-2222-4222-8222-222222222222',plan_id:first.plan_id,previous_version_id:first.id,notes:'Νέα πορεία',planned_material_ids:ids.slice(0,1)});
  const second=context.savePlan(update).plan;
  assert.equal(second.previous_version_id,first.id);
  assert.equal(context.savePlan(update).created,false);
  assert.equal(context.listPlans().plans.length,2);
  assert.equal(context.listEvaluations().records.length,0);
  assert.throws(()=>context.savePlan({...update,request_id:'a3333333-3333-4333-8333-333333333333'}),/άλλη συσκευή/);
  assert.throws(()=>context.savePlan({...update,notes:'Άλλο περιεχόμενο'}),/διαφορετικό σχέδιο/);
  const restored=environment(storage).context;
  assert.equal(restored.listPlans().plans.find(p=>p.id===first.id).notes,first.notes);
  assert.equal(restored.exportEvaluations().plans.length,2);
});
test('older clients changing class or date automatically create independent plans',()=>{
  const {context}=environment();
  const first=context.savePlan(planPayload()).plan;
  const change=planPayload({request_id:'b2222222-2222-4222-8222-222222222222',plan_id:first.plan_id,previous_version_id:first.id,section:'Β3'});
  const second=context.savePlan(change).plan;
  assert.equal(second.plan_id,second.id);
  assert.equal(second.previous_version_id,'');
  assert.equal(second.source_version_id,first.id);
  assert.equal(context.savePlan(change).created,false);
  const third=context.savePlan({...change,request_id:'b3333333-3333-4333-8333-333333333333',plan_id:second.plan_id,previous_version_id:second.id,lesson_date:'2026-10-26'}).plan;
  assert.equal(third.plan_id,third.id);
  assert.equal(context.latestPlanVersions_(context.listPlans().plans).length,3);
  assert.equal(context.listPlans().plans.find(p=>p.id===first.id).section,'Β2');
});
test('legacy cross-class chains can each be edited without hiding the other class',()=>{
  const {context,storage}=environment();
  const first=context.savePlan(planPayload()).plan;
  const legacy={...first,id:'b4444444-4444-4444-8444-444444444444',previous_version_id:first.id,section:'Β3'};
  storage.files.push({getName:()=>`plan-${legacy.id}.json`,getBlob:()=>({getDataAsString:()=>JSON.stringify(legacy)})});
  assert.equal(context.latestPlanVersions_(context.listPlans().plans).length,2);
  const edited=context.savePlan(planPayload({request_id:'b5555555-5555-4555-8555-555555555555',plan_id:first.plan_id,previous_version_id:first.id,notes:'Β2 updated'})).plan;
  assert.equal(edited.plan_id,first.plan_id);
  const latest=context.latestPlanVersions_(context.listPlans().plans);
  assert.deepEqual(Array.from(latest,p=>p.section).sort(),['Β2','Β3']);
});
test('explicit independent copies preserve historical media and retries without duplicates',()=>{
  const {context}=environment();
  const first=context.savePlan(planPayload()).plan;
  vm.runInContext(`CATALOG.scenarios.find(s=>s.scenario_id===${JSON.stringify(scenario.scenario_id)}).activities=[]`,context);
  const data=planPayload({request_id:'b6666666-6666-4666-8666-666666666666',source_version_id:first.id,section:'Β3'});
  const copy=context.savePlan(data).plan;
  assert.equal(copy.plan_id,copy.id);
  assert.equal(copy.planned_materials.length,2);
  assert.equal(context.savePlan(data).created,false);
  assert.throws(()=>context.savePlan({...data,request_id:'b7777777-7777-4777-8777-777777777777',source_version_id:'b8888888-8888-4888-8888-888888888888'}),/αντιγραφή/);
});
test('evaluation captures planned versus actually used media and private classroom context',()=>{
  const {context}=environment();
  const plan=context.savePlan(planPayload()).plan;
  const data=payload({scenario_id:scenario.scenario_id,plan_version_id:plan.id,class_profile:plan.class_profile,time_slot:'morning',lesson_date:'2026-10-25',media_usage_recorded:true,used_material_ids:[ids[1],ids[2]]});
  const saved=context.saveEvaluation(data).record;
  assert.equal(saved.lesson_plan.id,plan.id);
  assert.deepEqual(Array.from(saved.lesson_plan.planned_materials,a=>a.id),ids.slice(0,2));
  assert.deepEqual(Array.from(saved.used_materials,a=>a.id),[ids[1],ids[2]]);
  assert.equal(saved.time_slot,'morning');
  assert.equal(saved.lesson_plan.time_slot,'midday');
  assert.equal(saved.class_profile,plan.class_profile);
  assert.equal(context.saveEvaluation(data).created,false);
  assert.throws(()=>context.saveEvaluation({...data,time_slot:'midday'}),/διαφορετική καταγραφή/);
  const empty=context.saveEvaluation({...data,request_id:'a4444444-4444-4444-8444-444444444444',used_material_ids:[]}).record;
  assert.equal(empty.media_usage_recorded,true);
  assert.equal(empty.used_materials.length,0);
});
test('plans and evaluations reject foreign media, invalid context and cross-lesson plans',()=>{
  const {context,storage}=environment();
  for(const change of [{planned_material_ids:['unknown']},{time_slot:'night'},{class_profile:'x'.repeat(241)},{lesson_date:'2026-02-30'},{notes:'x'.repeat(2001)}]) assert.throws(()=>context.savePlan(planPayload(change)));
  assert.equal(storage.files.length,0);
  const plan=context.savePlan(planPayload()).plan;
  for(const change of [{scenario_id:'book:abraham-journey'},{used_material_ids:['unknown']},{media_usage_recorded:false},{time_slot:'night'}]) assert.throws(()=>context.saveEvaluation(payload({scenario_id:scenario.scenario_id,plan_version_id:plan.id,media_usage_recorded:true,used_material_ids:[ids[0]],...change})));
  assert.equal(context.listEvaluations().records.length,0);
});
test('old evaluations remain readable and do not imply no media were used',()=>{
  const {context,storage}=environment();
  const saved=context.saveEvaluation(payload()).record;
  const legacy={...saved,schema_version:1};
  for(const key of ['lesson_plan','class_profile','time_slot','lesson_date','used_materials','media_usage_recorded'])delete legacy[key];
  storage.files[0]={getName:()=>legacy.id+'.json',getBlob:()=>({getDataAsString:()=>JSON.stringify(legacy)})};
  assert.equal(context.saveEvaluation(payload()).record.schema_version,1);
  assert.equal(context.listEvaluations().records[0].media_usage_recorded,undefined);
});
test('a saved plan preserves media removed by a later catalogue refresh',()=>{
  const {context}=environment();
  const plan=context.savePlan(planPayload()).plan;
  vm.runInContext(`CATALOG.scenarios.find(s=>s.scenario_id===${JSON.stringify(scenario.scenario_id)}).activities=[]`,context);
  const saved=context.saveEvaluation(payload({scenario_id:scenario.scenario_id,plan_version_id:plan.id,media_usage_recorded:true,used_material_ids:[ids[0]]})).record;
  assert.equal(saved.used_materials[0].label,plan.planned_materials[0].label);
  assert.equal(saved.lesson_plan.planned_materials.length,2);
});
test('cloud keeps individual records across a fresh runtime and retry is idempotent',()=>{
  const {context,storage}=environment();
  const first=context.saveEvaluation(payload());
  assert.equal(first.created,true);
  assert.equal(storage.files.length,1);
  assert.equal(context.saveEvaluation(payload()).created,false);
  assert.equal(storage.files.length,1);
  assert.throws(()=>context.saveEvaluation(payload({flags:['more-time']})),/διαφορετική καταγραφή/);
  const restarted=environment(storage).context;
  assert.equal(restarted.listEvaluations().records[0].id,first.record.id);
  assert.equal(restarted.exportEvaluations().evaluations.length,1);
});
test('cloud validates known identities, flags, grade and section before writing',()=>{
  const {context,storage}=environment();
  for(const changed of [{request_id:'../../x'},{scenario_id:'unknown'},{model_id:'unknown'},{flags:[]},{flags:['invalid']},{grade:'unknown'},{grade:'',section:'B1'},{section:'x'.repeat(41)},{cognitive_difficulty:9}]){
    assert.throws(()=>context.saveEvaluation(payload(changed)));
  }
  assert.equal(storage.files.length,0);
});
test('cloud stops if storage was shared or a record was corrupted',()=>{
  const {context,folder,storage}=environment();
  folder.getEditors=()=>['someone'];
  assert.throws(()=>context.listEvaluations(),/ιδιωτικός/);
  folder.getEditors=()=>[];
  storage.files.push({getName:()=>payload().request_id+'.json',getBlob:()=>({getDataAsString:()=>'{broken'})});
  assert.throws(()=>context.listEvaluations(),/ανάκτηση/);
});

const mapPayload=(overrides={})=>({request_id:randomUUID(),document_id:randomUUID(),kind:'canvas',document:lmNewCanvas('Ιδιωτικό μάθημα',scenario.scenario_id),...overrides});
test('lesson maps preserve versions, reject stale writes, and retry once',()=>{
 const {context,storage}=environment();const data=mapPayload(),one=context.saveLessonMap(data).version;
 assert.equal(context.saveLessonMap(data).created,false);
 const edit=mapPayload({document_id:one.document_id,previous_version_id:one.id});edit.document.title='Νέα έκδοση';
 const two=context.saveLessonMap(edit).version;assert.equal(two.previous_version_id,one.id);
 assert.throws(()=>context.saveLessonMap({...edit,request_id:randomUUID()}),/άλλη συσκευή/);
 assert.equal(environment(storage).context.listLessonMaps().versions.length,2);
 assert.equal(context.listEvaluations().records.length,0);assert.equal(context.listPlans().plans.length,0);
});
test('private registration is a material with an exact saved canvas version',()=>{
 const {context}=environment();const row=context.registerLessonCanvas(mapPayload()).version;
 const c=context.lessonCanvasRegistry_().scenarios.find(s=>s.scenario_id===scenario.scenario_id),a=c.activities.find(a=>a.kind==='canvas');
 assert.equal(a.canvas_version_id,row.id);assert.equal(catalog.scenarios.find(s=>s.scenario_id===scenario.scenario_id).activities.some(a=>a.kind==='canvas'),false);
 const plan=context.savePlan(planPayload({planned_material_ids:[a.id]})).plan;assert.equal(plan.planned_materials[0].canvas_version_id,row.id);
 const usage={confirmed:true,canvas_id:row.document_id,version_id:row.id,used_building_ids:['text'],guidance_building_ids:['images'],note:'Ιδιωτική παρατήρηση'};
 const evaluation={...payload({scenario_id:scenario.scenario_id,plan_version_id:plan.id,media_usage_recorded:true,used_material_ids:[a.id]}),canvas_usage:usage};
 const saved=context.saveEvaluation(evaluation).record;assert.equal(saved.canvas_usage.version_id,row.id);assert.equal(context.saveEvaluation(evaluation).created,false);
 assert.throws(()=>context.saveEvaluation({...evaluation,canvas_usage:{...usage,note:'διαφορετικό'}}),/διαφορετική καταγραφή/);
 assert.throws(()=>context.validateCanvasUsage_({...usage,confirmed:false},scenario.scenario_id),/Επιβεβαίωσε/);
 assert.throws(()=>context.validateCanvasUsage_(usage,'foreign'),/έκδοση χάρτη/);
});
test('uploaded HTML remains private and its bytes are returned only to the owner',()=>{
 const {context}=environment();const id=randomUUID(),text='<!doctype html><html><body>ΜΑΘΗΜΑ</body></html>',blob=context.Utilities.newBlob(text,'text/html','activity.html');
 const result=context.uploadCanvasAsset({asset_id:id,file:blob});assert.equal(result.asset.mime,'text/html');assert.equal(Buffer.from(context.readCanvasAsset(id).base64,'base64').toString('utf8'),text);
 assert.equal(context.uploadCanvasAsset({asset_id:id,file:blob}).asset.sha256,result.asset.sha256);
 assert.throws(()=>context.uploadCanvasAsset({asset_id:randomUUID(),file:context.Utilities.newBlob(text,'image/png','fake.png')}),/αντιστοιχεί/);
 const data=mapPayload();data.document.buildings[3].materials.push({id:randomUUID(),label:'HTML',type:'html',asset_id:id});const row=context.saveLessonMap(data).version;
 assert.equal(JSON.stringify(row).includes('ΜΑΘΗΜΑ'),false);assert.equal(context.listEvaluations().records.length,0);
});
test('server validates map relationships, asset references, and normalized annotations',()=>{
 const {context}=environment();
 for(const mutate of [d=>d.schema_version=2,d=>d.buildings.pop(),d=>d.buildings[0].box.x=NaN,d=>d.connections.push({id:randomUUID(),from:'missing',to:'text'}),d=>d.buildings[0].materials.push({id:randomUUID(),type:'pdf',url:'javascript:alert(1)'}),d=>d.buildings[0].materials.push({id:randomUUID(),type:'image',asset_id:randomUUID()})]){
  const p=mapPayload();mutate(p.document);assert.throws(()=>context.saveLessonMap(p));
 }
 const w=lmNewWorkspace(catalog);assert.equal(w.themes.length,5);assert.equal(w.themes.some(t=>t.title.includes('Αποκάλυψη')),false);
 assert.equal(context.listLessonMaps().versions.length,0);
});
