import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { validateWithCore } from '../lib/live2d/core-validation.mjs';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'live2d-core-validation-'));
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('live2d-core-validation-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const write = async (name: string, value: string) => { const filename = path.join(directory, name); await fs.writeFile(filename, value); return filename; };
  const mocPath = await write('header-only.moc3', 'MOC3 header is not an actual model-load result');
  return { directory, write, mocPath };
}

test('missing Core is BLOCKED even when a MOC-looking file exists; parameters are never invented', async t => {
  const f = await fixture(t);
  const result = await validateWithCore({ mocPath: f.mocPath, expectedParameters: [{ id: 'ParamMouthOpenY', min: 0, max: 1, default: 0 }] });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.environment.coreExecutionAttempted, false);
  assert.equal(result.environment.actualModelLoaded, false);
  assert.equal(result.loadedCoreHash, null);
  assert.equal(result.coreVersion, null);
  assert.deepEqual(result.parameters, []);
  assert.equal(result.mocHash, sha(await fs.readFile(f.mocPath)));
  assert.ok(result.checks.some(entry => entry.id === 'moc_load' && entry.status === 'NOT_RUN'));
  assert.ok(!result.checks.some(entry => entry.id === 'moc_load' && entry.status === 'PASS'));
});

test('malformed settings fail before execution and cannot become a Core pass', async t => {
  const f = await fixture(t);
  const expression = await f.write('bad.exp3.json', '{broken json');
  const result = await validateWithCore({ mocPath: f.mocPath, expressionFiles: [expression] });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.environment.coreExecutionAttempted, false);
  assert.equal(result.command, null);
  assert.ok(result.checks.some(entry => entry.id === 'settings:expressionFiles:0' && entry.status === 'FAIL'));
});

test('undeclared MotionSync targets and malformed motion segments fail without executing Core', async t => {
  const f = await fixture(t);
  const sync = await f.write('bad.motionsync3.json', JSON.stringify({ Version: 1, Settings: [{ Id: 'Mouth', CubismParameters: [{ Id: 'ParamMouthOpenY', Min: 0, Max: 1 }], Mappings: [{ Targets: [{ Id: 'UnlistedMouth', Value: 1 }] }] }] }));
  const motion = await f.write('bad.motion3.json', JSON.stringify({ Version: 3, Curves: [{ Target: 'Parameter', Id: 'ParamMouthOpenY', Segments: [0, 0, 99, 1, 1] }] }));
  const result = await validateWithCore({ mocPath: f.mocPath, motionFiles: [motion], motionSyncFiles: [sync] });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.environment.coreExecutionAttempted, false);
  assert.ok(result.checks.some(entry => entry.id === 'settings:motionFiles:0' && entry.status === 'FAIL'));
  assert.ok(result.checks.some(entry => entry.id === 'settings:motionSyncFiles:0' && entry.status === 'FAIL'));
});

test('selected SHA mismatch stops before any supplied JavaScript executes', async t => {
  const f = await fixture(t);
  const source = 'throw new Error("This file must never execute when its selected hash mismatches.");';
  const corePath = await f.write('not-a-core.js', source);
  const result = await validateWithCore({ corePath, mocPath: f.mocPath, targetHashes: { core: '0'.repeat(64) } });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.environment.coreExecutionAttempted, false);
  assert.equal(result.environment.coreFileHash, sha(source));
  assert.equal(result.loadedCoreHash, null);
  assert.equal(result.command, null);
  assert.ok(result.checks.some(entry => entry.id === 'hash:core' && entry.status === 'FAIL'));
});

test('an incompatible local script is BLOCKED after actual isolated evaluation; no mocked Core global is supplied', async t => {
  const f = await fixture(t);
  const source = 'globalThis.localDiagnostic = "This script is intentionally not a Cubism Core implementation.";';
  const corePath = await f.write('incompatible.js', source);
  const result = await validateWithCore({ corePath, mocPath: f.mocPath });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.environment.coreExecutionAttempted, true);
  assert.equal(result.environment.actualModelLoaded, false);
  assert.equal(result.loadedCoreHash, sha(source));
  assert.equal(result.coreVersion, null);
  assert.deepEqual(result.parameters, []);
  assert.ok(result.checks.some(entry => entry.id === 'core_execution' && entry.status === 'BLOCKED'));
  assert.ok(!result.checks.some(entry => entry.id === 'moc_load' && entry.status === 'PASS'));
});

test('BLOCKED evidence records actual file hashes without promoting file reads to a model-load result', async t => {
  const f = await fixture(t);
  const result = await validateWithCore({ mocPath: f.mocPath, modelId: '../../unsafe-label', runEvidenceDirectory: path.join(f.directory, 'evidence') });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.outputs.length, 1);
  const output = result.outputs[0];
  assert.equal(path.dirname(output.path), path.join(f.directory, 'evidence'));
  const bytes = await fs.readFile(output.path);
  assert.equal(output.sha256, sha(bytes));
  assert.equal(output.bytes, bytes.length);
  const stored = JSON.parse(bytes.toString('utf8'));
  assert.equal(stored.status, 'BLOCKED');
  assert.equal(stored.environment.actualModelLoaded, false);
  assert.deepEqual(stored.parameters, []);
});

test('invalid expected ranges fail before execution rather than fabricating matching actual parameters', async t => {
  const f = await fixture(t);
  const result = await validateWithCore({ mocPath: f.mocPath, expectedParameters: [{ id: 'ParamMouthOpenY', min: 1, max: 0, default: 0 }] });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.environment.coreExecutionAttempted, false);
  assert.ok(result.checks.some(entry => entry.id === 'expected_parameter_spec' && entry.status === 'FAIL'));
});
