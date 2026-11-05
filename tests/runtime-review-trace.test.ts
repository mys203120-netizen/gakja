import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeReviewPayload, approveNaturalQuestion, naturalCoreWireSchema, NaturalQuestionDecisionError, type NaturalCoreOutput, type NaturalReviewTrace } from '../server/providers/natural-question';
import { buildQuestionPremiseReviewInput, buildStablePremiseProofOptions } from '../server/providers/question-premises';
import type { InterviewContext, StudentEvidence } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';

function fixture() {
  const source = { id: 'E01', activityId: 'A01', text: 'PRIVATE_RECORD_SENTINEL. 자료를 선택해 비교하는 탐구를 진행함.', sourceRef: { pdfSha256: 'a'.repeat(64), page: 1, file: 'synthetic.pdf', extraction: 'synthetic', startOffset: 0, endOffset: 53 }, confirmationStatus: 'confirmed_from_record', scientificTruthVerification: 'not_independently_verified' } as StudentEvidence;
  const draft = { questionText: '자료를 비교한 과정은 무엇인가요?', questionKind: 'main', parentMainQuestionId: null, acknowledgement: null, acknowledgementQuote: null, evidenceIds: ['E01'], evidenceQuotes: [{ evidenceId: 'E01', quote: source.text }], primaryFunction: 'PROCESS', questionIntent: '실제로 진행한 자료 비교 과정 확인', targetEvidence: ['실제로 거친 한 단계'], depth: 'D2', groundingRationale: '기록된 비교 행동을 확인한다.', validationStatus: 'approved', validationFailures: [] } as QuestionDraft;
  const turn = { id: 'q0', answerId: 'a0', parentMainQuestionId: 'q0', mainIndex: 1, mainCount: 5, questionKind: 'main', questionText: draft.questionText, questionAudioUrl: '/api/audio/synthetic-question', acknowledgement: null, acknowledgementAudioUrl: null, interviewerId: 'interviewer-1', followUpIndex: 0, evidenceIds: draft.evidenceIds, rawTranscript: '자료를 비교했습니다. PRIVATE_ANSWER_SENTINEL', transcriptStatus: 'finalized', metadata: { ...draft, rulesVersion: 'synthetic', generatedAt: '2026-01-01T00:00:00.000Z', answerTurnId: null, sourceRefIds: ['E01'], supportTarget: null, parentQuestionId: null, questionClusterId: 'q0', activityIds: ['A01'] } } as RecordedTurn;
  const context = { questionReferences: null, questionStrategies: null, errors: [], student: { evidence: [source] }, school: { sources: [] }, manifest: { rulesVersion: 'synthetic', files: [{ role: 'studentPdf', path: 'synthetic.pdf', sha256: source.sourceRef.pdfSha256 }] } } as unknown as InterviewContext;
  const session = { id: 'synthetic-review-trace', sourceManifest: context.manifest, turns: [turn], followUpCountByMainQuestion: {}, elapsedMs: 0, durationSeconds: 720 } as unknown as InterviewSession;
  const output: NaturalCoreOutput = { answerRelation: { kind: 'related', note: '비교의 기준이 불명확하다.' }, interpretation: { meaning: '자료를 비교했다고 말했다.', dialogueRequests: [], covered: [], unresolved: [], corrections: [], uncertainty: [] }, decision: { fulfillment: 'partial', action: 'FOLLOW_UP', reason: 'missing_requested_detail', necessity: '실제 비교에 사용한 기준 한 가지를 확인한다.', reaction: null, question: { text: '자료를 비교할 때 어떤 기준을 사용했나요?', intent: '실제로 자료를 비교한 구체적인 기준 확인', target: '자료 비교에 실제 사용한 판단 기준', primaryFunction: 'CHOICE', depth: 'D2', answerQuote: '자료를 비교했습니다.', strategyId: null, matchedEstablishedTargetIds: [] } } };
  return { source, draft, turn, context, session, output };
}
const purpose = { subordinateToCluster: true, hasAdditionalVerificationValue: true, repeatedEstablishedTargetIds: [] };
const reviewBase = { verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true, runtimePurpose: purpose };

test('runtime proof offsets preserve complete source and answer qualifiers without duplicating quote strings', () => {
  const f = fixture();
  const draft = { ...f.draft, questionKind: 'follow_up' as const, parentMainQuestionId: 'q0' };
  const input = buildQuestionPremiseReviewInput(draft, [{ id: 'E01', text: f.source.text }], { turnId: 'q0', answerId: 'a0', parentMainQuestionId: 'q0', transcriptStatus: 'finalized', text: '본인이\n  직접 자료를 비교했습니다.' });
  const payload = buildRuntimeReviewPayload(input);
  const originals = new Map([...payload.sources, payload.answer!].map(s => [s.id, s.text]));
  const old = buildStablePremiseProofOptions(input);
  assert.equal(payload.sources[0].text, f.source.text);
  assert.equal(payload.answer!.text, '본인이\n  직접 자료를 비교했습니다.');
  assert.equal(payload.proofChoices.length, old.length);
  for (const proof of payload.proofChoices) {
    const original = originals.get(proof.sourceId)!;
    const quote = old.find(p => p.proofId === proof.proofId)!;
    assert.equal(original.slice(proof.startOffset, proof.endOffset).replace(/\s+/gu, ' ').trim(), quote.supportQuote);
    assert.equal(proof.basis, quote.basis);
    assert.ok(!('supportQuote' in proof));
  }
});

