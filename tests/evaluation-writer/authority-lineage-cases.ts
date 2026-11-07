import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { EvaluationProjection } from '../../server/evaluation-writer/evaluation-writer-ports';

type Owner = 'a' | 'b';
interface Response<T = unknown> { status: number; value: T }
interface Child {
  request<T = Record<string, unknown>>(who: string, route: string, input?: unknown): Promise<Response<T>>;
  rpc<T = Record<string, unknown>>(operation: string, payload?: Record<string, unknown>): Promise<T>;
  barrier(phase: string): Promise<{ barrierId: string }>;
}
interface View {
  control: { approvalSha256: string | null }; projection: EvaluationProjection | null;
}
/** All closures come from the real HTTP/two-worker/official Storage harness.
 * No additional database, domain shortcuts or model/worker replacement lives here. */
export interface AuthorityLineageHarness {
  one(): Child; worker1(): Child;
  endedHttp(who: Owner): Promise<string>;
  publishA(who: Owner, id: string): Promise<unknown>;
  publishB(who: Owner, id: string): Promise<Response>;
  consume(who: Owner, id: string): Promise<Response>;
  eview(who: string, id: string): Promise<View>;
  runJob(who: Owner, jobId: string): Promise<{ processed: boolean; job: { status: string } | null }>;
  sql(table: string, id: string): Promise<Record<string, unknown>[]>;
  pools: { admin: Pick<Pool, 'query'> };
  completed: Map<Owner, { id: string; jobId: string; result: unknown }>;
  rows: Record<string, unknown>[];
  epath(id: string, action?: string): string;
}

