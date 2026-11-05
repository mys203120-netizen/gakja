import test from 'node:test';
import assert from 'node:assert/strict';
import type { InterviewSession } from '../server/protocol';
import { visibleFollowUpCounts } from '../scripts/benchmark-latest-interview';

test('historical core checkpoints never inherit future F counts or count a replay twice', () => {
  const source = { turns: [
    { id: 'root', parentMainQuestionId: 'root', questionKind: 'main' },
    { id: 'f1', parentMainQuestionId: 'root', questionKind: 'follow_up' },
    { id: 'f2', parentMainQuestionId: 'root', questionKind: 'follow_up' },
  ], questionPresentations: [
    { turnId: 'root', questionKind: 'main', startedAtMs: 0 },
    { turnId: 'f1', questionKind: 'follow_up', startedAtMs: 100 },
    { turnId: 'f1', questionKind: 'follow_up', startedAtMs: 200 },
    { turnId: 'f2', questionKind: 'follow_up', startedAtMs: 300 },
  ] } as unknown as InterviewSession;
  assert.deepEqual(visibleFollowUpCounts({ ...source, turns: source.turns.slice(0, 1) }), {});
  assert.deepEqual(visibleFollowUpCounts({ ...source, turns: source.turns.slice(0, 2) }), { root: 1 });
  assert.deepEqual(visibleFollowUpCounts(source), { root: 2 });
  assert.equal(source.turns.length, 3);
});
