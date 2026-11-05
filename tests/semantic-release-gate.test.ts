import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  assertSemanticIdentityWorkspace, canonicalJson, collectSemanticCandidate, createSemanticIdentity, hashSemanticOutcome,
  semanticHash, semanticReportSource, semanticRubricSchema, verifySemanticRelease as verifyGate, type SemanticCandidate, type SemanticReview, type SemanticReleaseIdentity, type SemanticReportSource,
} from '../scripts/lib/semantic-release-gate';
import { verifySemanticReleaseCli } from '../scripts/verify-semantic-release';
import { compareFollowupLatency, type FollowupLatencyReport } from '../scripts/lib/followup-latency-gate';

const hash = (value: unknown) => semanticHash(canonicalJson(value));
const sourceReports = new Map<string, SemanticReportSource>();
function verifySemanticRelease(candidate: SemanticCandidate, signed: unknown, options: Parameters<typeof verifyGate>[2] = {}) {
  return verifyGate(candidate, signed, { sourceReports: candidate.reports.map(source => sourceReports.get(source.sha256)!).filter(Boolean), ...options });
}
const models = { policyMode: 'compiled', core: { requestedModel: 'synthetic-core', responseModel: 'synthetic-core-001', reasoningEffort: 'low', maxOutputTokens: 2000 },
  factReview: { requestedModel: 'synthetic-review', responseModel: 'synthetic-review-001', reasoningEffort: 'none', maxOutputTokens: 500 },
  surfaceRepair: { requestedModel: 'synthetic-core', responseModel: 'synthetic-core-001', reasoningEffort: 'none', maxOutputTokens: 140 } };
const rubricInput = { schemaVersion: 1, version: 'synthetic-rubric-v1', requiredCoverage: ['missing-subpoint'], acceptedReviewProvenance: ['human'],
  cases: [{ caseId: 'synthetic-F1', repeats: 1, coverage: ['missing-subpoint'], expectedActions: ['FOLLOW_UP'], expectedCoverage: ['partial'], expectedResponse: ['answered'], followUpScope: '이미 답한 행동은 다시 묻지 않고 선택 기준 하나만 확인' }] };