export function registerAuthorityLineageCases(h: AuthorityLineageHarness) {
  test('F-LINEAGE-05 a newly signed B revision creates a new domain job and preserves the prior exact result and reference', { timeout: 240_000 }, async () => {
    const id = await h.endedHttp('a'); await h.publishA('a', id);
    assert.equal((await h.publishB('a', id)).status, 200); assert.equal((await h.consume('a', id)).status, 200);
    const initial = await h.eview('a', id), oldJobId = initial.projection!.job!.id;
    assert.equal((await h.runJob('a', oldJobId)).job?.status, 'completed');
    const old = (await h.eview('a', id)).projection!, resultsBefore = await h.sql('evaluation_results', id), revisionsBefore = await h.sql('evaluation_result_revisions', id);
    assert.ok(old.result); assert.ok(old.revisionJson); assert.equal(resultsBefore.length, 1); assert.equal(revisionsBefore.length, 1);
    // Actual HTTP processing puts the new issuance after the original receipt;
    // the original approved bundle, E frozen answers and A registry stay exact.
    assert.equal((await h.publishB('a', id)).status, 200); assert.equal((await h.consume('a', id)).status, 200);
    const revised = await h.eview('a', id), newJobId = revised.projection!.job!.id;
    assert.notEqual(revised.control.approvalSha256, initial.control.approvalSha256); assert.notEqual(newJobId, oldJobId);
    assert.notEqual(revised.projection!.job!.sourceSha256, old.job!.sourceSha256);
    assert.equal(revised.projection!.job!.pipelineVersion, old.job!.pipelineVersion); assert.equal(revised.projection!.job!.model, old.job!.model);
    assert.equal((await h.runJob('a', newJobId)).job?.status, 'completed');
    const latest = (await h.eview('a', id)).projection!; assert.equal(latest.job!.id, newJobId); assert.equal(latest.currentApproval, true);
    const history = await h.one().request<EvaluationProjection & { resultIsHistorical: boolean }>('a', h.epath(id, 'revision') + '?jobId=' + oldJobId);
    assert.equal(history.status, 200, JSON.stringify(history.value)); assert.equal(history.value.currentApproval, false); assert.equal(history.value.resultIsHistorical, true);
    assert.deepEqual(history.value.result, old.result); assert.equal(history.value.revisionJson, old.revisionJson); assert.equal(history.value.resultRevisionId, old.resultRevisionId);
    const resultRows = await h.sql('evaluation_results', id), revisionRows = await h.sql('evaluation_result_revisions', id);
    assert.equal(resultRows.length, 2); assert.equal(revisionRows.length, 2);
    assert.deepEqual(resultRows.find(row => row.job_id === oldJobId), resultsBefore[0]); assert.deepEqual(revisionRows.find(row => row.job_id === oldJobId), revisionsBefore[0]);
    h.rows.push({ caseId: 'F-LINEAGE-05', sessionId: id, oldJobId, newJobId, resultRows: 2, revisionRows: 2, oldResultAndReferenceExact: true, automaticReceiptReissue: false });
  });

  test('F-AUTHORITY-06 an owned grant revoked during actual model I/O prevents result publication; restoring the mapping preserves historical results', { timeout: 240_000 }, async () => {
    const historical = h.completed.get('a')!, historicalBytes = await h.sql('evaluation_results', historical.id);
    const id = await h.endedHttp('a'); await h.publishA('a', id); assert.equal((await h.publishB('a', id)).status, 200); assert.equal((await h.consume('a', id)).status, 200);
    const jobId = (await h.eview('a', id)).projection!.job!.id, worker = h.worker1();
    const grant = (await h.pools.admin.query('SELECT account_id,student_id,application_target_id,active FROM gakja.access_grants WHERE account_id=$1 AND application_target_id=$2', ['account-a', 'shadow-app-a'])).rows;
    assert.equal(grant.length, 1); assert.equal(grant[0].active, true);
    const revisionBefore = (await h.pools.admin.query('SELECT revision::text value FROM gakja.accounts WHERE account_id=$1', ['account-a'])).rows[0].value;
    await worker.rpc('configure', { holdModel: true });
    const pending = h.runJob('a', jobId).then(result => ({ result, error: null }), error => ({ result: null, error: error as Error }));
    const barrier = await worker.barrier('model'); let restored = false, released = false;
    try {
      const changed = await h.pools.admin.query('UPDATE gakja.access_grants SET active=false WHERE account_id=$1 AND student_id=$2 AND application_target_id=$3 AND active=true', [grant[0].account_id, grant[0].student_id, grant[0].application_target_id]);
      assert.equal(changed.rowCount, 1);
      const denied = await h.one().request('a', h.epath(id)); assert.notEqual(denied.status, 200);
      await worker.rpc('release', { barrierId: barrier.barrierId }); released = true;
      const outcome = await pending; assert.notEqual(outcome.result?.job?.status, 'completed');
      assert.equal((await h.sql('evaluation_results', id)).length, 0); assert.equal((await h.sql('evaluation_result_revisions', id)).length, 0);
      await h.pools.admin.query('UPDATE gakja.access_grants SET active=$4 WHERE account_id=$1 AND student_id=$2 AND application_target_id=$3', [grant[0].account_id, grant[0].student_id, grant[0].application_target_id, grant[0].active]); restored = true;
      const revisionAfter = (await h.pools.admin.query('SELECT revision::text value FROM gakja.accounts WHERE account_id=$1', ['account-a'])).rows[0].value;
      assert.ok(BigInt(revisionAfter) > BigInt(revisionBefore));
      assert.equal((await h.one().request('a', h.epath(id))).status, 200);
      const archive = await h.one().request<EvaluationProjection & { resultIsHistorical: boolean }>('a', h.epath(historical.id, 'revision') + '?jobId=' + historical.jobId);
      assert.equal(archive.status, 200, JSON.stringify(archive.value)); assert.deepEqual(archive.value.result, historical.result);
      assert.deepEqual(await h.sql('evaluation_results', historical.id), historicalBytes);
      h.rows.push({ caseId: 'F-AUTHORITY-06', sessionId: id, jobId, revokedDuringActualModelIo: true, deniedStatus: denied.status,
        resultRows: 0, revisionRows: 0, mappingRestoredToOriginalActive: true, accountRevisionRemainedMonotonic: true, historicalResultExact: true,
        workerError: outcome.error?.message ?? null });
    } finally {
      if (!restored) await h.pools.admin.query('UPDATE gakja.access_grants SET active=$4 WHERE account_id=$1 AND student_id=$2 AND application_target_id=$3', [grant[0].account_id, grant[0].student_id, grant[0].application_target_id, grant[0].active]);
      if (!released) await worker.rpc('release', { barrierId: barrier.barrierId }).catch(() => undefined);
      await pending; await worker.rpc('configure', {});
    }
  });
}
