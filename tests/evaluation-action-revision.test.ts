import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';
import { approveQuestionContract, assertQuestionContractIntegrity, createQuestionBlueprint } from '../server/question-objective';
import { buildEvaluationUnits, assertEvaluationQuestionContracts } from '../server/providers/evaluation-turns';
import { aggregateSessionEvaluation } from '../server/providers/evaluation-aggregation';
import { assertRepairProof, createRepairCheck, createRepairContract, repairContractHash } from '../server/providers/repair-contract';
import { reviewedRecordEvaluationFixture } from './fixtures/reviewed-evaluation-knowledge';
import { createEvaluationActionRevision, applyEvaluationActionRevision, evaluateSessionWithActionRevision,
  assertEvaluationActionProjectionProvenance, type EvaluationActionProjection,
  type EvaluationActionReview } from '../server/providers/evaluation-action-revision';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sourceText = '모둠 탐구에서 온도를 측정하고 결과를 기록함.';
const context = { manifest: { files: [] }, target: {}, evaluationGuidelines: '합성 평가 기준', questionGuidelines: '합성 질문 기준',
  school: { schoolReferenceId: 'synthetic-school', sources: [] }, student: { evidence: [{
    id: 'source-1', activityId: 'activity-1', page: 1, text: sourceText,
    sourceRef: { pdfSha256: 'a'.repeat(64), page: 1, startOffset: 0, endOffset: sourceText.length },
    scientificTruthVerification: 'not_independently_verified',
  }] } } as unknown as InterviewContext;
function session(): InterviewSession {
  return { id: 'synthetic-action-revision', status: 'ending', evaluationStatus: 'failed', createdAt: '2026-11-04T00:00:00.000Z',
    turns: [], questionPresentations: [], followUpCountByMainQuestion: {}, elapsedMs: 20000,
    sourceManifest: { source: 'explicit-synthetic-fixture' }, metrics: {} } as unknown as InterviewSession;
}
function addTurn(value: InterviewSession, id: string, kind: 'main' | 'follow_up', root: string, questionText: string, answer: string) {
  const previous = value.turns.at(-1);
  const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText, questionKind: kind,
    parentMainQuestionId: kind === 'main' ? null : root, evidenceIds: ['source-1'],
    evidenceQuotes: [{ evidenceId: 'source-1', quote: sourceText, sourceStartOffset: 0, sourceEndOffset: sourceText.length }],
    primaryFunction: kind === 'main' ? 'ROLE' : 'CLARIFY_CONTENT', depth: 'D2',
    questionIntent: kind === 'main' ? '본인이 직접 한 실제 행동 확인' : '직전 답변의 추가 확인 지점',
    targetEvidence: [kind === 'main' ? '본인이 직접 한 행동 한 가지' : '새로 확인할 구체적 지점'],
    groundingRationale: '합성 기록과 확정 답변을 근거로 한다.', validationStatus: 'approved', validationFailures: [],
    premiseValidation: { version: 'question-premise-v1', guidelineVersion: '2.3', status: 'approved', method: 'bounded_semantic_review',
      questionSha256: hash(questionText), reviewModel: 'explicit-synthetic-review', coreIntentCount: 1,
      supportedPremises: [], openChecks: [{ questionStartOffset: 0, questionEndOffset: questionText.length, kind: 'open_check' }] },
  };
  const blueprint = createQuestionBlueprint(draft, context, value, { questionId: id,
    ...(kind === 'follow_up' ? { subordinationRationale: '합성 답변에서 필요한 한 지점을 확인한다.',
      answerRefs: [{ turnId: previous!.id, answerId: previous!.answerId!, start: 0, end: previous!.rawTranscript!.length }] } : {}) });
  draft.questionBlueprint = blueprint; draft.approvedQuestion = approveQuestionContract(draft, blueprint);
  const turn = { ...draft, id, questionKind: kind, parentMainQuestionId: root,
    metadata: { ...draft, rulesVersion: 'synthetic', activityIds: ['activity-1'], answerTurnId: previous?.id ?? null },
    answerId: 'answer-' + id, rawTranscript: answer, transcriptStatus: 'finalized', followUpIndex: kind === 'main' ? 0 : id === 'f2' ? 2 : 1,
  } as unknown as RecordedTurn;
  value.turns.push(turn);
  value.questionPresentations!.push({ turnId: id, rootTurnId: root, questionKind: kind, clockId: 'synthetic-clock', startedAtMs: 100, completedAtMs: 200 });
  value.followUpCountByMainQuestion[root] = value.turns.filter(item => item.parentMainQuestionId === root && item.questionKind === 'follow_up').length;
}
function fixture(f2 = false) {
  const value = session();
  addTurn(value, 'q0', 'main', 'q0', '탐구에서 본인이 직접 한 일은 무엇인가요?', '탐구에 열심히 참여했습니다.');
  addTurn(value, 'f1', 'follow_up', 'q0', '그 탐구에서 본인이 맡아 한 일은 무엇인가요?', '온도를 측정하고 기록했습니다.');
  if (f2) addTurn(value, 'f2', 'follow_up', 'q0', '온도를 측정할 때 간격을 정한 기준은 무엇인가요?', '변화를 비교하려고 같은 간격으로 정했습니다.');
  addTurn(value, 'q1', 'main', 'q1', '다른 탐구에서 본인이 직접 한 일은 무엇인가요?', '자료를 분류했습니다.');
  return value;
}
function review(value: InterviewSession): EvaluationActionReview {
  const original = value.turns[0], changed = value.turns[1];
  return { reviewerAuthority: 'developer_review', reviewerId: 'explicit-synthetic-reviewer', reviewedAt: '2026-11-04T01:00:00.000Z',
    reason: '두 질문의 실제 요구가 같은 전체 역할 확인이라는 명시적 검토 결과다.',
    changes: [{ turnId: changed.id, sourceAnswerId: changed.answerId!, originalKind: 'follow_up', correctedKind: 'clarification',
      clarificationOfTurnId: original.id, reason: '새 평가 지점 없이 본인의 전체 행동을 다시 요구한 재진술이다.',
      reviewedSpans: [
        { kind: 'question', turnId: original.id, start: 0, end: original.questionText.length, quote: original.questionText },
        { kind: 'question', turnId: changed.id, start: 0, end: changed.questionText.length, quote: changed.questionText },
        { kind: 'answer', turnId: original.id, start: 0, end: original.rawTranscript!.length, quote: original.rawTranscript! },
      ] }] };
}