async function fixture(t: TestContext, purpose: 'fixture' | 'release' = 'fixture', customRubric: unknown = rubricInput,
  customGold: unknown = { cases: [{ id: 'synthetic-F1', provenance: 'synthetic' }] }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'semantic-release-gate-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    // Only this task-owned, direct child of the temp directory can be removed.
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('semantic-release-gate-test-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const files = ['interview.config.ts', 'interview-files.mjs', 'package-lock.json', 'scripts/lib/semantic-release-gate.ts', 'scripts/lib/followup-latency-gate.ts', 'scripts/verify-semantic-release.ts',
    'scripts/evaluate-historical-dialogue-gold.ts', 'scripts/replay-actual-user-core.ts', 'scripts/replay-gold-surface-repairs.ts', 'scripts/live-demand-boundary-e2e.ts',
    'scripts/benchmark-latest-interview.ts', 'scripts/verify-followup-final-runtime.ts',
    'server/providers/single-core-contract.ts', 'server/providers/runtime-core-payload.ts', 'server/providers/runtime-core-scope.ts',
    'server/policy/compiled-runtime-policy.ts', 'server/policy/full-md-policy.ts'];
  for (const file of files) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'explicit-synthetic:' + file); }
  for (const [file, value] of Object.entries({ 'gold.json': customGold, 'rubric.json': customRubric, 'models.json': models, 'policy.json': { source: 'synthetic-policy' } }))
    await writeFile(path.join(root, file), JSON.stringify(value));
  const identity = await createSemanticIdentity(root, { gold: 'gold.json', rubric: 'rubric.json', modelConfig: 'models.json', policies: ['policy.json'], purpose });
  return { root, identity, rubric: semanticRubricSchema.parse(customRubric) };
}
function report(identity: SemanticReleaseIdentity, changes: Record<string, unknown> = {}) {
  const outcome = {
    caseId: 'synthetic-F1', repeat: 1, phase: 'final-runtime', inputSha256: hash({ question: '맡은 일은?', answer: '자료를 골랐습니다.' }), historySha256: hash([]),
    coreDecisionSha256: hash({ action: 'FOLLOW_UP', target: '선택 기준' }), finalQuestionSha256: semanticHash('자료를 고를 때 어떤 기준을 사용했나요?'), factualReviewSha256: hash({ status: 'approved' }),
    surfaceOrigin: 'core', executedAction: 'FOLLOW_UP', coverage: 'partial', response: 'answered', executionReady: true, structuralChecksPassed: true,
    models: [{ stage: 'core', ...models.core }, { stage: 'review', ...models.factReview }], ...changes,
  };
  const value = { version: 'semantic-release-report-v1', releaseKey: identity.releaseKey, engineSourceSha256: identity.engineSources, outcomes: [outcome] };
  const source = semanticReportSource('report.json', canonicalJson(value)); sourceReports.set(source.sha256, source); return { ...source, value };
}
function reviews(candidate: SemanticCandidate, changes: Partial<SemanticReview> = {}) {
  return { schemaVersion: 1, reviews: candidate.outcomes.map(outcome => ({
    releaseKey: candidate.identity.releaseKey, outcomeSha256: outcome.outcomeSha256, rubricSha256: candidate.identity.rubric.sha256,
    provenance: 'human', reviewer: 'explicit-synthetic-reviewer', reviewedAt: '2026-11-05T00:00:00Z',
    checks: { demandRelation: 'pass', answeredScopePreserved: 'pass', usefulSingleSubpoint: outcome.executedAction === 'FOLLOW_UP' ? 'pass' : 'not-applicable', refusalNegationCorrectionPreserved: 'pass',
      repairedMeaningPreserved: outcome.surfaceOrigin === 'repair' ? 'pass' : 'not-applicable', historyConsistency: 'pass' },
    note: 'Explicitly simulated review; no human signoff or model call occurred in this test.', ...changes,
  })) };
}
function latencyReceipt(releaseKey: string) {
  const base: FollowupLatencyReport = { version: 'followup-latency-report-v1', providerMode: 'live', scope: 'explicitly simulated live-report shape, not real measurements', configuration: { model: 'synthetic', concurrency: 1 }, completed: true, releaseKey,
    samples: (['normal', 'repair'] as const).flatMap(path => Array.from({ length: 20 }, (_, index) => ({ caseId: `${path}-${index}`, repeat: 1, path, inputSha256: hash(index), wallMs: 100 + index,
      calls: { core: 1, review: path === 'repair' ? 2 : 1, repair: path === 'repair' ? 1 : 0 }, failure: null }))) };
  return { latencyReceipt: compareFollowupLatency(base, structuredClone(base)), latencyEvidence: { before: base, after: structuredClone(base) } };
}

test('identity fingerprints exact model/prompt/policy/gold/rubric/input/code and changes invalidate cached approval', async t => {
  const f = await fixture(t); const first = f.identity.releaseKey;
  assert.equal((await assertSemanticIdentityWorkspace(f.root, f.identity)).releaseKey, first);
  for (const file of ['server/providers/runtime-core-payload.ts', 'server/providers/single-core-contract.ts', 'policy.json', 'gold.json']) {
    const original = await readFile(path.join(f.root, file)); await writeFile(path.join(f.root, file), Buffer.concat([original, Buffer.from(' ')]));
    await assert.rejects(assertSemanticIdentityWorkspace(f.root, f.identity), /SEMANTIC_WORKSPACE_CHANGED/u);
    await writeFile(path.join(f.root, file), original);
  }
  const originalModels = await readFile(path.join(f.root, 'models.json'));
  await writeFile(path.join(f.root, 'models.json'), JSON.stringify({ ...models, core: { ...models.core, responseModel: 'different-snapshot' } }));
  await assert.rejects(assertSemanticIdentityWorkspace(f.root, f.identity), /SEMANTIC_WORKSPACE_CHANGED/u);
  await writeFile(path.join(f.root, 'models.json'), originalModels);
  const modified = structuredClone(f.identity); modified.modelConfig.core.requestedModel = 'other';
  assert.throws(() => collectSemanticCandidate(modified, f.rubric, []), /SEMANTIC_RELEASE_KEY_MISMATCH/u);
});

