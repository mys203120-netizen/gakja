import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nextReplayAnswer, rootQuestionForBaseline, createReplayCheckpoint, assertReplayBank, replayHash, maySupplementReplayRoot, type ReplayBaseline } from '../scripts/live-e2e-replay';
import { syntheticGoldCheckpoint } from '../scripts/evaluate-historical-dialogue-gold';
import { dialogueActionHistoricalGoldCases } from './fixtures/dialogue-action-historical-gold';
import { LocalSessionStore } from '../server/storage/local-session-store';
import type { PreparedQuestionBank } from '../server/data/prepared-question-bank';
import { assertQuestionContractIntegrity } from '../server/question-objective';
import { coreCheckpoint } from '../scripts/replay-interview-core-checkpoints';
import type { InterviewSession } from '../server/protocol';

const fixture = () => ({ bankKey: 'same', bankContentSha256: 'content', turns: [
  { index: 0, clusterId: 'q0', question: '원래 역할 질문', syntheticStudent: { text: '다 같이 했습니다.' }, capture: { rawTranscript: '다 같이 했습니다. ' } },
  { index: 1, clusterId: 'q0', question: '역할 F', syntheticStudent: { text: '문구를 고쳤습니다.' }, capture: { rawTranscript: '문구를 고쳤습니다. ' } },
  { index: 2, clusterId: 'q1', question: '비교 질문', syntheticStudent: { text: '기억나지 않습니다.' }, capture: { rawTranscript: '기억나지 않습니다. ' } },
], finalSession: { turns: [ { id: 'q0', questionKind: 'main', questionText: '역할은 무엇인가요?' },
  { id: 'q1', questionKind: 'main', questionText: '비교 근거가 무엇인가요?' } ] } } as unknown as ReplayBaseline);

test('replay preserves stored answer order within an approved root even when F becomes a rephrase', () => {
  const baseline = fixture(), consumed = new Set<number>();
  const first = nextReplayAnswer(baseline, '역할은 무엇인가요?', consumed)!;
  assert.equal(first.syntheticStudent.text, '다 같이 했습니다.'); consumed.add(first.index);
  const second = nextReplayAnswer(baseline, '역할은 무엇인가요?', consumed)!;
  assert.equal(second.syntheticStudent.text, '문구를 고쳤습니다.'); consumed.add(second.index);
  assert.equal(nextReplayAnswer(baseline, '역할은 무엇인가요?', consumed), undefined);
  assert.equal(maySupplementReplayRoot(baseline, '역할은 무엇인가요?', consumed), true);
  assert.equal(maySupplementReplayRoot(baseline, '새 질문입니다.', consumed), false);
  assert.equal(nextReplayAnswer(baseline, '새 질문입니다.', consumed), undefined);
  assert.equal(nextReplayAnswer(baseline, '비교 근거가 무엇인가요?', consumed)?.index, 2);
  assert.equal(rootQuestionForBaseline(baseline, baseline.turns[1]), '역할은 무엇인가요?');
  assert.equal(replayHash(second.syntheticStudent.text), replayHash('문구를 고쳤습니다.'));
});

test('replay rejects changed bank identities and missing answer material', () => {
  const baseline = fixture();
  assert.throws(() => assertReplayBank(baseline, { key: 'other', contentSha256: 'content' } as any), /REPLAY_BANK_CHANGED/u);
  assert.throws(() => assertReplayBank({ ...baseline, turns: [{ syntheticStudent: { text: '답변' } }] } as any,
    { key: 'same', contentSha256: 'content' } as any), /REPLAY_BASELINE_INCOMPLETE|REPLAY_ANSWER_MISSING/u);
});

