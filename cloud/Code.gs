/** Private teacher service. Deploy as yourself, access: Only myself. */
const OWNER_EMAIL = '__OWNER_EMAIL__';
const CATALOG = __CATALOG__;
const MODELS = __MODELS__;
const PRIVATE_PAGE = __PRIVATE_PAGE__;

function assertOwner_() {
  const active = Session.getActiveUser().getEmail().toLowerCase();
  const effective = Session.getEffectiveUser().getEmail().toLowerCase();
  if (!active || active !== OWNER_EMAIL.toLowerCase() || effective !== active) {
    throw new Error('Ο ιδιωτικός χώρος είναι διαθέσιμος μόνο στον λογαριασμό του εκπαιδευτικού.');
  }
}

function doGet(e) {
  assertOwner_();
  const parameters = e && e.parameter || {};
  const initial = {};
  if (CATALOG.scenarios.some(s => s.scenario_id === parameters.scenario)) {
    initial.scenario = parameters.scenario;
    initial.view = parameters.view === 'evaluate' ? 'evaluate' : 'activity';
  }
  if (CATALOG.grades.includes(parameters.grade)) initial.grade = parameters.grade;
  if (MODELS.models.some(m => m.id === parameters.model)) initial.modelId = parameters.model;
  if (initial.grade && typeof parameters.section === 'string') initial.section = parameters.section.slice(0, 40);
  if (initial.scenario && typeof parameters.materials === 'string') {
    const known = CATALOG.scenarios.find(s => s.scenario_id === initial.scenario).activities.map(a => a.id);
    initial.materialIds = parameters.materials.split(',').filter(id => known.includes(id)).slice(0, 100);
  }
  const bootstrap = JSON.stringify({registry: CATALOG, models: MODELS, initial,
    assetBase: CATALOG.publication.site_url}).replace(/</g, '\\u003c');
  return HtmlService.createHtmlOutput(PRIVATE_PAGE.replace('__MISSION_BOOTSTRAP__', bootstrap))
    .setTitle('Πιλοτήριο τάξης · Ιδιωτικός χώρος')
    .addMetaTag('viewport', 'width=device-width,initial-scale=1');
}

function folder_() {
  const properties = PropertiesService.getScriptProperties();
  let id = properties.getProperty('EVALUATIONS_FOLDER');
  if (!id) {
    const folder = DriveApp.createFolder('Πιλοτήριο τάξης · Ιδιωτικές αξιολογήσεις');
    id = folder.getId();
    properties.setProperty('EVALUATIONS_FOLDER', id);
  }
  const folder = DriveApp.getFolderById(id);
  if (folder.getSharingAccess() !== DriveApp.Access.PRIVATE ||
      folder.getEditors().length || folder.getViewers().length ||
      folder.getOwner().getEmail().toLowerCase() !== OWNER_EMAIL.toLowerCase()) {
    throw new Error('Ο φάκελος αξιολογήσεων πρέπει να παραμένει ιδιωτικός στον εκπαιδευτικό.');
  }
  return folder;
}

function readRecords_(folder) {
  // Iterate all files so that a malformed record can never silently disappear.
  const all = folder.getFiles();
  const records = [];
  while (all.hasNext()) {
    const file = all.next();
    if (!/^[0-9a-f-]{36}\.json$/.test(file.getName())) continue;
    let row;
    try { row = JSON.parse(file.getBlob().getDataAsString('UTF-8')); }
    catch (e) { throw new Error('Μια καταγραφή δεν διαβάζεται. Διατηρήθηκε για ανάκτηση.'); }
    if (!row.id || !row.scenario_id || !row.created_at || !Array.isArray(row.flags)) {
      throw new Error('Μια καταγραφή χρειάζεται έλεγχο. Διατηρήθηκε για ανάκτηση.');
    }
    records.push(row);
  }
  return records.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

function listEvaluations() {
  assertOwner_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return {records: readRecords_(folder_())}; }
  finally { lock.releaseLock(); }
}

