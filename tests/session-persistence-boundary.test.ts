import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { InterviewSession } from '../server/protocol';
import { createSessionRuntime, restoreLogicalSession, saveSessionSnapshot } from '../server/session-runtime';
import { createLocalSessionStore } from '../server/storage/local-session-store';
import { loadInterviewContext } from './fixtures/runtime-context';

test('saving a restored snapshot preserves the recovery deadline and frozen accepted end input', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pr06c-snapshot-'));
  try {
    const context = await loadInterviewContext(), at = '2026-11-06T00:00:00.000Z';
    const original = { id: randomUUID(), createdAt: at, updatedAt: at, status: 'active', evaluationStatus: 'pending', elapsedMs: 1234,
      target: context.target, sourceManifest: context.manifest, runtime: createSessionRuntime(context, { id: 'owner-fixture', mode: 'local-development' }, at),
      turns: [], followUpCountByMainQuestion: {} } as InterviewSession;
    original.runtime!.checkpoint.disconnectedAt = at;
    original.runtime!.acceptedEndRequest = { elapsedMs: 1234, metrics: { accepted: true } };
    original.runtime!.evaluationInputFrozenAt = at;
    const store = createLocalSessionStore(root);
    await store.saveContext(context, 'owner-fixture');
    const restored = restoreLogicalSession(original, 'owner-fixture', Date.parse(at) + 599999);
    const checkpoint = structuredClone(restored.runtime!.checkpoint);
    await saveSessionSnapshot(restored, store, '2026-11-06T00:09:59.999Z');
    const loaded = (await createLocalSessionStore(root).load(original.id, 'owner-fixture'))!;
    assert.deepEqual(loaded.runtime!.checkpoint, checkpoint);
    assert.deepEqual(loaded.runtime!.acceptedEndRequest, original.runtime!.acceptedEndRequest);
    assert.equal(loaded.runtime!.evaluationInputFrozenAt, at);
    assert.equal(loaded.runtime!.contextSnapshotSha256, original.runtime!.contextSnapshotSha256);
    assert.equal(loaded.updatedAt, '2026-11-06T00:09:59.999Z');
    assert.doesNotThrow(() => restoreLogicalSession(loaded, 'owner-fixture', Date.parse(at) + 600000));
    assert.throws(() => restoreLogicalSession(loaded, 'owner-fixture', Date.parse(at) + 600001), /SESSION_RECOVERY_EXPIRED/);
    assert.equal(await readFile(path.join(root, 'data/sessions', `${original.id}.json`), 'utf8'), JSON.stringify(restored, null, 2));
    const error = Object.assign(new Error('owned failure'), { code: 'EIO' });
    const failing = createLocalSessionStore(root, { replaceFile: async () => { throw error; } });
    const bytes = await readFile(path.join(root, 'data/sessions', `${original.id}.json`));
    await assert.rejects(saveSessionSnapshot(restored, failing, '2026-11-06T00:10:00.001Z'), actual => actual === error);
    assert.deepEqual(await readFile(path.join(root, 'data/sessions', `${original.id}.json`)), bytes);
    assert.deepEqual(restored.runtime!.checkpoint, checkpoint);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('pr06c-snapshot-'));
    await rm(root, { recursive: true, force: true });
  }
});