test('restoration checkpoint contains the verified bank Q0 and no old answers, metrics or decisions', async () => {
  const artifact = JSON.parse(await readFile('artifacts/live-interview-e2e-20261103T125455Z-coverage.json', 'utf8')) as ReplayBaseline;
  const original = JSON.parse(await readFile(`data/sessions/${artifact.sessionId}.json`, 'utf8')) as InterviewSession;
  assert.ok(original.runtime);
  const context = await new LocalSessionStore().loadContext(original.runtime.contextSnapshotSha256, original.runtime.owner.id);
  assert.deepEqual(context.errors, []);
  const contextBefore = JSON.stringify(context);
  const pinnedBankKey = original.plan?.poolKey; assert.match(pinnedBankKey ?? '', /^[a-f0-9]{64}$/u);
  const bankFile = `data/prepared/question-banks/${pinnedBankKey}.json`, bankBytes = await readFile(bankFile);
  const bank = JSON.parse(bankBytes.toString('utf8')) as PreparedQuestionBank;
  const approvedCandidates = bank.slots.filter(slot => !slot.quarantine).flatMap(slot => slot.candidates);
  assert.ok(approvedCandidates.length > 0);
  assertReplayBank(artifact, bank, original);
  const before = JSON.stringify(original), owner = 'synthetic-replay-checkpoint-unit';
  const session = createReplayCheckpoint(context, bank, original, owner);
  assert.notEqual(session.id, original.id); assert.equal(session.runtime?.owner.id, owner);
  assert.equal(session.runtime?.runtimePolicy?.mode, 'compiled'); assert.equal(session.turns.length, 1);
  assert.equal(session.plan?.slots.length, approvedCandidates.length, 'Checkpoint retains the exact approved pool pinned by the historical source');
  assert.equal(session.turns[0].questionText, original.turns[0].questionText);
  assert.equal(session.turns[0].answerId, undefined); assert.equal(session.turns[0].rawTranscript, undefined);
  assert.equal(session.turns[0].metrics, undefined); assert.equal(session.turns[0].metadata.coreDecision, undefined);
  assert.equal(session.providerUsageLedger, undefined);
  assert.notEqual(session.turns[0].id, original.turns[0].id);
  assert.equal(session.turns[0].parentMainQuestionId, session.turns[0].id);
  assert.equal(session.turns[0].metadata.questionClusterId, session.turns[0].id);
  assert.equal((session.metrics as any).verification.syntheticTest, true);
  const turn = session.turns[0];
  assert.doesNotThrow(() => assertQuestionContractIntegrity({ ...turn.metadata, acknowledgement: null,
    questionText: turn.questionText, questionKind: 'main', parentMainQuestionId: null, evidenceIds: turn.evidenceIds }, turn.metadata.approvedQuestion!));
  assert.equal(JSON.stringify(original), before, 'Original historical session must remain immutable');
  const controlledA = coreCheckpoint(context, original, artifact.turns[0]);
  const controlledB = coreCheckpoint(context, original, artifact.turns[0]);
  assert.equal(controlledA.id, controlledB.id, 'Same source checkpoint must keep the retrieval seed');
  assert.notEqual(controlledA.id, original.id);
  assert.notEqual(controlledA.id, coreCheckpoint(context, original, artifact.turns[1]).id);
  assert.equal(controlledA.turns.length, 1);
  assert.equal(controlledA.turns[0].metadata.coreDecision, undefined);
  assert.equal(JSON.stringify(original), before, 'Controlled checkpoint creation must not mutate its source');
  const gold = dialogueActionHistoricalGoldCases.find(item => item.id === 'DHG-02')!;
  const synthetic = syntheticGoldCheckpoint(context, original, artifact.turns[4], gold, gold.variants[0]).session;
  const answer = synthetic.turns.at(-1)!;
  assert.equal(answer.questionText, artifact.turns[4].question);
  assert.equal(answer.rawTranscript, gold.variants[0].answer);
  assert.notEqual(answer.answerId, original.turns.find(turn => turn.id === answer.id)?.answerId);
  assert.equal(answer.answerObservation, undefined, 'Synthetic text must not borrow observed STT timing');
  assert.equal(answer.sttObservations, undefined);
  assert.equal(answer.metadata.coreDecision, undefined);
  assert.deepEqual(synthetic.turns.slice(0, -1), original.turns.slice(0, synthetic.turns.length - 1));
  assert.equal(JSON.stringify(original), before, 'Gold current-answer substitution never mutates source');
  assert.deepEqual(await readFile(bankFile), bankBytes, 'Checkpoint creation must preserve the complete pinned bank bytes');
  assert.equal(JSON.stringify(context), contextBefore, 'Replay must preserve the source session’s hash-verified context snapshot');
});
