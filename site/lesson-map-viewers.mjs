import {lmId,lmEscape,lmPoint,lmClamp,lmSafeURL} from './lesson-map-domain.mjs';

export function lmModal(host,title,body,{wide=false,onClose=()=>{}}={}) {
  const dialog=document.createElement('dialog');dialog.className='lm-dialog'+(wide?' lm-viewer':'');
  dialog.innerHTML=`<header><h2>${lmEscape(title)}</h2><button type="button" class="lm-close" aria-label="Κλείσιμο και επιστροφή στον χάρτη">✕</button></header><div class="lm-dialog-body">${body}</div>`;
  host.append(dialog);dialog.querySelector('.lm-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{onClose();dialog.remove();},{once:true});
  dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
  dialog.showModal();return dialog;
}

export function lmForm(host,title,body,submitLabel='Εφαρμογή') {
  return new Promise(resolve=>{
    let done=false;
    const dialog=lmModal(host,title,`<form class="lm-form">${body}<p class="lm-form-error" role="alert"></p><div class="lm-form-actions"><button type="button" data-cancel>Άκυρο</button><button type="submit" class="lm-primary">${submitLabel}</button></div></form>`,{onClose:()=>{if(!done)resolve(null);}});
    dialog.querySelector('[data-cancel]').onclick=()=>dialog.close();
    dialog.querySelector('form').onsubmit=e=>{e.preventDefault();done=true;resolve(Object.fromEntries(new FormData(e.target)));dialog.close();};
  });
}

export async function lmShowViewer(owner,building,start=0) {
  const readOnly=Boolean(owner.readOnly||owner.historical);
  let index=start,zoom=1,tool='pan',first=null,active=null,mediaEpoch=0,pdf=null,page=1,destroyed=false,renderTask=null;
  const viewerURLs=new Set();
  const releaseURLs=()=>{for(const url of viewerURLs){URL.revokeObjectURL(url);owner.objectURLs.delete(url);}viewerURLs.clear();};
  const container=owner.host;
  const dialog=lmModal(container,building.title,`<div class="lm-viewer-controls"><button data-prev aria-label="Προηγούμενο υλικό">←</button><select data-material aria-label="Επιλογή υλικού"></select><button data-next aria-label="Επόμενο υλικό">→</button><button data-zoom-out aria-label="Σμίκρυνση">−</button><button data-zoom-in aria-label="Μεγέθυνση">＋</button><button data-fullscreen>Πλήρης οθόνη</button></div><div class="lm-viewer-status" role="status"></div><div class="lm-viewer-media"></div>`,{wide:true,onClose:()=>{destroyed=true;++mediaEpoch;renderTask?.cancel();pdf?.destroy();releaseURLs();owner.render();}});
  const body=dialog.querySelector('.lm-viewer-media'),status=dialog.querySelector('.lm-viewer-status'),selector=dialog.querySelector('[data-material]');
  const current=()=>building.materials[index];
  const annotations=()=>owner.document.annotations.filter(a=>a.material_id===current()?.id);
  function overlayMarkup(rows) {
    return rows.map(a=>{
      const pts=a.points.map(p=>`${p.x*1000},${p.y*1000}`).join(' '),a0=a.points[0],a1=a.points.at(-1);
      if(a.kind==='region')return `<rect x="${Math.min(a0.x,a1.x)*1000}" y="${Math.min(a0.y,a1.y)*1000}" width="${Math.abs(a1.x-a0.x)*1000}" height="${Math.abs(a1.y-a0.y)*1000}" class="lm-region"/><text x="${Math.min(a0.x,a1.x)*1000+5}" y="${Math.min(a0.y,a1.y)*1000+25}">${lmEscape(a.verb)}</text>`;
      return `<polyline points="${pts}" class="${a.kind==='relation'?'lm-relation-line':'lm-ink'}"/>${a.verb?`<text x="${(a0.x+a1.x)*500}" y="${(a0.y+a1.y)*500-12}">${lmEscape(a.verb)}</text>`:''}`;
    }).join('');
  }
  function drawOverlay(extra=[]) {
    const svg=body.querySelector('.lm-image-overlay');if(svg)svg.innerHTML=overlayMarkup([...annotations(),...extra]);
  }
  async function addAnnotation(kind,points) {
    let verb='',phrase='';
    if(kind==='relation'||kind==='region') {
      const values=await lmForm(container,kind==='region'?'Ονομασία περιοχής':'Σύνδεση περιοχών',`<label>${kind==='region'?'Σύντομη ονομασία':'Ρήμα σχέσης'}<input name="verb" maxlength="100" list="lm-viewer-verbs" required></label><datalist id="lm-viewer-verbs">${owner.document.verbs.map(v=>`<option value="${lmEscape(v)}">`).join('')}</datalist>${kind==='relation'?'<label>Ερμηνευτική φράση <textarea name="phrase" maxlength="600"></textarea></label>':''}`);
      if(!values||destroyed)return;verb=values.verb;phrase=values.phrase||'';
    }
    owner.change(()=>owner.document.annotations.push({id:lmId(),material_id:current().id,kind,points,verb,phrase}),false);drawOverlay();regionButtons();
  }
  function regionButtons() {
    const target=body.querySelector('.lm-region-buttons');if(!target)return;
    target.innerHTML=annotations().filter(a=>a.kind==='region').map(a=>`<button data-region="${a.id}">${lmEscape(a.verb||'Περιοχή')}</button>`).join('');
    target.querySelectorAll('[data-region]').forEach(b=>b.onclick=()=>{
      const a=annotations().find(a=>a.id===b.dataset.region),vp=body.querySelector('.lm-image-viewport'),img=body.querySelector('.lm-image-page');
      zoom=2.5;img.style.width=`${100*zoom}%`;
      requestAnimationFrame(()=>{vp.scrollLeft=(a.points[0].x+a.points.at(-1).x)/2*img.offsetWidth-vp.clientWidth/2;vp.scrollTop=(a.points[0].y+a.points.at(-1).y)/2*img.offsetHeight-vp.clientHeight/2;});
    });
  }
  function imageTools() {
    if(readOnly)body.querySelectorAll('[data-image-tool]:not([data-image-tool="pan"]),[data-undo-annotation],[data-clear-annotations]').forEach(b=>b.disabled=true);
    body.querySelector('[data-fit-image]').onclick=()=>{const vp=body.querySelector('.lm-image-viewport'),page=body.querySelector('.lm-image-page'),img=page.querySelector('img');if(img.naturalWidth){zoom=Math.min(1,vp.clientHeight/(img.naturalHeight/img.naturalWidth*vp.clientWidth)*.97);page.style.width=zoom*100+'%';vp.scrollTop=vp.scrollLeft=0;}};
    body.querySelectorAll('[data-image-tool]').forEach(button=>button.onclick=()=>{
      tool=button.dataset.imageTool;first=null;active=null;
      body.querySelectorAll('[data-image-tool]').forEach(b=>b.setAttribute('aria-pressed',b===button));
      body.querySelector('.lm-image-overlay').style.touchAction=tool==='pan'?'auto':'none';
      status.textContent=tool==='relation'?'Πάτησε δύο σημεία της εικόνας.':tool==='region'?'Σύρε για να ορίσεις μια περιοχή.':tool==='stroke'?'Σχεδίασε πάνω στην εικόνα.':'Μεγέθυνση και κύλιση εικόνας.';
    });
    body.querySelector('[data-undo-annotation]').onclick=()=>{const rows=annotations();if(rows.length){owner.change(()=>{owner.document.annotations=owner.document.annotations.filter(a=>a.id!==rows.at(-1).id);},false);drawOverlay();regionButtons();}};
    body.querySelector('[data-clear-annotations]').onclick=async()=>{if(await lmForm(container,'Καθαρισμός σημειώσεων','<p>Αφαίρεση των σημειώσεων αυτής της εικόνας από τον χάρτη;</p>','Καθαρισμός')){owner.change(()=>{owner.document.annotations=owner.document.annotations.filter(a=>a.material_id!==current().id);},false);drawOverlay();regionButtons();}};
    body.querySelector('[data-reveal-image]').onclick=e=>{body.querySelector('.lm-image-curtain').hidden=true;e.target.hidden=true;};
    const svg=body.querySelector('.lm-image-overlay');
    svg.addEventListener('pointerdown',e=>{
      if(tool==='pan')return;
      e.preventDefault();const p=lmPoint(e.clientX,e.clientY,svg.getBoundingClientRect());
      if(tool==='relation') {if(!first){first=p;status.textContent='Τώρα πάτησε το δεύτερο σημείο.';}else{const from=first;first=null;void addAnnotation('relation',[from,p]);}return;}
      active={pointerId:e.pointerId,points:[p]};svg.setPointerCapture(e.pointerId);
    });
    svg.addEventListener('pointermove',e=>{
      if(!active||active.pointerId!==e.pointerId)return;
      const p=lmPoint(e.clientX,e.clientY,svg.getBoundingClientRect());
      if(tool==='region')active.points=[active.points[0],p];else if(active.points.length<2000)active.points.push(p);
      drawOverlay([{kind:tool==='region'?'region':'stroke',points:active.points,verb:''}]);
    });
    svg.addEventListener('pointerup',e=>{if(!active||e.pointerId!==active.pointerId)return;const points=active.points;active=null;if(points.length>1)void addAnnotation(tool==='region'?'region':'stroke',points);});
    svg.addEventListener('pointercancel',()=>{active=null;drawOverlay();});
    regionButtons();drawOverlay();
  }
  async function paintPDF() {
    if(!pdf||destroyed)return;
    renderTask?.cancel();
    try {
      const p=await pdf.getPage(page);if(destroyed)return;
      const base=p.getViewport({scale:1}),available=Math.max(300,body.clientWidth-40),scale=available/base.width*zoom;
      const viewport=p.getViewport({scale}),canvas=body.querySelector('canvas'),ratio=Math.min(devicePixelRatio||1,2);
      canvas.width=viewport.width*ratio;canvas.height=viewport.height*ratio;canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
      renderTask=p.render({canvasContext:canvas.getContext('2d'),viewport,transform:ratio!==1?[ratio,0,0,ratio,0,0]:null});
      await renderTask.promise;status.textContent=`Σελίδα ${page} από ${pdf.numPages}`;
      body.querySelector('[data-page-prev]').disabled=page<=current().page_start;
      body.querySelector('[data-page-next]').disabled=page>=Math.min(current().page_end,pdf.numPages);
    } catch(e){if(e.name!=='RenderingCancelledException')status.textContent='Η σελίδα δεν αποδόθηκε: '+e.message;}
  }
  async function show() {
    const epoch=++mediaEpoch;index=lmClamp(index,0,Math.max(0,building.materials.length-1));zoom=1;first=null;active=null;tool='pan';renderTask?.cancel();pdf?.destroy();pdf=null;
    releaseURLs();
    selector.innerHTML=building.materials.map((m,i)=>`<option value="${i}" ${i===index?'selected':''}>${lmEscape(m.label||'Υλικό '+(i+1))}</option>`).join('');
    dialog.querySelector('[data-prev]').disabled=index===0;dialog.querySelector('[data-next]').disabled=index>=building.materials.length-1;
    const m=current();if(!m){body.innerHTML='<div class="lm-empty"><span>✦</span><h3>Έτοιμο για το υλικό σου</h3><p>Επέστρεψε στην επεξεργασία και πρόσθεσε κείμενο, εικόνα, PDF ή δραστηριότητα.</p></div>';return;}
    status.textContent='Φόρτωση…';body.innerHTML='';
    try {
      let url=m.url,blob=null,activity=null;
      if(m.activity_id)activity=owner.registry.scenarios.find(s=>s.scenario_id===m.source_scenario_id)?.activities.find(a=>a.id===m.activity_id);
      if(activity&&!m.asset_id){
        const useDownload=activity.download_only||m.type==='pdf'||m.type==='image';
        url=useDownload?(activity.download_url||activity.url):(activity.url||activity.download_url);
      }
      if(m.asset_id){blob=await owner.readAsset(m.asset_id);url=URL.createObjectURL(blob);owner.objectURLs.add(url);viewerURLs.add(url);}
      if(destroyed||epoch!==mediaEpoch)return;
      const external=lmSafeURL(url)?`<a href="${lmEscape(url)}" target="_blank" rel="noopener noreferrer">${activity?.download_only?'Λήψη από το Drive':'Άνοιγμα σε νέα καρτέλα'} ↗</a>`:blob?`<a href="${url}" download="${lmEscape(m.label)}">Λήψη αρχείου ↓</a>`:'';
      if(m.type==='text'){
        body.innerHTML=`<article class="lm-reading"><h3>${lmEscape(m.label)}</h3><div>${lmEscape(m.text).replaceAll('\n','<br>')}</div></article>`;
      }else if(activity?.download_only&&!blob){
        const help=activity.note||'Άνοιξε τη λήψη με τον λογαριασμό σου στο Drive.';
        body.innerHTML=`<div class="lm-empty"><span>🔒</span><h3>${lmEscape(m.label)}</h3><p>${lmEscape(help)}</p>${external}</div>`;
      }else if(m.type==='image'){
        body.innerHTML=`<div class="lm-image-tools"><button data-fit-image>Προβολή όλης της εικόνας</button><button data-image-tool="pan" aria-pressed="true">Περιήγηση</button><button data-image-tool="stroke" aria-pressed="false">✎ Γραμμή</button><button data-image-tool="relation" aria-pressed="false">🔗 Σύνδεση</button><button data-image-tool="region" aria-pressed="false">▧ Περιοχή</button><button data-undo-annotation>Αναίρεση γραμμής</button><button data-clear-annotations>Καθαρισμός</button><button data-reveal-image>Αποκάλυψη εικόνας</button></div><div class="lm-region-buttons"></div><div class="lm-image-viewport"><div class="lm-image-page"><img src="${lmEscape(url)}" alt="${lmEscape(m.label)}" draggable="false"><svg class="lm-image-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Σημειώσεις και συνδέσεις εικόνας"></svg><div class="lm-image-curtain" hidden>✦</div></div></div><div class="lm-resource-link">${external}<button data-cover>Κάλυψη εικόνας</button></div>`;
        body.querySelector('img').onerror=()=>{status.textContent='Η εικόνα δεν φορτώθηκε. Έλεγξε τον σύνδεσμο ή εισήγαγε το αρχείο.';};
        body.querySelector('[data-cover]').onclick=()=>{body.querySelector('.lm-image-curtain').hidden=false;body.querySelector('[data-reveal-image]').hidden=false;};
        imageTools();
      }else if(m.type==='pdf'){
        body.innerHTML=`<div class="lm-pdf-tools"><button data-page-prev>← Σελίδα</button><button data-page-next>Σελίδα →</button>${external}</div><div class="lm-pdf-page"><canvas aria-label="Σελίδα PDF"></canvas></div>`;
        const pdfjs=await import(owner.assetURL('vendor/pdfjs/pdf.mjs'));
        pdfjs.GlobalWorkerOptions.workerSrc=owner.assetURL('vendor/pdfjs/pdf.worker.mjs');
        const task=pdfjs.getDocument({...blob?{data:new Uint8Array(await blob.arrayBuffer())}:{url},cMapUrl:owner.assetURL('vendor/pdfjs/cmaps/'),cMapPacked:true,standardFontDataUrl:owner.assetURL('vendor/pdfjs/standard_fonts/'),wasmUrl:owner.assetURL('vendor/pdfjs/wasm/')});
        const loaded=await task.promise;if(destroyed||epoch!==mediaEpoch){loaded.destroy();return;}
        pdf=loaded;page=Math.min(m.page_start,pdf.numPages);
        body.querySelector('[data-page-prev]').onclick=()=>{page=Math.max(m.page_start,page-1);void paintPDF();};
        body.querySelector('[data-page-next]').onclick=()=>{page=Math.min(m.page_end,pdf.numPages,page+1);void paintPDF();};
        await paintPDF();return;
      }else{
        body.innerHTML=`<div class="lm-resource-link">${external}<span>Αν δεν επιτρέπεται η ενσωμάτωση, χρησιμοποίησε το εξωτερικό άνοιγμα.</span></div><iframe class="lm-html-frame" title="${lmEscape(m.label)}" sandbox="allow-scripts allow-forms allow-modals allow-downloads allow-pointer-lock" referrerpolicy="no-referrer" allow="fullscreen; autoplay"></iframe>`;
        const frame=body.querySelector('iframe');if(blob)frame.srcdoc=await blob.text();else frame.src=lmSafeURL(url)||'about:blank';
      }
      status.textContent=m.label;
    }catch(e){if(destroyed||epoch!==mediaEpoch)return;status.textContent='Το υλικό δεν άνοιξε: '+e.message;const u=lmSafeURL(m.url);body.innerHTML=`<div class="lm-empty"><p>Μπορείς να ελέγξεις τον σύνδεσμο ή να εισαγάγεις το αρχείο από τη μπάρα επεξεργασίας.</p>${u?`<a href="${lmEscape(u)}" target="_blank" rel="noopener noreferrer">Άνοιγμα αρχικής πηγής ↗</a>`:''}</div>`;}
  }
  selector.onchange=()=>{index=Number(selector.value);void show();};
  dialog.querySelector('[data-prev]').onclick=()=>{--index;void show();};dialog.querySelector('[data-next]').onclick=()=>{++index;void show();};
  function changeZoom(factor){zoom=lmClamp(zoom*factor,.08,4);const image=body.querySelector('.lm-image-page');if(image)image.style.width=`${zoom*100}%`;if(pdf)void paintPDF();}
  dialog.querySelector('[data-zoom-out]').onclick=()=>changeZoom(1/1.25);dialog.querySelector('[data-zoom-in]').onclick=()=>changeZoom(1.25);
  dialog.querySelector('[data-fullscreen]').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await dialog.requestFullscreen();}catch{status.textContent='Η προβολή έχει ήδη προσαρμοστεί στο διαθέσιμο παράθυρο.';}};
  await show();return dialog;
}
