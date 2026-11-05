import test from 'node:test';
import assert from 'node:assert/strict';
import type { InterviewContext, StudentEvidence } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';
import type { StrategyCoreOptions } from '../server/providers/realtime-strategy-core';
import { classifySingleCoreAnswerCandidate, runSingleCoreRuntime, assertSingleCoreCandidateBinding, type SingleCoreAnswerCandidate } from '../server/providers/single-core-runtime';
import { decodeSingleCoreCandidateDecision, encodeSingleCoreDecision, encodeSingleCoreCandidateResponse, singleCoreCandidateWireSchema, singleCoreDecisionSchema, type SingleCoreDecision, type SingleCoreOutput } from '../server/providers/single-core-contract';
import { zodTextFormat } from 'openai/helpers/zod';
import { buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview } from '../server/providers/question-premises';
import { approveQuestionContract, createQuestionBlueprint } from '../server/question-objective';
import { verifyAcknowledgement, assertInterviewQuestionSpeech } from '../server/providers/interview-speech';
import { observeAnswerSubmission } from '../server/answer-submission';
import { recordQuestionPresentation } from '../server/question-presentation';
import { mayAskFollowUp } from '../server/interview-planner';

function fixture(raw = '작성 시점을 비교했습니다.', primary: 'EVIDENCE' | 'ROLE' = 'EVIDENCE') {
  const source: StudentEvidence = { id: 'E1', activityId: 'A1', page: 1, grade: 2, section: '세특', title: '합성 자료 비교',
    text: '자료를 선택하고 비교하는 탐구를 진행함.', sourceRef: { file: 'synthetic.pdf', pdfSha256: 'a'.repeat(64), page: 1, extraction: 'explicit-synthetic-test', startOffset: 0, endOffset: 24 },
    confirmationStatus: 'confirmed_from_record', preparationPriority: null, scientificTruthVerification: 'not_independently_verified' };
  const draft: QuestionDraft = { questionText: primary === 'ROLE' ? '자료 비교에서 본인이 맡은 일은 무엇인가요?' : '자료를 비교해 내린 판단의 근거는 무엇인가요?',
    questionKind: 'main', parentMainQuestionId: null, acknowledgement: null, acknowledgementQuote: null, evidenceIds: [source.id], evidenceQuotes: [{ evidenceId: source.id, quote: source.text }],
    primaryFunction: primary, depth: 'D2', questionIntent: primary === 'ROLE' ? '본인이 맡은 일 확인' : '판단의 실제 근거 확인', targetEvidence: [primary === 'ROLE' ? '본인이 한 일 한 가지' : '판단 근거 한 가지'],
    groundingRationale: '기록된 자료 비교 경험의 한 요구를 확인한다.', validationStatus: 'approved', validationFailures: [] };
  draft.premiseValidation = finalizeQuestionPremiseReview({ verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true,
    premises: [{ questionSpan: '자료', basis: 'record', sourceId: source.id, supportQuote: source.text, supported: true }] }, buildQuestionPremiseReviewInput(draft, [source]), 'explicit-synthetic-offline-review');
  const context = { target: { university: '합성 대학', department: '합성 학과' }, questionReferences: null, questionStrategies: null, errors: [], student: { evidence: [source] }, school: { sources: [] }, interviewOverview: null,
    manifest: { rulesVersion: 'single-core-synthetic', sourceIntegrity: { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true, evidenceCount: 1 },
      files: [{ role: 'studentPdf', path: 'synthetic.pdf', sha256: source.sourceRef.pdfSha256 }] } } as unknown as InterviewContext;
  const session = { id: 'single-core-synthetic-session', sourceManifest: structuredClone(context.manifest), followUpCountByMainQuestion: {}, elapsedMs: 0, durationSeconds: 720, turns: [] } as unknown as InterviewSession;
  draft.questionBlueprint = createQuestionBlueprint(draft, context, session, { questionId: 'q0' });
  draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint);
  const turn = { id: 'q0', answerId: 'a0', parentMainQuestionId: 'q0', mainIndex: 1, mainCount: 5, followUpIndex: 0, questionKind: 'main', questionText: draft.questionText,
    evidenceIds: [source.id], rawTranscript: raw, transcriptStatus: 'finalized', metadata: { ...draft, rulesVersion: context.manifest.rulesVersion, questionClusterId: 'q0', activityIds: ['A1'] } } as unknown as RecordedTurn;
  session.turns.push(turn);
  return { context, session, turn };
}

