import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DeepRebindCallBudget, assertDeepApprovedCacheRebind, assertDeepRepairOverlayEquivalent, authorizeDeepIncompleteWireRetry, deepNewQuestionCacheBinding, deepRecoveryReadiness, deepRetainedStablePayload, deepProviderErrorDiagnostics, mergeCalibratedDeepReviews, parseDeepRebindExecutionArgs, rebuildDeepReboundDraft, rebindExistingDeepRecovery, runDeepBankRebind, selectMissingDeepRecoveryCandidateIds, validateDeepRecoveryRepairPlan, validateDeepRepairPlan, validateStoredDeepReview, verifyStoredDeepReviewFiles, withDeepRebindGenerationLock, type DeepRecoveryRepairPlan, type DeepRepairPlan, type RetainedArtifact, type StoredReview } from '../scripts/run-deep-bank-rebind';
import { deepRebindDigest, type DeepBankRebindRow } from '../server/data/deep-bank-rebind';
import { loadApprovedRecoveryVariants, saveApprovedRecoveryVariants } from '../server/data/approved-recovery-variants';
import { recoveryOriginal } from '../scripts/prepare-runtime-recovery-pool';
import { resolveVoiceSettings, speechAudioCacheId } from '../server/providers/clova-tts';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { PreparedMainCandidate, PreparedQuestionBank } from '../server/data/prepared-question-bank';
import type { QuestionDraft, InterviewSession } from '../server/protocol';
import type { QuestionPremiseReviewInput } from '../server/providers/question-premises';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function temporary(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deep-bank-execution-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('deep-bank-execution-')); await rm(root, { recursive: true, force: true }); }); return root;
}
function fixture() {
  const text = '공동 탐구 보고서를 작성하고 그 내용을 발표함.', questionText = '공동 탐구에서 본인이 맡은 역할은 무엇인가요?';
  const evidence = { id: 'source-1', text, sourceRef: { pdfSha256: sha('synthetic-pdf') } };
  const question = { questionText, questionKind: 'main' as const, primaryFunction: 'ROLE' as const, questionIntent: '공동 탐구에서 맡은 본인 역할 한 가지', targetEvidence: ['직접 맡은 역할 한 가지'], depth: 'D2' as const };
  const input: QuestionPremiseReviewInput = { question, sources: [{ id: evidence.id, text, status: 'record_only_not_scientific_verification' }], answer: null, answerSources: [], originalQuestion: null };
  const objective = { id: 'objective-1', primaryFunction: 'ROLE', depth: 'D2', questionIntent: question.questionIntent, targetEvidence: question.targetEvidence, semanticKey: 'synthetic-role', evidenceIds: [evidence.id], activityIds: ['activity-1'], anchorRefs: [], anchorQuote: text, scope: 'record_based', requiresOpenCheck: true, selectionBasis: '개인 역할을 열린 질문으로 확인', unknowns: ['개인 역할 미확인'], forbiddenPremises: ['팀 역할을 개인에게 귀속하지 않음'] };
  const row = { oldCandidateId: 'candidate-1', oldObjectiveId: 'objective-1', questionSha256: sha(questionText), questionText, reviewInput: input, currentMeaningContext: { objective, entities: [] } } as unknown as DeepBankRebindRow;
  // All review outputs in this file are synthetic fixtures, never real API evidence.
  const review = { verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true,
    premises: [{ questionSpan: '공동 탐구', basis: 'record', sourceId: evidence.id, supportQuote: text, supported: true }] };
  const stored: StoredReview = { candidateId: row.oldCandidateId, objectiveId: row.oldObjectiveId, model: 'synthetic-independent-reviewer', inputSha256: deepRebindDigest({ ...input, currentSourceContext: row.currentMeaningContext }), questionSha256: row.questionSha256,
    requestPath: '', requestFileSha256: '', responsePath: '', responseFileSha256: '', review, status: 'approved', failureCode: null };
  const context = { errors: [], student: { evidence: [evidence] }, manifest: { files: [{ role: 'fullStudentAnalysis', path: 'old.json', sha256: sha('old') }] } } as unknown as InterviewContext;
  const draft = { acknowledgement: null, acknowledgementQuote: null, ...question, parentMainQuestionId: null, evidenceIds: [evidence.id], evidenceQuotes: [{ evidenceId: evidence.id, quote: text }],
    groundingRationale: '합성 기록을 근거로 개인 역할이 무엇인지 질문한다.', validationStatus: 'approved', validationFailures: [],
    approvedQuestion: { oldSentinel: 'must-be-dropped' }, questionBlueprint: { oldSentinel: 'must-be-dropped' }, premiseValidation: { oldSentinel: 'must-be-dropped' } } as unknown as QuestionDraft;
  const voice = resolveVoiceSettings('synthetic-speaker', {});
  const candidate = { id: 'candidate-1', slotId: 'slot-1', mainIndex: 1, variant: 0, draft, voiceSettings: voice, questionSha256: sha(questionText) } as PreparedMainCandidate;
  const slot = { id: 'slot-1', index: 1, objective, primaryFunction: 'ROLE', depth: 'D2', evidenceIds: [evidence.id], activityIds: ['activity-1'], schoolConnections: [] };
  const session = { id: 'synthetic-offline-session', turns: [], plan: { scheduling: 'time_based', slots: [slot] } } as unknown as InterviewSession;
  const bank = { key: sha('synthetic-bank'), plan: { slots: [slot] }, slots: [{ slotId: slot.id, candidates: [candidate] }] } as unknown as PreparedQuestionBank;
  return { row, stored, input, review, context, candidate, session, bank, voice };
}