test('semantic pass is deterministic sample evidence and missing latency is never full release approval', async t => {
  const f = await fixture(t), candidate = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity)]), signed = reviews(candidate);
  const receipt = verifySemanticRelease(candidate, signed);
  assert.equal(receipt.semanticStatus, 'pass'); assert.equal(receipt.latencyStatus, 'not-provided'); assert.equal(receipt.releaseStatus, 'incomplete');
  assert.deepEqual(verifySemanticRelease(candidate, signed), receipt); assert.equal(receipt.scope.newRuntimeCalls, 0); assert.equal(receipt.scope.sampleEvidenceOnly, true);
  assert.equal(receipt.scope.humanIdentityNotCryptographicallyVerified, true);
  assert.equal(verifySemanticRelease(candidate, signed, latencyReceipt(f.identity.releaseKey)).releaseStatus, 'incomplete', 'A fixture cannot approve production.');
});

test('a release needs a correctly bound valid latency receipt in addition to semantic approval', async t => {
  const f = await fixture(t, 'release'), candidate = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity)]), signed = reviews(candidate);
  assert.equal(verifySemanticRelease(candidate, signed, latencyReceipt(f.identity.releaseKey)).releaseStatus, 'pass');
  assert.equal(verifySemanticRelease(candidate, signed, { ...latencyReceipt(f.identity.releaseKey), latencyReceipt: { status: 'pass', releaseKey: f.identity.releaseKey } }).releaseStatus, 'fail');
  assert.equal(verifySemanticRelease(candidate, signed, latencyReceipt('a'.repeat(64))).latencyStatus, 'unbound');
});

test('labels, candidate-only results, missing final proof and unreviewed templates cannot approve speech', async t => {
  const f = await fixture(t);
  for (const changes of [{ phase: 'candidate-only' }, { factualReviewSha256: null }, { finalQuestionSha256: null }]) {
    const candidate = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity, changes)]);
    assert.equal(verifySemanticRelease(candidate, reviews(candidate)).semanticStatus, 'incomplete');
  }
  const candidate = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity)]);
  assert.equal(verifySemanticRelease(candidate, { schemaVersion: 1, reviews: [] }).semanticStatus, 'incomplete');
  assert.equal(verifySemanticRelease(candidate, reviews(candidate, { provenance: 'unreviewed' })).semanticStatus, 'incomplete');
  assert.equal(verifySemanticRelease(candidate, reviews(candidate, { provenance: 'model' })).semanticStatus, 'incomplete', 'Default rubric requires a human review, not a model disguised as a human.');
});

test('edited final repair/history/config invalidates the exact signed outcome; changed fields cannot retain a hash', async t => {
  const f = await fixture(t), candidate = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity)]), signed = reviews(candidate);
  const edited = structuredClone(candidate); edited.outcomes[0].finalQuestionSha256 = semanticHash('다른 요구를 추가한 수정 질문인가요?');
  assert.equal(verifySemanticRelease(edited, signed).semanticStatus, 'fail');
  edited.outcomes[0].outcomeSha256 = hashSemanticOutcome(edited.outcomes[0]);
  assert.equal(verifySemanticRelease(edited, signed).semanticStatus, 'fail');
  edited.outcomes[0].historySha256 = hash(['a different F1']); edited.outcomes[0].outcomeSha256 = hashSemanticOutcome(edited.outcomes[0]);
  assert.equal(verifySemanticRelease(edited, signed).semanticStatus, 'fail');
  const wrongModel = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity, { models: [{ stage: 'core', requestedModel: 'synthetic-core', responseModel: 'wrong' }] })]);
  assert.equal(verifySemanticRelease(wrongModel, reviews(wrongModel)).semanticStatus, 'fail');
});

test('repair requires review of preserved meaning and unresolved/fail remain nonpassing', async t => {
  const f = await fixture(t), candidate = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity, { surfaceOrigin: 'repair', models: [
    { stage: 'core', ...models.core }, { stage: 'review', ...models.factReview }, { stage: 'repair', ...models.surfaceRepair },
  ] })]);
  const signed = reviews(candidate); assert.equal(verifySemanticRelease(candidate, signed).semanticStatus, 'pass');
  const unresolved = structuredClone(signed); unresolved.reviews[0].checks.repairedMeaningPreserved = 'unresolved';
  assert.equal(verifySemanticRelease(candidate, unresolved).semanticStatus, 'incomplete');
  unresolved.reviews[0].checks.repairedMeaningPreserved = 'fail'; assert.equal(verifySemanticRelease(candidate, unresolved).semanticStatus, 'fail');
});

