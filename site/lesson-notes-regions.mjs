import {lmId,lmClamp,lmEscape} from './lesson-map-domain.mjs';

/** Detect the printed dark exercise panels used in the teacher's Notes exports. */
export function niDarkPanels({data,width,height}) {
  const rows=[];
  for(let y=0;y<height;y++){let dark=0;for(let x=0;x<width;x++){const i=(y*width+x)*4;if(data[i]<65&&data[i+1]<65&&data[i+2]<65)dark++;}rows.push(dark/width>.30);}
  let previous=-1;for(let y=0;y<height;y++)if(rows[y]){if(previous>=0&&y-previous<Math.max(4,height*.03))for(let gap=previous;gap<y;gap++)rows[gap]=true;previous=y;}
  const bands=[];let first=-1;
  for(let y=0;y<=height;y++){if(rows[y]&&first<0)first=y;if(!rows[y]&&first>=0){if(y-first>height*.12)bands.push([first,y]);first=-1;}}
  return bands.map(([top,bottom])=>{
    const xs=[];for(let x=0;x<width;x++){let dark=0;for(let y=top;y<bottom;y++){const i=(y*width+x)*4;if(data[i]<65&&data[i+1]<65&&data[i+2]<65)dark++;}if(dark/(bottom-top)>.55)xs.push(x);}
    if(!xs.length)return null;const left=Math.max(0,xs[0]-2),right=Math.min(width,xs.at(-1)+3);
    return {x:left/width,y:Math.max(0,top-2)/height,w:(right-left)/width,h:(Math.min(height,bottom+2)-Math.max(0,top-2))/height};
  }).filter(r=>r&&r.w>.25);
}

export function niPrintedPixels(image) {
  // Red pen is excluded from the OCR working copy. The original and saved crops stay intact.
  const data=new Uint8ClampedArray(image.data);
  for(let i=0;i<data.length;i+=4){const r=data[i],g=data[i+1],b=data[i+2];if(r>100&&r>g*1.4&&r>b*1.4){data[i]=data[i+1]=data[i+2]=255;}}
  return data;
}

export async function niPageCanvas(file,pdf,page=1) {
  const canvas=document.createElement('canvas');
  if(pdf){const p=await pdf.getPage(page),base=p.getViewport({scale:1}),viewport=p.getViewport({scale:Math.min(2.5,2200/base.width,2600/base.height)});canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await p.render({canvasContext:canvas.getContext('2d'),viewport}).promise;}
  else{const bitmap=await createImageBitmap(file),scale=Math.min(1,2600/bitmap.width,3000/bitmap.height);canvas.width=Math.ceil(bitmap.width*scale);canvas.height=Math.ceil(bitmap.height*scale);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();}
  return canvas;
}