test('rejected review records the exact unsupported question span with hashes but no source or answer body', async () => {
  const f = fixture(); let trace: NaturalReviewTrace | undefined;
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, { requestReview: async input => ({ ...reviewBase, premises: [{ questionSpan: '자료를', basis: 'record', proofId: buildStablePremiseProofOptions(input)[0].proofId, supported: false }] }), onReviewTrace: t => { trace = t; } }));
  assert.equal(trace?.schemaValid, true);
  assert.equal(trace?.verdict, 'allowed');
  assert.equal(trace?.accepted, false);
  assert.equal(trace?.failureCode, 'PREMISE_UNSUPPORTED');
  assert.equal(trace?.rejectReason, 'unsupported_question_span');
  assert.equal(trace?.premises[0].questionSpan, '자료를');
  assert.match(trace!.premises[0].sourceQuoteSha256!, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(trace), /PRIVATE_RECORD_SENTINEL|PRIVATE_ANSWER_SENTINEL|supportQuote|instructions|apiKey/u);
});

test('invalid proof and unknown source cannot gain approval through the trace path', async () => {
  const f = fixture(); let trace: NaturalReviewTrace | undefined;
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, { requestReview: async () => ({ ...reviewBase, premises: [{ questionSpan: '자료를', basis: 'record', proofId: 'P99999', supported: true }] }), onReviewTrace: t => { trace = t; } }));
  assert.equal(trace?.accepted, false);
  assert.equal(trace?.failureCode, 'PREMISE_REVIEW_INVALID');
  assert.equal(trace?.invalidReason, 'UNKNOWN_PROOF_ID');
});

test('a failing private trace consumer does not change independent approval', async () => {
  const f = fixture(); let trace: NaturalReviewTrace | undefined;
  const approved = await approveNaturalQuestion(f.context, f.session, f.output, { requestReview: async input => ({ ...reviewBase, premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }), onReviewTrace: t => { trace = t; throw new Error('synthetic diagnostic failure'); } });
  assert.equal(trace?.accepted, true);
  assert.equal(approved.premiseValidation?.status, 'approved');
  assert.equal(approved.providerTimings?.runtimeReviewWire, 3);
});

test('follow-up independent review receives the actual spoken question rather than a generator-only objective', async () => {
  const f = fixture();
  let observed = false;
  await approveNaturalQuestion(f.context, f.session, f.output, { requestReview: async input => {
    observed = true;
    assert.equal(input.originalQuestion?.questionText, f.turn.questionText);
    assert.equal(input.originalQuestion?.questionIntent, f.turn.metadata.questionIntent);
    assert.deepEqual(input.originalQuestion?.targetEvidence, f.turn.metadata.targetEvidence);
    assert.equal(input.answer?.text, f.turn.rawTranscript);
    return { ...reviewBase, premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] };
  } });
  assert.equal(observed, true);
});

test('the actual generation grammar enforces separate F75 and rephrase80 speech budgets', () => {
  const f = fixture();
  f.output.decision.question!.text = '가'.repeat(75) + '?';
  assert.equal(naturalCoreWireSchema.safeParse(f.output).success, false, '76-character F must not be generated');
  f.output.decision.action = 'CLARIFICATION';
  f.output.decision.question!.text = '가'.repeat(79) + '?';
  assert.equal(naturalCoreWireSchema.safeParse(f.output).success, true);
  f.output.decision.question!.text += '요';
  assert.equal(naturalCoreWireSchema.safeParse(f.output).success, false);
});

test('an oversized rephrase is rejected before any paid independent review and reports its surface gate', async () => {
  const f = fixture(); let calls = 0; let trace: NaturalReviewTrace | undefined;
  f.output.decision.action = 'CLARIFICATION';
  f.output.decision.question!.text = '자료의 비교 과정에서 ' + '중요한 단계와 '.repeat(10) + '순서가 무엇인가요?';
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    onReviewStarted: () => { calls++; }, requestReview: async () => { throw new Error('should not call'); },
    onReviewTrace: value => { trace = value; },
  }), error => error instanceof Error && error.message === 'UNAPPROVED_QUESTION');
  assert.equal(calls, 0);
  assert.equal(trace?.stage, 'surface_precheck');
  assert.equal(trace?.rejectReason, 'surface_contract_failed');
  assert.equal(trace?.accepted, false);
});

test('unanswered whole-demand repetition is independently canonicalized as a non-F rephrase', async () => {
  const f = fixture(); let trace: NaturalReviewTrace | undefined;
  f.output.decision.question = { ...f.output.decision.question!, text: '자료를 비교할 때 어떤 단계들을 거쳤나요?', intent: '자료 비교 단계 확인', target: '자료를 비교한 실제 단계', primaryFunction: 'PROCESS' };
  const approved = await approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose,
      demandRelation: 'same_whole_demand_rephrase', currentDemandFulfillment: 'partial', hasAdditionalVerificationValue: false },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }),
    onReviewTrace: value => { trace = value; },
  });
  assert.equal(approved.questionKind, 'clarification');
  assert.equal(approved.questionIntent, f.turn.metadata.questionIntent);
  assert.deepEqual(approved.targetEvidence, f.turn.metadata.targetEvidence);
  assert.equal(approved.primaryFunction, f.turn.metadata.primaryFunction);
  assert.equal(approved.depth, f.turn.metadata.depth);
  assert.equal(trace?.canonicalQuestionKind, 'clarification');
  assert.equal(trace?.turnLocalCoverage?.fulfillment, 'partial');
  assert.equal(trace?.accepted, true);
});

