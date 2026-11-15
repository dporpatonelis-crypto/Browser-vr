import {lmId,lmNewCanvas,lmEscape} from './lesson-map-domain.mjs';

export const niNormalize = text => String(text||'').normalize('NFD').replace(/\p{M}/gu,'').toLocaleLowerCase('el').replace(/ς/g,'σ');
const NI_STOP = new Set(niNormalize('και του της την τον των στο στον στην από για που είναι ένα μια ένας με σε το τα τη τις τους ο η οι να ως ή θα δεν μας σας τουσ στη τού στον θεός θεού άνθρωπος ανθρώπου μάθημα εικόνα κείμενο δραστηριότητα διαφάνειες html digital book powerpoint γυμνασίου λυκείου μετά κατά είπε δίνει γιατί σου όλη προς ήταν τότε έχει αυτή αυτός μαζί χωρίς μέσα μέσω').split(/\s+/));
export function niTerms(text,limit=12) {
  const counts=new Map();
  for(const word of String(text||'').match(/[\p{L}][\p{L}\p{M}’-]{3,}/gu)||[]){const key=niNormalize(word);if(NI_STOP.has(key))continue;const old=counts.get(key);counts.set(key,{word:old?.word||word,count:(old?.count||0)+1});}
  return [...counts.values()].sort((a,b)=>b.count-a.count).slice(0,limit).map(v=>v.word);
}
const NI_TOPICS=[
  ['Πτώση και συνέπειες','πτωσ|παρακοη|εδεμ|οδυν|προπατορ|εξορια'],
  ['Δημιουργία και ανθρώπινη κλήση','δημιουργ|κατ.? εικονα|ομοιωσ|χαρισμα|ταλαντ'],
  ['Απόστολος Παύλος','παυλ|αποστολοσ των εθνων|δαμασκ'],
  ['Γέννηση του Χριστού','γεννηση του χριστου|χριστοσ γενναται|χριστουγεν|βηθλεεμ'],
  ['Πεντηκοστή','πεντηκοστ|υπερωο|πνευμα συγκροτει'],
  ['Άγιος Λουκάς ο Ιατρός','λουκα|ιατροσ|χειρουργ'],
];
export function niMaterialTarget(a) {
  const label=niNormalize([a.label,a.native_id,a.reveal_mode].join(' '));
  if(['vr','canvas','model'].includes(a.kind)||(!a.url&&!a.download_url))return null;
  if(a.kind==='image'||/\.(png|jpe?g|webp)([?#]|$)/i.test(a.url||''))return {building:/εννοι|mind.?map|concept/.test(label)?'mindmap':'images',type:'image'};
  if(a.kind==='pdf'||/\.pdf([?#]|$)/i.test(a.url||''))return {building:'text',type:'pdf'};
  if(['html','quiz'].includes(a.kind))return {building:'html',type:'html'};
  return {building:/mind.?map|concept|εννοιολογ|χαρτησ/.test(label)?'mindmap':['book','text'].includes(a.kind)?'text':'html',type:'html'};
}
/** Transparent retrieval clues, not a claim of AI comprehension. Teacher confirms each selection. */
export function niFindMaterials(registry,{title='',text='',focus='',query=''}={}) {
  const prompt=niNormalize([title,focus,query,text.slice(0,50000)].join(' '));
  const terms=[...new Set(niTerms([title,focus,query].join(' '),20).concat(niTerms(text,18)).map(niNormalize))];
  const topics=NI_TOPICS.filter(([,pattern])=>new RegExp(pattern).test(prompt));
  const rows=[];
  for(const s of registry.scenarios){
    if(s.private)continue;
    const parent=niNormalize([s.title,s.inquiry_question,...s.objectives||[],...s.aliases||[]].join(' '));
    for(const a of s.activities){
      const target=niMaterialTarget(a);if(!target)continue;
      const direct=niNormalize([a.label,a.note,a.native_id,...(a.content_preview||[]).map(p=>p.title+' '+p.text)].join(' ')),label=niNormalize(a.label);
      const hits=terms.filter(t=>direct.includes(t)||parent.includes(t));
      const topicHits=topics.filter(([,pattern])=>new RegExp(pattern).test(label+' '+parent));
      let score=hits.reduce((n,t)=>n+(label.includes(t)?3:direct.includes(t)?1.5:.35),0)+topicHits.length*3;
      if(query){const q=niNormalize(query);if(label.includes(q))score+=12;}
      if(score<2)continue;
      const reasons=[...topicHits.map(t=>t[0]),...hits.slice(0,4)];
      rows.push({key:s.scenario_id+'|'+a.id,scenario_id:s.scenario_id,scenario_title:s.title,activity:a,...target,score,reasons:[...new Set(reasons)],evidence:a.note||s.inquiry_question||s.objectives?.[0]||s.title});
    }
  }
  const ids=new Set();return rows.sort((a,b)=>b.score-a.score||a.activity.label.localeCompare(b.activity.label,'el')).filter(r=>{const key=r.activity.id;if(ids.has(key))return false;ids.add(key);return true;}).slice(0,60);
}
export function niMaterial(row){return {id:lmId(),label:row.activity.label,type:row.type,text:'',url:'',asset_id:'',activity_id:row.activity.id,source_scenario_id:row.scenario_id,page_start:1,page_end:1};}
export function niSourceMaterial(type,label,extra={}){return {id:lmId(),type,label:label.slice(0,240),text:'',url:'',asset_id:'',activity_id:'',source_scenario_id:'',page_start:1,page_end:1,...extra};}
export function niExistingImport(documents,sha,start,end){return [...documents].find(([,row])=>{const s=row.document.import_source;return s?.sha256===sha&&s.page_start===start&&s.page_end===end;});}
export function niBuildCanvas({id,title,grade,source,text,terms,focus,selected}) {
  const doc=lmNewCanvas(title,'notes:'+id);doc.grade=grade;doc.registered=true;doc.presentation.hide_empty=false;
  doc.import_source={...source,focus:focus||'',keywords:terms,related_scenario_ids:[...new Set(selected.map(r=>r.scenario_id))]};
  const add=(bid,m)=>doc.buildings.find(b=>b.id===bid).materials.push(m);
  if(text.trim())add('text',niSourceMaterial('text','Κείμενο σημειώσεων · ελεγμένο από τον εκπαιδευτικό',{text:text.slice(0,100000)}));
  add('text',niSourceMaterial(source.type,'Πρωτότυπο · '+source.name,{asset_id:source.asset_id,page_start:source.page_start,page_end:source.page_end}));
  for(const r of selected)add(r.building,niMaterial(r));
  if(focus)add('synthesis',niSourceMaterial('text','Ερώτημα σύνθεσης',{text:focus}));
  return doc;
}
