import {LM_BUILDINGS,LM_VERBS,LM_WORKSPACE_ID,LM_PILOT_ID,LM_PILOT_SCENARIO,lmId,lmClone,lmEscape,lmNewCanvas,lmNewWorkspace,lmLatest,lmFit,lmZoom,lmCurve,lmConnectionLabel,lmSafeURL,lmMaterialType,lmClamp,lmValidateTransfer} from './lesson-map-domain.mjs';
import {lmModal,lmForm,lmShowViewer} from './lesson-map-viewers.mjs';

export function createLessonMap(host,options) { return new LessonMap(host,options); }

export class LessonMap {
  constructor(host,options) {
    this.host=host;this.options=options;this.registry=options.registry;this.privateMode=options.privateMode;
    this.assetURL=path=>new URL(options.assetURL(path),location.href).href;
    this.documents=new Map();this.versions=new Map();this.allVersions=[];this.pending=new Map();this.savedJSON=new Map();
    this.current=LM_WORKSPACE_ID;this.selected='';this.edit=this.privateMode;this.tool='select';this.connectFrom='';
    this.undoStack=[];this.redoStack=[];this.views=new Map();this.objectURLs=new Set();this.blobs=new Map();this.saving=false;this.notice='';this.error=false;
    this.revealCount=5;this.showConnections=true;this.abort=new AbortController();this.points=new Map();this.gesture=null;
    this.ready=this.initialize(options.canvasId);
    window.addEventListener('beforeunload',e=>{if(this.dirty()){e.preventDefault();e.returnValue='';}},{signal:this.abort.signal});
    window.addEventListener('keydown',e=>{
      if(!this.host.isConnected||!this.edit||this.host.querySelector('dialog[open]')||e.target.matches('input,textarea,select'))return;
      if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();this.undo(e.shiftKey);}
      if(e.key==='Delete'&&this.selected){e.preventDefault();void this.removeSelected();}
    },{signal:this.abort.signal});
  }
  get document(){return this.documents.get(this.current)?.document;}
  get kind(){return this.documents.get(this.current)?.kind;}
  get workspace(){return this.documents.get(LM_WORKSPACE_ID)?.document;}
  get nodes(){return this.kind==='workspace'?this.document.themes:this.document.buildings;}
  async initialize(canvasId) {
    try{
      if(this.privateMode){const r=await this.get('api/lesson-maps','listLessonMaps');this.ingest(r.versions);}
      if(!this.documents.has(LM_WORKSPACE_ID))this.documents.set(LM_WORKSPACE_ID,{kind:'workspace',document:lmNewWorkspace(this.registry)});
      if(!this.documents.has(LM_PILOT_ID))this.documents.set(LM_PILOT_ID,{kind:'canvas',document:lmNewCanvas('Κατ’ εικόνα → Τάλαντα → Άγιος Λουκάς → Καθ’ ομοίωση',this.registry.scenarios.some(s=>s.scenario_id===LM_PILOT_SCENARIO)?LM_PILOT_SCENARIO:null)});
      if(!this.privateMode)this.documents.get(LM_PILOT_ID).document.presentation.hide_empty=false;
      if(canvasId&&this.documents.has(canvasId))this.current=canvasId;
      else if(canvasId)this.notice='Ο συγκεκριμένος ιδιωτικός χάρτης δεν είναι διαθέσιμος σε αυτή τη συνεδρία.';
      if(canvasId&&this.options.versionId){const versionId=this.options.versionId;this.options.versionId='';this.open(canvasId,versionId);}else this.render();
    }catch(e){this.notice='Δεν φορτώθηκαν οι ιδιωτικοί χάρτες: '+e.message;this.error=true;this.host.innerHTML=`<div class="lm-load-error"><h1>Χάρτης Μαθήματος</h1><p>${lmEscape(this.notice)}</p><button data-retry>Δοκιμή ξανά</button><button data-exit>Επιστροφή στο Πιλοτήριο</button></div>`;this.host.querySelector('[data-retry]').onclick=()=>this.initialize(canvasId);this.host.querySelector('[data-exit]').onclick=()=>this.options.onExit();}
  }
  ingest(rows) {
    this.allVersions=rows;this.versions=lmLatest(rows);
    for(const [id,row] of this.versions){this.documents.set(id,{kind:row.kind,document:lmClone(row.document)});this.savedJSON.set(id,JSON.stringify(row.document));}
  }
  async get(url,rpcName){if(this.options.cloud)return this.options.rpc(rpcName);const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error('Ανάγνωση '+r.status);return r.json();}
  async post(url,rpcName,payload){if(this.options.cloud)return this.options.rpc(rpcName,payload);const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Mission-Control':'teacher-action'},body:JSON.stringify(payload)});const d=await r.json();if(!r.ok)throw Error(d.error||'Η αποθήκευση απέτυχε.');return d;}
  async readAsset(id) {
    if(this.blobs.has(id))return this.blobs.get(id);
    let blob;
    if(this.options.cloud){const r=await this.options.rpc('readCanvasAsset',id);blob=new Blob([Uint8Array.from(atob(r.base64),c=>c.charCodeAt(0))],{type:r.mime});}
    else{const r=await fetch('api/canvas-assets/'+encodeURIComponent(id),{cache:'no-store'});if(!r.ok)throw Error('Δεν διαβάστηκε το ιδιωτικό αρχείο.');blob=await r.blob();}
    this.blobs.set(id,blob);return blob;
  }
  async upload(file,requestedId='') {
    if(file.size>25*1024*1024)throw Error('Το αρχείο πρέπει να είναι έως 25 MB.');
    const type=lmMaterialType(file),id=requestedId||lmId(),mime=type==='pdf'?'application/pdf':type==='html'?'text/html':file.type||({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'}[file.name.split('.').pop().toLowerCase()]);
    let result;
    if(this.options.cloud){
      const form=document.createElement('form'),input=document.createElement('input'),identifier=document.createElement('input');
      input.type='file';input.name='file';const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;identifier.name='asset_id';identifier.value=id;form.append(input,identifier);
      result=await this.options.rpc('uploadCanvasAsset',form);
    }else{const r=await fetch('api/canvas-assets',{method:'POST',headers:{'Content-Type':mime,'X-Mission-Control':'teacher-action','X-Asset-ID':id,'X-Asset-Name':encodeURIComponent(file.name)},body:file});result=await r.json();if(!r.ok)throw Error(result.error||'Η μεταφόρτωση απέτυχε.');}
    this.blobs.set(id,new Blob([await file.arrayBuffer()],{type:mime}));return {asset:result.asset,type};
  }
  async importTransfer(file) {
    if(!file||!this.privateMode||this.saving)return;
    try{
      if(file.size>50*1024*1024)throw Error('Το πακέτο μεταφοράς πρέπει να είναι έως 50 MB.');
      const bundle=lmValidateTransfer(JSON.parse(await file.text())),incoming=bundle.documents.filter(([id])=>!this.versions.has(id));
      if(!incoming.length){this.notice='Οι χάρτες υπάρχουν ήδη στον ιδιωτικό χώρο και διατηρήθηκαν.';this.render();return;}
      const confirmed=await lmForm(this.host,'Μεταφορά στον ιδιωτικό χώρο',`<p>Θα προστεθούν ${incoming.length} χάρτες με τα αρχεία τους. Οι ήδη αποθηκευμένοι χάρτες και οι αξιολογήσεις διατηρούνται.</p>`,'Μεταφορά');if(!confirmed)return;
      const needed=new Set(incoming.flatMap(([,row])=>(row.document.buildings||[]).flatMap(b=>b.materials.map(m=>m.asset_id).filter(Boolean))));
      this.saving=true;this.notice='Μεταφορά ιδιωτικών αρχείων…';this.render();let done=0;
      for(const a of bundle.assets.filter(a=>needed.has(a.id))){const bytes=Uint8Array.from(atob(a.base64),c=>c.charCodeAt(0));await this.upload(new File([bytes],a.name,{type:a.mime}),a.id);this.notice=`Μεταφέρθηκαν ${++done} από ${needed.size} αρχεία.`;this.render();}
      this.saving=false;this.change(()=>{for(const [id,row] of incoming)this.documents.set(id,lmClone(row));});
      await this.save();
    }catch(e){this.saving=false;this.notice='Η μεταφορά δεν ολοκληρώθηκε: '+e.message;this.error=true;this.render();}
  }
  async chooseTransfer() {
    if(!this.privateMode)return;
    const dialog=lmModal(this.host,'Μεταφορά ιδιωτικού μαθήματος','<div class="lm-import-choices"><button data-transfer-file><span>📂</span><strong>Από αρχείο</strong><small>Ιδιωτικό πακέτο μεταφοράς</small></button><button data-transfer-paste><span>📋</span><strong>Με επικόλληση</strong><small>Το ίδιο πακέτο ως κείμενο JSON</small></button></div>');
    dialog.querySelector('[data-transfer-file]').onclick=()=>{dialog.close();this.host.querySelector('#lm-transfer-file').click();};
    dialog.querySelector('[data-transfer-paste]').onclick=async()=>{dialog.close();const values=await lmForm(this.host,'Επικόλληση ιδιωτικού πακέτου','<label>Ιδιωτικό πακέτο μεταφοράς<textarea name="package" rows="10" required spellcheck="false" wrap="off" style="white-space:pre;overflow-wrap:normal" placeholder="Επικόλλησε εδώ το πλήρες περιεχόμενο του ιδιωτικού πακέτου JSON."></textarea></label>','Έλεγχος πακέτου');if(values)await this.importTransfer(new File([values.package],'private.lessonmap.json',{type:'application/json'}));};
  }
  snapshot(){return JSON.stringify([...this.documents]);}
  dirty(id=null){const documentFor=key=>this.historical?.document_id===key?this.documentBeforeHistorical?.document:this.documents.get(key)?.document;return id?this.savedJSON.get(id)!==JSON.stringify(documentFor(id)):[...this.documents.keys()].some(key=>this.savedJSON.get(key)!==JSON.stringify(documentFor(key)));}
  change(fn,render=true){if(this.saving)return;this.undoStack.push(this.snapshot());if(this.undoStack.length>60)this.undoStack.shift();this.redoStack=[];fn();this.pending.clear();this.notice='Υπάρχουν αλλαγές προς αποθήκευση.';this.error=false;if(render)this.render();}
  undo(redo=false){const source=redo?this.redoStack:this.undoStack,target=redo?this.undoStack:this.redoStack;if(!source.length||this.saving)return;target.push(this.snapshot());this.documents=new Map(JSON.parse(source.pop()));this.pending.clear();this.selected='';this.render();}
  async save(register=false) {
    if(!this.privateMode||this.saving)return;
    if(register&&!this.document.scenario_id){await this.linkScenario();if(!this.document.scenario_id)return;}
    if(register)this.change(()=>{this.document.registered=true;},false);
    this.saving=true;this.notice='Αποθήκευση στον ιδιωτικό χώρο…';this.render();
    try{
      const ordered=[...this.documents].sort((a,b)=>(a[1].kind==='workspace')-(b[1].kind==='workspace'));
      for(const [id,row] of ordered){
        if(!this.dirty(id))continue;
        let payload=this.pending.get(id);
        if(!payload){payload={request_id:lmId(),document_id:id,kind:row.kind,previous_version_id:this.versions.get(id)?.id||'',document:lmClone(row.document)};this.pending.set(id,payload);}
        const r=await this.post(register&&id===this.current?'api/lesson-maps/register':'api/lesson-maps',register&&id===this.current?'registerLessonCanvas':'saveLessonMap',payload);
        this.versions.set(id,r.version);this.savedJSON.set(id,JSON.stringify(r.version.document));row.document=lmClone(r.version.document);this.allVersions.push(r.version);this.pending.delete(id);
        if(r.registry){this.registry=r.registry;this.options.onRegistry(r.registry);}
      }
      this.notice=register?'Ο χάρτης καταχωρίστηκε ιδιωτικά στα μέσα του μαθήματος.':'Αποθηκεύτηκε ιδιωτικά. Μπορείς να συνεχίσεις από την ίδια ή άλλη συσκευή.';this.error=false;
    }catch(e){this.notice=e.message+' Οι αλλαγές σου παραμένουν εδώ.';this.error=true;this.conflict=/άλλη συσκευή/.test(e.message);}
    finally{this.saving=false;this.render();}
  }
  async reload(){if(this.dirty()&&!await lmForm(this.host,'Άνοιγμα τελευταίας αποθήκευσης','<p>Οι τρέχουσες αλλαγές θα αντικατασταθούν. Μπορείς πρώτα να τις κατεβάσεις ως αντίγραφο από τη μπάρα.</p>','Άνοιγμα'))return;try{const r=await this.get('api/lesson-maps','listLessonMaps');this.documents.clear();this.savedJSON.clear();this.ingest(r.versions);this.undoStack=[];this.redoStack=[];this.pending.clear();this.conflict=false;await this.initialize(this.current);}catch(e){this.notice=e.message;this.error=true;this.render();}}
  download(){const u=URL.createObjectURL(new Blob([JSON.stringify({schema_version:1,documents:[...this.documents],exported_at:new Date().toISOString()},null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=u;a.download='lesson-map-private-copy.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1000);}
  open(id,versionId=''){
    if(!this.documents.has(id)){this.notice='Ο χάρτης δεν βρέθηκε στον ιδιωτικό χώρο.';this.render();return;}
    if(versionId){const v=this.allVersions.find(v=>v.id===versionId&&v.document_id===id);if(v){this.historical=v;this.current=id;this.selected='';this.edit=false;this.documentBeforeHistorical=this.documents.get(id);this.documents.set(id,{kind:v.kind,document:lmClone(v.document)});this.render();return;}}
    this.restoreHistorical();this.current=id;this.selected='';this.connectFrom='';this.revealCount=5;history.replaceState(null,'',id===LM_WORKSPACE_ID?'#map':'#canvas/'+id);this.render();
  }
  restoreHistorical(){if(this.historical){this.documents.set(this.historical.document_id,this.documentBeforeHistorical);this.historical=null;this.documentBeforeHistorical=null;}}
  async openLesson(id){
    const lesson=this.workspace.lessons.find(l=>l.id===id);if(!lesson)return;
    if(!lesson.canvas_id){
      if(!this.privateMode){const u=this.registry.scenarios.find(s=>s.scenario_id===lesson.scenario_id)?.activities.find(a=>a.url)?.url;if(u)window.open(u,'_blank','noopener');return;}
      const cid=lmId(),doc=lmNewCanvas(lesson.title,lesson.scenario_id);
      const activities=this.registry.scenarios.find(s=>s.scenario_id===lesson.scenario_id)?.activities||[];
      doc.buildings.find(b=>b.id==='html').materials=activities.filter(a=>a.kind==='html').map(a=>this.catalogueMaterial(lesson.scenario_id,a));
      this.change(()=>{lesson.canvas_id=cid;this.documents.set(cid,{kind:'canvas',document:doc});},false);
    }
    this.open(lesson.canvas_id);
  }
  catalogueMaterial(sid,a){return {id:lmId(),label:a.label,type:'html',text:'',url:'',asset_id:'',activity_id:a.id,source_scenario_id:sid,page_start:1,page_end:1};}
  async addTheme(){const v=await lmForm(this.host,'Νέα θεματική','<label>Τίτλος<input name="title" maxlength="120" required></label><label>Σύμβολο<input name="icon" maxlength="20" value="📚"></label>','Προσθήκη');if(!v)return;const id=lmId();this.change(()=>{this.document.themes.push({id,title:v.title,icon:v.icon,box:{x:.25+this.document.themes.length*.08,y:.4,w:.32,h:.4}});this.selected=id;});}
  async addLesson(){
    const theme=this.kind==='workspace'?this.document.themes.find(t=>t.id===this.selected)||this.document.themes[0]:null;
    if(!theme){this.notice='Πρόσθεσε πρώτα μια θεματική.';this.render();return;}
    const v=await lmForm(this.host,'Προσθήκη μαθήματος',`<label>Θεματική<select name="theme_id">${this.document.themes.map(t=>`<option value="${t.id}" ${t.id===theme.id?'selected':''}>${lmEscape(t.title)}</option>`).join('')}</select></label><label>Υπάρχον μάθημα<select name="scenario_id"><option value="">Νέο πρόχειρο μάθημα</option>${this.registry.scenarios.map(s=>`<option value="${lmEscape(s.scenario_id)}">${lmEscape(s.title)}</option>`).join('')}</select></label><label>Δικός μου τίτλος <span>(προαιρετικό για υπάρχον μάθημα)</span><input name="title" maxlength="240"></label>`,'Προσθήκη');if(!v)return;
    const title=v.title.trim()||this.registry.scenarios.find(s=>s.scenario_id===v.scenario_id)?.title||'Νέο μάθημα',cid=lmId();
    this.change(()=>{this.documents.set(cid,{kind:'canvas',document:lmNewCanvas(title,v.scenario_id||null)});this.workspace.lessons.push({id:lmId(),theme_id:v.theme_id,title,scenario_id:v.scenario_id||null,canvas_id:cid});});
  }
  async linkScenario(){const v=await lmForm(this.host,'Σύνδεση με υπάρχον μάθημα',`<p>Η σύνδεση διατηρεί το υπάρχον αναγνωριστικό του μαθήματος.</p><label>Μάθημα<select name="scenario_id" required><option value="">Επιλογή…</option>${this.registry.scenarios.map(s=>`<option value="${lmEscape(s.scenario_id)}" ${s.scenario_id===this.document.scenario_id?'selected':''}>${lmEscape(s.title)}</option>`).join('')}</select></label>`,'Σύνδεση');if(v)this.change(()=>{this.document.scenario_id=v.scenario_id;for(const l of this.workspace.lessons)if(l.canvas_id===this.current)l.scenario_id=v.scenario_id;});}
  async removeSelected(){
    if(this.kind==='canvas'){this.change(()=>{const b=this.nodes.find(b=>b.id===this.selected);if(b)b.hidden=!b.hidden;});return;}
    const theme=this.nodes.find(n=>n.id===this.selected);if(!theme)return;
    const v=await lmForm(this.host,'Αφαίρεση θεματικής',`<p>Αφαίρεση της θεματικής «${lmEscape(theme.title)}» και των θέσεων μαθημάτων της από αυτόν τον χάρτη; Τα αποθηκευμένα μαθήματα διατηρούνται στον ιδιωτικό χώρο.</p>`,'Αφαίρεση');if(!v)return;
    this.change(()=>{this.document.themes=this.document.themes.filter(t=>t.id!==theme.id);this.document.lessons=this.document.lessons.filter(l=>l.theme_id!==theme.id);this.document.connections=this.document.connections.filter(c=>c.from!==theme.id&&c.to!==theme.id);this.selected='';});
  }
  async editTitle(){const target=this.selected?this.nodes.find(n=>n.id===this.selected):this.document;if(!target)return;const v=await lmForm(this.host,'Τίτλος και σύμβολο',`<label>Τίτλος<input name="title" value="${lmEscape(target.title)}" maxlength="240" required></label>${'icon'in target?`<label>Σύμβολο<input name="icon" value="${lmEscape(target.icon)}" maxlength="20"></label>`:''}`);if(v)this.change(()=>{target.title=v.title;if('icon'in target)target.icon=v.icon;});}
  async connect(id){
    if(!this.connectFrom){this.connectFrom=id;this.notice='Επίλεξε το δεύτερο στοιχείο της σύνδεσης.';this.render();return;}
    if(this.connectFrom===id){this.connectFrom='';this.render();return;}
    const from=this.connectFrom;this.connectFrom='';
    const v=await lmForm(this.host,'Νέα σχέση',`<label>Ρήμα σχέσης<input name="verb" list="lm-verbs" maxlength="100" required></label><datalist id="lm-verbs">${this.document.verbs.map(v=>`<option value="${lmEscape(v)}">`).join('')}</datalist><label>Ερμηνευτική φράση<textarea name="phrase" maxlength="600"></textarea></label>`,'Σύνδεση');
    if(v)this.change(()=>this.document.connections.push({id:lmId(),from,to:id,verb:v.verb,phrase:v.phrase,visible:true}));else this.render();
  }
  targetBuilding(type='html'){return this.document.buildings.find(b=>b.id===this.selected)||this.document.buildings.find(b=>b.id===(type==='pdf'||type==='text'?'text':type==='image'?'images':'html'));}
  async addMaterial(){
    if(this.kind!=='canvas')return;
    const d=lmModal(this.host,'Προσθήκη υλικού',`<div class="lm-import-choices"><button data-source="catalogue"><span>📚</span><strong>Από τον κατάλογο</strong><small>Υπάρχον υλικό του Πιλοτηρίου</small></button><button data-source="file"><span>📂</span><strong>Από αρχείο</strong><small>Εικόνα, PDF ή αυτοτελές HTML</small></button><button data-source="url"><span>↗</span><strong>Από σύνδεσμο</strong><small>Διεύθυνση HTTPS</small></button><button data-source="text"><span>✎</span><strong>Νέο κείμενο</strong><small>Απόσπασμα ή ερώτημα σύνθεσης</small></button></div>`);
    d.querySelectorAll('[data-source]').forEach(b=>b.onclick=()=>{const source=b.dataset.source;d.close();if(source==='file')this.host.querySelector('#lm-file').click();else void this.importForm(source);});
  }
  async importForm(source,material=null){
    if(source==='catalogue'){
      const choices=this.registry.scenarios.flatMap(s=>s.activities.filter(a=>a.url&&a.kind!=='canvas'&&a.kind!=='vr').map(a=>({s,a})));
      const v=await lmForm(this.host,'Υλικό από τον κατάλογο',`<label>Αναζήτηση στον κατάλογο<input data-catalogue-search type="search" placeholder="Γράψε τίτλο ή θέμα"></label><label>Υλικό<select name="choice" size="8" required>${choices.map(({s,a},i)=>`<option value="${i}">${lmEscape(s.title+' · '+a.label)}</option>`).join('')}</select></label><label>Οικοδόμημα<select name="building">${this.document.buildings.map(b=>`<option value="${b.id}" ${b.id===(this.selected||'html')?'selected':''}>${lmEscape(b.title)}</option>`).join('')}</select></label>`,'Προσθήκη');
      if(v){const c=choices[Number(v.choice)];if(c)this.change(()=>{this.document.buildings.find(b=>b.id===v.building).materials.push(this.catalogueMaterial(c.s.scenario_id,c.a));this.selected=v.building;});}return;
    }
    const type=material?.type||(source==='text'?'text':this.selected==='text'?'pdf':this.selected==='html'?'html':'image');
    const v=await lmForm(this.host,material?'Αλλαγή υλικού':source==='text'?'Νέο κείμενο':'Νέος σύνδεσμος',`<label>Οικοδόμημα<select name="building">${this.document.buildings.map(b=>`<option value="${b.id}" ${b.id===(this.selected||this.targetBuilding(type).id)?'selected':''}>${lmEscape(b.title)}</option>`).join('')}</select></label><label>Τίτλος<input name="label" value="${lmEscape(material?.label||'')}" maxlength="240" required></label>${source!=='text'?`<label>Τύπος<select name="type">${[['image','Εικόνα'],['pdf','PDF'],['html','HTML']].map(([id,t])=>`<option value="${id}" ${type===id?'selected':''}>${t}</option>`).join('')}</select></label><label>Διεύθυνση HTTPS<input name="url" type="url" pattern="https://.*" value="${lmEscape(material?.url||'')}" ${material?.asset_id||material?.activity_id?'':'required'}></label><div class="lm-form-row"><label>Από σελίδα PDF<input name="page_start" type="number" min="1" max="10000" value="${material?.page_start||1}"></label><label>Έως σελίδα PDF<input name="page_end" type="number" min="1" max="10000" value="${material?.page_end||1}"></label></div>`:`<label>Κείμενο προς τους μαθητές<textarea name="text" rows="9" maxlength="100000" required>${lmEscape(material?.text||'')}</textarea></label>`}`);
    if(!v)return;
    if(v.url&&!lmSafeURL(v.url)){this.notice='Χρειάζεται πλήρης σύνδεσμος HTTPS.';this.error=true;this.render();return;}
    const item={id:material?.id||lmId(),label:v.label,type:source==='text'?'text':v.type,text:v.text||'',url:v.url||'',asset_id:material?.asset_id||'',activity_id:material?.activity_id||'',source_scenario_id:material?.source_scenario_id||'',page_start:Number(v.page_start)||1,page_end:Number(v.page_end)||1};
    if(v.url&&v.url!==material?.url){item.asset_id='';item.activity_id='';item.source_scenario_id='';}
    if(item.page_end<item.page_start){this.notice='Η τελευταία σελίδα πρέπει να είναι μετά την πρώτη.';this.error=true;this.render();return;}
    this.change(()=>{if(material)for(const b of this.document.buildings)b.materials=b.materials.filter(m=>m.id!==material.id);this.document.buildings.find(b=>b.id===v.building).materials.push(item);this.selected=v.building;});
  }
  async importFile(file){
    if(!file||this.kind!=='canvas')return;
    this.notice='Μεταφόρτωση ιδιωτικού αρχείου…';this.render();
    try{const {asset,type}=await this.upload(file);const b=this.targetBuilding(type);this.change(()=>{b.materials.push({id:lmId(),label:file.name,type,text:'',url:'',asset_id:asset.id,activity_id:'',source_scenario_id:'',page_start:1,page_end:1});this.selected=b.id;});}
    catch(e){this.notice=e.message;this.error=true;this.render();}
  }
  async settings(){
    const d=this.document;
    const values=await lmForm(this.host,'Ρυθμίσεις χάρτη',`<label>Τίτλος<input name="title" value="${lmEscape(d.title)}" maxlength="240" required></label><label>Τάξη<select name="grade">${this.registry.grades.map(g=>`<option ${g===d.grade?'selected':''}>${lmEscape(g)}</option>`).join('')}</select></label><label>Ρήματα σχέσεων <span>ένα σε κάθε γραμμή</span><textarea name="verbs" rows="7">${lmEscape(d.verbs.join('\n'))}</textarea></label>${this.kind==='canvas'?`<label class="lm-check"><input name="hide_empty" type="checkbox" ${d.presentation.hide_empty?'checked':''}> Απόκρυψη κενών οικοδομημάτων στην τάξη</label>`:''}`);
    if(values)this.change(()=>{d.title=values.title;d.grade=values.grade;d.verbs=[...new Set(values.verbs.split('\n').map(v=>v.trim()).filter(Boolean))].slice(0,80);if(this.kind==='canvas')d.presentation.hide_empty=values.hide_empty==='on';});
  }
  async addSaved(){
    if(this.kind!=='workspace')return;
    const canvases=[...this.documents].filter(([,v])=>v.kind==='canvas'),themes=this.document.themes;
    if(!themes.length)return;
    const v=await lmForm(this.host,'Αποθηκευμένο μάθημα στον χάρτη',`<label>Μάθημα<select name="canvas_id">${canvases.map(([id,c])=>`<option value="${id}">${lmEscape(c.document.title)}</option>`).join('')}</select></label><label>Θεματική<select name="theme_id">${themes.map(t=>`<option value="${t.id}" ${t.id===this.selected?'selected':''}>${lmEscape(t.title)}</option>`).join('')}</select></label>`,'Προσθήκη');
    if(v)this.change(()=>{const c=this.documents.get(v.canvas_id).document;this.document.lessons.push({id:lmId(),canvas_id:v.canvas_id,scenario_id:c.scenario_id,title:c.title,theme_id:v.theme_id});});
  }
  panelMarkup(){
    const node=this.nodes.find(n=>n.id===this.selected);
    if(!node)return `<aside class="lm-inspector"><span class="lm-panel-symbol">✦</span><h2>Χτίζουμε το μάθημα</h2><p>Διάλεξε ${this.kind==='workspace'?'μια νησίδα':'ένα οικοδόμημα'} για να οργανώσεις το υλικό του.</p><p>Η λαβή ⠿ μετακινεί το στοιχείο. Η κάτω δεξιά γωνία αλλάζει το μέγεθός του.</p><button data-action="settings">Ρυθμίσεις χάρτη</button>${this.kind==='workspace'?'<button data-action="saved">Αποθηκευμένα μαθήματα</button>':''}</aside>`;
    const entries=this.kind==='workspace'?this.document.lessons.filter(l=>l.theme_id===node.id):node.materials;
    return `<aside class="lm-inspector"><div class="lm-panel-heading"><h2>${lmEscape(node.icon)} ${lmEscape(node.title)}</h2><button data-action="deselect" aria-label="Κλείσιμο επιλογής">✕</button></div><div class="lm-panel-buttons"><button data-action="title">Τίτλος / σύμβολο</button>${this.kind==='canvas'?`<button data-action="hide">${node.hidden?'Εμφάνιση στην τάξη':'Απόκρυψη στην τάξη'}</button>`:'<button data-action="remove">Αφαίρεση θεματικής</button>'}</div><h3>${this.kind==='workspace'?'Μαθήματα':'Το υλικό μου'} <small>${entries.length}</small></h3><ol class="lm-material-list">${entries.map((m,i)=>`<li><button class="lm-entry-open" data-open-entry="${m.id}">${lmEscape(m.title||m.label)}</button><div><button data-entry-up="${m.id}" ${i?'':'disabled'} aria-label="Μετακίνηση νωρίτερα">↑</button><button data-entry-down="${m.id}" ${i<entries.length-1?'':'disabled'} aria-label="Μετακίνηση αργότερα">↓</button>${this.kind==='canvas'?`<button data-edit-entry="${m.id}" aria-label="Αλλαγή υλικού">✎</button>`:''}<button data-remove-entry="${m.id}" aria-label="Αφαίρεση από τον χάρτη">✕</button></div></li>`).join('')}</ol><button class="lm-primary" data-action="${this.kind==='workspace'?'lesson':'material'}">＋ ${this.kind==='workspace'?'Προσθήκη μαθήματος':'Προσθήκη υλικού'}</button>${this.kind==='canvas'?`<h3>Σειρά αποκάλυψης</h3><ol class="lm-reveal-order">${this.document.presentation.reveal_order.map((id,i)=>`<li><span>${lmEscape(this.document.buildings.find(b=>b.id===id).title)}</span><button data-reveal-up="${id}" ${i?'':'disabled'} aria-label="Νωρίτερα στην αποκάλυψη">↑</button></li>`).join('')}</ol>`:''}<h3>Σχέσεις</h3><div class="lm-connection-list">${this.document.connections.filter(c=>c.from===node.id||c.to===node.id).map(c=>`<div><label><input type="checkbox" data-connection-visible="${c.id}" ${c.visible?'checked':''}> ${lmEscape(c.verb)}</label>${c.phrase?`<p>${lmEscape(c.phrase)}</p>`:''}<button data-edit-connection="${c.id}">Αλλαγή</button><button data-remove-connection="${c.id}" aria-label="Αφαίρεση σχέσης">✕</button></div>`).join('')||'<p>Επίλεξε «Σύνδεση» και δύο στοιχεία στον χάρτη.</p>'}</div></aside>`;
  }
  worldMarkup(){
    const workspace=this.kind==='workspace',nodes=this.nodes,doc=this.document;
    const visible=n=>this.edit||workspace||(!n.hidden&&(!doc.presentation.hide_empty||n.materials.length||n.id==='synthesis'&&doc.connections.length));
    const allowed=workspace?new Set(nodes.map(n=>n.id)):new Set(doc.presentation.reveal_order.slice(0,this.revealCount));
    const connections=this.showConnections?doc.connections.filter(c=>c.visible&&nodes.some(n=>n.id===c.from&&visible(n)&&allowed.has(n.id))&&nodes.some(n=>n.id===c.to&&visible(n)&&allowed.has(n.id))):[];
    const placedLabels=[];
    const paths=connections.map(c=>{const a=nodes.find(n=>n.id===c.from),b=nodes.find(n=>n.id===c.to),p=lmCurve(a.box,b.box),label=lmConnectionLabel(p,nodes.map(n=>n.box),placedLabels);return `<g data-connection="${c.id}"><path d="${p.d}"/><foreignObject x="${label.x-140}" y="${label.y-26}" width="280" height="90"><button xmlns="http://www.w3.org/1999/xhtml" class="lm-thread-label" data-explain="${c.id}">${lmEscape(c.verb)}</button></foreignObject></g>`;}).join('');
    const deco=workspace?'<div class="lm-sea-decor lm-sea-a">⛵</div><div class="lm-sea-decor lm-sea-b">✧</div>':`<div class="lm-plaza"><span>✦</span><h2>${lmEscape(doc.title)}</h2><small>Πολιτεία γνώσης</small></div><svg class="lm-city-paths" viewBox="0 0 1600 900" aria-hidden="true"><path d="M800 180 Q800 450 1320 420 M800 450 Q600 480 260 420 M800 450 Q800 550 1120 750 M800 450 Q600 600 500 750"/></svg>`;
    return `${deco}<svg class="lm-threads" viewBox="0 0 1600 900" aria-label="Σχέσεις εννοιών">${paths}</svg>${nodes.filter(visible).map(n=>{
      const b=n.box,selected=this.selected===n.id||this.connectFrom===n.id,unrevealed=!this.edit&&!allowed.has(n.id);
      const content=workspace?this.document.lessons.filter(l=>l.theme_id===n.id):n.materials;
      const sprite=workspace?'island':LM_BUILDINGS.find(d=>d.id===n.id).sprite;
      return `<section class="lm-node ${workspace?'lm-island':'lm-building'} ${selected?'lm-selected':''} ${unrevealed?'lm-unrevealed':''} ${n.hidden?'lm-hidden-building':''}" data-lm-node="${n.id}" style="left:${b.x*1600}px;top:${b.y*900}px;width:${b.w*1600}px;height:${b.h*900}px" aria-label="${lmEscape(n.title)}"><img class="lm-sprite" src="${lmEscape(this.assetURL('assets/lesson-map/'+sprite+'.webp'))}" alt="" draggable="false"><div class="lm-node-content"><button class="lm-node-title" data-node-select="${n.id}"><span>${lmEscape(n.icon)}</span>${lmEscape(n.title)}</button>${unrevealed?'<div class="lm-unrevealed-label">✦</div>':workspace?`<div class="lm-island-lessons">${content.map(l=>`<button data-open-lesson="${l.id}">${lmEscape(l.title)} <span>↗</span></button>`).join('')||'<span class="lm-island-empty">Μια νέα ενότητα αρχίζει εδώ</span>'}</div>`:`<button class="lm-building-open" data-open-building="${n.id}">${content.length?`${content.length} ${content.length===1?'μέσο':'μέσα'} · Άνοιγμα`:(n.id==='synthesis'&&doc.connections.length?'Οι σχέσεις μας · Άνοιγμα':this.edit?'＋ Προσθήκη υλικού':'Άνοιγμα')}</button>`}</div>${this.edit?`<button class="lm-drag" data-drag-node="${n.id}" aria-label="Μετακίνηση: ${lmEscape(n.title)}">⠿</button><button class="lm-resize" data-resize-node="${n.id}" aria-label="Αλλαγή μεγέθους: ${lmEscape(n.title)}">↘</button>`:''}</section>`;
    }).join('')}`;
  }
  render(){
    if(!this.document)return;
    const workspace=this.kind==='workspace',registered=this.document.registered,version=this.versions.get(this.current);
    this.host.className=`lesson-map ${workspace?'lm-archipelago':'lm-city'} ${this.edit?'lm-edit':'lm-class'}`;
    this.host.innerHTML=`<header class="lm-header"><button class="lm-brand" data-action="exit"><span>📖</span><div><strong>Χάρτης Μαθήματος</strong><small>Νησίδες και πολιτεία γνώσης</small></div></button><div class="lm-context"><span>${lmEscape(this.document.grade)}</span><span class="lm-privacy">${this.privateMode?'Ιδιωτικός χώρος':'Δείγμα χάρτη'}</span></div><div class="lm-header-actions">${this.privateMode?`<button data-action="mode" class="${!this.edit?'lm-primary':''}">${this.edit?'▷ Προβολή τάξης':'✎ Επεξεργασία'}</button>`:`<a href="${lmEscape(this.registry.publication?.cloud_url||'#')}?view=map" target="_top">Στον ιδιωτικό χώρο ↗</a>`}<button data-action="fullscreen" aria-label="Πλήρης οθόνη">⛶</button></div></header><nav class="lm-breadcrumb" aria-label="Επίπεδα χάρτη"><button data-action="home" ${workspace?'aria-current="page"':''}>1 · Θεματικές ενότητες</button>${workspace?'<span>Χτίζουμε τις ενότητες σιγά σιγά</span>':`<span>›</span><strong>2 · ${lmEscape(this.document.title)}</strong>`}${this.historical?'<span class="lm-version-badge">Παλαιότερη αποθηκευμένη έκδοση</span>':''}</nav>${this.edit?`<div class="lm-toolbar" role="toolbar" aria-label="Επεξεργασία χάρτη">${workspace?'<button data-action="theme">＋ Θεματική</button><button data-action="lesson">＋ Μάθημα</button>':'<button class="lm-primary" data-action="material">＋ Υλικό</button>'}<span class="lm-separator"></span><button data-tool="select" aria-pressed="${this.tool==='select'}">↖ Επιλογή</button><button data-tool="connect" aria-pressed="${this.tool==='connect'}">🔗 Σύνδεση</button><button data-action="title">✎ Τίτλος</button><button data-action="undo" ${this.undoStack.length?'':'disabled'} aria-label="Αναίρεση">↶</button><button data-action="redo" ${this.redoStack.length?'':'disabled'} aria-label="Επανάληψη">↷</button><button data-action="settings" aria-label="Ρυθμίσεις">⚙</button><span class="lm-toolbar-spacer"></span><button data-action="import">↑ Μεταφορά μαθήματος</button><button data-action="download" title="Ιδιωτικό αντίγραφο διάταξης· τα αρχεία φυλάσσονται χωριστά">↓ Αντίγραφο</button><button data-action="save" class="lm-save" ${this.saving?'disabled':''}>${this.saving?'Αποθήκευση…':'✓ Αποθήκευση πρόχειρου'}</button>${workspace?'':`<button data-action="register" ${this.saving?'disabled':''}>${registered?'✓ Καταχωρισμένο':'Καταχώριση στο Πιλοτήριο'}</button>`}</div>`:`<div class="lm-presentation-tools"><button data-action="fit">Προβολή όλων</button><button data-action="connections">${this.showConnections?'Απόκρυψη':'Εμφάνιση'} σχέσεων</button>${workspace?'':`<button data-action="reveal-start">Σταδιακή αποκάλυψη</button><button data-action="reveal-next" ${this.revealCount>=5?'disabled':''}>Επόμενο οικοδόμημα →</button><button data-tool="connect" aria-pressed="${this.tool==='connect'}">🔗 Σύνδεση εννοιών</button>`}</div>`}<div class="lm-status ${this.error?'lm-error':''}" role="status">${lmEscape(!this.edit&&this.privateMode?(this.tool==='connect'?this.notice:workspace?'Επίλεξε ένα μάθημα για να ανοίξεις την πολιτεία γνώσης.':'Επίλεξε ένα οικοδόμημα για να ανοίξεις το υλικό του.'):this.notice||(!this.privateMode?'Το δείγμα ανοίγει χωρίς ιδιωτικό υλικό. Στον χώρο εκπαιδευτικού προσθέτεις και αποθηκεύεις τα δικά σου μέσα.':this.dirty()?'Πρόχειρος χάρτης · αποθήκευσε όταν είσαι έτοιμος.':'✓ Αποθηκευμένο στον ιδιωτικό χώρο.'))}${this.conflict?'<button data-action="reload">Άνοιγμα τελευταίας έκδοσης</button>':''}</div><div class="lm-main"><div class="lm-viewport" tabindex="0" aria-label="Καμβάς: μετακίνηση, μεγέθυνση και επιλογή στοιχείων"><div class="lm-world">${this.worldMarkup()}</div><div class="lm-zoom-controls"><button data-action="zoom-in" aria-label="Μεγέθυνση χάρτη">＋</button><button data-action="zoom-out" aria-label="Σμίκρυνση χάρτη">−</button><button data-action="fit" aria-label="Προβολή όλου του χάρτη">⌂</button></div><span class="lm-canvas-caption">${workspace?'Θεματικές νησίδες':'Πέντε οικοδομήματα · μία διαδρομή γνώσης'}</span></div>${this.edit?this.panelMarkup():''}</div><nav class="lm-quick-nav" aria-label="Γρήγορη επιλογή ${workspace?'θεματικών':'οικοδομημάτων'}">${this.nodes.map(n=>`<button data-quick="${n.id}">${lmEscape(n.icon)} ${lmEscape(n.title)}</button>`).join('')}</nav>${!workspace&&this.privateMode&&this.edit&&version?'<div class="lm-after-lesson"><button data-action="review">Τι έγινε στην τάξη · Αποτίμηση χάρτη →</button></div>':''}<input type="file" id="lm-transfer-file" accept="application/json,.json" hidden><input type="file" id="lm-file" accept="image/png,image/jpeg,image/webp,application/pdf,text/html,.html,.htm" hidden>`;
    this.bind();this.bindPointer();
    const viewport=this.host.querySelector('.lm-viewport');
    if(!this.views.has(this.current))this.views.set(this.current,lmFit(this.nodes.map(n=>n.box),viewport.clientWidth,viewport.clientHeight));
    this.applyView();
    this.resizeObserver?.disconnect();this.resizeObserver=new ResizeObserver(()=>this.applyView());this.resizeObserver.observe(viewport);
    this.host.querySelector('[data-catalogue-search]')?.focus();
  }
  applyView(){const v=this.views.get(this.current),world=this.host.querySelector('.lm-world');if(v&&world)world.style.transform=`translate(${v.x}px,${v.y}px) scale(${v.zoom})`;}
  fit(){const vp=this.host.querySelector('.lm-viewport');this.views.set(this.current,lmFit(this.nodes.map(n=>n.box),vp.clientWidth,vp.clientHeight));this.applyView();}
  zoom(factor,cx,cy){const vp=this.host.querySelector('.lm-viewport');this.views.set(this.current,lmZoom(this.views.get(this.current),factor,cx??vp.clientWidth/2,cy??vp.clientHeight/2));this.applyView();}
  async building(id){
    const b=this.document.buildings.find(b=>b.id===id);this.selected=id;
    if(this.edit&&!b.materials.length&&!(id==='synthesis'&&this.document.connections.length)){this.render();await this.addMaterial();return;}
    if(id==='synthesis'&&this.document.connections.length){const rows=this.document.connections.filter(c=>c.visible),label=id=>this.nodes.find(n=>n.id===id)?.title||id;const d=lmModal(this.host,b.title,`<div class="lm-synthesis">${rows.map((c,i)=>`<article data-synthesis-step="${i}" ${!this.edit&&i?'hidden':''}><p><strong>${lmEscape(label(c.from))}</strong><em>${lmEscape(c.verb)}</em><strong>${lmEscape(label(c.to))}</strong></p>${c.phrase?`<div>${lmEscape(c.phrase)}</div>`:''}</article>`).join('')}<button data-synthesis-next>Επόμενη σχέση →</button>${b.materials.length?'<button data-synthesis-material>Κείμενα και εικόνες σύνθεσης</button>':''}</div>`,{wide:true});let next=1;d.querySelector('[data-synthesis-next]').onclick=e=>{const step=d.querySelector(`[data-synthesis-step="${next++}"]`);if(step)step.hidden=false;if(next>=rows.length)e.target.disabled=true;};d.querySelector('[data-synthesis-material]')?.addEventListener('click',()=>{d.close();void lmShowViewer(this,b);});return;}
    await lmShowViewer(this,b);
  }
  bind(){
    this.host.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>void this.action(b.dataset.action));
    this.host.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>{this.tool=b.dataset.tool;this.connectFrom='';this.notice=this.tool==='connect'?'Πάτησε δύο στοιχεία για να περιγράψεις τη σχέση τους.':'';this.render();});
    this.host.querySelectorAll('[data-node-select]').forEach(b=>b.onclick=()=>{if(this.tool==='connect')void this.connect(b.dataset.nodeSelect);else if(this.edit){this.selected=b.dataset.nodeSelect;this.render();}else if(this.kind==='canvas')void this.building(b.dataset.nodeSelect);});
    this.host.querySelectorAll('[data-open-building]').forEach(b=>b.onclick=()=>{if(this.tool==='connect')void this.connect(b.dataset.openBuilding);else void this.building(b.dataset.openBuilding);});
    this.host.querySelectorAll('[data-open-lesson]').forEach(b=>b.onclick=()=>{if(this.tool==='connect'){const l=this.workspace.lessons.find(l=>l.id===b.dataset.openLesson);void this.connect(l.theme_id);}else void this.openLesson(b.dataset.openLesson);});
    this.host.querySelectorAll('[data-quick]').forEach(b=>b.onclick=()=>{if(this.tool==='connect')void this.connect(b.dataset.quick);else if(this.kind==='canvas')void this.building(b.dataset.quick);else{this.selected=b.dataset.quick;this.render();const node=this.nodes.find(n=>n.id===this.selected),vp=this.host.querySelector('.lm-viewport');const zoom=Math.min(1.3,vp.clientWidth/(node.box.w*1600+80));this.views.set(this.current,{zoom,x:vp.clientWidth/2-(node.box.x+node.box.w/2)*1600*zoom,y:vp.clientHeight/2-(node.box.y+node.box.h/2)*900*zoom});this.applyView();}});
    this.host.querySelectorAll('[data-explain]').forEach(b=>b.onclick=()=>{const c=this.document.connections.find(c=>c.id===b.dataset.explain);lmModal(this.host,c.verb,`<p class="lm-relation-phrase">${lmEscape(c.phrase||'Παρατήρησε τα δύο συνδεδεμένα στοιχεία και εξήγησε τη σχέση τους.')}</p>`);});
    this.host.querySelector('#lm-transfer-file').onchange=e=>void this.importTransfer(e.target.files[0]);
    this.host.querySelector('#lm-file').onchange=e=>void this.importFile(e.target.files[0]);
    this.host.querySelectorAll('[data-open-entry]').forEach(b=>b.onclick=()=>{if(this.kind==='workspace')void this.openLesson(b.dataset.openEntry);else{const building=this.nodes.find(b=>b.id===this.selected);void lmShowViewer(this,building,building.materials.findIndex(m=>m.id===b.dataset.openEntry));}});
    this.host.querySelectorAll('[data-remove-entry]').forEach(b=>b.onclick=()=>this.change(()=>{if(this.kind==='workspace')this.document.lessons=this.document.lessons.filter(l=>l.id!==b.dataset.removeEntry);else{this.nodes.find(n=>n.id===this.selected).materials=this.nodes.find(n=>n.id===this.selected).materials.filter(m=>m.id!==b.dataset.removeEntry);this.document.annotations=this.document.annotations.filter(a=>a.material_id!==b.dataset.removeEntry);}}));
    this.host.querySelectorAll('[data-entry-up],[data-entry-down]').forEach(b=>b.onclick=()=>this.change(()=>{const id=b.dataset.entryUp||b.dataset.entryDown,arr=this.kind==='workspace'?this.document.lessons:this.nodes.find(n=>n.id===this.selected).materials,i=arr.findIndex(m=>m.id===id),j=i+(b.dataset.entryUp?-1:1);if(j>=0&&j<arr.length)[arr[i],arr[j]]=[arr[j],arr[i]];}));
    this.host.querySelectorAll('[data-edit-entry]').forEach(b=>b.onclick=()=>{const m=this.nodes.find(n=>n.id===this.selected).materials.find(m=>m.id===b.dataset.editEntry);void this.importForm(m.type==='text'?'text':'url',m);});
    this.host.querySelectorAll('[data-reveal-up]').forEach(b=>b.onclick=()=>this.change(()=>{const a=this.document.presentation.reveal_order,i=a.indexOf(b.dataset.revealUp);if(i>0)[a[i-1],a[i]]=[a[i],a[i-1]];}));
    this.host.querySelectorAll('[data-connection-visible]').forEach(b=>b.onchange=()=>this.change(()=>{this.document.connections.find(c=>c.id===b.dataset.connectionVisible).visible=b.checked;}));
    this.host.querySelectorAll('[data-remove-connection]').forEach(b=>b.onclick=()=>this.change(()=>{this.document.connections=this.document.connections.filter(c=>c.id!==b.dataset.removeConnection);}));
    this.host.querySelectorAll('[data-edit-connection]').forEach(b=>b.onclick=async()=>{const c=this.document.connections.find(c=>c.id===b.dataset.editConnection);const v=await lmForm(this.host,'Αλλαγή σχέσης',`<label>Ρήμα<input name="verb" value="${lmEscape(c.verb)}" maxlength="100" required></label><label>Φράση<textarea name="phrase" maxlength="600">${lmEscape(c.phrase)}</textarea></label>`);if(v)this.change(()=>{c.verb=v.verb;c.phrase=v.phrase;});});
    this.host.oninput=e=>{if(!e.target.matches('[data-catalogue-search]'))return;const q=e.target.value.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();e.target.closest('form').querySelectorAll('select[name="choice"] option').forEach(o=>{o.hidden=!o.textContent.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().includes(q);});};
    if(this.saving)this.host.querySelectorAll('.lm-toolbar button,.lm-inspector button').forEach(b=>b.disabled=true);
  }
  async action(action){
    if(action==='exit'){if(this.dirty()&&!await lmForm(this.host,'Επιστροφή στο Πιλοτήριο','<p>Υπάρχουν αλλαγές προς αποθήκευση. Θα παραμείνουν διαθέσιμες όσο μένεις σε αυτή τη συνεδρία χάρτη. Αποθήκευσε πρώτα για να τις ξανανοίξεις αργότερα.</p>','Έξοδος χωρίς αποθήκευση'))return;this.restoreHistorical();this.options.onExit();return;}
    if(action==='home'){this.open(LM_WORKSPACE_ID);return;}
    if(action==='mode'){this.restoreHistorical();this.edit=!this.edit;this.selected='';this.tool='select';this.revealCount=5;this.render();this.fit();return;}
    if(action==='import')return this.chooseTransfer();
    if(action==='save')return this.save();if(action==='register')return this.save(true);
    if(action==='theme')return this.addTheme();if(action==='lesson')return this.addLesson();if(action==='material')return this.addMaterial();
    if(action==='title')return this.editTitle();if(action==='settings')return this.settings();if(action==='remove'||action==='hide')return this.removeSelected();
    if(action==='undo')return this.undo();if(action==='redo')return this.undo(true);if(action==='download')return this.download();if(action==='reload')return this.reload();if(action==='saved')return this.addSaved();
    if(action==='deselect'){this.selected='';this.render();return;}
    if(action==='zoom-in')return this.zoom(1.25);if(action==='zoom-out')return this.zoom(1/1.25);if(action==='fit')return this.fit();
    if(action==='connections'){this.showConnections=!this.showConnections;this.render();return;}
    if(action==='reveal-start'){this.revealCount=0;this.render();return;}
    if(action==='reveal-next'){this.revealCount=Math.min(5,this.revealCount+1);this.render();return;}
    if(action==='fullscreen'){try{if(document.fullscreenElement)await document.exitFullscreen();else await this.host.requestFullscreen();}catch{this.notice='Ο χάρτης προσαρμόζεται ήδη στο διαθέσιμο παράθυρο.';this.render();}return;}
    if(action==='review'){if(this.dirty()){await this.save();if(this.error)return;}const row=this.versions.get(this.current);if(!row?.document.scenario_id){await this.linkScenario();return;}this.options.onReview(row);}
  }
  bindPointer(){
    const vp=this.host.querySelector('.lm-viewport');let pointers=new Map(),g=null;
    vp.addEventListener('wheel',e=>{e.preventDefault();const r=vp.getBoundingClientRect();this.zoom(Math.exp(-e.deltaY*.0015),e.clientX-r.left,e.clientY-r.top);},{passive:false});
    vp.addEventListener('pointerdown',e=>{
      if(e.target.closest('.lm-zoom-controls'))return;
      const handle=e.target.closest('[data-drag-node],[data-resize-node]');
      if(e.target.closest('button,a,input')&&!handle)return;
      if(this.saving||this.tool==='connect')return;
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});vp.setPointerCapture(e.pointerId);
      if(pointers.size===2){const [a,b]=[...pointers.values()],r=vp.getBoundingClientRect();g={type:'pinch',distance:Math.hypot(b.x-a.x,b.y-a.y),view:{...this.views.get(this.current)},cx:(a.x+b.x)/2-r.left,cy:(a.y+b.y)/2-r.top};return;}
      const id=handle?.dataset.dragNode||handle?.dataset.resizeNode;
      if(handle&&this.edit){e.preventDefault();const n=this.nodes.find(n=>n.id===id);this.selected=id;g={type:handle.dataset.resizeNode?'resize':'node',id,node:n,box:{...n.box},x:e.clientX,y:e.clientY,before:this.snapshot()};}
      else g={type:'pan',x:e.clientX,y:e.clientY,view:{...this.views.get(this.current)}};
    });
    vp.addEventListener('pointermove',e=>{
      if(!pointers.has(e.pointerId)||!g)return;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(g.type==='pinch'&&pointers.size===2){const [a,b]=[...pointers.values()],r=vp.getBoundingClientRect(),factor=Math.hypot(b.x-a.x,b.y-a.y)/Math.max(1,g.distance),v=lmZoom(g.view,factor,g.cx,g.cy);v.x+=(a.x+b.x)/2-r.left-g.cx;v.y+=(a.y+b.y)/2-r.top-g.cy;this.views.set(this.current,v);this.applyView();return;}
      if(g.type==='pan'){this.views.set(this.current,{...g.view,x:g.view.x+e.clientX-g.x,y:g.view.y+e.clientY-g.y});this.applyView();return;}
      if(g.type==='node'||g.type==='resize'){
        const view=this.views.get(this.current),dx=(e.clientX-g.x)/view.zoom/1600,dy=(e.clientY-g.y)/view.zoom/900;
        g.node.box=g.type==='node'?{...g.box,x:lmClamp(g.box.x+dx,-5,5),y:lmClamp(g.box.y+dy,-5,5)}:{...g.box,w:lmClamp(g.box.w+dx,.15,1.5),h:lmClamp(g.box.h+dy,.18,1.5)};
        const n=this.host.querySelector(`[data-lm-node="${g.id}"]`),b=g.node.box;n.style.left=b.x*1600+'px';n.style.top=b.y*900+'px';n.style.width=b.w*1600+'px';n.style.height=b.h*900+'px';
        const placed=[];
        this.host.querySelectorAll('[data-connection]').forEach(el=>{const c=this.document.connections.find(c=>c.id===el.dataset.connection),p=lmCurve(this.nodes.find(n=>n.id===c.from).box,this.nodes.find(n=>n.id===c.to).box),label=lmConnectionLabel(p,this.nodes.map(n=>n.box),placed);el.querySelector('path').setAttribute('d',p.d);el.querySelector('foreignObject').setAttribute('x',label.x-140);el.querySelector('foreignObject').setAttribute('y',label.y-26);});
      }
    });
    const end=e=>{pointers.delete(e.pointerId);if(!g)return;if(g.type==='node'||g.type==='resize'){this.undoStack.push(g.before);this.redoStack=[];this.pending.clear();this.notice='Η διάταξη άλλαξε.';g=null;this.render();return;}if(pointers.size===0)g=null;else{const p=[...pointers.values()][0];g={type:'pan',x:p.x,y:p.y,view:{...this.views.get(this.current)}};}};
    vp.addEventListener('pointerup',end);
    vp.addEventListener('pointercancel',e=>{if(g?.before)this.documents=new Map(JSON.parse(g.before));pointers.clear();g=null;this.render();});
  }
  destroy(){this.abort.abort();this.resizeObserver?.disconnect();this.host.querySelectorAll('dialog').forEach(d=>d.remove());for(const u of this.objectURLs)URL.revokeObjectURL(u);this.blobs.clear();}
}