test('resigning edited candidate booleans cannot override a failed pinned raw report', async t => {
  const f = await fixture(t), original = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity, { executionReady: false, structuralChecksPassed: false })]);
  assert.equal(verifySemanticRelease(original, reviews(original)).semanticStatus, 'fail');
  const edited = structuredClone(original); edited.diagnostics = []; edited.outcomes[0].executionReady = true; edited.outcomes[0].structuralChecksPassed = true;
  edited.outcomes[0].outcomeSha256 = hashSemanticOutcome(edited.outcomes[0]);
  const receipt = verifySemanticRelease(edited, reviews(edited));
  assert.equal(receipt.semanticStatus, 'fail'); assert.ok(receipt.diagnostics.some(row => row.code === 'CANDIDATE_RECOLLECTION_MISMATCH'));
  assert.equal(verifyGate(original, reviews(original)).semanticStatus, 'fail', 'Bad execution still fails even without raw reports.');
  const good = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity)]);
  assert.equal(verifyGate(good, reviews(good)).semanticStatus, 'incomplete', 'A well-shaped candidate with no raw report proof cannot pass.');
});

test('latency summary is recomputed from before/after evidence and cannot be made faster by editing metrics', async t => {
  const f = await fixture(t, 'release'), candidate = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity)]), signed = reviews(candidate), proof = latencyReceipt(f.identity.releaseKey);
  const forged = structuredClone(proof); forged.latencyReceipt.paths[0].after.p95Ms = (forged.latencyReceipt.paths[0].after.p95Ms ?? 0) - 1;
  assert.equal(verifySemanticRelease(candidate, signed, forged).latencyStatus, 'fail');
  assert.equal(verifySemanticRelease(candidate, signed, { latencyReceipt: proof.latencyReceipt }).releaseStatus, 'incomplete');
});

test('unobserved effort/token budget is incomplete, and changed actual request config fails', async t => {
  const f = await fixture(t), core = { stage: 'core', requestedModel: models.core.requestedModel, responseModel: models.core.responseModel };
  const missing = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity, { models: [core, { stage: 'review', ...models.factReview }] })]);
  assert.equal(verifySemanticRelease(missing, reviews(missing)).semanticStatus, 'incomplete');
  const changed = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity, { models: [{ ...core, reasoningEffort: 'medium', maxOutputTokens: 2000 }, { stage: 'review', ...models.factReview }] })]);
  assert.equal(verifySemanticRelease(changed, reviews(changed)).semanticStatus, 'fail');
});

test('F2 is discretionary: valid transition with F1 history passes without forcing F2 or subsequent turn', async t => {
  const custom = { ...rubricInput, requiredCoverage: ['f2-decision-history', 'refusal-negation-correction'], cases: [
    { caseId: 'synthetic-F1', repeats: 1, coverage: ['f2-decision-history', 'refusal-negation-correction'], expectedActions: ['FOLLOW_UP', 'TRANSITION'], expectedCoverage: ['met'], expectedResponse: ['answered'] },
    { caseId: 'optional-after-F2', repeats: 1, required: false, coverage: [], expectedActions: ['TRANSITION'] },
  ] };
  const f = await fixture(t, 'fixture', custom), candidate = collectSemanticCandidate(f.identity, f.rubric, [report(f.identity, { executedAction: 'TRANSITION', coverage: 'met', finalQuestionSha256: null, factualReviewSha256: null, surfaceOrigin: 'none', historySha256: hash(['actual F1 question and answer']) })]);
  assert.equal(verifySemanticRelease(candidate, reviews(candidate)).semanticStatus, 'pass');
  candidate.rubric.requiredCoverage.push('not-covered'); assert.throws(() => verifySemanticRelease(candidate, reviews(candidate)), /SEMANTIC_RUBRIC_CHANGED/u);
});

