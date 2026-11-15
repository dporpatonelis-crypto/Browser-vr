import test from 'node:test';
import assert from 'node:assert/strict';
import {lmNewWorkspace,lmNewCanvas,lmLatest,lmFit,lmZoom,lmCurve,lmPoint,lmSafeURL,lmMaterialType,lmValidateTransfer,LM_BUILDINGS} from '../public/lesson-map-domain.mjs';
import {niBuildCanvas,niFindMaterials,niMaterialTarget,niExistingImport} from '../public/lesson-import-domain.mjs';
import {niDarkPanels,niPrintedPixels} from '../public/lesson-notes-regions.mjs';
import {readFileSync} from 'node:fs';

test('starter has five editable A Gymnasium themes without Revelation',()=>{
  const w=lmNewWorkspace();assert.equal(w.themes.length,5);assert.equal(w.grade,'Α΄ Γυμνασίου');assert.ok(!w.themes.some(t=>/Αποκάλυψη/.test(t.title)));
  const c=lmNewCanvas();assert.equal(c.buildings.length,5);assert.deepEqual(c.buildings.map(b=>b.id),LM_BUILDINGS.map(b=>b.id));assert.equal(c.scenario_id,null);assert.equal(c.registered,false);
});
test('version ancestry takes precedence over tied timestamps and ID ordering',()=>{
  const rows=[{id:'z',document_id:'canvas',previous_version_id:'',created_at:'same'},{id:'a',document_id:'canvas',previous_version_id:'z',created_at:'same'}];
  assert.equal(lmLatest(rows).get('canvas').id,'a');
});
test('zoom keeps the world point beneath the cursor fixed',()=>{
  const view={x:50,y:-30,zoom:.5},next=lmZoom(view,1.7,300,200);
  assert.ok(Math.abs((300-view.x)/view.zoom-(300-next.x)/next.zoom)<1e-8);
  assert.ok(Math.abs((200-view.y)/view.zoom-(200-next.y)/next.zoom)<1e-8);
});
test('fit includes extended islands and relation curves follow node centers',()=>{
  const boxes=[{x:-.5,y:0,w:.3,h:.4},{x:1.4,y:.8,w:.3,h:.4}],v=lmFit(boxes,1000,600);
  for(const b of boxes){assert.ok(b.x*1600*v.zoom+v.x>=0);assert.ok((b.x+b.w)*1600*v.zoom+v.x<=1000);}
  const before=lmCurve(boxes[0],boxes[1]);const after=lmCurve({...boxes[0],x:.3},boxes[1]);assert.notEqual(before.d,after.d);
});
test('image points are normalized against the displayed image and clamped',()=>{
  const rect={left:100,top:50,width:800,height:400};assert.deepEqual(lmPoint(300,150,rect),{x:.25,y:.25});assert.deepEqual(lmPoint(50,900,rect),{x:0,y:1});
});
test('material links reject active and credential-bearing URLs',()=>{
  assert.equal(lmSafeURL('javascript:alert(1)'),'');assert.equal(lmSafeURL('file:///tmp/a'),'');assert.equal(lmSafeURL('https://a:b@example.org'), '');assert.equal(lmSafeURL('https://example.org/lesson'),'https://example.org/lesson');
  assert.equal(lmMaterialType({name:'lesson.HTML',type:''}),'html');assert.equal(lmMaterialType({name:'book.pdf'}),'pdf');assert.throws(()=>lmMaterialType({name:'script.js'}));
});
test('private transfer validates identities and requires every referenced payload',()=>{
  const id='d15602cc-a42b-4c76-9577-0535b43cfa02',aid='d15602cc-a42b-4c76-9577-0535b43cfa03';
  const doc=lmNewCanvas();doc.buildings[1].materials.push({id:aid,type:'image',asset_id:aid});
  const bundle={format:'lesson-map-transfer',schema_version:1,documents:[[id,{kind:'canvas',document:doc}]],assets:[{id:aid,name:'image.png',mime:'image/png',base64:'aGVsbG8='}]};
  assert.equal(lmValidateTransfer(bundle),bundle);
  assert.throws(()=>lmValidateTransfer({...bundle,assets:[]}));
  assert.throws(()=>lmValidateTransfer({...bundle,documents:[...bundle.documents,...bundle.documents]}));
  assert.throws(()=>lmValidateTransfer({...bundle,schema_version:2}));
  assert.throws(()=>lmValidateTransfer({...bundle,format:'unrelated-file'}));
});
test('Notes keeps the original and text in the library without generating HTML or invented concepts',()=>{
  const id=crypto.randomUUID(),source={asset_id:crypto.randomUUID(),type:'pdf',name:'source.pdf',page_start:2,page_end:4};
  const d=niBuildCanvas({id,title:'Συνέπειες της πτώσης',grade:'Α΄ Γυμνασίου',source,text:'Έντυπο κείμενο',terms:['παρακοή'],focus:'',selected:[]});
  assert.equal(d.scenario_id,'notes:'+id);assert.equal(d.registered,true);assert.equal(d.buildings[0].materials[0].text,'Έντυπο κείμενο');assert.equal(d.buildings[0].materials[1].type,'pdf');assert.equal(d.buildings[0].materials[1].page_start,2);
  assert.equal(d.buildings.find(b=>b.id==='html').materials.length,0);assert.equal(d.buildings.find(b=>b.id==='mindmap').materials.length,0);
});
test('Notes retrieval uses existing material identities and supplies evidence for teacher selection',()=>{
  const registry=JSON.parse(readFileSync(new URL('../site/data/scenario-registry.json',import.meta.url)));
  const rows=niFindMaterials(registry,{title:'Συνέπειες της πτώσης',text:'Οι οδύνες μετά την παρακοή. Γένεση 3. Η Εδέμ και η εξορία.'});
  assert.ok(rows.some(r=>r.scenario_id==='unity:byzantium_fall_restoration'&&/οδύνες/.test(r.activity.label)));
  assert.ok(rows.every(r=>r.activity.id&&r.evidence&&r.building));
  assert.equal(niMaterialTarget({kind:'vr',url:'https://example.org'}),null);
  assert.deepEqual(niMaterialTarget({kind:'image',label:'Εννοιολογικός χάρτης',url:'https://example.org/map.png'}),{building:'mindmap',type:'image'});
});
test('dark exercise panel detection retains the word bank across gaps in printed rows',()=>{
  const width=100,height=120,data=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=20;y<95;y++)for(let x=10;x<75;x++){if(y===50||y===51)continue;const i=(y*width+x)*4;data[i]=data[i+1]=data[i+2]=0;}
  const [r]=niDarkPanels({data,width,height});assert.ok(r.x<=.10);assert.ok(r.y<=20/height);assert.ok(r.y+r.h>=95/height);assert.ok(r.x+r.w<.8);
});
test('red pen is removed only from the OCR working copy, preserving typed ink and original bytes',()=>{
  const data=new Uint8ClampedArray([225,20,30,255,0,0,0,255,20,70,160,255]),original=[...data],result=niPrintedPixels({data});
  assert.deepEqual([...data],original);assert.deepEqual([...result.slice(0,4)],[255,255,255,255]);assert.deepEqual([...result.slice(4)],[0,0,0,255,20,70,160,255]);
});
test('one PDF can supply distinct lessons from different page ranges without duplicating the same range',()=>{
  const id=crypto.randomUUID(),rows=new Map([[id,{document:{import_source:{sha256:'hash',page_start:2,page_end:4}}}]]);
  assert.equal(niExistingImport(rows,'hash',2,4)[0],id);assert.equal(niExistingImport(rows,'hash',5,8),undefined);assert.equal(niExistingImport(rows,'other',2,4),undefined);
});