const endingObservation: SingleCoreAnswerCandidate['endingObservation'] = { stopSource: 'space', lastSpeechMs: 1200, trailingSilenceMs: 0, speechActiveAtEnd: true, vadAvailable: true };
const continuation: SingleCoreDecision = { assessment: null, next: { action: 'CONTINUE_ANSWER', question: null }, reaction: null };
const transition: SingleCoreOutput = { assessment: { coverage: 'met', response: 'answered', reason: '현재 실제 요구에 답했다.' }, next: { action: 'TRANSITION', question: null }, reaction: { quote: '관심사는 아니었습니다', text: '연결된 관심사는 아니었다는 말씀이군요.' } };
const options = (decision: SingleCoreDecision, onRequest?: StrategyCoreOptions['requestSingleCore']): StrategyCoreOptions => ({ allowFollowUp: true, allowClarification: true, allowReplay: true,
  requestSingleCore: onRequest ?? (async () => encodeSingleCoreDecision(decision)),
  requestFactReview: async () => { throw new Error('UNEXPECTED_FACT_REVIEW'); }, requestSurfaceRepair: async () => { throw new Error('UNEXPECTED_REPAIR'); },
});

test('unfinished candidate uses the sole core without finalizing, evaluating or preparing a new question', async () => {
  const f = fixture(''); f.turn.transcriptStatus = 'paused';
  const before = structuredClone(f.session);
  let calls = 0;
  const result = await classifySingleCoreAnswerCandidate(f.context, f.session, { text: '딱히 연결된 관심사는 아니었으나', captureRevision: 2, endingObservation }, options(continuation, async request => {
    calls++; const input = JSON.parse(request.input);
    assert.equal(input.answer.transcriptText, '딱히 연결된 관심사는 아니었으나');
    assert.equal(Object.hasOwn(input.answer, 'finalTranscript'), false);
    assert.equal(input.actualAnswers.answers.at(-1).transcriptRef, 'answer.transcriptText');
    assert.equal(input.answer.submissionState, 'candidate');
    assert.ok(input.actualAnswers.answers.every((answer: object) => !Object.hasOwn(answer, 'observation')));
    assert.deepEqual(input.endingObservation, endingObservation);
    assert.ok(request.instructions.includes('CONTINUE_ANSWER'));
    return encodeSingleCoreDecision(continuation);
  }));
  assert.equal(calls, 1); assert.equal(result.kind, 'CONTINUE'); assert.deepEqual(result.semanticDecision, continuation);
  assert.equal(result.captureRevision, 2); assert.equal(result.providerTimings.coreModelCalls, 1);
  assert.deepEqual(f.session, before, 'A candidate projection must never mutate an answer record.');
});

test('a historical candidate without ending observations preserves unknown timing instead of inventing a button or speech state', async () => {
  const f = fixture('작성 시점을 비교했습니다.'); f.turn.transcriptStatus = 'paused';
  const before = structuredClone(f.session); let calls = 0;
  const decision: SingleCoreDecision = { assessment: { coverage: 'met', response: 'answered', reason: '현재 요구에 답했다.' }, next: { action: 'TRANSITION', question: null }, reaction: null };
  const result = await classifySingleCoreAnswerCandidate(f.context, f.session, { text: f.turn.rawTranscript!, captureRevision: 1 }, options(decision, async request => {
    calls++; const input = JSON.parse(request.input); assert.equal(input.endingObservation, null);
    assert.equal(input.answer.transcriptText, f.turn.rawTranscript); return encodeSingleCoreDecision(decision);
  }));
  assert.equal(calls, 1); assert.deepEqual(result.semanticDecision, decision); assert.deepEqual(f.session, before);
});

