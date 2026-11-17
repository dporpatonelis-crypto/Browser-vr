import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {lmNewCanvas,lmNewWorkspace,lmCurateTransfer,lmVisibleWorkspace,LM_WORKSPACE_ID} from '../public/lesson-map-domain.mjs';
import {lmRoute,lmParseRoute,lmMemberships,lmAtlasIndex,lmMaterialIdentities,lmOpenAtlas} from '../public/lesson-map-atlas.mjs';

const reg={scenarios:[]},sid='example',id=randomUUID(),b=randomUUID(),c=randomUUID();
const material={id:randomUUID(),type:'image',label:'Άσκηση',asset_id:randomUUID()};
const canvas=lmNewCanvas('Κοινό μάθημα',sid);canvas.buildings[1].materials=[material];
const workspace=(grade='Α΄ Γυμνασίου')=>({...lmNewWorkspace(reg),grade,lessons:[{id:randomUUID(),theme_id:lmNewWorkspace(reg).themes[0].id,canvas_id:id,title:'Παλιός τίτλος',scenario_id:sid}]});
const docs=()=>new Map([[id,{kind:'canvas',document:structuredClone(canvas)}],[LM_WORKSPACE_ID,{kind:'workspace',document:workspace()}],[b,{kind:'workspace',document:{...workspace('Β΄ Γυμνασίου'),visual_theme:'jerusalem'}}],[c,{kind:'workspace',document:{...workspace('Β΄ Γυμνασίου'),visual_theme:'mediterranean'}}]]);
test('map routes retain legacy links and distinguish two contexts of one shared canvas',()=>{
  for(const wid of [LM_WORKSPACE_ID,b,c])for(const version of ['',randomUUID()])assert.deepEqual(lmParseRoute(lmRoute(wid,id,version)),{workspaceId:wid===LM_WORKSPACE_ID?'':wid,canvasId:id,versionId:version});
  assert.equal(lmParseRoute('#map').workspaceId,LM_WORKSPACE_ID);assert.equal(lmParseRoute('#map/'+b).workspaceId,b);assert.equal(lmParseRoute('#map/../../secret'),null);
});
test('one shared city has three map memberships without duplicating material',()=>{
  const x=docs(),index=lmAtlasIndex(x,reg);assert.equal(index.canvases.length,1);assert.equal(index.canvases[0].memberships.length,3);assert.equal(index.shared.length,0);
  x.get(id).document.title='Νέος κοινός τίτλος';
  for(const wid of [LM_WORKSPACE_ID,b,c])assert.equal(lmVisibleWorkspace(x.get(wid).document,x,reg).lessons[0].title,'Νέος κοινός τίτλος');
  x.get(b).document.lessons=[];assert.equal(lmMemberships(x,id).length,2);assert.equal(x.get(id).document.buildings[1].materials.length,1);
});
test('last material removal withdraws every shared placement and undo restores all',()=>{
  const x=docs(),before=structuredClone(x);x.get(id).document.buildings[1].materials=[];
  for(const wid of [LM_WORKSPACE_ID,b,c])assert.equal(lmVisibleWorkspace(x.get(wid).document,x,reg).themes.length,0);
  for(const wid of [LM_WORKSPACE_ID,b,c])assert.equal(lmVisibleWorkspace(before.get(wid).document,before,reg).lessons.length,1);
});
test('common material uses payload identity across different filenames and asset IDs',()=>{
  const x=docs(),other=randomUUID(),aid=randomUUID();const d=lmNewCanvas('Άλλο μάθημα');d.buildings[2].materials=[{...material,id:randomUUID(),label:'Μετονομασμένη εικόνα',asset_id:aid}];x.set(other,{kind:'canvas',document:d});
  const index=lmAtlasIndex(x,reg,{[material.asset_id]:{sha256:'same-bytes'},[aid]:{sha256:'same-bytes'}});assert.equal(index.shared.length,1);assert.equal(index.shared[0].uses.length,2);assert.equal(index.shared[0].uses[1].building_id,'mindmap');
});
test('matching titles, distinct PDF ranges and distinct embedded HTML units are not common material',()=>{
  const registry={scenarios:[{scenario_id:'s',activities:[{id:'a',drive_id:'drive',native_id:'one'},{id:'b',drive_id:'drive',native_id:'two'}]}]};
  const a={activity_id:'a',source_scenario_id:'s',type:'html'},b={...a,activity_id:'b'};
  assert.equal(lmMaterialIdentities(a,registry).some(k=>lmMaterialIdentities(b,registry).includes(k)),false);
  const pdf={type:'pdf',asset_id:'same',page_start:1,page_end:2};assert.notDeepEqual(lmMaterialIdentities(pdf,reg),lmMaterialIdentities({...pdf,page_start:3,page_end:4},reg));
  assert.deepEqual(lmMaterialIdentities({label:'Ίδιος τίτλος',type:'image'},reg),[]);
});
test('different catalogue cards for the same Drive unit resolve to one file identity',()=>{
  const registry={scenarios:[{scenario_id:'s1',activities:[{id:'a',drive_id:'same-file',native_id:'lesson'}]},{scenario_id:'s2',activities:[{id:'b',drive_id:'same-file',native_id:'lesson'}]}]};
  const a=lmMaterialIdentities({type:'html',activity_id:'a',source_scenario_id:'s1'},registry),b=lmMaterialIdentities({type:'html',activity_id:'b',source_scenario_id:'s2'},registry);assert.ok(a.some(k=>b.includes(k)));
});
test('curation creates a new styled workspace from existing city references and is repeatable',()=>{
  const x=docs(),wid=randomUUID(),theme=randomUUID(),bundle={documents:[],curation:{workspace_id:wid,title:'Νέος χάρτης Β΄',grade:'Β΄ Γυμνασίου',visual_theme:'jerusalem',themes:[{id:theme,title:'Κοινό μάθημα',icon:'📚',box:{x:.2,y:.2,w:.3,h:.4}}],placements:[{id:randomUUID(),theme_id:theme,canvas_id:id}]}};
  const before=JSON.stringify([...x]),changed=lmCurateTransfer(bundle,x);assert.equal(changed.size,1);const next=new Map([...x,...changed]);assert.equal(next.get(wid).document.visual_theme,'jerusalem');assert.equal(next.get(wid).document.themes.length,1);assert.equal(lmCurateTransfer(bundle,next).size,0);assert.equal(JSON.stringify([...x]),before);
  bundle.curation.placements[0].canvas_id=randomUUID();assert.throws(()=>lmCurateTransfer(bundle,x),/Λείπει/);
});
test('the teacher atlas cannot open in public or presentation mode',async()=>{
  await lmOpenAtlas({privateMode:false,edit:true});await lmOpenAtlas({privateMode:true,edit:false});
});

test('a stored original and its direct Drive link share identity while a PDF extract stays distinct',()=>{
  const original={type:'image',provenance:{drive_id:'same-drive',name:'renamed.png'}},link={type:'image',url:'https://drive.google.com/file/d/same-drive/view'};
  const keys=lmMaterialIdentities(original,reg);assert.ok(lmMaterialIdentities(link,reg).some(k=>keys.includes(k)));
  assert.equal(lmMaterialIdentities({...original,provenance:{...original.provenance,page:39,variant:'embedded-image'}},reg).some(k=>keys.includes(k)),false);
});
