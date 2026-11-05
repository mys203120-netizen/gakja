import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession } from '../server/protocol';
import { APPROVED_KNOWLEDGE_VERSION, knowledgeHash, knowledgeSessionQuestionAnswerHash, parseApprovedKnowledgeBundle,
  type ApprovedKnowledgePacket, type DemandKnowledgeBinding } from '../server/data/approved-knowledge';
import { evaluateKnowledgeGate } from '../server/providers/evaluation-knowledge-gate';
import { buildEvaluationUnits } from '../server/providers/evaluation-turns';
import { buildEvaluationClusterInputs, EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint, type EvaluationClusterCheckpoint } from '../server/providers/evaluation-input';
import { evaluateSession, finalizeSessionEvaluation } from '../server/providers/openai';
import { createReviewedEvaluationKnowledgeContext, prepareApprovedKnowledgeCli } from '../scripts/prepare-approved-knowledge';
import { enqueueReviewedKnowledgeEvaluation, runEvaluationWorkerOnce } from '../server/evaluation-worker';
import { EvaluationJobStore } from '../server/evaluation-job-store';
import { LocalSessionStore } from '../server/storage/local-session-store';
import { createSessionRuntime } from '../server/session-runtime';
import { knowledgeSpan, reviewedKnowledgeBundle, reviewedRecordEvaluationFixture, sealKnowledge,
  syntheticKnowledgeApproval } from './fixtures/reviewed-evaluation-knowledge';

const rawContext = { school: { schoolReferenceId: 'explicit-synthetic-school' }, evaluationGuidelines: '합성 평가 규칙',
  manifest: { files: [], recordIds: {}, rulesVersion: 'synthetic-engine' },
  student: { evidence: [{ id: 'record-1', text: '측정 탐구를 진행함.', scientificTruthVerification: 'not_independently_verified' }] },
} as unknown as InterviewContext;
function fixture(primary = 'PROCESS') {
  const source = { id: 'synthetic-knowledge-session', status: 'ending', metrics: {}, turns: [{
    id: 'q0', questionKind: 'main', parentMainQuestionId: 'q0', questionText: '그 조건에서 물의 끓는점은 얼마인가요?', evidenceIds: [],
    answerId: 'answer-q0', rawTranscript: '1기압에서 물의 끓는점은 섭씨 100도입니다.', transcriptStatus: 'finalized',
    metadata: { primaryFunction: primary, questionIntent: '명시된 조건에서 끓는점을 확인한다.', targetEvidence: ['1기압에서 물의 끓는점'], depth: 'D1' },
  }], questionPresentations: [{ turnId: 'q0', rootTurnId: 'q0', questionKind: 'main', clockId: 'synthetic-clock', startedAtMs: 1, completedAtMs: 2 }],
  } as unknown as InterviewSession;
  return reviewedRecordEvaluationFixture(rawContext, source);
}
function packet(): ApprovedKnowledgePacket {
  const text = '합성 검토용 출처: 순수한 물은 1기압에서 섭씨 100도에서 끓는다.';
  return sealKnowledge({ version: APPROVED_KNOWLEDGE_VERSION, id: 'synthetic-water-packet', revision: 'reviewed-v1', approval: syntheticKnowledgeApproval,
    source: { id: 'synthetic-textbook', version: 'synthetic-edition-1', locator: 'explicit-synthetic-only:p1', text, textSha256: knowledgeHash(text) },
    sourceSpan: knowledgeSpan(text), assumptions: [{ id: 'pressure', text: '압력은 1기압이다.' }],
    excludedScopes: [{ id: 'mixture', text: '용질이 포함된 혼합물은 제외한다.' }] });
}
function objective(primary = 'PROCESS') {
  const value = fixture(primary), source = packet(), turn = value.session.turns[0];
  const prior = value.context.approvedKnowledge!.bindings[0];
  const { contentSha256: _hash, ...body } = prior; void _hash;
  const binding: DemandKnowledgeBinding = sealKnowledge({ ...body, scope: 'objective_accuracy_core' as const,
    claimCoverage: 'all_core_claims_reviewed' as const, packetRefs: [{ id: source.id, revision: source.revision, contentSha256: source.contentSha256 }],
    claimReviews: [{ sourceTurnId: turn.id, answerId: turn.answerId!, answerSha256: knowledgeHash(turn.rawTranscript!), claim: knowledgeSpan(turn.rawTranscript!),
      packetId: source.id, packetSha256: source.contentSha256, sourceSpanSha256: source.sourceSpan.sha256,
      assumptionReviews: [{ id: 'pressure', satisfied: true, reason: '실제 질문의 조건과 답변은 1기압이다.' }],
      excludedScopeReviews: [{ id: 'mixture', applies: false, reason: '명시 검토: 순수한 물에 관한 요구이다.' }],
      relation: 'supported' as const, isCoreToDemand: true, rationale: '조건이 일치하는 승인 발췌와 실제 원문 주장을 검토한 합성 입력이다.' }] });
  value.context.approvedKnowledge = reviewedKnowledgeBundle([source], [binding]);
  return value;
}
function resealBinding(value: ReturnType<typeof objective>, mutate: (binding: DemandKnowledgeBinding) => void) {
  const binding = structuredClone(value.context.approvedKnowledge!.bindings[0]); mutate(binding);
  const { contentSha256: _hash, ...body } = binding; void _hash;
  value.context.approvedKnowledge = reviewedKnowledgeBundle([...value.context.approvedKnowledge!.packets], [sealKnowledge(body)]);
}
function gate(value: ReturnType<typeof fixture>, quote = value.session.turns[0].rawTranscript) {
  return evaluateKnowledgeGate(value.context, value.session, buildEvaluationUnits(value.session).scoredUnits[0], quote);
}
function output(value: ReturnType<typeof fixture>, claimedError = false) {
  const axis = { anchor: 4, quote: value.session.turns[0].rawTranscript, rationale: '명시적인 합성 앵커 입력이다.' };
  return { summary: '합성 평가', languageClassifications: [], answers: [{ turnId: 'q0', status: 'SATISFIED', deferredReason: null,
    axes: { I: axis, A: axis, S: axis, R: axis, C: axis }, verifiedCoreError: claimedError, verifiedCoreErrorEvidence: '모델의 미승인 정오 주장',
    strengths: [], improvements: [], conflictNeedsReview: [], deliveryCoaching: [], strategyCoaching: [] }] };
}

