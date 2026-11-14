import test from 'node:test';
import assert from 'node:assert/strict';
import {lmNewWorkspace,lmNewCanvas,lmLatest,lmFit,lmZoom,lmCurve,lmPoint,lmSafeURL,lmMaterialType,lmValidateTransfer,LM_BUILDINGS} from '../public/lesson-map-domain.mjs';

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