function validateRecord_(data, lessonPlan) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 64000) {
    throw new Error('Μη έγκυρη καταγραφή.');
  }
  if (typeof data.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.request_id)) {
    throw new Error('Η καταγραφή χρειάζεται μοναδικό αναγνωριστικό.');
  }
  const scenario = CATALOG.scenarios.find(s => s.scenario_id === data.scenario_id);
  const model = MODELS.models.find(m => m.id === data.model_id);
  if (!scenario || !model) throw new Error('Επίλεξε υπάρχον μάθημα και παιδαγωγικό μοντέλο.');
  const permitted = MODELS.flags.map(f => f.id);
  if (!Array.isArray(data.flags) || !data.flags.length || data.flags.some(f => !permitted.includes(f))) {
    throw new Error('Επίλεξε τουλάχιστον μία διαθέσιμη επισήμανση.');
  }
  const grade = data.grade || '';
  const section = data.section || '';
  if (typeof grade !== 'string' || (grade && !CATALOG.grades.includes(grade)) ||
      typeof section !== 'string' || section.length > 40 || /[\x00-\x1f]/.test(section) || (section.trim() && !grade)) {
    throw new Error('Έλεγξε την τάξη και το τμήμα.');
  }
  const difficulty = data.cognitive_difficulty == null ? null : data.cognitive_difficulty;
  if (difficulty !== null && (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 5)) {
    throw new Error('Η γνωστική δυσκολία παίρνει τιμές 1–5 ή παραμένει κενή.');
  }
  if (lessonPlan && lessonPlan.scenario_id !== scenario.scenario_id) throw new Error('Το σχέδιο ανήκει σε άλλο μάθημα.');
  const usage = data.media_usage_recorded == null ? false : data.media_usage_recorded;
  if (typeof usage !== 'boolean' || ('used_material_ids' in data && !usage)) throw new Error('Επιβεβαίωσε ποια μέσα χρησιμοποιήθηκαν.');
  const used = usage ? selectMaterials_(data.used_material_ids, scenario, lessonPlan) : [];
  const timestamp = new Date();
  return {schema_version: 2, id: data.request_id.toLowerCase(), scenario_id: scenario.scenario_id,
    scenario_title: scenario.title, created_at: timestamp.toISOString(),
    date: Utilities.formatDate(timestamp, 'Europe/Athens', 'yyyy-MM-dd'), timezone: 'Europe/Athens',
    grade, section: section.trim(), model_id: model.id, model_title: model.title,
    flags: [...new Set(data.flags)], flag_labels: Object.fromEntries(MODELS.flags.filter(f => data.flags.includes(f.id)).map(f => [f.id, f.label])),
    cognitive_difficulty: difficulty, technical_difficulty: scenario.technical_difficulty,
    ...contextFields_(data), media_usage_recorded: usage, used_materials: used, lesson_plan: lessonPlan || null};
}

function saveEvaluation(data) {
  assertOwner_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const folder = folder_();
    const plan = data && data.plan_version_id ? planVersion_(data.plan_version_id, folder) : null;
    return persistRecord_(validateRecord_(data, plan), folder);
  }
  finally { lock.releaseLock(); }
}

function persistRecord_(record, folder) {
    const matches = folder.getFilesByName(record.id + '.json');
    if (matches.hasNext()) {
      const old = JSON.parse(matches.next().getBlob().getDataAsString('UTF-8'));
      const keys = ['scenario_id', 'grade', 'section', 'model_id', 'flags', 'cognitive_difficulty'];
      if (keys.some(k => JSON.stringify(old[k]) !== JSON.stringify(record[k]))) {
        throw new Error('Το αναγνωριστικό χρησιμοποιήθηκε για διαφορετική καταγραφή.');
      }
      const defaults = {class_profile:'', time_slot:'', lesson_date:'', media_usage_recorded:false, used_materials:[], lesson_plan:null};
      if (Object.keys(defaults).some(k => JSON.stringify(old[k] == null ? defaults[k] : old[k]) !== JSON.stringify(record[k]))) {
        throw new Error('Το αναγνωριστικό χρησιμοποιήθηκε για διαφορετική καταγραφή.');
      }
      return {ok: true, record: old, created: false};
    }
    const file = folder.createFile(Utilities.newBlob(JSON.stringify(record, null, 2), 'application/json', record.id + '.json'));
    // Read back the actual persisted record before confirming success to the teacher.
    const persisted = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
    if (JSON.stringify(record) !== JSON.stringify(persisted)) throw new Error('Η αποθήκευση χρειάζεται έλεγχο.');
    return {ok: true, record: persisted, created: true};
}

function exportEvaluations() {
  assertOwner_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { const folder = folder_(); return {schema_version:2, exported_at:new Date().toISOString(), evaluations:readRecords_(folder), plans:readPlans_(folder)}; }
  finally { lock.releaseLock(); }
}