test('missing reviewed scope remains unresolved for every label and model assertions cannot create scientific authority', () => {
  for (const primary of ['CONCEPT', 'PROCESS', 'TRANSFER', 'VERIFY_CLAIM']) {
    const value = fixture(primary); delete value.context.approvedKnowledge;
    assert.deepEqual(gate(value).holdReasons, ['KNOWLEDGE_SCOPE_APPROVAL_REQUIRED']);
    const result = finalizeSessionEvaluation(output(value, true), value.context, value.session).answers[0];
    assert.equal(result.score, null); assert.equal(result.verifiedCoreError, false);
    assert.ok(result.deferredReason?.includes('보류'));
  }
});

test('explicit record consistency scope scores without an external packet and CONCEPT does not force a knowledge gate', () => {
  for (const primary of ['CONCEPT', 'PROCESS', 'TRANSFER', 'VERIFY_CLAIM']) {
    const value = fixture(primary), before = JSON.stringify(value);
    assert.deepEqual(gate(value).holdReasons, []); assert.equal(gate(value).scientificTruthAuthority, 'none');
    const result = finalizeSessionEvaluation(output(value, true), value.context, value.session).answers[0];
    assert.equal(result.score, 100); assert.equal(result.verifiedCoreError, false);
    assert.equal(JSON.stringify(value), before);
    assert.equal(value.context.student.evidence[0].scientificTruthVerification, 'not_independently_verified');
  }
});

test('objective accuracy is allowed only with approved exact source, answer claim and matching reviewed conditions', () => {
  const value = objective(); assert.deepEqual(gate(value).holdReasons, []);
  assert.equal(gate(value).scientificTruthAuthority, 'explicit_reviewed_packet_and_claim');
  const result = finalizeSessionEvaluation(output(value, true), value.context, value.session).answers[0];
  assert.equal(result.score, 100); assert.equal(result.verifiedCoreError, false);
  const input = buildEvaluationClusterInputs(value.context, value.session)[0].answers[0].knowledge;
  assert.equal(input.packets[0].source.text, packet().source.text); assert.equal(input.binding!.contentSha256, gate(value).bindingSha256);
});

