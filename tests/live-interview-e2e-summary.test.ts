import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLiveInterviewE2e, transcriptDifference } from '../scripts/summarize-live-interview-e2e';

test('live summary attributes answer processing and question synthesis to their actual stages', () => {
  const report = summarizeLiveInterviewE2e([{ sourceFile: 'synthetic.json', sourceSha256: 'synthetic', data: {
    completedAt: '2026-11-03T00:00:00.000Z', sessionId: 's1', turns: [{ index: 0, turnId: 'q0', clusterId: 'q0', question: '어떤 기준인가요?', questionKind: 'main',
      syntheticStudent: { text: '기준이 있습니다.' }, capture: { rawTranscript: '기준이 있습니다. ', sttFinalizeMs: 100, pcmBytes: 32000 },
      response: { status: 200, nextMs: 300, submitToNextReadyMs: 405, events: [{ type: 'turn_ready', afterSubmitMs: 400 }] },
      coreDecision: { nextAction: 'TRANSITION', providerTimings: { coreMs: 210, premiseReviewMs: 0, realtimeTurnMs: 210 } },
      // This timing belongs to the question just answered, not this answer's core.
      providerTimings: { coreMs: 9999 },
    }], finalSession: { turns: [{ id: 'q0', questionText: '어떤 기준인가요?', metadata: { providerTimings: { questionTtsMs: 0, questionTtsCacheHit: 1 } } },
      { id: 'q1', questionText: '다음 질문입니다.', metadata: { providerTimings: { questionTtsMs: 50, questionTtsCacheHit: 0 } } }],
    } } }]);
  const run = report.runs[0];
  assert.equal(run.latencyMs.core.mean, 210);
  assert.equal(run.latencyMs.submitToTurnReadyEvent.mean, 400);
  assert.equal(run.interviewerAudio.newQuestionTtsMs.mean, 50);
  assert.equal(run.transcription.normalizedDifferenceTurns, 0);
  assert.equal(run.costs.productionLlmLedgerSummary, null);
  assert.equal(run.ending.evaluationStatus, null);
});

test('requested replay remains visible without being labelled an unrequested duplicate', () => {
  const question = '과정이 무엇인가요?';
  const report = summarizeLiveInterviewE2e([{ sourceFile: 'synthetic.json', sourceSha256: 'synthetic', data: { sessionId: 's1', turns: [
    { index: 0, turnId: 'q0', clusterId: 'q0', question, coreDecision: { interpretation: { dialogueRequests: ['repeat_audio'] } } },
    { index: 1, turnId: 'q0', clusterId: 'q0', question },
    { index: 2, turnId: 'q2', clusterId: 'q2', question },
  ], naturalEnding: { reason: 'candidate_exhausted', remainingMs: 123000 } } }]);
  const run = report.runs[0];
  assert.equal(run.observations.exactQuestionDuplicates.length, 2);
  assert.equal(run.observations.unrequestedExactRepeatSuspects.length, 1);
  assert.equal(run.ending.earlyCandidateExhaustionObserved, true);
  assert.equal(report.aggregate.allSourcesCompleted, false);
  assert.equal(run.latencyMs.sttFinalize.mean, null);
  assert.throws(() => summarizeLiveInterviewE2e([
    { sourceFile: 'a', sourceSha256: 'a', data: { sessionId: 'same' } },
    { sourceFile: 'b', sourceSha256: 'b', data: { sessionId: 'same' } },
  ]), /DUPLICATE_SESSION_INPUT/u);
});

test('transcript differences flag acronym changes without rewriting either original', () => {
  const difference = transcriptDifference('CNT를 비교했습니다.', '시엔T를 비교했습니다. ');
  assert.equal(difference.punctuationWhitespaceCaseNormalizedEqual, false);
  assert.equal(difference.intended, 'CNT를 비교했습니다.');
  assert.equal(difference.transcript, '시엔T를 비교했습니다. ');
  assert.ok(difference.normalizedCharacterEdits! > 0);
  assert.equal(transcriptDifference('', '').normalizedCharacterErrorRatio, null);
});

test('successful retry does not hide the failed attempt or its processing latency', () => {
  const summary = summarizeLiveInterviewE2e([{ sourceFile: 'retry.json', sourceSha256: 'synthetic', data: { sessionId: 'retry-session', turns: [{
    index: 0, turnId: 'q0', question: '어떤 기준인가요?', capture: { rawTranscript: '기준입니다.', sttFinalizeMs: 100 },
    firstFailedResponse: { status: 503, nextMs: 200 }, firstFailedDecision: { providerTimings: { coreMs: 150, realtimeTurnMs: 150 } },
    explicitRetryCount: 1, response: { status: 200, nextMs: 300, events: [{ type: 'turn_ready', afterSubmitMs: 600 }] },
    coreDecision: { providerTimings: { coreMs: 250, realtimeTurnMs: 250 } },
  }] } }]);
  const run = summary.runs[0];
  assert.equal(run.observations.httpAttempts, 2);
  assert.equal(run.observations.httpFailures.length, 1);
  assert.equal(run.observations.explicitRetries, 1);
  assert.equal(run.latencyMs.nextRequestToResponseCompleteAllAttempts.mean, 250);
  assert.equal(run.latencyMs.core.mean, 200);
  assert.equal(run.latencyMs.submitToTurnReadyEvent.mean, 600);
});