test('missing one required comparison part stays an evaluative F rather than a whole-demand rephrase', async () => {
  const f = fixture();
  f.turn.questionText = 'A와 B의 변화를 비교해 설명해 주세요.';
  Object.assign(f.turn.metadata, { primaryFunction: 'CONCEPT', questionIntent: 'A와 B의 변화 비교', targetEvidence: ['A와 B의 변화에 대한 비교 설명'] });
  f.turn.rawTranscript = 'A는 증가합니다.';
  f.output.decision.question = { ...f.output.decision.question!, text: 'B는 어떻게 변하나요?', intent: '비교에서 빠진 B의 변화 확인', target: 'B의 변화 설명', primaryFunction: 'CONCEPT', answerQuote: 'A는 증가합니다.' };
  const approved = await approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'missing_subpart', currentDemandFulfillment: 'partial' },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }),
  });
  assert.equal(approved.questionKind, 'follow_up');
  assert.equal(approved.targetEvidence[0], 'B의 변화 설명');
});

test('an answered single-action demand cannot inherit another root activity gap', async () => {
  const f = fixture(); let trace: NaturalReviewTrace | undefined;
  f.turn.questionText = '비교하거나 정리할 때 본인이 맡은 일 한 가지는 무엇인가요?';
  f.turn.rawTranscript = '제가 표의 단위를 통일했습니다.';
  Object.assign(f.turn.metadata, { primaryFunction: 'ROLE', questionIntent: '본인이 맡은 한 행동', targetEvidence: ['본인의 행동 한 가지'] });
  f.output.decision.question = { ...f.output.decision.question!, text: '자료 정리에서 직접 맡은 일도 있었나요?', intent: '정리에서 수행한 개인 행동 확인', target: '정리 행동', primaryFunction: 'ROLE', answerQuote: f.turn.rawTranscript };
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'missing_subpart', currentDemandFulfillment: 'met' },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }),
    onReviewTrace: value => { trace = value; },
  }), error => error instanceof NaturalQuestionDecisionError && error.code === 'QUESTION_NO_USEFUL_PROBE' && error.semanticFulfillment === 'met');
  assert.equal(trace?.rejectReason, 'current_spoken_demand_already_met');
  assert.equal(trace?.intentMatches, true);
  assert.equal(trace?.completeAssertionCoverage, true);
  assert.equal(trace?.turnLocalCoverage?.turnId, f.turn.id);
});

test('a semantic met judgment never bypasses an unsupported premise', async () => {
  const f = fixture();
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'same_whole_demand_rephrase', currentDemandFulfillment: 'met', hasAdditionalVerificationValue: false },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: false }] }),
  }), error => error instanceof Error && error.message === 'PREMISE_UNSUPPORTED' && !(error instanceof NaturalQuestionDecisionError));
});

test('an identical declared target cannot become F merely because the reviewer labels it a missing subpart', async () => {
  const f = fixture(); let trace: NaturalReviewTrace | undefined;
  f.output.decision.question = { ...f.output.decision.question!, text: '자료를 비교할 때 실제로 거친 단계는 무엇인가요?',
    primaryFunction: f.turn.metadata.primaryFunction, target: f.turn.metadata.targetEvidence[0].replace(/\s/gu, '') };
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'missing_subpart', currentDemandFulfillment: 'partial',
      demandStructure: 'single_undivided_or_alternative', missingSubpartProof: null },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }),
    onReviewTrace: value => { trace = value; },
  }), /CORE_DEMAND_RELATION_CONFLICT/u);
  assert.equal(trace?.declaredDemandIdentity, true);
  assert.equal(trace?.rejectReason, 'declared_same_demand_relation_conflict');
});

test('two topic names joined with and do not prove two separately required answer parts', async () => {
  const f = fixture(); let trace: NaturalReviewTrace | undefined;
  f.turn.questionText = '자료 분류와 표 정리 활동에서 본인이 직접 한 일이 있다면 무엇인가요?';
  f.turn.rawTranscript = '다 같이 열심히 했습니다.';
  Object.assign(f.turn.metadata, { primaryFunction: 'ROLE', questionIntent: '자료 분류와 표 정리에서 개인 역할', targetEvidence: ['자료 분류와 표 정리에서 본인이 한 일'] });
  f.output.decision.question = { ...f.output.decision.question!, text: '그 과정에서 본인이 직접 한 일은 무엇인가요?', primaryFunction: 'ROLE',
    target: '두 활동에서 개인이 맡은 구체적인 행동', answerQuote: f.turn.rawTranscript };
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'missing_subpart', currentDemandFulfillment: 'partial',
      demandStructure: 'separate_parts_requested', missingSubpartProof: { answeredDemandSpan: '자료 분류', missingDemandSpan: '표 정리', scopeOperatorQuote: '와', answeredAnswerQuote: f.turn.rawTranscript } },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }),
    onReviewTrace: value => { trace = value; },
  }), /CORE_DEMAND_RELATION_CONFLICT/u);
  assert.equal(trace?.declaredDemandIdentity, false);
  assert.equal(trace?.rejectReason, 'missing_subpart_no_explicit_spoken_scope');
  assert.ok(!JSON.stringify(trace).includes(f.turn.rawTranscript));
});

