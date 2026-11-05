import test from 'node:test';
import assert from 'node:assert/strict';
import type { InterviewSession, RecordedTurn } from '../server/protocol';
import { buildConversationLedger, conversationLedgerTrace, ledgerTargetKey } from '../server/conversation-ledger';
import { recordQuestionPresentation } from '../server/question-presentation';
import { mayAskFollowUp } from '../server/interview-planner';
import { nextPosition } from '../server/protocol';

function turn(id: string, raw: string, options: Partial<RecordedTurn> = {}): RecordedTurn {
  return { id, parentMainQuestionId: 'root', questionKind: id === 'root' ? 'main' : 'follow_up', questionText: '어떤 근거로 판단했나요?', evidenceIds: ['source'], answerId: 'answer-' + id, rawTranscript: raw, transcriptStatus: 'finalized', metadata: { primaryFunction: 'EVIDENCE', questionIntent: '판단 근거를 확인한다.', targetEvidence: ['판단의 근거 한 가지'], activityIds: ['activity'] }, ...options } as RecordedTurn;
}
function session(turns: RecordedTurn[]): InterviewSession { return { turns, followUpCountByMainQuestion: {}, elapsedMs: 0 } as InterviewSession; }

test('ledger includes only finalized actual words, preserves negation and correction, and never labels claims record facts', () => {
  const turns = [turn('root', '처음에는 측정했다고 말했습니다.'), turn('follow', '정확히는 직접 측정하지 않았습니다. 자료를 조사했습니다.'), turn('stream', '아직 확정하지 않은 말', { transcriptStatus: 'streaming' })];
  const ledger = buildConversationLedger(session(turns));
  assert.equal(ledger.answers.length, 2);
  assert.ok(ledger.claims.every(claim => claim.status === 'student_claim_unverified'));
  for (const claim of ledger.claims) assert.equal(turns.find(item => item.id === claim.turnId)!.rawTranscript!.slice(claim.start, claim.end), claim.text);
  assert.equal(ledger.correctionCandidates.length, 1);
  assert.equal(ledger.correctionCandidates[0].status, 'requires_context_review');
  assert.ok(ledger.claims.some(claim => claim.signals.some(signal => signal.kind === 'correction')));
  assert.ok(!JSON.stringify(conversationLedgerTrace(ledger)).includes('직접 측정'));
});

test('unbound judgments cannot mark a target fulfilled and actual clarification completion resolves the original target', () => {
  const root = turn('root', '네.');
  Object.assign(root.metadata, { coreDecision: { sourceTurnId: 'wrong', sourceAnswerId: root.answerId, fulfillment: 'met' } });
  assert.equal(buildConversationLedger(session([root])).establishedTargets.length, 0);
  const clarification = turn('clarification', '관찰한 결과가 판단의 근거였습니다.', { questionKind: 'clarification' });
  Object.assign(clarification.metadata, { coreDecision: { sourceTurnId: clarification.id, sourceAnswerId: clarification.answerId, fulfillment: 'met', nextAction: 'TRANSITION' } });
  const ledger = buildConversationLedger(session([root, clarification]));
  assert.equal(ledger.establishedTargets.length, 1);
  assert.equal(ledger.unresolvedTargets.length, 0);
  assert.equal(ledger.followUpsUsed, 0);
});

test('cross-cluster memory is source-related and bounded while same-cluster words and silence remain intact', () => {
  const unrelated = turn('unrelated', '무관한 이전 자료', { parentMainQuestionId: 'unrelated', evidenceIds: ['other'], metadata: { ...turn('x', '').metadata, activityIds: ['other'] } });
  const related = turn('earlier', '같은 활동의 앞선 설명', { parentMainQuestionId: 'earlier' });
  const root = turn('root', '', { answerObservation: { classification: 'silence_observed', nonAnswer: true, durationMs: 1000, speakingMs: 0, silenceMs: 1000, firstSpeechMs: null, speechDetected: false, rawTranscriptPreserved: true, origin: 'finalized-stt-and-observed-speech-timing' } });
  const ledger = buildConversationLedger(session([unrelated, related, root]));
  assert.deepEqual(ledger.crossClusterTurnIds, ['earlier']);
  assert.equal(ledger.answers.find(answer => answer.turnId === 'root')?.observation, 'no_final_words');
  assert.equal(ledger.declinedTargets[0].reason, 'silence');
  assert.equal(buildConversationLedger(session([unrelated, related, root]), { crossClusterLimit: 0 }).crossClusterTurnIds.length, 0);
  assert.deepEqual(ledger, buildConversationLedger(session([unrelated, related, root])));
});

