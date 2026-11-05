import test from 'node:test';
import assert from 'node:assert/strict';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession, RecordedTurn } from '../server/protocol';
import { answerContextTrace, buildAnswerContext, isIncompleteAnswerFragment } from '../server/providers/answer-context';
import { reactToAnswer, reactionRequest } from '../server/providers/answer-reaction';

function turn(id: string, rawTranscript: string, root = 'q0'): RecordedTurn {
  return { id, answerId: `${id}-answer`, parentMainQuestionId: root, questionKind: id === root ? 'main' : 'clarification', questionText: '자료를 선택한 기준은 무엇인가요?', transcriptStatus: 'finalized', rawTranscript, metadata: { primaryFunction: 'CHOICE', questionIntent: '실제 자료 선택 기준 확인', targetEvidence: ['자료 선택 기준'], depth: 'D2' } } as RecordedTurn;
}
const session = (turns: RecordedTurn[]) => ({ turns, followUpCountByMainQuestion: {}, elapsedMs: 0 } as InterviewSession);

test('context preserves original finalized answers, corrections and negations in the same root without inferring facts', () => {
  const original = turn('q0', '공식 기관의 자료를 봤습니다. 결과 수치는 없었습니다.');
  const uncertain = { ...turn('f-error', '보존하면 안 되는 미확정 주장'), transcriptStatus: 'error' } as RecordedTurn;
  const correction = turn('c1', '정정하겠습니다. 기관 이름이 아니라 작성 연도를 비교했습니다.');
  const value = session([turn('old', '다른 질문의 문장', 'old'), original, uncertain, correction]);
  const context = buildAnswerContext(value)!;
  assert.deepEqual(context.answers.map(answer => answer.turnId), ['q0', 'c1']);
  assert.equal(context.answers[0].rawTranscript, original.rawTranscript);
  assert.equal(context.answers[1].rawTranscript, correction.rawTranscript);
  assert.ok(context.answers[0].languageSignals.some(signal => signal.kind === 'negation'));
  assert.ok(context.answers[1].languageSignals.some(signal => signal.kind === 'correction'));
  for (const answer of context.answers) for (const signal of answer.languageSignals) assert.ok(answer.rawTranscript.slice(signal.start, signal.end).length > 0);
  const payload = JSON.parse(reactionRequest(value).input);
  assert.deepEqual(payload.answer.context, context);
  const trace = JSON.stringify(answerContextTrace(value));
  assert.ok(!trace.includes(original.rawTranscript!)); assert.ok(!trace.includes(correction.rawTranscript!));
  assert.ok(trace.includes('transcriptSha256')); assert.equal(context.rootQuestion.text, original.questionText);
});

test('the observed fragment 같은 is reconfirmed without making up an evaluative claim or consuming F', async () => {
  const value = session([turn('q0', '같은 ')]);
  const reaction = await reactToAnswer({} as InterviewContext, value, true, { request: async () => { throw new Error('Fragment needs no model'); } });
  assert.equal(reaction.classification, 'unclear'); assert.equal(reaction.reasonCode, 'UNINTELLIGIBLE_CONTENT');
  assert.equal(reaction.directive, 'clarification_same_target'); assert.equal(reaction.keywordQuote, null);
  assert.equal(reaction.missingTarget, '자료 선택 기준'); assert.equal(reaction.probeBasis, null);
  assert.equal(buildAnswerContext(value)!.answers[0].observation, 'incomplete_fragment');
});

test('short valid terms, numbers, negative answers and substantive fragment-prefix answers remain semantically classified', async () => {
  for (const answer of ['백금입니다.', '3', '아니요.', '없었습니다.', '같은 조건에서 온도를 비교했습니다.', '그래서 작성 연도를 먼저 비교했습니다.']) {
    assert.equal(isIncompleteAnswerFragment(answer), false);
    const value = session([turn('q0', answer)]); value.turns[0].questionText = '비교에 쓴 재료는 무엇인가요?';
    let calls = 0;
    const result = await reactToAnswer({} as InterviewContext, value, true, { request: async () => { calls++; return { classification: 'relevant', action: 'proceed', keywordQuote: null, reply: null, reasonCode: 'ANSWER_RELATED', evidenceSpan: null, missingTarget: null }; } });
    assert.equal(calls, 1); assert.equal(result.directive, 'next_main'); assert.equal(result.classification, 'relevant');
  }
});
