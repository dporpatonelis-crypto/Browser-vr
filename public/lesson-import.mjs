import {lmId,lmEscape,lmMaterialType} from './lesson-map-domain.mjs';
import {lmModal,lmForm} from './lesson-map-viewers.mjs';
import {niRegionPicker,niPageCanvas,niPrintedPixels} from './lesson-notes-regions.mjs';
import {niTerms,niFindMaterials,niBuildCanvas,niSourceMaterial,niMaterial,niExistingImport} from './lesson-import-domain.mjs';

export async function niPDF(owner,file) {
  const lib=await import(owner.assetURL('vendor/pdfjs/pdf.mjs'));lib.GlobalWorkerOptions.workerSrc=owner.assetURL('vendor/pdfjs/pdf.worker.mjs');
  return lib.getDocument({data:new Uint8Array(await file.arrayBuffer()),cMapUrl:owner.assetURL('vendor/pdfjs/cmaps/'),cMapPacked:true,standardFontDataUrl:owner.assetURL('vendor/pdfjs/standard_fonts/'),wasmUrl:owner.assetURL('vendor/pdfjs/wasm/')}).promise;
}
export async function niExtract(owner,file,{pdf=null,start=1,end=1,regions=[],signal,onProgress=()=>{}}={}) {
  let worker=null,method='pdf-text';const pieces=[],warnings=[];
  const check=()=>{if(signal?.aborted)throw new DOMException('Η ανάγνωση ακυρώθηκε.','AbortError');};
  async function recognize(image,excluded=[]) {
    check();
    if(!worker){const module=await import(owner.assetURL('vendor/notes-ocr/tesseract.esm.min.js')),tess=module.default||module;worker=await tess.createWorker('ell',1,{workerPath:owner.assetURL('vendor/notes-ocr/worker.min.js'),corePath:owner.assetURL('vendor/notes-ocr/core/'),langPath:owner.assetURL('vendor/notes-ocr/lang'),cacheMethod:'none',logger:m=>onProgress('Αναγνώριση κειμένου · '+Math.round((m.progress||0)*100)+'%')});await worker.setParameters({tessedit_pageseg_mode:'3',preserve_interword_spaces:'1'});}
    let timer;const stop=()=>void worker?.terminate();signal?.addEventListener('abort',stop,{once:true});
    const source=image instanceof Blob?await niPageCanvas(image,null):image,working=document.createElement('canvas');working.width=source.width;working.height=source.height;const context=working.getContext('2d',{willReadFrequently:true});context.drawImage(source,0,0);const pixels=context.getImageData(0,0,working.width,working.height);pixels.data.set(niPrintedPixels(pixels));context.putImageData(pixels,0,0);
    context.fillStyle='white';for(const r of excluded)context.fillRect(r.x*working.width,r.y*working.height,r.w*working.width,r.h*working.height);
    try{return await Promise.race([worker.recognize(working),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Η αναγνώριση άργησε. Μπορείς να συμπληρώσεις το κείμενο χειροκίνητα.')),90000);})]);}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',stop);}
  }
  try{
    if(pdf){
      for(let n=start;n<=end;n++){
        check();onProgress(`Ανάγνωση σελίδας ${n} από ${end}`);const page=await pdf.getPage(n),content=await page.getTextContent();
        const excluded=regions.filter(r=>r.page===n),view=page.getViewport({scale:1});
        let text=content.items.filter(i=>{const [x,y]=view.convertToViewportPoint(i.transform[4]+(i.width||0)/2,i.transform[5]);return !excluded.some(r=>x/view.width>=r.x&&x/view.width<=r.x+r.w&&y/view.height>=r.y&&y/view.height<=r.y+r.h);}).map(i=>i.str+(i.hasEOL?'\n':' ')).join('').trim();
        if(text.replace(/\s/g,'').length<40){const base=page.getViewport({scale:1}),scale=Math.min(2.5,2000/base.width,2400/base.height),viewport=page.getViewport({scale}),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
          const result=await recognize(canvas,excluded);text=result.data.text;method=pieces.length?'mixed':'ocr';canvas.width=canvas.height=0;
          if(result.data.confidence<65)warnings.push('Χαμηλή βεβαιότητα αναγνώρισης στη σελίδα '+n+'.');
        }
        pieces.push(text.trim());page.cleanup();
      }
    }else{
      method='ocr';const result=await recognize(file,regions);pieces.push(result.data.text.trim());if(result.data.confidence<65)warnings.push('Χαμηλή βεβαιότητα αναγνώρισης. Έλεγξε το κείμενο.');
    }
    check();return {text:pieces.join('\n\n').replaceAll('µ','μ').slice(0,100000),method,warnings};
  }finally{await worker?.terminate();}
}

export async function niStartImport(owner) {
  if(!owner.privateMode||owner.saving)return;
  let file=null,pdf=null,closed=false,analysis=null,prepared=null,picker=null;
  const abort=new AbortController();
  const dialog=lmModal(owner.host,'Από σημειώσεις σε μάθημα',`<div class="ni-steps"><span class="active">1 · Πηγή</span><span>2 · Υλικό και θεματική</span><span>3 · Ιδιωτικό μάθημα</span></div><p>Διάλεξε το PDF ή την εικόνα που εξήγαγες από το Samsung Notes. Θα ελέγξεις το κείμενο και τα προτεινόμενα μέσα πριν δημιουργηθεί το μάθημα.</p><label class="ni-file-label">Αρχείο σημειώσεων<input data-notes-file type="file" accept="application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp"></label><p class="ni-help">Έως 25 MB. Η ανάγνωση γίνεται στη συσκευή σου. Το πρωτότυπο αποθηκεύεται στον ιδιωτικό χώρο όταν επιλέξεις «Δημιουργία».</p><div data-range hidden><label>Από σελίδα<input data-start type="number" min="1" value="1"></label><label>Έως σελίδα<input data-end type="number" min="1" value="1"></label><p data-pages></p></div><div data-regions></div><p data-progress role="status"></p><p data-error role="alert"></p><button data-read class="lm-primary" disabled>Ανάγνωση σημειώσεων →</button>`,{wide:true,onClose:()=>{closed=true;abort.abort();void pdf?.destroy();}});
  const status=dialog.querySelector('[data-progress]'),error=dialog.querySelector('[data-error]'),read=dialog.querySelector('[data-read]');
  async function updateRange(){if(!prepared)return;const start=Number(dialog.querySelector('[data-start]').value),end=Number(dialog.querySelector('[data-end]').value);if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>(pdf?.numPages||1)||end-start>=20)return;read.disabled=true;picker?.destroy();picker=await niRegionPicker(dialog.querySelector('[data-regions]'),file,pdf,{start,end});read.disabled=false;}
  dialog.querySelector('[data-start]').onchange=updateRange;dialog.querySelector('[data-end]').onchange=updateRange;
  dialog.querySelector('[data-notes-file]').onchange=async e=>{
    file=e.target.files[0];read.disabled=true;error.textContent='';prepared=null;await pdf?.destroy();pdf=null;
    if(!file)return;
    try{const type=lmMaterialType(file);if(!['pdf','image'].includes(type)||file.size>25*1024*1024)throw Error('Επίλεξε PDF, PNG, JPG ή WebP έως 25 MB.');
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))).map(v=>v.toString(16).padStart(2,'0')).join('');
      if(type==='pdf'){status.textContent='Έλεγχος PDF…';pdf=await niPDF(owner,file);if(closed)return;dialog.querySelector('[data-range]').hidden=false;dialog.querySelector('[data-end]').value=Math.min(pdf.numPages,20);dialog.querySelector('[data-pages]').textContent=`${pdf.numPages} σελίδες · επίλεξε έως 20 για κάθε εισαγωγή.`;}else dialog.querySelector('[data-range]').hidden=true;
      prepared={type,sha256:hash};picker?.destroy();picker=await niRegionPicker(dialog.querySelector('[data-regions]'),file,pdf,{start:1,end:pdf?Math.min(pdf.numPages,20):1});status.textContent='Έλεγξε τις περιοχές εικόνων και συνέχισε με το έντυπο κείμενο.';read.disabled=false;
    }catch(err){error.textContent=err.message;status.textContent='';}
  };
  read.onclick=async()=>{
    const start=pdf?Number(dialog.querySelector('[data-start]').value):1,end=pdf?Number(dialog.querySelector('[data-end]').value):1;
    if(!Number.isInteger(start)||!Number.isInteger(end)||start<1||end<start||end>(pdf?.numPages||1)||end-start>=20){error.textContent='Επίλεξε έγκυρο εύρος έως 20 σελίδων.';return;}
    const existing=niExistingImport(owner.documents,prepared.sha256,start,end);
    if(existing){error.textContent='Οι ίδιες σελίδες υπάρχουν ήδη: '+existing[1].document.title;const open=document.createElement('button');open.textContent='Άνοιγμα υπάρχοντος μαθήματος';open.onclick=()=>{dialog.close();owner.open(existing[0]);};error.append(open);return;}
    read.disabled=true;dialog.querySelector('[data-notes-file]').disabled=true;error.textContent='';let crops=[];
    try{if(picker.start!==start||picker.end!==end){picker.destroy();picker=await niRegionPicker(dialog.querySelector('[data-regions]'),file,pdf,{start,end});}dialog.querySelector('[data-regions]').inert=true;crops=await picker.files();analysis=await niExtract(owner,file,{pdf,start,end,regions:picker.regions,signal:abort.signal,onProgress:message=>{if(!closed)status.textContent=message;}});}
    catch(err){if(closed)return;analysis={text:'',method:'manual',warnings:['Η αυτόματη ανάγνωση δεν ολοκληρώθηκε: '+err.message]};}
    if(closed)return;
    const source={...prepared,name:file.name.slice(0,180),page_start:start,page_end:end,total_pages:pdf?.numPages||1,extraction:analysis.method};
    // Closing the first step releases the reader, while the source File stays in this closure.
    dialog.close();await niReview(owner,file,source,{...analysis,crops});
  };
  return dialog;
}