function contextFields_(data) {
  const profile = data.class_profile == null ? '' : data.class_profile;
  const slot = data.time_slot == null ? '' : data.time_slot;
  const day = data.lesson_date == null ? '' : data.lesson_date;
  if (typeof profile !== 'string' || profile.length > 240 || /[\x00-\x1f]/.test(profile)) throw new Error('Η περιγραφή τμήματος δέχεται έως 240 χαρακτήρες, χωρίς ονόματα μαθητών.');
  if (!['', 'morning', 'midday'].includes(slot)) throw new Error('Επίλεξε πρωινή ώρα ή προς το μεσημέρι.');
  if (typeof day !== 'string' || (day && (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0,10) !== day))) throw new Error('Μη έγκυρη ημερομηνία μαθήματος.');
  return {class_profile:profile.trim(), time_slot:slot, lesson_date:day};
}
function uuid_(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Χρειάζεται έγκυρο μοναδικό αναγνωριστικό.');
  return value.toLowerCase();
}
function selectMaterials_(ids, scenario, plan) {
  const choices = new Map(((plan && plan.planned_materials) || []).map(a => [a.id,a]));
  scenario.activities.forEach(a => choices.set(a.id,Object.fromEntries(['id','kind','label','url','room','native_id'].map(k => [k,a[k] || '']))));
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !choices.has(id))) throw new Error('Επίλεξε μέσα από το συγκεκριμένο μάθημα ή το αποθηκευμένο σχέδιο.');
  return [...new Set(ids)].map(id => choices.get(id));
}
function readPlans_(folder) {
  const all = folder.getFiles(), rows = [];
  while (all.hasNext()) {
    const file = all.next();
    if (!/^plan-[0-9a-f-]{36}\.json$/.test(file.getName())) continue;
    let row;
    try { row = JSON.parse(file.getBlob().getDataAsString('UTF-8')); }
    catch(e) { throw new Error('Ένα σχέδιο δεν διαβάζεται. Διατηρήθηκε για ανάκτηση.'); }
    if (!row.id || !row.plan_id || !row.scenario_id || !row.created_at || !Array.isArray(row.planned_materials)) throw new Error('Ένα σχέδιο χρειάζεται έλεγχο. Διατηρήθηκε για ανάκτηση.');
    rows.push(row);
  }
  return rows.sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}