test('objective missing packet, unapproved source, unresolved scope and conflicting approvals hold rather than downgrade to experience', () => {
  const missing = objective(); resealBinding(missing, binding => { binding.packetRefs = []; });
  assert.deepEqual(gate(missing).holdReasons, ['APPROVED_KNOWLEDGE_SOURCE_UNAVAILABLE']);
  const pending = objective(), source = structuredClone(packet()); source.approval.status = 'pending';
  const { contentSha256: _hash, ...sourceBody } = source; void _hash;
  const unapproved = sealKnowledge(sourceBody);
  resealBinding(pending, binding => { binding.packetRefs[0].contentSha256 = unapproved.contentSha256; binding.claimReviews[0].packetSha256 = unapproved.contentSha256; });
  pending.context.approvedKnowledge = reviewedKnowledgeBundle([unapproved], [...pending.context.approvedKnowledge!.bindings]);
  assert.deepEqual(gate(pending).holdReasons, ['APPROVED_KNOWLEDGE_SOURCE_UNAVAILABLE']);
  const unresolved = fixture(); resealBinding(unresolved, binding => { binding.scope = 'unresolved'; });
  assert.deepEqual(gate(unresolved).holdReasons, ['KNOWLEDGE_SCOPE_UNRESOLVED']);
  const conflict = objective(), second = structuredClone(conflict.context.approvedKnowledge!.bindings[0]);
  second.id += '-conflict'; const { contentSha256: _second, ...secondBody } = second; void _second;
  conflict.context.approvedKnowledge = reviewedKnowledgeBundle([...conflict.context.approvedKnowledge!.packets], [...conflict.context.approvedKnowledge!.bindings, sealKnowledge(secondBody)]);
  assert.deepEqual(gate(conflict).holdReasons, ['APPROVED_KNOWLEDGE_BINDING_CONFLICT']);
});

test('tampered source/hash/span, changed question contract and changed captured claim never retain approval', () => {
  const badHash = objective(), registry = structuredClone(badHash.context.approvedKnowledge!); registry.packets[0].source.text += ' 변조';
  badHash.context.approvedKnowledge = registry; assert.deepEqual(gate(badHash).holdReasons, ['APPROVED_KNOWLEDGE_REGISTRY_INVALID']);
  const changedQuestion = objective(); changedQuestion.session.turns[0].questionText += ' 추가 요구';
  assert.deepEqual(gate(changedQuestion).holdReasons, ['APPROVED_KNOWLEDGE_DEMAND_BINDING_CHANGED']);
  const changedAnswer = objective(); changedAnswer.session.turns[0].rawTranscript += ' 다른 조건';
  assert.deepEqual(gate(changedAnswer).holdReasons, ['APPROVED_KNOWLEDGE_DEMAND_BINDING_CHANGED']);
  const changedContract = objective(); changedContract.session.turns[0].metadata.targetEvidence = ['바뀐 요구'];
  assert.deepEqual(gate(changedContract).holdReasons, ['APPROVED_KNOWLEDGE_DEMAND_BINDING_CHANGED']);
  const badSpan = objective(); resealBinding(badSpan, binding => { binding.claimReviews[0].claim.start = 1; });
  assert.deepEqual(gate(badSpan).holdReasons, ['APPROVED_KNOWLEDGE_CLAIM_BINDING_CHANGED']);
  const otherScope = objective(); resealBinding(otherScope, binding => { binding.claimReviews[0].excludedScopeReviews[0].applies = true; });
  assert.deepEqual(gate(otherScope).holdReasons, ['APPROVED_KNOWLEDGE_SCOPE_NOT_ESTABLISHED']);
  const uncertain = objective(); resealBinding(uncertain, binding => { binding.claimReviews[0].assumptionReviews[0].satisfied = null; });
  assert.deepEqual(gate(uncertain).holdReasons, ['APPROVED_KNOWLEDGE_SCOPE_NOT_ESTABLISHED']);
});

