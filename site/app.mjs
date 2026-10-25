import {filterScenarios, relevantHistory} from './domain.mjs';

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
  }
  const r = await fetch(url,{cache:'no-store'}); if (!r.ok) throw Error(`Η ανάγνωση απέτυχε (${r.status}).`); return r.json();
};
const postJson = async (url, data) => {
  if (cloud && url === 'api/evaluations') return rpc('saveEvaluation', data);
  const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Mission-Control':'teacher-action'},body:JSON.stringify(data)});
  const body = await r.json(); if (!r.ok) throw Error(body.error || 'Η αποθήκευση δεν ολοκληρώθηκε.'); return body;
};
const uuid = () => crypto.randomUUID?.() ?? '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c => (Number(c)^crypto.getRandomValues(new Uint8Array(1))[0]&15>>Number(c)/4).toString(16));
let remembered = {};
try { remembered = JSON.parse(sessionStorage.getItem('mission-context') || '{}'); } catch {}
const state = {registry:null,models:null,view:'select',selected:null,grade:remembered.grade || '',section:remembered.section || '',
  modelId:remembered.modelId || 'guided-exploration',filters:{search:'',goal:'',subject:'',source:'',includeUnknown:false},
  service:false,records:[],historyError:'',drafts:new Map(),notice:'',refreshing:false,saving:false};
