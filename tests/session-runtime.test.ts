import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession } from '../server/protocol';
import { createSessionRuntime, restoreLogicalSession, SESSION_RECOVERY_WINDOW_MS, snapshotHash } from '../server/session-runtime';
import { LocalSessionStore } from '../server/storage/local-session-store';

const context = { manifest: { rulesVersion: 'synthetic-engine-v3', sourceIntegrity: { pdfHashVerified: true } }, target: { department: '합성학과' }, student: { studentId: 'student-fixture', evidence: [] }, questionGuidelines: '합성 정본', evaluationGuidelines: '합성 평가 정본', errors: [] } as unknown as InterviewContext;
function fixture(now: number): InterviewSession {
  return { id: randomUUID(), createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), status: 'active', evaluationStatus: 'pending', elapsedMs: 1234, target: context.target, sourceManifest: context.manifest, runtime: createSessionRuntime(context, { id: 'owner-a', mode: 'local-development' }, new Date(now).toISOString()), turns: [{ id: 'q1', answerId: 'a1', rawTranscript: '저장된 미확정 원문', transcriptStatus: 'streaming', questionKind: 'main', parentMainQuestionId: 'q1', metadata: {} }], followUpCountByMainQuestion: {} } as InterviewSession;
}
test('restart restoration preserves partial words and confirmed answers without fabricating audio or delivery', () => {
  const now = Date.now(), original = fixture(now);
  original.runtime!.operations.next = { status: 'committed', startedAt: new Date(now).toISOString(), epoch: 0, result: { turn: null, done: true } };
  const restored = restoreLogicalSession(original, 'owner-a', now + 1000);
  assert.equal(original.turns[0].transcriptStatus, 'streaming');
  assert.equal(restored.turns[0].transcriptStatus, 'paused'); assert.equal(restored.turns[0].rawTranscript, '저장된 미확정 원문');
  assert.equal(restored.runtime!.epoch, 1); assert.equal(restored.runtime!.checkpoint.deliveryUncertain, true);
  assert.deepEqual(restored.runtime!.operations.next.result, { turn: null, done: true });
  original.turns[0].transcriptStatus = 'finalized';
  assert.equal(restoreLogicalSession(original, 'owner-a', now + 1000).turns[0].transcriptStatus, 'finalized');
});
test('ongoing recovery checks server owner and the ten minute wall-clock window', () => {
  const now = Date.now(), original = fixture(now);
  assert.throws(() => restoreLogicalSession(original, 'owner-b', now), /SESSION_OWNER_MISMATCH/);
  assert.doesNotThrow(() => restoreLogicalSession(original, 'owner-a', now + SESSION_RECOVERY_WINDOW_MS));
  assert.throws(() => restoreLogicalSession(original, 'owner-a', now + SESSION_RECOVERY_WINDOW_MS + 1), /SESSION_RECOVERY_EXPIRED/);
  original.status = 'completed';
  assert.doesNotThrow(() => restoreLogicalSession(original, 'owner-a', now + SESSION_RECOVERY_WINDOW_MS * 10));
});
test('local store actually reads owner-bound session/context snapshots and detects tampering', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'interview-runtime-'));
  try {
    const store = new LocalSessionStore(path.join(directory, 'sessions')), original = fixture(Date.now());
    const digest = await store.saveContext(context, 'owner-a'); assert.equal(digest, snapshotHash(context));
    await store.save(original);
    const reopened = new LocalSessionStore(path.join(directory, 'sessions'));
    assert.deepEqual(await reopened.load(original.id, 'owner-a'), original);
    await assert.rejects(reopened.load(original.id, 'owner-b'), /SESSION_OWNER_MISMATCH/);
    assert.deepEqual(await reopened.loadContext(digest, 'owner-a'), context);
    await assert.rejects(reopened.loadContext(digest, 'owner-b'));
    const contextFile = path.join(directory, 'session-contexts', `${snapshotHash('owner-a')}-${digest}.json`);
    const envelope = JSON.parse(await readFile(contextFile, 'utf8')); envelope.context.questionGuidelines = '변조'; await writeFile(contextFile, JSON.stringify(envelope));
    await assert.rejects(reopened.loadContext(digest, 'owner-a'), /CONTEXT_SNAPSHOT_INVALID/);
    assert.equal((await reopened.load(original.id, 'owner-a'))!.turns[0].rawTranscript, '저장된 미확정 원문');
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('interview-runtime-'));
    await rm(directory, { recursive: true, force: true });
  }
});