test('a runtime draft spends no follow-up budget and replay attempts spend it only once', () => {
  const pending = turn('follow', '', { transcriptStatus: undefined });
  const active = session([turn('root', '자료를 조사했습니다.'), pending]);
  active.runtime = { version: 'session-runtime-v1' } as NonNullable<InterviewSession['runtime']>;
  active.followUpCountByMainQuestion = { root: 1 };
  assert.equal(buildConversationLedger(active).followUpsUsed, 0);
  active.questionPresentations = [{ turnId: pending.id, rootTurnId: 'root', questionKind: 'follow_up', startedAtMs: 500, completedAtMs: null }];
  assert.equal(buildConversationLedger(active).followUpsUsed, 1);
  active.questionPresentations.push({ ...active.questionPresentations[0], startedAtMs: 800, completedAtMs: 1000 });
  assert.equal(buildConversationLedger(active).followUpsUsed, 1);
});

test('a delayed playback start restores the shared F limit before another question, even if the stored counter lags', () => {
  const first = turn('f1', 'First finalized synthetic answer.'), second = turn('f2', 'Second finalized synthetic answer.');
  Object.assign(first, { mainIndex: 1, followUpIndex: 1 }); Object.assign(second, { mainIndex: 1, followUpIndex: 2 });
  const active = session([turn('root', 'Root answer.'), first, second]);
  active.runtime = { version: 'session-runtime-v1' } as NonNullable<InterviewSession['runtime']>;
  active.plan = { scheduling: 'time_based' } as InterviewSession['plan']; active.mainQuestionTarget = 5;
  active.followUpCountByMainQuestion.root = 0;
  const started = { eventId: 'first-start', type: 'question_playing', turnId: 'f1', clockId: 'clock', atMs: 10 };
  recordQuestionPresentation(active, { eventId: 'first-end', type: 'audio_ended', turnId: 'f1', clockId: 'clock', atMs: 20, payload: { role: 'question' } }, first);
  recordQuestionPresentation(active, { ...started, eventId: 'second-start', turnId: 'f2', atMs: 30 }, second);
  assert.equal(buildConversationLedger(active).followUpsUsed, 1);
  recordQuestionPresentation(active, started, first); recordQuestionPresentation(active, started, first);
  assert.equal(buildConversationLedger(active).followUpsUsed, 2);
  assert.equal(mayAskFollowUp(active, 600, 2), false);
  assert.equal(nextPosition(active, 'follow_up', 5, 2, 600)?.kind, 'main');
});

test('a quoted covered part does not mark the whole requirement met while another part is unresolved', () => {
  const root = turn('root', '약전해질의 변화만 설명했습니다.');
  const id = ledgerTargetKey(root);
  root.metadata.coreDecision = { sourceTurnId: root.id, sourceAnswerId: root.answerId, fulfillment: 'partial',
    interpretation: { meaning: '한 비교 대상만 답함', dialogueRequests: [], covered: [{ targetId: id, answerQuote: root.rawTranscript! }],
      unresolved: [{ targetId: id, missingMeaning: '다른 비교 대상' }], corrections: [], uncertainty: [] } };
  const result = buildConversationLedger(session([root]));
  assert.ok(!result.establishedTargets.includes(id));
  assert.ok(result.unresolvedTargets.includes(id));
});

test('a later reviewed local completion survives an earlier partial interpretation without changing history', () => {
  const root = turn('root', '다같이 했습니다.');
  const targetId = ledgerTargetKey(root);
  root.metadata.coreDecision = { sourceTurnId: root.id, sourceAnswerId: root.answerId, fulfillment: 'partial',
    interpretation: { meaning: '공동 활동만 설명함', dialogueRequests: [], covered: [{ targetId, answerQuote: root.rawTranscript! }],
      unresolved: [{ targetId, missingMeaning: '본인이 수행한 행동' }], corrections: [], uncertainty: [] } };
  const clarification = turn('clarification', '제가 안내 문구를 고쳤습니다.', { questionKind: 'clarification' });
  // The independent review can confirm fulfillment without manufacturing a
  // generator quote when it overrides an earlier partial judgment.
  clarification.metadata.coreDecision = { sourceTurnId: clarification.id, sourceAnswerId: clarification.answerId, fulfillment: 'met',
    interpretation: { meaning: '본인 행동을 구체화함', dialogueRequests: [], covered: [], unresolved: [], corrections: [], uncertainty: [] } };
  const result = buildConversationLedger(session([root, clarification]));
  assert.deepEqual(result.establishedTargets, [targetId]);
  assert.deepEqual(result.unresolvedTargets, []);
  assert.equal(result.requestedTargets[0].fulfillment, 'partial');
  assert.equal(result.requestedTargets[1].fulfillment, 'met');
});