test('each paid phase requires its own explicit cap; combined or excessive caps are rejected before execution', () => {
  const base = ['--run-live', '--revision=synthetic.json', '--mapping=artifacts/synthetic-map.json', '--output=artifacts/synthetic-output.json', '--review-model=synthetic-reviewer'];
  const retained = parseDeepRebindExecutionArgs([...base, '--phase=retained', '--max-retained-review-calls=30']);
  assert.equal(retained.maxRetainedReviewCalls, 30); assert.equal(retained.maxNewQuestionCalls, 0);
  assert.equal(parseDeepRebindExecutionArgs([...base, '--phase=bank', '--max-new-question-calls=12', '--max-new-question-tts-calls=6']).maxNewQuestionCalls, 12);
  assert.equal(parseDeepRebindExecutionArgs([...base, '--phase=recovery', '--max-new-recovery-calls=12', '--max-new-recovery-tts-calls=6']).maxNewRecoveryCalls, 12);
  assert.equal(parseDeepRebindExecutionArgs([...base, '--phase=recovery', '--max-new-recovery-calls=68', '--max-new-recovery-tts-calls=34']).maxNewRecoveryCalls, 68);
  assert.equal(parseDeepRebindExecutionArgs([...base, '--phase=calibration', '--max-calibration-calls=5']).maxCalibrationCalls, 5);
  assert.equal(parseDeepRebindExecutionArgs([...base, '--phase=repair', '--repair-plan=artifacts/explicit.json', '--max-repair-calls=8']).maxRepairCalls, 8);
  assert.equal(parseDeepRebindExecutionArgs([...base, '--phase=bank', '--max-new-question-calls=24', '--max-new-question-tts-calls=6']).maxNewQuestionCalls, 24);
  assert.equal(parseDeepRebindExecutionArgs([...base, '--phase=gate']).maxRetainedReviewCalls, 0);
  assert.equal(parseDeepRebindExecutionArgs([...base, '--phase=retained', '--max-retained-review-calls=31', '--allow-one-incomplete-wire-retry']).maxRetainedReviewCalls, 31);
  for (const args of [[...base, '--phase=retained'], [...base, '--phase=retained', '--max-retained-review-calls=31'], [...base, '--phase=gate', '--max-new-question-calls=12'], [...base, '--phase=retained', '--max-retained-review-calls=30', '--activate']]) assert.throws(() => parseDeepRebindExecutionArgs(args), /DEEP_REBIND_/u);
  assert.throws(() => parseDeepRebindExecutionArgs([...base, '--phase=calibration', '--max-calibration-calls=6']), /CAP_OUT_OF_RANGE/u);
  assert.throws(() => parseDeepRebindExecutionArgs([...base, '--phase=repair', '--max-repair-calls=8']), /REPAIR_PLAN_REQUIRED/u);
  assert.throws(() => parseDeepRebindExecutionArgs([...base, '--phase=repair', '--repair-plan=artifacts/explicit.json', '--max-repair-calls=9']), /CAP_OUT_OF_RANGE/u);
  assert.equal(parseDeepRebindExecutionArgs([...base, '--phase=recovery', '--max-new-recovery-calls=75', '--max-new-recovery-tts-calls=34', '--recovery-repair-plan=artifacts/pinned.json']).maxNewRecoveryCalls, 75);
  assert.equal(parseDeepRebindExecutionArgs([...base, '--phase=recovery', '--max-new-recovery-calls=77', '--max-new-recovery-tts-calls=34', '--recovery-repair-plan=artifacts/proposals.json']).maxNewRecoveryCalls, 77);
  assert.throws(() => parseDeepRebindExecutionArgs([...base, '--phase=recovery', '--max-new-recovery-calls=78', '--max-new-recovery-tts-calls=34']), /CAP_OUT_OF_RANGE/u);
});