async function niReview(owner,file,source,analysis) {
  const title=analysis.title||file.name.replace(/\.[^.]+$/,'').replace(/[_-]/g,' ').replace(/Samsung Notes/gi,'').trim().slice(0,240);
  const values=await lmForm(owner.host,'Έλεγχος σημειώσεων',`<p>Έλεγξε τίτλο και κείμενο. Οι υπογραμμίσεις και τα χειρόγραφα παραμένουν στο πρωτότυπο· η αναγνώρισή τους μπορεί να έχει λάθη.</p>${analysis.warnings.map(w=>`<p class="ni-warning">${lmEscape(w)}</p>`).join('')}<label>Τίτλος μαθήματος<input name="title" required maxlength="240" value="${lmEscape(title)}"></label><label>Τάξη<select name="grade">${owner.registry.grades.map(g=>`<option ${g===(analysis.grade||owner.workspace.grade)?'selected':''}>${lmEscape(g)}</option>`).join('')}</select></label><label>Κείμενο σημειώσεων<textarea name="text" rows="12" maxlength="100000">${lmEscape(analysis.text)}</textarea></label><label>Διδακτικό ερώτημα / εστίαση<textarea name="focus" rows="2" maxlength="1000" placeholder="π.χ. Πώς αλλάζουν οι σχέσεις του ανθρώπου μετά την παρακοή;">${lmEscape(analysis.focus||'')}</textarea></label>`,'Εύρεση υλικού →');
  if(!values)return;
  return niChoose(owner,file,source,values,analysis.crops||[]);
}

