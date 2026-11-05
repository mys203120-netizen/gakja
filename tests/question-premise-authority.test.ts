import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { interviewConfig } from '../interview.config';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { QuestionDraft } from '../server/protocol';
import { createApprovedCommonObjectives } from '../server/question-objective';
import { QuestionValidationError } from '../server/providers/question-grounding';
import { buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview, questionPremiseReviewWireSchema, resolveVerifiedCommonPremiseAuthority, QuestionPremiseReviewError } from '../server/providers/question-premises';
import { buildPremiseReviewDiagnostic, safeQuestionProviderFailure } from '../server/providers/openai';

// Source-binding contracts only. Synthetic reviewer verdicts do not measure model accuracy.
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture() {
  const context = {
    target: interviewConfig.target, errors: [],
    school: { university: interviewConfig.target.university, academicYear: interviewConfig.target.year, schoolReferenceId: 'fixture-university',
      department: { id: 'fixture-department', name: interviewConfig.target.department },
      interview: { id: 'fixture-track', department_id: 'fixture-department', university_id: 'fixture-university', academic_year: interviewConfig.target.year, track_name: interviewConfig.target.track },
    },
    manifest: { errors: [], files: ['questionGuidelines', 'universitiesJson', 'departmentsJson', 'admissionTracksJson'].map(role => ({ role, path: `synthetic-${role}`, sha256: digest(role) })), recordIds: { schoolReferenceId: 'fixture-university', departmentId: 'fixture-department', admissionTrackId: 'fixture-track' } },
  } as unknown as InterviewContext;
  const approvedModule = createApprovedCommonObjectives(context)[0];
  assert.equal(approvedModule.grounding?.kind, 'COMMON_APPROVED');
  const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: `${context.target.department}를 선택하게 된 계기가 있다면 무엇인가요?`, questionKind: 'main', parentMainQuestionId: null, evidenceIds: [], evidenceQuotes: [], commonApproval: approvedModule.grounding as NonNullable<QuestionDraft['commonApproval']>, primaryFunction: approvedModule.primaryFunction, questionIntent: approvedModule.questionIntent, targetEvidence: [...approvedModule.targetEvidence], depth: approvedModule.depth, groundingRationale: '승인된 공통 모듈 목적을 열린 질문으로 확인한다.', validationStatus: 'approved', validationFailures: [] };
  return { context, draft };
}
function openReview(questionText: string) {
  return { verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true, premises: [{ questionSpan: questionText, basis: 'open_check', sourceId: null, supportQuote: null, supported: true }] };
}

test('common premise input provides only verified support-target labels and the exact approved open module purpose', () => {
  const { context, draft } = fixture();
  const authority = resolveVerifiedCommonPremiseAuthority(context, draft)!;
  const input = buildQuestionPremiseReviewInput(draft, [], undefined, undefined, [], authority);
  assert.equal(input.commonAuthority!.supportTarget.department, context.target.department);
  assert.equal(input.commonAuthority!.supportTarget.university, context.target.university);
  assert.equal(input.commonAuthority!.supportTarget.academicYear, context.target.year);
  assert.equal(input.commonAuthority!.supportTarget.id, context.school.interview!.id);
  assert.equal(input.commonAuthority!.module.questionIntent, draft.questionIntent);
  assert.deepEqual(input.commonAuthority!.module.targetEvidence, draft.targetEvidence);
  assert.equal(input.commonAuthority!.module.requiresOpenCheck, true);
  assert.equal(input.commonAuthority!.studentFactsAuthorized, false);
  assert.equal(input.commonAuthority!.scientificTruthAuthorized, false);
  assert.deepEqual(input.sources, []);
  assert.equal(JSON.stringify(input).includes(context.target.studentName), false);
  const output = openReview(draft.questionText);
  assert.equal(questionPremiseReviewWireSchema(input).safeParse(output).success, true);
  const result = finalizeQuestionPremiseReview(output, input, 'synthetic-independent-review');
  assert.equal(result.supportedPremises.length, 0);
  assert.equal(result.openChecks.length, 1);
  assert.throws(() => finalizeQuestionPremiseReview({ ...output, verdict: 'rewrite' }, input, 'test'), error => error instanceof QuestionValidationError && error.code === 'PREMISE_UNSUPPORTED', 'a common authority never automatically overrules the independent semantic rejection');
});

test('unknown common modules, stale approval revisions and unverified or cross-target school records fail before review', () => {
  const changes: Array<(context: InterviewContext, draft: QuestionDraft) => void> = [
    (_context, draft) => { draft.commonApproval!.moduleId = 'invented-module'; },
    (_context, draft) => { draft.commonApproval!.approvalRevision = 'old-guideline-revision'; },
    (context) => { context.school.department!.name = '다른학과'; },
    (context) => { context.school.interview!.academic_year--; },
    (context) => { context.manifest.recordIds.departmentId = 'other-department'; },
    (context) => { context.manifest.files.find(file => file.role === 'questionGuidelines')!.sha256 = digest('changed guideline'); },
    (context) => { context.manifest.files.find(file => file.role === 'departmentsJson')!.sha256 = null; },
    (context) => { context.errors.push('unverified source'); },
  ];
  for (const change of changes) {
    const { context, draft } = fixture(); change(context, draft);
    assert.throws(() => resolveVerifiedCommonPremiseAuthority(context, draft), error => error instanceof QuestionPremiseReviewError && error.invalidReason === 'COMMON_AUTHORITY_INVALID');
  }
});