test('only actual failed cases may enter the once-only recovery plan; semantic rejects cannot masquerade as an absent-response retry', () => {
  const { bank, candidate } = fixture();
  const current = { ...bank, contentSha256: sha('current-bank'), slots: Array.from({ length: 4 }, (_, i) => ({ slotId: `slot-${i}`, candidates: [{ ...candidate, id: `candidate-${i}`, draft: { ...candidate.draft, questionText: `합성 질문 ${i}인가요?` } }] })) } as PreparedQuestionBank;
  const plan: DeepRecoveryRepairPlan = { version: 'actual-failed-recovery-once-plan-v1', sourceReportPath: 'synthetic-report.json', sourceReportFileSha256: sha('report'), bankKey: current.key, bankContentSha256: current.contentSha256, items: Array.from({ length: 4 }, (_, i) => ({ candidateId: `candidate-${i}`, action: i === 3 ? 'retry_review_once' : 'regenerate_once', ...(i === 3 ? { failedRequestPath: 'synthetic/request.json', failedRequestFileSha256: sha('failed-request') } : {}) })) };
  const source = { bankKey: current.key, bankContentSha256: current.contentSha256, newRecovery: { completedAt: '2026-11-05T00:00:00Z', questions: current.slots.map((slot, i) => ({ candidateId: slot.candidates[0].id, question: slot.candidates[0].draft.questionText, ready: false, attempts: [{ questionText: '이전 후보', failure: i === 3 ? 'Error' : 'PREMISE_UNSUPPORTED', ...(i === 3 ? {} : { review: { verdict: 'rewrite', intentMatches: false } }) }] })) } };
  const missing = plan.items.map(item => item.candidateId);
  assert.equal(validateDeepRecoveryRepairPlan(plan, source, current, missing).length, 4);
  const relabeled = structuredClone(source); relabeled.newRecovery.questions[3].attempts[0].review = { verdict: 'rewrite', intentMatches: false };
  assert.throws(() => validateDeepRecoveryRepairPlan(plan, relabeled, current, missing), /NOT_AN_ACTUAL_FAILED_CASE/u);
  const ready = structuredClone(source); ready.newRecovery.questions[0].ready = true;
  assert.throws(() => validateDeepRecoveryRepairPlan(plan, ready, current, missing), /NOT_AN_ACTUAL_FAILED_CASE/u);
  assert.throws(() => validateDeepRecoveryRepairPlan(plan, source, current, missing.slice(1)), /NOT_AN_ACTUAL_FAILED_CASE/u);
  const provided: DeepRecoveryRepairPlan = { ...plan, providedProposalsReview: { remainingDefectsReportPath: 'synthetic-defects.json', remainingDefectsReportFileSha256: sha('defects'), targetContentSha256: sha('target'), authorship: 'codex-offline-source-and-demand-reviewed-proposal', approvalAuthority: 'none' }, items: plan.items.slice(0, 2).map((item, i) => ({ candidateId: item.candidateId, action: 'provided_candidate', questionText: `합성 내용 ${i}를 설명해 주세요.`, originalQuestionSha256: sha(current.slots[i].candidates[0].draft.questionText) })) };
  assert.equal(validateDeepRecoveryRepairPlan(provided, source, current, missing).length, 2);
  const changedProposal = structuredClone(provided); changedProposal.items[0].originalQuestionSha256 = sha('other-question');
  assert.throws(() => validateDeepRecoveryRepairPlan(changedProposal, source, current, missing), /NOT_AN_ACTUAL_FAILED_CASE/u);
  const falseAuthority = structuredClone(provided); (falseAuthority.providedProposalsReview as { approvalAuthority: string }).approvalAuthority = 'approved';
  assert.throws(() => validateDeepRecoveryRepairPlan(falseAuthority, source, current, missing), /PLAN_INVALID/u);
  assert.deepEqual(deepProviderErrorDiagnostics({ status: 503, code: 'UNAVAILABLE', type: 'server_error', request_id: 'request-id', message: 'secret-body-must-not-be-saved', headers: { authorization: 'secret' } }), { status: 503, code: 'UNAVAILABLE', type: 'server_error', request_id: 'request-id' });
});

