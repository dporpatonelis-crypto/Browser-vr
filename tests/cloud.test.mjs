import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const owner='teacher@example.com';
const catalog=JSON.parse(readFileSync(new URL('../site/data/scenario-registry.json',import.meta.url)));
const models=JSON.parse(readFileSync(new URL('../site/data/pedagogical-models.json',import.meta.url)));
const source=readFileSync(new URL('../cloud/Code.gs',import.meta.url),'utf8')
  .replace('__OWNER_EMAIL__',owner).replace('__CATALOG__',JSON.stringify(catalog))
  .replace('__MODELS__',JSON.stringify(models)).replace('__PRIVATE_PAGE__',JSON.stringify('<html>__MISSION_BOOTSTRAP__</html>'));
function iterator(rows){let i=0;return {hasNext:()=>i<rows.length,next:()=>rows[i++]};}
function environment(storage={files:[],properties:new Map()},active=owner,effective=owner){
  const folder={getId:()=> 'private-folder',getSharingAccess:()=> 'PRIVATE',getEditors:()=>[],getViewers:()=>[],getOwner:()=>({getEmail:()=>owner}),
    getFiles:()=>iterator(storage.files),getFilesByName:name=>iterator(storage.files.filter(f=>f.getName()===name)),
    createFile:blob=>{const f={getName:()=>blob.name,getBlob:()=>({getDataAsString:()=>blob.data})};storage.files.push(f);return f;}};
  const context=vm.createContext({Session:{getActiveUser:()=>({getEmail:()=>active}),getEffectiveUser:()=>({getEmail:()=>effective})},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>storage.properties.get(k),setProperty:(k,v)=>storage.properties.set(k,v)})},
    LockService:{getScriptLock:()=>({waitLock:()=>{},releaseLock:()=>{}})},DriveApp:{Access:{PRIVATE:'PRIVATE'},createFolder:()=>folder,getFolderById:()=>folder},
    Utilities:{newBlob:(data,type,name)=>({data,type,name}),formatDate:d=>d.toISOString().slice(0,10)},
    HtmlService:{createHtmlOutput:s=>({setTitle:()=>({addMetaTag:()=>s})})}});
  vm.runInContext(source,context);
  return {context,storage,folder};
}
const payload=(overrides={})=>({request_id:'7ed3a50f-991a-4eb9-964a-f2e5458a5de0',scenario_id:'book:abraham-journey',model_id:'guided-exploration',grade:'Β΄ Λυκείου',section:'Β1',flags:['worked-well'],cognitive_difficulty:3,...overrides});
test('private cloud rejects anonymous, other accounts and mismatched execution identity',()=>{
  for(const [active,effective] of [['',owner],['other@example.com',owner],[owner,'other@example.com']]){
    const {context}=environment(undefined,active,effective);
    for(const name of ['doGet','listEvaluations','saveEvaluation','exportEvaluations','verifyPrivateStorage']) assert.throws(()=>context[name](payload()),/ιδιωτικός χώρος/);
  }
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
