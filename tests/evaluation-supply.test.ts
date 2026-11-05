import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareEndedSessionReview, supplyReviewedSessionEvaluation } from '../server/evaluation-supply';
import { knowledgeSessionQuestionAnswerHash } from '../server/data/approved-knowledge';
import { buildEvaluationUnits } from '../server/providers/evaluation-turns';
import { evaluateKnowledgeGate } from '../server/providers/evaluation-knowledge-gate';
import { aggregateSessionEvaluation } from '../server/providers/evaluation-aggregation';
import { evaluateSession, finalizeSessionEvaluation } from '../server/providers/openai';
import { runEvaluationWorkerOnce } from '../server/evaluation-worker';
import { EvaluationJobStore } from '../server/evaluation-job-store';
import { LocalSessionStore } from '../server/storage/local-session-store';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from '../server/providers/evaluation-input';
import { publishBankScopeReview, sealBankScopeRegistry } from '../server/data/evaluation-scope-registry';
import { approveQuestionContract, bindQuestionContractToTurn } from '../server/question-objective';
import { prepareApprovedKnowledgeCli } from '../scripts/prepare-approved-knowledge';
import { sealKnowledge, reviewedKnowledgeBundle } from './fixtures/reviewed-evaluation-knowledge';
import { evaluationSupplyFixture, mutateSupplyBinding, pinSupplySnapshot, reviewedSupplyRegistry, signSupplyReceipt,
  supplyObjectiveBundle, supplyRecordBundle, supplyReviewer, supplySigner } from './fixtures/evaluation-supply';