function repairedFixture() {
  const value = fixture(true), turn = value.turns[1];
  const draft: QuestionDraft = { ...turn.metadata, acknowledgement: null, acknowledgementQuote: null,
    questionText: turn.questionText, questionKind: turn.questionKind,
    parentMainQuestionId: turn.parentMainQuestionId, evidenceIds: [...turn.evidenceIds] };
  const repairContract = createRepairContract({ ...draft, questionText: '그 탐구에서 본인이 직접 맡은 일은 무엇인가요?' });
  draft.premiseValidation = { ...draft.premiseValidation!, method: 'bounded_fact_review',
    semanticAuthority: 'single_core', coreIntentCountAuthority: 'single_core_single_target_contract',
    repairCheck: createRepairCheck(repairContract, draft, 'same') };
  draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint!, { repairContract });
  Object.assign(turn.metadata, { premiseValidation: draft.premiseValidation, approvedQuestion: draft.approvedQuestion });
  return value;
}

test('a repaired F1 can receive a separately authorized evaluation projection while its runtime proof remains immutable', () => {
  const original = repairedFixture(), before = JSON.stringify(original);
  const originalProof = original.turns[1].metadata.premiseValidation!.repairCheck!;
  const revision = createEvaluationActionRevision(context, original, review(original));
  const projected = applyEvaluationActionRevision(context, original, revision), { session: projection, audit } = projected;
  assert.equal(JSON.stringify(original), before);
  assert.deepEqual(original.turns[1].metadata.premiseValidation!.repairCheck, originalProof);
  assertRepairProof({ ...original.turns[1].metadata, acknowledgement: null, acknowledgementQuote: null,
    questionText: original.turns[1].questionText, questionKind: 'follow_up', parentMainQuestionId: 'q0', evidenceIds: ['source-1'] });
  assert.equal(projection.turns[1].questionKind, 'clarification');
  assert.equal(projection.turns[1].metadata.premiseValidation!.repairCheck, undefined);
  assert.equal(projection.turns[1].metadata.premiseValidation!.semanticAuthority, undefined);
  assert.equal(projection.turns[1].metadata.premiseValidation!.coreIntentCountAuthority, undefined);
  assert.deepEqual(projection.turns[1].metadata.premiseValidation!.supportedPremises, original.turns[1].metadata.premiseValidation!.supportedPremises);
  assert.deepEqual(projection.turns[1].metadata.premiseValidation!.openChecks, original.turns[1].metadata.premiseValidation!.openChecks);
  const snapshot = audit.contractRevisions[0].runtimeApproval;
  assert.deepEqual(snapshot.draft.premiseValidation!.repairCheck, originalProof);
  assert.notEqual(snapshot.draft.premiseValidation!.repairCheck, originalProof);
  assert.deepEqual(snapshot.approvedQuestion, original.turns[1].metadata.approvedQuestion);
  assertQuestionContractIntegrity(snapshot.draft, snapshot.approvedQuestion);
  assert.ok(Object.isFrozen(snapshot.draft.premiseValidation!.repairCheck!.contract));
  assert.ok(Object.isFrozen(snapshot.approvedQuestion));
  assert.deepEqual(audit.contractRevisions[0].authorization, { revisionId: revision.revisionId,
    revisionSha256: revision.contentSha256, originalDraftSha256: hash(JSON.stringify(snapshot.draft)),
    originalRepairCheckSha256: hash(JSON.stringify(originalProof)), clarificationTargetTurnId: 'q0',
    clarificationTargetContractSha256: original.turns[0].metadata.approvedQuestion!.contentSha256 });
  assert.equal(audit.projectedSessionContentSha256, hash(JSON.stringify(projection)));
  assertEvaluationActionProjectionProvenance(context, original, revision, JSON.parse(JSON.stringify(projected)) as EvaluationActionProjection);
  assertEvaluationQuestionContracts(projection);
  assert.deepEqual(buildEvaluationUnits(projection).scoredUnits[0].answerAttempts.map(attempt => attempt.sourceTurnId), ['q0', 'f1']);
  const result = aggregateSessionEvaluation(projection, [
    { turnId: 'q0', status: 'SATISFIED', score: 80 }, { turnId: 'f2', status: 'SATISFIED', score: 90 }, { turnId: 'q1', status: 'SATISFIED', score: 70 },
  ]);
  assert.deepEqual(result.clusterScores[0].members.map(member => member.weight), [0.7, 0.3]);
  assert.equal(result.clusterScores[0].score, 83);
  assert.deepEqual(projection.turns.map(turn => [turn.id, turn.answerId, turn.questionText, turn.rawTranscript, turn.questionAudioUrl]),
    original.turns.map(turn => [turn.id, turn.answerId, turn.questionText, turn.rawTranscript, turn.questionAudioUrl]));
  assert.deepEqual(projection.questionPresentations!.map(presentation => ({ ...presentation, questionKind: undefined })),
    original.questionPresentations!.map(presentation => ({ ...presentation, questionKind: undefined })));
  const invalidRuntimeReuse: QuestionDraft = { ...snapshot.draft, questionKind: 'clarification',
    primaryFunction: projection.turns[1].metadata.primaryFunction, targetEvidence: projection.turns[1].metadata.targetEvidence };
  assert.throws(() => approveQuestionContract(invalidRuntimeReuse, projection.turns[1].metadata.questionBlueprint!), /REPAIR_PROOF_INVALID/u);
});