test('only an approved exact core contradiction enables the 59 cap and conflicting claim reviews are held', () => {
  const value = objective('CONCEPT'); value.session.turns[0].rawTranscript = '1기압에서 물의 끓는점은 섭씨 90도입니다.';
  resealBinding(value, binding => {
    binding.sessionQuestionAnswerSha256 = knowledgeSessionQuestionAnswerHash(value.session);
    binding.claimReviews[0].answerSha256 = knowledgeHash(value.session.turns[0].rawTranscript!);
    binding.claimReviews[0].claim = knowledgeSpan(value.session.turns[0].rawTranscript!);
    binding.claimReviews[0].relation = 'contradicted';
  });
  const scored = output(value, false); scored.answers[0].axes.A = { ...scored.answers[0].axes.A, anchor: 0 };
  const result = finalizeSessionEvaluation(scored, value.context, value.session).answers[0];
  assert.equal(result.verifiedCoreError, true); assert.ok('cap' in result); assert.equal(result.cap, 59); assert.equal(result.score, 59);
  assert.ok('rawScore' in result); assert.equal(result.rawScore, 60); assert.equal(result.axes?.A.anchor, 0);
  assert.ok(result.verifiedCoreErrorEvidence?.startsWith('reviewed-claim:'));
  resealBinding(value, binding => { binding.claimReviews.push({ ...structuredClone(binding.claimReviews[0]), relation: 'supported' }); });
  assert.deepEqual(gate(value).holdReasons, ['APPROVED_KNOWLEDGE_CLAIM_CONFLICT']);
});

test('an approved exact core contradiction conflicts with a positive model A anchor and holds without rewriting that anchor', () => {
  const value = objective('CONCEPT'); value.session.turns[0].rawTranscript = '1기압에서 물의 끓는점은 섭씨 90도입니다.';
  resealBinding(value, binding => {
    binding.sessionQuestionAnswerSha256 = knowledgeSessionQuestionAnswerHash(value.session);
    binding.claimReviews[0].answerSha256 = knowledgeHash(value.session.turns[0].rawTranscript!);
    binding.claimReviews[0].claim = knowledgeSpan(value.session.turns[0].rawTranscript!);
    binding.claimReviews[0].relation = 'contradicted';
  });
  for (const anchor of [1, 4]) {
    const model = output(value, false); model.answers[0].axes.A = { ...model.answers[0].axes.A, anchor };
    const result = finalizeSessionEvaluation(model, value.context, value.session).answers[0];
    assert.equal(result.status, 'NOT_EVALUABLE'); assert.equal(result.score, null); assert.equal(result.grade, null);
    assert.ok(result.holdReasons.includes('KNOWLEDGE_A_ANCHOR_CONFLICT')); assert.equal(result.axes?.A.anchor, anchor);
    assert.equal(result.verifiedCoreError, true); assert.ok(result.deferredReason?.includes('앵커'));
  }
});

test('A evidence outside an approved claim and a dynamically created F without its own binding remain held', () => {
  const value = objective(); resealBinding(value, binding => { binding.claimReviews[0].claim = knowledgeSpan(value.session.turns[0].rawTranscript!, 0, 3); });
  assert.deepEqual(gate(value).holdReasons, ['APPROVED_KNOWLEDGE_A_EVIDENCE_UNREVIEWED']);
  const followup = fixture(), added = structuredClone(followup.session.turns[0]);
  added.id = 'f1'; added.questionKind = 'follow_up'; added.answerId = 'answer-f1'; added.questionText = '새 조건에서 결과는 무엇인가요?';
  followup.session.turns.push(added);
  const fUnit = buildEvaluationUnits(followup.session).scoredUnits.find(unit => unit.turn.id === 'f1')!;
  assert.deepEqual(evaluateKnowledgeGate(followup.context, followup.session, fUnit).holdReasons, ['KNOWLEDGE_SCOPE_APPROVAL_REQUIRED']);
});

