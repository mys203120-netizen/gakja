import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { InterviewContext, StudentEvidence } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';
import type { PreparedActivities } from '../server/data/prepared-activities';
import { COMMON_OBJECTIVE_MODULE_VERSION, approveQuestionContract, assertQuestionContractIntegrity, bindQuestionContractToTurn, buildStudentTrajectory, createApprovedCommonObjectives, createQuestionBlueprint, createStudentObjectiveCandidates } from '../server/question-objective';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function source(id = 'source-a', text = '촉매반응의 원리를 조사하고 결과를 비교했다.', grade = 1): StudentEvidence {
  return { id, activityId: 'activity-' + id, text, grade, page: 1, title: '합성 테스트 자료', section: '교과세특', confirmationStatus: 'confirmed_from_record', preparationPriority: null, scientificTruthVerification: 'not_independently_verified', sourceRef: { file: 'synthetic.pdf', pdfSha256: 'synthetic-source-sha', page: 1, extraction: 'fixture', startOffset: 0, endOffset: text.length } };
}
function context(evidence = [source()]): InterviewContext { return { student: { evidence }, school: { sources: [] } } as unknown as InterviewContext; }
function session(turns: RecordedTurn[] = []): InterviewSession { return { id: 'synthetic-session', turns, followUpCountByMainQuestion: {}, elapsedMs: 0 } as InterviewSession; }
function draft(change: Partial<QuestionDraft> = {}): QuestionDraft {
  const text = '촉매반응을 조사할 때 실제로 거친 한 단계는 무엇인가요?';
  const value: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: text, questionKind: 'main', parentMainQuestionId: null, evidenceIds: ['source-a'], evidenceQuotes: [{ evidenceId: 'source-a', quote: source().text, sourceStartOffset: 0, sourceEndOffset: source().text.length }], primaryFunction: 'PROCESS', questionIntent: '기록된 수행 방법 한 단계를 확인한다.', targetEvidence: ['실제로 거친 방법 한 단계'], depth: 'D2', groundingRationale: '합성 원문에 직접 연결한 수행 확인이다.', validationStatus: 'approved', validationFailures: [], premiseValidation: { version: 'question-premise-v1', guidelineVersion: '2.3', status: 'approved', method: 'bounded_semantic_review', reviewModel: 'explicit-synthetic-review', questionSha256: hash(text), coreIntentCount: 1, supportedPremises: [], openChecks: [] }, ...change };
  if (change.questionText && !change.premiseValidation) value.premiseValidation = { ...value.premiseValidation!, questionSha256: hash(change.questionText) };
  return value;
}

test('student objective candidates retain exact original anchors and do not turn collective praise into personal achievement', () => {
  const team = source('team', '학급 공동 활동에서 의견을 나누고 협력하는 태도가 우수함.');
  const candidates = createStudentObjectiveCandidates(context([team]));
  const role = candidates.find(candidate => candidate.primaryFunction === 'ROLE')!;
  assert.ok(role.requiresOpenCheck);
  assert.ok(role.questionIntent.includes('단정하지 않고'));
  assert.ok(role.targetEvidence[0].includes('직접 한 행동'));
  assert.equal(candidates.some(candidate => candidate.primaryFunction === 'RESULT'), false);
  for (const candidate of candidates) {
    assert.equal(candidate.evidenceIds[0], team.id);
    assert.equal(team.text.slice(candidate.anchorRefs[0].start, candidate.anchorRefs[0].end), candidate.anchorQuote);
    assert.equal(candidate.anchorRefs[0].claimStatus, 'record_fact');
  }
});

test('objective depth follows actual demand instead of generic function defaults and stale activity caches are rejected', () => {
  const candidates = createStudentObjectiveCandidates(context());
  assert.equal(candidates.find(candidate => candidate.primaryFunction === 'CONCEPT')?.depth, 'D1');
  assert.equal(candidates.find(candidate => candidate.primaryFunction === 'LIMIT')?.depth, 'D4');
  const stale = { units: [{ sourceId: 'source-a', excerpt: '다른 원문', sourceRef: source().sourceRef }] } as unknown as PreparedActivities;
  assert.throws(() => createStudentObjectiveCandidates(context(), stale), /SOURCE_STALE/);
});