test('all genuinely missing recovery candidates are selected across 35 ready Q0s, including legacy 28; existing audio is not regenerated', () => {
  const { bank, candidate } = fixture();
  const current = { ...bank, slots: Array.from({ length: 35 }, (_, i) => ({ slotId: `slot-${i}`, candidates: [{ ...candidate, id: `candidate-${i}` }] })) } as PreparedQuestionBank;
  const missing = Array.from({ length: 34 }, (_, i) => `candidate-${i + 1}`);
  assert.deepEqual(selectMissingDeepRecoveryCandidateIds(current, missing), missing);
  assert.throws(() => selectMissingDeepRecoveryCandidateIds(current, [...missing, missing[0]]), /MISSING_SCOPE_INVALID/u);
  assert.throws(() => selectMissingDeepRecoveryCandidateIds(current, ['not-in-bank']), /MISSING_SCOPE_INVALID/u);
});

test('checkpoint repair requires exact explicit source pins, unique selected purposes and one regeneration; the approved cache is a separate bounded fifth item', () => {
  const { context } = fixture();
  const ctx = { ...context, studentAnalysis: { contentSha256: sha('common') }, targetAnalysis: { contentSha256: sha('target'), objectives: Array.from({ length: 5 }, (_, i) => ({ id: `objective-${i}` })) } } as unknown as InterviewContext;
  const plan: DeepRepairPlan = { version: 'explicit-checkpoint-question-repair-v1', commonContentSha256: sha('common'), targetContentSha256: sha('target'), items: Array.from({ length: 5 }, (_, i) => ({ objectiveId: `objective-${i}`, action: i === 3 ? 'regenerate_once' : i === 4 ? 'review_approved_cache' : 'review_checkpoint', candidatePath: `synthetic/${i}.json`, candidateFileSha256: sha(`file-${i}`), feedback: { questionText: '합성 질문인가요?', failureCode: 'SYNTHETIC_REVIEW', reviewSummary: '실제 검수 전인 합성 사례로 승인 여부를 예단하지 않는다.' } })) };
  validateDeepRepairPlan(plan, ctx); validateDeepRepairPlan({ ...plan, items: plan.items.slice(0, 4) }, ctx);
  assert.throws(() => validateDeepRepairPlan({ ...plan, commonContentSha256: sha('other') }, ctx), /PLAN_INVALID/u);
  assert.throws(() => validateDeepRepairPlan({ ...plan, items: [...plan.items, plan.items[4]] }, ctx), /PLAN_INVALID/u);
  const duplicate = structuredClone(plan); duplicate.items[1].objectiveId = duplicate.items[0].objectiveId;
  assert.throws(() => validateDeepRepairPlan(duplicate, ctx), /PLAN_INVALID/u);
  const excessive = structuredClone(plan); excessive.items[0].feedback.reviewSummary = 'x'.repeat(701);
  assert.throws(() => validateDeepRepairPlan(excessive, ctx), /PLAN_INVALID/u);
});

