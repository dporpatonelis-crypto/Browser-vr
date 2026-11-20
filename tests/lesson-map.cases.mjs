import test from 'node:test';
import assert from 'node:assert/strict';
import {lmNewWorkspace,lmNewCanvas,lmLatest,lmFit,lmZoom,lmCurve,lmChronologyArrow,lmPoint,lmSafeURL,lmMaterialType,lmValidateTransfer,lmVisibleWorkspace,lmCurateTransfer,lmCanvasReady,LM_WORKSPACE_ID,LM_BUILDINGS} from '../public/lesson-map-domain.mjs';
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
test('chronology arrows stay outside their islands and adapt to moved or overlapping boxes', () => {
  const first = {x: 0, y: 0, w: 0.25, h: 0.4};
  const second = {...first, x: 0.5};
  assert.equal(lmChronologyArrow(first, second), 'M410,180 L790,180');
  assert.equal(lmChronologyArrow(second, first), 'M790,180 L410,180');
  assert.notEqual(lmChronologyArrow(first, {...second, y: 0.4}), lmChronologyArrow(first, second));
  assert.equal(lmChronologyArrow({...first, w: 0.6}, second), '');
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
test('ready-only import keeps provenance without copying text or original into the library',()=>{
  const id=crypto.randomUUID(),source={asset_id:crypto.randomUUID(),type:'image',name:'worksheet.jpg',page_start:1,page_end:1};
  const d=niBuildCanvas({id,title:'Άσκηση',grade:'Α΄ Γυμνασίου',source,text:'Δεν εισάγεται',readyOnly:true});
  assert.equal(d.buildings[0].materials.length,0);assert.equal(d.import_source.asset_id,source.asset_id);assert.equal(d.presentation.hide_empty,true);
  assert.equal(lmCanvasReady(d),false);
});
test('islands and cities follow actual material, including removal, undo and reloaded drafts',()=>{
  const w=lmNewWorkspace(),cid=crypto.randomUUID(),doc=lmNewCanvas(),registry={scenarios:[]},documents=new Map([[cid,{kind:'canvas',document:doc}]]);
  w.lessons=[{id:crypto.randomUUID(),theme_id:w.themes[0].id,canvas_id:cid}];
  const visible=()=>lmVisibleWorkspace(w,documents,registry);
  assert.equal(visible().themes.length,0);
  doc.buildings[1].materials=[{id:crypto.randomUUID(),type:'image',asset_id:crypto.randomUUID()}];
  const before=JSON.stringify(doc);assert.equal(visible().themes.length,1);assert.equal(visible().lessons.length,1);
  doc.buildings[1].materials=[];assert.equal(visible().themes.length,0);
  documents.set(cid,{kind:'canvas',document:JSON.parse(before)});assert.equal(visible().lessons.length,1);
  assert.equal(w.themes.length,5);assert.equal(w.lessons.length,1);
});
test('a label or source file alone does not activate a draft, and catalogue links need a launch target',()=>{
  const d=lmNewCanvas();d.import_source={asset_id:crypto.randomUUID()};d.buildings[1].materials=[{id:crypto.randomUUID(),type:'image',label:'Προσθήκη αργότερα'}];
  assert.equal(lmCanvasReady(d),false);
  d.buildings[3].materials=[{type:'html',activity_id:'actual',source_scenario_id:'s'}];
  assert.equal(lmCanvasReady(d,{scenarios:[{scenario_id:'s',activities:[{id:'actual',kind:'html',url:'https://example.org/lesson'}]}]}),true);
});
test('curation merges into current canvas and placement, preserving edits and avoiding duplicates on retry',()=>{
  const registry={scenarios:[]},w=lmNewWorkspace(registry),cid=crypto.randomUUID(),incomingId=crypto.randomUUID(),sid='existing:lesson';
  const c=lmNewCanvas('Τίτλος εκπαιδευτικού',sid);c.buildings[1].box.x=.56;
  const edited={id:crypto.randomUUID(),type:'image',label:'Δικός μου τίτλος',asset_id:crypto.randomUUID(),provenance:{drive_id:'source_id_12345',name:'image.jpg'}};
  c.buildings[1].materials=[edited];w.lessons=[{id:crypto.randomUUID(),canvas_id:cid,scenario_id:sid,title:'Δικός μου τίτλος',theme_id:w.themes[0].id}];
  const incoming=lmNewCanvas('Νέος τίτλος',sid);incoming.registered=true;incoming.buildings[1].materials=[{...edited,id:crypto.randomUUID(),label:'Αρχικός τίτλος'},{id:crypto.randomUUID(),type:'image',asset_id:crypto.randomUUID()}];
  const bundle={documents:[[incomingId,{kind:'canvas',document:incoming}]],curation:{workspace_id:LM_WORKSPACE_ID,themes:[w.themes[4]],placements:[{id:crypto.randomUUID(),canvas_id:incomingId,theme_id:w.themes[4].id}]}};
  const docs=new Map([[LM_WORKSPACE_ID,{kind:'workspace',document:w}],[cid,{kind:'canvas',document:c}]]),before=JSON.stringify([...docs]);
  const changes=lmCurateTransfer(bundle,docs);assert.equal(JSON.stringify([...docs]),before);assert.ok(!changes.has(incomingId));
  assert.equal(changes.get(cid).document.title,c.title);assert.equal(changes.get(cid).document.buildings[1].box.x,.56);
  assert.equal(changes.get(cid).document.buildings[1].materials.length,2);assert.equal(changes.get(cid).document.buildings[1].materials[0].label,edited.label);
  assert.equal(changes.get(LM_WORKSPACE_ID).document.lessons[0].id,w.lessons[0].id);assert.equal(changes.get(LM_WORKSPACE_ID).document.lessons[0].theme_id,w.themes[4].id);
  for(const pair of changes)docs.set(...pair);
  assert.equal(lmCurateTransfer(bundle,docs).size,0);
});
test('Byzantine curation keeps dates and recognizes an existing link to the same HTML', () => {
  const workspaceId = crypto.randomUUID();
  const canvasId = crypto.randomUUID();
  const theme = {...lmNewWorkspace().themes[0], title: 'Χριστολογία', artwork: 'christology', period: '5ος–7ος αι.'};
  const canvas = lmNewCanvas('Δοκιμή', 's');
  const material = {id: crypto.randomUUID(), type: 'html', url: 'https://example.org/activity.html'};
  canvas.buildings.find(b => b.id === 'html').materials.push(material);
  const bundle = {
    format: 'lesson-map-transfer', schema_version: 1, assets: [],
    documents: [[canvasId, {kind: 'canvas', document: canvas}]],
    curation: {
      workspace_id: workspaceId, visual_theme: 'byzantium', themes: [theme],
      placements: [{id: crypto.randomUUID(), canvas_id: canvasId, theme_id: theme.id, period: '7ος αι.'}],
    },
  };
  const existing = structuredClone(canvas);
  Object.assign(existing.buildings.find(b => b.id === 'html').materials[0], {
    id: crypto.randomUUID(), label: 'Δικός μου τίτλος', url: 'https://EXAMPLE.org/activity.html',
  });
  const documents = new Map([[canvasId, {kind: 'canvas', document: existing}]]);
  const changes = lmCurateTransfer(lmValidateTransfer(bundle), documents);
  assert.equal(changes.size, 1);
  const {document: workspace} = changes.get(workspaceId);
  assert.equal(workspace.themes[0].period, '5ος–7ος αι.');
  assert.equal(workspace.lessons[0].period, '7ος αι.');
  for (const pair of changes) documents.set(...pair);
  assert.equal(lmCurateTransfer(bundle, documents).size, 0);
});
test('curation registers an existing private draft without replacing its images, HTML or layout',()=>{
  const cid=crypto.randomUUID(),w=lmNewWorkspace(),old=lmNewCanvas('Αγία Φιλοθέη'),mid=crypto.randomUUID(),oldAsset=crypto.randomUUID();
  delete old.scenario_id;old.presentation.reveal_order=['text','html','images','mindmap','synthesis'];
  old.buildings[1].materials=[{id:mid,type:'image',label:'Δικό μου αρχείο',asset_id:oldAsset}];
  old.buildings[3].materials=[{id:crypto.randomUUID(),type:'html',asset_id:crypto.randomUUID()}];
  w.lessons=[{id:crypto.randomUUID(),title:old.title,canvas_id:cid,theme_id:w.themes[3].id}];
  const incoming=lmNewCanvas(old.title,'notes:'+cid);incoming.registered=true;incoming.import_source={asset_id:crypto.randomUUID()};
  incoming.buildings[1].materials=[{id:mid,type:'image',asset_id:crypto.randomUUID(),provenance:{drive_id:'source_id_12345',name:'source.jpg'}}];
  const bundle={documents:[[cid,{kind:'canvas',document:incoming}]],curation:{workspace_id:LM_WORKSPACE_ID,themes:[w.themes[3]],placements:[{id:crypto.randomUUID(),canvas_id:cid,theme_id:w.themes[3].id}]}};
  const docs=new Map([[LM_WORKSPACE_ID,{kind:'workspace',document:w}],[cid,{kind:'canvas',document:old}]]),changes=lmCurateTransfer(bundle,docs),merged=changes.get(cid).document;
  assert.equal(merged.scenario_id,'notes:'+cid);assert.equal(merged.registered,true);assert.equal(merged.buildings[1].materials.length,1);assert.equal(merged.buildings[1].materials[0].asset_id,oldAsset);
  assert.equal(merged.buildings[1].materials[0].label,'Δικό μου αρχείο');assert.equal(merged.buildings[3].materials[0].asset_id,old.buildings[3].materials[0].asset_id);assert.deepEqual(merged.presentation,old.presentation);
  for(const pair of changes)docs.set(...pair);assert.equal(lmCurateTransfer(bundle,docs).size,0);
});