test('knowledge bytes and scope approval affect source fingerprint and prevent checkpoint reuse without extra evaluation calls', async () => {
  const value = objective(), baseline = evaluationSessionSourceFingerprint(value.context, value.session);
  const saved: EvaluationClusterCheckpoint[] = [];
  await evaluateSession(value.context, value.session, { requestEvaluation: async () => output(value), onClusterComplete: checkpoint => { saved.push(checkpoint); } });
  assert.equal(saved[0].version, EVALUATION_PIPELINE_VERSION);
  resealBinding(value, binding => { binding.reason += ' 검토 설명이 갱신됨'; });
  assert.notEqual(evaluationSessionSourceFingerprint(value.context, value.session), baseline);
  let calls = 0;
  const evaluated = await evaluateSession(value.context, value.session, { resumeClusters: saved,
    requestEvaluation: async () => { calls++; return output(value); } });
  assert.equal(calls, 1); assert.ok('evaluationPipeline' in evaluated); assert.equal(evaluated.evaluationPipeline.reusedClusters, 0);
});

test('reviewed preparation CLI rejects missing/foreign authority and pins an immutable ended context without inventing approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'explicit-knowledge-cli-'));
  try {
    await assert.rejects(prepareApprovedKnowledgeCli([], root), /REVIEWED_INPUT_AND_REVIEWER_REQUIRED/u);
    await assert.rejects(prepareApprovedKnowledgeCli(['--unknown'], root), /ARGUMENT_UNKNOWN/u);
    await assert.rejects(prepareApprovedKnowledgeCli(['--reviewer', 'one', '--reviewer', 'two'], root), /ARGUMENT_DUPLICATED/u);
    const value = objective(); value.session.runtime = createSessionRuntime(rawContext, { id: 'explicit-synthetic-cli-owner', mode: 'local-development' });
    const before = JSON.stringify(value), bundle = value.context.approvedKnowledge!;
    await writeFile(join(root, 'reviewed.json'), JSON.stringify(bundle));
    await writeFile(join(root, 'session.json'), JSON.stringify(value.session));
    await writeFile(join(root, 'context.json'), JSON.stringify(rawContext));
    await assert.rejects(prepareApprovedKnowledgeCli(['--reviewed-input', 'reviewed.json', '--reviewer', 'not-the-reviewer'], root), /AUTHORITY_MISMATCH/u);
    assert.deepEqual((await readdir(root)).sort(), ['context.json', 'reviewed.json', 'session.json']);
    const result = await prepareApprovedKnowledgeCli(['--reviewed-input', 'reviewed.json', '--reviewer', syntheticKnowledgeApproval.approverId,
      '--session-input', 'session.json', '--context-input', 'context.json', '--model', 'explicit-synthetic-cli-model'], root);
    assert.equal(result.providerCalls, 0); assert.equal(result.scientificTruthIndependentlyVerified, false);
    assert.equal(result.originalSessionModified, false); assert.deepEqual(result.heldTurns, []);
    assert.equal(JSON.parse(await readFile(join(root, result.revisionPath), 'utf8')).contentSha256, bundle.contentSha256);
    assert.equal(result.preparationScope, 'explicit_ended_evaluation_context');
    const pinned = JSON.parse(await readFile(join(root, result.evaluationContextPath!), 'utf8'));
    assert.equal(pinned.context.approvedKnowledge.contentSha256, bundle.contentSha256);
    assert.equal(pinned.contextSha256, knowledgeHash(JSON.stringify(pinned.context)));
    assert.equal(pinned.sourceSha256, evaluationSessionSourceFingerprint(pinned.context, value.session, 'explicit-synthetic-cli-model'));
    assert.equal(JSON.stringify(value), before);
    assert.equal(parseApprovedKnowledgeBundle(pinned.context.approvedKnowledge).packets.length, 1);
  } finally { assert.ok(root.startsWith(join(tmpdir(), 'explicit-knowledge-cli-'))); await rm(root, { recursive: true, force: true }); }
});