test('unverified empty candidate keeps the same uncommitted answer with explicit technical provenance and zero calls', async () => {
  for (const observedEmpty of [false, true]) {
    const raw = observedEmpty ? ' \t' : '';
    const f = fixture(raw); f.turn.transcriptStatus = 'paused'; f.turn.metadata.answerCaptureRevision = 9;
    if (observedEmpty) f.turn.answerObservation = { classification: 'empty_transcript', nonAnswer: false, durationMs: 3000,
      speakingMs: null, silenceMs: null, firstSpeechMs: null, speechDetected: null, rawTranscriptPreserved: true, origin: 'finalized-stt-and-observed-speech-timing' };
    const before = structuredClone(f.session); let calls = 0;
    const result = await classifySingleCoreAnswerCandidate(f.context, f.session, { text: raw, captureRevision: 9,
      endingObservation: { stopSource: 'space', lastSpeechMs: null, trailingSilenceMs: null, speechActiveAtEnd: null, vadAvailable: false } }, {
      ...options(transition, async () => { calls++; throw new Error('NO_MODEL_FOR_EMPTY_CAPTURE'); }),
      resolveApprovedRecovery: async () => { throw new Error('NO_QUESTION_RECOVERY_FOR_EMPTY_CAPTURE'); },
    });
    assert.equal(calls, 0); assert.equal(result.kind, 'CONTINUE'); assert.deepEqual(result.semanticDecision, continuation);
    assert.equal(result.decisionAuthority, 'technical_capture_guard'); assert.equal(result.captureReason, 'UNVERIFIED_EMPTY_CAPTURE');
    assert.equal(result.providerTimings.coreModelCalls, 0); assert.equal(result.providerTimings.premiseReviewAttempts, 0);
    assert.equal(result.providerTimings.repairModelCalls, 0); assert.equal(result.providerUsage, undefined);
    assert.equal(result.policyTrace?.decisionAuthority, 'technical_capture_guard');
    assert.doesNotThrow(() => assertSingleCoreCandidateBinding(f.context, f.session, result, undefined));
    assert.deepEqual(f.session, before);
  }
});

test('technical empty-candidate execution has no assessment, question, relation or coverage and preserves legacy blocking', async () => {
  const f = fixture(''); let calls = 0;
  const injected = options(transition, async () => { calls++; throw new Error('NO_EMPTY_CAPTURE_MODEL'); });
  const candidate = await runSingleCoreRuntime(f.context, f.session, { ...injected, candidateOnly: true });
  assert.equal(candidate.origin, 'deterministic'); assert.equal(candidate.execution?.status, 'ready');
  assert.equal(candidate.execution?.action, 'CONTINUE_ANSWER'); assert.equal(candidate.execution?.decisionAuthority, 'technical_capture_guard');
  assert.equal(candidate.execution?.captureReason, 'UNVERIFIED_EMPTY_CAPTURE'); assert.equal(candidate.decisionReasonCode, 'UNVERIFIED_EMPTY_CAPTURE');
  assert.deepEqual(candidate.semanticDecision, continuation); assert.equal(candidate.draft, null); assert.equal(candidate.reaction.reply, null);
  assert.equal(candidate.answerRelation, undefined); assert.equal(candidate.turnLocalCoverage, undefined);
  assert.ok(candidate.serverGuards?.includes('UNVERIFIED_EMPTY_CAPTURE'));
  const finalized = await runSingleCoreRuntime(f.context, f.session, injected);
  assert.equal(finalized.execution?.status, 'blocked'); assert.equal(finalized.failureDetail, 'CORE_EMPTY_TRANSCRIPT_UNOBSERVED');
  assert.equal(finalized.decisionAuthority, undefined); assert.equal(calls, 0);
});

test('confirmed silence keeps its existing replay/transition path while transport-error captures cannot be promoted', async () => {
  for (const replay of [true, false]) {
    const f = fixture(''); f.turn.transcriptStatus = 'paused'; f.turn.metadata.answerCaptureRevision = 1;
    f.turn.metrics = { speech: { durationMs: 3000, speakingMs: 0, firstSpeechMs: null } };
    f.turn.answerObservation = { classification: 'silence_observed', nonAnswer: true, durationMs: 3000, speakingMs: 0,
      silenceMs: 3000, firstSpeechMs: null, speechDetected: false, rawTranscriptPreserved: true, origin: 'finalized-stt-and-observed-speech-timing' };
    const result = await classifySingleCoreAnswerCandidate(f.context, f.session, { text: '', captureRevision: 1, endingObservation }, {
      ...options(transition, async () => { throw new Error('NO_MODEL_FOR_OBSERVED_SILENCE'); }), allowReplay: replay,
    });
    assert.equal(result.kind, 'ADVANCE'); assert.equal(result.semanticDecision.next.action, replay ? 'REPLAY' : 'TRANSITION');
    assert.equal(result.captureReason, undefined); assert.equal(result.providerTimings.coreModelCalls, 0);
  }
  for (const status of ['error', 'streaming'] as const) {
    const f = fixture(''); f.turn.transcriptStatus = status;
    await assert.rejects(() => classifySingleCoreAnswerCandidate(f.context, f.session, { text: '', captureRevision: 1, endingObservation },
      options(transition, async () => { throw new Error('NO_MODEL_FOR_UNCONFIRMED_CAPTURE'); })), /CORE_CANDIDATE_SOURCE_INVALID/u);
    assert.equal(f.turn.transcriptStatus, status);
  }
});

