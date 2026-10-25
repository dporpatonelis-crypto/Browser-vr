import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {filterScenarios,relevantHistory} from '../public/domain.mjs';

const localRegistry=new URL('../public/data/scenario-registry.json',import.meta.url);
const registry=JSON.parse(readFileSync(existsSync(localRegistry)?localRegistry:new URL('../site/data/scenario-registry.json',import.meta.url)));
test('Greek accent independent search and class filters retain only evidenced grades',()=>{
  const found=filterScenarios(registry.scenarios,{search:'αβρααμ'});
  assert.ok(found.some(s=>s.scenario_id==='book:abraham-journey'));
  const grade=filterScenarios(registry.scenarios,{grade:'Α΄ Γυμνασίου'});
  assert.ok(grade.some(s=>s.scenario_id==='sb:vivlos-dialogos-kai-drasi'));
  assert.ok(!grade.some(s=>s.scenario_id==='book:abraham-journey'));
  const expanded=filterScenarios(registry.scenarios,{grade:'Α΄ Γυμνασίου',includeUnknown:true});
  assert.ok(expanded.some(s=>s.scenario_id==='book:abraham-journey'));
});
test('HTML and Slides filters include connected real activities',()=>{
  const slides=filterScenarios(registry.scenarios,{source:'Slides'});
  assert.ok(slides.some(s=>s.scenario_id==='book:father-sophrony'));
  const html=filterScenarios(registry.scenarios,{source:'Drive HTML'});
  assert.ok(html.some(s=>s.scenario_id==='sculpture:spiritual-freedom'));
});
test('older same section record outranks newer unrelated records',()=>{
  const rows=[
    {id:'a',scenario_id:'s',grade:'Β΄ Λυκείου',section:'Β1',created_at:'2026-10-20',flags:['more-guidance']},
    {id:'b',scenario_id:'s',grade:'Β΄ Λυκείου',section:'Β2',created_at:'2026-10-21',flags:['worked-well']},
    {id:'c',scenario_id:'s',grade:'Γ΄ Λυκείου',section:'Γ1',created_at:'2026-10-22',flags:['too-difficult']},
  ];
  assert.equal(relevantHistory(rows,'s','Β΄ Λυκείου','β1').latest.id,'a');
  assert.equal(relevantHistory(rows,'s','Β΄ Λυκείου','Β3').latest.id,'b');
  assert.equal(relevantHistory(rows,'s','Α΄ Γυμνασίου').latest.id,'c');
  assert.equal(relevantHistory(rows,'s').summary.total,3);
  assert.equal(rows[0].id,'a');
});