test('source-bound answered and missing comparison parts keep the narrowed concept question as F', async () => {
  const f = fixture(); let trace: NaturalReviewTrace | undefined;
  f.turn.questionText = 'A와 B의 변화를 비교해 설명해 주세요.';
  f.turn.rawTranscript = 'A는 증가합니다.';
  Object.assign(f.turn.metadata, { primaryFunction: 'CONCEPT', questionIntent: 'A와 B의 변화 비교', targetEvidence: ['A와 B의 변화에 대한 비교 설명'] });
  f.output.decision.question = { ...f.output.decision.question!, text: 'B는 어떻게 변하나요?', primaryFunction: 'CONCEPT', target: 'B의 변화', answerQuote: f.turn.rawTranscript };
  const approved = await approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'missing_subpart', currentDemandFulfillment: 'partial',
      demandStructure: 'explicit_comparison', missingSubpartProof: { answeredDemandSpan: 'A', missingDemandSpan: 'B', scopeOperatorQuote: 'B의 변화를 비교해', answeredAnswerQuote: f.turn.rawTranscript } },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }),
    onReviewTrace: value => { trace = value; },
  });
  assert.equal(approved.questionKind, 'follow_up');
  assert.equal(trace?.accepted, true);
  assert.ok(trace?.runtimePurpose?.missingSubpartProof?.answeredAnswerQuoteSha256);
  assert.ok(!JSON.stringify(trace).includes(f.turn.rawTranscript));
});

test('a source-bound one-action witness prevents a second activity from being retroactively required', async () => {
  const f = fixture(); let trace: NaturalReviewTrace | undefined;
  f.turn.questionText = '자료비교표 제작과 보고서 안내에서 본인이 직접 한 일이 있다면 무엇인가요?';
  f.turn.rawTranscript = '자료비교표의 글자 크기를 직접 고쳤습니다.';
  Object.assign(f.turn.metadata, { primaryFunction: 'ROLE', questionIntent: '개인의 행동 한 가지', targetEvidence: ['본인이 수행한 일'] });
  f.output.decision.question = { ...f.output.decision.question!, text: '보고서 안내에서 본인이 직접 한 일은 무엇인가요?',
    primaryFunction: 'ROLE', target: '보고서 안내 역할', answerQuote: f.turn.rawTranscript };
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'missing_subpart', currentDemandFulfillment: 'partial',
      demandStructure: 'single_undivided_or_alternative', missingSubpartProof: null },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }),
    onReviewTrace: value => { trace = value; },
  }), error => error instanceof NaturalQuestionDecisionError && error.semanticFulfillment === 'met');
  assert.equal(trace?.turnLocalCoverage?.source, 'spoken_local_demand_witness');
  assert.equal(trace?.rejectReason, 'single_personal_action_already_supplied');
  assert.ok(trace?.turnLocalCoverage?.witness?.quoteSha256);
});

test('a local action witness cannot override an unsupported independent premise verdict', async () => {
  const f = fixture();
  f.turn.questionText = '자료비교표에서 본인이 직접 한 일이 있다면 무엇인가요?';
  f.turn.rawTranscript = '자료비교표의 글자 크기를 직접 고쳤습니다.';
  Object.assign(f.turn.metadata, { primaryFunction: 'ROLE' });
  f.output.decision.question!.answerQuote = f.turn.rawTranscript;
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'missing_subpart', currentDemandFulfillment: 'partial',
      demandStructure: 'single_undivided_or_alternative', missingSubpartProof: null },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: false }] }),
  }), error => error instanceof Error && error.message === 'PREMISE_UNSUPPORTED' && !(error instanceof NaturalQuestionDecisionError));
});

test('a fabricated missing-part source quote is blocked even when the purpose reviewer says it is useful', async () => {
  const f = fixture();
  f.turn.questionText = 'A와 B를 각각 설명해 주세요.';
  f.turn.rawTranscript = 'A에 대해 설명했습니다.';
  f.output.decision.question = { ...f.output.decision.question!, text: 'B는 무엇인가요?', primaryFunction: 'CONCEPT', target: 'B의 의미', answerQuote: f.turn.rawTranscript };
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'missing_subpart', currentDemandFulfillment: 'partial',
      demandStructure: 'separate_parts_requested', missingSubpartProof: { answeredDemandSpan: 'A', missingDemandSpan: 'B', scopeOperatorQuote: '각각', answeredAnswerQuote: '실제로 말하지 않은 문장' } },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }),
  }), /CORE_DEMAND_RELATION_CONFLICT/u);
});

test('a met current demand does not receive another rephrase without a new meaning or replay request', async () => {
  const f = fixture(); let trace: NaturalReviewTrace | undefined;
  f.output.decision.action = 'CLARIFICATION';
  f.output.decision.question!.text = '자료를 비교한 순서를 다시 말씀해 주세요.';
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'same_whole_demand_rephrase', currentDemandFulfillment: 'met',
      demandStructure: 'single_undivided_or_alternative', missingSubpartProof: null, hasAdditionalVerificationValue: false },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }),
    onReviewTrace: value => { trace = value; },
  }), error => error instanceof NaturalQuestionDecisionError && error.semanticFulfillment === 'met');
  assert.equal(trace?.rejectReason, 'fulfilled_rephrase_without_current_request');
});

