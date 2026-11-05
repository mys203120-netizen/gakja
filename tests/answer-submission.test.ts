import test from "node:test";
import assert from "node:assert/strict";
import { observeAnswerSubmission } from "../server/answer-submission";
import { finalizeCapturedTurnForEnd, isFinalizedAnswer, mayAskClarification, nextPosition, type InterviewSession, type RecordedTurn } from "../server/protocol";

function turn(changes: Partial<RecordedTurn> = {}): RecordedTurn { return { id: "q0", answerId: "answer", parentMainQuestionId: "q0", questionKind: "main", mainIndex: 1, mainCount: 3, followUpIndex: 0, rawTranscript: "", transcriptStatus: "finalized", ...changes } as RecordedTurn; }
function session(): InterviewSession { return { id: "session", createdAt: "", updatedAt: "", status: "active", evaluationStatus: "pending", target: {}, sourceManifest: {}, durationSeconds: 600, mainQuestionTarget: 3, turns: [turn()], followUpCountByMainQuestion: { q0: 0 }, elapsedMs: 0 }; }

test("an actual finalized empty answer is valid while absent transcripts, IDs and technical failures are rejected", () => {
  assert.equal(isFinalizedAnswer(turn()), true);
  assert.equal(isFinalizedAnswer(turn({ rawTranscript: "   " })), true);
  for (const invalid of [turn({ rawTranscript: undefined }), turn({ answerId: undefined }), turn({ answerId: " " }), turn({ transcriptStatus: "streaming" }), turn({ transcriptStatus: "paused" }), turn({ transcriptStatus: "error" })]) assert.equal(isFinalizedAnswer(invalid), false);
});
test("observed silence records real duration and zero VAD without fabricating content or a device error", () => {
  const result = observeAnswerSubmission("", { speech: { durationMs: 5000, speakingMs: 0, firstSpeechMs: null } });
  assert.equal(result.classification, "silence_observed"); assert.equal(result.nonAnswer, true);
  assert.equal(result.durationMs, 5000); assert.equal(result.silenceMs, 5000); assert.equal(result.speechDetected, false);
  assert.equal(result.firstSpeechMs, null); assert.equal(result.rawTranscriptPreserved, true);
});
test("empty STT without VAD or with observed speech is not asserted to be confirmed silence", () => {
  const unknown = observeAnswerSubmission("", { speech: { durationMs: 5000, speakingMs: null, firstSpeechMs: null } });
  assert.equal(unknown.classification, "empty_transcript"); assert.equal(unknown.speechDetected, null); assert.equal(unknown.silenceMs, null);
  const voiced = observeAnswerSubmission("", { speech: { durationMs: 5000, speakingMs: 2000, firstSpeechMs: 1000 } });
  assert.equal(voiced.classification, "empty_transcript"); assert.equal(voiced.speechDetected, true);
  assert.equal(observeAnswerSubmission("없었습니다.", {}).nonAnswer, false);
  assert.equal(observeAnswerSubmission("음", {}).classification, "speech_transcribed");
});

test('disabled empty input never becomes observed student silence and nonempty words before mute remain ordinary', () => {
  const metrics = { speech: { durationMs: 2000, speakingMs: 0, firstSpeechMs: null } };
  const before = structuredClone(metrics);
  const disabled = observeAnswerSubmission('', metrics, { microphoneEnabled: false });
  assert.equal(disabled.classification, 'empty_transcript'); assert.equal(disabled.speechDetected, null);
  assert.equal(disabled.speakingMs, null); assert.equal(disabled.silenceMs, null); assert.equal(disabled.durationMs, 2000);
  assert.equal(observeAnswerSubmission('', metrics, { microphoneEnabled: true }).classification, 'silence_observed');
  assert.equal(observeAnswerSubmission('', metrics).classification, 'silence_observed');
  assert.equal(observeAnswerSubmission('말씀드린 내용입니다.', metrics, { microphoneEnabled: false }).classification, 'speech_transcribed');
  assert.deepEqual(metrics, before);
});
test("one non-evaluative clarification leaves the root F counter unchanged even with no F budget", () => {
  const value = session();
  assert.equal(mayAskClarification(value, 600), true);
  assert.deepEqual(nextPosition(value, "clarification", 3, 0, 600), { kind: "clarification", mainIndex: 1, followUpIndex: 0, parentId: "q0" });
  value.turns.push(turn({ id: "repair", questionKind: "clarification", metadata: { clarificationOfTurnId: "q0", nonEvaluative: true } as RecordedTurn["metadata"] }));
  assert.equal(mayAskClarification(value, 600), false);
  assert.equal(value.followUpCountByMainQuestion.q0, 0);
  assert.deepEqual(nextPosition(value, "follow_up", 3, 2, 600), { kind: "follow_up", mainIndex: 1, followUpIndex: 1, parentId: "q0" });
  assert.equal(nextPosition(value, "clarification", 3, 2, 600)?.mainIndex, 2);
});
test("clarification obeys remaining-time reservations and never restarts a root or a completed deadline", () => {
  const value = session(); value.followUpCountByMainQuestion.q0 = 2;
  assert.deepEqual(nextPosition(value, "clarification", 3, 2, 600), { kind: "clarification", mainIndex: 1, followUpIndex: 2, parentId: "q0" });
  value.elapsedMs = 405000; // remaining: two main reserves and one 45-second repair reserve
  assert.equal(mayAskClarification(value, 600), false);
  assert.equal(nextPosition(value, "clarification", 3, 2, 600)?.kind, "main");
  value.elapsedMs = 600000; assert.equal(nextPosition(value, "clarification", 3, 2, 600), null);
});
test("explicit ending preserves a flushed paused empty observation and does not upgrade a failed stream", () => {
  const value = turn({ transcriptStatus: "paused" }); finalizeCapturedTurnForEnd(value, false);
  assert.equal(value.rawTranscript, ""); assert.equal(isFinalizedAnswer(value), true);
  const failed = turn({ transcriptStatus: "error" }); finalizeCapturedTurnForEnd(failed, true); assert.equal(isFinalizedAnswer(failed), false);
});
