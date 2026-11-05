import test from "node:test";
import assert from "node:assert/strict";
import { summarizeSessionLatency } from "../server/session-latency";
import type { InterviewSession } from "../server/protocol";

test("latency preserves separate acknowledged and actual question starts on the browser clock", () => {
  const session = { turns: [{ metadata: { providerTimings: { llmMs: 1200, sttFinalizeMs: 90 }, clientTimings: { submittedAt: 100, finalizedAt: 200, acknowledgementStarted: 1600, questionStarted: 2500 } } }] } as unknown as InterviewSession;
  const summary = summarizeSessionLatency(session);
  assert.deepEqual(summary.measured.submitToAcknowledgementMs, { samples: 1, p50Ms: 1500, p95Ms: 1500 });
  assert.deepEqual(summary.measured.submitToQuestionMs, { samples: 1, p50Ms: 2400, p95Ms: 2400 });
  assert.deepEqual(summary.measured.submitToFirstPlaybackMs, { samples: 1, p50Ms: 1500, p95Ms: 1500 });
  assert.equal(summary.measured.llmMs.p50Ms, 1200);
  assert.equal(summary.measured.submitToFinalTranscriptMs.p50Ms, 100);
});

test('actual first playback accepts question-only starts and keeps timeouts/cancellations visible beside observed percentiles', () => {
  const session = { turns: [{ metadata: { clientTimings: { submittedAt: 100, questionStarted: 600 } } }, { metadata: { clientTimings: { submittedAt: 900 } } }],
    runtime: { submissionAttempts: { a: { status: 'completed' }, b: { status: 'expired' }, c: { status: 'cancelled' } } } } as unknown as InterviewSession;
  const summary = summarizeSessionLatency(session);
  assert.deepEqual(summary.measured.submitToFirstPlaybackMs, { samples: 1, p50Ms: 500, p95Ms: 500 });
  assert.deepEqual(summary.waitingOutcomes, { recordedAttempts: 3, expiredAttempts: 1, cancelledAttempts: 1, completedAttempts: 1, runningAttempts: 0 });
});
test("missing or reversed timing observations stay unavailable instead of becoming zero latency", () => {
  const session = { turns: [{ metadata: { clientTimings: { submittedAt: 900, questionStarted: 500 } } }, { metadata: {} }] } as unknown as InterviewSession;
  const summary = summarizeSessionLatency(session);
  assert.deepEqual(summary.measured.submitToQuestionMs, { samples: 0, p50Ms: null, p95Ms: null });
  assert.equal(summary.measured.llmMs.samples, 0);
});

test("a cached first-question preparation is separate from between-turn provider latency while its actual STT remains measured", () => {
  const session = { turns: [{ metadata: { providerTimings: { preparedCacheHit: 1, llmMs: 9000, sttFinalizeMs: 300 } } }, { metadata: { providerTimings: { llmMs: 1200 } } }] } as unknown as InterviewSession;
  const summary = summarizeSessionLatency(session);
  assert.deepEqual(summary.measured.llmMs, { samples: 1, p50Ms: 1200, p95Ms: 1200 });
  assert.deepEqual(summary.warmup.llmMs, { samples: 1, p50Ms: 9000, p95Ms: 9000 });
  assert.equal(summary.measured.sttFinalizeMs.p50Ms, 300);
});

test("actual acknowledgement-to-question gaps use one browser clock and old playback backup without double counting", () => {
  const session = { turns: [{ id: "one", metadata: { clientTimings: { acknowledgementEnded: 1000, questionStarted: 1300 } } }, { id: "two", metadata: {} }, { id: "three", metadata: {} }], metrics: { questionPlaybackTimingsByTurn: { two: { acknowledgementEnded: 1000, questionStarted: 1300 }, three: { acknowledgementEnded: 2000, questionStarted: 2400 } } } } as unknown as InterviewSession;
  assert.deepEqual(summarizeSessionLatency(session).measured.acknowledgementEndToQuestionMs, { samples: 2, p50Ms: 300, p95Ms: 400 });
});

test('live core usage sums only answer-bound observations and leaves unavailable costs or old token data null', () => {
  const session = { turns: [
    { id: 'a', answerId: 'aa', metadata: { coreDecision: { sourceTurnId: 'a', sourceAnswerId: 'aa', providerTimings: { coreModelCalls: 1, premiseReviewAttempts: 1, inputTokens: 90, outputTokens: 10, cachedInputTokens: 64 } } } },
    { id: 'b', answerId: 'bb', metadata: { coreDecision: { sourceTurnId: 'wrong', sourceAnswerId: 'bb', providerTimings: { inputTokens: 9000 } } } },
    { id: 'c', answerId: 'cc', metadata: {} },
  ] } as unknown as InterviewSession;
  const report = summarizeSessionLatency(session);
  assert.deepEqual(report.coreUsage.totals.inputTokens, { observedTurns: 1, total: 90 });
  assert.equal(report.coreUsage.totals.coreModelCalls.total, 1);
  assert.equal(report.coreUsage.estimatedMonetaryCost, null);
  assert.equal(summarizeSessionLatency({ turns: [] }).coreUsage.totals.inputTokens.total, null);
});
