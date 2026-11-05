import test from 'node:test';
import assert from 'node:assert/strict';
import { repeatConfiguration } from '../scripts/repeat-interview-core-checkpoints';

test('repeat runner bounds paid decisions before any calls', () => {
  assert.equal(repeatConfiguration([]).plannedDecisions, 15);
  for (const args of [['--repeats=0'], ['--repeats=6'], ['--only=conversation:3,conversation:3'], ['--only=unknown']]) {
    assert.throws(() => repeatConfiguration(args), /BOUNDED_REPEAT_CONFIGURATION_INVALID/u);
  }
});