test('full-runtime adapter binds repaired final utterance instead of original core wording', async t => {
  const f = await fixture(t), question = '무엇을 맡았나요?', answer = '자료를 골랐습니다.', final = '자료를 고른 기준 하나를 말씀해 주세요.';
  const decision = { assessment: { coverage: 'partial', response: 'answered' }, next: { action: 'FOLLOW_UP', question: { text: '잘못된 최초 문장인가요?' } } };
  const value = { semanticReleaseIdentity: f.identity, engineSourceSha256: f.identity.engineSources, cases: [{ caseId: 'synthetic-F1', question, syntheticAnswer: answer, priorSha256: hash([]),
    providerUsage: report(f.identity).value.outcomes[0].models.map(entry => ({ stage: entry.stage, observation: { requestedModel: entry.requestedModel, responseModel: entry.responseModel,
      requestedReasoningEffort: entry.reasoningEffort, requestedMaxOutputTokens: entry.maxOutputTokens } })),
    result: { semanticDecision: decision, execution: { status: 'ready', action: 'FOLLOW_UP', surfaceOrigin: 'bounded_surface_repair' }, draft: { questionText: final, premiseValidation: { status: 'approved' } } } }] };
  const source = { path: 'actual-shape.json', value, sha256: hash(value) }, candidate = collectSemanticCandidate(f.identity, f.rubric, [source]);
  assert.equal(candidate.diagnostics.length, 0); assert.equal(candidate.outcomes[0].finalQuestionSha256, semanticHash(final));
  assert.notEqual(candidate.outcomes[0].finalQuestionSha256, semanticHash(decision.next.question.text)); assert.equal(candidate.outcomes[0].surfaceOrigin, 'repair');
  assert.equal(candidate.outcomes[0].models[0].reasoningEffort, models.core.reasoningEffort); assert.equal(candidate.outcomes[0].models[0].maxOutputTokens, models.core.maxOutputTokens);
});

test('Q6 whole-demand and Q14 subpoint QA binds model verdicts to final runtime utterances, including repair and discretionary transition', async t => {
  type Input = { id: string; question: string; rawTranscript: string; expected: { actions: string[]; coverage: string[]; response?: string[]; followUpScope?: string | null } };
  type Surface = { id: string; inputCaseId: string; action: 'FOLLOW_UP' | 'CLARIFICATION' | 'TRANSITION'; coreText: string | null; finalText: string | null;
    surfaceOrigin: 'core' | 'repair' | 'none'; expectedVerdict: 'pass' | 'fail'; failedChecks: Array<keyof SemanticReview['checks']>; note: string };
  const gold = JSON.parse(await readFile(new URL('./fixtures/single-core-demand-boundary-cases.json', import.meta.url), 'utf8')) as {
    cases: Input[]; wholeCausalDemandContrasts: { cases: Input[] }; finalUtteranceQa: { provenance: string; cases: Surface[] } };
  const inputs = new Map([...gold.cases, ...gold.wholeCausalDemandContrasts.cases].map(row => [row.id, row]));
  for (const row of gold.finalUtteranceQa.cases) await t.test(row.id, async sub => {
    const input = inputs.get(row.inputCaseId)!;
    const rubric = { schemaVersion: 1, version: 'synthetic-final-utterance-boundary-v1', requiredCoverage: ['whole-demand-vs-subpoint-final-utterance'], acceptedReviewProvenance: ['model'],
      cases: [{ caseId: row.id, repeats: 1, coverage: ['whole-demand-vs-subpoint-final-utterance'], expectedActions: input.expected.actions,
        expectedCoverage: input.expected.coverage, expectedResponse: input.expected.response ?? ['answered'], followUpScope: input.expected.followUpScope ?? null }] };
    const f = await fixture(sub, 'fixture', rubric, gold);
    const observations = [{ stage: 'core', ...models.core }, ...(row.finalText === null ? [] : [{ stage: 'review', ...models.factReview }]),
      ...(row.surfaceOrigin === 'repair' ? [{ stage: 'repair', ...models.surfaceRepair }] : [])];
    const value = { semanticReleaseIdentity: f.identity, engineSourceSha256: f.identity.engineSources, cases: [{ caseId: row.id,
      question: input.question, syntheticAnswer: input.rawTranscript, priorSha256: hash([]),
      providerUsage: observations.map(entry => ({ stage: entry.stage, observation: { requestedModel: entry.requestedModel, responseModel: entry.responseModel,
        requestedReasoningEffort: entry.reasoningEffort, requestedMaxOutputTokens: entry.maxOutputTokens } })),
      result: {
        semanticDecision: { assessment: { coverage: input.expected.coverage[0], response: 'answered', reason: 'Explicit synthetic boundary fixture; no live decision or human signoff.' },
          next: { action: row.action, question: row.coreText === null ? null : { text: row.coreText } }, reaction: null },
        execution: { status: 'ready', action: row.action, surfaceOrigin: row.surfaceOrigin === 'repair' ? 'bounded_surface_repair' : row.surfaceOrigin },
        draft: row.finalText === null ? null : { questionText: row.finalText, premiseValidation: { status: 'approved', fixtureOnly: true } },
      } }] };
    const source = semanticReportSource(`${row.id}.json`, canonicalJson(value)); sourceReports.set(source.sha256, source);
    const candidate = collectSemanticCandidate(f.identity, f.rubric, [source]);
    assert.deepEqual(candidate.diagnostics, []); assert.equal(candidate.outcomes[0].phase, 'final-runtime');
    assert.equal(candidate.outcomes[0].finalQuestionSha256, row.finalText === null ? null : semanticHash(row.finalText));
    const signed = reviews(candidate, { provenance: 'model', reviewer: 'synthetic-model-fixture-author', note: `${gold.finalUtteranceQa.provenance}: ${row.note}` });
    for (const check of row.failedChecks) signed.reviews[0].checks[check] = 'fail';
    const receipt = verifySemanticRelease(candidate, signed);
    assert.equal(receipt.semanticStatus, row.expectedVerdict); assert.notEqual(receipt.releaseStatus, 'pass', 'Synthetic/model QA never impersonates production human approval.');
    if (row.id === 'Q6-WHOLE-WHY-HOW-AS-F') {
      assert.ok(receipt.diagnostics.some(entry => entry.code === 'ACTION_OUTSIDE_GOLD'));
      assert.ok(receipt.diagnostics.some(entry => entry.code === 'SEMANTIC_REVIEW_FAILED'));
    }
    if (row.surfaceOrigin === 'repair') {
      assert.notEqual(candidate.outcomes[0].finalQuestionSha256, semanticHash(row.coreText!));
      const narrow = structuredClone(value); narrow.cases[0].result.draft!.questionText = row.coreText!;
      const narrowSource = semanticReportSource(`${row.id}-before-repair.json`, canonicalJson(narrow)); sourceReports.set(narrowSource.sha256, narrowSource);
      const narrowCandidate = collectSemanticCandidate(f.identity, f.rubric, [narrowSource]);
      const narrowReview = reviews(narrowCandidate, { provenance: 'model', reviewer: 'synthetic-model-fixture-author' });
      assert.equal(verifySemanticRelease(narrowCandidate, narrowReview).semanticStatus, 'pass');
      assert.equal(verifySemanticRelease(candidate, narrowReview).semanticStatus, 'incomplete', 'Review of the narrow core wording cannot approve an expanded final utterance.');
    }
  });
});