test('a current explicit meaning request can receive a same-demand rephrase even after content fulfillment', async () => {
  const f = fixture();
  f.output.interpretation.dialogueRequests = ['explain_question'];
  f.output.decision.action = 'CLARIFICATION';
  f.output.decision.question!.text = '자료를 비교할 때 실제로 거친 순서를 설명해 주세요.';
  const approved = await approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'same_whole_demand_rephrase', currentDemandFulfillment: 'met',
      demandStructure: 'single_undivided_or_alternative', missingSubpartProof: null, hasAdditionalVerificationValue: false },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }),
  });
  assert.equal(approved.questionKind, 'clarification');
});

test('unsupported rephrase premise wins over a met no-request semantic stop', async () => {
  const f = fixture();
  f.output.decision.action = 'CLARIFICATION';
  f.output.decision.question!.text = '자료를 비교한 순서를 다시 말씀해 주세요.';
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'same_whole_demand_rephrase', currentDemandFulfillment: 'met',
      demandStructure: 'single_undivided_or_alternative', missingSubpartProof: null, hasAdditionalVerificationValue: false },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: false }] }),
  }), error => error instanceof Error && error.message === 'PREMISE_UNSUPPORTED' && !(error instanceof NaturalQuestionDecisionError));
});

test('independent review receives source-bound pronunciation readings without a second full answer or changed proof', () => {
  const f = fixture();
  const source = { ...f.source, text: 'CNT를 MXene 전극에 삽입한 탐구를 진행함.' };
  const draft = { ...f.draft, questionKind: 'follow_up' as const, parentMainQuestionId: 'q0', evidenceQuotes: [{ evidenceId: source.id, quote: source.text }] };
  const raw = '씨엔T와 맥신 전극을 비교했습니다.';
  const input = buildQuestionPremiseReviewInput(draft, [{ id: source.id, text: source.text }], {
    turnId: 'q0', answerId: 'a0', parentMainQuestionId: 'q0', transcriptStatus: 'finalized', text: raw,
  });
  const payload = buildRuntimeReviewPayload(input);
  assert.equal(payload.answer?.text, raw);
  assert.equal(payload.pronunciationReadings.length, 1);
  assert.deepEqual(payload.pronunciationReadings[0].readings.map(reading => reading.canonicalTerm), ['CNT', 'MXene']);
  assert.ok(!('normalizedReading' in payload.pronunciationReadings[0]));
  for (const reading of payload.pronunciationReadings[0].readings) assert.equal(raw.slice(reading.start, reading.end), reading.surface);
  assert.equal(payload.proofChoices.length, buildStablePremiseProofOptions(input).length);
});

test('generated-question vocabulary and ambiguous electrode words cannot authorize a normalized reading', () => {
  const f = fixture();
  const draft = { ...f.draft, questionKind: 'follow_up' as const, parentMainQuestionId: 'q0', questionText: 'CNT와 MXene을 어떻게 비교했나요?' };
  const answer = { turnId: 'q0', answerId: 'a0', parentMainQuestionId: 'q0', transcriptStatus: 'finalized' as const, text: '씨엔T와 신 전극을 비교했습니다.' };
  const payload = buildRuntimeReviewPayload(buildQuestionPremiseReviewInput(draft, [{ id: f.source.id, text: f.source.text }], answer));
  assert.deepEqual(payload.pronunciationReadings, []);
  assert.equal(payload.answer?.text, answer.text);
});

test('an open academic comparison asks for the missing explanation without requiring the expected answer in the record', async () => {
  const f = fixture(); let trace: NaturalReviewTrace | undefined;
  const record = '전해질과 전도도를 학습하고 약전해질과 강전해질을 비교하여 탐구함.';
  f.context.student.evidence[0].text = record;
  f.turn.metadata.evidenceQuotes = [{ evidenceId: 'E01', quote: record }];
  f.turn.questionText = '온도 상승에 따른 약전해질의 전도도 변화를 강전해질과 비교해 설명해 주세요.';
  f.turn.rawTranscript = '온도가 올라가면 약전해질은 해리도가 커져 이온수가 늘고 전도도가 높아집니다.';
  Object.assign(f.turn.metadata, { primaryFunction: 'CONCEPT', depth: 'D3', questionIntent: '온도 상승에 따른 약전해질과 강전해질의 전도도 비교', targetEvidence: ['두 전해질 전도도 변화 비교'] });
  f.output.decision.question = { ...f.output.decision.question!,
    text: '강전해질은 온도가 올라갈 때 전도도가 어떻게 변하며, 약전해질과 어떤 차이가 있나요?',
    intent: '빠진 강전해질 변화와 이미 설명한 약전해질과의 차이 확인', target: '강전해질 변화와 비교', primaryFunction: 'CONCEPT', depth: 'D3', answerQuote: f.turn.rawTranscript };
  const reviewed = (question: string) => ({ ...reviewBase, runtimePurpose: { ...purpose,
    demandRelation: 'missing_subpart', currentDemandFulfillment: 'partial', demandStructure: 'explicit_comparison',
    missingSubpartProof: { answeredDemandSpan: '약전해질', missingDemandSpan: '강전해질', scopeOperatorQuote: '비교해', answeredAnswerQuote: f.turn.rawTranscript } },
    premises: [{ questionSpan: question, basis: 'open_check', proofId: null, supported: true }] });
  const approved = await approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => reviewed(input.question.questionText), onReviewTrace: value => { trace = value; },
  });
  assert.equal(approved.questionKind, 'follow_up');
  assert.equal(approved.questionText, f.output.decision.question.text);
  assert.equal(trace?.runtimePurpose?.demandRelation, 'missing_subpart');
  assert.equal(trace?.policyVersion, 'compact-independent-review-v3');
  assert.equal(trace?.accepted, true);
  // The server does not silently upgrade an independent unsupported record
  // judgment merely because the surface looks like a conceptual question.
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewed(input.question.questionText), verdict: 'rewrite',
      premises: [{ questionSpan: '강전해질은 온도가 올라갈 때 전도도가 어떻게 변하며', basis: 'record', proofId: null, supported: false }] }),
  }), error => error instanceof Error && error.message === 'PREMISE_UNSUPPORTED');
});