async function niChoose(owner,file,source,values,crops) {
  let matches=niFindMaterials(owner.registry,values),selected=new Map(),saving=false;const cropURLs=crops.map(r=>URL.createObjectURL(r.file));
  const dialog=lmModal(owner.host,'Θεματική και οικοδομήματα',`<div class="ni-steps"><span>1 · Πηγή ✓</span><span class="active">2 · Υλικό και θεματική</span><span>3 · Ιδιωτικό μάθημα</span></div><form class="lm-form ni-review"><label>Θεματική στον χάρτη<select name="theme_id" required><option value="">Επιλογή θεματικής…</option>${owner.workspace.themes.map(t=>`<option value="${t.id}">${lmEscape(t.title)}</option>`).join('')}</select></label><label>Βασικές έννοιες <small>Χώρισε με κόμμα· μπορείς να διορθώσεις τις προτεινόμενες λέξεις.</small><input name="terms" maxlength="1000" value="${lmEscape(niTerms(values.text,8).join(', '))}"></label><fieldset><legend>Εικόνες από τις σημειώσεις</legend><p>Το πρωτότυπο και το ελεγμένο έντυπο κείμενο μπαίνουν στη Βιβλιοθήκη. Οι επιλεγμένες ασκήσεις μπαίνουν στην Πινακοθήκη και οι χάρτες στη Σχολή εννοιών.</p>${crops.map((r,i)=>`<label class="ni-crop-choice"><input type="checkbox" name="crop-${i}" checked> ${lmEscape(r.label)} · σελ. ${r.page}<img src="${cropURLs[i]}" alt="Προεπισκόπηση: ${lmEscape(r.label)}"></label>`).join('')||'<p>Δεν επιλέχθηκαν αποσπάσματα εικόνας. Μπορείς να τα προσθέσεις αργότερα.</p>'}</fieldset><h3>Υλικό από το Πιλοτήριο</h3><p>Προτάσεις από τίτλους, στόχους και περιγραφές του καταλόγου. Διάβασε τη συνάφεια και επίλεξε όσα ταιριάζουν στο συγκεκριμένο μάθημα.</p><label>Αναζήτηση στον κατάλογο<input data-query placeholder="Π.χ. παρακοή, πτώση, δημιουργία"></label><button type="button" data-search>Εύρεση</button><div data-matches></div><div data-selected></div><p data-error role="alert"></p><p data-progress role="status"></p><div class="lm-form-actions"><button type="button" data-back>← Πίσω στο κείμενο</button><button class="lm-primary" type="submit">Δημιουργία ιδιωτικού μαθήματος</button></div></form>`,{wide:true});
  const form=dialog.querySelector('form'),error=form.querySelector('[data-error]'),status=form.querySelector('[data-progress]');
  function results(){
    form.querySelector('[data-matches]').innerHTML=matches.map((r,i)=>`<article class="ni-result"><label><input type="checkbox" data-match="${i}" ${selected.has(r.key)?'checked':''}><strong>${lmEscape(r.activity.label)}</strong></label><small>${lmEscape(r.scenario_title)} · ${lmEscape(r.reasons.join(' · '))}</small><p>${lmEscape(r.evidence.slice(0,900))}</p><select aria-label="Οικοδόμημα: ${lmEscape(r.activity.label)}" data-target="${i}">${[['text','Βιβλιοθήκη'],['images','Πινακοθήκη'],['mindmap','Σχολή εννοιών'],['html','Εργαστήριο'],['synthesis','Στοά σύνθεσης']].map(([id,label])=>`<option value="${id}" ${(selected.get(r.key)?.building||r.building)===id?'selected':''}>${label}</option>`).join('')}</select>${r.activity.download_only?'<small>Ιδιωτικό αρχείο Drive · διατηρείται η υπάρχουσα λήψη.</small>':''}</article>`).join('')||'<p>Δεν προέκυψε πρόταση. Δοκίμασε άλλη αναζήτηση ή πρόσθεσε υλικό αργότερα από τον χάρτη.</p>';
    form.querySelectorAll('[data-match]').forEach(c=>c.onchange=()=>{const r=matches[Number(c.dataset.match)];if(c.checked)selected.set(r.key,{...r,building:form.querySelector(`[data-target="${c.dataset.match}"]`).value});else selected.delete(r.key);count();});
    form.querySelectorAll('[data-target]').forEach(s=>s.onchange=()=>{const r=matches[Number(s.dataset.target)];if(selected.has(r.key))selected.get(r.key).building=s.value;});count();
  }
  function count(){form.querySelector('[data-selected]').textContent=`${selected.size} μέσα επιλεγμένα από το Πιλοτήριο.`;}
  form.querySelector('[data-search]').onclick=()=>{matches=niFindMaterials(owner.registry,{...values,query:form.querySelector('[data-query]').value});results();};
  form.querySelector('[data-back]').onclick=()=>{dialog.close();void niReview(owner,file,source,{...values,warnings:[],crops});};
  form.onsubmit=async e=>{
    e.preventDefault();if(saving)return;
    const fields=new FormData(form),terms=String(fields.get('terms')).split(/[,;\n]/).map(t=>t.trim()).filter(Boolean).slice(0,12);
    if(terms.some(t=>t.length>100)){error.textContent='Κάθε έννοια μπορεί να έχει έως 100 χαρακτήρες.';return;}
    saving=true;form.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);dialog.querySelector('.lm-close').disabled=true;error.textContent='';
    try{
      status.textContent='Αποθήκευση πρωτότυπου στον ιδιωτικό χώρο…';const known=[...owner.documents.values()].find(r=>r.document.import_source?.sha256===source.sha256)?.document.import_source,original=known?{asset:{id:known.asset_id}}:await owner.upload(file),id=lmId();
      const doc=niBuildCanvas({id,...values,source:{...source,asset_id:original.asset.id},terms,selected:[...selected.values()]});
      doc.import_source.exercise_regions=[];
      for(let i=0;i<crops.length;i++)if(fields.has('crop-'+i)){const crop=crops[i];status.textContent='Αποθήκευση αποσπάσματος εικόνας…';const uploaded=await owner.upload(crop.file);doc.buildings.find(b=>b.id===(crop.kind==='mindmap'?'mindmap':'images')).materials.push(niSourceMaterial('image',crop.label+' · σελ. '+crop.page,{asset_id:uploaded.asset.id}));doc.import_source.exercise_regions.push({asset_id:uploaded.asset.id,page:crop.page,x:crop.x,y:crop.y,w:crop.w,h:crop.h});}
      owner.change(()=>{owner.documents.set(id,{kind:'canvas',document:doc});owner.workspace.lessons.push({id:lmId(),theme_id:fields.get('theme_id'),title:values.title,scenario_id:doc.scenario_id,canvas_id:id});},false);
      dialog.close();owner.open(id);await owner.save();
    }catch(err){error.textContent='Η δημιουργία δεν ολοκληρώθηκε: '+err.message+' Οι επιλογές σου παραμένουν εδώ.';status.textContent='';saving=false;form.querySelectorAll('button,input,select').forEach(el=>el.disabled=false);dialog.querySelector('.lm-close').disabled=false;}
  };
  results();dialog.addEventListener('close',()=>cropURLs.forEach(u=>URL.revokeObjectURL(u)),{once:true});return dialog;
}

