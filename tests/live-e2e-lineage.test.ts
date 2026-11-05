import test from 'node:test';
import assert from 'node:assert/strict';
import type { InterviewSession } from '../server/protocol';
import { auditLiveLineage } from '../scripts/audit-live-e2e-lineage';
import { maskConversationSecrets } from '../server/storage/conversation-log';

function fixture() {
  const main = { id: 'main', questionText: '본인이 한 일은 무엇인가요?', questionKind: 'main', parentMainQuestionId: 'main',
    answerId: 'a1', rawTranscript: '함께 했습니다.', transcriptStatus: 'finalized', metadata: {
      coreDecision: { sourceTurnId: 'main', sourceAnswerId: 'a1', semanticDecision: { next: { action: 'CLARIFICATION' } }, execution: { action: 'CLARIFICATION' } } } };
  const clarification = { id: 'same', questionText: '직접 맡은 일은 무엇인가요?', questionKind: 'clarification', parentMainQuestionId: 'main',
    answerId: 'a2', rawTranscript: '문구를 고쳤습니다.', transcriptStatus: 'finalized', metadata: { nonEvaluative: true, clarificationOfTurnId: 'main',
      coreDecision: { sourceTurnId: 'same', sourceAnswerId: 'a2', semanticDecision: { next: { action: 'TRANSITION' } }, execution: { action: 'TRANSITION' } } } };
  const evaluation = { answers: [{ turnId: 'main', answerAttemptTurnIds: ['main', 'same'],
    axes: { I: { quote: '문구를 고쳤습니다.' } }, quoteSources: { I: { sourceTurnId: 'same', answerId: 'a2', start: 0, end: 10 } } }],
    clusterScores: [{ rootTurnId: 'main', status: 'SCORABLE', members: [{ turnId: 'main', questionKind: 'main', weight: 1, score: 90 }] }] };
  evaluation.answers[0].quoteSources.I.end = clarification.rawTranscript.length;
  const durable = { id: 'synthetic', turns: [main, clarification], evaluationStatus: 'completed', evaluation,
    questionPresentations: [{ rootTurnId: 'main', turnId: 'main', questionKind: 'main', startedAtMs: 0, completedAtMs: 1 }] } as unknown as InterviewSession;
  const report = { endedThroughApi: true, replay: { allOriginalAnswersReady: true }, finalSession: { evaluation }, turns: [
    { index: 0, turnId: 'main', capture: { answerId: 'a1', rawTranscript: main.rawTranscript }, response: { status: 200 }, next: { turnId: 'same' } },
    { index: 1, turnId: 'same', capture: { answerId: 'a2', rawTranscript: clarification.rawTranscript }, response: { status: 200 } },
  ] };
  return { durable, report };
}

test('actual clarification attempts remain one evaluation unit with bound latest-answer quote', () => {
  const { durable, report } = fixture(), result = auditLiveLineage(report, durable, 1);
  assert.equal(result.integrityPass, true); assert.equal(result.checkedNonNullAxisQuotes, 1);
  assert.deepEqual(result.independentScoredUnitIds, ['main']);
});

test('lineage audit catches separate clarification scoring and forged quote offsets', () => {
  const { durable, report } = fixture();
  const evaluation = durable.evaluation as any;
  evaluation.answers.push({ turnId: 'same', axes: {} }); evaluation.answers[0].quoteSources.I.start = 1;
  const result = auditLiveLineage(report, durable, 1);
  assert.ok(result.issues.some(issue => issue.startsWith('CLARIFICATION_SCORED_SEPARATELY')));
  assert.ok(result.issues.some(issue => issue.startsWith('EVALUATION_QUOTE_NOT_BOUND')));
});

test('lineage audit rejects duplicate end and missing planned replay inputs', () => {
  const { durable, report } = fixture(); report.replay.allOriginalAnswersReady = false;
  const result = auditLiveLineage(report, durable, 2);
  assert.equal(result.runtimePass, false); assert.ok(result.issues.includes('END_JOURNAL_COUNT:2'));
});

test('redacted diagnostic differences are distinct from durable score changes', () => {
  const { durable, report } = fixture();
  (durable.evaluation as any).diagnostics = { inputTokens: { mean: 3 }, semanticKey: 'fixture-noncredential-hash' };
  report.finalSession.evaluation = maskConversationSecrets(durable.evaluation) as typeof report.finalSession.evaluation;
  const redacted = auditLiveLineage(report, durable, 1);
  assert.equal(redacted.recordedEvaluationMatchesDurable, false);
  assert.equal(redacted.recordedEvaluationMatchesAfterStandardRedaction, true);
  assert.equal(redacted.integrityPass, true);
  (durable.evaluation as any).clusterScores[0].members[0].score = 80;
  const changed = auditLiveLineage(report, durable, 1);
  assert.equal(changed.integrityPass, false);
  assert.ok(changed.issues.includes('DURABLE_EVALUATION_ESSENTIAL_FIELDS_MISMATCH'));
});