test('reserved, failed and completed physical requests all consume the same durable cap across process-local instances', async t => {
  const root = await temporary(t), budget = new DeepRebindCallBudget(root, 2);
  const first = budget.reserve('review', { synthetic: 1 }); await writeFile(first.replace('.request.json', '.failure.json'), '{"syntheticFailure":true}');
  budget.reserve('review', { synthetic: 2 });
  assert.equal(budget.used(), 2); assert.throws(() => new DeepRebindCallBudget(root, 2).reserve('review', { synthetic: 3 }), /PHYSICAL_CALL_CAP_REACHED/u);
  assert.equal(JSON.parse(await readFile(first, 'utf8')).request.synthetic, 1);
});

test('explicit source overlay can add an existing owned header to one purpose without changing common facts, other purposes or its question demand', () => {
  const { context, session } = fixture();
  const base = { ...context, studentAnalysis: { contentSha256: sha('same-common') }, targetAnalysis: { objectives: [structuredClone(session.plan!.slots[0].objective!), { ...structuredClone(session.plan!.slots[0].objective!), id: 'other-purpose' }] } } as unknown as InterviewContext;
  base.student.evidence.push({ ...base.student.evidence[0], id: 'owned-header', text: '[1학년]' });
  const current = structuredClone(base); current.targetAnalysis!.objectives[0].evidenceIds.push('owned-header');
  assertDeepRepairOverlayEquivalent(base, current, 'objective-1', ['owned-header']);
  const changedDemand = structuredClone(current); changedDemand.targetAnalysis!.objectives[0].targetEvidence = ['다른 평가 요구'];
  assert.throws(() => assertDeepRepairOverlayEquivalent(base, changedDemand, 'objective-1', ['owned-header']), /DEMAND_OR_SOURCE_CHANGED/u);
  const otherChanged = structuredClone(current); otherChanged.targetAnalysis!.objectives[1].questionIntent = '다른 의도';
  assert.throws(() => assertDeepRepairOverlayEquivalent(base, otherChanged, 'objective-1', ['owned-header']), /OTHER_OBJECTIVE_CHANGED/u);
  const sourceChanged = structuredClone(current); sourceChanged.student.evidence[0].text = '수정한 원문';
  assert.throws(() => assertDeepRepairOverlayEquivalent(base, sourceChanged, 'objective-1', ['owned-header']), /SOURCE_CHANGED/u);
  assert.throws(() => assertDeepRepairOverlayEquivalent(base, current, 'objective-1', ['not-owned']), /DEMAND_OR_SOURCE_CHANGED/u);
});

test('generation lock rejects a concurrent writer and releases ownership on both success and failure', async t => {
  const root = await temporary(t);
  await withDeepRebindGenerationLock(root, async () => { await assert.rejects(withDeepRebindGenerationLock(root, async () => 'never'), /GENERATION_IS_LOCKED/u); });
  await assert.rejects(withDeepRebindGenerationLock(root, async () => { throw new Error('SYNTHETIC_FAILURE'); }), /SYNTHETIC_FAILURE/u);
  assert.equal(await withDeepRebindGenerationLock(root, async () => 'released'), 'released');
});

test('live entry point reserves a new report before reading source data or constructing any provider', async t => {
  const root = await temporary(t); await mkdir(path.join(root, 'artifacts'));
  const file = path.join(root, 'artifacts/preserved.json'); await writeFile(file, 'original-report-preserved');
  await assert.rejects(runDeepBankRebind({ root, phase: 'retained', revisionPath: 'missing-stage', mappingPath: 'missing-map', output: 'artifacts/preserved.json', reviewModel: 'synthetic-reviewer', maxRetainedReviewCalls: 30 }), { code: 'EEXIST' });
  assert.equal(await readFile(file, 'utf8'), 'original-report-preserved');
});

