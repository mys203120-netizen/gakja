import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticPracticeDays} from '../apps/web/src/lib/automatic-practice';
import {recordMatchesCurrentTarget} from '../apps/web/src/lib/learning-target-scope';
const questions=[{id:'a',title:'연습한 질문',practiced:true},{id:'b',title:'새 질문',practiced:false}];
test('foundation starts with unpracticed questions; the final week is spoken rehearsal',()=>{
  const foundation=automaticPracticeDays('2026-12-01','2027-01-02',30,questions);
  assert.equal(foundation[0].questionId,'b');assert.equal(foundation[0].kind,'quiz');assert.equal(foundation[2].kind,'interview');
  const result=automaticPracticeDays('2026-12-30','2027-01-02',30,questions);
  assert.equal(result.length,5);assert.equal(result[0].questionId,'b');assert.equal(result[0].kind,'interview');
  assert.equal(result[2].kind,'interview');assert.equal(result.at(-1)?.date,'2027-01-01');
  assert.equal(result.filter(p=>p.date==='2027-01-01').length,1);
  assert.equal(result.at(-1)?.minutes,10);
  assert.ok(result.every(p=>p.date<'2027-01-02'));
});
test('tomorrow still has one rehearsal and no empty or unlimited schedules',()=>{
  assert.equal(automaticPracticeDays('2028-02-28','2028-02-29',20,questions).length,1);
  for(const day of ['2026-10-16','2026-10-17','2027-02-30','2027-10-17'])assert.throws(()=>automaticPracticeDays('2026-10-17',day,20,questions));
  assert.throws(()=>automaticPracticeDays('2026-10-17','2026-10-20',20,[]));
  assert.throws(()=>automaticPracticeDays('2026-10-17','2026-10-20',99,questions));
});
test('deleted Kookmin records never enter current Korea recommendations',()=>{
  const korea={id:'korea',university:'고려대학교',department:'경영학과',admission_year:2027,admission_type:'종합',campus:'본교'};
  const kookmin={id:'kookmin',university:'국민대학교',department:'경영학과',admission_year:2027,admission_type:'종합',campus:'본교'};
  assert.equal(recordMatchesCurrentTarget({target_id:'kookmin',target_snapshot:kookmin},[korea]),false);
  assert.equal(recordMatchesCurrentTarget({target_id:'korea',target_snapshot:kookmin},[korea]),false);
  assert.equal(recordMatchesCurrentTarget({target_id:'korea',target_snapshot:korea},[korea]),true);
  assert.equal(recordMatchesCurrentTarget({targetId:'korea',targetSnapshot:korea},[korea]),true);
  assert.equal(recordMatchesCurrentTarget({target_id:'korea'},[korea]),false);
  assert.equal(recordMatchesCurrentTarget({target_id:'korea',target_snapshot:korea},[]),false);
});
