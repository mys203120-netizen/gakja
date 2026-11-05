/** Anonymized current-domain examples. These are explicit synthetic question
 * approvals, never real student facts or evaluation-scope approval fixtures. */
import { createHash } from 'node:crypto';
import type { InterviewSession, QuestionDraft } from '../../server/protocol';
import type { StudentObjectiveCandidate } from '../../server/question-objective';
import { approveQuestionContract, createQuestionBlueprint, createStudentObjectiveCandidates } from '../../server/question-objective';
import { speechAudioCacheId } from '../../server/providers/clova-tts';
import { loadInterviewContext } from './runtime-context';

export type QuestionDomainFixtureKind = 'student-objective-candidate' | 'prepared-main-candidate' | 'approved-question-contract';
export interface QuestionDomainFixtureCase {
  id: string; kind: QuestionDomainFixtureKind; payload: unknown; expected: boolean; schemaExpected: boolean;
  validation: 'shape' | 'existing_hash_integrity'; draft?: QuestionDraft;
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function createQuestionDomainFixtureCases(): Promise<QuestionDomainFixtureCase[]> {
  const context = await loadInterviewContext(), source = context.student.evidence[0];
  context.target = { ...context.target, studentName: '익명 합성 학생', university: '합성대학교', department: '합성학과', track: '합성전형' } as unknown as typeof context.target;
  context.manifest.target = context.target;
  source.text = '🙂 모둠 탐구에서 함께 자료를 모으고 같은 기준으로 비교함.';
  source.sourceRef.endOffset = source.text.length;
  const selected = createStudentObjectiveCandidates(context).find(item => item.primaryFunction === 'ROLE')!;
  const objective: StudentObjectiveCandidate = { ...selected, id: 'OBJ-synthetic-current-role', semanticKey: 'synthetic-role-purpose',
    anchorRefs: [{ ...selected.anchorRefs[0], start: 3, end: source.text.length }], anchorQuote: source.text.slice(3), knownFacts: [source.text], unknowns: [], forbiddenPremises: [] };
  const common: StudentObjectiveCandidate = { id: 'OBJ-synthetic-common', evidenceIds: [], activityIds: [], primaryFunction: 'MOTIVE', depth: 'D2',
    questionIntent: '합성 전공 선택의 개인적인 계기를 확인한다.', targetEvidence: ['개인적인 선택 계기'], targetDescription: '합성 전공 선택의 개인적인 계기',
    anchorRefs: [], anchorQuote: '', scope: 'common_approved', requiresOpenCheck: true, selectionBasis: '명시적인 합성 정책 모듈',
    grounding: { kind: 'COMMON_APPROVED', moduleId: 'synthetic-module', approvalRevision: 'synthetic-approved-policy-v1', supportTargetId: 'synthetic-target' },
    moduleApproval: { moduleVersion: 'synthetic-modules-v1', questionGuidelinesSha256: sha('synthetic-guideline'), supportTargetId: 'synthetic-target',
      authority: 'explicit_user_approved_local_registry', sourceClauses: ['synthetic-clause'] } };
  const questionText = '모둠 탐구에서 본인이 직접 한 일을 한 가지 설명해 주세요.';
  const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText, questionKind: 'main', parentMainQuestionId: null,
    evidenceIds: [source.id], evidenceQuotes: [{ evidenceId: source.id, quote: source.text, sourceStartOffset: 0, sourceEndOffset: source.text.length, matchKind: 'exact' }],
    primaryFunction: 'ROLE', questionIntent: '공동 활동에서 본인이 실제 한 행동을 확인한다.', targetEvidence: ['본인이 직접 한 행동 한 가지'], depth: 'D2',
    groundingRationale: '합성 검수자가 정확한 원문과 한 가지 요구를 검수한 테스트 자료', validationStatus: 'approved', validationFailures: [],
    premiseValidation: { version: 'question-premise-v1', guidelineVersion: '2.3', status: 'approved', method: 'bounded_semantic_review',
      reviewModel: 'explicit-synthetic-question-reviewer', questionSha256: sha(questionText), coreIntentCount: 1, supportedPremises: [],
      openChecks: [{ questionStartOffset: 0, questionEndOffset: questionText.length, kind: 'open_check' }] } };
  const session = { id: 'synthetic-codec-session', turns: [] } as unknown as InterviewSession;
  draft.questionBlueprint = createQuestionBlueprint(draft, context, session, { questionId: 'synthetic-current-question' });
  draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint);
  const voiceSettings = { speaker: 'synthetic_voice', speed: 0, pitch: 1, volume: 0, format: 'mp3' as const };
  const speechHash = speechAudioCacheId(questionText, voiceSettings);
  const candidate = { id: sha('synthetic-bank-slot-variant'), slotId: 'synthetic-slot-1', mainIndex: 1, variant: 0 as const,
    createdAt: '2026-11-06T00:00:00.000Z', draft, questionSha256: sha(questionText), questionAudioUrl: `/api/audio/${speechHash}`,
    speechHash, audioSha256: sha(Buffer.from('explicit-synthetic-audio-bytes-not-a-production-mp3')), voiceSettings };
  const cases: QuestionDomainFixtureCase[] = [];
  const add = (id: string, kind: QuestionDomainFixtureKind, payload: unknown, expected = true, schemaExpected = expected,
    validation: QuestionDomainFixtureCase['validation'] = 'shape', originalDraft?: QuestionDraft) => cases.push({ id, kind, payload, expected, schemaExpected, validation, ...(originalDraft ? { draft: originalDraft } : {}) });
  add('objective-record-utf16', 'student-objective-candidate', objective);
  add('objective-common-empty-no-fake-record', 'student-objective-candidate', common);
  add('objective-optional-absent', 'student-objective-candidate', selected);
  add('objective-null-is-not-absent', 'student-objective-candidate', { ...objective, knownFacts: null }, false);
  add('objective-fractional-offset', 'student-objective-candidate', { ...objective, anchorRefs: [{ ...objective.anchorRefs[0], start: 1.5 }] }, false);
  add('objective-unknown-field-rejected', 'student-objective-candidate', { ...objective, evaluationScope: 'record_consistency_only' }, false);
  add('contract-current-nullable-digests', 'approved-question-contract', draft.approvedQuestion, true, true, 'existing_hash_integrity', draft);
  add('contract-hash-tampered', 'approved-question-contract', { ...draft.approvedQuestion, contentSha256: 'f'.repeat(64) }, false, true, 'existing_hash_integrity', draft);
  add('contract-blueprint-tampered', 'approved-question-contract', { ...draft.approvedQuestion, blueprint: { ...draft.approvedQuestion.blueprint, questionIntent: '변경된 확인 목적' } }, false, true, 'existing_hash_integrity', draft);
  add('contract-evaluation-approval-is-separate', 'approved-question-contract', { ...draft.approvedQuestion, evaluationScope: 'record_consistency_only' }, false);
  add('contract-validation-invalid', 'approved-question-contract', { ...draft.approvedQuestion, validation: { ...draft.approvedQuestion.validation, method: 'self_approved' } }, false);
  add('candidate-current-v0', 'prepared-main-candidate', candidate, true, true, 'existing_hash_integrity');
  add('candidate-current-v1', 'prepared-main-candidate', { ...candidate, variant: 1 }, true, true, 'existing_hash_integrity');
  add('candidate-variant-invalid', 'prepared-main-candidate', { ...candidate, variant: 2 }, false);
  add('candidate-voice-null-invalid', 'prepared-main-candidate', { ...candidate, voiceSettings: null }, false);
  add('candidate-question-hash-tampered', 'prepared-main-candidate', { ...candidate, questionSha256: 'f'.repeat(64) }, false, true, 'existing_hash_integrity');
  add('candidate-empty-failures-not-missing', 'prepared-main-candidate', { ...candidate, draft: { ...draft, validationFailures: [] } }, true, true, 'existing_hash_integrity');
  return structuredClone(cases);
}
