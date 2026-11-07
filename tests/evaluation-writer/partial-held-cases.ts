import test from 'node:test';
import assert from 'node:assert/strict';
import type { InterviewSession } from '../../server/protocol';
import type { SessionCommandSnapshot } from '../../server/session-writer/session-command-ports';
import type { EvaluationProjection } from '../../server/evaluation-writer/evaluation-writer-ports';
import { APPROVED_KNOWLEDGE_VERSION, knowledgeHash, parseApprovedKnowledgeBundle, type ApprovedKnowledgeBundle, type ApprovedKnowledgePacket } from '../../server/data/approved-knowledge';
import { mutateSupplyBinding } from '../fixtures/evaluation-supply';
import { knowledgeSpan, reviewedKnowledgeBundle, sealKnowledge, syntheticKnowledgeApproval } from '../fixtures/reviewed-evaluation-knowledge';

type Owner = 'a' | 'b';
interface Response<T = unknown> { status: number; value: T }
interface Child {
  rpc<T = Record<string, unknown>>(operation: string, payload?: Record<string, unknown>): Promise<T>;
  request<T = Record<string, unknown>>(who: string, route: string, input?: unknown): Promise<Response<T>>;
}
interface View {
  control: { approvalGeneration: string; approvalSha256: string | null };
  projection: EvaluationProjection | null;
}
interface Evaluation {
  answers: Array<{ turnId: string; status: string; score: number | null; holdReasons: string[] }>;
  clusterScores: Array<{ status: string; score: number | null;
    members: Array<{ turnId: string; weight: number | null; score: number | null }>; exclusionReasons: Array<{ turnId: string; code: string }> }>;
  sessionScore: number | null; overallWeightedScore: number | null; partialReport: boolean;
  aggregation: { N_total: number; N_valid: number; validRatio: number | null };
}
/** Real HTTP supply/consumer and independent worker closures. Only the new E
 * inputs are explicitly controlled public fixtures; no evaluator is replaced. */
export interface PartialHeldHarness {
  one(): Child; worker1(): Child;
  installTrust(who: Owner): Promise<unknown>;
  publishA(who: Owner, id: string): Promise<unknown>;
  publishB(who: Owner, id: string, mutate?: (payload: Record<string, unknown>) => void, selectedTurnIds?: string[]): Promise<Response>;
  signReceipt(who: Owner, payload: Record<string, unknown>): Record<string, unknown>;
  consume(who: Owner, id: string): Promise<Response>;
  eview(who: string, id: string): Promise<View>;
  runJob(who: Owner, jobId: string): Promise<{ processed: boolean; job: { status: string } | null }>;
  sql(table: string, id: string): Promise<Record<string, unknown>[]>;
  epath(id: string, action?: string): string;
  rows: Record<string, unknown>[];
}

async function controlled(h: PartialHeldHarness) {
  const seeded = await h.one().rpc<{ sessionId: string; snapshot: SessionCommandSnapshot; qualification: string }>('seed-controlled-ended', { who: 'a', followUps: 2 });
  const session = JSON.parse(seeded.snapshot.sessionJson) as InterviewSession;
  assert.equal(seeded.qualification, 'controlled-public-E-repository/shared-lifecycle-fixture');
  assert.equal(session.turns.length, 3); assert.deepEqual(session.turns.map(turn => turn.followUpIndex), [0, 1, 2]);
  assert.deepEqual(session.turns.map(turn => turn.questionKind), ['main', 'follow_up', 'follow_up']);
  return { ...seeded, session };
}

function assertFrozen(actual: SessionCommandSnapshot, expected: SessionCommandSnapshot) {
  // Read-time/connection telemetry is outside the frozen E payload. Every raw
  // session/context/pin byte, authority binding, revision and handoff is exact.
  const { serverNow: actualNow, lastDisconnectedAt: actualDisconnect, ...left } = actual;
  const { serverNow: expectedNow, lastDisconnectedAt: expectedDisconnect, ...right } = expected;
  void actualNow; void actualDisconnect; void expectedNow; void expectedDisconnect;
  assert.deepEqual(left, right);
}

