import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalSessionStore, LocalSessionStore } from '../server/storage/local-session-store';
import type { SessionStore } from '../server/storage/session-store';
import type { InterviewSession } from '../server/protocol';
import { createSessionRuntime, localDevelopmentOwner, snapshotHash } from '../server/session-runtime';
import { prepareEvaluationScopesCli } from '../scripts/prepare-evaluation-scopes';
import { loadInterviewContext } from './fixtures/runtime-context';

async function workspace(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-store-contract-'));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('session-store-contract-')); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function fixture() {
  const context = await loadInterviewContext(), owner = localDevelopmentOwner(), now = '2026-11-06T00:00:00.000Z';
  const session: InterviewSession = { id: '11111111-1111-4111-8111-111111111111', createdAt: now, updatedAt: now, status: 'ending', evaluationStatus: 'pending',
    target: context.target, sourceManifest: context.manifest, elapsedMs: 123, turns: [], followUpCountByMainQuestion: {},
    metrics: { explicitNull: null, literal: '🙂 원문 순서 보존', omitted: undefined }, runtime: createSessionRuntime(context, owner, now) };
  session.runtime!.evaluationInputFrozenAt = now;
  session.runtime!.acceptedEndRequest = { elapsedMs: session.elapsedMs, metrics: { accepted: true } };
  return { context, session, owner };
}

test('expanded existing SessionStore and local factory preserve exact files, constructor compatibility and owner-bound reads', async t => {
  const root = await workspace(t), value = await fixture(), store: SessionStore = createLocalSessionStore(root);
  const contextHash = await store.saveContext(value.context, value.owner.id);
  await store.save(value.session);
  const sessionFile = path.join(root, 'data/sessions', `${value.session.id}.json`);
  assert.deepEqual(await readFile(sessionFile), Buffer.from(JSON.stringify(value.session, null, 2)));
  assert.deepEqual(await readFile(path.join(root, 'data/session-contexts', `${snapshotHash(value.owner.id)}-${contextHash}.json`)),
    Buffer.from(JSON.stringify({ version: 1, ownerId: value.owner.id, contentSha256: contextHash, context: value.context })));
  const reopened = new LocalSessionStore(path.join(root, 'data/sessions'));
  assert.equal(JSON.stringify(await reopened.load(value.session.id, value.owner.id)), JSON.stringify(value.session));
  assert.equal(JSON.stringify(await reopened.loadContext(contextHash, value.owner.id)), JSON.stringify(value.context));
  assert.equal(await reopened.load('22222222-2222-4222-8222-222222222222', value.owner.id), null);
  await assert.rejects(reopened.load(value.session.id, 'another-owner'), /SESSION_OWNER_MISMATCH/u);
  await writeFile(path.join(root, 'data/sessions', '33333333-3333-4333-8333-333333333333.json'), 'explicit damaged synthetic JSON');
  await writeFile(`${sessionFile}.tmp`, 'explicit incomplete temporary snapshot');
  assert.deepEqual((await reopened.list(value.owner.id)).map(session => session.id), [value.session.id]);
});

test('local queue retains captured snapshots and exactly seven Windows attempts before a queued retry can recover', async t => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) await t.test(code, async child => {
    const root = await workspace(child), value = await fixture(), waits: number[] = [], snapshots: string[] = [];
    let attempts = 0;
    const store = createLocalSessionStore(root, { replaceFile: async (from, to) => {
      snapshots.push(JSON.parse(await readFile(from, 'utf8')).metrics.marker);
      if (++attempts <= 7) throw Object.assign(new Error('EXPLICIT_SYNTHETIC_WINDOWS_REPLACE_DENIED'), { code });
      return rename(from, to);
    }, wait: async milliseconds => { waits.push(milliseconds); } });
    value.session.metrics = { marker: 'first-frozen-input' };
    const first = store.save(value.session); value.session.metrics = { marker: 'queued-recovery' };
    const second = store.save(value.session);
    await assert.rejects(first, /EXPLICIT_SYNTHETIC_WINDOWS_REPLACE_DENIED/u); await second;
    assert.equal(attempts, 8);
    assert.deepEqual(waits, [10, 25, 50, 100, 150, 200]);
    assert.deepEqual(snapshots, [...Array(7).fill('first-frozen-input'), 'queued-recovery']);
    assert.equal(((await store.load(value.session.id, value.owner.id))!.metrics as Record<string, unknown>).marker, 'queued-recovery');
  });
  const root = await workspace(t), value = await fixture();
  const initial = createLocalSessionStore(root); await initial.save(value.session);
  const file = path.join(root, 'data/sessions', `${value.session.id}.json`), before = await readFile(file);
  const failure = Object.assign(new Error('EXPLICIT_SYNTHETIC_PERMANENT_REPLACE_FAILURE'), { code: 'EIO' });
  const failed = createLocalSessionStore(root, { replaceFile: async () => { throw failure; }, wait: async () => { assert.fail('EIO must not retry'); } });
  await assert.rejects(failed.save({ ...value.session, metrics: { marker: 'unpublished' } }), error => error === failure);
  assert.deepEqual(await readFile(file), before);
  assert.equal(JSON.parse(await readFile(`${file}.tmp`, 'utf8')).metrics.marker, 'unpublished', 'existing failed writer leaves its temporary snapshot; extraction does not invent cleanup');
});

test('ended-session coverage uses an injected structural SessionStore and keeps stored session/context bytes unchanged', async t => {
  const root = await workspace(t), value = await fixture(), local = createLocalSessionStore(root), calls: string[] = [];
  await local.saveContext(value.context, value.owner.id); await local.save(value.session);
  const before = await readFile(path.join(root, 'data/sessions', `${value.session.id}.json`));
  const port: SessionStore = {
    save: session => { calls.push('save'); return local.save(session); },
    load: (id, ownerId) => { calls.push('load'); return local.load(id, ownerId); },
    list: ownerId => { calls.push('list'); return local.list(ownerId); },
    saveContext: (context, ownerId) => { calls.push('saveContext'); return local.saveContext(context, ownerId); },
    loadContext: (hash, ownerId) => { calls.push('loadContext'); return local.loadContext(hash, ownerId); },
  };
  const result = await prepareEvaluationScopesCli(['coverage', '--session-id', value.session.id], root, { sessions: port });
  assert.equal(result.providerCalls, 0); assert.equal(result.snapshotScope, 'original_ended_session');
  assert.deepEqual(calls, ['load', 'loadContext']);
  assert.deepEqual(await readFile(path.join(root, 'data/sessions', `${value.session.id}.json`)), before);
});
