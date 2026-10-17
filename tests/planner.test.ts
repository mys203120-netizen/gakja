import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {validPlanDay,koreaToday,planWeek,monthDays,planTargetHref} from '../apps/web/src/lib/planner-model';
test('plan dates reject nonexistent leap/calendar days',()=>{assert.equal(validPlanDay('2026-02-29'),false);assert.equal(validPlanDay('2028-02-29'),true);assert.equal(validPlanDay('2026-13-01'),false);});
test('today and week respect Korean midnight and year boundary',()=>{assert.equal(koreaToday(new Date('2026-10-11T15:01:00Z')),'2026-10-12');assert.deepEqual(planWeek('2027-01-01'),['2026-12-28','2026-12-29','2026-12-30','2026-12-31','2027-01-01','2027-01-02','2027-01-03']);});
test('month grid contains complete weeks and every calendar date',()=>{const days=monthDays('2026-02');assert.equal(days.length,28);assert.equal(days[0],'2026-02-01');assert.equal(days.at(-1),'2026-02-28');assert.equal(monthDays('2026-05').length,42);});
test('owned plan targets yield fixed internal paths with opaque IDs encoded',()=>{
  assert.equal(planTargetHref({kind:'question',id:'q&next=evil'},'interview'),'/interview/new?questionId=q%26next%3Devil');
  assert.equal(planTargetHref({kind:'question',id:'q'},'quiz'),'/quiz?questionId=q');
  assert.equal(planTargetHref({kind:'activity',id:'a/b'},'study'),'/materials/activities/a%2Fb');
  assert.equal(planTargetHref({kind:'video',id:'lQRsqMiBTsI'},'reading'),'/knowledge/lQRsqMiBTsI');
  assert.equal(planTargetHref({kind:'assignment',id:'task'},'quiz'),'/quiz/assignments/task');
});
test('common recall plans open quiz with their saved school and common revision',()=>{
  const target={kind:'question' as const,id:'school-q',common:true,targetId:'school-a',sourceType:'common' as const,sourceVersion:3};
  const quiz=new URL(planTargetHref(target,'quiz'),'http://local.test');
  assert.equal(quiz.pathname,'/quiz');
  assert.deepEqual(Object.fromEntries(quiz.searchParams),{questionId:'school-q',targetId:'school-a',sourceType:'common',sourceVersion:'3'});
  const {sourceType,...legacy}=target;
  assert.equal(new URL(planTargetHref(legacy,'quiz'),'http://local.test').searchParams.get('sourceType'),'common');
  assert.equal(new URL(planTargetHref(target,'interview'),'http://local.test').pathname,'/interview/new');
  assert.equal(new URL(planTargetHref(legacy,'study'),'http://local.test').pathname,'/interview/new');
});
