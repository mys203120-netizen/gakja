import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { actualEvaluativeQuestion, mayAskClarification, mayReplayQuestion, nextPosition, type InterviewSession, type RecordedTurn, type QuestionDraft } from '../server/protocol';
import type { InterviewContext } from '../server/data/load-interview-context';
import { createQuestionBlueprint, approveQuestionContract, assertQuestionContractIntegrity } from '../server/question-objective';
import { approvedAudioReplay } from '../server/providers/approved-audio-replay';
import { runStrategyRealtimeCore } from '../server/providers/realtime-strategy-core';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function setup() {
  const source = { id: 'e1', activityId: 'act1', text: '자료를 조사하고 비교하는 탐구를 진행함.', sourceRef: { pdfSha256: 'a'.repeat(64) } };
  const context = { errors: [], student: { evidence: [source] }, school: { sources: [], interview: { id: 'support1' } }, manifest: { rulesVersion: 'replay-fixture', files: [{ role: 'studentPdf', path: 'synthetic.pdf', sha256: 'a'.repeat(64) }], sourceIntegrity: { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true } }, questionStrategies: null, questionReferences: null } as unknown as InterviewContext;
  const session = { id: 'session-replay', status: 'active', elapsedMs: 1000, durationSeconds: 720, sourceManifest: context.manifest, plan: { scheduling: 'time_based' }, turns: [], followUpCountByMainQuestion: {} } as unknown as InterviewSession;
  const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: '자료를 비교한 과정은 무엇인가요?', questionKind: 'main', parentMainQuestionId: null, evidenceIds: ['e1'], evidenceQuotes: [{ evidenceId: 'e1', quote: source.text }], primaryFunction: 'PROCESS', questionIntent: '자료를 비교한 실제 수행 과정 확인', targetEvidence: ['자료 비교에서 실제로 거친 한 단계'], depth: 'D2', groundingRationale: '실제 기록의 자료 비교 과정을 확인한다.', validationStatus: 'approved', validationFailures: [] };
  draft.premiseValidation = { version: 'question-premise-v1', guidelineVersion: '2.3', status: 'approved', method: 'bounded_semantic_review', reviewModel: 'explicit-synthetic-review', questionSha256: hash(draft.questionText), coreIntentCount: 1, supportedPremises: [{ questionStartOffset: 0, questionEndOffset: 3, basis: 'record', sourceId: 'e1', sourceStartOffset: 0, sourceEndOffset: 3 }], openChecks: [] };
  draft.questionBlueprint = createQuestionBlueprint(draft, context, session, { questionId: 'q0' }); draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint);
  const q0 = { id: 'q0', parentMainQuestionId: 'q0', questionKind: 'main', questionText: draft.questionText, mainIndex: 1, mainCount: 3, followUpIndex: 0, evidenceIds: draft.evidenceIds, answerId: 'a0', rawTranscript: '자료를 비교했습니다.', transcriptStatus: 'finalized', metadata: { ...draft, rulesVersion: 'replay-fixture', activityIds: ['act1'], questionClusterId: 'q0' } } as unknown as RecordedTurn;
  session.turns.push(q0); return { context, session, q0 };
}
test('pure audio replay remains available after a meaning rephrase without consuming F or another rephrase', () => {
  const { session, q0 } = setup();
  const q0c = { ...q0, id: 'q0-rephrase', questionKind: 'clarification', metadata: { ...q0.metadata, nonEvaluative: true, clarificationOfTurnId: q0.id, clarificationMode: 'rephrase' } } as RecordedTurn;
  session.turns.push(q0c); assert.equal(mayAskClarification(session, 720), false); assert.equal(mayReplayQuestion(session, 720), true);
  assert.equal(nextPosition(session, 'clarification', 3, 2, 720, { clarificationMode: 'repeat_audio' })?.kind, 'clarification');
  assert.equal(session.followUpCountByMainQuestion.q0 ?? 0, 0);
  const f1 = { ...q0, id: 'f1', questionKind: 'follow_up', followUpIndex: 1 } as RecordedTurn;
  session.turns.push(f1); assert.equal(mayAskClarification(session, 720), true);
  const replay = { ...f1, id: 'f1-replay', questionKind: 'clarification', metadata: { ...f1.metadata, nonEvaluative: true, clarificationOfTurnId: 'f1', clarificationMode: 'repeat_audio' } } as RecordedTurn;
  session.turns.push(replay); assert.equal(mayAskClarification(session, 720), true);
  const rephrase = { ...replay, id: 'f1-rephrase', metadata: { ...replay.metadata, clarificationOfTurnId: replay.id, clarificationMode: 'rephrase' } } as RecordedTurn;
  session.turns.push(rephrase); assert.equal(actualEvaluativeQuestion(session)?.id, 'f1'); assert.equal(mayAskClarification(session, 720), false); assert.equal(mayReplayQuestion(session, 720), true);
  session.elapsedMs = 720000; assert.equal(mayReplayQuestion(session, 720), false); assert.equal(nextPosition(session, 'clarification', 3, 2, 720, { clarificationMode: 'repeat_audio' }), null);
});
test('clarification ancestry cycles fail closed instead of borrowing a Q0 or looping', () => {
  const { session, q0 } = setup(); session.turns.push({ ...q0, id: 'cycle', questionKind: 'clarification', metadata: { ...q0.metadata, clarificationOfTurnId: 'cycle' } } as RecordedTurn);
  assert.equal(actualEvaluativeQuestion(session), null); assert.equal(mayReplayQuestion(session, 720), false);
});
test('natural repeat requests bypass only rephrase budget, with no F generation or independent review', async () => {
  const { context, session } = setup();
  const result = await runStrategyRealtimeCore(context, session, { allowFollowUp: false, allowClarification: false, allowReplay: true, requestStrategy: async () => ({ answerRelation: { kind: 'related', note: '일부 답변과 함께 질문 재청취를 요청했다.' }, interpretation: { meaning: '자료를 비교했다고 답하면서 재청취를 요청함.', dialogueRequests: ['repeat_audio'], covered: [], unresolved: [], corrections: [], uncertainty: [] }, decision: { fulfillment: 'partial', action: 'CLARIFICATION', reason: 'repeat_request', necessity: '원래 요청을 바꾸지 않고 같은 음성을 다시 전달한다.', reaction: null, question: null } }), requestReview: async () => { throw new Error('no semantic generation to review'); } });
  assert.equal(result.nextAction, 'CLARIFICATION'); assert.equal(result.clarificationMode, 'repeat_audio'); assert.equal(result.providerTimings.coreModelCalls, 1); assert.equal(result.providerTimings.premiseReviewAttempts, 0);
});
test('an approved natural F can be replayed exactly with answer-source proof retained', () => {
  const { context, session, q0 } = setup();
  const draft: QuestionDraft = { ...q0.metadata, acknowledgement: null, acknowledgementQuote: null, questionText: '자료를 비교할 때 어떤 기준을 사용했나요?', questionKind: 'follow_up', parentMainQuestionId: q0.id, evidenceIds: q0.evidenceIds, primaryFunction: 'CHOICE', questionIntent: '자료 비교에 실제 사용한 기준 확인', targetEvidence: ['자료 비교의 판단 기준'] };
  draft.premiseValidation = { ...q0.metadata.premiseValidation!, questionSha256: hash(draft.questionText), supportedPremises: [{ questionStartOffset: 0, questionEndOffset: 6, basis: 'answer_turn_attributed', sourceId: 'ANSWER_TURN:q0:a0', sourceStartOffset: 0, sourceEndOffset: 6 }] };
  draft.questionBlueprint = createQuestionBlueprint(draft, context, session, { questionId: 'f1', subordinationRationale: '같은 자료 비교의 판단 기준 한 지점 확인', answerRefs: [{ turnId: 'q0', answerId: 'a0', start: 0, end: 6 }] }); draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint);
  const f1 = { ...q0, id: 'f1', questionKind: 'follow_up', questionText: draft.questionText, answerId: 'a1', metadata: { ...q0.metadata, ...draft, rulesVersion: 'replay-fixture' } } as RecordedTurn;
  session.turns.push(f1); const replay = approvedAudioReplay(context, session);
  assert.ok(replay); assert.equal(replay.questionText, f1.questionText); assert.equal(replay.clarificationMode, 'repeat_audio'); assert.equal(replay.approvedQuestion!.validation.independentSemanticReview, false);
  assert.ok(replay.questionBlueprint!.anchorRefs.some(ref => ref.sourceId === 'ANSWER_TURN:q0:a0')); assert.doesNotThrow(() => assertQuestionContractIntegrity(replay, replay.approvedQuestion!));
  q0.rawTranscript = '나중에 바뀐 다른 답변'; assert.equal(approvedAudioReplay(context, session), null);
});