test('serialized or mutated common authority is not a substitute for fresh server registry resolution', () => {
  const { context, draft } = fixture();
  const authority = resolveVerifiedCommonPremiseAuthority(context, draft)!;
  assert.throws(() => buildQuestionPremiseReviewInput(draft, [], undefined, undefined, [], structuredClone(authority)), QuestionPremiseReviewError);
  authority.supportTarget.department = '위조된 학과';
  assert.throws(() => buildQuestionPremiseReviewInput(draft, [], undefined, undefined, [], authority), QuestionPremiseReviewError);
  const fresh = resolveVerifiedCommonPremiseAuthority(context, draft)!;
  assert.throws(() => buildQuestionPremiseReviewInput({ ...draft, primaryFunction: 'ROLE' }, [], undefined, undefined, [], fresh), QuestionPremiseReviewError);
});

test('a common-module follow-up keeps module authority while using its own answer-grounded function and depth', () => {
  const { context, draft } = fixture();
  const followUp = { ...draft, questionKind: 'follow_up' as const, parentMainQuestionId: 'root', questionText: '실험이 적성에 맞는다고 말씀하신 판단 근거는 무엇인가요?', primaryFunction: 'VERIFY_CLAIM' as const, depth: 'D3' as const, questionIntent: '실험이 적성에 맞는다는 실제 답변 주장의 근거 확인', targetEvidence: ['실험 적성 판단의 실제 근거'] };
  const answer = { turnId: 'turn', answerId: 'answer', parentMainQuestionId: 'root', transcriptStatus: 'finalized' as const, text: '실험이 제 적성에 맞는다고 생각했습니다.' };
  const input = buildQuestionPremiseReviewInput(followUp, [], answer, undefined, [], resolveVerifiedCommonPremiseAuthority(context, followUp));
  assert.equal(input.commonAuthority!.module.primaryFunction, 'MOTIVE');
  assert.equal(input.question.primaryFunction, 'VERIFY_CLAIM');
  assert.equal(input.question.depth, 'D3');
  const output = { ...openReview(followUp.questionText), premises: [{ questionSpan: '실험이 적성에 맞는다고 말씀하신', basis: 'answer_turn_attributed', sourceId: input.answer!.id, supportQuote: answer.text, supported: true }] };
  assert.equal(questionPremiseReviewWireSchema(input).safeParse(output).success, true);
  assert.equal(finalizeQuestionPremiseReview(output, input, 'test').supportedPremises[0].sourceId, input.answer!.id);
});

test('private premise diagnostics retain selected logical proof quotes while masking credentials and excluding provider bodies', () => {
  const { context, draft } = fixture();
  const input = buildQuestionPremiseReviewInput(draft, [], undefined, undefined, [], resolveVerifiedCommonPremiseAuthority(context, draft));
  const secret = 'sk-explicit-test-credential-12345', old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = secret;
  try {
    const result = buildPremiseReviewDiagnostic({ ...draft, questionText: `${draft.questionText} ${secret}` }, input, openReview(draft.questionText));
    const serialized = JSON.stringify(result);
    assert.ok(serialized.includes('logicalReview'));
    assert.ok(serialized.includes(draft.questionText));
    assert.ok(serialized.includes('[redacted]'));
    assert.ok(!serialized.includes(secret));
    const malformed = buildPremiseReviewDiagnostic(draft, input, { ...openReview(draft.questionText), providerHeaders: { authorization: secret }, rawProviderBody: 'not a permitted logical review' }) as { logicalReview: unknown };
    assert.equal(malformed.logicalReview, null);
    assert.ok(!JSON.stringify(malformed).includes('rawProviderBody'));
    const failure = safeQuestionProviderFailure(Object.assign(new Error(`Bearer ${secret}`), { name: 'APIError', code: 'invalid_api_key', status: 401, response: { body: secret }, stack: secret }), 'premise_review');
    assert.deepEqual(failure, { stage: 'premise_review', errorClass: 'APIError', code: 'invalid_api_key', httpStatus: 401 });
    assert.ok(!JSON.stringify(failure).includes(secret));
    assert.deepEqual(safeQuestionProviderFailure(new Error('OBJECTIVE_CANDIDATE_MISMATCH'), 'question_contract'), { stage: 'question_contract', errorClass: 'Error', code: 'OBJECTIVE_CANDIDATE_MISMATCH', httpStatus: null });
  } finally {
    if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old;
  }
});