test('a direction asserted inside a concept question still needs proof and cannot hide in an open ending', async () => {
  const f = fixture();
  f.turn.questionText = '온도 상승에 따른 두 전해질의 전도도 변화를 비교해 주세요.';
  f.turn.rawTranscript = '약전해질에 대해 설명했습니다.';
  f.output.decision.question = { ...f.output.decision.question!,
    text: '강전해질은 온도가 오르면 전도도가 증가하는데, 그 이유는 무엇인가요?', primaryFunction: 'CONCEPT',
    target: '강전해질 변화 이유', answerQuote: f.turn.rawTranscript };
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async () => ({ ...reviewBase, verdict: 'rewrite', runtimePurpose: { ...purpose,
      demandRelation: 'missing_subpart', currentDemandFulfillment: 'partial', demandStructure: 'explicit_comparison', missingSubpartProof: null },
      premises: [{ questionSpan: '강전해질은 온도가 오르면 전도도가 증가하는데', basis: 'record', proofId: null, supported: false }] }),
  }), error => error instanceof Error && error.message === 'PREMISE_UNSUPPORTED');
});

test('asking the entire comparison again remains a rephrase rather than automatically becoming a concept F', async () => {
  const f = fixture();
  f.turn.questionText = '약전해질과 강전해질의 전도도 변화를 비교해 주세요.';
  f.turn.rawTranscript = '약전해질의 변화만 설명했습니다.';
  Object.assign(f.turn.metadata, { primaryFunction: 'CONCEPT', questionIntent: '두 전해질 변화 비교', targetEvidence: ['두 전해질 변화 비교'] });
  f.output.decision.question = { ...f.output.decision.question!, text: '약전해질과 강전해질의 전도도는 각각 어떻게 달라지나요?',
    primaryFunction: 'CONCEPT', target: '두 전해질 변화 비교', answerQuote: f.turn.rawTranscript };
  const approved = await approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'same_whole_demand_rephrase', currentDemandFulfillment: 'partial',
      demandStructure: 'explicit_comparison', missingSubpartProof: null },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }),
  });
  assert.equal(approved.questionKind, 'clarification');
  assert.equal(approved.questionIntent, f.turn.metadata.questionIntent);
});

function unavailableFixture(raw = '두 자료를 비교했습니다. 다만 당시 조건과 원자료는 지금 기억나지 않습니다.') {
  const f = fixture();
  f.turn.questionText = '자료를 비교하여 내린 판단의 근거는 무엇인가요?';
  f.turn.rawTranscript = raw;
  f.output.decision.question!.answerQuote = raw;
  f.output.decision.question!.text = '자료를 비교해 판단한 근거를 다시 말씀해 주세요.';
  return f;
}
function unavailableReview(question: string, answerQuote: string, overrides: Record<string, unknown> = {}) {
  return { ...reviewBase, verdict: 'rewrite', runtimePurpose: { ...purpose, hasAdditionalVerificationValue: false,
    demandRelation: 'same_whole_demand_rephrase', currentDemandFulfillment: 'partial', demandStructure: 'single_undivided_or_alternative',
    missingSubpartProof: null, unavailableDemandProof: { answerQuote, currentQuestionSpan: '판단의 근거', scopeRelation: 'same_requested_demand', answerProofId: null }, ...overrides },
    premises: [{ questionSpan: question, basis: 'open_check', proofId: null, supported: false }] };
}

test('an independently bound unavailable current demand stops without approving an unsupported candidate or marking the answer met', async () => {
  const f = unavailableFixture(); let trace: NaturalReviewTrace | undefined;
  const quote = '다만 당시 조건과 원자료는 지금 기억나지 않습니다.';
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => unavailableReview(input.question.questionText, quote), onReviewTrace: value => { trace = value; },
  }), error => error instanceof NaturalQuestionDecisionError && error.code === 'QUESTION_DECLINED_CURRENT_DEMAND' && error.semanticFulfillment === 'partial');
  assert.equal(trace?.accepted, false); assert.equal(trace?.verdict, 'rewrite');
  assert.equal(trace?.premises[0].supported, false); assert.equal(trace?.answerDisposition?.accepted, true);
  assert.equal(trace?.runtimePurpose?.unavailableDemandProof?.currentQuestionSpan, '판단의 근거');
  assert.match(trace?.runtimePurpose?.unavailableDemandProof?.answerQuoteSha256 ?? '', /^[a-f0-9]{64}$/u);
  const proof = trace?.runtimePurpose?.unavailableDemandProof;
  assert.equal(f.turn.rawTranscript!.slice(proof!.answerStartOffset!, proof!.answerEndOffset!), quote);
  assert.ok(!JSON.stringify(trace).includes(quote)); assert.equal(f.session.turns.length, 1);
});