export async function niEnrich(owner) {
  if(!owner.privateMode||owner.saving||!owner.document.import_source)return;
  const doc=owner.document,existing=new Set(doc.buildings.flatMap(b=>b.materials.filter(m=>m.activity_id).map(m=>m.source_scenario_id+'|'+m.activity_id)));
  const text=doc.buildings.flatMap(b=>b.materials.filter(m=>m.type==='text').map(m=>m.text)).join('\n');
  const rows=niFindMaterials(owner.registry,{title:doc.title,text,focus:doc.import_source.focus}).filter(r=>!existing.has(r.key));
  const values=await lmForm(owner.host,'Συμπλήρωση από το Πιλοτήριο',`<p>Επιλέγεις πρόσθετα μέσα από τον διαθέσιμο κατάλογο. Τα HTML ενημερώνονται χωριστά από το Drive ή τοπικά. Οι υπάρχουσες επιλογές και η διάταξη διατηρούνται.</p>${rows.map((r,i)=>`<label class="lm-check"><input type="checkbox" name="item-${i}">${lmEscape(r.activity.label)}</label><small>${lmEscape(r.evidence.slice(0,400))}</small>`).join('')||'<p>Δεν προέκυψαν νέα προτεινόμενα μέσα. Μπορείς να χρησιμοποιήσεις και το «＋ Υλικό → Κατάλογος».</p>'}`,'Προσθήκη επιλεγμένων');
  if(!values)return;const chosen=rows.filter((r,i)=>'item-'+i in values);
  if(!chosen.length)return;
  owner.change(()=>{for(const r of chosen)doc.buildings.find(b=>b.id===r.building).materials.push(niMaterial(r));doc.import_source.related_scenario_ids=[...new Set([...doc.import_source.related_scenario_ids,...chosen.map(r=>r.scenario_id)])];});
}