test('a reviewed ended evaluation pins a new immutable worker context and job while leaving original session and evaluation bytes intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'explicit-knowledge-worker-'));
  try {
    const value = objective();
    value.session.runtime = createSessionRuntime(rawContext, { id: 'explicit-synthetic-owner', mode: 'local-development' });
    Object.assign(value.session, { evaluation: { summary: '과거 평가본은 그대로 보존한다.' } });
    const original = JSON.stringify(value.session), originalContext = JSON.stringify(rawContext);
    await writeFile(join(root, 'original-session.json'), original);
    const approved = createReviewedEvaluationKnowledgeContext(rawContext, value.session, value.context.approvedKnowledge!, {
      path: 'explicit-synthetic-reviewed-packet.json', fileSha256: 'a'.repeat(64) });
    const jobs = new EvaluationJobStore(join(root, 'jobs')), sessions = new LocalSessionStore(join(root, 'sessions'));
    await sessions.saveContext(rawContext, value.session.runtime.owner.id);
    const queued = await enqueueReviewedKnowledgeEvaluation(approved.context, value.session, { jobs, sessions, model: 'explicit-synthetic-model' });
    assert.equal(queued.job.pipelineVersion, EVALUATION_PIPELINE_VERSION);
    assert.notEqual(queued.contextSnapshotSha256, value.session.runtime.contextSnapshotSha256);
    const snapshot = await jobs.snapshot(queued.job);
    assert.equal(snapshot.contextSnapshotSha256, queued.contextSnapshotSha256);
    assert.equal(snapshot.session.runtime!.contextSnapshotSha256, queued.contextSnapshotSha256);
    const pinned = await sessions.loadContext(queued.contextSnapshotSha256, value.session.runtime.owner.id);
    assert.equal(pinned.approvedKnowledge!.contentSha256, value.context.approvedKnowledge!.contentSha256);
    let calls = 0;
    const completed = await runEvaluationWorkerOnce({ jobs, sessions,
      evaluate: (context, session, options) => evaluateSession(context, session, { ...options,
        requestEvaluation: async () => { calls++; return output(value); } }) });
    assert.equal(completed.job!.status, 'completed'); assert.equal(calls, 1);
    assert.equal(JSON.stringify(value.session), original); assert.equal(JSON.stringify(rawContext), originalContext);
    assert.equal(await readFile(join(root, 'original-session.json'), 'utf8'), original);
    const stored = await jobs.result(completed.job!);
    assert.equal((stored!.evaluation as { answers: Array<{ score: number }> }).answers[0].score, 100);
    await writeFile(join(root, 'reviewed.json'), JSON.stringify(value.context.approvedKnowledge));
    await writeFile(join(root, 'context.json'), originalContext);
    await new LocalSessionStore(join(root, 'data', 'sessions')).saveContext(rawContext, value.session.runtime.owner.id);
    const cli = await prepareApprovedKnowledgeCli(['--reviewed-input', 'reviewed.json', '--reviewer', syntheticKnowledgeApproval.approverId,
      '--session-input', 'original-session.json', '--context-input', 'context.json', '--enqueue', '--model', 'explicit-synthetic-cli-worker-model'], root);
    assert.ok(cli.evaluationJobId); assert.ok(cli.contextSnapshotSha256);
    const cliJobs = new EvaluationJobStore(join(root, 'data', 'evaluation-jobs')), cliJob = (await cliJobs.get(cli.evaluationJobId))!;
    assert.equal(cliJob.contextSnapshotSha256, cli.contextSnapshotSha256);
    assert.equal(cliJob.sourceSha256, cli.evaluationSourceSha256);
    assert.equal(cliJob.model, 'explicit-synthetic-cli-worker-model');
    assert.equal((await cliJobs.snapshot(cliJob)).session.runtime!.contextSnapshotSha256, cli.contextSnapshotSha256);
    assert.equal(await readFile(join(root, 'original-session.json'), 'utf8'), original);
    const changed = objective(); resealBinding(changed, binding => { binding.reason += ' 새 검토본'; });
    const second = await enqueueReviewedKnowledgeEvaluation(changed.context, value.session, { jobs, sessions, model: 'explicit-synthetic-model' });
    assert.notEqual(second.job.id, queued.job.id);
    resealBinding(changed, binding => { binding.reason += ' pin 후 변경'; });
    let unboundCalls = 0;
    const rejected = await runEvaluationWorkerOnce({ jobs, sessions, loadContext: async () => changed.context,
      evaluate: async (...args) => { unboundCalls++; return evaluateSession(...args); } });
    assert.equal(rejected.job!.status, 'failed'); assert.equal(unboundCalls, 0);
    assert.ok(rejected.job!.error!.message.includes('EVALUATION_INPUT_SOURCE_CHANGED'));
  } finally { assert.ok(root.startsWith(join(tmpdir(), 'explicit-knowledge-worker-'))); await rm(root, { recursive: true, force: true }); }
});