test('synthetic fresh review binds the exact question, current entity context and reviewer; stale approval cannot be reused', () => {
  const { row, stored } = fixture(), result = validateStoredDeepReview(row, stored, stored.model);
  assert.equal(result.reviewModel, stored.model); assert.equal(result.method, 'bounded_semantic_review');
  const changed = structuredClone(row); changed.currentMeaningContext!.objective.unknowns!.push('새 미확인 조건');
  assert.throws(() => validateStoredDeepReview(changed, stored, stored.model), /SOURCE_BINDING_CHANGED/u);
  assert.throws(() => validateStoredDeepReview(row, stored, 'different-reviewer'), /SOURCE_BINDING_CHANGED/u);
});

test('fresh current-source approval drops every old trace while preserving utterance and bound question demand', () => {
  const { row, stored, context, candidate, session } = fixture(), old = JSON.stringify(candidate);
  const draft = rebuildDeepReboundDraft(candidate, row, stored, context, session);
  assert.equal(draft.questionText, candidate.draft.questionText); assert.equal(draft.premiseValidation!.reviewModel, stored.model);
  assert.equal(draft.approvedQuestion!.finalUtteranceSha256, candidate.questionSha256);
  assert.doesNotMatch(JSON.stringify(draft.approvedQuestion), /oldSentinel/u);
  assert.equal(JSON.stringify(candidate), old);
  const changed = structuredClone(session); changed.plan!.slots[0].objective!.forbiddenPremises = ['수정된 금지 전제'];
  assert.throws(() => rebuildDeepReboundDraft(candidate, row, stored, context, changed), /MEANING_CONTEXT_CHANGED/u);
});

test('a semantic rejection remains a rejection; a source binding error is not turned into an approved contract', () => {
  const { row, stored, context, candidate, session } = fixture();
  stored.review = { ...stored.review as object, verdict: 'uncertain' };
  assert.throws(() => rebuildDeepReboundDraft(candidate, row, stored, context, session), /PREMISE_UNCERTAIN/u);
});

test('calibration keeps original approvals byte-for-byte and replaces only prior rejected reviews with exact same input/model', () => {
  const { stored } = fixture(), rejected = { ...stored, candidateId: 'synthetic-rejected', status: 'rejected' as const, failureCode: 'PREMISE_UNSUPPORTED' };
  const original = { version: 'deep-bank-fresh-retained-review-v1', reviews: [stored, rejected] } as RetainedArtifact, before = JSON.stringify(original);
  const calibrated = { ...rejected, status: 'approved' as const, failureCode: null };
  const combined = mergeCalibratedDeepReviews(original, [calibrated], sha('original-artifact'), '2026-11-05T00:00:00.000Z', sha('new-rules'));
  assert.deepEqual(combined.reviews[0], original.reviews[0]); assert.equal(combined.reviews[1].status, 'approved'); assert.equal(combined.calibration!.preservedApprovedCount, 1);
  assert.equal(JSON.stringify(original), before);
  assert.throws(() => mergeCalibratedDeepReviews(original, [{ ...calibrated, inputSha256: sha('different-input') }], sha('parent'), 'now', 'instructions'), /CHANGED_ORIGINAL_INPUT/u);
  assert.throws(() => mergeCalibratedDeepReviews(original, [stored], sha('parent'), 'now', 'instructions'), /CHANGED_ORIGINAL_INPUT/u);
});

