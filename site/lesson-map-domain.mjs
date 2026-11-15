export const LM_BUILDINGS = [
  {id:'text',title:'Βιβλιοθήκη κειμένου',icon:'📖',sprite:'library',box:{x:.35,y:.015,w:.29,h:.34}},
  {id:'images',title:'Πινακοθήκη εικόνων',icon:'🖼️',sprite:'gallery',box:{x:.69,y:.29,w:.29,h:.35}},
  {id:'mindmap',title:'Σχολή εννοιών',icon:'💡',sprite:'concepts',box:{x:.015,y:.29,w:.29,h:.35}},
  {id:'html',title:'Εργαστήριο δραστηριοτήτων',icon:'✨',sprite:'workshop',box:{x:.17,y:.65,w:.29,h:.34}},
  {id:'synthesis',title:'Στοά σύνθεσης',icon:'🔗',sprite:'synthesis',box:{x:.56,y:.65,w:.29,h:.34}},
];
export const LM_VERBS = ['προεικονίζει','φανερώνει','ερμηνεύει','καλλιεργεί','ολοκληρώνει','πραγματώνει','αντιπαραβάλλεται με','οδηγεί σε','συμβολίζει','εφαρμόζεται στη ζωή'];
export const LM_WORKSPACE_ID = 'd15602cc-a42b-4c76-9577-0535b43cfa01';
export const LM_PILOT_ID = 'd15602cc-a42b-4c76-9577-0535b43cfa02';
export const LM_PILOT_SCENARIO = 'html:1jiGpW-SNz_pIEP_fOdUyyOlqKu315LxD:eikona-talanta-loukas';
export const lmId = () => crypto.randomUUID?.() ?? '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(Number(c)^crypto.getRandomValues(new Uint8Array(1))[0]&15>>Number(c)/4).toString(16));
export const lmClone = value => JSON.parse(JSON.stringify(value));
export const lmEscape = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const lmClamp = (value,min,max) => Math.max(min,Math.min(max,value));
export function lmNewCanvas(title='Νέο μάθημα',scenarioId=null) {
  return {schema_version:1,title,grade:'Α΄ Γυμνασίου',scenario_id:scenarioId,registered:false,
    verbs:[...LM_VERBS],buildings:LM_BUILDINGS.map(b=>({...lmClone(b),materials:[],hidden:false})),
    annotations:[],connections:[],presentation:{reveal_order:LM_BUILDINGS.map(b=>b.id),hide_empty:true}};
}
export function lmNewWorkspace(registry={scenarios:[]}) {
  const names=[['Παλαιά Διαθήκη','📜'],['Καινή Διαθήκη','🕊️'],['Παραβολές','🌾'],['Βίοι Αγίων','🕯️'],['Κατ’ εικόνα – Καθ’ ομοίωση','🌱']];
  const boxes=[{x:.04,y:.02,w:.32,h:.4},{x:.59,y:.02,w:.32,h:.4},{x:.065,y:.56,w:.32,h:.4},{x:.61,y:.56,w:.32,h:.4},{x:.33,y:.29,w:.32,h:.4}];
  const themes=names.map(([title,icon],i)=>({id:`d15602cc-a42b-4c76-9577-0535b43cfa1${i}`,title,icon,box:boxes[i]}));
  const examples=[['book:lesson-creation-world',0,'Δημιουργία του ανθρώπου'],
    ['html:1ZUZE2aoj9grwUdi-WmSpKshE3t2KURou:talents-music-mindmap',2,'Η παραβολή των ταλάντων'],
    ['html:1Ko8gjsGL-vHako6sN4ngfolgt5i6yFdJ:saint-luke-journey',3,'Άγιος Λουκάς ο Ιατρός'],
    [LM_PILOT_SCENARIO,4,'Κατ’ εικόνα → Τάλαντα → Άγιος Λουκάς → Καθ’ ομοίωση']];
  const lessons=examples.filter(([sid])=>registry.scenarios.some(s=>s.scenario_id===sid)).map(([sid,t,title],i)=>({id:`d15602cc-a42b-4c76-9577-0535b43cfa2${i}`,theme_id:themes[t].id,title,scenario_id:sid,canvas_id:sid===LM_PILOT_SCENARIO?LM_PILOT_ID:null}));
  return {schema_version:1,title:'Ο χάρτης των μαθημάτων μου',grade:'Α΄ Γυμνασίου',verbs:[...LM_VERBS],themes,lessons,connections:[]};
}
export function lmLatest(versions) {
  const byId=new Map(),superseded=new Set(versions.map(v=>v.previous_version_id).filter(Boolean));
  for(const v of [...versions].filter(v=>!superseded.has(v.id)).sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id))) byId.set(v.document_id,v);
  return byId;
}
export function lmFit(boxes,width,height) {
  const x1=Math.min(0,...boxes.map(b=>b.x*1600-35)),y1=Math.min(0,...boxes.map(b=>b.y*900-35));
  const x2=Math.max(1600,...boxes.map(b=>(b.x+b.w)*1600+35)),y2=Math.max(900,...boxes.map(b=>(b.y+b.h)*900+35));
  const zoom=Math.max(.12,Math.min(width/(x2-x1),height/(y2-y1))*.96);
  return {x:(width-(x2-x1)*zoom)/2-x1*zoom,y:(height-(y2-y1)*zoom)/2-y1*zoom,zoom};
}
export function lmZoom(view,factor,cx,cy) {
  const zoom=lmClamp(view.zoom*factor,.12,3.5),ratio=zoom/view.zoom;
  return {x:cx-(cx-view.x)*ratio,y:cy-(cy-view.y)*ratio,zoom};
}
export function lmCurve(a,b) {
  const from={x:(a.x+a.w/2)*1600,y:(a.y+a.h/2)*900},to={x:(b.x+b.w/2)*1600,y:(b.y+b.h/2)*900};
  const bend=Math.min(150,Math.hypot(to.x-from.x,to.y-from.y)*.22);
  return {d:`M${from.x},${from.y} C${from.x},${from.y-bend} ${to.x},${to.y-bend} ${to.x},${to.y}`,x:(from.x+to.x)/2,y:(from.y+to.y)/2-bend*.75};
}
export function lmConnectionLabel(curve,boxes,placed=[]) {
  const bands=boxes.map(b=>({x:b.x*1600,y:(b.y+b.h*.6)*900,w:b.w*1600,h:b.h*.4*900}));
  const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));
  const candidates=[[0,0],[0,95],[0,-95],[0,165],[160,80],[-160,80],[160,-80],[-160,-80]];
  let best=null;
  for(const [dx,dy] of candidates){const p={x:lmClamp(curve.x+dx,145,1455),y:lmClamp(curve.y+dy,40,830)},r={x:p.x-140,y:p.y-26,w:280,h:80};const score=[...bands,...placed].reduce((sum,b)=>sum+overlap(r,b),0)+Math.hypot(dx,dy)*.1;if(!best||score<best.score)best={...p,score};}
  placed.push({x:best.x-140,y:best.y-26,w:280,h:80});return best;
}
export function lmPoint(clientX,clientY,rect) {
  return {x:lmClamp((clientX-rect.left)/rect.width,0,1),y:lmClamp((clientY-rect.top)/rect.height,0,1)};
}
export function lmSafeURL(value) {
  try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u.href:'';}catch{return '';}
}
export function lmMaterialType(file) {
  const ext=file.name?.split('.').pop()?.toLowerCase();
  if(file.type?.startsWith('image/')||['png','jpg','jpeg','webp'].includes(ext))return 'image';
  if(file.type==='application/pdf'||ext==='pdf')return 'pdf';
  if(file.type==='text/html'||['html','htm'].includes(ext))return 'html';
  throw Error('Επίλεξε PNG, JPG, WebP, PDF ή αυτοτελές HTML.');
}
export function lmAssetIDs(doc){return [...new Set([...(doc.buildings||[]).flatMap(b=>b.materials.map(m=>m.asset_id)),doc.import_source?.asset_id,...(doc.import_source?.exercise_regions||[]).map(r=>r.asset_id)].filter(Boolean))];}
export function lmMaterialReady(material,registry={scenarios:[]}) {
  if(material.type==='text')return Boolean(material.text?.trim());
  if(material.asset_id||lmSafeURL(material.url))return true;
  const activity=registry.scenarios.find(s=>s.scenario_id===material.source_scenario_id)?.activities.find(a=>a.id===material.activity_id);
  return Boolean(activity&&(activity.url||activity.download_url)&&!['canvas','vr','model'].includes(activity.kind));
}
export function lmCanvasReady(doc,registry) {return Boolean(doc?.buildings?.some(b=>b.materials.some(m=>lmMaterialReady(m,registry))));}
export function lmVisibleWorkspace(workspace,documents,registry) {
  const lessons=workspace.lessons.filter(l=>{
    if(l.canvas_id)return lmCanvasReady(documents.get(l.canvas_id)?.document,registry);
    return registry.scenarios.find(s=>s.scenario_id===l.scenario_id)?.activities.some(a=>['html','image','pdf','quiz'].includes(a.kind)&&(a.url||a.download_url));
  });
  const themes=workspace.themes.filter(t=>lessons.some(l=>l.theme_id===t.id));
  return {...workspace,themes,lessons};
}
export function lmMaterialKey(m) {
  if(m.activity_id)return 'activity:'+m.source_scenario_id+':'+m.activity_id;
  if(m.provenance)return 'source:'+m.provenance.drive_id+':'+(m.provenance.page||'')+':'+(m.provenance.variant||'');
  return m.asset_id?'asset:'+m.asset_id:'material:'+m.id;
}
/** Add curated material to the teacher's latest documents, preserving their layout and edits. */
export function lmCurateTransfer(bundle,documents) {
  const next=new Map([...documents].map(([id,row])=>[id,lmClone(row)])),curation=bundle.curation;
  const workspace=next.get(curation.workspace_id)?.document||lmNewWorkspace({scenarios:[]});
  const aliases=new Map();
  for(const [id,row] of bundle.documents){
    if(row.kind!=='canvas')continue;
    const sid=row.document.scenario_id,placed=workspace.lessons.find(l=>l.canvas_id===id||(sid&&l.scenario_id===sid));
    const targetId=placed?.canvas_id&&next.has(placed.canvas_id)?placed.canvas_id:id;
    aliases.set(id,targetId);
    if(!next.has(targetId)){next.set(targetId,lmClone(row));continue;}
    const target=next.get(targetId).document;
    for(const b of row.document.buildings){
      const into=target.buildings.find(t=>t.id===b.id),keys=new Set(into.materials.map(lmMaterialKey));
      for(const m of b.materials){
        const existing=into.materials.find(t=>t.id===m.id);
        if(existing){if(m.provenance&&!existing.provenance)existing.provenance=lmClone(m.provenance);continue;}
        if(!keys.has(lmMaterialKey(m))){into.materials.push(lmClone(m));keys.add(lmMaterialKey(m));}
      }
    }
    if(!target.registered&&!target.scenario_id&&row.document.import_source&&sid==='notes:'+targetId){target.scenario_id=sid;target.import_source=lmClone(row.document.import_source);}
    if(row.document.registered&&target.scenario_id===sid)target.registered=true;
  }
  for(const t of curation.themes)if(!workspace.themes.some(old=>old.id===t.id))workspace.themes.push(lmClone(t));
  for(const p of curation.placements){
    const cid=aliases.get(p.canvas_id)||p.canvas_id,canvas=next.get(cid);
    if(canvas?.kind!=='canvas')throw Error('Λείπει το αποθηκευμένο μάθημα της κατανομής.');
    const doc=canvas.document,old=workspace.lessons.find(l=>l.canvas_id===cid||(doc.scenario_id&&l.scenario_id===doc.scenario_id));
    if(old){old.canvas_id=cid;old.theme_id=p.theme_id;old.scenario_id=doc.scenario_id;}
    else workspace.lessons.push({id:p.id,canvas_id:cid,theme_id:p.theme_id,title:doc.title,scenario_id:doc.scenario_id});
  }
  next.set(curation.workspace_id,{kind:'workspace',document:workspace});
  return new Map([...next].filter(([id,row])=>JSON.stringify(row)!==JSON.stringify(documents.get(id))));
}
export function lmValidateTransfer(value) {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if(!value||value.format!=='lesson-map-transfer'||value.schema_version!==1||!Array.isArray(value.documents)||value.documents.length>100||!Array.isArray(value.assets)||value.assets.length>500)throw Error('Επίλεξε έγκυρο ιδιωτικό πακέτο μεταφοράς χάρτη.');
  const ids=new Set();
  for(const pair of value.documents){
    if(!Array.isArray(pair)||pair.length!==2||!uuid.test(pair[0])||ids.has(pair[0])||!['workspace','canvas'].includes(pair[1]?.kind)||!pair[1].document||pair[1].document.schema_version!==1)throw Error('Το πακέτο περιέχει μη έγκυρο χάρτη.');
    ids.add(pair[0]);
  }
  const assets=new Set();
  for(const a of value.assets){if(!a||!uuid.test(a.id)||assets.has(a.id)||typeof a.name!=='string'||a.name.length>180||!['image/png','image/jpeg','image/webp','application/pdf','text/html'].includes(a.mime)||typeof a.base64!=='string'||a.base64.length>36*1024*1024)throw Error('Το πακέτο περιέχει μη έγκυρο αρχείο.');assets.add(a.id);}
  for(const [,row] of value.documents)for(const b of row.document.buildings||[])for(const m of b.materials||[])if(m.asset_id&&!assets.has(m.asset_id))throw Error('Λείπει αρχείο από το πακέτο μεταφοράς.');
  for(const [,row] of value.documents)if(lmAssetIDs(row.document).some(id=>!assets.has(id)))throw Error('Λείπει πρωτότυπο ή απόσπασμα σημειώσεων από το πακέτο.');
  if(value.curation){
    const c=value.curation;
    if(!uuid.test(c.workspace_id)||!Array.isArray(c.themes)||c.themes.length>80||!Array.isArray(c.placements)||c.placements.length>100||value.documents.some(([,r])=>r.kind!=='canvas'))throw Error('Μη έγκυρη κατανομή υλικού.');
    const themes=new Set(),placements=new Set();
    for(const t of c.themes){if(!uuid.test(t.id)||themes.has(t.id)||typeof t.title!=='string'||!t.title.trim()||t.title.length>240||typeof t.icon!=='string'||t.icon.length>20||!t.box||!['x','y','w','h'].every(k=>Number.isFinite(t.box[k]))||Math.abs(t.box.x)>5||Math.abs(t.box.y)>5||t.box.w<.05||t.box.h<.05||t.box.w>2||t.box.h>2)throw Error('Μη έγκυρη θεματική της κατανομής.');themes.add(t.id);}
    for(const p of c.placements){if(!uuid.test(p.id)||!uuid.test(p.canvas_id)||!themes.has(p.theme_id)||placements.has(p.canvas_id))throw Error('Μη έγκυρη πόλη της κατανομής.');placements.add(p.canvas_id);}
  }
  return value;
}
