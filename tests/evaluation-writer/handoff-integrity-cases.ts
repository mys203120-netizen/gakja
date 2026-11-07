import test from 'node:test';
import assert from 'node:assert/strict';
import type { ControlledHandoffFault } from './ended-fixture';
import type { SessionCommandSnapshot } from '../../server/session-writer/session-command-ports';

interface Response<T = unknown> { status: number; value: T }
interface Child {
  rpc<T = Record<string, unknown>>(operation: string, payload?: Record<string, unknown>): Promise<T>;
}
interface Seeded {
  sessionId: string; snapshot: SessionCommandSnapshot; qualification: string;
  testOnlyMalformedHandoff: ControlledHandoffFault | null;
}
export interface HandoffIntegrityHarness {
  one(): Child; worker1(): Child; worker2(): Child;
  fcommand(who: string, id: string, action: string, payload: unknown): Promise<Response>;
  sql(table: string, id: string): Promise<Record<string, unknown>[]>;
  rows: Record<string, unknown>[];
}
function assertFrozen(actual: SessionCommandSnapshot, expected: SessionCommandSnapshot) {
  const { serverNow: actualNow, lastDisconnectedAt: actualDisconnect, ...left } = actual;
  const { serverNow: expectedNow, lastDisconnectedAt: expectedDisconnect, ...right } = expected;
  void actualNow; void actualDisconnect; void expectedNow; void expectedDisconnect;
  assert.deepEqual(left, right);
}
const groups: Array<{ label: string; faults: ControlledHandoffFault[]; code: string }> = [
  { label: 'owner and student', faults: ['owner', 'student'], code: 'F_HANDOFF_BINDING_CHANGED' },
  { label: 'personal application and domain support targets', faults: ['application-target', 'support-target'], code: 'F_HANDOFF_BINDING_CHANGED' },
  { label: 'accepted end intent', faults: ['accepted-intent'], code: 'F_HANDOFF_BINDING_CHANGED' },
  { label: 'accepted end input hash', faults: ['accepted-input'], code: 'F_HANDOFF_BINDING_CHANGED' },
  { label: 'exact context session and pins JSON', faults: ['context-json', 'session-json', 'pins-json'], code: 'F_HANDOFF_BINDING_CHANGED' },
  { label: 'pinned evaluation model', faults: ['model'], code: 'F_HANDOFF_PINS_CHANGED' },
  { label: 'pinned pipeline', faults: ['pipeline'], code: 'F_HANDOFF_PINS_CHANGED' },
  { label: 'evaluation source fingerprint', faults: ['source'], code: 'F_HANDOFF_EVALUATION_SOURCE_CHANGED' },
];

/** Deliberately malformed payloads are committed only in newly owned E rows by
 * the explicit trusted IPC fixture helper. They are not updates of E evidence,
 * public upload routes, real approvals or a replacement decoder. */
export function registerHandoffIntegrityCases(h: HandoffIntegrityHarness) {
  test('F-HANDOFF-13 actual HTTP consumer refuses exact E handoff substitutions before any F job or provider I/O', { timeout: 600_000 }, async t => {
    const normal = await h.one().rpc<Seeded>('seed-controlled-ended', { who: 'a', followUps: 0 });
    assert.equal(normal.testOnlyMalformedHandoff, null);
    const workers = [h.worker1(), h.worker2()];
    const calls = async () => Promise.all(workers.map(async worker => (await worker.rpc<{ counters: { modelCalls: number } }>('state')).counters.modelCalls));
    const before = await calls();
    for (const group of groups) await t.test(group.label, { timeout: 120_000 }, async () => {
      for (const fault of group.faults) {
        const seeded = await h.one().rpc<Seeded>('seed-controlled-ended', { who: 'a', followUps: 0, handoffFault: fault });
        assert.equal(seeded.testOnlyMalformedHandoff, fault);
        assert.equal(seeded.qualification, 'controlled-public-E-repository/shared-lifecycle-fixture');
        assert.notEqual(seeded.sessionId, normal.sessionId); assert.ok(seeded.snapshot.handoff);
        // The actual E repository accepted its own envelope/hash checks. The
        // new F HTTP boundary must still reject the substituted payload.
        const refused = await h.fcommand('a', seeded.sessionId, 'consume', {
          handoffPayloadSha256: seeded.snapshot.handoff.payloadSha256, approvalSha256: null,
        });
        assert.equal(refused.status, 409, JSON.stringify({ fault, response: refused.value }));
        assert.ok(JSON.stringify(refused.value).includes(group.code), JSON.stringify({ fault, response: refused.value }));
        for (const table of ['evaluation_jobs', 'evaluation_results', 'evaluation_result_revisions', 'evaluation_command_receipts'])
          assert.equal((await h.sql(table, seeded.sessionId)).length, 0, fault + ':' + table);
        assertFrozen(await h.one().rpc<SessionCommandSnapshot>('snapshot', { who: 'a', sessionId: seeded.sessionId }), seeded.snapshot);
        assertFrozen(await h.one().rpc<SessionCommandSnapshot>('snapshot', { who: 'a', sessionId: normal.sessionId }), normal.snapshot);
        assert.deepEqual(await calls(), before);
        h.rows.push({ caseId: 'F-HANDOFF-13-' + fault, sessionId: seeded.sessionId, qualification: seeded.qualification,
          deliberatelyMalformedNewOwnedEInput: true, existingEUpdated: false, ECommitAccepted: true, actualHttpRejection: 409,
          rejectionBoundary: 'F actual HTTP consumer', rejectionCode: group.code, outerPayloadHashRecomputed: true,
          FJobs: 0, FResults: 0, FResultRevisions: 0, FCommandReceipts: 0, modelCallsDelta: 0,
          normalEFrozenBytesExact: true, malformedEFrozenBytesExact: true, ignoredOuterTelemetry: ['serverNow', 'lastDisconnectedAt'] });
      }
    });
  });
}
