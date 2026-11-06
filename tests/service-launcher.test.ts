import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

test('the retained service launcher fails closed after auth rollback and never imports the legacy engine', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pr07a-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts')); await mkdir(path.join(root, 'server'));
  await copyFile('scripts/run-service-realtime.mjs', path.join(root, 'scripts/run-service-realtime.mjs'));
  const touched = path.join(root, 'private-access-marker');
  await writeFile(path.join(root, 'server/realtime.ts'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(touched)}, 'private-access');`);
  for (const mode of ['', 'service', 'local-development']) {
    const run = spawnSync(process.execPath, ['scripts/run-service-realtime.mjs'], {
      cwd: root, env: { ...process.env, NODE_ENV: 'production', INTERVIEW_EXECUTION_MODE: mode }, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    assert.equal(run.status, 1); assert.match(run.stderr, /SERVICE_BOUNDARY_UNAVAILABLE/u);
    await assert.rejects(readFile(touched), { code: 'ENOENT' });
  }
});