async function directory(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'evaluation-supply-contract-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('evaluation-supply-contract-')); await rm(root, { recursive: true, force: true }); });
  return root;
}
function gate(value: Awaited<ReturnType<typeof evaluationSupplyFixture>>, index = 0, quote?: string) {
  return evaluateKnowledgeGate(value.context, value.session, buildEvaluationUnits(value.session).scoredUnits[index], quote);
}
function withBundle(value: Awaited<ReturnType<typeof evaluationSupplyFixture>>, bundle = supplyRecordBundle(value.session)) {
  value.context.approvedKnowledge = bundle; return value;
}
function modelOutput(value: Awaited<ReturnType<typeof evaluationSupplyFixture>>, aQuote?: string) {
  return { summary: '명시적인 합성 평가', languageClassifications: [], answers: buildEvaluationUnits(value.session).scoredUnits.map(unit => {
    const quote = unit.answerAttempts[0].rawTranscript, axis = { anchor: 4, quote, rationale: '실제 확정 답변의 범위 안에서만 판단하는 합성 결과다.' };
    return { turnId: unit.turn.id, status: 'SATISFIED', deferredReason: null,
      axes: { I: axis, A: { ...axis, quote: aQuote ?? quote }, S: axis, R: axis, C: axis }, verifiedCoreError: false,
      verifiedCoreErrorEvidence: null, strengths: [], improvements: [], conflictNeedsReview: [], deliveryCoaching: [], strategyCoaching: [] };
  }) };
}
function reviewedInput(value: Awaited<ReturnType<typeof evaluationSupplyFixture>>, scientific = false, signer?: ReturnType<typeof supplySigner>, onlyFirst = false) {
  const registry = reviewedSupplyRegistry(value);
  value.context.evaluationScopeRegistry = registry; pinSupplySnapshot(value.context, value.session);
  const proposal = prepareEndedSessionReview(value.context, value.session, registry);
  const bundle = scientific ? supplyObjectiveBundle(value.session) : supplyRecordBundle(value.session, onlyFirst ? [value.turn] : value.session.turns);
  const payload = { version: 'authenticated-session-evaluation-review-v1', actorId: supplyReviewer,
    action: 'approve_session_evaluation', proposalSha256: proposal.contentSha256, bundleSha256: bundle.contentSha256,
    sessionId: value.session.id, sessionQuestionAnswerSha256: knowledgeSessionQuestionAnswerHash(value.session),
    contextSnapshotSha256: value.session.runtime!.contextSnapshotSha256,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const signed = signer ? { trustedPublicKey: signer.trustedPublicKey, receipt: signer.receipt(payload) } : signSupplyReceipt(payload);
  return { ...value, registry, currentRegistry: registry, proposal, bundle, ...signed };
}

async function queuedAuthenticated(t: { after(fn: () => void | Promise<void>): void }, root: string, partialFollowUp = false) {
  const signer = supplySigner(), value = reviewedInput(await evaluationSupplyFixture({ followUp: partialFollowUp }), false, signer, partialFollowUp);
  const priorKey = process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY;
  process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY = signer.trustedPublicKey;
  t.after(() => { if (priorKey === undefined) delete process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY; else process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY = priorKey; });
  const registryReceipt = (sha: string) => signer.receipt({ version: 'authenticated-bank-scope-review-v1', actorId: supplyReviewer,
    registrySha256: sha, action: 'publish_scopes', issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await publishBankScopeReview(value.registry, value.context, value.bank, registryReceipt(value.registry.contentSha256), null, root, signer.trustedPublicKey);
  const sessions = new LocalSessionStore(path.join(root, 'data/sessions')), jobs = new EvaluationJobStore(path.join(root, 'data/evaluation-jobs'));
  await sessions.saveContext(value.context, value.session.runtime!.owner.id); await sessions.save(value.session);
  const supplied = await supplyReviewedSessionEvaluation({ ...value, root, enqueue: true, model: 'synthetic-evaluation-only' });
  const withdraw = async () => {
    const { contentSha256: ignored, ...body } = structuredClone(value.registry); void ignored;
    body.entries[0].review = { status: 'withdrawn', authority: 'explicit_reviewed_input', approverId: supplyReviewer,
      reviewedAt: new Date().toISOString(), reason: '명시적인 합성 승인 철회 사건이다.' };
    const changed = sealBankScopeRegistry(body);
    await publishBankScopeReview(changed, value.context, value.bank, registryReceipt(changed.contentSha256), value.registry.contentSha256, root, signer.trustedPublicKey);
  };
  return { value, jobs, sessions, supplied, withdraw };
}

test('EV-01/EV-02 approved ROLE question without an exact scope remains held and never produces a number', async () => {
  const value = await evaluationSupplyFixture();
  assert.ok(value.turn.metadata.approvedQuestion); assert.equal(value.turn.metadata.primaryFunction, 'ROLE');
  assert.deepEqual(gate(value).holdReasons, ['KNOWLEDGE_SCOPE_APPROVAL_REQUIRED']);
  const evaluated = finalizeSessionEvaluation(modelOutput(value), value.context, value.session).answers[0];
  assert.equal(evaluated.score, null); assert.equal(evaluated.status, 'NOT_EVALUABLE');
});

test('EV-01 ordinary worker parks missing approval as review_required without model retries', async t => {
  const root = await directory(t), value = await evaluationSupplyFixture();
  const jobs = new EvaluationJobStore(path.join(root, 'jobs')), sessions = new LocalSessionStore(path.join(root, 'sessions'));
  await sessions.saveContext(value.context, value.session.runtime!.owner.id); await sessions.save(value.session);
  const job = await jobs.enqueue(value.session, evaluationSessionSourceFingerprint(value.context, value.session), EVALUATION_PIPELINE_VERSION);
  let calls = 0;
  const result = await runEvaluationWorkerOnce({ jobs, sessions, evaluate: async () => { calls++; throw new Error('Unreviewed input must not reach a model'); } });
  assert.equal(calls, 0); assert.equal(result.job?.id, job.id); assert.equal(result.job?.status, 'review_required');
  assert.equal((await runEvaluationWorkerOnce({ jobs, sessions, evaluate: async () => { calls++; throw new Error('No repeated review-wait work'); } })).processed, false);
  assert.equal(calls, 0);
});

test('EV-03/EV-04 one changed question character, approval contract or manifest cannot reuse the prior session approval', async () => {
  const value = withBundle(await evaluationSupplyFixture());
  assert.deepEqual(gate(value).holdReasons, []);
  for (const change of [
    (copy: typeof value) => { copy.turn.questionText += '?'; },
    (copy: typeof value) => { copy.turn.metadata.approvedQuestion!.semanticContractSha256 = 'f'.repeat(64); },
  ]) { const copy = structuredClone(value); change(copy); assert.ok(gate(copy).holdReasons.some(reason => /CHANGED|INVALID/.test(reason))); }
  const supplied = reviewedInput(await evaluationSupplyFixture());
  const changed = structuredClone(supplied.context); changed.manifest.rulesVersion += '-changed';
  await assert.rejects(supplyReviewedSessionEvaluation({ ...supplied, context: changed, enqueue: false }));
});

test('EV-05 a reviewed exact Q0 specification is not actual frozen-session binding approval', async () => {
  const value = reviewedInput(await evaluationSupplyFixture());
  assert.equal(value.registry.entries[0].review.status, 'approved');
  assert.ok(gate(value).holdReasons.includes('KNOWLEDGE_SCOPE_APPROVAL_REQUIRED'));
  assert.equal(value.proposal.sessionQuestionAnswerSha256, knowledgeSessionQuestionAnswerHash(value.session));
  assert.equal('approverId' in value.proposal, false);
  await assert.rejects(supplyReviewedSessionEvaluation({ ...value, receipt: null, enqueue: false }), /RECEIPT|AUTHENTICATED|expected object/);
});

test('EV-04 a valid new approval contract with the same semantic hash still requires a newly reviewed specification', async () => {
  const value = reviewedInput(await evaluationSupplyFixture()), prior = value.turn.metadata.approvedQuestion!;
  const draft = value.bank.slots[0].candidates[0].draft;
  value.turn.metadata.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint!, { policyDigest: 'changed-synthetic-question-policy' });
  assert.equal(value.turn.metadata.approvedQuestion.semanticContractSha256, prior.semanticContractSha256);
  assert.notEqual(value.turn.metadata.approvedQuestion.contentSha256, prior.contentSha256);
  const next = prepareEndedSessionReview(value.context, value.session, value.registry);
  assert.equal(next.units[0].specification, null);
  assert.ok(next.units[0].holdReasons.includes('QUESTION_EVALUATION_SPEC_APPROVAL_REQUIRED'));
});

test('exact deterministic bank-to-turn rebinding preserves specification eligibility without reusing its session approval', async () => {
  const value = reviewedInput(await evaluationSupplyFixture()), originalId = value.turn.id;
  const draft = value.bank.slots[0].candidates[0].draft, nextId = 'synthetic-rebased-runtime-turn';
  const rebound = bindQuestionContractToTurn(draft, value.context, { ...value.session, turns: [] }, nextId);
  value.turn.id = nextId; value.turn.parentMainQuestionId = nextId;
  Object.assign(value.turn.metadata, rebound, { questionClusterId: nextId });
  value.session.questionPresentations = value.session.questionPresentations!.map(row => row.turnId === originalId ? { ...row, turnId: nextId, rootTurnId: nextId } : { ...row });
  const proposed = prepareEndedSessionReview(value.context, value.session, value.registry);
  assert.equal(proposed.units[0].specification?.evaluationSpecId, value.registry.entries[0].evaluationSpecId);
  assert.deepEqual(proposed.units[0].holdReasons, []);
  assert.ok(gate(value).holdReasons.length, 'eligible pre-spec still does not approve this rebased session');
});

test('real-shaped manifest plan tolerates current slot history changes while pool identity changes are rejected', async () => {
  const value = reviewedInput(await evaluationSupplyFixture());
  const plan = { ...value.session.plan, slots: [{ id: 'first' }, { id: 'second' }], policyVersion: 'synthetic-plan-policy',
    selectionPolicyVersion: 'synthetic-selection-policy', durationSeconds: 600, purpose: 'mock', mode: 'mock',
    selectionContext: { scope: { ownerId: value.session.runtime!.owner.id, target: 'synthetic-target' }, lastSelection: null as unknown } };
  value.session.plan = plan as unknown as typeof value.session.plan;
  value.session.sourceManifest = { ...value.context.manifest, interviewPlan: structuredClone(plan) } as typeof value.session.sourceManifest;
  assert.doesNotThrow(() => prepareEndedSessionReview(value.context, value.session, value.registry));
  plan.slots.reverse(); plan.selectionContext.lastSelection = { selectedCandidateId: 'synthetic-recent-selection' };
  assert.doesNotThrow(() => prepareEndedSessionReview(value.context, value.session, value.registry));
  for (const field of ['poolKey', 'poolContentSha256'] as const) {
    const changed = structuredClone(value.session); changed.plan![field] = '0'.repeat(64);
    assert.throws(() => prepareEndedSessionReview(value.context, changed, value.registry), /MANIFEST_CHANGED/);
  }
});

test('EV-06 authenticated exact record-consistency supply creates a separate context with no science authority or history mutation', async t => {
  const root = await directory(t), value = reviewedInput(await evaluationSupplyFixture()), original = JSON.stringify({ context: value.context, session: value.session });
  const result = await supplyReviewedSessionEvaluation({ ...value, root, enqueue: false });
  assert.notEqual(result.context, value.context); assert.deepEqual(result.decisions[0].holdReasons, []);
  assert.equal(result.decisions[0].scientificTruthAuthority, 'none');
  assert.equal(JSON.stringify({ context: value.context, session: value.session }), original);
  const scored = finalizeSessionEvaluation(modelOutput(value), result.context, value.session).answers[0];
  assert.equal(scored.score, 100); assert.equal(scored.verifiedCoreError, false);
});

test('EV-07/EV-08 packets without actual claim review and unmet assumptions/excluded scopes stay held', async () => {
  const value = await evaluationSupplyFixture({ scientific: true }), original = supplyObjectiveBundle(value.session);
  withBundle(value, original); assert.deepEqual(gate(value).holdReasons, []);
  for (const [mutate, expected] of [
    [(binding: typeof original.bindings[number]) => { binding.claimReviews = []; }, 'APPROVED_KNOWLEDGE_CLAIM_REVIEW_REQUIRED'],
    [(binding: typeof original.bindings[number]) => { binding.claimReviews[0].assumptionReviews[0].satisfied = false; }, 'APPROVED_KNOWLEDGE_SCOPE_NOT_ESTABLISHED'],
    [(binding: typeof original.bindings[number]) => { binding.claimReviews[0].excludedScopeReviews[0].applies = true; }, 'APPROVED_KNOWLEDGE_SCOPE_NOT_ESTABLISHED'],
  ] as const) { value.context.approvedKnowledge = mutateSupplyBinding(original, mutate); assert.deepEqual(gate(value).holdReasons, [expected]); }
});

test('EV-09/EV-15 an unreviewed F never inherits Q0 approval or disappears from the whole-cluster exclusion', async () => {
  const value = await evaluationSupplyFixture({ followUp: true });
  withBundle(value, supplyRecordBundle(value.session, [value.turn]));
  assert.deepEqual(gate(value, 0).holdReasons, []); assert.ok(gate(value, 1).holdReasons.length);
  const final = finalizeSessionEvaluation(modelOutput(value), value.context, value.session);
  assert.equal(final.answers.find(answer => answer.turnId === value.session.turns[1].id)!.score, null);
  const attemptsToDropF = aggregateSessionEvaluation(value.session, [{ turnId: value.turn.id, status: 'SATISFIED', score: 100 }]);
  assert.equal(attemptsToDropF.clusterScores[0].status, 'CLUSTER_NOT_EVALUABLE'); assert.equal(attemptsToDropF.clusterScores[0].score, null);
  assert.equal(attemptsToDropF.clusterScores[0].members.length, 2); assert.equal(attemptsToDropF.sessionScore, null);
});

test('EV-10 changing any finalized answer invalidates every old session-bound demand', async () => {
  const value = withBundle(await evaluationSupplyFixture({ followUp: true }));
  const before = knowledgeSessionQuestionAnswerHash(value.session);
  value.session.turns[1].rawTranscript += ' 정정';
  assert.notEqual(knowledgeSessionQuestionAnswerHash(value.session), before);
  assert.deepEqual(gate(value, 0).holdReasons, ['APPROVED_KNOWLEDGE_DEMAND_BINDING_CHANGED']);
  assert.deepEqual(gate(value, 1).holdReasons, ['APPROVED_KNOWLEDGE_DEMAND_BINDING_CHANGED']);
});

test('EV-11 approved supply cannot be copied to another owner or another session', async () => {
  const value = reviewedInput(await evaluationSupplyFixture());
  const otherSession = structuredClone(value.session); otherSession.id = 'synthetic-other-session';
  await assert.rejects(supplyReviewedSessionEvaluation({ ...value, session: otherSession, enqueue: false }));
  const otherOwner = structuredClone(value.session); otherOwner.runtime!.owner.id = 'synthetic-other-owner';
  await assert.rejects(supplyReviewedSessionEvaluation({ ...value, session: otherOwner, enqueue: false }));
});

test('EV-12 duplicate demand bindings conflict and a current registry withdrawal blocks the prior signed supply', async () => {
  const value = withBundle(await evaluationSupplyFixture()), first = value.context.approvedKnowledge!.bindings[0];
  const { contentSha256: ignored, ...body } = structuredClone(first); void ignored;
  value.context.approvedKnowledge = reviewedKnowledgeBundle([], [first, sealKnowledge({ ...body, id: body.id + '-duplicate' })]);
  assert.deepEqual(gate(value).holdReasons, ['APPROVED_KNOWLEDGE_BINDING_CONFLICT']);
  const supplied = reviewedInput(await evaluationSupplyFixture()), { contentSha256: ignoredRegistry, ...registryBody } = structuredClone(supplied.registry); void ignoredRegistry;
  registryBody.entries[0].review.status = 'withdrawn';
  const currentRegistry = sealBankScopeRegistry(registryBody);
  await assert.rejects(supplyReviewedSessionEvaluation({ ...supplied, currentRegistry, enqueue: false }), /WITHDRAWN|REVOKED|REGISTRY|CHANGED/);
});

test('EV-13 identical reviewed supply retries reuse one immutable evaluation job', async t => {
  const root = await directory(t), value = await queuedAuthenticated(t, root);
  const historyFile = path.join(root, 'data/sessions', `${value.value.session.id}.json`), before = await readFile(historyFile);
  const second = await supplyReviewedSessionEvaluation({ ...value.value, root, enqueue: true, model: 'synthetic-evaluation-only' });
  assert.equal(second.jobId, value.supplied.jobId); assert.deepEqual(await readFile(historyFile), before);
  for (const [file, content] of Object.entries({ 'bundle.json': value.value.bundle, 'context.json': value.value.context,
    'session.json': value.value.session, 'proposal.json': value.value.proposal, 'receipt.json': value.value.receipt })) {
    await writeFile(path.join(root, file), JSON.stringify(content));
  }
  const cli = await prepareApprovedKnowledgeCli(['--reviewed-input', 'bundle.json', '--reviewer', supplyReviewer,
    '--context-input', 'context.json', '--session-input', 'session.json', '--proposal-input', 'proposal.json',
    '--receipt', 'receipt.json', '--enqueue', '--model', 'synthetic-evaluation-only'], root);
  assert.equal(cli.authority, 'authenticated_exact_session_review'); assert.equal(cli.evaluationJobId, value.supplied.jobId);
  const job = (await value.jobs.get(value.supplied.jobId!))!;
  assert.equal((await value.jobs.snapshot(job)).session.runtime!.evaluationInputFrozenAt, value.value.session.runtime!.evaluationInputFrozenAt);
});

test('EV-06 authenticated A/B supply reaches the real ordinary worker and publishes only its exact reviewed answer', async t => {
  const root = await directory(t), value = await queuedAuthenticated(t, root); let calls = 0;
  const result = await runEvaluationWorkerOnce({ jobs: value.jobs, sessions: value.sessions,
    evaluate: (context, session, options) => evaluateSession(context, session, { ...options,
      requestEvaluation: async () => { calls++; return modelOutput({ ...value.value, context, session }); } }) });
  assert.equal(result.job?.id, value.supplied.jobId); assert.equal(result.job?.status, 'completed'); assert.equal(calls, 1);
  const stored = await value.jobs.result(result.job!);
  assert.equal((stored!.evaluation as { answers: Array<{ score: number }> }).answers[0].score, 100);
});

test('EV-09/EV-15 partial signed supply sends only approved Q0 to the model and retains held F in aggregation', async t => {
  const root = await directory(t), value = await queuedAuthenticated(t, root, true); let calls = 0;
  const result = await runEvaluationWorkerOnce({ jobs: value.jobs, sessions: value.sessions,
    evaluate: (context, session, options) => evaluateSession(context, session, { ...options, requestEvaluation: async request => {
      calls++; const input = JSON.parse(request.input);
      assert.deepEqual(input.answers.map((answer: { id: string }) => answer.id), [value.value.turn.id]);
      const output = modelOutput({ ...value.value, context, session });
      output.answers = output.answers.filter(answer => answer.turnId === value.value.turn.id); return output;
    } }) });
  assert.equal(result.job?.status, 'completed'); assert.equal(calls, 1);
  const evaluation = (await value.jobs.result(result.job!))!.evaluation as {
    answers: Array<{ turnId: string; score: number | null }>; sessionScore: number | null;
    clusterScores: Array<{ status: string; score: number | null }>; partialReport: boolean };
  assert.equal(evaluation.answers.length, 2); assert.equal(evaluation.answers.find(answer => answer.turnId === value.value.session.turns[1].id)!.score, null);
  assert.equal(evaluation.clusterScores[0].status, 'CLUSTER_NOT_EVALUABLE'); assert.equal(evaluation.clusterScores[0].score, null);
  assert.equal(evaluation.sessionScore, null); assert.equal(evaluation.partialReport, true);
});

for (const when of ['before', 'during'] as const) test(`EV-12 registry withdrawal ${when} worker evaluation prevents score publication`, async t => {
  const root = await directory(t), value = await queuedAuthenticated(t, root); let calls = 0;
  if (when === 'before') await value.withdraw();
  const result = await runEvaluationWorkerOnce({ jobs: value.jobs, sessions: value.sessions,
    evaluate: (context, session, options) => evaluateSession(context, session, { ...options,
      requestEvaluation: async () => { calls++; await value.withdraw(); return modelOutput({ ...value.value, context, session }); } }) });
  assert.equal(result.job?.status, 'review_required'); assert.equal(calls, when === 'before' ? 0 : 1);
  assert.equal(await value.jobs.result(result.job!), null);
});

test('EV-14 A-axis evidence outside the approved claim span is held after model output validation', async () => {
  const value = await evaluationSupplyFixture({ scientific: true }); withBundle(value, supplyObjectiveBundle(value.session));
  assert.deepEqual(gate(value).holdReasons, []);
  const outsideQuote = '그리고 자료를 정리했습니다.';
  assert.deepEqual(gate(value, 0, outsideQuote).holdReasons, ['APPROVED_KNOWLEDGE_A_EVIDENCE_UNREVIEWED']);
  const scored = finalizeSessionEvaluation(modelOutput(value, outsideQuote), value.context, value.session).answers[0];
  assert.equal(scored.score, null); assert.ok(scored.holdReasons.includes('APPROVED_KNOWLEDGE_A_EVIDENCE_UNREVIEWED'));
});