test('an explicit current-demand unknown remains unknown rather than satisfied', async () => {
  for (const raw of ['모르겠습니다.', '기억이 안 납니다.', '답변 못하겠습니다.', '설명을 못해요.']) {
    const f = unavailableFixture(raw);
    await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
      requestReview: async input => unavailableReview(input.question.questionText, f.turn.rawTranscript!, { currentDemandFulfillment: 'unknown' }),
    }), error => error instanceof NaturalQuestionDecisionError && error.code === 'QUESTION_DECLINED_CURRENT_DEMAND' && error.semanticFulfillment === 'unknown');
  }
});

test('another task or an unclear scope cannot authorize a declined-current-demand disposition', async () => {
  for (const explicitOtherScope of [false, true]) {
    const raw = explicitOtherScope ? '다른 활동의 조건은 기억나지 않습니다.' : '그 조건은 기억나지 않습니다.';
    const f = unavailableFixture(raw); let trace: NaturalReviewTrace | undefined;
    await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
      requestReview: async input => unavailableReview(input.question.questionText, raw, {
        unavailableDemandProof: { answerQuote: raw, currentQuestionSpan: '판단의 근거', scopeRelation: explicitOtherScope ? 'same_requested_demand' : 'different_or_unclear', answerProofId: null },
      }), onReviewTrace: value => { trace = value; },
    }), error => error instanceof Error && error.message === 'PREMISE_UNSUPPORTED' && !(error instanceof NaturalQuestionDecisionError));
    assert.equal(trace?.answerDisposition?.accepted, false);
  }
});

test('fabricated answer or question spans cannot authorize a declined answer', async () => {
  for (const falseSpan of ['answer', 'question']) {
    const f = unavailableFixture(); let trace: NaturalReviewTrace | undefined;
    await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
      requestReview: async input => unavailableReview(input.question.questionText, f.turn.rawTranscript!, {
        unavailableDemandProof: { answerQuote: falseSpan === 'answer' ? '저는 그 방법을 모르겠습니다.' : f.turn.rawTranscript!,
          currentQuestionSpan: falseSpan === 'question' ? '학생이 직접 측정한 수치' : '판단의 근거', scopeRelation: 'same_requested_demand', answerProofId: null },
      }), onReviewTrace: value => { trace = value; },
    }), error => error instanceof Error && error.message === 'PREMISE_UNSUPPORTED' && !(error instanceof NaturalQuestionDecisionError));
    assert.equal(trace?.answerDisposition?.accepted, false);
  }
});

test('negated, double-negated, quoted and other-speaker inability does not become the student declining a demand', async () => {
  const cases = [
    { raw: '모르겠습니다라는 뜻은 아닙니다.', quote: '모르겠습니다' },
    { raw: '기억나지 않는 것은 아닙니다.', quote: '기억나지 않는 것은 아닙니다.' },
    { raw: '친구가 "모르겠습니다."라고 말했습니다.', quote: '모르겠습니다' },
    { raw: '친구는 그 근거를 모릅니다.', quote: '친구는 그 근거를 모릅니다.' },
    { raw: '답변할 수 없지는 않습니다.', quote: '답변할 수 없지는 않습니다.' },
  ];
  for (const { raw, quote } of cases) {
    const f = unavailableFixture(raw); let trace: NaturalReviewTrace | undefined;
    await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
      requestReview: async input => unavailableReview(input.question.questionText, quote), onReviewTrace: value => { trace = value; },
    }), error => error instanceof Error && error.message === 'PREMISE_UNSUPPORTED' && !(error instanceof NaturalQuestionDecisionError));
    assert.equal(trace?.answerDisposition?.accepted, false, raw);
  }
});

test('later recall or correction cancels an earlier unavailable-demand witness', async () => {
  const f = unavailableFixture('기억나지 않습니다. 아니요, 다시 생각해 보니 기억났습니다.'); let trace: NaturalReviewTrace | undefined;
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => unavailableReview(input.question.questionText, '기억나지 않습니다.'), onReviewTrace: value => { trace = value; },
  }), error => error instanceof Error && error.message === 'PREMISE_UNSUPPORTED' && !(error instanceof NaturalQuestionDecisionError));
  assert.equal(trace?.answerDisposition?.rejectReason, 'unavailable_later_correction');
});

test('unavailable proof needs partial or unknown fulfillment and an independent no-additional-value verdict', async () => {
  for (const conflict of [{ currentDemandFulfillment: 'met' }, { hasAdditionalVerificationValue: true }]) {
    const f = unavailableFixture(); let trace: NaturalReviewTrace | undefined;
    await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
      requestReview: async input => unavailableReview(input.question.questionText, f.turn.rawTranscript!, conflict), onReviewTrace: value => { trace = value; },
    }), error => error instanceof Error && error.message === 'PREMISE_UNSUPPORTED' && !(error instanceof NaturalQuestionDecisionError));
    assert.equal(trace?.answerDisposition?.accepted, false);
  }
});

test('no-useful-probe alone cannot bypass failed premises even when the raw answer contains a declined scope', async () => {
  const f = unavailableFixture();
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => unavailableReview(input.question.questionText, f.turn.rawTranscript!, { unavailableDemandProof: null }),
  }), error => error instanceof Error && error.message === 'PREMISE_UNSUPPORTED' && !(error instanceof NaturalQuestionDecisionError));
});