test('projection provenance rejects replaced or locally rehashed runtime proof, revision, target and historical timing', () => {
  const original = repairedFixture(), revision = createEvaluationActionRevision(context, original, review(original));
  const projected = applyEvaluationActionRevision(context, original, revision);
  const tamper: Array<(value: EvaluationActionProjection) => void> = [
    value => {
      const row = value.audit.contractRevisions[0], proof = row.runtimeApproval.draft.premiseValidation!.repairCheck!;
      proof.contract = { ...proof.contract, action: 'CLARIFICATION' };
      proof.contractSha256 = repairContractHash(proof.contract);
      row.authorization.originalRepairCheckSha256 = hash(JSON.stringify(proof));
      row.authorization.originalDraftSha256 = hash(JSON.stringify(row.runtimeApproval.draft));
    },
    value => {
      const row = value.audit.contractRevisions[0];
      delete row.runtimeApproval.draft.premiseValidation!.repairCheck;
      row.authorization.originalRepairCheckSha256 = null;
      row.authorization.originalDraftSha256 = hash(JSON.stringify(row.runtimeApproval.draft));
    },
    value => { value.audit.contractRevisions[0].authorization.revisionSha256 = 'b'.repeat(64); },
    value => {
      const authorization = value.audit.contractRevisions[0].authorization;
      authorization.clarificationTargetTurnId = 'q1';
      authorization.clarificationTargetContractSha256 = original.turns.at(-1)!.metadata.approvedQuestion!.contentSha256;
    },
    value => {
      value.session.questionPresentations![1].completedAtMs! += 1;
      value.audit.projectedSessionContentSha256 = hash(JSON.stringify(value.session));
    },
    value => {
      value.session.turns[1].rawTranscript += ' 추가하지 않은 발화';
      value.audit.projectedSessionContentSha256 = hash(JSON.stringify(value.session));
    },
  ];
  for (const mutate of tamper) {
    const changed = structuredClone(projected); mutate(changed);
    assert.throws(() => assertEvaluationActionProjectionProvenance(context, original, revision, changed), /PROJECTION_PROVENANCE_INVALID/u);
  }
  const brokenOriginal = structuredClone(repairedFixture());
  brokenOriginal.turns[1].metadata.premiseValidation!.repairCheck!.contractSha256 = 'c'.repeat(64);
  assert.throws(() => createEvaluationActionRevision(context, brokenOriginal, review(brokenOriginal)), /REPAIR_PROOF_INVALID/u);
});

