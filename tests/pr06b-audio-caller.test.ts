import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

test('public speech caller uses real local storage across shared synthesis, one-subscriber cancellation and process restart', { timeout: 30_000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pr06b-clova-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('pr06b-clova-'));
    await rm(root, { recursive: true, force: true });
  });
  const execute = async (mode: string) => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import', pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href,
      path.resolve('tests/fixtures/pr06b-audio-caller.ts'), `--source-root=${process.cwd()}`, `--mode=${mode}`,
    ], { cwd: root, windowsHide: true, timeout: 12_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  };
  const generated = await execute('generate'), reopened = await execute('reopen');
  assert.equal(generated.fetchCount, 2); assert.equal(generated.primaryCancelled, true);
  assert.equal(generated.sameKeyCache, 'shared'); assert.equal(generated.otherKeyCache, 'provider');
  assert.equal(reopened.fetchCount, 0); assert.equal(reopened.sameKeyCache, 'disk'); assert.equal(reopened.otherKeyCache, 'disk');
  for (const key of ['audioId', 'otherAudioId', 'audioSha256', 'otherAudioSha256']) assert.equal(reopened[key], generated[key]);
  assert.equal(generated.timingBoundsValid, true); assert.equal(reopened.timingBoundsValid, true);
  assert.equal(generated.actualProviderCalls + reopened.actualProviderCalls, 0);
});
