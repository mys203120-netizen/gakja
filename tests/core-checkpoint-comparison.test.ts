import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareCoreCheckpoints } from '../scripts/compare-core-checkpoints';

const report = () => ({ live: true, completedAt: '2026-11-04T00:00:00Z', bankIdentity: 'bank', bankContentSha256: 'content',
  sourceFilesModified: false, originalSessionSaved: false, cases: [{ caseId: 'conversation:0', baselinePath: 'source',
    originalAnswerSha256: 'answer', baselineSha256: 'baseline', observedSessionId: 'session', observedSessionSha256: 'session-sha',
    question: '원질문', questionKind: 'main', rawTranscript: '실제 확정 답변', rawTranscriptSha256: 'transcript-sha',
    prefixTurnCount: 1, currentTurnId: 'turn', currentAnswerId: 'answer-id', originalSessionUnchanged: true,
    checkpointValid: true, options: { allowFollowUp: true }, wallMs: 1200,
    result: { engineVersion: 'test', origin: 'model', nextAction: 'TRANSITION', providerTimings: { realtimeTurnMs: 1000 } },
    providerUsage: [] }] });

test('controlled comparison rejects a transcript change and a changed historical prefix', () => {
  const before = report(), transcript = report(), prefix = report();
  transcript.cases[0].rawTranscript = '다른 답변'; prefix.cases[0].prefixTurnCount = 2;
  assert.throws(() => compareCoreCheckpoints(before, transcript), /CONTROLLED_INPUT_CHANGED_rawTranscript/u);
  assert.throws(() => compareCoreCheckpoints(before, prefix), /CONTROLLED_INPUT_CHANGED_prefixTurnCount/u);
});

test('controlled comparison retains failures outside paired successful latency and unknown costs', () => {
  const before = report(), after = report();
  Object.assign(after.cases[0].result, { origin: 'fallback', failureDetail: 'PROVIDER_TIMEOUT' });
  Object.assign(after.cases[0], { providerUsage: [{ stage: 'core', observation: {
    responseModel: 'unknown-model', serviceTier: 'default', validity: 'missing_usage', usage: null,
  } }] });
  const comparison = compareCoreCheckpoints(before, after);
  assert.equal(comparison.before.runtimeSuccesses, 1);
  assert.equal(comparison.after.runtimeFailures, 1);
  assert.equal(comparison.pairedRuntimeSuccesses, 0);
  assert.equal(comparison.after.byStage.core.unknownCostRequests, 1);
  assert.equal(comparison.pairs[0].after.requests[0].estimatedCost.usd, null);
  assert.equal(comparison.pairs[0].after.failure, 'PROVIDER_TIMEOUT');
});

test('controlled comparison refuses incomplete runs and duplicate cases', () => {
  const before = report(), incomplete = report(), duplicate = report();
  incomplete.completedAt = ''; duplicate.cases.push(structuredClone(duplicate.cases[0]));
  assert.throws(() => compareCoreCheckpoints(before, incomplete), /CONTROLLED_LIVE_REPORT_INCOMPLETE/u);
  before.cases.push(structuredClone(before.cases[0]));
  assert.throws(() => compareCoreCheckpoints(before, duplicate), /CONTROLLED_DUPLICATE_CASE/u);
});

test('controlled comparison refuses production source edits during a run', () => {
  const before = report(), after = { ...report(), engineSourceUnchanged: false };
  assert.throws(() => compareCoreCheckpoints(before, after), /CONTROLLED_ENGINE_CHANGED_DURING_RUN/u);
});

test('successful bounded repair keeps its rejection diagnostic outside terminal failures', () => {
  const before = report(), after = report();
  Object.assign(after.cases[0].result, { execution: { status: 'ready' }, failureDetail: 'PREMISE_UNSUPPORTED' });
  const comparison = compareCoreCheckpoints(before, after);
  assert.equal(comparison.after.runtimeFailures, 0);
  assert.equal(comparison.pairs[0].after.recoveredRejection, 'PREMISE_UNSUPPORTED');
});
