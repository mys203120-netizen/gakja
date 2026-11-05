import test from 'node:test';
import assert from 'node:assert/strict';
import { compareReplayRun } from '../scripts/compare-live-e2e-replay';
import { replayHash } from '../scripts/live-e2e-replay';

function pair() {
  const answers = ['다 같이 했습니다.', '제가 문구를 고쳤습니다.'];
  const before = { sessionId: 'old', turns: answers.map((text, index) => ({ index, scenario: index ? 'specific_role' : 'vague_role',
    question: '역할은 무엇인가요?', questionKind: index ? 'follow_up' : 'main', syntheticStudent: { text },
    capture: { rawTranscript: text, sttFinalizeMs: 100 },
    response: index ? { status: 503, nextMs: 900 } : { status: 200, nextMs: 500, events: [{ type: 'turn_ready', afterSubmitMs: 650 }] },
    coreDecision: { nextAction: index ? 'TRANSITION' : 'FOLLOW_UP' },
  })) };
  const after = { sessionId: 'new', replay: { sourceSessionId: 'old', unusedSourceIndices: [], newStudentGenerationCalls: 0 },
    turns: answers.map((text, index) => ({ index, question: '한 일을 말씀해 주세요.', questionKind: index ? 'clarification' : 'main',
      syntheticStudent: { text }, capture: { rawTranscript: text + ' ', sttFinalizeMs: 90,
        exactReplayInput: { sourceIndex: index, answerSha256: replayHash(text), baselineAnswerSha256: replayHash(text),
          pcmHashEqualToFrozenBaseline: true, pcmBytesEqual: true, pcmSha256: 'known-pcm' } },
      response: { status: 200, nextMs: 200, events: [{ type: 'turn_ready', afterSubmitMs: 300 }] },
      coreDecision: { nextAction: index ? 'TRANSITION' : 'CLARIFICATION' }, next: { question: '다음 질문', kind: 'main' },
    })),
  };
  return { before, after };
}

test('matched replay keeps before failures separate rather than converting them to zero-time successes', () => {
  const { before, after } = pair(), result = compareReplayRun(before, after);
  assert.equal(result.exactAnswerAndReconstructedPcmInputs, 2);
  assert.equal(result.allOriginalAnswersReplayed, true);
  assert.equal(result.failures.beforeBlockedAnswers, 1); assert.equal(result.failures.afterBlockedAnswers, 0);
  assert.equal(result.timings.sameSuccessCohortBeforeSubmitToReadyMs.count, 1);
  assert.equal(result.timings.sameSuccessCohortBeforeSubmitToReadyMs.mean, 650);
  assert.equal(result.timings.previouslyBlockedNowReady.length, 1);
  assert.equal(result.timings.previouslyBlockedNowReady[0].sourceIndex, 1);
  assert.equal(result.rows[1].questionKindChanged, true);
});

test('changed answer text or audio proof cannot enter a same-input comparison', () => {
  const { before, after } = pair();
  after.turns[0].capture.exactReplayInput.answerSha256 = replayHash('다른 답변');
  assert.throws(() => compareReplayRun(before, after), /REPLAY_INPUT_NOT_IDENTICAL/u);
  const valid = pair(); valid.after.turns[0].capture.exactReplayInput.pcmHashEqualToFrozenBaseline = false;
  assert.throws(() => compareReplayRun(valid.before, valid.after), /REPLAY_INPUT_NOT_IDENTICAL/u);
});