test('a current-answer proof ID restores the untouched academic answer despite a model-normalized proof quote', async () => {
  for (const scopeOperatorQuote of ['약전해질과 어떤 차이가 있나요?', '약전해질과 어떻게 다른지']) {
    const f = fixture(); let trace: NaturalReviewTrace | undefined;
    f.turn.questionText = `강전해질이 온도 상승에 따라 어떻게 변하고 ${scopeOperatorQuote}`;
    f.turn.rawTranscript = '강전의 질은 온도가 오르면 전도도가 높아집니다.';
    Object.assign(f.turn.metadata, { primaryFunction: 'CONCEPT', questionIntent: '두 대상의 온도 변화 비교', targetEvidence: ['두 대상의 변화 비교'] });
    f.output.decision.question = { ...f.output.decision.question!, text: '약전해질과는 어떤 차이가 있나요?', primaryFunction: 'CONCEPT', target: '미답 대상의 비교', answerQuote: f.turn.rawTranscript };
    const approved = await approveNaturalQuestion(f.context, f.session, f.output, {
      requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'missing_subpart', currentDemandFulfillment: 'partial',
        demandStructure: 'explicit_comparison', missingSubpartProof: { answeredDemandSpan: '강전해질', missingDemandSpan: '약전해질', scopeOperatorQuote,
          answeredAnswerQuote: '강전해질은 온도가 오르면 전도도가 높아집니다.',
          answeredAnswerProofId: buildStablePremiseProofOptions(input).find(proof => proof.sourceId === input.answer!.id)!.proofId } },
        premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }), onReviewTrace: value => { trace = value; },
    });
    assert.equal(approved.questionKind, 'follow_up'); assert.equal(trace?.accepted, true);
    assert.ok(trace?.runtimePurpose?.missingSubpartProof?.answeredAnswerProofId);
    assert.equal(f.turn.rawTranscript, '강전의 질은 온도가 오르면 전도도가 높아집니다.');
  }
});

test('a comparison topic noun does not become an explicit spoken comparison request', async () => {
  const f = fixture();
  f.turn.questionText = '자료 비교표 제작에서 맡은 일을 설명해 주세요.';
  f.output.decision.question!.answerQuote = f.turn.rawTranscript!;
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => ({ ...reviewBase, runtimePurpose: { ...purpose, demandRelation: 'missing_subpart', currentDemandFulfillment: 'partial',
      demandStructure: 'explicit_comparison', missingSubpartProof: { answeredDemandSpan: '자료', missingDemandSpan: '제작', scopeOperatorQuote: '비교표 제작',
        answeredAnswerQuote: f.turn.rawTranscript, answeredAnswerProofId: null } },
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', proofId: null, supported: true }] }),
  }), /CORE_DEMAND_RELATION_CONFLICT/u);
});

test('an unavailable-demand proof ID uses only a current raw-answer span and keeps its scope qualifiers', async () => {
  const f = unavailableFixture('조건과 원자료는 지금 기억나지 않습니다.'); let trace: NaturalReviewTrace | undefined;
  await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, {
    requestReview: async input => unavailableReview(input.question.questionText, '원자료를 모릅니다.', {
      unavailableDemandProof: { answerQuote: '원자료를 모릅니다.', currentQuestionSpan: '판단의 근거', scopeRelation: 'same_requested_demand',
        answerProofId: buildStablePremiseProofOptions(input).find(proof => proof.sourceId === input.answer!.id)!.proofId },
    }), onReviewTrace: value => { trace = value; },
  }), error => error instanceof NaturalQuestionDecisionError && error.code === 'QUESTION_DECLINED_CURRENT_DEMAND');
  const proof = trace?.runtimePurpose?.unavailableDemandProof;
  assert.equal(f.turn.rawTranscript!.slice(proof!.answerStartOffset!, proof!.answerEndOffset!), f.turn.rawTranscript);
  assert.ok(proof?.answerProofId); assert.equal(trace?.accepted, false);
});

test('unknown or non-current-answer proof IDs cannot supply a missing-part or unavailable-demand witness', async () => {
  for (const target of ['missing', 'unavailable']) for (const wrongSource of ['unknown', 'record', 'prior_answer']) {
    const f = unavailableFixture();
    f.session.turns.unshift({ ...f.turn, id: 'prior', answerId: 'prior-answer', rawTranscript: f.turn.rawTranscript });
    await assert.rejects(approveNaturalQuestion(f.context, f.session, f.output, { requestReview: async input => {
      const choices = buildStablePremiseProofOptions(input);
      const id = wrongSource === 'unknown' ? 'P99999' : choices.find(proof => wrongSource === 'record' ? proof.basis === 'record' : proof.sourceId !== input.answer!.id && proof.basis === 'answer_turn_attributed')!.proofId;
      return unavailableReview(input.question.questionText, f.turn.rawTranscript!, target === 'missing'
        ? { missingSubpartProof: { answeredDemandSpan: '자료', missingDemandSpan: '근거', scopeOperatorQuote: '비교', answeredAnswerQuote: f.turn.rawTranscript, answeredAnswerProofId: id } }
        : { unavailableDemandProof: { answerQuote: f.turn.rawTranscript, currentQuestionSpan: '판단의 근거', scopeRelation: 'same_requested_demand', answerProofId: id } });
    } }), /CORE_REVIEW_ANSWER_PROOF_INVALID/u);
  }
});

