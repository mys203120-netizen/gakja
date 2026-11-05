import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalSessionStore } from '../server/storage/local-session-store';
import type { InterviewSession } from '../server/protocol';

test('temporary Windows replace locks retry the exact snapshot before queued session writes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-store-lock-'));
  try {
    let attempts = 0;
    const seen: string[] = [], waits: number[] = [];
    const store = new LocalSessionStore(directory, { replaceFile: async (from, to) => {
      const snapshot = JSON.parse(await readFile(from, 'utf8'));
      seen.push(snapshot.metrics.marker);
      if (++attempts <= 2) throw Object.assign(new Error('synthetic Windows reader lock'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
      await rename(from, to);
    }, wait: async milliseconds => { waits.push(milliseconds); } });
    const first = { id: randomUUID(), metrics: { marker: 'accepted-end' } } as unknown as InterviewSession;
    const saving = store.save(first);
    first.metrics = { marker: 'later-checkpoint' };
    const queued = store.save(first);
    await Promise.all([saving, queued]);
    assert.deepEqual(seen, ['accepted-end', 'accepted-end', 'accepted-end', 'later-checkpoint']);
    assert.deepEqual(waits, [10, 25]);
    assert.equal(JSON.parse(await readFile(path.join(directory, `${first.id}.json`), 'utf8')).metrics.marker, 'later-checkpoint');
  } finally { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('session-store-lock-')); await rm(directory, { recursive: true, force: true }); }
});

test('permanent storage errors reject without retrying or overwriting the last accepted snapshot', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-store-lock-'));
  try {
    const value = { id: randomUUID(), metrics: { marker: 'preserved' } } as unknown as InterviewSession;
    await new LocalSessionStore(directory).save(value);
    const before = await readFile(path.join(directory, `${value.id}.json`));
    let attempts = 0, waits = 0;
    const store = new LocalSessionStore(directory, { replaceFile: async () => { attempts++; throw Object.assign(new Error('synthetic disk failure'), { code: 'EIO' }); }, wait: async () => { waits++; } });
    await assert.rejects(store.save({ ...value, metrics: { marker: 'not-accepted' } }), /synthetic disk failure/u);
    assert.equal(attempts, 1); assert.equal(waits, 0);
    assert.deepEqual(await readFile(path.join(directory, `${value.id}.json`)), before);
  } finally { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('session-store-lock-')); await rm(directory, { recursive: true, force: true }); }
});
