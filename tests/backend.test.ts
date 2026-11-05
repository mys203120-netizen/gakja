import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { concatenateStreamTranscript, finalizeCapturedTurnForEnd, IdempotentTurnOperations, mergeTranscriptObservation, nextPosition, replaceTranscriptAt, type InterviewSession, type RecordedTurn } from "../server/protocol";
import { calculateAnswerScore, groundedAcknowledgement, scoreProfile } from "../server/providers/openai";

function session(followUpIndex = 0): InterviewSession {
  const root = randomUUID();
  const turn = { id: followUpIndex ? randomUUID() : root, parentMainQuestionId: root, questionKind: followUpIndex ? "follow_up" : "main", mainIndex: 1, followUpIndex } as RecordedTurn;
  return { id: randomUUID(), createdAt: "", updatedAt: "", status: "active", evaluationStatus: "pending", target: {}, sourceManifest: {}, turns: [turn], followUpCountByMainQuestion: { [root]: followUpIndex }, elapsedMs: 0 };
}
test("nested follow-ups keep the Q0 root and cannot exceed cap", () => {
  const value = session(1);
  assert.deepEqual(nextPosition(value, "follow_up", 4, 2, 600), { kind: "follow_up", mainIndex: 1, followUpIndex: 2, parentId: value.turns[0].parentMainQuestionId });
  value.followUpCountByMainQuestion[value.turns[0].parentMainQuestionId] = 2;
  assert.deepEqual(nextPosition(value, "follow_up", 4, 2, 600), { kind: "main", mainIndex: 2, followUpIndex: 0, parentId: null });
  assert.throws(() => nextPosition(value, "follow_up", 4, 4, 600));
});
test("near timeout progresses to main or ends without a follow-up", () => {
  const value = session(); value.elapsedMs = 560_000;
  assert.equal(nextPosition(value, "follow_up", 4, 2, 600)?.kind, "main");
  value.elapsedMs = 600_000;
  assert.equal(nextPosition(value, "follow_up", 4, 2, 600), null);
});
test("last main with exhausted follow-ups ends", () => {
  const value = session(2); value.turns[0].mainIndex = 4;
  assert.equal(nextPosition(value, "follow_up", 4, 2, 600), null);
});
test("CLOVA position revisions replace text without duplicate fillers", () => {
  const first = replaceTranscriptAt("", "어 실험", 0);
  assert.equal(replaceTranscriptAt(first, "어 실험을 했습니다.", 0), "어 실험을 했습니다.");
  assert.equal(replaceTranscriptAt(first, "을 했습니다.", 4), "어 실험을 했습니다.");
  assert.throws(() => replaceTranscriptAt(first, "오류", 900));
});
test("resume keeps real repeated words, does not append the same revision", () => {
  assert.equal(concatenateStreamTranscript("어 음", "음 다시 말씀드리면"), "어 음 음 다시 말씀드리면");
  assert.equal(concatenateStreamTranscript("", "어 음"), "어 음");
});
test("document-defined scoring weights and caps are computed in code", () => {
  assert.equal(scoreProfile("CONCEPT"), "KNOWLEDGE");
  assert.equal(scoreProfile("CLARIFY_CONTENT"), null);
  assert.equal(calculateAnswerScore("EXPERIENCE", { I: 4, A: 4, S: 4, R: 4, C: 4 }, false).score, 100);
  assert.equal(calculateAnswerScore("EXPERIENCE", { I: 0, A: 4, S: 4, R: 4, C: 4 }, false).score, 39);
  assert.equal(calculateAnswerScore("KNOWLEDGE", { I: 4, A: 4, S: 4, R: 4, C: 4 }, true).score, 59);
  assert.equal(calculateAnswerScore("EXPERIENCE", { I: 3, A: 3, S: 3, R: 3, C: 3 }, false).score, 75);
});
test("simultaneous button and Space share one question/TTS generation", async () => {
  const operations = new IdempotentTurnOperations<{ id: number }>();
  let calls = 0;
  const generate = async () => { calls += 1; return { id: calls }; };
  const [a, b] = await Promise.all([operations.run("session:turn:answer", generate), operations.run("session:turn:answer", generate)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(await operations.run("session:turn:answer", generate), a);
  assert.equal(calls, 1);
});
test("provider errors preserve retry capability without caching failures", async () => {
  const operations = new IdempotentTurnOperations<string>();
  await assert.rejects(operations.run("turn", async () => { throw new Error("provider failed"); }));
  assert.equal(await operations.run("turn", async () => "real provider result"), "real provider result");
});
test("acknowledgement preserves a grounded short model sentence and omits unsupported fillers", () => {
  assert.equal(groundedAcknowledgement("어, 흡광도를 측정했습니다.", "흡광도", "‘흡광도’를 언급하셨군요."), "‘흡광도’를 언급하셨군요.");
  assert.equal(groundedAcknowledgement("역할을 분담했습니다.", "수상", "‘수상’을 언급하셨군요."), null);
  assert.equal(groundedAcknowledgement("좋은 답변이라고 했습니다.", "좋은 답변", "‘좋은 답변’을 언급하셨군요."), null);
  assert.equal(groundedAcknowledgement("어", null), null);
});
test("explicit ending finalizes flushed paused capture and preserves its real transcript", () => {
  const turn = session().turns[0];
  turn.answerId = randomUUID(); turn.rawTranscript = "어, 역할을 나누었습니다."; turn.transcriptStatus = "paused";
  finalizeCapturedTurnForEnd(turn, false);
  assert.equal(turn.transcriptStatus, "finalized");
  assert.equal(turn.rawTranscript, "어, 역할을 나누었습니다.");
});
test("ending cannot mark a pending or errored capture as finalized", () => {
  const turn = session().turns[0]; turn.answerId = randomUUID(); turn.transcriptStatus = "streaming";
  finalizeCapturedTurnForEnd(turn, false);
  assert.equal(turn.transcriptStatus, "streaming");
  finalizeCapturedTurnForEnd(turn, true);
  assert.equal(turn.transcriptStatus, "finalized");
  turn.transcriptStatus = "error";
  finalizeCapturedTurnForEnd(turn, true);
  assert.equal(turn.transcriptStatus, "error");
});
test("STT observations replace position revisions and keep missing provider values null", () => {
  const first = { segmentId: "stream-1:0", revision: 1, confidence: 0.91, startTimestamp: 190, endTimestamp: 840 };
  let observations = mergeTranscriptObservation([], first);
  observations = mergeTranscriptObservation(observations, { ...first, revision: 2, confidence: 0.95, endTimestamp: 1000 });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].confidence, 0.95);
  observations = mergeTranscriptObservation(observations, first);
  assert.equal(observations[0].revision, 2);
  observations = mergeTranscriptObservation(observations, { segmentId: "stream-2:0", revision: 1, confidence: null, startTimestamp: null, endTimestamp: null });
  assert.equal(observations.length, 2);
  assert.equal(observations[1].confidence, null);
  assert.equal(observations[1].startTimestamp, null);
});
