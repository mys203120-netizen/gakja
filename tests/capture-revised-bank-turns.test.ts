import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { InterviewContext, StudentEvidence } from '../server/data/load-interview-context';
import type { PreparedQuestionBank } from '../server/data/prepared-question-bank';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';
import { approveQuestionContract, assertQuestionContractIntegrity, createQuestionBlueprint, type StudentObjectiveCandidate } from '../server/question-objective';
import { createRevisedBankCheckpoint, type RevisedBankReplaySpec } from '../scripts/capture-revised-bank-turns';

/** All records, reviews and audio references below are explicitly synthetic.
 * These tests exercise binding only; they never certify a production bank. */
function fixture() {
  const text = '합성 자료를 모은 뒤 항목별로 정리함.';
  const evidence: StudentEvidence = { id: 'SYN-E1', activityId: 'SYN-A1', page: 1, grade: 2, section: '합성 세특', title: '합성 자료 정리', text,
    sourceRef: { file: 'synthetic.pdf', pdfSha256: 'a'.repeat(64), page: 1, extraction: 'explicit-synthetic-fixture', startOffset: 0, endOffset: text.length },
    confirmationStatus: 'confirmed_from_record', preparationPriority: null, scientificTruthVerification: 'not_independently_verified' };
  const context = { target: { university: '합성 대학', department: '합성 학과' }, student: { evidence: [evidence] }, school: { sources: [] },
    errors: [], interviewerPolicy: null, questionStrategies: null,
    manifest: { rulesVersion: 'synthetic-revised-bank', files: [{ role: 'studentPdf', path: 'synthetic.pdf', sha256: 'a'.repeat(64) }],
      sourceIntegrity: { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true } },
  } as unknown as InterviewContext;
  const spec: RevisedBankReplaySpec = { id: 'SYN-REVISED-Q19', sourceNumber: 19, objectiveId: 'SYN-OBJ1', slotId: 'synthetic-objective-slot-1', questionText: '합성 자료를 정리할 때 어떤 절차를 거쳤나요?' };
  const objective: StudentObjectiveCandidate = { id: spec.objectiveId, evidenceIds: [evidence.id], activityIds: [evidence.activityId],
    primaryFunction: 'PROCESS', depth: 'D2', questionIntent: '자료 정리에 거친 수행 절차를 확인한다.', targetEvidence: ['실제 정리 절차 한 단계'],
    targetDescription: '자료 정리에 실제로 거친 한 단계', anchorRefs: [], anchorQuote: text, scope: 'record_based', requiresOpenCheck: false, selectionBasis: '명시적 합성 테스트' };
  const draft: QuestionDraft = { questionText: spec.questionText, acknowledgement: null, acknowledgementQuote: null,
    questionKind: 'main', parentMainQuestionId: null, evidenceIds: [evidence.id], evidenceQuotes: [{ evidenceId: evidence.id, quote: text }],
    primaryFunction: objective.primaryFunction, depth: objective.depth, questionIntent: objective.questionIntent, targetEvidence: [...objective.targetEvidence],
    groundingRationale: '합성 원문에 기록된 자료 정리 절차를 확인한다.', validationStatus: 'approved', validationFailures: [],
    premiseValidation: { version: 'question-premise-v1', guidelineVersion: '2.3', method: 'bounded_semantic_review', status: 'approved', reviewModel: 'explicit-synthetic-review-only',
      questionSha256: createHash('sha256').update(spec.questionText).digest('hex'), coreIntentCount: 1, supportedPremises: [],
      openChecks: [{ questionStartOffset: 0, questionEndOffset: spec.questionText.length, kind: 'open_check' }] },
  };
  draft.questionBlueprint = createQuestionBlueprint(draft, context, { id: 'synthetic-offline', turns: [] } as unknown as InterviewSession, { questionId: 'synthetic-offline-q0', objectiveCandidate: objective });
  draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint);
  const slot = { id: spec.slotId, index: 1, topicArea: 'academic_inquiry' as const, label: '합성 탐구', evidenceIds: [evidence.id], activityIds: [evidence.activityId],
    primaryFunction: 'PROCESS' as const, questionIntent: objective.targetDescription, depth: 'D2' as const, interviewerId: 'interviewer-1' as const, interviewerRole: 'academic' as const, schoolConnections: [], objective };
  const bank = { status: 'ready', key: 'b'.repeat(64), contentSha256: 'c'.repeat(64), target: context.target,
    plan: { policyVersion: 'synthetic-pool', durationSeconds: 720, mainQuestionTarget: 1, purpose: 'candidate_pool', scheduling: 'time_based', slots: [slot], limitations: [] },
    slots: [{ slotId: slot.id, mainIndex: 1, candidates: [{ id: 'synthetic-candidate', slotId: slot.id, mainIndex: 1, variant: 0, draft,
      questionSha256: draft.premiseValidation!.questionSha256, questionAudioUrl: '/api/audio/explicit-synthetic-unused', voiceSettings: { speaker: 'synthetic-voice', speed: 0, pitch: 0, volume: 0, format: 'mp3' } }] }],
  } as unknown as PreparedQuestionBank;
  const raw = '  자료를 모으고 항목별로 나눴습니다. \n';
  const source = { id: 'original-synthetic-turn', answerId: 'original-synthetic-answer', questionText: '이전 합성 질문은 어떤 방식이었나요?', rawTranscript: raw,
    transcriptStatus: 'finalized', metrics: { speech: { durationMs: 6000, speakingMs: 4200 } },
    metadata: { answerEndingObservation: { stopSource: 'space', speechActiveAtEnd: false, microphoneEnabled: true, vadAvailable: true } },
  } as unknown as RecordedTurn;
  return { context, bank, source, spec };
}