test('paused candidate recomputes finalized observations from capture metrics without mutating stale original observations', async () => {
  for (const microphoneEnabled of [true, undefined, false]) {
    const f = fixture(''); f.turn.transcriptStatus = 'paused'; f.turn.metadata.answerCaptureRevision = 1;
    f.turn.metrics = { speech: { durationMs: 2000, speakingMs: 0, firstSpeechMs: null } };
    f.turn.answerObservation = observeAnswerSubmission('', {}); // Paused-stage stale unknown state.
    const before = structuredClone(f.session);
    const result = await classifySingleCoreAnswerCandidate(f.context, f.session, { text: '', captureRevision: 1,
      endingObservation: { ...endingObservation, microphoneEnabled } }, options(transition, async () => { throw new Error('NO_MODEL_FOR_EMPTY_CAPTURE'); }));
    assert.equal(result.semanticDecision.next.action, microphoneEnabled === false ? 'CONTINUE_ANSWER' : 'REPLAY');
    assert.equal(result.captureReason, microphoneEnabled === false ? 'INPUT_DISABLED' : undefined);
    assert.equal(result.decisionAuthority, microphoneEnabled === false ? 'technical_capture_guard' : undefined);
    if (microphoneEnabled === false) assert.deepEqual(result.semanticDecision, continuation);
    assert.equal(result.providerTimings.coreModelCalls, 0); assert.deepEqual(f.session, before);
  }
});

test('empty capture with observed speech or unknown timing remains technical continuation and existing words before mute still reach the sole core', async () => {
  for (const speech of [{ durationMs: 2000, speakingMs: 1000, firstSpeechMs: 100 }, { durationMs: 2000, speakingMs: null, firstSpeechMs: null }]) {
    const f = fixture(''); f.turn.transcriptStatus = 'paused'; f.turn.metadata.answerCaptureRevision = 1;
    f.turn.metrics = { speech }; f.turn.answerObservation = observeAnswerSubmission('', { speech: { durationMs: 2000, speakingMs: 0 } });
    const result = await classifySingleCoreAnswerCandidate(f.context, f.session, { text: '', captureRevision: 1,
      endingObservation: { ...endingObservation, microphoneEnabled: true } }, options(transition, async () => { throw new Error('NO_MODEL_FOR_LOST_WORDS'); }));
    assert.deepEqual(result.semanticDecision, continuation); assert.equal(result.captureReason, 'UNVERIFIED_EMPTY_CAPTURE');
    assert.equal(result.providerTimings.coreModelCalls, 0);
  }
  const raw = '딱히 연결된 관심사는 아니었습니다.';
  const f = fixture(raw); f.turn.transcriptStatus = 'paused'; f.turn.metadata.answerCaptureRevision = 1;
  f.turn.metrics = { speech: { durationMs: 2000, speakingMs: 1000, firstSpeechMs: 100 } };
  f.turn.answerObservation = observeAnswerSubmission('', { speech: { durationMs: 2000, speakingMs: 0 } });
  let calls = 0;
  const result = await classifySingleCoreAnswerCandidate(f.context, f.session, { text: raw, captureRevision: 1,
    endingObservation: { ...endingObservation, microphoneEnabled: false } }, options(transition, async request => {
    calls++; const input = JSON.parse(request.input);
    assert.equal(input.technicalObservation.classification, 'speech_transcribed'); assert.equal(input.answer.transcriptText, raw);
    return encodeSingleCoreCandidateResponse(transition);
  }));
  assert.equal(calls, 1); assert.equal(result.kind, 'ADVANCE'); assert.equal(result.captureReason, undefined);
  assert.equal(f.turn.answerObservation.classification, 'silence_observed', 'The original paused observation is immutable during candidate judgment.');
});