test('trajectory links are exact cross-grade possibilities and never assert causal growth', () => {
  const first = source('first', '촉매반응을 조사했다.', 1), later = source('later', '촉매반응을 비교했다.', 2);
  const links = buildStudentTrajectory(context([first, later]));
  // Korean inflection differences need not match; an explicit shared literal term does.
  const explicit = buildStudentTrajectory(context([source('a', 'DNA 자료를 조사했다.', 1), source('b', 'DNA 원리를 정리했다.', 2)]));
  assert.equal(explicit.length, 1);
  assert.equal(explicit[0].sharedTerm, 'DNA');
  assert.equal(explicit[0].status, 'possible_connection_not_causal_fact');
  assert.ok(links.every(link => link.status === 'possible_connection_not_causal_fact'));
  assert.equal(buildStudentTrajectory(context([source('a', '자료를 조사했다.', 1), source('b', '자료를 정리했다.', 2)])).length, 0);
});
test('explicit common modules supply only motivation/study-choice purposes with target and MD approval, never fake record evidence', () => {
  const approved = { ...context(), errors: [], target: { department: '합성 학과' }, school: { interview: { id: 'TARGET-A' }, sources: [] }, manifest: { errors: [], files: [{ role: 'questionGuidelines', sha256: 'a'.repeat(64) }] } } as unknown as InterviewContext;
  const common = createApprovedCommonObjectives(approved);
  assert.equal(common.length, 2);
  assert.deepEqual(common.map(objective => [objective.primaryFunction, objective.depth]), [['MOTIVE', 'D2'], ['CHOICE', 'D2']]);
  for (const objective of common) {
    assert.deepEqual(objective.evidenceIds, []); assert.deepEqual(objective.activityIds, []); assert.deepEqual(objective.anchorRefs, []); assert.deepEqual(objective.knownFacts, []);
    assert.equal(objective.grounding?.kind, 'COMMON_APPROVED');
    assert.equal(objective.moduleApproval?.moduleVersion, COMMON_OBJECTIVE_MODULE_VERSION);
    assert.equal(objective.moduleApproval?.questionGuidelinesSha256, 'a'.repeat(64));
    assert.equal(objective.supportTargetId, 'TARGET-A');
    assert.equal(/자기소개|마지막/u.test(objective.targetDescription), false);
  }
  assert.equal(createStudentObjectiveCandidates(approved).filter(objective => objective.originKind === 'common_approved').length, 2, 'legacy branch actually supplies the approved modules');
  const analysis = { ...approved, targetAnalysis: { objectives: [] } } as unknown as InterviewContext;
  assert.equal(createStudentObjectiveCandidates(analysis).length, 2, 'full-analysis branch actually supplies the approved modules');
  const changed = structuredClone(approved); changed.manifest.files[0].sha256 = 'b'.repeat(64);
  const newer = createApprovedCommonObjectives(changed);
  assert.equal(newer[0].semanticKey, common[0].semanticKey, 'a revision change does not pretend the confirmation purpose is new');
  assert.notEqual(newer[0].grounding, common[0].grounding);
  changed.school.interview!.id = 'TARGET-B';
  assert.notEqual(createApprovedCommonObjectives(changed)[0].id, common[0].id);
});

test('final question contracts freeze the actual utterance, requirements, review and approval flags', () => {
  const question = draft();
  const blueprint = createQuestionBlueprint(question, context(), session(), { questionId: 'offline-question' });
  const approved = approveQuestionContract(question, blueprint, { policyDigest: 'synthetic-policy' });
  assert.ok(Object.isFrozen(approved.blueprint.target));
  assert.equal(approved.validation.independentSemanticReview, true);
  assertQuestionContractIntegrity(question, approved);
  for (const changed of [{ ...question, questionText: question.questionText + ' 왜인가요?' }, { ...question, targetEvidence: ['묻지 않은 성과'] }, { ...question, depth: 'D4' as const }]) assert.throws(() => assertQuestionContractIntegrity(changed, approved), /MUTATED/);
  const changedApproval = structuredClone(approved); changedApproval.validation.residualSemanticRisk = true;
  assert.throws(() => assertQuestionContractIntegrity(question, changedApproval), /MUTATED/);
});