const selected = () => state.registry.scenarios.find(s => s.scenario_id === state.selected);
const model = () => state.models.models.find(m => m.id === state.modelId) || state.models.models[0];
function contextKey() { return [state.selected,state.grade,state.section.trim(),state.modelId].join('|'); }
function draft() {
  const key=contextKey();
  if (!state.drafts.has(key)) state.drafts.set(key,{flags:new Set(),requestId:uuid(),saved:false,error:'',difficulty:selected()?.cognitive_difficulty ?? ''});
  return state.drafts.get(key);
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
  return link(target.href,'Στον ιδιωτικό χώρο '+icon('external'),'button secondary');
}
function header() {
  const steps=[['select','book','Επιλογή μαθήματος','Η αφετηρία της τάξης'],['activity','play','Έναρξη δραστηριότητας','Υλικό και παιδαγωγική διαδρομή'],['evaluate','check','Αξιολόγηση εφαρμογής','Μία μικρή ανατροφοδότηση']];
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
  return `<article class="scenario-card"><div class="card-top"><span class="eyebrow">${family}</span>${icon(s.formats.includes('Unity VR')?'vr':s.formats.includes('Slides')?'slides':'book')}</div><h3>${esc(s.title)}</h3><p class="card-grade">${esc(grade)}</p><p class="card-description">${esc(question)}</p><div class="badges">${badges(s)}</div><div class="card-bottom"><span class="history-mini ${h.latest?.flags.includes('worked-well')?'positive':''}">${!state.service?'Ιδιωτικό ιστορικό στον χώρο εκπαιδευτικού':state.historyError?'Ιστορικό μη διαθέσιμο':isNew?'Δεν έχει καταγραφεί εφαρμογή':`${h.summary.total} εφαρμογ${h.summary.total===1?'ή':'ές'} · ${h.summary.positive} θετικές`}</span><button class="choose" data-select="${esc(s.scenario_id)}" aria-label="Επιλογή: ${esc(s.title)}">Επιλογή ${icon('arrow')}</button></div></article>`;
}
function sessionContext() {
  return `<div class="session-context"><div><label for="session-grade">Η τάξη μου</label><select id="session-grade" data-context="grade">${gradeOptions('Χωρίς επιλογή τάξης')}</select></div><div><label for="section">Τμήμα <span class="optional">προαιρετικό</span></label><input id="section" data-context="section" value="${esc(state.section)}" maxlength="40" placeholder="π.χ. Β1" ${state.grade?'':'disabled'}></div><div class="context-model"><label for="model">Παιδαγωγικό μοντέλο</label><select id="model" data-context="modelId">${state.models.models.map(m=>`<option value="${esc(m.id)}" ${model().id===m.id?'selected':''}>${esc(m.title)}</option>`).join('')}</select></div></div>`;
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
  ${full?`<details class="history-details"><summary>Ιστορικό εφαρμογών (${h.summary.total})</summary><ol>${h.records.map(x=>`<li><time>${date(x.created_at)}</time><span>${esc([x.grade,x.section].filter(Boolean).join(' · ') || 'Χωρίς επιλογή τάξης')}</span><p>${esc(x.flags.map(f=>x.flag_labels?.[f]||state.models.flags.find(a=>a.id===f)?.label||f).join(' · '))}</p><small>${esc(x.model_title || x.model_id)}</small></li>`).join('')}</ol></details>`:''}</div></section>`;
}
function selectedIntro(s, eyebrow) {
  return `<section class="view-intro selected-intro"><div><button class="text-button back" data-view="select">← Πίσω στα μαθήματα</button><p class="eyebrow">${eyebrow}</p><h1 id="view-title" tabindex="-1">${esc(s.title)}</h1><div class="badges">${badges(s)}</div></div></section>`;
}
function activityCard(a) {
  if (a.kind==='vr') return `<article class="material vr-material">${icon('vr')}<div><span class="material-kind">UNITY VR · ΤΟΠΙΚΗ ΑΠΟΣΤΟΛΗ</span><h3>${esc(a.label)}</h3><p>${esc(a.room || '')}</p><p>${esc(a.note)}</p><details><summary>Πληροφορία τοπικής αποστολής</summary><p class="source-path">${esc(state.registry.source_files.find(x=>x.key===a.source_key)?.path || '')}</p><p>Άνοιξε την αποστολή από την υπάρχουσα διαδικασία του Unity project.</p></details></div></article>`;
  const kind={book:'DIGITAL BOOK',slides:'ΔΙΑΦΑΝΕΙΕΣ',html:'ΔΙΑΔΡΑΣΤΙΚΗ ΕΦΑΡΜΟΓΗ',quiz:'QUIZ',text:'ΚΕΙΜΕΝΟ'}[a.kind];
  const target=state.service && a.local_url ? a.local_url : a.url;
  if (!target) return '';
  const label= a.drive_html && !a.local_url?'Άνοιγμα στο Drive':a.kind==='book'?'Στο βιβλίο':a.kind==='slides'?'Άνοιγμα διαφανειών':'Άνοιγμα δραστηριότητας';
  return `<article class="material">${icon(a.kind==='slides'?'slides':a.kind==='book'||a.kind==='text'?'book':'play')}<div><span class="material-kind">${kind}${a.slide_count?' · '+a.slide_count+' διαφάνειες':''}</span><h3>${esc(a.label)}</h3>${a.note?`<p>${esc(a.note)}</p>`:''}<div class="material-links">${link(target,label+' '+icon('external'),'button secondary')}${a.drive_html?link(a.download_url,'Λήψη HTML','small-link'):''}${a.lesson_download_url?link(a.lesson_download_url,'Λήψη μαθήματος','small-link'):''}${state.service&&a.app==='interactive-sculpture'&&a.url?link(a.url,'Online εφαρμογή','small-link'):''}</div>
  ${a.content_preview?.length?`<details class="content-preview"><summary>Τι περιέχει η παρουσίαση;</summary><ol>${a.content_preview.map(p=>`<li>${link(p.url,esc(p.title))}<p>${esc(p.text)}</p></li>`).join('')}</ol></details>`:''}</div></article>`;
}
function activityView() {
  const s=selected(); const m=model();
  const hasVr=s.activities.some(a=>a.kind==='vr');
  const steps=m.steps.filter(st=>!st.requires || s.activities.some(a=>a.kind===st.requires));
  return `${selectedIntro(s,'Η ΔΡΑΣΤΗΡΙΟΤΗΤΑ ΣΤΗΝ ΤΑΞΗ')}${sessionContext()}${previous(s)}
  <div class="activity-layout"><section class="panel route-panel"><p class="eyebrow">ΠΡΟΤΕΙΝΟΜΕΝΗ ΠΑΙΔΑΓΩΓΙΚΗ ΔΙΑΔΡΟΜΗ</p><h2>${esc(m.short_title || m.title)}</h2><p class="muted">${esc(m.description)}</p><p class="preparation">${esc(m.preparation)}</p><ol class="route-steps">${steps.map((st,i)=>`<li><span>${i+1}</span><div><h3>${esc(st.title)}</h3><p>${esc(st.description)}</p></div></li>`).join('')}</ol>${m.id==='asymmetric-html-vr'&&!hasVr?'<p class="notice">Δεν έχει τεκμηριωθεί τοπική αποστολή VR για αυτό το σενάριο. Η κοινή δραστηριότητα και η αιτιολόγηση παραμένουν διαθέσιμες.</p>':''}<div class="application"><strong>Πρόταση για την εφαρμογή</strong><p>${esc(s.pedagogical_application)}</p></div>
  <details class="mapping"><summary>Στόχοι και σχεδιασμένη δυσκολία</summary><p><strong>Τάξη:</strong> ${esc(s.grades.join(' · ')||'Προς επιβεβαίωση')}</p>${s.audience_source?`<p>${esc(s.audience_source)}</p>`:''}<p><strong>Διάρκεια:</strong> ${esc(s.duration || 'Προς επιβεβαίωση')}${s.duration_status==='unconfirmed'&&s.duration?' · προς επιβεβαίωση':''}</p><p><strong>Γνωστική δυσκολία:</strong> ${difficulty(s.cognitive_difficulty,'cognitive')}${s.cognitive_status==='mapped'?' · χαρτογράφηση από τα ζητούμενα':''}</p><p><strong>Τεχνική δυσκολία:</strong> ${difficulty(s.technical_difficulty,'technical')}</p><p class="muted">Οι κλίμακες περιγράφουν τον σχεδιασμό. Η αξιολόγηση κρατά τι συνέβη στην τάξη.</p>${s.objectives.length?`<ul>${s.objectives.map(o=>`<li>${esc(o)}</li>`).join('')}</ul>`:'<p>Οι διδακτικοί στόχοι χρειάζονται επιβεβαίωση από τον εκπαιδευτικό.</p>'}</details></section>
  <section class="materials"><div class="results-heading"><h2>Το διαθέσιμο υλικό σου</h2></div>${[...s.activities].sort((a,b)=>({book:0,text:1,slides:2,html:3,quiz:3,vr:4}[a.kind]??5)-({book:0,text:1,slides:2,html:3,quiz:3,vr:4}[b.kind]??5)).map(activityCard).join('') || '<div class="empty panel">Χρειάζεται επιβεβαίωση συνδέσμου.</div>'}${s.readiness_note?`<p class="source-note">${esc(s.readiness_note)}</p>`:''}</section></div>
  <div class="next-bar"><p>Μετά τη δραστηριότητα, κράτησε ό,τι θα βοηθήσει την επόμενη φορά.</p><button class="button primary" data-view="evaluate">Αξιολόγηση εφαρμογής ${icon('arrow')}</button></div>${sourceNotes(s)}`;
}
function difficulty(level,kind) { return level?`${level}/5 · ${esc(state.models[kind+'_scale'].find(d=>d.level===Number(level))?.label)}`:'Προς επιβεβαίωση'; }
function sourceNotes(s) {
  return `<details class="source-notes"><summary>Πηγές της χαρτογράφησης</summary><p>Ανάγνωση των υπαρχόντων αρχείων. Οι προτάσεις εφαρμογής είναι προτάσεις σχεδιασμού, όχι αποτελέσματα αξιολόγησης.</p>${s.notes.map(n=>`<p>${esc(n)}</p>`).join('')}<ul>${s.sources.map(src=>`<li><strong>${esc(src.system)}</strong><span class="source-path">${esc(src.path)}${src.locator?' · '+esc(src.locator):''}</span></li>`).join('')}</ul></details>`;
}
function evaluationView() {
  const s=selected(), d=draft();
  return `${selectedIntro(s,'Η ΔΙΚΗ ΣΟΥ ΑΝΑΤΡΟΦΟΔΟΤΗΣΗ')}${sessionContext()}<div class="evaluation-layout"><section class="panel evaluation-panel"><p class="eyebrow">ΜΙΑ ΜΙΚΡΗ ΚΑΤΑΓΡΑΦΗ ΓΙΑ ΤΗΝ ΕΠΟΜΕΝΗ ΦΟΡΑ</p><h2>Πώς λειτούργησε η δραστηριότητα;</h2><p class="muted">Επίλεξε μία ή περισσότερες επισημάνσεις. Δεν χρειάζεται γραπτή αναφορά.</p><div class="flag-options" role="group" aria-label="Επισημάνσεις εφαρμογής">${state.models.flags.map(f=>`<button class="flag ${d.flags.has(f.id)?'chosen':''}" data-flag="${f.id}" aria-pressed="${d.flags.has(f.id)}" ${state.saving||!state.service?'disabled':''}><span class="flag-icon">${f.icon}</span><span>${esc(f.label)}</span><span class="flag-check" aria-hidden="true">${d.flags.has(f.id)?'✓':'+'}</span></button>`).join('')}</div>
  <details class="difficulty-select"><summary>Γνωστική δυσκολία σχεδιασμού · ${d.difficulty?d.difficulty+'/5':'προαιρετική'}</summary><label for="cognitive">Επίπεδο, εφόσον είναι γνωστό</label><select id="cognitive"><option value="">Προς επιβεβαίωση</option>${state.models.cognitive_scale.map(x=>`<option value="${x.level}" ${Number(d.difficulty)===x.level?'selected':''}>${x.level}. ${esc(x.label)}</option>`).join('')}</select></details>
  ${!state.service?`<div class="notice"><p>Οι αξιολογήσεις παραμένουν ιδιωτικές στον Google λογαριασμό σου. Άνοιξε τον ιδιωτικό χώρο για να αποθηκεύσεις και να δεις το ιστορικό από κάθε συσκευή.</p>${privateSpace()}</div>`:''}${d.error?`<div class="notice error" role="alert">${esc(d.error)} Οι επιλογές σου παραμένουν εδώ.</div>`:''}${d.saved?`<div class="saved-message" role="status">✓ ${cloud?'Αποθηκεύτηκε στο ιδιωτικό cloud.':'Αποθηκεύτηκε στον δίσκο.'} Θα εμφανιστεί στην επόμενη επιλογή του σεναρίου.</div>`:''}
  <div class="save-row"><span>${state.grade?esc(state.grade)+(state.section?' · '+esc(state.section):''):'Χωρίς επιλογή τάξης'}<small>${esc(model().short_title || model().title)}</small></span><button class="button primary" id="save-evaluation" ${!state.service||!d.flags.size||state.saving?'disabled':''}>${state.saving?'Αποθηκεύεται…':'Αποθήκευση'} ${icon('check')}</button></div><p class="privacy-note">Οι καταγραφές παραμένουν στον χώρο του εκπαιδευτικού. Δεν προστίθενται στο Digital Book ή στις δραστηριότητες των μαθητών.</p></section><aside class="evaluation-history"><h2>Από τις προηγούμενες εφαρμογές</h2>${previous(s)}<button class="text-button" data-view="activity">← Επιστροφή στο υλικό</button></aside></div>`;
}
function footer() {
  const drive=state.registry.integrations.google_drive;
  return `<footer class="footer"><span>Το υλικό σου. Η παιδαγωγική σου διαδρομή.</span><details class="integrations"><summary>Πηγές και διατήρηση</summary><div class="integration-content"><p><strong>Digital Book:</strong> έκδοση ${esc(state.registry.integrations.digital_book.revision || 'προς επιβεβαίωση')}. Το βιβλίο συνεχίζει να ενημερώνεται από την υπάρχουσα διαδικασία.</p><p><strong>Google Drive:</strong> ${drive.checked_at?'ανάγνωση '+date(drive.checked_at):'δεν έχει ολοκληρωθεί ανάγνωση'}. ${drive.folder?link(drive.folder.url,'Φάκελος ChatGPT'):''}</p><p>Η ανανέωση εδώ ξαναδιαβάζει τα τοπικά μαθήματα και το βιβλίο. Νέες παρουσιάσεις και HTML του Drive εισάγονται μέσω της συνδεδεμένης διαδικασίας Google Drive στο Codex· η ημερομηνία ελέγχου διατηρείται.</p><div class="footer-actions"><button class="button secondary" id="refresh" ${!state.service||state.refreshing?'disabled':''}>${state.refreshing?'Ενημερώνεται…':cloud?'Ανανέωση ιστορικού':'Ανανέωση τοπικού καταλόγου'}</button>${cloud?'<button class="text-button" id="export-history">Λήψη ιστορικού αξιολογήσεων</button>':state.service?link('api/export','Λήψη ιστορικού αξιολογήσεων','small-link'):''}</div><p>${cloud?'Οι αξιολογήσεις αποθηκεύονται ως ξεχωριστά ιδιωτικά αρχεία στο Drive. Ο ίδιος Google λογαριασμός βλέπει το ίδιο ιστορικό από κάθε συσκευή.':'Η online σελίδα περιέχει μόνο τον κατάλογο. Οι αξιολογήσεις διατηρούνται στον ιδιωτικό χώρο ή στην τοπική υπηρεσία.'}</p></div></details></footer>`;
}
function render(focus=false) {
  if (!selected() && state.view!=='select') state.view='select';
  app.innerHTML=header()+`<main id="main">${state.notice?`<div class="notice" role="status">${esc(state.notice)}</div>`:''}${state.view==='select'?selectView():state.view==='activity'?activityView():evaluationView()}</main>`+footer();
  bind();
  if (focus) { document.querySelector('#view-title')?.focus({preventScroll:true}); window.scrollTo({top:0,behavior:'instant'}); }
}
function go(view) {
  state.view=view;
  if (view==='select') history.replaceState(null,'',location.pathname);
  else history.replaceState(null,'',`#${view}/${encodeURIComponent(state.selected)}`);
  state.notice=''; render(true);
}
function bind() {
  document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.view)));
  document.querySelectorAll('[data-select]').forEach(b=>b.addEventListener('click',()=>{state.selected=b.dataset.select;go('activity');}));
  document.querySelectorAll('[data-context]').forEach(el=>el.addEventListener(el.dataset.context==='section'?'input':'change',()=>{
    const cursor=el.selectionStart;
    const k=el.dataset.context;state[k]=el.value.trim();if(k==='grade')state.section='';remember();render();
    if(k==='section'){const replacement=document.querySelector('#section');replacement?.focus();replacement?.setSelectionRange(cursor,cursor);}
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
  document.querySelector('#save-evaluation')?.addEventListener('click',save);
  document.querySelector('#refresh')?.addEventListener('click',refresh);
  document.querySelector('#export-history')?.addEventListener('click',exportHistory);
}
async function loadHistory() {
  if (!state.service) return;
  try { const data=await getJson('api/evaluations');state.records=data.records;state.historyError=''; }
  catch(e) {state.historyError='Το ιστορικό δεν είναι διαθέσιμο: '+e.message;}
}
async function save() {
  const d=draft();if(state.saving||!d.flags.size||!state.service)return;
  const key=contextKey();
  const payload={request_id:d.requestId,scenario_id:state.selected,grade:state.grade,section:state.section,model_id:model().id,flags:[...d.flags],cognitive_difficulty:d.difficulty?Number(d.difficulty):null};
  state.saving=true;d.error='';render();
  try {
    const r=await postJson('api/evaluations',payload);
    state.records=[...state.records.filter(x=>x.id!==r.record.id),r.record];
    d.flags.clear();d.saved=true;d.requestId=uuid();announce('Η αξιολόγηση αποθηκεύτηκε.');
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
    const a=document.createElement('a');a.href=url;a.download='teaching-evaluations.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
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
    await loadHistory();render();
  } catch(e) {app.innerHTML=`<main class="loading"><h1>Δεν φορτώθηκε ο κατάλογος.</h1><p>${esc(e.message)}</p><p>Ανανέωσε τη σελίδα και έλεγξε τη σύνδεσή σου.</p><button class="button primary" id="retry">Δοκιμή ξανά</button></main>`;document.querySelector('#retry').addEventListener('click',boot);}
}
window.addEventListener('focus',async()=>{if(state.registry&&state.service){const before=JSON.stringify([state.records,state.historyError]);await loadHistory();if(before!==JSON.stringify([state.records,state.historyError]))render();}});
boot();