test('revised question capture rebinds the already reviewed narrow contract and preserves exact historical words without recording playback', () => {
  const f = fixture(), before = JSON.stringify(f);
  const { session, candidate, binding } = createRevisedBankCheckpoint(f.context, f.bank, f.source, f.spec);
  const turn = session.turns[0];
  assert.notEqual(turn.id, f.source.id); assert.notEqual(turn.answerId, f.source.answerId);
  assert.equal(turn.rawTranscript, f.source.rawTranscript); assert.equal(turn.questionText, f.spec.questionText);
  assert.deepEqual(turn.metadata.targetEvidence, candidate.draft.targetEvidence);
  assert.equal(turn.metadata.questionIntent, candidate.draft.questionIntent);
  assert.equal(turn.metadata.primaryFunction, 'PROCESS'); assert.equal(turn.metadata.depth, 'D2');
  assert.equal(binding.questionBlueprint.clusterObjective.id, f.spec.objectiveId);
  assert.equal(binding.questionBlueprint.questionId, turn.id);
  assert.equal(binding.questionBlueprint.target.description, candidate.draft.questionBlueprint!.target.description);
  assert.deepEqual(turn.metadata.premiseValidation, candidate.draft.premiseValidation);
  const boundDraft = { ...candidate.draft, ...binding };
  assert.doesNotThrow(() => assertQuestionContractIntegrity(boundDraft, binding.approvedQuestion));
  assert.deepEqual(session.questionPresentations, []); assert.equal(session.elapsedMs, 30_000);
  assert.equal(session.followUpCountByMainQuestion[turn.id], 0);
  assert.equal(JSON.stringify(f), before, 'The bank, source answer and context are never mutated.');
});

test('revised capture fails closed for stale surface, wrong objective identity, widened target, tampered approval or quarantine', () => {
  const changes = [
    (f: ReturnType<typeof fixture>) => { f.spec.questionText += ' 다시'; },
    (f: ReturnType<typeof fixture>) => { f.spec.objectiveId = 'wrong-objective'; },
    (f: ReturnType<typeof fixture>) => { f.bank.plan.slots[0].objective!.targetEvidence = ['말하지 않은 추가 결과까지']; },
    (f: ReturnType<typeof fixture>) => { f.bank.slots[0].candidates[0].draft.approvedQuestion = undefined; },
    (f: ReturnType<typeof fixture>) => { f.bank.slots[0].candidates[0].draft.questionIntent += ' 변조'; },
    (f: ReturnType<typeof fixture>) => { f.bank.slots[0].quarantine = { status: 'quarantined' } as NonNullable<typeof f.bank.slots[0]['quarantine']>; },
  ];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => createRevisedBankCheckpoint(f.context, f.bank, f.source, f.spec)); }
});