function resignBundle(h: PartialHeldHarness, payload: Record<string, unknown>, bundle: ApprovedKnowledgeBundle) {
  const envelope = JSON.parse(String(payload.reviewJson)) as { receipt: Record<string, unknown>; proposal: unknown };
  const { signature: oldSignature, ...receipt } = envelope.receipt; void oldSignature;
  payload.bundleJson = JSON.stringify(bundle);
  payload.reviewJson = JSON.stringify({ ...envelope, receipt: h.signReceipt('a', { ...receipt, bundleSha256: bundle.contentSha256 }) });
}

function invalidFollowUpProof(session: InterviewSession, original: ApprovedKnowledgeBundle, fault: 'claim-span' | 'claim-answer' | 'packet-span') {
  const turn = session.turns[1], text = '공개 합성 출처 😀: 검토 대상의 확정 답변 원문만 연결한다.';
  const packet: ApprovedKnowledgePacket = sealKnowledge({ version: APPROVED_KNOWLEDGE_VERSION, id: 'explicit-controlled-packet-' + turn.id,
    revision: 'explicit-public-v1', approval: syntheticKnowledgeApproval,
    source: { id: 'explicit-controlled-source', version: 'public-v1', locator: 'explicit-public-fixture:proof', text, textSha256: knowledgeHash(text) },
    sourceSpan: knowledgeSpan(text), assumptions: [], excludedScopes: [] });
  const { contentSha256: oldHash, ...base } = original.bindings.find(binding => binding.turnId === turn.id)!; void oldHash;
  const binding = sealKnowledge({ ...base, scope: 'objective_accuracy_core' as const, claimCoverage: 'all_core_claims_reviewed' as const,
    packetRefs: [{ id: packet.id, revision: packet.revision, contentSha256: packet.contentSha256 }],
    claimReviews: [{ sourceTurnId: turn.id, answerId: turn.answerId!, answerSha256: knowledgeHash(turn.rawTranscript!), claim: knowledgeSpan(turn.rawTranscript!),
      packetId: packet.id, packetSha256: packet.contentSha256, sourceSpanSha256: packet.sourceSpan.sha256,
      assumptionReviews: [], excludedScopeReviews: [], relation: 'supported' as const, isCoreToDemand: true,
      rationale: '명시적인 공개 검수 fixture이며 잘못된 proof 거부만 검증한다.' }] });
  const valid = reviewedKnowledgeBundle([packet], original.bindings.map(row => row.turnId === turn.id ? binding : row));
  const copied = structuredClone(valid), selected = copied.bindings.find(row => row.turnId === turn.id)!;
  if (fault === 'claim-span') selected.claimReviews[0].claim.end++;
  if (fault === 'claim-answer') selected.claimReviews[0].answerSha256 = '0'.repeat(64);
  if (fault === 'packet-span') {
    const { contentSha256: ignored, ...body } = copied.packets[0]; void ignored;
    body.sourceSpan.end++;
    const invalid = sealKnowledge(body); copied.packets[0] = invalid;
    selected.packetRefs[0].contentSha256 = invalid.contentSha256;
    selected.claimReviews[0].packetSha256 = invalid.contentSha256;
  }
  // Recompute every enclosing content hash and the receipt signature. These
  // are semantic proof failures, rather than stale hashes/signatures.
  const bindings = copied.bindings.map(({ contentSha256: ignored, ...body }) => { void ignored; return sealKnowledge(body); });
  return sealKnowledge({ version: copied.version, packets: copied.packets, bindings });
}

