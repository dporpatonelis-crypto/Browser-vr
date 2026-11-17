import {LM_WORKSPACE_ID,lmEscape,lmClone,lmId,lmCanvasReady} from './lesson-map-domain.mjs';
import {lmForm,lmModal,lmShowViewer} from './lesson-map-viewers.mjs';

export const LM_STYLES={
  default:{title:'Νησίδες γνώσης',folder:''},
  jerusalem:{title:'Ιεροσόλυμα',folder:'jerusalem/'},
  mediterranean:{title:'Μεσόγειος',folder:'mediterranean/'}
};
export function lmRoute(workspaceId=LM_WORKSPACE_ID,canvasId='',versionId=''){
  const base=workspaceId===LM_WORKSPACE_ID?'#map':'#map/'+workspaceId;
  return canvasId?(workspaceId===LM_WORKSPACE_ID?'#canvas/'+canvasId:base+'/canvas/'+canvasId)+(versionId?'/'+versionId:''):base;
}
export function lmParseRoute(hash){
  const m=hash.match(/^#map(?:\/([0-9a-f-]{36})(?:\/canvas\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?)?)?$/i);
  if(m)return {workspaceId:m[1]||LM_WORKSPACE_ID,canvasId:m[2]||'',versionId:m[3]||''};
  const c=hash.match(/^#canvas\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?$/i);
  return c?{workspaceId:'',canvasId:c[1],versionId:c[2]||''}:null;
}
export function lmWorkspaces(documents){return [...documents].filter(([,r])=>r.kind==='workspace').map(([id,r])=>({id,...r.document}));}
export function lmMemberships(documents,canvasId){return lmWorkspaces(documents).flatMap(w=>w.lessons.filter(l=>l.canvas_id===canvasId).map(l=>({workspace_id:w.id,title:w.title,grade:w.grade,placement_id:l.id})));}
export function lmActivity(material,registry){return registry.scenarios.find(s=>s.scenario_id===material.source_scenario_id)?.activities.find(a=>a.id===material.activity_id);}
export function lmMaterialIdentities(m,registry,metadata={}){
  const a=lmActivity(m,registry),unit=a?.native_id||'',span=m.type==='pdf'?`:${m.page_start||1}-${m.page_end||1}`:'';
  const variant=m.provenance?.page||m.provenance?.variant?`:${m.provenance.page||''}:${m.provenance.variant||''}`:'';
  const keys=[];
  // Units in an aggregate HTML stay distinct even when they share a physical file.
  const suffix=':unit:'+unit+span;
  if(m.asset_id){keys.push('asset:'+m.asset_id+suffix);if(metadata[m.asset_id]?.sha256)keys.push('sha256:'+metadata[m.asset_id].sha256+suffix);}
  const drive=m.provenance?.drive_id||a?.drive_id||m.url?.match(/drive\.google\.com\/file\/d\/([\w-]+)/)?.[1];
  if(drive)keys.push('drive:'+drive+variant+suffix);
  if(m.activity_id)keys.push('activity:'+m.activity_id+span);
  if(m.url&&!drive)keys.push('url:'+m.url+span);
  return keys;
}
export function lmAtlasIndex(documents,registry,metadata={}){
  const workspaces=lmWorkspaces(documents),canvases=[...documents].filter(([,r])=>r.kind==='canvas').map(([id,r])=>({id,...r.document,memberships:lmMemberships(documents,id)}));
  const byKey=new Map();
  for(const c of canvases)for(const b of c.buildings)for(const m of b.materials){
    const use={canvas_id:c.id,material_id:m.id,building_id:b.id,label:m.label};
    for(const key of lmMaterialIdentities(m,registry,metadata)){if(!byKey.has(key))byKey.set(key,[]);byKey.get(key).push(use);}
  }
  const shared=[],seen=new Set();
  for(const [key,uses] of byKey){if(new Set(uses.map(u=>u.canvas_id)).size<2)continue;const signature=uses.map(u=>u.canvas_id+':'+u.material_id).sort().join('|');if(seen.has(signature))continue;seen.add(signature);shared.push({key,uses});}
  const relations=workspaces.flatMap(w=>(w.lesson_relations||[]).map(r=>({...r,workspace_id:w.id}))).filter((r,i,all)=>all.findIndex(x=>x.id===r.id)===i);
  return {workspaces,canvases,shared,relations};
}

export async function lmOpenAtlas(owner,initial=''){
  if(!owner.privateMode||!owner.edit)return;
  let focus=initial||owner.atlasFocus||'',query=owner.atlasQuery||'',onlyShared=owner.atlasOnlyShared||false;
  const dialog=lmModal(owner.host,'Συνδέσεις και κοινό υλικό','',{wide:true});dialog.classList.add('lm-atlas');
  const body=dialog.querySelector('.lm-dialog-body');
  const redraw=()=>{
    const index=lmAtlasIndex(owner.documents,owner.registry,owner.assetMetadata),chosen=index.canvases.find(c=>c.id===focus);
    const common=index.shared.filter(s=>s.uses.some(u=>u.canvas_id===focus));
    const related=index.relations.filter(r=>r.status!=='dismissed'&&(r.from_canvas_id===focus||r.to_canvas_id===focus));
    const connected=new Set([focus,...common.flatMap(s=>s.uses.map(u=>u.canvas_id)),...(!onlyShared?related.flatMap(r=>[r.from_canvas_id,r.to_canvas_id]):[])]);
    const names=id=>index.canvases.find(c=>c.id===id)?.title||'Αποθηκευμένο μάθημα';
    const found=c=>!query||c.title.toLocaleLowerCase('el').includes(query.toLocaleLowerCase('el'));
    body.innerHTML=`<p class="lm-atlas-help">Ιδιωτικό εργαλείο εκπαιδευτικού · Επίλεξε μάθημα για να δεις πού χρησιμοποιείται και τι συνδέεται μαζί του.</p><div class="lm-atlas-filters"><label>Αναζήτηση μαθήματος<input type="search" data-atlas-search value="${lmEscape(query)}"></label><label class="lm-check"><input type="checkbox" data-atlas-shared ${onlyShared?'checked':''}> Μόνο κοινό μάθημα / αρχείο</label><button data-atlas-all>Όλα τα μαθήματα</button><button data-atlas-new>＋ Διδακτική σύνδεση</button><button data-atlas-save>Αποθήκευση αλλαγών</button></div><div class="lm-atlas-legend"><span class="lm-link-same">━ Ίδιο μάθημα</span><span class="lm-link-file">━ Ίδιο αρχείο</span><span class="lm-link-relation">┄ Πρόταση διδακτικής σύνδεσης</span></div><div class="lm-atlas-maps">${index.workspaces.map(w=>`<section><h3>${lmEscape(w.grade)}<small>${lmEscape(w.title)}</small></h3>${w.lessons.filter(l=>{const c=index.canvases.find(c=>c.id===l.canvas_id);return c&&lmCanvasReady(c,owner.registry)&&found(c)&&(!focus||query||connected.has(c.id));}).map(l=>{const c=index.canvases.find(c=>c.id===l.canvas_id),same=c.memberships.length>1;return `<button class="lm-atlas-city ${c.id===focus?'active':''}" data-atlas-focus="${c.id}"><strong>${lmEscape(c.title)}</strong>${same?`<small class="lm-link-same">Ίδιο μάθημα · ${c.memberships.length} χάρτες</small>`:''}${common.some(s=>s.uses.some(u=>u.canvas_id===c.id))?'<small class="lm-link-file">Ίδιο αρχείο</small>':''}</button><button class="lm-atlas-open" data-atlas-open="${c.id}" data-map="${w.id}">Άνοιγμα πόλης ↗</button>`;}).join('')||'<p>Δεν υπάρχει σχετικό μάθημα στην επιλογή.</p>'}</section>`).join('')}</div>${chosen?`<section class="lm-atlas-detail"><h3>${lmEscape(chosen.title)}</h3><p>${chosen.memberships.length?`Ένα μάθημα σε ${chosen.memberships.length} χάρτ${chosen.memberships.length===1?'η':'ες'}: ${chosen.memberships.map(m=>lmEscape(m.grade+' · '+m.title)).join(' · ')}`:'Αποθηκευμένο πρόχειρο χωρίς τοποθέτηση.'}</p><h4>Το υλικό του μαθήματος</h4>${chosen.buildings.flatMap(b=>b.materials.map(m=>{const group=common.find(s=>s.uses.some(u=>u.material_id===m.id&&u.canvas_id===focus));return `<article class="lm-atlas-material"><strong>${lmEscape(m.label)}</strong><small>${lmEscape(b.title)}${m.provenance?' · '+lmEscape(m.provenance.name):''}${group?' · Ίδιο αρχείο στα: '+lmEscape([...new Set(group.uses.map(u=>names(u.canvas_id)))].join(' · ')):''}</small><button data-atlas-material="${m.id}">Προβολή</button><button data-atlas-reuse="${m.id}">Χρήση σε άλλο μάθημα</button></article>`;})).join('')||'<p>Χωρίς υλικό.</p>'}${!onlyShared?`<h4>Διδακτικές συνδέσεις</h4>${related.map(r=>`<article class="lm-atlas-relation ${r.status}"><p><strong>${lmEscape(names(r.from_canvas_id))}</strong> — ${lmEscape(r.verb)} → <strong>${lmEscape(names(r.to_canvas_id))}</strong></p><span>${r.status==='confirmed'?'Επιβεβαιωμένη σύνδεση':'Πρόταση προς έλεγχο'}</span><p>${lmEscape(r.phrase)}</p><p>${lmEscape(r.evidence||'')}</p>${(r.evidence_refs||[]).map((ref,i)=>`<button data-atlas-evidence="${r.id}" data-ref="${i}">Πηγή ${i+1}</button>`).join('')}<button data-atlas-edit="${r.id}">Επεξεργασία</button><button data-atlas-confirm="${r.id}">${r.status==='confirmed'?'Ως πρόταση':'Επιβεβαίωση'}</button><button data-atlas-dismiss="${r.id}">Απόρριψη</button></article>`).join('')||'<p>Δεν έχει καταχωριστεί διδακτική σύνδεση.</p>'}`:''}</section>`:''}`;
    body.querySelector('[data-atlas-search]').oninput=e=>{query=e.target.value;owner.atlasQuery=query;redraw();const input=body.querySelector('[data-atlas-search]');input.focus();input.setSelectionRange(query.length,query.length);};
    body.querySelector('[data-atlas-all]').onclick=()=>{focus='';query='';owner.atlasFocus='';owner.atlasQuery='';redraw();};
    body.querySelector('[data-atlas-save]').onclick=async()=>{dialog.close();await owner.save();if(!owner.error)await lmOpenAtlas(owner,focus);};
    body.querySelector('[data-atlas-shared]').onchange=e=>{onlyShared=e.target.checked;owner.atlasOnlyShared=onlyShared;redraw();};
    body.querySelectorAll('[data-atlas-focus]').forEach(b=>b.onclick=()=>{focus=b.dataset.atlasFocus;owner.atlasFocus=focus;query='';redraw();});
    body.querySelectorAll('[data-atlas-open]').forEach(b=>b.onclick=()=>{dialog.close();owner.open(b.dataset.atlasOpen,'',b.dataset.map);});
    const preview=async(cid,mid)=>{let c=owner.documents.get(cid)?.document;if(!c?.buildings.some(b=>b.materials.some(m=>m.id===mid)))c=[...owner.allVersions].reverse().find(r=>r.document_id===cid&&r.kind==='canvas'&&r.document.buildings.some(b=>b.materials.some(m=>m.id===mid)))?.document;const b=c?.buildings.find(b=>b.materials.some(m=>m.id===mid));if(!b)return;const viewer=Object.create(owner);viewer.current=cid;viewer.documents=new Map(owner.documents);const historical=c!==owner.documents.get(cid)?.document;viewer.documents.set(cid,{kind:'canvas',document:historical?lmClone(c):c});viewer.readOnly=historical;viewer.change=historical?()=>{}:fn=>owner.change(fn,false);viewer.render=()=>{};await lmShowViewer(viewer,{...b,materials:[b.materials.find(m=>m.id===mid)]});};
    body.querySelectorAll('[data-atlas-material]').forEach(b=>b.onclick=()=>void preview(focus,b.dataset.atlasMaterial));
    body.querySelectorAll('[data-atlas-evidence]').forEach(b=>b.onclick=()=>{const r=index.relations.find(r=>r.id===b.dataset.atlasEvidence),ref=r.evidence_refs[Number(b.dataset.ref)];void preview(ref.canvas_id,ref.material_id);});
    body.querySelectorAll('[data-atlas-reuse]').forEach(b=>b.onclick=async()=>{
      const m=chosen.buildings.flatMap(b=>b.materials).find(m=>m.id===b.dataset.atlasReuse);
      const v=await lmForm(owner.host,'Χρήση υπάρχοντος υλικού',`<p>${lmEscape(m.label)} · Το αρχείο επαναχρησιμοποιείται χωρίς νέο ανέβασμα.</p><label>Μάθημα<select name="canvas_id">${index.canvases.filter(c=>c.id!==focus).map(c=>`<option value="${c.id}">${lmEscape(c.title)}</option>`).join('')}</select></label><label>Οικοδόμημα<select name="building_id">${chosen.buildings.map(b=>`<option value="${b.id}" ${b.materials.includes(m)?'selected':''}>${lmEscape(b.title)}</option>`).join('')}</select></label>`,'Προσθήκη');
      if(!v)return;const target=owner.documents.get(v.canvas_id)?.document,keys=new Set(lmMaterialIdentities(m,owner.registry,owner.assetMetadata));
      if(target.buildings.some(b=>b.materials.some(x=>lmMaterialIdentities(x,owner.registry,owner.assetMetadata).some(k=>keys.has(k))))){owner.notice='Το ίδιο υλικό υπάρχει ήδη σε αυτό το μάθημα.';redraw();return;}
      owner.change(()=>target.buildings.find(b=>b.id===v.building_id).materials.push({...lmClone(m),id:lmId()}),false);redraw();
    });
    const editRelation=async(old=null)=>{
      const options=selected=>index.canvases.map(c=>`<option value="${c.id}" ${c.id===selected?'selected':''}>${lmEscape(c.title)}</option>`).join('');
      const formPromise=lmForm(owner.host,old?'Διδακτική σύνδεση':'Νέα διδακτική σύνδεση',`<label>Από μάθημα<select name="from_canvas_id">${options(old?.from_canvas_id||focus)}</select></label><label>Προς μάθημα<select name="to_canvas_id">${options(old?.to_canvas_id)}</select></label><label>Ρήμα<input name="verb" required maxlength="100" value="${lmEscape(old?.verb||'συνδέεται με')}"></label><label>Εξήγηση<textarea name="phrase" maxlength="600">${lmEscape(old?.phrase||'')}</textarea></label><label>Τεκμηρίωση / πηγές<textarea name="evidence" maxlength="2000">${lmEscape(old?.evidence||'')}</textarea></label><label>Τεκμήριο 1<select name="evidence_one"></select></label><label>Τεκμήριο 2<select name="evidence_two"></select></label>`,'Αποθήκευση πρότασης');
      const form=owner.host.querySelector('dialog:last-of-type form');
      const updateSources=()=>{const endpoints=[form.elements.from_canvas_id.value,form.elements.to_canvas_id.value];for(const [i,name] of ['evidence_one','evidence_two'].entries()){const select=form.elements[name],previous=select.value||old?.evidence_refs?.[i]&&old.evidence_refs[i].canvas_id+'|'+old.evidence_refs[i].material_id;select.innerHTML='<option value="">Χωρίς παραπομπή</option>'+index.canvases.filter(c=>endpoints.includes(c.id)).flatMap(c=>c.buildings.flatMap(b=>b.materials.map(m=>`<option value="${c.id}|${m.id}">${lmEscape(c.title+' · '+m.label)}</option>`))).join('');if([...select.options].some(o=>o.value===previous))select.value=previous;}};
      form.elements.from_canvas_id.onchange=updateSources;form.elements.to_canvas_id.onchange=updateSources;updateSources();
      const v=await formPromise;
      if(!v||v.from_canvas_id===v.to_canvas_id)return;
      owner.change(()=>{const w=owner.documents.get(old?.workspace_id||owner.workspaceId).document;w.lesson_relations||=[];const {evidence_one,evidence_two,...fields}=v;const evidence_refs=[...new Set([evidence_one,evidence_two].filter(Boolean))].map(value=>{const [canvas_id,material_id]=value.split('|');return {canvas_id,material_id};});const next={id:old?.id||lmId(),...fields,status:'proposed',evidence_refs};if(old){const i=w.lesson_relations.findIndex(r=>r.id===old.id);w.lesson_relations[i]=next;}else w.lesson_relations.push(next);},false);redraw();
    };
    body.querySelector('[data-atlas-new]').onclick=()=>void editRelation();
    body.querySelectorAll('[data-atlas-edit]').forEach(b=>b.onclick=()=>void editRelation(index.relations.find(r=>r.id===b.dataset.atlasEdit)));
    for(const action of ['confirm','dismiss'])body.querySelectorAll(`[data-atlas-${action}]`).forEach(b=>b.onclick=()=>{const r=index.relations.find(r=>r.id===b.dataset[action==='confirm'?'atlasConfirm':'atlasDismiss']);owner.change(()=>{const stored=owner.documents.get(r.workspace_id).document.lesson_relations.find(x=>x.id===r.id);stored.status=action==='dismiss'?'dismissed':stored.status==='confirmed'?'proposed':'confirmed';},false);redraw();});
    const map=body.querySelector('.lm-atlas-maps');
    const draw=()=>{
      if(!map.isConnected)return;map.querySelector('svg')?.remove();if(!focus)return;
      const rect=map.getBoundingClientRect(),nodes=[...map.querySelectorAll('[data-atlas-focus]')].map(el=>{const r=el.getBoundingClientRect();return {id:el.dataset.atlasFocus,x:r.left-rect.left+r.width/2,y:r.top-rect.top+r.height/2,left:r.left-rect.left,right:r.right-rect.left};});
      const paths=[],seenPairs=new Set(),edge=(a,b,kind,label)=>{if(!a||!b||a===b)return;const signature=[nodes.indexOf(a),nodes.indexOf(b)].sort().join(':')+kind;if(seenPairs.has(signature))return;seenPairs.add(signature);const across=Math.abs(a.x-b.x)>100,forward=b.x>a.x,sx=across?(forward?a.right:a.left):a.right,tx=across?(forward?b.left:b.right):b.right,dx=across?(tx-sx)*.5:30;paths.push(`<path class="${kind}" d="M${sx},${a.y} C${sx+dx},${a.y-28} ${tx-dx},${b.y-28} ${tx},${b.y}"><title>${lmEscape(label)}</title></path>`);};
      const same=nodes.filter(n=>n.id===focus);for(let i=1;i<same.length;i++)edge(same[i-1],same[i],'same','Ίδιο μάθημα');
      for(const group of common)for(const use of group.uses)if(use.canvas_id!==focus)edge(same[0],nodes.find(n=>n.id===use.canvas_id),'file','Ίδιο αρχείο');
      if(!onlyShared)for(const r of related)edge(nodes.find(n=>n.id===r.from_canvas_id),nodes.find(n=>n.id===r.to_canvas_id),r.status==='confirmed'?'confirmed':'proposed',r.verb);
      map.insertAdjacentHTML('afterbegin',`<svg class="lm-atlas-links" viewBox="0 0 ${rect.width} ${rect.height}" aria-label="Συνδέσεις μαθημάτων">${paths.join('')}</svg>`);
    };
    observer?.disconnect();observer=new ResizeObserver(draw);observer.observe(map);requestAnimationFrame(draw);
  };
  let observer;
  dialog.addEventListener('close',()=>{observer?.disconnect();owner.render();},{once:true});redraw();
}