test('delivered adapter binds actual turn_ready speech/proof and excludes the next Q0 on transition', async t => {
  const custom = { ...rubricInput, cases: [{ ...rubricInput.cases[0], expectedActions: ['FOLLOW_UP', 'TRANSITION'] }] };
  const f = await fixture(t, 'fixture', custom), spoken = '자료 선택 기준 하나를 말씀해 주세요.';
  const decision = { assessment: { coverage: 'partial', response: 'answered' }, next: { action: 'FOLLOW_UP', question: { text: '수정 전 문장인가요?' } } };
  const row = { caseId: 'synthetic-F1', turnId: 'q0', question: '맡은 일은?', rawTranscript: '자료를 골랐습니다.', responseStatus: 200, rawAndAnswerIdPreserved: true,
    coreDecision: { semanticDecision: decision, nextAction: 'FOLLOW_UP', execution: { surfaceOrigin: 'bounded_surface_repair' }, providerUsage: [] },
    events: [{ type: 'turn_ready', turn: { id: 'f1', questionText: spoken } }],
    deliveredProof: { turnId: 'f1', questionSha256: semanticHash(spoken), premiseValidationSha256: hash({ status: 'approved' }), validationStatus: 'approved' } };
  const value = { semanticReleaseIdentity: f.identity, advances: [row] }, source = semanticReportSource('delivered.json', canonicalJson(value));
  const candidate = collectSemanticCandidate(f.identity, f.rubric, [source]);
  assert.equal(candidate.diagnostics.length, 0); assert.equal(candidate.outcomes[0].phase, 'delivered'); assert.equal(candidate.outcomes[0].finalQuestionSha256, semanticHash(spoken));
  assert.equal(candidate.outcomes[0].structuralChecksPassed, true);
  const transition = structuredClone(value); transition.advances[0].coreDecision.nextAction = 'TRANSITION';
  const nextMain = collectSemanticCandidate(f.identity, f.rubric, [semanticReportSource('next-main.json', canonicalJson(transition))]);
  assert.equal(nextMain.outcomes[0].finalQuestionSha256, null, 'Next Q0 is not the transition decision\'s generated follow-up.');
});