test('source-bound unknown and unbound or unfinished interpretations cannot manufacture completion', () => {
  for (const mode of ['unknown', 'unbound', 'unfinished'] as const) {
    const root = turn('root', '일부를 설명했습니다.');
    const targetId = ledgerTargetKey(root);
    if (mode === 'unfinished') root.transcriptStatus = 'streaming';
    root.metadata.coreDecision = { sourceTurnId: mode === 'unbound' ? 'wrong-turn' : root.id, sourceAnswerId: root.answerId, fulfillment: mode === 'unknown' ? 'unknown' : 'met',
      interpretation: { meaning: '일부 설명', dialogueRequests: [], covered: [{ targetId, answerQuote: root.rawTranscript! }], unresolved: [], corrections: [], uncertainty: [] } };
    const result = buildConversationLedger(session([root]));
    assert.deepEqual(result.establishedTargets, [], mode);
    assert.deepEqual(result.unresolvedTargets, [targetId], mode);
  }
});

test('a later genuine correction can reopen an earlier target while its own requested target is fulfilled', () => {
  const root = turn('root', '직접 측정한 값으로 판단했습니다.');
  const rootTargetId = ledgerTargetKey(root);
  root.metadata.coreDecision = { sourceTurnId: root.id, sourceAnswerId: root.answerId, fulfillment: 'met' };
  const followUp = turn('follow', '정확히는 직접 측정하지 않았습니다. 표의 출처는 논문입니다.');
  followUp.metadata.questionIntent = '활용한 자료의 출처를 확인한다.';
  followUp.metadata.targetEvidence = ['자료의 출처 한 가지'];
  const followTargetId = ledgerTargetKey(followUp);
  followUp.metadata.coreDecision = { sourceTurnId: followUp.id, sourceAnswerId: followUp.answerId, fulfillment: 'met',
    interpretation: { meaning: '출처를 밝히며 이전 측정 행동을 정정함', dialogueRequests: [], covered: [{ targetId: followTargetId, answerQuote: '표의 출처는 논문입니다.' }],
      unresolved: [{ targetId: rootTargetId, missingMeaning: '실제로 수행한 판단 행동' }], corrections: ['직접 측정했다는 앞선 답변을 취소함'], uncertainty: [] } };
  const result = buildConversationLedger(session([root, followUp]));
  assert.deepEqual(result.establishedTargets, [followTargetId]);
  assert.deepEqual(result.unresolvedTargets, [rootTargetId]);
  assert.equal(result.requestedTargets[0].fulfillment, 'met', 'historical observation remains unchanged');
});

test('a replay request with unknown fulfillment preserves the earlier aggregate result and its own unknown row', () => {
  for (const fulfillment of ['met', 'partial'] as const) {
    const root = turn('root', '논문에 제시된 관찰 결과로 판단했습니다.');
    const targetId = ledgerTargetKey(root);
    root.metadata.coreDecision = { sourceTurnId: root.id, sourceAnswerId: root.answerId, fulfillment };
    const replay = turn('replay', '다시 들려주세요.', { questionKind: 'clarification' });
    replay.metadata.clarificationMode = 'repeat_audio';
    replay.metadata.coreDecision = { sourceTurnId: replay.id, sourceAnswerId: replay.answerId, fulfillment: 'unknown' };
    const result = buildConversationLedger(session([root, replay]));
    assert.equal(result.establishedTargets.includes(targetId), fulfillment === 'met');
    assert.equal(result.unresolvedTargets.includes(targetId), fulfillment === 'partial');
    assert.equal(result.requestedTargets[1].fulfillment, 'unknown');
  }
});

test('an unknown local judgment still preserves a source-bound correction that reopens its earlier target', () => {
  const root = turn('root', '직접 측정한 값으로 판단했습니다.');
  const targetId = ledgerTargetKey(root);
  root.metadata.coreDecision = { sourceTurnId: root.id, sourceAnswerId: root.answerId, fulfillment: 'met' };
  const correction = turn('correction', '정확히는 직접 측정하지 않았습니다.', { questionKind: 'clarification' });
  correction.metadata.coreDecision = { sourceTurnId: correction.id, sourceAnswerId: correction.answerId, fulfillment: 'unknown',
    interpretation: { meaning: '앞선 행동 설명을 취소함', dialogueRequests: [], covered: [],
      unresolved: [{ targetId, missingMeaning: '실제 판단 근거' }], corrections: ['직접 측정했다는 앞선 답변을 취소함'], uncertainty: [] } };
  const result = buildConversationLedger(session([root, correction]));
  assert.deepEqual(result.establishedTargets, []);
  assert.deepEqual(result.unresolvedTargets, [targetId]);
  assert.equal(result.requestedTargets[1].fulfillment, 'unknown');
});
