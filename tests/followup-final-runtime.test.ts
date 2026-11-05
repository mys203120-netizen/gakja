import test from 'node:test';
import assert from 'node:assert/strict';
import { finalRuntimeQaOptions } from '../scripts/verify-followup-final-runtime';

test('full-runtime QA needs explicit live opt-in and defaults to six bounded Q6/Q14 attempts', () => {
  const output = 'artifacts/followup-final-runtime-synthetic-options.json';
  assert.deepEqual(finalRuntimeQaOptions([`--out=${output}`]), { runLive: false, only: [6, 14], repeats: 3, output });
  assert.equal(finalRuntimeQaOptions(['--run-live', `--out=${output}`]).runLive, true);
});

test('full-runtime QA rejects duplicate/unknown cases, unbounded repeats and existing-data output paths', () => {
  const base = ['--out=artifacts/followup-final-runtime-synthetic-options.json'];
  for (const value of ['6,6', '0', '23', '6.5', 'NaN', '']) assert.throws(() => finalRuntimeQaOptions([...base, `--only=${value}`]), /FINAL_RUNTIME_QA_OPTIONS_INVALID/u);
  for (const value of ['0', '6', '1.5', 'NaN']) assert.throws(() => finalRuntimeQaOptions([...base, `--repeats=${value}`]), /FINAL_RUNTIME_QA_OPTIONS_INVALID/u);
  assert.throws(() => finalRuntimeQaOptions([...base, '--only=1,2,3,4,5,6,7', '--repeats=5']), /FINAL_RUNTIME_QA_OPTIONS_INVALID/u);
  for (const output of ['data/sessions/existing.json', '../outside.json', 'artifacts/followup-final-runtime-../old.json']) {
    assert.throws(() => finalRuntimeQaOptions([`--out=${output}`]), /FINAL_RUNTIME_QA_OPTIONS_INVALID/u);
  }
});