test('CLI handles synthetic identity→collect→template→verify without calls, preserves outputs and catches report edits', async t => {
  const f = await fixture(t); await writeFile(path.join(f.root, 'identity.json'), JSON.stringify(f.identity));
  const raw = report(f.identity); await writeFile(path.join(f.root, 'report.json'), canonicalJson(raw.value));
  assert.equal((await verifySemanticReleaseCli(['collect', '--identity', 'identity.json', '--report', 'report.json', '--out', 'candidate.json'], f.root)).exitCode, 0);
  assert.equal((await verifySemanticReleaseCli(['review-template', '--candidate', 'candidate.json', '--out', 'reviews.json'], f.root)).exitCode, 0);
  const receipt = await verifySemanticReleaseCli(['verify', '--candidate', 'candidate.json', '--reviews', 'reviews.json', '--out', 'pending.json'], f.root);
  assert.equal(receipt.exitCode, 2); assert.equal(JSON.parse(await readFile(path.join(f.root, 'pending.json'), 'utf8')).semanticStatus, 'incomplete');
  await assert.rejects(verifySemanticReleaseCli(['verify', '--candidate', 'candidate.json', '--reviews', 'reviews.json', '--out', 'pending.json'], f.root), /EEXIST/u);
  await writeFile(path.join(f.root, 'report.json'), JSON.stringify({ ...raw.value, edited: true }));
  await assert.rejects(verifySemanticReleaseCli(['verify', '--candidate', 'candidate.json', '--reviews', 'reviews.json', '--out', 'edited.json'], f.root), /SEMANTIC_COLLECTED_REPORT_CHANGED/u);
  assert.match((await verifySemanticReleaseCli(['--help'], f.root)).output, /no API calls/u);
  await assert.rejects(verifySemanticReleaseCli(['collect', '--identity', 'identity.json', '--report', 'report.json', '--out', '../outside.json'], f.root), /SEMANTIC_CLI_PATH_OUTSIDE_ROOT/u);
});

test('CLI requires latency raw file evidence for combined release and rechecks its exact bytes', async t => {
  const f = await fixture(t, 'release'), source = report(f.identity), candidate = collectSemanticCandidate(f.identity, f.rubric, [source]);
  for (const [file, value] of Object.entries({ 'report.json': source.value, 'candidate.json': candidate, 'reviews.json': reviews(candidate) })) await writeFile(path.join(f.root, file), canonicalJson(value));
  const proof = latencyReceipt(f.identity.releaseKey), beforeBytes = canonicalJson(proof.latencyEvidence.before), afterBytes = canonicalJson(proof.latencyEvidence.after);
  await writeFile(path.join(f.root, 'before.json'), beforeBytes); await writeFile(path.join(f.root, 'after.json'), afterBytes);
  const receipt = { ...proof.latencyReceipt, evidence: { before: { path: 'before.json', sha256: semanticHash(beforeBytes) }, after: { path: 'after.json', sha256: semanticHash(afterBytes) } } };
  await writeFile(path.join(f.root, 'latency.json'), canonicalJson(receipt));
  const base = ['verify', '--candidate', 'candidate.json', '--reviews', 'reviews.json', '--require-latency'];
  assert.equal((await verifySemanticReleaseCli([...base, '--out', 'missing.json'], f.root)).exitCode, 2);
  assert.equal((await verifySemanticReleaseCli([...base, '--latency', 'latency.json', '--out', 'passed.json'], f.root)).exitCode, 0);
  await writeFile(path.join(f.root, 'after.json'), afterBytes + ' ');
  await assert.rejects(verifySemanticReleaseCli([...base, '--latency', 'latency.json', '--out', 'changed.json'], f.root), /SEMANTIC_LATENCY_REPORT_BYTES_CHANGED/u);
});