test('approved question cache survives authority revision bookkeeping but not changed facts, demand or sources', () => {
  const { row, stored, context, candidate, session } = fixture();
  const draft = rebuildDeepReboundDraft(candidate, row, stored, context, session);
  const prior = { ...context, target: { university: 'synthetic' }, studentAnalysis: { contentSha256: sha('same-common') } } as unknown as InterviewContext;
  const current = structuredClone(prior); current.manifest.files[0].sha256 = sha('new-target-authority');
  const oldObjective = structuredClone(session.plan!.slots[0].objective!), objective = structuredClone(oldObjective);
  objective.analysisRevision = 'new-noop-authority-revision';
  assertDeepApprovedCacheRebind(prior, current, oldObjective, objective, draft);
  assert.equal(deepNewQuestionCacheBinding(prior, oldObjective, []), deepNewQuestionCacheBinding(current, objective, []));
  objective.targetEvidence = ['확대된 다른 요구'];
  assert.throws(() => assertDeepApprovedCacheRebind(prior, current, oldObjective, objective, draft), /CACHE_SCOPE_CHANGED/u);
  const wrongSource = structuredClone(current); wrongSource.student.evidence[0].text = '다른 학생부 원문';
  assert.throws(() => assertDeepApprovedCacheRebind(prior, wrongSource, oldObjective, oldObjective, draft), /CITATION_NOT_FOUND|CACHE_SOURCE_CHANGED/u);
});

test('stored response hash and its actual parsed verdict must match, including rejection status', async t => {
  const root = await temporary(t), { row, stored } = fixture(), directory = path.join(root, 'data/prepared/deep-bank-rebind-jobs/synthetic');
  await mkdir(directory, { recursive: true });
  const request = { request: { candidateId: stored.candidateId, request: { model: stored.model, input: JSON.stringify({ ...row.reviewInput, currentSourceContext: row.currentMeaningContext }) } } };
  const requestBytes = JSON.stringify(request), responseBytes = JSON.stringify({ status: 'completed', output_parsed: stored.review });
  Object.assign(stored, { requestPath: 'data/prepared/deep-bank-rebind-jobs/synthetic/request.json', requestFileSha256: sha(requestBytes), responsePath: 'data/prepared/deep-bank-rebind-jobs/synthetic/response.json', responseFileSha256: sha(responseBytes) });
  await writeFile(path.resolve(root, stored.requestPath), requestBytes); await writeFile(path.resolve(root, stored.responsePath), responseBytes);
  await verifyStoredDeepReviewFiles(root, row, stored);
  const falseStatus = { ...stored, status: 'rejected' as const, failureCode: 'PREMISE_UNSUPPORTED' };
  await assert.rejects(verifyStoredDeepReviewFiles(root, row, falseStatus), /VERDICT_CHANGED/u);
  await writeFile(path.resolve(root, stored.responsePath), responseBytes.replace('completed', 'incomplete'));
  await assert.rejects(verifyStoredDeepReviewFiles(root, row, stored), /ARTIFACT_HASH_CHANGED/u);
});

test('compact proof-ID wire preserves the complete source/context and materializes the actual raw response before verifying its canonical review', async t => {
  const root = await temporary(t), { row, stored } = fixture(), directory = path.join(root, 'data/prepared/deep-bank-rebind-jobs/compact');
  await mkdir(directory, { recursive: true });
  const payload = deepRetainedStablePayload(row);
  assert.equal(payload.sources[0].text, row.reviewInput!.sources[0].text); assert.deepEqual(payload.currentSourceContext, row.currentMeaningContext);
  const requestBytes = JSON.stringify({ request: { candidateId: stored.candidateId, request: { model: stored.model, input: JSON.stringify(payload) } } });
  const raw = { verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true,
    premises: [{ questionSpan: '공동 탐구', basis: 'record', supported: true, proofId: 'P1' }] };
  const responseBytes = JSON.stringify({ status: 'completed', output_parsed: raw });
  Object.assign(stored, { wireVersion: 'stable-proof-id-v1', requestPath: 'data/prepared/deep-bank-rebind-jobs/compact/request.json', requestFileSha256: sha(requestBytes), responsePath: 'data/prepared/deep-bank-rebind-jobs/compact/response.json', responseFileSha256: sha(responseBytes) });
  await writeFile(path.resolve(root, stored.requestPath), requestBytes); await writeFile(path.resolve(root, stored.responsePath), responseBytes);
  await verifyStoredDeepReviewFiles(root, row, stored);
  assert.notDeepEqual(raw, stored.review, 'raw compact response is not falsely represented as the stored canonical quote contract');
  const changed = structuredClone(stored); (changed.review as { premises: Array<{ supportQuote: string }> }).premises[0].supportQuote = '없는 원문';
  await assert.rejects(verifyStoredDeepReviewFiles(root, row, changed), /ARTIFACT_HASH_CHANGED/u);
});