export async function niRegionPicker(host,file,pdf,{start=1,end=1}={}) {
  const wrapper=document.createElement('section');wrapper.className='ni-region-picker';
  wrapper.innerHTML=`<h3>Αποσπάσματα για τα οικοδομήματα</h3><p>Σύρε πάνω στη σελίδα για να κρατήσεις μια άσκηση μαζί με την τράπεζα λέξεων ή μια εικόνα εννοιολογικού χάρτη. Άφησε έξω τις χειρόγραφες σημειώσεις.</p><div class="ni-region-controls"><button type="button" data-prev aria-label="Προηγούμενη σελίδα πηγής">←</button><span data-page-label></span><button type="button" data-next aria-label="Επόμενη σελίδα πηγής">→</button><label>Είδος αποσπάσματος<select data-kind><option value="exercise">Άσκηση με κενά → Πινακοθήκη</option><option value="mindmap">Εννοιολογικός χάρτης → Σχολή εννοιών</option><option value="image">Άλλη εικόνα → Πινακοθήκη</option><option value="ignore">Χειρόγραφη σημείωση → Αγνόηση</option></select></label></div><div class="ni-source-page"><canvas aria-label="Σελίδα σημειώσεων"></canvas><svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Επιλογή περιοχής στη σελίδα"></svg></div><div data-region-list></div>`;
  host.append(wrapper);let current=start,canvas=null,drag=null,epoch=0;const regions=[],visited=new Set(),overlay=wrapper.querySelector('svg');
  function paint(extra=null){overlay.innerHTML=[...regions.filter(r=>r.page===current),...(extra?[extra]:[])].map(r=>`<rect x="${r.x*1000}" y="${r.y*1000}" width="${r.w*1000}" height="${r.h*1000}"/>`).join('');
    wrapper.querySelector('[data-region-list]').innerHTML=regions.map(r=>`<div class="ni-region-row"><span>${lmEscape(r.label)} · σελ. ${r.page}</span><button type="button" data-remove-region="${r.id}" aria-label="Αφαίρεση αποσπάσματος: ${lmEscape(r.label)}">Αφαίρεση</button></div>`).join('')||'<p>Δεν έχουν οριστεί αποσπάσματα εικόνας. Μπορείς να συνεχίσεις με το κείμενο ή να ορίσεις περιοχή.</p>';
    wrapper.querySelectorAll('[data-remove-region]').forEach(b=>b.onclick=()=>{const i=regions.findIndex(r=>r.id===b.dataset.removeRegion);regions.splice(i,1);paint();});
  }
  async function page(number){const my=++epoch;current=number;canvas=await niPageCanvas(file,pdf,current);if(my!==epoch)return;const shown=wrapper.querySelector('canvas');shown.width=canvas.width;shown.height=canvas.height;shown.getContext('2d').drawImage(canvas,0,0);
    if(!visited.has(current)){visited.add(current);const small=document.createElement('canvas');small.width=500;small.height=Math.round(500*canvas.height/canvas.width);small.getContext('2d').drawImage(canvas,0,0,small.width,small.height);for(const r of niDarkPanels(small.getContext('2d').getImageData(0,0,small.width,small.height)))regions.push({id:lmId(),page:current,kind:'exercise',label:'Άσκηση με κενά',...r});}
    wrapper.querySelector('[data-page-label]').textContent=`Σελίδα ${current}`;wrapper.querySelector('[data-prev]').disabled=current<=start;wrapper.querySelector('[data-next]').disabled=current>=end;paint();
  }
  const point=e=>{const rect=overlay.getBoundingClientRect();return {x:lmClamp((e.clientX-rect.left)/rect.width,0,1),y:lmClamp((e.clientY-rect.top)/rect.height,0,1)};};
  const rect=(a,b)=>({x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y)});
  overlay.onpointerdown=e=>{if(regions.length>=40)return;e.preventDefault();drag=point(e);overlay.setPointerCapture(e.pointerId);};
  overlay.onpointermove=e=>{if(drag)paint(rect(drag,point(e)));};
  overlay.onpointerup=e=>{if(!drag)return;const r=rect(drag,point(e));drag=null;if(r.w>.025&&r.h>.025){const kind=wrapper.querySelector('[data-kind]').value;regions.push({id:lmId(),page:current,kind,label:kind==='exercise'?'Άσκηση με κενά':kind==='mindmap'?'Εννοιολογικός χάρτης':kind==='ignore'?'Αγνόηση χειρόγραφου':'Εικόνα μαθήματος',...r});}paint();};overlay.onpointercancel=()=>{drag=null;paint();};
  wrapper.querySelector('[data-prev]').onclick=()=>void page(current-1);wrapper.querySelector('[data-next]').onclick=()=>void page(current+1);
  await page(start);
  return {start,end,regions,async files(){const crops=[];for(const r of regions.filter(r=>r.kind!=='ignore')){const page=await niPageCanvas(file,pdf,r.page),crop=document.createElement('canvas');crop.width=Math.max(1,Math.round(r.w*page.width));crop.height=Math.max(1,Math.round(r.h*page.height));crop.getContext('2d').drawImage(page,r.x*page.width,r.y*page.height,r.w*page.width,r.h*page.height,0,0,crop.width,crop.height);const blob=await new Promise(resolve=>crop.toBlob(resolve,'image/png'));if(!blob)throw Error('Δεν δημιουργήθηκε το απόσπασμα.');crops.push({...r,file:new File([blob],`notes-${r.kind}-${crops.length+1}.png`,{type:'image/png'})});}return crops;},destroy(){++epoch;wrapper.remove();}};
}