function sameTeachingSession_(a,b) {
  const section = row => (row.section || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/ς/g,'σ');
  return a.scenario_id === b.scenario_id && (a.grade || '') === (b.grade || '') && section(a) === section(b) && (a.lesson_date || '') === (b.lesson_date || '');
}
function latestPlanVersions_(rows) {
  const byId = new Map(rows.map(r => [r.id,r])), superseded = new Set();
  rows.forEach(row => {
    let parent = byId.get(row.previous_version_id);
    const visited = new Set([row.id]);
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      if (parent.plan_id === row.plan_id && sameTeachingSession_(parent,row)) superseded.add(parent.id);
      parent = byId.get(parent.previous_version_id);
    }
  });
  return rows.filter(r => !superseded.has(r.id));
}
function planVersion_(id, folder) {
  const key = uuid_(id), row = readPlans_(folder).find(p => p.id === key);
  if (!row) throw new Error('Δεν βρέθηκε η αποθηκευμένη έκδοση του σχεδίου.');
  return row;
}
function listPlans() {
  assertOwner_();
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try { return {plans:readPlans_(folder_())}; } finally { lock.releaseLock(); }
}
function savePlan(data) {
  assertOwner_();
  if (!data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 64000) throw new Error('Μη έγκυρο σχέδιο.');
  const id = uuid_(data.request_id);
  let planId = uuid_(data.plan_id || id), previous = data.previous_version_id ? uuid_(data.previous_version_id) : '';
  let sourceId = data.source_version_id ? uuid_(data.source_version_id) : '';
  const scenario = CATALOG.scenarios.find(s => s.scenario_id === data.scenario_id), model = MODELS.models.find(m => m.id === data.model_id);
  if (!scenario || !model) throw new Error('Επίλεξε υπάρχον μάθημα και παιδαγωγικό μοντέλο.');
  // Reuse the same grade/section validation as evaluations, without creating an evaluation.
  const context = validateRecord_({...data, flags:[MODELS.flags[0].id], cognitive_difficulty:null, media_usage_recorded:false});
  if (typeof data.notes !== 'string' || data.notes.length > 2000) throw new Error('Το σχέδιο δέχεται έως 2.000 χαρακτήρες σημειώσεων.');
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const folder = folder_(), versions = readPlans_(folder);
    const old = versions.find(p => p.id === id), base = versions.find(p => p.id === previous);
    if (previous && !base) throw new Error('Δεν βρέθηκε η προηγούμενη έκδοση του σχεδίου.');
    if (base && base.plan_id !== planId) throw new Error('Η έκδοση ανήκει σε άλλο σχέδιο.');
    let source = sourceId ? versions.find(p => p.id === sourceId) : base;
    if (sourceId && !source) throw new Error('Δεν βρέθηκε το σχέδιο για αντιγραφή.');
    if (source && source.scenario_id !== scenario.scenario_id) throw new Error('Το σχέδιο ανήκει σε άλλο μάθημα.');
    if (base && base.scenario_id !== scenario.scenario_id) throw new Error('Το σχέδιο ανήκει σε άλλο μάθημα.');
    if (base && !sameTeachingSession_(base,context)) {
      sourceId = base.id; source = base; planId = id; previous = '';
    }
    const latest = latestPlanVersions_(versions).find(p => p.plan_id === planId && sameTeachingSession_(p,context));
    const row = {schema_version:2, id, plan_id:planId, previous_version_id:previous, source_version_id:sourceId, scenario_id:scenario.scenario_id,
      scenario_title:scenario.title, grade:context.grade, section:context.section, model_id:model.id, model_title:model.title,
      ...contextFields_(data), notes:data.notes.trim(), planned_materials:selectMaterials_(data.planned_material_ids,scenario,source),
      objectives:scenario.objectives, duration:scenario.duration || null,
      route:model.steps.filter(s => !s.requires || scenario.activities.some(a => a.kind === s.requires))};
    if (old) {
      const keys = ['plan_id','previous_version_id','scenario_id','grade','section','model_id','class_profile','time_slot','lesson_date','notes'];
      if (keys.some(k => JSON.stringify(old[k]) !== JSON.stringify(row[k])) || (old.source_version_id || '') !== sourceId || JSON.stringify(old.planned_materials.map(a => a.id)) !== JSON.stringify([...new Set(data.planned_material_ids)])) throw new Error('Το αναγνωριστικό χρησιμοποιήθηκε για διαφορετικό σχέδιο.');
      return {ok:true, plan:old, created:false};
    }
    if (latest && (!base || base.id !== latest.id || base.plan_id !== planId)) throw new Error('Το σχέδιο άλλαξε από άλλη συσκευή. Άνοιξε την τελευταία έκδοση· οι επιλογές σου διατηρούνται.');
    if (!latest && (previous || planId !== id)) throw new Error('Δεν βρέθηκε το αρχικό σχέδιο.');
    row.created_at = new Date().toISOString();
    const file = folder.createFile(Utilities.newBlob(JSON.stringify(row,null,2),'application/json','plan-'+id+'.json'));
    const persisted = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
    if (JSON.stringify(row) !== JSON.stringify(persisted)) throw new Error('Η αποθήκευση χρειάζεται έλεγχο.');
    return {ok:true, plan:persisted, created:true};
  } finally { lock.releaseLock(); }
}

// Owner-only verification uses an isolated, disposable folder, never the real teacher history.
function verifyPrivateStorage() {
  assertOwner_();
  const sandbox = DriveApp.createFolder('Πιλοτήριο QA · ' + new Date().toISOString());
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (sandbox.getSharingAccess() !== DriveApp.Access.PRIVATE) throw new Error('Ο δοκιμαστικός φάκελος δεν είναι ιδιωτικός.');
    const ids = ['sb:vivlos-dialogos-kai-drasi', 'book:abraham-journey', 'unity:byzantium_fall_restoration'];
    ids.forEach((scenario_id, index) => {
      const data = {request_id: Utilities.getUuid(), scenario_id, model_id: 'guided-exploration',
        grade: CATALOG.grades[index], section: 'QA', flags: ['worked-well'], cognitive_difficulty: null};
      const record = validateRecord_(data);
      if (!persistRecord_(record, sandbox).created) throw new Error('Η δοκιμαστική καταγραφή δεν δημιουργήθηκε.');
      if (persistRecord_(record, sandbox).created) throw new Error('Δημιουργήθηκε διπλή καταγραφή.');
    });
    const restored = readRecords_(DriveApp.getFolderById(sandbox.getId()));
    if (restored.length !== 3) throw new Error('Δεν επανήλθαν όλες οι δοκιμαστικές καταγραφές.');
    const result = {ok: true, scenarios: 3, durable_readback: true, duplicate_retry: 'no duplicates',
      private_access: true, production_history_untouched: true};
    console.log(JSON.stringify(result));
    return result;
  } finally {
    sandbox.setTrashed(true);
    lock.releaseLock();
  }
}