test('a final Q0 may cite a reviewed subset of allowed context but cannot introduce another objective source', () => {
  const question = draft(), allowed = source('source-b', '추가로 연결된 같은 활동의 원문이다.');
  const c = context([source(), allowed, source('foreign', '다른 목표의 근거다.')]);
  const candidate = createStudentObjectiveCandidates(c).find(candidate => candidate.primaryFunction === 'PROCESS')!;
  candidate.evidenceIds = ['source-a', 'source-b'];
  candidate.primaryFunction = question.primaryFunction; candidate.depth = question.depth;
  assert.doesNotThrow(() => createQuestionBlueprint(question, c, session(), { objectiveCandidate: candidate }));
  const foreign = source('foreign', '다른 목표의 근거다.');
  const escaped = draft({ evidenceIds: ['foreign'], evidenceQuotes: [{ evidenceId: 'foreign', quote: foreign.text }] });
  assert.throws(() => createQuestionBlueprint(escaped, c, session(), { objectiveCandidate: candidate }), /CANDIDATE_MISMATCH/);
});

test('cached main question binds actual turn IDs without changing its reviewed meaning or inventing a second review', () => {
  const question = draft();
  const blueprint = createQuestionBlueprint(question, context(), session(), { questionId: 'offline-question' });
  const approvedQuestion = approveQuestionContract(question, blueprint);
  const bound = bindQuestionContractToTurn({ ...question, questionBlueprint: blueprint, approvedQuestion }, context(), session(), 'actual-main-id');
  assert.equal(bound.questionBlueprint.questionId, 'actual-main-id');
  assert.equal(bound.questionBlueprint.clusterId, 'actual-main-id');
  assert.equal(bound.questionBlueprint.clusterObjective.id, blueprint.clusterObjective.id);
  assert.equal(bound.approvedQuestion.reviewTraceSha256, approvedQuestion.reviewTraceSha256);
  assertQuestionContractIntegrity(question, bound.approvedQuestion);
});

test('follow-up blueprint requires same-root subordination and real finalized answer references even when no quote is spoken', () => {
  const main = draft(), blueprint = createQuestionBlueprint(main, context(), session(), { questionId: 'main' });
  const rawTranscript = '인터넷 자료를 찾아봤습니다.';
  const root = { id: 'main', parentMainQuestionId: 'main', questionKind: 'main', questionText: main.questionText, evidenceIds: main.evidenceIds, answerId: 'answer', rawTranscript, transcriptStatus: 'finalized', metadata: { ...main, questionBlueprint: blueprint } } as unknown as RecordedTurn;
  const active = session([root]);
  const follow = draft({ questionKind: 'follow_up', parentMainQuestionId: 'main', questionText: '그 판단을 뒷받침한 근거는 무엇인가요?', primaryFunction: 'VERIFY_CLAIM', questionIntent: '실제 발화에서 말한 판단 근거 한 가지를 확인한다.', targetEvidence: ['판단의 근거 한 가지'] });
  follow.premiseValidation!.method = 'constrained_answer_follow_up';
  assert.throws(() => createQuestionBlueprint(follow, context(), active, { subordinationRationale: '원래 수행 확인 목적에 필요한 직접 근거' }), /ANSWER_SOURCE_MISSING/);
  const options = { answerRefs: [{ turnId: 'main', answerId: 'answer', start: 0, end: rawTranscript.length }], subordinationRationale: '원래 수행 확인 목적에 필요한 직접 근거' };
  const followBlueprint = createQuestionBlueprint(follow, context(), active, options);
  assert.equal(followBlueprint.clusterObjective.id, blueprint.clusterObjective.id);
  assert.equal(followBlueprint.parentQuestionId, 'main');
  assert.equal(followBlueprint.answerTurnId, 'main');
  assert.equal(followBlueprint.anchorRefs.find(ref => ref.kind === 'ANSWER_TURN')?.claimStatus, 'student_claim_unverified');
  const approved = approveQuestionContract(follow, followBlueprint);
  assert.equal(approved.validation.independentSemanticReview, false);
  assert.equal(approved.validation.residualSemanticRisk, true);
  assert.throws(() => createQuestionBlueprint(follow, context(), active, { ...options, answerRefs: [{ ...options.answerRefs[0], answerId: 'wrong-answer' }] }), /ANSWER_REF_INVALID/);
});