test('candidate decision is reused only for the exact answer and capture revision with zero second core calls', async () => {
  const raw = '딱히 연결된 관심사는 아니었습니다.';
  const f = fixture(''); f.turn.transcriptStatus = 'paused';
  const result = await classifySingleCoreAnswerCandidate(f.context, f.session, { text: raw, captureRevision: 3, endingObservation }, options(transition));
  assert.equal(result.kind, 'ADVANCE');
  f.turn.rawTranscript = raw; f.turn.metadata.answerCaptureRevision = 3;
  assert.doesNotThrow(() => assertSingleCoreCandidateBinding(f.context, f.session, result, undefined), 'Same staged decision can be reused after an external persistence failure.');
  f.turn.transcriptStatus = 'finalized';
  const executed = await runSingleCoreRuntime(f.context, f.session, { ...options(transition, async () => { throw new Error('MUST_NOT_REPEAT_CORE'); }), pendingCandidateDecision: result });
  assert.equal(executed.execution?.status, 'ready'); assert.equal(executed.nextAction, 'TRANSITION');
  assert.equal(executed.providerTimings.coreModelCalls, 0); assert.equal(executed.providerUsage, undefined);
  assert.equal(executed.reaction.reply, '연결된 관심사는 아니었다는 말씀이군요.');
  assert.ok(executed.serverGuards?.includes('SOURCE_BOUND_CANDIDATE_DECISION_REUSED'));
  for (const mutation of [() => { f.turn.metadata.answerCaptureRevision = 4; }, () => { f.turn.metadata.answerCaptureRevision = 3; f.turn.rawTranscript = raw + ' 정정합니다.'; }]) {
    mutation(); const stale = await runSingleCoreRuntime(f.context, f.session, { ...options(transition), pendingCandidateDecision: result });
    assert.equal(stale.execution?.status, 'blocked'); assert.equal(stale.failureDetail, 'CORE_CANDIDATE_SOURCE_CHANGED');
  }
});

test('reconciled playback spends the live F budget without invalidating policy binding or repeating the candidate core', async () => {
  const f = fixture('작성 시점을 비교했습니다.');
  const makeFollow = (id: string, index: number) => {
    const turn = structuredClone(f.turn); Object.assign(turn, { id, answerId: `answer-${id}`, questionKind: 'follow_up', followUpIndex: index });
    delete turn.metadata.approvedQuestion; delete turn.metadata.questionBlueprint;
    return turn;
  };
  const first = makeFollow('f1', 1), current = makeFollow('f2', 2);
  current.transcriptStatus = 'paused'; current.metadata.answerCaptureRevision = 1;
  f.session.turns.push(first, current);
  f.session.runtime = { version: 'session-runtime-v1' } as NonNullable<InterviewSession['runtime']>;
  const output: SingleCoreOutput = { assessment: { coverage: 'met', response: 'answered', reason: '실제 사용한 기준의 한 지점을 확인한다.' },
    next: { action: 'FOLLOW_UP', question: { text: '자료를 비교할 때 어떤 기준을 사용했나요?', target: '실제로 사용한 비교 기준', primaryFunction: 'CHOICE', depth: 'D2', strategyId: null } }, reaction: null };
  let calls = 0;
  const candidate = await classifySingleCoreAnswerCandidate(f.context, f.session, { text: current.rawTranscript!, captureRevision: 1, endingObservation }, options(output, async () => { calls++; return encodeSingleCoreDecision(output); }));
  for (const [index, turn] of [first, current].entries()) recordQuestionPresentation(f.session, { eventId: `start-${turn.id}`, type: 'question_playing', turnId: turn.id, clockId: 'synthetic-clock', atMs: index * 1000 + 10 }, turn);
  assert.doesNotThrow(() => assertSingleCoreCandidateBinding(f.context, f.session, candidate, undefined));
  assert.equal(mayAskFollowUp(f.session, 720, 2), false);
  current.transcriptStatus = 'finalized';
  const result = await runSingleCoreRuntime(f.context, f.session, { ...options(output, async () => { throw new Error('MUST_NOT_REPEAT_CORE'); }), allowFollowUp: false, pendingCandidateDecision: candidate });
  assert.equal(calls, 1); assert.equal(result.providerTimings.coreModelCalls, 0);
  assert.equal(result.execution?.status, 'ready'); assert.equal(result.nextAction, 'TRANSITION'); assert.equal(result.draft, null);
  assert.deepEqual(result.semanticDecision, output); assert.ok(result.serverGuards?.includes('QUESTION_ACTION_BUDGET_EXHAUSTED'));
});

