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
  if (initial.grade && typeof parameters.section === 'string') initial.section = parameters.section.slice(0, 40);
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

function validateRecord_(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || JSON.stringify(data).length > 12000) {
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
  const timestamp = new Date();
  return {schema_version: 1, id: data.request_id.toLowerCase(), scenario_id: scenario.scenario_id,
    scenario_title: scenario.title, created_at: timestamp.toISOString(),
    date: Utilities.formatDate(timestamp, 'Europe/Athens', 'yyyy-MM-dd'), timezone: 'Europe/Athens',
    grade, section: section.trim(), model_id: model.id, model_title: model.title,
    flags: [...new Set(data.flags)], flag_labels: Object.fromEntries(MODELS.flags.filter(f => data.flags.includes(f.id)).map(f => [f.id, f.label])),
    cognitive_difficulty: difficulty, technical_difficulty: scenario.technical_difficulty};
}

function saveEvaluation(data) {
  assertOwner_();
  const record = validateRecord_(data);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return persistRecord_(record, folder_()); }
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
  return {schema_version: 1, exported_at: new Date().toISOString(), evaluations: listEvaluations().records};
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
