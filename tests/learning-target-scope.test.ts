import test from 'node:test';
import assert from 'node:assert/strict';
import { inLearningTargetScope, interviewMatchesLearningTarget, splitInterviewsByLearningTarget } from '../apps/web/src/lib/learning-target-scope';

const target = { id: 'uos', university: '서울시립대학교', admission_year: 2027, campus: '본교', department: '환경공학부', admission_type: '학생부종합Ⅰ', interview_stage: '2단계' };
const session = { id: 'old-1', target_id: target.id, data: { context: { targetId: target.id, target: structuredClone(target) } } };

test('only the selected target and frozen identity form the default resume group', () => {
  const other = { ...session, id: 'other', target_id: 'another' };
  const input = [other, session], before = JSON.stringify(input);
  const result = splitInterviewsByLearningTarget(input, target);
  assert.deepEqual(result.current.map(item => item.id), ['old-1']);
  assert.deepEqual(result.other.map(item => item.id), ['other']);
  assert.equal(JSON.stringify(input), before);
});

for (const changed of [{ university: '다른대학교' }, { department: '화학공학과' }, { campus: '분교' }, { admission_year: 2028 }, { admission_type: '다른 전형' }, { interview_stage: '3단계' }]) {
  test(`same target ID cannot relabel a frozen session after ${Object.keys(changed)[0]} changes`, () => {
    assert.equal(interviewMatchesLearningTarget(session, { ...target, ...changed }), false);
  });
}

test('legacy aliases work but a missing snapshot cannot certify current context', () => {
  assert.equal(interviewMatchesLearningTarget({ ...session, data: { context: { target: { university: target.university, year: 2027, campus: '본교', major: '환경공학부', track: target.admission_type } } } }, target), true);
  assert.equal(interviewMatchesLearningTarget({ target_id: target.id, data: {} }, target), false);
  assert.equal(interviewMatchesLearningTarget(session, null), false);
});

test('selected calendar scope changes with target while retaining general plans and explicit all scope', () => {
  assert.equal(inLearningTargetScope('uos', 'uos'), true);
  assert.equal(inLearningTargetScope('another', 'uos'), false);
  assert.equal(inLearningTargetScope('another', 'another'), true);
  assert.equal(inLearningTargetScope(undefined, 'uos'), true);
  assert.equal(inLearningTargetScope('another', 'uos', true), true);
});