test('CONTINUE cannot carry assessment, reaction or question and production cannot advance it', async () => {
  assert.deepEqual(decodeSingleCoreCandidateDecision(encodeSingleCoreDecision(continuation)), continuation);
  for (const changes of [{ assessment: transition.assessment }, { reaction: transition.reaction }, { next: { action: 'CONTINUE_ANSWER', question: { text: '다시 설명해 주세요.' } } }]) {
    assert.throws(() => decodeSingleCoreCandidateDecision({ ...continuation, ...changes }));
  }
  const f = fixture('딱히 연결된 관심사는 아니었으나');
  const result = await runSingleCoreRuntime(f.context, f.session, options(continuation));
  assert.equal(result.nextAction, 'CONTINUE_ANSWER'); assert.equal(result.execution?.action, 'CONTINUE_ANSWER');
  assert.equal(result.semanticDecision?.assessment, null); assert.equal(result.turnLocalCoverage, undefined);
  assert.equal(result.draft, null); assert.equal(result.reaction.reply, null); assert.equal(result.providerTimings.premiseReviewAttempts, 0);
});

test('production wrapped union correlates assessment, question and reaction for every action before generation', () => {
  const decisions: SingleCoreDecision[] = [
    continuation, transition,
    { ...transition, next: { action: 'CLOSING', question: null } },
    { ...transition, next: { action: 'REPLAY', question: null } },
    { ...transition, next: { action: 'CLARIFICATION', question: { text: '그 활동에서 어떤 기준을 사용했나요?' } } },
    { ...transition, next: { action: 'FOLLOW_UP', question: { text: '그 기준을 선택한 근거는 무엇인가요?', target: '실제로 선택한 기준의 근거', primaryFunction: 'EVIDENCE', depth: 'D2', strategyId: null } } },
  ];
  for (const decision of decisions) {
    const wire = encodeSingleCoreCandidateResponse(decision);
    assert.deepEqual(Object.keys(wire.decision).slice(0, 3), ['kind', 'assessment', 'next']);
    assert.deepEqual(decodeSingleCoreCandidateDecision(wire), decision);
    assert.equal(singleCoreCandidateWireSchema.safeParse(wire).success, true);
    if (decision.assessment) assert.equal(singleCoreCandidateWireSchema.safeParse({ decision: { ...wire.decision, assessment: null } }).success, false);
    else {
      assert.equal(singleCoreCandidateWireSchema.safeParse({ decision: { ...wire.decision, assessment: transition.assessment } }).success, false);
      assert.equal(singleCoreCandidateWireSchema.safeParse({ decision: { ...wire.decision, reaction: transition.reaction } }).success, false);
    }
  }
  const format = zodTextFormat(singleCoreCandidateWireSchema, 'single_interview_decision');
  assert.equal(format.schema.type, 'object'); assert.equal(Object.hasOwn(format.schema, 'anyOf'), false);
  assert.deepEqual(Object.keys(singleCoreDecisionSchema.shape.assessment.shape), ['coverage', 'response', 'reason']);
});

test('uniform medium effort preserves one core call and a nontruncating reasoning budget', async () => {
  const f = fixture('실제로 사용한 비교 기준을 설명했습니다.');
  const result = await runSingleCoreRuntime(f.context, f.session, { ...options({ ...transition, reaction: null }, async request => {
    assert.equal(request.reasoning.effort, 'medium'); assert.equal(request.max_output_tokens, 4000);
    return encodeSingleCoreCandidateResponse({ ...transition, reaction: null });
  }), coreReasoningEffort: 'medium' });
  assert.equal(result.providerTimings.coreModelCalls, 1); assert.equal(result.policyTrace?.coreTimeoutMs, 20000);
  assert.equal(result.policyTrace?.coreOutputTokenBudget, 4000);
});