test('a reviewed evaluation projection preserves the original Q/A and contracts while rebinding F as a non-evaluative restatement', () => {
  const original = fixture(), before = JSON.stringify(original);
  const revision = createEvaluationActionRevision(context, original, review(original));
  assert.ok(Object.isFrozen(revision.changes[0].reviewedSpans[0]));
  const { session: projection, audit } = applyEvaluationActionRevision(context, original, revision);
  assert.equal(JSON.stringify(original), before);
  assert.equal(original.turns[1].questionKind, 'follow_up');
  assert.equal(projection.turns[1].questionKind, 'clarification');
  assert.equal(projection.turns[1].metadata.clarificationOfTurnId, 'q0');
  assert.equal(projection.turns[1].metadata.primaryFunction, 'ROLE');
  assert.equal(projection.turns[1].metadata.depth, original.turns[0].metadata.depth);
  assert.deepEqual(projection.turns[1].metadata.targetEvidence, original.turns[0].metadata.targetEvidence);
  assert.deepEqual(projection.turns.map(turn => [turn.id, turn.answerId, turn.questionText, turn.rawTranscript]),
    original.turns.map(turn => [turn.id, turn.answerId, turn.questionText, turn.rawTranscript]));
  assert.equal(projection.questionPresentations![1].questionKind, 'clarification');
  assert.equal(projection.questionPresentations![1].startedAtMs, original.questionPresentations![1].startedAtMs);
  assert.notEqual(projection.turns[1].metadata.approvedQuestion!.contentSha256, original.turns[1].metadata.approvedQuestion!.contentSha256);
  assert.equal(projection.turns[1].metadata.approvedQuestion!.validation.independentSemanticReview, false);
  assertEvaluationQuestionContracts(projection);
  assert.equal(audit.revisionId, revision.revisionId); assert.equal(audit.evaluationOnly, true);
});

test('the same reviewed rephrase loses its F weight and its actual answer joins the original question', () => {
  const original = fixture();
  const { session: projection } = applyEvaluationActionRevision(context, original, createEvaluationActionRevision(context, original, review(original)));
  const units = buildEvaluationUnits(projection);
  assert.deepEqual(units.scoredUnits.map(unit => unit.turn.id), ['q0', 'q1']);
  assert.deepEqual(units.scoredUnits[0].answerAttempts.map(attempt => attempt.sourceTurnId), ['q0', 'f1']);
  const result = aggregateSessionEvaluation(projection, [
    { turnId: 'q0', status: 'SATISFIED', score: 80 }, { turnId: 'q1', status: 'SATISFIED', score: 70 },
  ]);
  assert.deepEqual(result.clusterScores[0].members.map(member => member.weight), [1]);
  assert.equal(result.clusterScores[0].score, 80); assert.equal(result.sessionScore, 75);
});

test('a later genuine F2 becomes the first remaining F with 30 percent weight without changing its source or spoken words', () => {
  const original = fixture(true);
  const { session: projection, audit } = applyEvaluationActionRevision(context, original, createEvaluationActionRevision(context, original, review(original)));
  assert.equal(projection.turns[2].questionKind, 'follow_up'); assert.equal(projection.turns[2].followUpIndex, 1);
  assert.equal(original.turns[2].followUpIndex, 2); assert.equal(projection.followUpCountByMainQuestion.q0, 1);
  assert.deepEqual(audit.followUpOrdinals.find(row => row.turnId === 'f2'), { turnId: 'f2', originalIndex: 2, revisedIndex: 1 });
  const result = aggregateSessionEvaluation(projection, [
    { turnId: 'q0', status: 'SATISFIED', score: 80 }, { turnId: 'f2', status: 'SATISFIED', score: 90 }, { turnId: 'q1', status: 'SATISFIED', score: 70 },
  ]);
  assert.deepEqual(result.clusterScores[0].members.map(member => member.weight), [0.7, 0.3]);
  assert.equal(result.clusterScores[0].score, 83);
});