test('reviewed preparation rejects a different base context before publishing any immutable output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'explicit-knowledge-base-pin-'));
  try {
    const value = objective(); value.session.runtime = createSessionRuntime(rawContext, { id: 'explicit-synthetic-base-owner', mode: 'local-development' });
    const altered = structuredClone(rawContext); altered.evaluationGuidelines += ' 승인하지 않은 다른 평가 규칙';
    assert.throws(() => createReviewedEvaluationKnowledgeContext(altered, value.session, value.context.approvedKnowledge!, {
      path: 'synthetic-reviewed.json', fileSha256: 'a'.repeat(64) }), /APPROVED_KNOWLEDGE_BASE_CONTEXT_CHANGED/u);
    await writeFile(join(root, 'reviewed.json'), JSON.stringify(value.context.approvedKnowledge));
    await writeFile(join(root, 'session.json'), JSON.stringify(value.session));
    await writeFile(join(root, 'wrong-context.json'), JSON.stringify(altered));
    await assert.rejects(prepareApprovedKnowledgeCli(['--reviewed-input', 'reviewed.json', '--reviewer', syntheticKnowledgeApproval.approverId,
      '--session-input', 'session.json', '--context-input', 'wrong-context.json', '--enqueue'], root), /APPROVED_KNOWLEDGE_BASE_CONTEXT_CHANGED/u);
    assert.deepEqual((await readdir(root)).sort(), ['reviewed.json', 'session.json', 'wrong-context.json']);
  } finally { assert.ok(root.startsWith(join(tmpdir(), 'explicit-knowledge-base-pin-'))); await rm(root, { recursive: true, force: true }); }
});

test('reviewed enqueue verifies the original stored context and rejects non-knowledge changes despite an unchanged engine and valid bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'explicit-knowledge-derivation-'));
  try {
    const value = objective(); value.session.runtime = createSessionRuntime(rawContext, { id: 'explicit-synthetic-derivation-owner', mode: 'local-development' });
    const jobs = new EvaluationJobStore(join(root, 'jobs')), sessions = new LocalSessionStore(join(root, 'sessions'));
    const original = JSON.stringify(value.session);
    await sessions.saveContext(rawContext, value.session.runtime.owner.id);
    const approved = createReviewedEvaluationKnowledgeContext(rawContext, value.session, value.context.approvedKnowledge!, {
      path: 'explicit-synthetic-reviewed.json', fileSha256: 'a'.repeat(64) });
    const mutations: Array<(context: InterviewContext) => void> = [
      context => { context.evaluationGuidelines += ' 변경된 평가 기준'; },
      context => { context.student.evidence[0].text += ' 학생 기록에 없던 수행'; },
      context => { context.school.schoolReferenceId += '-foreign'; },
      context => { context.manifest.recordIds.approvedEvaluationKnowledgeSha256 = 'b'.repeat(64); },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(approved.context); mutate(changed);
      await assert.rejects(enqueueReviewedKnowledgeEvaluation(changed, value.session, { jobs, sessions, model: 'explicit-synthetic-model' }),
        /APPROVED_KNOWLEDGE_(?:BASE_CONTEXT_CHANGED|CONTEXT_DERIVATION_INVALID)/u);
    }
    assert.deepEqual(await jobs.pending(), []); assert.equal(JSON.stringify(value.session), original);
    assert.equal(JSON.stringify(await sessions.loadContext(value.session.runtime.contextSnapshotSha256, value.session.runtime.owner.id)), JSON.stringify(rawContext));
    assert.equal((await readdir(join(root, 'session-contexts'))).length, 1, 'rejected derivations publish no new context');
  } finally { assert.ok(root.startsWith(join(tmpdir(), 'explicit-knowledge-derivation-'))); await rm(root, { recursive: true, force: true }); }
});