test('context vocabulary helps the core read terms while original negation, quantities and comparison remain unchanged', async () => {
  const raw = '방전의 질은 반비례하지만 약전의 질은 2배가 아닙니다.';
  const f = fixture(raw); f.turn.questionText = '온도에 따른 약전해질의 전도도 변화를 강전해질과 비교해 주세요.';
  // Only the synthetic fixture question changed; remove its unrelated approved surface binding.
  delete f.turn.metadata.approvedQuestion; f.turn.metadata.premiseValidation!.questionSha256 = (await import('node:crypto')).createHash('sha256').update(f.turn.questionText).digest('hex');
  await runSingleCoreRuntime(f.context, f.session, options({ ...transition, reaction: null }, async request => {
    const payload = JSON.parse(request.input);
    assert.equal(payload.answer.transcriptText, raw);
    assert.deepEqual(new Set(payload.answer.contextVocabulary), new Set(['약전해질', '강전해질', '전도도']));
    assert.equal(payload.answer.pronunciationReadings.length, 0, 'No regex alias should replace these uncertain words.');
    assert.ok(request.instructions.includes('비교를 partial로 소급하지'));
    assert.ok(request.instructions.includes('자료 검색 경로'));
    return encodeSingleCoreDecision({ ...transition, reaction: null });
  }));
  assert.equal(f.turn.rawTranscript, raw);
});

test('single-core neutral paraphrases and approved receipts retain exact source spans without mandatory quote echo', () => {
  const raw = '수치를 GPT로 찾았지만 원자료는 확인하지 않았습니다.';
  for (const text of ['원자료를 확인한 것은 아니라는 말씀이군요.', '네, 알겠습니다.']) {
    const accepted = verifyAcknowledgement(raw, '원자료는 확인하지 않았습니다', text, [], { semanticGrounding: 'single_core' });
    assert.ok(accepted); assert.equal(raw.slice(accepted.span.start, accepted.span.end), accepted.quote);
  }
  assert.equal(verifyAcknowledgement(raw, '확인했습니다', '네, 알겠습니다.', [], { semanticGrounding: 'single_core' }), null);
  assert.equal(verifyAcknowledgement(raw, '원자료', '좋은 답변입니다.', [], { semanticGrounding: 'single_core' }), null);
  assert.equal(verifyAcknowledgement(raw, '원자료', '네, 알겠습니다.', ['네, 알겠습니다.'], { semanticGrounding: 'single_core' }), null);
  assert.doesNotThrow(() => assertInterviewQuestionSpeech('합격해 입학한다면 어떤 분야를 먼저 배우고 싶나요?', { isFirstTurn: false }));
  const proof = verifyAcknowledgement('아무 근거 없습니다.', '아무 근거 없습니다.', '근거가 없다는 말씀이군요. 다음 주제로 이어가겠습니다.', [], { semanticGrounding: 'single_core' });
  assert.ok(proof); assert.equal(proof.quote, '아무 근거 없습니다.');
});

test('core-grounded neutral topic closing can refer to the actual question without echoing an unrelated answer', () => {
  const raw='행사에서 태극기를 흔들었습니다.';
  const spoken='질문은 공원 환경보호 캠페인에서 한 일에 관한 것이었습니다. 이 주제는 여기까지 하겠습니다.';
  const accepted=verifyAcknowledgement(raw,'태극기를 흔들었습니다.',spoken,[],{semanticGrounding:'single_core'});
  assert.ok(accepted);
  assert.equal(accepted.text,spoken);
  assert.equal(raw.slice(accepted.span.start,accepted.span.end),'태극기를 흔들었습니다.');
  assert.equal(spoken.includes(accepted.quote),false,'The exact quote is a source binding, not mandatory spoken text.');
  assert.equal(verifyAcknowledgement(raw,'태극기를 흔들었습니다.','질문과 다른 답변이니 점수가 낮습니다.',[],{semanticGrounding:'single_core'}),null);
  // This gate checks source/tone integrity. The sole core, rather than a TS
  // keyword predicate, must establish the actual question-topic relation.
});