export function registerPartialHeldCases(h: PartialHeldHarness) {
  for (const missingIndex of [1, 2]) test(`F-HELD-10-F${missingIndex} missing actual follow-up review preserves its null score and the original three-member weights`, { timeout: 240_000 }, async () => {
    const seeded = await controlled(h), { sessionId: id, session } = seeded;
    await h.installTrust('a'); await h.publishA('a', id);
    const missingId = session.turns[missingIndex].id, allowedIds = session.turns.filter(turn => turn.id !== missingId).map(turn => turn.id);
    const supplied = await h.publishB('a', id, undefined, allowedIds); assert.equal(supplied.status, 200, JSON.stringify(supplied.value));
    const stored = await h.one().request<{ bundleJson: string | null }>('a', h.epath(id, 'approval')); assert.equal(stored.status, 200);
    const bundle = parseApprovedKnowledgeBundle(JSON.parse(stored.value.bundleJson!));
    assert.deepEqual(bundle.bindings.map(binding => binding.turnId).sort(), [...allowedIds].sort());
    assert.equal(bundle.bindings.some(binding => binding.turnId === missingId), false);
    assert.equal((await h.consume('a', id)).status, 200);
    const queued = (await h.eview('a', id)).projection!; assert.equal(queued.state, 'queued'); assert.ok(queued.job);
    const worker = h.worker1(), before = await worker.rpc<{ modelInputs: Array<{ turnIds: string[] }> }>('state');
    const ran = await h.runJob('a', queued.job.id); assert.equal(ran.job?.status, 'completed', JSON.stringify(ran));
    const after = await worker.rpc<{ modelInputs: Array<{ turnIds: string[] }> }>('state');
    const submitted = after.modelInputs.slice(before.modelInputs.length).flatMap(input => input.turnIds);
    assert.deepEqual([...submitted].sort(), [...allowedIds].sort()); assert.equal(submitted.includes(missingId), false);
    const completed = (await h.eview('a', id)).projection!; assert.equal(completed.currentApproval, true); assert.ok(completed.result);
    const evaluation = completed.result.evaluation as Evaluation;
    assert.equal(evaluation.answers.length, 3);
    const held = evaluation.answers.find(answer => answer.turnId === missingId)!;
    assert.equal(held.status, 'NOT_EVALUABLE'); assert.equal(held.score, null); assert.ok(held.holdReasons.includes('KNOWLEDGE_SCOPE_APPROVAL_REQUIRED'));
    for (const allowed of allowedIds) { const answer = evaluation.answers.find(row => row.turnId === allowed)!; assert.equal(typeof answer.score, 'number'); }
    assert.equal(evaluation.clusterScores.length, 1); const cluster = evaluation.clusterScores[0];
    assert.equal(cluster.status, 'CLUSTER_NOT_EVALUABLE'); assert.equal(cluster.score, null); assert.equal(cluster.members.length, 3);
    assert.deepEqual(session.turns.map(turn => cluster.members.find(member => member.turnId === turn.id)!.weight), [0.7, 0.15, 0.15]);
    assert.equal(cluster.members.find(member => member.turnId === missingId)!.score, null);
    assert.ok(cluster.exclusionReasons.some(reason => reason.turnId === missingId));
    assert.equal(evaluation.sessionScore, null); assert.equal(evaluation.overallWeightedScore, null); assert.equal(evaluation.partialReport, true);
    assert.deepEqual(evaluation.aggregation.N_total, 1); assert.equal(evaluation.aggregation.N_valid, 0); assert.equal(evaluation.aggregation.validRatio, 0);
    const checkpoints = completed.job!.checkpoints.flatMap(checkpoint => (checkpoint.output as { answers: Array<{ turnId: string }> }).answers.map(answer => answer.turnId));
    assert.deepEqual(checkpoints.sort(), [...allowedIds].sort());
    assertFrozen(await h.one().rpc<SessionCommandSnapshot>('snapshot', { who: 'a', sessionId: id }), seeded.snapshot);
    assert.equal((await h.sql('evaluation_results', id)).length, 1); assert.equal((await h.sql('evaluation_result_revisions', id)).length, 1);
    h.rows.push({ caseId: `F-HELD-10-F${missingIndex}`, sessionId: id, jobId: completed.job!.id, qualification: seeded.qualification,
      missingReviewTurnId: missingId, storedBundleExcludedHeld: true, actualProviderTurnIds: submitted, heldScore: null,
      clusterScore: null, originalWeights: [0.7, 0.15, 0.15], memberCount: 3, sessionScore: null, originalEFrozenBytesExact: true,
      ignoredOuterTelemetry: ['serverNow', 'lastDisconnectedAt'],
      actualHttpSupplyAndConsumer: true, actualWorkerParserAndAggregation: true, paidProviderCalls: 0 });
  });

  test('F-HELD-11 a correctly signed bundle with a false exact question proof is rejected before approval or a runnable job', { timeout: 240_000 }, async () => {
    const seeded = await controlled(h), id = seeded.sessionId;
    await h.installTrust('a'); await h.publishA('a', id);
    const before = await h.eview('a', id);
    const refused = await h.publishB('a', id, payload => {
      const bundle = parseApprovedKnowledgeBundle(JSON.parse(String(payload.bundleJson)));
      const invalid = mutateSupplyBinding(bundle, binding => { binding.questionSha256 = '0'.repeat(64); });
      resignBundle(h, payload, invalid);
    });
    assert.equal(refused.status, 409, JSON.stringify(refused.value)); assert.match(JSON.stringify(refused.value), /SESSION_REVIEW_BINDING_CHANGED/u);
    const after = await h.eview('a', id); assert.equal(after.control.approvalGeneration, before.control.approvalGeneration);
    assert.equal(after.control.approvalSha256, null); assert.equal((await h.consume('a', id)).status, 200);
    const held = (await h.eview('a', id)).projection!; assert.equal(held.state, 'review_required'); assert.equal(held.job, null); assert.equal(held.result, null);
    assert.equal((await h.sql('evaluation_jobs', id)).length, 0); assert.equal((await h.sql('evaluation_results', id)).length, 0);
    assertFrozen(await h.one().rpc<SessionCommandSnapshot>('snapshot', { who: 'a', sessionId: id }), seeded.snapshot);
    h.rows.push({ caseId: 'F-HELD-11', sessionId: id, qualification: seeded.qualification, currentTrustedReviewerSignature: true,
      bundleAndBindingHashesRecomputed: true, rejectionCode: 'SESSION_REVIEW_BINDING_CHANGED', approvalCreated: false,
      runnableJobs: 0, resultRows: 0, originalEFrozenBytesExact: true, actualHttpSupplyAndConsumer: true });
  });

  test('F-PROOF-14 actual HTTP refuses signed wrong-session answer and UTF-16 claim or packet proofs before B publication', { timeout: 300_000 }, async t => {
    const seeded = await controlled(h), id = seeded.sessionId;
    await h.installTrust('a'); await h.publishA('a', id);
    const before = await h.eview('a', id);
    for (const fault of ['session', 'session-answers', 'claim-span', 'claim-answer', 'packet-span'] as const) await t.test(fault, { timeout: 60_000 }, async () => {
      const refused = await h.publishB('a', id, payload => {
        const bundle = parseApprovedKnowledgeBundle(JSON.parse(String(payload.bundleJson)));
        const invalid = fault === 'session' || fault === 'session-answers'
          ? mutateSupplyBinding(bundle, binding => { if (fault === 'session') binding.sessionId = 'explicit-other-session'; else binding.sessionQuestionAnswerSha256 = '0'.repeat(64); })
          : invalidFollowUpProof(seeded.session, bundle, fault);
        resignBundle(h, payload, invalid);
      });
      const expected = fault === 'session' || fault === 'session-answers' ? 'SESSION_REVIEW_BINDING_CHANGED'
        : fault === 'packet-span' ? 'APPROVED_KNOWLEDGE_SPAN_INVALID' : 'APPROVED_KNOWLEDGE_REVIEW_BINDING_INVALID';
      assert.equal(refused.status, 409, JSON.stringify({ fault, value: refused.value })); assert.ok(JSON.stringify(refused.value).includes(expected), JSON.stringify(refused.value));
      const after = await h.eview('a', id); assert.equal(after.control.approvalGeneration, before.control.approvalGeneration); assert.equal(after.control.approvalSha256, null);
      for (const table of ['evaluation_sessions', 'evaluation_jobs', 'evaluation_results', 'evaluation_result_revisions'])
        assert.equal((await h.sql(table, id)).length, 0, fault + ':' + table);
      assertFrozen(await h.one().rpc<SessionCommandSnapshot>('snapshot', { who: 'a', sessionId: id }), seeded.snapshot);
      h.rows.push({ caseId: 'F-PROOF-14-' + fault, sessionId: id, qualification: seeded.qualification, currentTrustedReviewerSignature: true,
        enclosingHashesRecomputed: true, rejectionBoundary: 'actual HTTP B approval before publication', rejectionCode: expected,
        approvalCreated: false, FSessionControls: 0, FJobs: 0, FResults: 0, originalEFrozenBytesExact: true,
        ignoredOuterTelemetry: ['serverNow', 'lastDisconnectedAt'] });
    });
  });
}
