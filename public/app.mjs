import {filterScenarios, relevantHistory, latestPlans, materialChoices} from './domain.mjs';

const app = document.querySelector('#app');
const cloud = window.__MISSION_CLOUD__ || null;
const catalogueMode = !!document.querySelector('meta[name="mission-mode"]');
const asset = path => cloud ? new URL(path, cloud.assetBase).href : path;
const rpc = (name, ...args) => new Promise((resolve, reject) => {
  google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[name](...args);
});
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => new Date(value).toLocaleDateString('el-GR', {day:'numeric',month:'short',year:'numeric',timeZone:'Europe/Athens'});
const icons = {
  book:'<path d="M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2z"/><path d="M12 6v15"/>',
  arrow:'<path d="M4 12h15m-6-6 6 6-6 6"/>',
  play:'<path d="m9 5 11 7-11 7z"/>',
  check:'<path d="m5 12 4 4L20 5"/><path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h8"/>',
  search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  external:'<path d="M14 3h7v7m0-7L11 13M10 3H4v17h17v-6"/>',
  vr:'<rect x="2" y="6" width="20" height="12" rx="4"/><path d="M8 12h.1m8 0h.1m-8 6 4-4 4 4"/>',
  slides:'<rect x="3" y="3" width="18" height="14" rx="2"/><path d="M12 17v4m-4 0h8M7 8h10m-10 4h6"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icon = (name, cls='') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.book}</svg>`;
const getJson = async url => {
  if (cloud) {
    if (url === 'api/registry') return cloud.registry;
    if (url === 'api/models') return cloud.models;
    if (url === 'api/evaluations') return rpc('listEvaluations');
    if (url === 'api/plans') return rpc('listPlans');
  }
  const r = await fetch(url,{cache:'no-store'}); if (!r.ok) throw Error(`Η ανάγνωση απέτυχε (${r.status}).`); return r.json();
};
const postJson = async (url, data) => {
  if (cloud && url === 'api/evaluations') return rpc('saveEvaluation', data);
  if (cloud && url === 'api/plans') return rpc('savePlan', data);
  const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Mission-Control':'teacher-action'},body:JSON.stringify(data)});
  const body = await r.json(); if (!r.ok) throw Error(body.error || 'Η αποθήκευση δεν ολοκληρώθηκε.'); return body;
};
const uuid = () => crypto.randomUUID?.() ?? '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c => (Number(c)^crypto.getRandomValues(new Uint8Array(1))[0]&15>>Number(c)/4).toString(16));
let remembered = {};
try { remembered = JSON.parse(sessionStorage.getItem('mission-context') || '{}'); } catch {}
const state = {registry:null,models:null,view:'select',selected:null,grade:remembered.grade || '',section:remembered.section || '',
  modelId:remembered.modelId || 'guided-exploration',filters:{search:'',goal:'',subject:'',source:'',includeUnknown:false},
  classProfile:'',timeSlot:'',lessonDate:new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Athens'}),
  service:false,records:[],plans:[],planError:'',planDrafts:new Map(),teaching:false,historyError:'',drafts:new Map(),notice:'',refreshing:false,saving:false,planning:false};
const selected = () => state.registry.scenarios.find(s => s.scenario_id === state.selected);
const model = () => state.models.models.find(m => m.id === state.modelId) || state.models.models[0];
function contextKey() { return state.selected; }
function draft() {
  const key=contextKey();
  if (!state.drafts.has(key)) state.drafts.set(key,{flags:new Set(),used:new Set(),usageConfirmed:false,requestId:uuid(),saved:false,error:'',difficulty:selected()?.cognitive_difficulty ?? ''});
  return state.drafts.get(key);
}
function planDraft() {
  if (!state.planDrafts.has(state.selected)) state.planDrafts.set(state.selected,{ids:[],notes:'',requestId:uuid(),saved:null,error:''});
  return state.planDrafts.get(state.selected);
}
function sessionData() {return {grade:state.grade,section:state.section.trim(),model_id:model().id,class_profile:state.classProfile.trim(),time_slot:state.timeSlot,lesson_date:state.lessonDate};}
function planContent() {const p=planDraft();return {scenario_id:state.selected,...(p.context||sessionData()),planned_material_ids:p.ids,notes:p.notes.trim()};}
function applyContext(c) {state.grade=c.grade;state.section=c.section;state.modelId=c.model_id;state.classProfile=c.class_profile;state.timeSlot=c.time_slot;state.lessonDate=c.lesson_date;}
function planDirty() {
  const p=planDraft(),s=p.saved;
  return !s || JSON.stringify(planContent())!==JSON.stringify({scenario_id:s.scenario_id,grade:s.grade,section:s.section,model_id:s.model_id,class_profile:s.class_profile,time_slot:s.time_slot,lesson_date:s.lesson_date,planned_material_ids:s.planned_materials.map(a=>a.id),notes:s.notes});
}
function changed(evaluationOnly=false) {
  if (!evaluationOnly) {planDraft().requestId=uuid();planDraft().error='';planDraft().context=sessionData();}
  const d=draft();d.requestId=uuid();d.saved=false;d.error='';
}
const timeLabel=slot=>({morning:'Πρωινή',midday:'Προς το μεσημέρι'}[slot] || 'Ώρα χωρίς χαρακτηρισμό');
function openPlan(id) {
  const p=state.plans.find(p=>p.id===id);if(!p)return;
  state.planDrafts.set(state.selected,{ids:p.planned_materials.map(a=>a.id),notes:p.notes,requestId:uuid(),saved:p,error:'',context:{grade:p.grade,section:p.section,model_id:p.model_id,class_profile:p.class_profile,time_slot:p.time_slot,lesson_date:p.lesson_date}});
  state.grade=p.grade;state.section=p.section;state.modelId=p.model_id;state.classProfile=p.class_profile;state.timeSlot=p.time_slot;state.lessonDate=p.lesson_date;
  state.drafts.delete(contextKey());remember();state.teaching=true;render(true);
}
function remember() { try { sessionStorage.setItem('mission-context',JSON.stringify({grade:state.grade,section:state.section,modelId:state.modelId})); } catch {} }
function announce(text) { document.querySelector('#announcement').textContent=text; }
function link(url,label,cls='',extra='') {
  try { if (!['http:','https:'].includes(new URL(url,location.href).protocol)) return ''; } catch { return ''; }
  return `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" ${extra}>${label}</a>`;
}
function privateSpace(view='evaluate') {
  const url=state.registry.publication?.cloud_url;
  if (!url || cloud) return '';
  const target=new URL(url);
  if (state.selected) { target.searchParams.set('scenario',state.selected);target.searchParams.set('view',view); }
  if (state.grade) target.searchParams.set('grade',state.grade);
  if (state.grade && state.section) target.searchParams.set('section',state.section);
  target.searchParams.set('model',state.modelId);
  if (state.selected && planDraft().ids.length) target.searchParams.set('materials',planDraft().ids.join(','));
  return link(target.href,'Στον ιδιωτικό χώρο '+icon('external'),'button secondary');
}
function header() {
  const steps=[['select','book','Επιλογή μαθήματος','Η αφετηρία της τάξης'],['activity','play','Σχέδιο μαθήματος','Επιλογές και διδασκαλία'],['evaluate','check','Τι έγινε στην τάξη','Μέσα και αξιολόγηση']];
  return `<header class="header"><div class="brand"><img src="${esc(asset('icon.svg'))}" alt="" width="42" height="42"><div><span class="brand-title">Πιλοτήριο τάξης</span><span class="brand-subtitle">TEACHING MISSION CONTROL</span></div></div><div class="header-right"><span class="teacher-mark"><i class="status-dot ${state.service?'':'offline'}"></i>${cloud?'Ιδιωτικός χώρος · cloud':state.service?'Χώρος εκπαιδευτικού':'Online κατάλογος'}</span>${!state.service?privateSpace('activity'):''}${link(state.registry.integrations.digital_book.url,icon('book')+' Το ψηφιακό μου βιβλίο '+icon('external'),'book-link')}</div></header>
  <nav class="steps" aria-label="Πορεία μαθήματος">${steps.map(([id,ic,title,caption],i)=>`<button class="step ${state.view===id?'active':''}" data-view="${id}" ${id!=='select'&&!state.selected?'disabled title="Επίλεξε πρώτα ένα σενάριο"':''} ${state.view===id?'aria-current="step"':''}><span class="step-number">0${i+1}</span><span class="step-copy"><strong>${title}</strong><small>${caption}</small></span>${icon(ic)}</button>`).join('')}</nav>`;
}
function gradeOptions(empty='Όλες οι τάξεις') { return `<option value="">${empty}</option>`+state.registry.grades.map(g=>`<option ${g===state.grade?'selected':''}>${esc(g)}</option>`).join(''); }
function badges(s) { return s.formats.map(f=>`<span class="badge ${f==='Unity VR'?'vr-badge':''}">${esc(f)}</span>`).join(''); }
function selectView() {
  const all=state.registry.scenarios;
  const results=filterScenarios(all,{...state.filters,grade:state.grade});
  const subjects=[...new Set(all.map(s=>s.subject))].sort((a,b)=>a.localeCompare(b,'el'));
  return `<section class="view-intro"><div><p class="eyebrow">ΤΟ ΜΑΘΗΜΑ ΣΗΜΕΡΑ</p><h1 id="view-title" tabindex="-1">Τι θα εξερευνήσουμε σήμερα;</h1><p>Το υπάρχον υλικό σου, συγκεντρωμένο γύρω από το μάθημα.</p></div><div class="intro-symbol">${icon('book')}</div></section>
  <div class="selection-layout"><aside class="filters panel" aria-label="Φίλτρα μαθημάτων"><h2>Βρες το μάθημά σου</h2><label for="grade">Τάξη</label><select id="grade" data-context="grade">${gradeOptions()}</select>
  <label for="search">Μάθημα ή θέμα</label><div class="search-field">${icon('search')}<input type="search" id="search" data-filter="search" value="${esc(state.filters.search)}" placeholder="π.χ. Αβραάμ, ελευθερία"></div>
  <label for="subject">Γνωστικό αντικείμενο</label><select id="subject" data-filter="subject"><option value="">Όλα τα αντικείμενα</option>${subjects.map(t=>`<option value="${esc(t)}" ${state.filters.subject===t?'selected':''}>${esc(t)}</option>`).join('')}</select>
  <label for="goal">Διδακτικός στόχος</label><input id="goal" data-filter="goal" value="${esc(state.filters.goal)}" placeholder="π.χ. αντιστοίχιση, ερμηνεία">
  <label for="source">Διαθέσιμο υλικό</label><select id="source" data-filter="source"><option value="">Όλες οι μορφές</option>${['Digital Book','Slides','HTML','Unity VR','Drive HTML'].map(f=>`<option ${state.filters.source===f?'selected':''}>${esc(f)}</option>`).join('')}</select>
  <label class="checkbox-row"><input type="checkbox" id="include-unknown" data-filter="includeUnknown" ${state.filters.includeUnknown?'checked':''}><span>Και μαθήματα με τάξη προς επιβεβαίωση</span></label>
  <button class="text-button" id="clear-filters">Καθαρισμός φίλτρων</button><div class="filter-note">${icon('book')}<p>Το Digital Book παραμένει το βιβλίο της τάξης. Εδώ επιλέγεις υλικό και κρατάς τις δικές σου επισημάνσεις.</p></div></aside>
  <section class="results" aria-label="Χαρτογραφημένα σενάρια"><div class="results-heading"><h2>Χαρτογραφημένα μαθήματα <span class="count">${results.length}</span></h2><span>${state.grade?esc(state.grade):'Η βιβλιοθήκη σου'}</span></div><div class="cards">${results.map(s=>card(s)).join('') || `<div class="empty panel"><h2>Δεν βρέθηκε μάθημα με αυτά τα φίλτρα.</h2><p>Δοκίμασε άλλο θέμα ή συμπερίλαβε μαθήματα με τάξη προς επιβεβαίωση.</p></div>`}</div></section></div>`;
}
function card(s) {
  const h=relevantHistory(state.records,s.scenario_id,state.grade,state.section);
  const isNew = !h.latest;
  const family=s.source_groups.includes('Digital Book')?'ΑΠΟ ΤΟ ΨΗΦΙΑΚΟ ΒΙΒΛΙΟ':s.source_groups.includes('Drive HTML')?'ΔΙΑΔΡΑΣΤΙΚΗ ΔΡΑΣΤΗΡΙΟΤΗΤΑ':s.source_groups.includes('Google Drive')?'ΑΠΟ ΤΟ GOOGLE DRIVE':'ΑΠΟ ΤΗ ΒΙΒΛΙΟΘΗΚΗ ΜΑΘΗΜΑΤΩΝ';
  const grade=s.grades.length===6?'Δευτεροβάθμια εκπαίδευση':s.grades.join(' · ') || 'Τάξη προς επιβεβαίωση';
  const question=s.inquiry_question || (s.objectives[0]?.length<240?s.objectives[0]:'') || s.pedagogical_application;
  const plans=latestPlans(state.plans,s.scenario_id).length;
  return `<article class="scenario-card"><div class="card-top"><span class="eyebrow">${family}</span>${icon(s.formats.includes('Unity VR')?'vr':s.formats.includes('Slides')?'slides':'book')}</div><h3>${esc(s.title)}</h3><p class="card-grade">${esc(grade)}</p><p class="card-description">${esc(question)}</p><div class="badges">${badges(s)}${plans?`<span class="badge">${plans} αποθηκευμέν${plans===1?'ο σχέδιο':'α σχέδια'}</span>`:''}</div><div class="card-bottom"><span class="history-mini ${h.latest?.flags.includes('worked-well')?'positive':''}">${!state.service?'Ιδιωτικό ιστορικό στον χώρο εκπαιδευτικού':state.historyError?'Ιστορικό μη διαθέσιμο':isNew?'Δεν έχει καταγραφεί εφαρμογή':`${h.summary.total} εφαρμογ${h.summary.total===1?'ή':'ές'} · ${h.summary.positive} θετικές`}</span><button class="choose" data-select="${esc(s.scenario_id)}" aria-label="Επιλογή: ${esc(s.title)}">Επιλογή ${icon('arrow')}</button></div></article>`;
}
function sessionContext() {
  return `<div class="session-context"><div><label for="session-grade">Η τάξη μου</label><select id="session-grade" data-context="grade">${gradeOptions('Χωρίς επιλογή τάξης')}</select></div><div><label for="section">Τμήμα <span class="optional">προαιρετικό</span></label><input id="section" data-context="section" value="${esc(state.section)}" maxlength="40" placeholder="π.χ. Β1" ${state.grade?'':'disabled'}></div><div class="context-model"><label for="model">Παιδαγωγικό μοντέλο</label><select id="model" data-context="modelId">${state.models.models.map(m=>`<option value="${esc(m.id)}" ${model().id===m.id?'selected':''}>${esc(m.title)}</option>`).join('')}</select></div>
  <div><label for="lesson-date">Ημερομηνία μαθήματος</label><input id="lesson-date" type="date" data-context="lessonDate" value="${esc(state.lessonDate)}"></div><div><label for="time-slot">Ώρα μαθήματος</label><select id="time-slot" data-context="timeSlot"><option value="">Χωρίς χαρακτηρισμό</option>${['morning','midday'].map(t=>`<option value="${t}" ${state.timeSlot===t?'selected':''}>${timeLabel(t)}</option>`).join('')}</select></div><div><label for="class-profile">Εικόνα του τμήματος <span class="optional">προαιρετικό</span></label><input id="class-profile" data-context="classProfile" maxlength="240" value="${esc(state.classProfile)}" placeholder="π.χ. συμμετοχικό, χρειάζεται καθοδήγηση"><small class="privacy-note">Σύντομη περιγραφή, χωρίς ονόματα μαθητών.</small></div></div>`;
}
function recordDetails(r) {
  const plan=r.lesson_plan;
  return `<p>${esc([r.class_profile,r.time_slot?timeLabel(r.time_slot):'',r.lesson_date?'Μάθημα: '+date(r.lesson_date):''].filter(Boolean).join(' · '))}</p>${plan?`<p><strong>Σχεδιάστηκαν:</strong> ${esc(plan.planned_materials.map(a=>a.label).join(' · ')||'Χωρίς ψηφιακά μέσα')}</p>`:''}<p><strong>Χρησιμοποιήθηκαν:</strong> ${r.media_usage_recorded?esc(r.used_materials.map(a=>a.label).join(' · ')||'Κανένα από τα καταγεγραμμένα μέσα'):'Δεν καταγράφηκαν στην παλαιότερη αξιολόγηση.'}</p>`;
}
function previous(s, full=true) {
  if (state.historyError) return `<div class="notice error" role="alert">${esc(state.historyError)}</div>`;
  if (!state.service) return `<div class="notice">Το ιστορικό εμφανίζεται στον ιδιωτικό χώρο του εκπαιδευτικού. ${privateSpace()}</div>`;
  const h=relevantHistory(state.records,s.scenario_id,state.grade,state.section);
  if (!h.latest) return `<div class="previous fresh"><span class="previous-symbol">○</span><div><strong>Η πρώτη σου καταγραφή ξεκινά εδώ.</strong><p>Μετά τη δραστηριότητα, κράτησε μια σύντομη επισήμανση για την επόμενη φορά.</p></div></div>`;
  const r=h.latest;
  const positive=r.flags.every(f=>f==='worked-well');
  const context=[r.grade,r.section].filter(Boolean).join(' · ');
  const labels=r.flags.map(f=>r.flag_labels?.[f] || state.models.flags.find(x=>x.id===f)?.label || f);
  return `<section class="previous ${positive?'positive':'attention'}" aria-label="Προηγούμενη εφαρμογή"><span class="previous-symbol">${positive?'✓':'!'}</span><div><p class="eyebrow">ΓΙΑ ΤΗΝ ΕΠΟΜΕΝΗ ΦΟΡΑ · ${h.scope==='section'?'ΙΔΙΟ ΤΜΗΜΑ':h.scope==='grade'?'ΙΔΙΑ ΤΑΞΗ':'ΠΡΟΣΦΑΤΗ ΚΑΤΑΓΡΑΦΗ'}</p><strong>${positive?'Η δραστηριότητα λειτούργησε πολύ καλά'+(context?' · '+esc(context):''):esc(labels.join(' · '))}</strong><p>${date(r.created_at)}${context?' · '+esc(context):''} · ${esc(r.model_title || r.model_id)}</p>${h.summary.total>=3?`<p class="history-summary">${h.summary.total} εφαρμογές · ${h.summary.positive} θετικές · ${h.summary.increased_difficulty} με αυξημένη δυσκολία. Περιγραφικές καταγραφές, χωρίς συμπέρασμα αποτελεσματικότητας.</p>`:''}
  ${recordDetails(r)}${full?`<details class="history-details"><summary>Ιστορικό εφαρμογών (${h.summary.total})</summary><ol>${h.records.map(x=>`<li><time>${date(x.created_at)}</time><span>${esc([x.grade,x.section].filter(Boolean).join(' · ') || 'Χωρίς επιλογή τάξης')}</span><p>${esc(x.flags.map(f=>x.flag_labels?.[f]||state.models.flags.find(a=>a.id===f)?.label||f).join(' · '))}</p><small>${esc(x.model_title || x.model_id)}</small>${recordDetails(x)}</li>`).join('')}</ol></details>`:''}</div></section>`;
}
function selectedIntro(s, eyebrow) {
  return `<section class="view-intro selected-intro"><div><button class="text-button back" data-view="select">← Πίσω στα μαθήματα</button><p class="eyebrow">${eyebrow}</p><h1 id="view-title" tabindex="-1">${esc(s.title)}</h1><div class="badges">${badges(s)}</div></div></section>`;
}
function activityCard(a) {
  const choice=`<label class="material-choice"><input type="checkbox" data-planned="${esc(a.id)}" ${planDraft().ids.includes(a.id)?'checked':''}><span>Στο σχέδιο μαθήματος</span></label>`;
  if (a.kind==='vr') return `<article class="material vr-material">${icon('vr')}<div><span class="material-kind">UNITY VR · ΤΟΠΙΚΗ ΑΠΟΣΤΟΛΗ</span><h3>${esc(a.label)}</h3><p>${esc(a.room || '')}</p><p>${esc(a.note)}</p>${choice}<details><summary>Πληροφορία τοπικής αποστολής</summary><p class="source-path">${esc(state.registry.source_files.find(x=>x.key===a.source_key)?.path || '')}</p><p>Άνοιξε την αποστολή από την υπάρχουσα διαδικασία του Unity project.</p></details></div></article>`;
  const kind={book:'DIGITAL BOOK',slides:'ΔΙΑΦΑΝΕΙΕΣ',html:'ΔΙΑΔΡΑΣΤΙΚΗ ΕΦΑΡΜΟΓΗ',quiz:'QUIZ',text:'ΚΕΙΜΕΝΟ',model:'3D ΜΟΝΤΕΛΟ · ΥΛΙΚΟ ΓΙΑ ΠΡΟΕΤΟΙΜΑΣΙΑ'}[a.kind];
  const target=state.service && a.local_url ? a.local_url : a.url;
  if (!target) return '';
  const label= a.drive_html && !a.local_url?'Άνοιγμα στο Drive':a.kind==='book'?'Στο βιβλίο':a.kind==='slides'?'Άνοιγμα διαφανειών':a.kind==='model'?'Άνοιγμα μοντέλων':'Άνοιγμα δραστηριότητας';
  return `<article class="material">${icon(a.kind==='slides'?'slides':a.kind==='book'||a.kind==='text'?'book':'play')}<div><span class="material-kind">${kind}${a.slide_count?' · '+a.slide_count+' διαφάνειες':''}</span><h3>${esc(a.label)}</h3>${a.note?`<p>${esc(a.note)}</p>`:''}<div class="material-links">${link(target,label+' '+icon('external'),'button secondary')}${a.drive_html?link(a.download_url,'Λήψη HTML','small-link'):''}${a.lesson_download_url?link(a.lesson_download_url,'Λήψη μαθήματος','small-link'):''}${state.service&&a.app==='interactive-sculpture'&&a.url?link(a.url,'Online εφαρμογή','small-link'):''}</div>
  ${choice}${a.content_preview?.length?`<details class="content-preview"><summary>Τι περιέχει η παρουσίαση;</summary><ol>${a.content_preview.map(p=>`<li>${link(p.url,esc(p.title))}<p>${esc(p.text)}</p></li>`).join('')}</ol></details>`:''}</div></article>`;
}
function planPanel() {
  const p=planDraft(),s=selected(),choices=materialChoices(s,p.saved),saved=latestPlans(state.plans,state.selected);
  const materials=p.ids.map(id=>choices.find(a=>a.id===id)).filter(Boolean);
  const route=p.saved&&!planDirty()?p.saved.route:model().steps.filter(st=>!st.requires||s.activities.some(a=>a.kind===st.requires));
  const objectives=p.saved&&!planDirty()?p.saved.objectives:s.objectives;
  return `<section class="panel lesson-plan ${state.teaching?'teaching-plan':''}" aria-label="Το σχέδιο μαθήματος"><div class="plan-heading"><div><p class="eyebrow">ΠΡΙΝ ΚΑΙ ΚΑΤΑ ΤΗ ΔΙΔΑΣΚΑΛΙΑ</p><h2>Το σχέδιο μαθήματός μου</h2><p class="muted">${esc([state.grade,state.section,state.timeSlot?timeLabel(state.timeSlot):'',state.lessonDate?date(state.lessonDate):''].filter(Boolean).join(' · '))}</p></div><div class="plan-actions"><button class="button secondary" id="teaching-mode">${state.teaching?'Επεξεργασία σχεδίου':'Προβολή για διδασκαλία'}</button><button class="text-button" id="new-plan">Νέο σχέδιο</button></div></div>
  ${state.planError?`<div class="notice error">${esc(state.planError)}</div>`:''}${saved.length?`<details class="saved-plans"><summary>Τα αποθηκευμένα σχέδια για αυτό το μάθημα (${saved.length})</summary>${saved.map(x=>`<div><span>${esc([x.lesson_date?date(x.lesson_date):date(x.created_at),x.grade,x.section,x.time_slot?timeLabel(x.time_slot):''].filter(Boolean).join(' · '))}<small>${x.planned_materials.length} μέσα · ${esc(x.model_title)}</small></span><button class="button secondary" data-open-plan="${esc(x.id)}">Άνοιγμα σχεδίου</button></div>`).join('')}</details>`:''}
  ${state.classProfile?`<p class="plan-profile">${esc(state.classProfile)}</p>`:''}<div class="plan-grid"><div><h3>Τα μέσα που επέλεξα <span class="count">${materials.length}</span></h3>${materials.length?`<ol class="plan-materials">${materials.map((a,i)=>{const current=s.activities.find(x=>x.id===a.id);const target=a.kind==='vr'?'':state.service&&current?.local_url?current.local_url:a.url;return `<li><div><strong>${esc(a.label)}</strong>${a.room?`<small>${esc(a.room)}</small>`:''}${a.unavailable?'<small class="missing-material">Η παλιά επιλογή απουσιάζει από τον σημερινό κατάλογο. Έλεγξε τη διαθεσιμότητά της.</small>':''}</div><div class="plan-actions">${target?link(target,'Άνοιγμα '+icon('external'),'button secondary'):'<small>Άνοιγμα από το Unity project</small>'}${!state.teaching?`<button class="text-button" data-move-material="${esc(a.id)}" ${i===0?'disabled':''} aria-label="Νωρίτερα: ${esc(a.label)}">↑</button><button class="text-button" data-remove-material="${esc(a.id)}" aria-label="Αφαίρεση: ${esc(a.label)}">Αφαίρεση</button>`:''}</div></li>`;}).join('')}</ol>`:'<p class="muted">Σημείωσε «Στο σχέδιο μαθήματος» στις κάρτες υλικού παρακάτω. Η σειρά των επιλογών είναι και η σειρά στο σχέδιο.</p>'}
  <label for="plan-notes" class="field-label">Η δική μου πορεία / σημειώσεις <span class="optional">προαιρετικό</span></label>${state.teaching?`<p class="plan-notes">${esc(p.notes||'Δεν έχουν προστεθεί σημειώσεις.')}</p>`:`<textarea id="plan-notes" rows="3" maxlength="2000" placeholder="π.χ. Ερώτημα εκκίνησης → διαφάνειες → ομάδες στο VR → συζήτηση">${esc(p.notes)}</textarea>`}</div><div><h3>${esc(p.saved&&!planDirty()?p.saved.model_title:model().title)}</h3><ol class="compact-route">${route.map(st=>`<li><strong>${esc(st.title)}</strong><p>${esc(st.description)}</p></li>`).join('')}</ol>${objectives.length?`<details ${state.teaching?'open':''}><summary>Διδακτικοί στόχοι</summary><ul>${objectives.map(o=>`<li>${esc(o)}</li>`).join('')}</ul></details>`:''}</div></div>
  ${p.error?`<div class="notice error" role="alert">${esc(p.error)} Οι επιλογές σου παραμένουν εδώ.</div>`:''}<div class="plan-save"><span role="status">${p.saved&&!planDirty()?'✓ Αποθηκευμένο ιδιωτικά · '+date(p.saved.created_at):p.saved?'Υπάρχουν αλλαγές προς αποθήκευση.':'Προσχέδιο · δεν έχει αποθηκευτεί.'}</span>${state.service?`<button class="button primary" id="save-plan" ${state.planning||state.saving||!planDirty()?'disabled':''}>${state.planning?'Αποθηκεύεται…':'Αποθήκευση σχεδίου'}</button>`:`<div>${privateSpace('activity')}<p class="privacy-note">Οι επιλογές υλικού μεταφέρονται στον ιδιωτικό χώρο. Εκεί συμπλήρωσε τα στοιχεία και τις σημειώσεις και αποθήκευσε το σχέδιο.</p></div>`}</div></section>`;
}
function activityView() {
  const s=selected(); const m=model();
  const hasVr=s.activities.some(a=>a.kind==='vr');
  if(state.teaching) return `${selectedIntro(s,'ΤΟ ΣΧΕΔΙΟ ΜΟΥ ΣΤΗΝ ΤΑΞΗ')}${planPanel()}<div class="next-bar"><p>Μετά τη διδασκαλία σημείωσε τι τελικά χρησιμοποιήθηκε.</p><button class="button primary" data-view="evaluate">Τι έγινε στην τάξη ${icon('arrow')}</button></div>`;
  return `${selectedIntro(s,'Ο ΣΧΕΔΙΑΣΜΟΣ ΤΟΥ ΜΑΘΗΜΑΤΟΣ')}${sessionContext()}${planPanel()}${previous(s)}
  <details class="panel route-guidance"><summary>Προετοιμασία και παιδαγωγική καθοδήγηση</summary><p class="muted">${esc(m.description)}</p><p class="preparation">${esc(m.preparation)}</p><p class="muted">${esc(s.pedagogical_application)}</p>${m.id==='asymmetric-html-vr'&&!hasVr?'<p class="notice">Δεν έχει τεκμηριωθεί τοπική αποστολή VR για αυτό το σενάριο.</p>':''}<p class="muted">Γνωστική δυσκολία: ${difficulty(s.cognitive_difficulty,'cognitive')} · Τεχνική δυσκολία: ${difficulty(s.technical_difficulty,'technical')}</p></details>
  <section class="materials"><div class="results-heading"><h2>Το διαθέσιμο υλικό σου</h2><span>Σημείωσε όσα θέλεις να εντάξεις στο σχέδιο.</span></div><div class="material-grid">${[...s.activities].sort((a,b)=>({book:0,text:1,slides:2,html:3,quiz:3,vr:4}[a.kind]??5)-({book:0,text:1,slides:2,html:3,quiz:3,vr:4}[b.kind]??5)).map(activityCard).join('') || '<div class="empty panel">Χρειάζεται επιβεβαίωση συνδέσμου.</div>'}</div>${s.readiness_note?`<p class="source-note">${esc(s.readiness_note)}</p>`:''}</section>
  <div class="next-bar"><p>Μετά τη δραστηριότητα, κράτησε ό,τι θα βοηθήσει την επόμενη φορά.</p><button class="button primary" data-view="evaluate">Αξιολόγηση εφαρμογής ${icon('arrow')}</button></div>${sourceNotes(s)}`;
}
function difficulty(level,kind) { return level?`${level}/5 · ${esc(state.models[kind+'_scale'].find(d=>d.level===Number(level))?.label)}`:'Προς επιβεβαίωση'; }
function sourceNotes(s) {
  const check=state.registry.integrations.source_refresh;
  const freshness=check?.checked_at?`<p>${check.status==='verified'?'Έλεγχος πηγών':'Έλεγχος με εκκρεμότητες'}: ${esc(date(check.checked_at))}. Η ημερομηνία συγχρονισμού μιας εφαρμογής διατηρείται χωριστά από τον σημερινό έλεγχο.</p>`:'';
  return `<details class="source-notes"><summary>Πηγές της χαρτογράφησης</summary>${freshness}<p>Ανάγνωση των υπαρχόντων αρχείων. Οι προτάσεις εφαρμογής είναι προτάσεις σχεδιασμού, όχι αποτελέσματα αξιολόγησης.</p>${s.notes.map(n=>`<p>${esc(n)}</p>`).join('')}<ul>${s.sources.map(src=>`<li><strong>${esc(src.system)}</strong><span class="source-path">${esc(src.path)}${src.locator?' · '+esc(src.locator):''}</span></li>`).join('')}</ul></details>`;
}
function evaluationView() {
  const s=selected(), d=draft();
  const p=planDraft(),choices=materialChoices(s,p.saved),planned=choices.filter(a=>p.ids.includes(a.id));
  return `${selectedIntro(s,'Η ΔΙΚΗ ΣΟΥ ΑΝΑΤΡΟΦΟΔΟΤΗΣΗ')}${sessionContext()}<div class="evaluation-layout"><section class="panel evaluation-panel"><section class="actual-materials"><p class="eyebrow">ΑΠΟ ΤΟ ΣΧΕΔΙΟ ΣΤΗΝ ΠΡΑΞΗ</p><h2>Ποια μέσα χρησιμοποιήθηκαν;</h2><p class="muted"><strong>Στο σχέδιο:</strong> ${esc(planned.map(a=>a.label).join(' · ')||'Χωρίς επιλεγμένα μέσα')}. Μπορείς να αφαιρέσεις όσα δεν πρόλαβες ή να προσθέσεις μέσα που χρησιμοποίησες επιπλέον.</p><button class="text-button" id="use-planned">Επιλογή των μέσων του σχεδίου</button><div class="used-options" role="group" aria-label="Μέσα που χρησιμοποιήθηκαν">${choices.map(a=>`<label class="usage-choice"><input type="checkbox" data-used="${esc(a.id)}" ${d.used.has(a.id)?'checked':''} ${!state.service?'disabled':''}><span><strong>${esc(a.label)}</strong><small>${p.ids.includes(a.id)?'Στο σχέδιο':'Εκτός σχεδίου'}${a.room?' · '+esc(a.room):''}${a.unavailable?' · παλιά επιλογή καταλόγου':''}</small></span></label>`).join('')}</div><label class="usage-confirm"><input type="checkbox" id="usage-confirmed" ${d.usageConfirmed?'checked':''} ${!state.service?'disabled':''}><span>Επιβεβαιώνω ότι οι επιλογές δείχνουν τι χρησιμοποιήθηκε τελικά${d.used.size?' ('+d.used.size+' μέσα)':' · δεν χρησιμοποιήθηκε κανένα από τα παραπάνω'}.</span></label></section><p class="eyebrow">Η ΛΕΙΤΟΥΡΓΙΑ ΤΟΥ ΜΑΘΗΜΑΤΟΣ</p><h2>Πώς λειτούργησε η δραστηριότητα;</h2><p class="muted">Επίλεξε μία ή περισσότερες επισημάνσεις. Δεν χρειάζεται γραπτή αναφορά.</p><div class="flag-options" role="group" aria-label="Επισημάνσεις εφαρμογής">${state.models.flags.map(f=>`<button class="flag ${d.flags.has(f.id)?'chosen':''}" data-flag="${f.id}" aria-pressed="${d.flags.has(f.id)}" ${state.saving||!state.service?'disabled':''}><span class="flag-icon">${f.icon}</span><span>${esc(f.label)}</span><span class="flag-check" aria-hidden="true">${d.flags.has(f.id)?'✓':'+'}</span></button>`).join('')}</div>
  <details class="difficulty-select"><summary>Γνωστική δυσκολία σχεδιασμού · ${d.difficulty?d.difficulty+'/5':'προαιρετική'}</summary><label for="cognitive">Επίπεδο, εφόσον είναι γνωστό</label><select id="cognitive"><option value="">Προς επιβεβαίωση</option>${state.models.cognitive_scale.map(x=>`<option value="${x.level}" ${Number(d.difficulty)===x.level?'selected':''}>${x.level}. ${esc(x.label)}</option>`).join('')}</select></details>
  ${!state.service?`<div class="notice"><p>Οι αξιολογήσεις παραμένουν ιδιωτικές στον Google λογαριασμό σου. Άνοιξε τον ιδιωτικό χώρο για να αποθηκεύσεις και να δεις το ιστορικό από κάθε συσκευή.</p>${privateSpace()}</div>`:''}${d.error?`<div class="notice error" role="alert">${esc(d.error)} Οι επιλογές σου παραμένουν εδώ.</div>`:''}${d.saved?`<div class="saved-message" role="status">✓ ${cloud?'Αποθηκεύτηκε στο ιδιωτικό cloud.':'Αποθηκεύτηκε στον δίσκο.'} Θα εμφανιστεί στην επόμενη επιλογή του σεναρίου.</div>`:''}
  <div class="save-row"><span>${state.grade?esc(state.grade)+(state.section?' · '+esc(state.section):''):'Χωρίς επιλογή τάξης'}<small>${esc(model().short_title || model().title)} · ${timeLabel(state.timeSlot)}</small></span><button class="button primary" id="save-evaluation" ${!state.service||!d.flags.size||!d.usageConfirmed||state.saving?'disabled':''}>${state.saving?'Αποθηκεύεται…':'Αποθήκευση αξιολόγησης'} ${icon('check')}</button></div><p class="privacy-note">Με την αξιολόγηση αποθηκεύεται και η τρέχουσα έκδοση του σχεδίου. Οι καταγραφές παραμένουν στον χώρο του εκπαιδευτικού.</p></section><aside class="evaluation-history"><h2>Από τις προηγούμενες εφαρμογές</h2>${previous(s)}<button class="text-button" data-view="activity">← Επιστροφή στο σχέδιο</button></aside></div>`;
}
function footer() {
  const drive=state.registry.integrations.google_drive;
  return `<footer class="footer"><span>Το υλικό σου. Η παιδαγωγική σου διαδρομή.</span><details class="integrations"><summary>Πηγές και διατήρηση</summary><div class="integration-content"><p><strong>Digital Book:</strong> έκδοση ${esc(state.registry.integrations.digital_book.revision || 'προς επιβεβαίωση')}. Το βιβλίο συνεχίζει να ενημερώνεται από την υπάρχουσα διαδικασία.</p><p><strong>Google Drive:</strong> ${drive.checked_at?'ανάγνωση '+date(drive.checked_at):'δεν έχει ολοκληρωθεί ανάγνωση'}. ${drive.folder?link(drive.folder.url,'Φάκελος ChatGPT'):''}</p><p>${cloud?'Η ανανέωση φορτώνει το ιδιωτικό ιστορικό σου.':state.service?'Η ανανέωση ξαναδιαβάζει τα τοπικά μαθήματα και το βιβλίο.':'Η online έκδοση περιέχει τον τελευταίο δημοσιευμένο κατάλογο.'} Για νέες παρουσιάσεις και HTML του Drive, ζήτησε ενημέρωση του καταλόγου. Η ημερομηνία ελέγχου διατηρείται.</p><div class="footer-actions"><button class="button secondary" id="refresh" ${!state.service||state.refreshing?'disabled':''}>${state.refreshing?'Ενημερώνεται…':cloud?'Ανανέωση ιστορικού':'Ανανέωση τοπικού καταλόγου'}</button>${cloud?'<button class="text-button" id="export-history">Λήψη σχεδίων και αξιολογήσεων</button>':state.service?link('api/export','Λήψη σχεδίων και αξιολογήσεων','small-link'):''}</div><p>${cloud?'Τα σχέδια και οι αξιολογήσεις αποθηκεύονται ως ξεχωριστά ιδιωτικά αρχεία στο Drive. Ο ίδιος Google λογαριασμός βλέπει το ίδιο ιστορικό από κάθε συσκευή.':state.service?'Οι αξιολογήσεις αποθηκεύονται στον δίσκο. Οι συσκευές που συνδέονται στην ίδια τοπική υπηρεσία βλέπουν το ίδιο ιστορικό.':'Η online σελίδα περιέχει μόνο τον κατάλογο. Οι αξιολογήσεις διατηρούνται στον ιδιωτικό χώρο ή στην τοπική υπηρεσία.'}</p></div></details></footer>`;
}
function render(focus=false) {
  if (!selected() && state.view!=='select') state.view='select';
  app.innerHTML=header()+`<main id="main">${state.notice?`<div class="notice" role="status">${esc(state.notice)}</div>`:''}${state.view==='select'?selectView():state.view==='activity'?activityView():evaluationView()}</main>`+footer();
  bind();
  if(state.saving||state.planning) app.querySelectorAll('button,input,select,textarea').forEach(el=>{el.disabled=true;});
  if (focus) { document.querySelector('#view-title')?.focus({preventScroll:true}); window.scrollTo({top:0,behavior:'instant'}); }
}
function go(view) {
  if(state.selected){
    if(state.view==='activity')planDraft().context=sessionData();
    if(state.view==='evaluate')draft().context=sessionData();
    const target=view==='activity'?planDraft().context:view==='evaluate'?draft().context:null;
    if(target)applyContext(target);
  }
  state.view=view;
  if (view==='select') history.replaceState(null,'',location.pathname);
  else history.replaceState(null,'',`#${view}/${encodeURIComponent(state.selected)}`);
  state.notice=''; render(true);
}
function bind() {
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.view)));
  document.querySelectorAll('[data-select]').forEach(b=>b.addEventListener('click',()=>{state.selected=b.dataset.select;state.teaching=false;go('activity');}));
  document.querySelectorAll('[data-context]').forEach(el=>el.addEventListener(['section','classProfile'].includes(el.dataset.context)?'input':'change',()=>{
    const cursor=el.selectionStart;
    const k=el.dataset.context;state[k]=el.value;if(k==='grade')state.section='';if(state.selected)changed(state.view==='evaluate');remember();render();
    const replacement=document.getElementById(el.id);replacement?.focus();if(cursor!==null)replacement?.setSelectionRange?.(cursor,cursor);
  }));
  document.querySelectorAll('[data-filter]').forEach(el=>el.addEventListener(el.tagName==='INPUT'&&el.type!=='checkbox'?'input':'change',()=>{
    const id=el.id,start=el.selectionStart,end=el.selectionEnd;
    state.filters[el.dataset.filter]=el.type==='checkbox'?el.checked:el.value;
    render();const replacement=document.getElementById(id);replacement?.focus();if(start!==null) replacement?.setSelectionRange?.(start,end);
    const count=document.querySelectorAll('.scenario-card').length;announce(count+(count===1?' διαθέσιμο μάθημα':' διαθέσιμα μαθήματα'));
  }));
  document.querySelector('#clear-filters')?.addEventListener('click',()=>{state.filters={search:'',goal:'',subject:'',source:'',includeUnknown:false};state.grade='';state.section='';remember();render();});
  document.querySelectorAll('[data-flag]').forEach(b=>b.addEventListener('click',()=>{
    const d=draft(), id=b.dataset.flag;d.flags.has(id)?d.flags.delete(id):d.flags.add(id);d.saved=false;d.error='';d.requestId=uuid();render();document.querySelector(`[data-flag="${id}"]`)?.focus();
  }));
  document.querySelector('#cognitive')?.addEventListener('change',e=>{const d=draft();d.difficulty=e.target.value;d.requestId=uuid();d.saved=false;});
  document.querySelectorAll('[data-planned]').forEach(el=>el.addEventListener('change',()=>{const p=planDraft();p.ids=el.checked?[...p.ids,el.dataset.planned]:p.ids.filter(i=>i!==el.dataset.planned);changed();render();document.querySelector(`[data-planned="${el.dataset.planned}"]`)?.focus();}));
  document.querySelectorAll('[data-remove-material]').forEach(el=>el.addEventListener('click',()=>{planDraft().ids=planDraft().ids.filter(i=>i!==el.dataset.removeMaterial);changed();render();}));
  document.querySelectorAll('[data-move-material]').forEach(el=>el.addEventListener('click',()=>{const ids=planDraft().ids,i=ids.indexOf(el.dataset.moveMaterial);if(i>0)[ids[i-1],ids[i]]=[ids[i],ids[i-1]];changed();render();}));
  document.querySelector('#plan-notes')?.addEventListener('input',e=>{planDraft().notes=e.target.value;changed();const button=document.querySelector('#save-plan');if(button)button.disabled=false;document.querySelector('.plan-save>span').textContent='Υπάρχουν αλλαγές προς αποθήκευση.';});
  document.querySelector('#teaching-mode')?.addEventListener('click',()=>{state.teaching=!state.teaching;render();});
  document.querySelector('#new-plan')?.addEventListener('click',()=>{state.planDrafts.delete(state.selected);state.drafts.delete(contextKey());state.teaching=false;state.lessonDate=new Date().toLocaleDateString('en-CA',{timeZone:'Europe/Athens'});render();});
  document.querySelectorAll('[data-open-plan]').forEach(el=>el.addEventListener('click',()=>openPlan(el.dataset.openPlan)));
  document.querySelector('#save-plan')?.addEventListener('click',async()=>{try{await savePlan();}catch{}render();});
  document.querySelectorAll('[data-used]').forEach(el=>el.addEventListener('change',()=>{const d=draft();el.checked?d.used.add(el.dataset.used):d.used.delete(el.dataset.used);d.usageConfirmed=false;changed(true);render();document.querySelector(`[data-used="${el.dataset.used}"]`)?.focus();}));
  document.querySelector('#use-planned')?.addEventListener('click',()=>{draft().used=new Set(planDraft().ids);draft().usageConfirmed=false;changed(true);render();});
  document.querySelector('#usage-confirmed')?.addEventListener('change',e=>{draft().usageConfirmed=e.target.checked;changed(true);render();document.querySelector('#usage-confirmed')?.focus();});
  document.querySelector('#save-evaluation')?.addEventListener('click',save);
  document.querySelector('#refresh')?.addEventListener('click',refresh);
  document.querySelector('#export-history')?.addEventListener('click',exportHistory);
}
async function loadHistory() {
  if (!state.service) return;
  const results=await Promise.allSettled([getJson('api/evaluations'),getJson('api/plans')]);
  if(results[0].status==='fulfilled'){state.records=results[0].value.records;state.historyError='';}else state.historyError='Το ιστορικό δεν είναι διαθέσιμο: '+results[0].reason.message;
  if(results[1].status==='fulfilled'){state.plans=results[1].value.plans;state.planError='';}else state.planError='Τα σχέδια δεν είναι διαθέσιμα: '+results[1].reason.message;
}
async function savePlan() {
  const p=planDraft();if(!state.service)throw Error('Άνοιξε τον ιδιωτικό χώρο.');
  if(p.saved&&!planDirty())return p.saved;
  const payload={...planContent(),request_id:p.requestId,plan_id:p.saved?.plan_id||p.requestId,previous_version_id:p.saved?.id||''};
  state.planning=true;p.error='';render();
  try {const r=await postJson('api/plans',payload);p.saved=r.plan;p.requestId=uuid();state.plans=[...state.plans.filter(x=>x.id!==r.plan.id),r.plan];return r.plan;}
  catch(e){p.error=e.message;throw e;}
  finally{state.planning=false;render();}
}
async function save() {
  const d=draft();if(state.saving||!d.flags.size||!d.usageConfirmed||!state.service)return;
  const key=contextKey();
  const payload={request_id:d.requestId,scenario_id:state.selected,...sessionData(),flags:[...d.flags],cognitive_difficulty:d.difficulty?Number(d.difficulty):null,media_usage_recorded:true,used_material_ids:[...d.used]};
  state.saving=true;d.error='';render();
  try {
    const plan=await savePlan();payload.plan_version_id=plan.id;
    const r=await postJson('api/evaluations',payload);
    state.records=[...state.records.filter(x=>x.id!==r.record.id),r.record];
    d.flags.clear();d.saved=true;d.usageConfirmed=false;d.requestId=uuid();announce('Η αξιολόγηση αποθηκεύτηκε.');
  } catch(e) {d.error=e.message || 'Η αποθήκευση απέτυχε.';}
  finally {state.saving=false;if(contextKey()===key)render();else render();}
}
async function refresh() {
  if (cloud) { await loadHistory();render();return; }
  state.refreshing=true;render();
  try {const r=await postJson('api/refresh',{});state.registry=r.registry;state.notice='Ο τοπικός κατάλογος ενημερώθηκε. Το ιστορικό αξιολογήσεων διατηρήθηκε.';await loadHistory();}
  catch(e){state.notice='Η ενημέρωση δεν ολοκληρώθηκε: '+e.message;}
  finally{state.refreshing=false;render();}
}
async function exportHistory() {
  try {
    const data=await rpc('exportEvaluations');
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='teaching-plans-and-evaluations.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  } catch(e) {state.notice='Η λήψη δεν ολοκληρώθηκε: '+e.message;render();}
}
async function boot() {
  try {
    if (cloud) state.service=true;
    else if (!catalogueMode) { try {const h=await getJson('api/health');state.service=h.service==='teaching-mission-control';} catch {} }
    [state.registry,state.models]=await Promise.all([getJson(state.service?'api/registry':'data/scenario-registry.json'),getJson(state.service?'api/models':'data/pedagogical-models.json')]);
    if (cloud?.initial) { const i=cloud.initial;state.selected=i.scenario||null;state.view=i.view||'select';state.grade=i.grade||state.grade;state.section=i.section||'';state.modelId=i.modelId||state.modelId; }
    if(!state.registry.grades.includes(state.grade)){state.grade='';state.section='';}
    if(!state.models.models.some(m=>m.id===state.modelId))state.modelId=state.models.models[0].id;
    const match=location.hash.match(/^#(activity|evaluate)\/(.+)$/);
    if(match){state.view=match[1];state.selected=decodeURIComponent(match[2]);}
    if(cloud?.initial?.materialIds && state.selected)planDraft().ids=cloud.initial.materialIds;
    await loadHistory();render();
  } catch(e) {app.innerHTML=`<main class="loading"><h1>Δεν φορτώθηκε ο κατάλογος.</h1><p>${esc(e.message)}</p><p>Ανανέωσε τη σελίδα και έλεγξε τη σύνδεσή σου.</p><button class="button primary" id="retry">Δοκιμή ξανά</button></main>`;document.querySelector('#retry').addEventListener('click',boot);}
}
window.addEventListener('focus',async()=>{if(state.registry&&state.service&&!state.saving&&!state.planning){const before=JSON.stringify([state.records,state.plans,state.historyError,state.planError]);await loadHistory();if(before!==JSON.stringify([state.records,state.plans,state.historyError,state.planError]))render();}});
boot();
