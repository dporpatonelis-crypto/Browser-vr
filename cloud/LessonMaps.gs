/** Lesson maps share the existing owner-only folder and append-only history. */
const MAP_BUILDINGS_ = ['text','images','mindmap','html','synthesis'];
function mapText_(value,max) {if(typeof value!=='string'||value.length>(max||240)||value.includes('\0'))throw new Error('Μη έγκυρο κείμενο χάρτη.');return value;}
function mapList_(value,max) {if(!Array.isArray(value)||value.length>(max||500))throw new Error('Μη έγκυρη λίστα χάρτη.');return value;}
function mapPoint_(p,min,max) {
  if(!p||typeof p!=='object'||['x','y'].some(k=>typeof p[k]!=='number'||!Number.isFinite(p[k])||p[k]<min||p[k]>max))throw new Error('Μη έγκυρες συντεταγμένες.');
  return {x:p.x,y:p.y};
}
function mapBox_(b) {const p=mapPoint_(b,-5,5);if(['w','h'].some(k=>typeof b[k]!=='number'||!Number.isFinite(b[k])||b[k]<.05||b[k]>2))throw new Error('Μη έγκυρο μέγεθος.');return {...p,w:b.w,h:b.h};}
function mapLinks_(rows,ids) {
  const result=mapList_(rows).map(r=>{
    if(!r||!ids.has(r.from)||!ids.has(r.to)||r.from===r.to)throw new Error('Η σύνδεση χρειάζεται δύο υπαρκτά στοιχεία.');
    return {id:uuid_(r.id),from:r.from,to:r.to,verb:mapText_(r.verb||'',100),phrase:mapText_(r.phrase||'',600),visible:r.visible!==false};
  });
  if(new Set(result.map(r=>r.id)).size!==result.length)throw new Error('Διπλή ταυτότητα σύνδεσης.');return result;
}
function validateNotesSource_(data,scenarios){
  if(!data||!['pdf','image'].includes(data.type)||!/^([0-9a-f]{64})$/.test(data.sha256||'')||!['pdf-text','ocr','mixed','manual'].includes(data.extraction))throw new Error('Μη έγκυρη πηγή σημειώσεων.');
  const start=data.page_start,end=data.page_end,total=data.total_pages;
  if(![start,end,total].every(Number.isInteger)||start<1||end<start||end>total||total>10000||end-start>=20)throw new Error('Επίλεξε έγκυρο εύρος έως 20 σελίδων.');
  const related=mapList_(data.related_scenario_ids||[],100);if(related.some(s=>!scenarios.has(s)))throw new Error('Δεν βρέθηκε το σχετικό μάθημα.');
  return {asset_id:uuid_(data.asset_id),sha256:data.sha256,name:mapText_(data.name,180),type:data.type,extraction:data.extraction,page_start:start,page_end:end,total_pages:total,focus:mapText_(data.focus||'',1000),keywords:mapList_(data.keywords||[],12).map(t=>mapText_(t,100)),related_scenario_ids:[...new Set(related)],exercise_regions:mapList_(data.exercise_regions||[],40).map(r=>{if(r.page<start||r.page>end)throw new Error('Το απόσπασμα είναι εκτός επιλεγμένων σελίδων.');return {asset_id:uuid_(r.asset_id),page:r.page,...notesRegion_(r)};})};
}
function notesRegion_(r){const p=mapPoint_(r,0,1);if(!Number.isInteger(r.page)||r.page<1||r.page>10000||!['w','h'].every(k=>typeof r[k]==='number'&&Number.isFinite(r[k])&&r[k]>.001&&r[k]<=1)||p.x+r.w>1.001||p.y+r.h>1.001)throw new Error('Μη έγκυρο απόσπασμα άσκησης.');return {...p,w:r.w,h:r.h};}
function mapProvenance_(data){
  if(!data||typeof data!=='object'||!/^[-\w]{10,200}$/.test(data.drive_id||''))throw new Error('Μη έγκυρη ταυτότητα πηγής Drive.');
  const result={drive_id:mapText_(data.drive_id,200),name:mapText_(data.name,180)};
  if('page' in data){if(!Number.isInteger(data.page)||data.page<1||data.page>10000)throw new Error('Μη έγκυρη σελίδα πηγής.');result.page=data.page;}
  if('variant' in data)result.variant=mapText_(data.variant,120);
  return result;
}
function validateLessonMap_(kind,data,documentId) {
  if(!data||typeof data!=='object'||Array.isArray(data)||JSON.stringify(data).length>1048576)throw new Error('Μη έγκυρο μέγεθος ή περιεχόμενο χάρτη.');
  if(data.schema_version!=null&&data.schema_version!==1)throw new Error('Η έκδοση αυτού του χάρτη χρειάζεται νεότερη εφαρμογή. Το αρχείο διατηρείται.');
  const result={schema_version:1,title:mapText_(data.title),grade:mapText_(data.grade||'',60),verbs:[...new Set(mapList_(data.verbs||[],80).map(v=>mapText_(v,100)))]};
  if(!result.title.trim())throw new Error('Δώσε τίτλο στον χάρτη.');
  const scenarios=new Map(lessonCanvasRegistry_().scenarios.map(s=>[s.scenario_id,s]));
  if(kind==='workspace') {
    const themes=mapList_(data.themes,80).map(t=>({id:uuid_(t.id),title:mapText_(t.title),icon:mapText_(t.icon||'📚',20),box:mapBox_(t.box)})),ids=new Set(themes.map(t=>t.id));
    if(ids.size!==themes.length)throw new Error('Διπλή ταυτότητα θεματικής.');
    const lessons=mapList_(data.lessons).map(l=>{
      if(!ids.has(l.theme_id)||(l.scenario_id&&!scenarios.has(l.scenario_id)))throw new Error('Επίλεξε υπαρκτή θεματική και μάθημα.');
      return {id:uuid_(l.id),theme_id:l.theme_id,title:mapText_(l.title),scenario_id:l.scenario_id||null,canvas_id:l.canvas_id?uuid_(l.canvas_id):null};
    });
    if(new Set(lessons.map(l=>l.id)).size!==lessons.length)throw new Error('Διπλή ταυτότητα μαθήματος.');
    return {...result,themes,lessons,connections:mapLinks_(data.connections||[],ids)};
  }
  if(kind!=='canvas')throw new Error('Άγνωστος τύπος χάρτη.');
  const sid=data.scenario_id||null,registered=data.registered===true,materialIds=new Set();
  const source=data.import_source?validateNotesSource_(data.import_source,scenarios):null,ownNotes=source&&sid==='notes:'+documentId;
  if(sid&&!scenarios.has(sid)&&!ownNotes)throw new Error('Επίλεξε υπάρχον σενάριο για τη σύνδεση.');
  if(source&&!ownNotes)throw new Error('Το μάθημα σημειώσεων διατηρεί τη δική του ταυτότητα.');
  if(registered&&!sid)throw new Error('Η καταχώριση χρειάζεται υπάρχον μάθημα.');
  const buildings=mapList_(data.buildings,5).map(b=>{
    if(!MAP_BUILDINGS_.includes(b.id))throw new Error('Άγνωστος τύπος οικοδομήματος.');
    const materials=mapList_(b.materials||[],100).map(m=>{
      if(!['text','image','pdf','html'].includes(m.type))throw new Error('Άγνωστος τύπος υλικού.');
      const id=uuid_(m.id);if(materialIds.has(id))throw new Error('Διπλή ταυτότητα υλικού.');materialIds.add(id);
      const url=mapText_(m.url||'',4096),aid=mapText_(m.activity_id||'',200),source=m.source_scenario_id||'';
      if(url&&!/^https:\/\/[^\s/@:]+(?::\d+)?(?:[/?#][^\s]*)?$/i.test(url))throw new Error('Ο σύνδεσμος πρέπει να είναι πλήρης διεύθυνση HTTPS.');
      if(aid&&!(scenarios.get(source)?.activities||[]).some(a=>a.id===aid))throw new Error('Δεν βρέθηκε το συγκεκριμένο υλικό στον κατάλογο.');
      const start=m.page_start||1,end=m.page_end||1;if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>10000)throw new Error('Μη έγκυρο εύρος σελίδων.');
      return {id,type:m.type,label:mapText_(m.label||''),text:mapText_(m.text||'',100000),url,asset_id:m.asset_id?uuid_(m.asset_id):'',activity_id:aid,source_scenario_id:source,page_start:start,page_end:end,...m.provenance?{provenance:mapProvenance_(m.provenance)}:{}};
    });
    return {id:b.id,title:mapText_(b.title),icon:mapText_(b.icon||'',20),box:mapBox_(b.box),hidden:b.hidden===true,materials};
  });
  if(buildings.length!==5||new Set(buildings.map(b=>b.id)).size!==5)throw new Error('Κάθε μάθημα χρειάζεται τους πέντε τύπους οικοδομημάτων.');
  const annotations=mapList_(data.annotations||[],1000).map(a=>{
    if(!materialIds.has(a.material_id)||!['stroke','relation','region'].includes(a.kind))throw new Error('Μη έγκυρη σημείωση εικόνας.');
    const points=mapList_(a.points,2000).map(p=>mapPoint_(p,0,1));if(points.length<2)throw new Error('Η σημείωση χρειάζεται τουλάχιστον δύο σημεία.');
    return {id:uuid_(a.id),material_id:a.material_id,kind:a.kind,points,verb:mapText_(a.verb||'',100),phrase:mapText_(a.phrase||'',600)};
  });
  const p=data.presentation||{},order=mapList_(p.reveal_order||MAP_BUILDINGS_,5);
  if(order.length!==5||new Set(order).size!==5||order.some(i=>!MAP_BUILDINGS_.includes(i)))throw new Error('Μη έγκυρη σειρά εμφάνισης.');
  return {...result,...source?{import_source:source}:{},scenario_id:sid,registered,buildings,annotations,connections:mapLinks_(data.connections||[],new Set(MAP_BUILDINGS_)),presentation:{reveal_order:order,hide_empty:p.hide_empty!==false}};
}
function readLessonMaps_(folder) {
  const files=folder.getFiles(),rows=[];
  while(files.hasNext()){
    const f=files.next();if(!/^map-version-[0-9a-f-]{36}\.json$/.test(f.getName()))continue;
    let row;try{row=JSON.parse(f.getBlob().getDataAsString('UTF-8'));uuid_(row.id);uuid_(row.document_id);if(!['workspace','canvas'].includes(row.kind)||!row.document||!row.created_at)throw new Error();}
    catch(e){throw new Error('Ένας χάρτης χρειάζεται έλεγχο. Διατηρήθηκε για ανάκτηση.');}rows.push(row);
  }
  return rows.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
}
function latestLessonMaps_(rows){const latest=new Map(),superseded=new Set(rows.map(r=>r.previous_version_id).filter(Boolean));rows.filter(r=>!superseded.has(r.id)).forEach(r=>latest.set(r.document_id,r));return [...latest.values()];}
function listLessonMaps(){assertOwner_();const lock=LockService.getScriptLock();lock.waitLock(30000);try{return {versions:readLessonMaps_(folder_())};}finally{lock.releaseLock();}}
function lessonCanvasRegistry_(){
  const registry=JSON.parse(JSON.stringify(CATALOG)),scenarios=new Map(registry.scenarios.map(s=>[s.scenario_id,s]));
  for(const row of latestLessonMaps_(readLessonMaps_(folder_()))){const d=row.document;
    if(row.kind==='canvas'&&d.registered&&d.import_source&&d.scenario_id==='notes:'+row.document_id){
      const source=d.import_source,refs=new Set(d.buildings.flatMap(b=>b.materials.filter(m=>m.activity_id).map(m=>m.source_scenario_id+'|'+m.activity_id)));
      const activities=CATALOG.scenarios.flatMap(s=>s.activities.filter(a=>refs.has(s.scenario_id+'|'+a.id))).map(a=>JSON.parse(JSON.stringify(a)));
      const scenario={scenario_id:d.scenario_id,title:d.title,subject:'Θρησκευτικά',grades:CATALOG.grades.includes(d.grade)?[d.grade]:[],grade_status:'confirmed',objectives:[],inquiry_question:source.focus,modes:['μελέτη πηγής','σύνδεση εννοιών'],formats:[source.type==='pdf'?'PDF':'Εικόνα','HTML'],duration:null,cognitive_difficulty:null,technical_difficulty:null,readiness:'available',pedagogical_application:source.focus||'Μελέτη των σημειώσεων και σύνδεση με επιλεγμένα μέσα.',application_status:'teacher-confirmed',aliases:[],notes:[],source_groups:['Samsung Notes'],sources:[{system:'Samsung Notes',path:source.name,locator:''}],activities,private:true};
      registry.scenarios.push(scenario);scenarios.set(d.scenario_id,scenario);
    }
    if(row.kind==='canvas'&&d.registered&&scenarios.has(d.scenario_id))scenarios.get(d.scenario_id).activities.push({id:'canvas:'+row.document_id,kind:'canvas',label:'Χάρτης · '+d.title,url:'#canvas/'+row.document_id,canvas_id:row.document_id,canvas_version_id:row.id,note:'Ιδιωτικός χάρτης μαθήματος · πέντε οικοδομήματα γνώσης',app:'lesson-map'});}
  return registry;
}
function saveLessonMap(data){
  assertOwner_();if(!data||typeof data!=='object')throw new Error('Μη έγκυρος χάρτης.');
  const id=uuid_(data.request_id),did=uuid_(data.document_id),previous=data.previous_version_id?uuid_(data.previous_version_id):'',kind=data.kind,doc=validateLessonMap_(kind,data.document,did);
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    const folder=folder_(),rows=readLessonMaps_(folder),old=rows.find(r=>r.id===id),latest=latestLessonMaps_(rows).find(r=>r.document_id===did);
    if(old){if(['document_id','kind','previous_version_id','document'].some(k=>JSON.stringify(old[k])!==JSON.stringify({document_id:did,kind,previous_version_id:previous,document:doc}[k])))throw new Error('Το αναγνωριστικό χρησιμοποιήθηκε για διαφορετική αλλαγή.');return {ok:true,version:old,created:false,registry:lessonCanvasRegistry_()};}
    if(latest&&(latest.id!==previous||latest.kind!==kind)||!latest&&previous)throw new Error('Ο χάρτης άλλαξε από άλλη συσκευή. Άνοιξε την τελευταία έκδοση· οι αλλαγές σου διατηρούνται.');
    if(latest?.document.registered&&latest.document.scenario_id!==doc.scenario_id)throw new Error('Ο καταχωρισμένος χάρτης παραμένει στο ίδιο μάθημα. Δημιούργησε αντίγραφο.');
    if(doc.import_source){const s=doc.import_source,info=canvasAssetInfo_(s.asset_id,folder);if(info.sha256!==s.sha256||(s.type==='pdf')!==(info.mime==='application/pdf')||!/^image\/|^application\/pdf$/.test(info.mime))throw new Error('Το πρωτότυπο δεν αντιστοιχεί στις σημειώσεις.');for(const r of s.exercise_regions||[])if(!canvasAssetInfo_(r.asset_id,folder).mime.startsWith('image/'))throw new Error('Η άσκηση χρειάζεται εικόνα.');}
    for(const b of doc.buildings||[])for(const m of b.materials)if(m.asset_id)canvasAssetInfo_(m.asset_id,folder);
    if(kind==='workspace')for(const l of doc.lessons)if(l.canvas_id&&!rows.some(r=>r.kind==='canvas'&&r.document_id===l.canvas_id))throw new Error('Αποθήκευσε πρώτα τα μαθήματα του χάρτη.');
    const row={schema_version:1,id,document_id:did,previous_version_id:previous,kind,created_at:new Date().toISOString(),document:doc};
    const file=folder.createFile(Utilities.newBlob(JSON.stringify(row,null,2),'application/json','map-version-'+id+'.json'));
    if(file.getBlob().getDataAsString('UTF-8')!==JSON.stringify(row,null,2))throw new Error('Η αποθήκευση χρειάζεται έλεγχο.');
    return {ok:true,version:row,created:true,registry:lessonCanvasRegistry_()};
  }finally{lock.releaseLock();}
}
function registerLessonCanvas(data){assertOwner_();if(!data||data.kind!=='canvas'||!data.document)throw new Error('Η καταχώριση αφορά χάρτη μαθήματος.');data.document.registered=true;return saveLessonMap(data);}
function canvasAssetInfo_(id,folder){const files=folder.getFilesByName('map-asset-'+uuid_(id)+'.json');if(!files.hasNext())throw new Error('Δεν βρέθηκε το ιδιωτικό αρχείο.');return JSON.parse(files.next().getBlob().getDataAsString('UTF-8'));}
function uploadCanvasAsset(form){
  assertOwner_();if(!form?.file||!form.asset_id)throw new Error('Επίλεξε αρχείο.');
  const id=uuid_(form.asset_id),blob=form.file,bytes=blob.getBytes(),unsigned=bytes.map(b=>(b+256)%256),name=mapText_(blob.getName().replace(/^.*[\\/]/,''),180),ext=name.split('.').pop().toLowerCase();
  const mime=({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',pdf:'application/pdf',html:'text/html',htm:'text/html'})[ext];
  if(!mime||!bytes.length||bytes.length>25*1024*1024)throw new Error('Επίλεξε εικόνα, PDF ή αυτοτελές HTML έως 25 MB.');
  const ascii=unsigned.slice(0,4096).map(b=>String.fromCharCode(b)).join('');
  const valid={'image/png':unsigned.slice(0,8).join(',')==='137,80,78,71,13,10,26,10','image/jpeg':unsigned[0]===255&&unsigned[1]===216&&unsigned[2]===255,'image/webp':ascii.startsWith('RIFF')&&ascii.slice(8,12)==='WEBP','application/pdf':ascii.startsWith('%PDF-'),'text/html':/<(?:!doctype\s+html|html|head|body)\b/i.test(ascii)}[mime];
  if(!valid)throw new Error('Το περιεχόμενο δεν αντιστοιχεί στον τύπο αρχείου.');
  const sha=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,bytes).map(b=>((b+256)%256).toString(16).padStart(2,'0')).join(''),metadata={id,name,mime,size:bytes.length,sha256:sha};
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try{const folder=folder_(),found=folder.getFilesByName('map-asset-'+id+'.json');if(found.hasNext()){const old=JSON.parse(found.next().getBlob().getDataAsString('UTF-8'));if(JSON.stringify(old)!==JSON.stringify(metadata))throw new Error('Το αρχείο έχει ήδη διαφορετικό περιεχόμενο.');return {ok:true,asset:old};}
    folder.createFile(Utilities.newBlob(bytes,mime,'map-asset-'+id+'.bin'));
    folder.createFile(Utilities.newBlob(JSON.stringify(metadata),'application/json','map-asset-'+id+'.json'));
    return {ok:true,asset:metadata};
  }finally{lock.releaseLock();}
}
function readCanvasAsset(id){assertOwner_();const folder=folder_(),info=canvasAssetInfo_(id,folder),files=folder.getFilesByName('map-asset-'+info.id+'.bin');if(!files.hasNext())throw new Error('Δεν βρέθηκε το ιδιωτικό αρχείο.');return {...info,base64:Utilities.base64Encode(files.next().getBlob().getBytes())};}
function validateCanvasUsage_(data,scenarioId){
  if(!data||data.confirmed!==true)throw new Error('Επιβεβαίωσε τη χρήση του χάρτη.');
  const row=readLessonMaps_(folder_()).find(r=>r.id===data.version_id&&r.document_id===data.canvas_id&&r.kind==='canvas');
  if(!row||row.document.scenario_id!==scenarioId)throw new Error('Δεν βρέθηκε η συγκεκριμένη έκδοση χάρτη για το μάθημα.');
  const doc=row.document,allowed={used_building_ids:new Set(MAP_BUILDINGS_),guidance_building_ids:new Set(MAP_BUILDINGS_),effective_material_ids:new Set(doc.buildings.flatMap(b=>b.materials.map(m=>m.id))),effective_connection_ids:new Set(doc.connections.map(c=>c.id))};
  const result={canvas_id:row.document_id,version_id:row.id,title:doc.title,confirmed:true,note:mapText_(data.note||'',2000)};
  for(const key of Object.keys(allowed)){const values=mapList_(data[key]||[]);if(values.some(v=>!allowed[key].has(v)))throw new Error('Επίλεξε στοιχεία της συγκεκριμένης έκδοσης χάρτη.');result[key]=[...new Set(values)];}
  return result;
}