test('a legacy max-output incomplete response permits only one explicitly bounded compact retry and remains unapproved', async t => {
  const root = await temporary(t), { row, stored } = fixture(), job = path.join(root, 'generation'), directory = path.join(job, 'retained-calls');
  await mkdir(directory, { recursive: true });
  const requestFile = path.join(directory, '003-retained-review.request.json');
  await writeFile(requestFile, JSON.stringify({ request: { candidateId: row.oldCandidateId, request: { model: stored.model, input: JSON.stringify({ ...row.reviewInput, currentSourceContext: row.currentMeaningContext }), text: { format: { name: 'deep_current_source_premise_review' } } } } }));
  const responseFile = requestFile.replace('.request.json', '.response.json'), original = JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output_parsed: null, output_text: '{unfinished  \t\t' });
  await writeFile(responseFile, original);
  await assert.rejects(authorizeDeepIncompleteWireRetry(job, row, stored.model, [requestFile], false), /WITHOUT_FINAL_RESULT_REQUIRES_REVIEW/u);
  const note = await authorizeDeepIncompleteWireRetry(job, row, stored.model, [requestFile], true);
  assert.equal(note.incompleteOutputNotApproved, true); assert.equal(note.maximumExtraPhysicalRequests, 1); assert.equal(note.totalRetainedCap, 31);
  assert.equal(await readFile(responseFile, 'utf8'), original);
  await assert.rejects(authorizeDeepIncompleteWireRetry(job, row, stored.model, [requestFile, requestFile], true), /WITHOUT_FINAL_RESULT_REQUIRES_REVIEW/u);
  await writeFile(responseFile, JSON.stringify({ status: 'incomplete', incomplete_details: { reason: 'other' }, output_parsed: null }));
  await assert.rejects(authorizeDeepIncompleteWireRetry(job, row, stored.model, [requestFile], true), /ONLY_LEGACY_WIRE_OUTPUT_TRUNCATION_CAN_RETRY/u);
});

test('a missing recovery variant blocks readiness and is never replaced by the original Q0', async t => {
  const root = await temporary(t), { context, bank } = fixture();
  const result = await deepRecoveryReadiness(context, bank, root);
  assert.deepEqual(result.missing, ['candidate-1']); assert.deepEqual(result.ready, []);
  const migration = await rebindExistingDeepRecovery(context, context, bank, bank, root);
  assert.equal(migration.ttsCalls, 0); assert.equal(migration.providerCalls, 0);
  assert.equal(migration.pending[0].reason, 'NO_APPROVED_DONOR_RECOVERY');
});

test('an existing exact recovery is rebound to new source pins, reloaded and checks durable audio without new API/TTS', async t => {
  const root = await temporary(t), { context, bank, candidate, review, voice } = fixture(), oldBefore = JSON.stringify(context);
  const variantText = '공동 탐구에서 맡았던 본인 역할을 설명해 주세요.';
  const original = recoveryOriginal(candidate);
  await saveApprovedRecoveryVariants(context, original, [{ questionText: variantText, reviewedAt: '2026-11-05T00:00:00.000Z', reviewModel: 'synthetic-reviewer', review }], root);
  const id = speechAudioCacheId(variantText, voice); await mkdir(path.join(root, 'data/audio'), { recursive: true }); await writeFile(path.join(root, 'data/audio', `${id}.mp3`), 'synthetic-audio');
  const current = structuredClone(context); current.manifest.files[0].sha256 = sha('new-analysis-only');
  const migration = await rebindExistingDeepRecovery(context, current, bank, bank, root);
  assert.deepEqual(migration.migrated, ['candidate-1']); assert.deepEqual(migration.pending, []);
  assert.equal((await loadApprovedRecoveryVariants(current, recoveryOriginal(candidate), root))[0].questionText, variantText);
  assert.deepEqual((await deepRecoveryReadiness(current, bank, root)).missing, []);
  assert.equal(JSON.stringify(context), oldBefore);
});
