export function normalize(text = '') {
  return String(text).normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('el').replaceAll('ς', 'σ');
}

export function filterScenarios(scenarios, filters) {
  const search = normalize(filters.search);
  const goal = normalize(filters.goal);
  return scenarios.filter(s => {
    if (filters.grade && !s.grades.includes(filters.grade) && !(filters.includeUnknown && !s.grades.length)) return false;
    if (filters.subject && s.subject !== filters.subject) return false;
    if (filters.source && !s.formats.includes(filters.source) && !s.source_groups.includes(filters.source)) return false;
    if (search && !normalize([s.title, s.subject, s.inquiry_question, ...s.modes].join(' ')).includes(search)) return false;
    if (goal && !normalize([...s.objectives, ...s.modes, s.pedagogical_application].join(' ')).includes(goal)) return false;
    return true;
  });
}

export function relevantHistory(records, scenarioId, grade = '', section = '') {
  const rows = records.filter(r => r.scenario_id === scenarioId).sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  let latest, scope = 'general';
  if (grade && section) {
    latest = rows.find(r => r.grade === grade && normalize(r.section?.trim()) === normalize(section.trim()));
    if (latest) scope = 'section';
  }
  if (!latest && grade) {
    latest = rows.find(r => r.grade === grade);
    if (latest) scope = 'grade';
  }
  latest ??= rows[0] ?? null;
  return {records: rows, latest, scope, summary: {
    total: rows.length,
    positive: rows.filter(r => r.flags.includes('worked-well')).length,
    increased_difficulty: rows.filter(r => r.flags.includes('too-difficult')).length,
  }};
}

export function latestPlans(plans, scenarioId) {
  const rows = plans.filter(p => p.scenario_id === scenarioId);
  const byId = new Map(rows.map(p => [p.id,p])), superseded = new Set();
  for (const row of rows) {
    let parent = byId.get(row.previous_version_id);
    const visited = new Set([row.id]);
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id);
      if (parent.plan_id === row.plan_id && sameTeachingSession(parent,row)) superseded.add(parent.id);
      parent = byId.get(parent.previous_version_id);
    }
  }
  return rows.filter(p => !superseded.has(p.id)).sort((a,b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

export function sameTeachingSession(a,b) {
  return a.scenario_id === b.scenario_id && (a.grade || '') === (b.grade || '') &&
    normalize(a.section?.trim()) === normalize(b.section?.trim()) && (a.lesson_date || '') === (b.lesson_date || '');
}

export function materialChoices(scenario, plan) {
  const choices = new Map((plan?.planned_materials || []).map(a => [a.id,{...a, unavailable:true}]));
  for (const a of scenario.activities) choices.set(a.id,a);
  return [...choices.values()];
}