test('wrong spans, source answer IDs, cross-cluster lineage and forward links cannot create a reviewed correction', () => {
  const original = fixture();
  const badSpan = review(original); badSpan.changes[0].reviewedSpans[0].quote = '원문에 없는 문장';
  assert.throws(() => createEvaluationActionRevision(context, original, badSpan), /SPAN_INVALID/u);
  const badAnswer = review(original); badAnswer.changes[0].sourceAnswerId = 'other-answer';
  assert.throws(() => createEvaluationActionRevision(context, original, badAnswer), /BINDING_INVALID/u);
  const forward = review(original); forward.changes[0].clarificationOfTurnId = 'q1';
  assert.throws(() => createEvaluationActionRevision(context, original, forward), /BINDING_INVALID/u);
  const duplicate = review(original); duplicate.changes.push(structuredClone(duplicate.changes[0]));
  assert.throws(() => createEvaluationActionRevision(context, original, duplicate), /LINEAGE_INVALID/u);
  const active = fixture(); active.status = 'active';
  assert.throws(() => createEvaluationActionRevision(context, active, review(active)), /SESSION_NOT_ENDED/u);
});

test('a changed transcript, original approval, context source, review revision or replayed projection is rejected', () => {
  const original = fixture(), revision = createEvaluationActionRevision(context, original, review(original));
  const changedAnswer = structuredClone(original); changedAnswer.turns[0].rawTranscript += ' 달라진 말';
  assert.throws(() => applyEvaluationActionRevision(context, changedAnswer, revision), /SOURCE_CHANGED/u);
  const changedContext = structuredClone(context); changedContext.student.evidence[0].text += ' 다른 사실';
  assert.throws(() => applyEvaluationActionRevision(changedContext, original, revision), /SOURCE_CHANGED/u);
  const changedRevision = structuredClone(revision); changedRevision.changes[0].reviewedSpans[0].start = 2;
  assert.throws(() => applyEvaluationActionRevision(context, original, changedRevision), /SOURCE_CHANGED/u);
  const projection = applyEvaluationActionRevision(context, original, revision);
  assert.throws(() => applyEvaluationActionRevision(context, projection.session, revision), /SOURCE_CHANGED/u);
});

test('resigning an outer revision digest cannot authorize a stale proof revision or fabricated source span', () => {
  const original = fixture();
  const revision = structuredClone(createEvaluationActionRevision(context, original, review(original)));
  revision.changes[0].sourceProofs[0].revision = 'b'.repeat(64);
  const { revisionId: _id, contentSha256: _digest, ...body } = revision;
  void _id; void _digest;
  revision.contentSha256 = hash(JSON.stringify(body)); revision.revisionId = 'EVAL-ACTION-REV-' + revision.contentSha256.slice(0, 24);
  assert.throws(() => applyEvaluationActionRevision(context, original, revision), /PROOF_CHANGED/u);
});

test('the explicit evaluation entry point accepts a repaired correction without a second classifier or original mutation', async () => {
  const original = repairedFixture(), before = JSON.stringify(original), revision = createEvaluationActionRevision(context, original, review(original));
  const approved = reviewedRecordEvaluationFixture(context, applyEvaluationActionRevision(context, original, revision).session);
  let calls = 0;
  const result = await evaluateSessionWithActionRevision(approved.context, original, revision, { requestEvaluation: async request => {
    calls++;
    const input = JSON.parse(request.input) as { answers: Array<{ id: string; answerAttempts: Array<{ sourceTurnId: string; rawTranscript: string }> }> };
    return { summary: '합성 평가', languageClassifications: [], answers: input.answers.map(answer => {
      const quote = answer.answerAttempts.at(-1)!.rawTranscript, axis = { anchor: 3, quote, rationale: '실제 질문의 역할 요구에 답한 행동이다.' };
      return { turnId: answer.id, status: 'SATISFIED', deferredReason: null, axes: { I: axis, A: axis, S: axis, R: axis, C: axis },
        verifiedCoreError: false, verifiedCoreErrorEvidence: null, strengths: [], improvements: [], conflictNeedsReview: [], deliveryCoaching: [], strategyCoaching: [] };
    }) };
  } });
  assert.equal(calls, 2); assert.equal(result.answers.length, 3);
  assert.equal(result.answers[0].quoteSources.I?.sourceTurnId, 'f1');
  assert.deepEqual(result.clusterScores[0].members.map(member => member.weight), [0.7, 0.3]);
  assert.equal(result.evaluationActionRevision.revisionId, revision.revisionId);
  assert.equal(JSON.stringify(original), before);
});
