import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neutralReaction, quantizeReactionLevel, reactionFace, reactionLabel, validateInterviewerReaction } from '../apps/web/src/lib/interviewer-reaction';

const input = { question: '대조군은 실험에서 왜 필요하나요?', answer: '저는 오늘 점심에 떡볶이를 먹었습니다. 실험에 대한 답변은 하지 않겠습니다.' };
const offTopic = { engagement: 23, signal: 'off_topic', confidence: 'high', evidence: '오늘 점심에 떡볶이를 먹었습니다.', reason: '대조군의 역할 대신 식사 경험을 말했습니다.' };

test('expression intensity is bounded and quantized to five, with neutral invalid numbers', () => {
  for (const value of [-400, 0, 1, 12, 23, 49, 51, 99, 100, 999]) {
    const level = quantizeReactionLevel(value); assert.equal(level % 5, 0); assert.ok(level >= 0 && level <= 100);
  }
  assert.equal(quantizeReactionLevel(23), 25); assert.equal(quantizeReactionLevel(NaN), 50); assert.equal(quantizeReactionLevel(Infinity), 50);
});
test('a grounded semantic off-topic assessment changes the face after submission', () => {
  const reaction = validateInterviewerReaction(offTopic, input);
  assert.equal(reaction.signal, 'off_topic'); assert.equal(reaction.level, 25); assert.equal(reaction.status, 'evaluated');
  assert.equal(reaction.evidence, offTopic.evidence); assert.equal(reaction.timing, 'after_submission');
  assert.notDeepEqual(reactionFace(reaction), reactionFace(neutralReaction()));
});
test('negative words alone create no reaction; short or unusual wording can receive attentive feedback', () => {
  const answer = '터무니없는 결과처럼 보였지만 대조군과 비교해 측정 오류를 확인했습니다.';
  assert.equal(validateInterviewerReaction(null, { ...input, answer }).status, 'unavailable');
  const good = validateInterviewerReaction({ ...offTopic, engagement: 65, signal: 'attentive', evidence: '대조군과 비교해 측정 오류를 확인했습니다.', reason: '대조군을 비교 기준으로 설명했습니다.' }, { ...input, answer });
  assert.equal(good.signal, 'attentive'); assert.equal(good.status, 'evaluated');
  const brief = validateInterviewerReaction({ ...offTopic, engagement: 55, signal: 'attentive', evidence: '네', reason: '자료 확인 여부에 직접 답했습니다.' }, { question: '자료를 확인했나요?', answer: '네' });
  assert.equal(brief.status, 'evaluated');
});
test('a model quote absent from the actual answer never changes expression', () => {
  for (const evidence of ['실험은 전혀 몰라요.', '', 'x', 'a'.repeat(801)]) assert.equal(validateInterviewerReaction({ ...offTopic, evidence }, input).level, 50);
});
test('low confidence and transcript uncertainty keep a neutral face even with a negative signal', () => {
  assert.equal(validateInterviewerReaction({ ...offTopic, confidence: 'low' }, input).signal, 'uncertain');
  assert.equal(validateInterviewerReaction(offTopic, { ...input, transcriptUncertain: true }).status, 'unavailable');
});
test('malformed, extreme and signal-inconsistent output cannot masquerade as a reaction', () => {
  for (const change of [{ signal: 'angry' }, { engagement: '25' }, { engagement: 25.5 }, { engagement: -5 }, { engagement: 105 }, { engagement: 95 }, { reason: '' }, { reason: 'a'.repeat(501) }, { confidence: 'definitely' }]) {
    assert.equal(validateInterviewerReaction({ ...offTopic, ...change }, input).status, 'unavailable');
  }
  assert.equal(validateInterviewerReaction({ ...offTopic, signal: 'encouraging', engagement: 0 }, input).status, 'unavailable');
});
test('all 21 intensity steps have distinct geometry and no hostile frown', () => {
  const faces = Array.from({ length: 21 }, (_, index) => reactionFace({ ...neutralReaction(), status: 'evaluated', signal: index < 10 ? 'clarify' : 'encouraging', level: index * 5 }));
  assert.equal(new Set(faces.map(face => JSON.stringify(face))).size, 21);
  assert.ok(faces.every(face => face.mouthCurve >= 0 && Math.abs(face.headTilt) <= 5));
});
test('labels describe a coach response without displaying a percentage or ability score', () => {
  const reaction = validateInterviewerReaction(offTopic, input);
  assert.match(reactionLabel(reaction), /질문/); assert.doesNotMatch(reactionLabel(reaction), /%|점수|합격/);
  assert.equal(reactionLabel(neutralReaction('invalidated')), reactionLabel());
});
test('missing question or answer is never assessed', () => {
  assert.equal(validateInterviewerReaction(offTopic, { ...input, question: '' }).status, 'unavailable');
  assert.equal(validateInterviewerReaction(offTopic, { ...input, answer: '' }).status, 'unavailable');
});
