import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { compareDeepBankRebindQuestion, deepRebindDigest, planDeepBankRebind } from '../server/data/deep-bank-rebind';
import { checkDeepBankRebind, prepareDeepBankRebindCli } from '../scripts/prepare-deep-bank-rebind';
import { loadStagedInterviewContextAt } from '../server/data/staged-interview-context';
import { FULL_ANALYSIS_CURRENT, type FullRecordSource } from '../server/data/full-student-analysis';
import { approveQuestionContract, createQuestionBlueprint, type StudentObjectiveCandidate } from '../server/question-objective';
import { buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview } from '../server/providers/question-premises';
import { resolveVoiceSettings, speechAudioCacheId } from '../server/providers/clova-tts';
import type { InterviewContext, StudentEvidence } from '../server/data/load-interview-context';
import type { PreparedMainCandidate, PreparedQuestionBank } from '../server/data/prepared-question-bank';
import type { InterviewPlan, InterviewPlanSlot } from '../server/interview-planner';
import type { InterviewSession, QuestionDraft } from '../server/protocol';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const text = '공동 탐구 보고서를 작성하고 그 내용을 발표함.';
  const source = { studentId: 'synthetic-student', pdfSha256: sha('synthetic-pdf'), contentSha256: sha('synthetic-record'), pages: [{ page: 1, text }] } as FullRecordSource;
  const evidence: StudentEvidence = { id: 'source-1', activityId: 'activity-1', page: 1, grade: 2, section: '합성 세특', title: '합성 공동 탐구', text,
    sourceKind: 'activity', originEntityId: 'activity-1', confirmationStatus: 'confirmed_from_record', preparationPriority: null, scientificTruthVerification: 'not_independently_verified',
    sourceRef: { file: 'synthetic.pdf', pdfSha256: source.pdfSha256, page: 1, extraction: 'synthetic-exact-fixture', startOffset: 0, endOffset: text.length } };
  const proof = { sourceRefId: 'block-1', page: 1, pageStart: 0, pageEnd: text.length, quote: text, sourceTextSha256: sha(text) };
  const entity = { id: 'activity-1', localId: 'A1', title: evidence.title, grade: 2, area: evidence.section,
    facts: { recordedContext: [proof], studentActions: [], teamActions: [], choiceReasons: [], outcomes: [], teacherObservations: [] }, unknowns: ['개인 역할 미확인'], mergedFromLegacyIds: [] };
  const objective: StudentObjectiveCandidate = { id: 'objective-1', semanticKey: 'synthetic-role-only', activityIds: [entity.id], evidenceIds: [evidence.id],
    primaryFunction: 'ROLE', depth: 'D2', questionIntent: '공동 탐구에서 본인이 맡은 역할 한 가지', targetEvidence: ['본인이 맡은 역할 한 가지'], targetDescription: '공동 탐구에서 본인이 맡은 역할 한 가지',
    anchorRefs: [{ kind: 'RECORD', sourceId: evidence.id, revision: source.pdfSha256, start: 0, end: text.length, confirmationStatus: 'confirmed_from_record', claimStatus: 'record_fact' }],
    anchorQuote: text, scope: 'record_based', requiresOpenCheck: true, selectionBasis: '실제 개인 역할은 답변으로 확인한다.', originKind: 'activity', originEntityId: entity.id,
    knownFacts: [text], unknowns: ['개인 역할 미확인'], forbiddenPremises: ['팀 전체 행동을 개인 행동으로 단정하지 않는다.'], analysisRevision: 'old-revision', priority: 'A' };
  const oldContext = { target: { studentName: '합성 학생', university: '합성 대학', department: '합성 학과', track: '합성 전형', year: 2027 }, errors: [],
    manifest: { errors: [], files: [{ role: 'questionGuidelines', path: 'synthetic.md', sha256: sha('synthetic-policy') }], rulesVersion: 'synthetic-rules' },
    student: { studentId: source.studentId, pdfSha256: source.pdfSha256, evidence: [evidence] },
    studentAnalysis: { studentId: source.studentId, revision: 'old-revision', contentSha256: sha('old-common'), sourceContentSha256: source.contentSha256, activities: [entity], academicRecords: [], trajectories: [] },
    targetAnalysis: { contentSha256: sha('old-target'), objectives: [structuredClone(objective)] } } as unknown as InterviewContext;
  const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: '공동 탐구에서 본인이 맡은 역할은 무엇인가요?', questionKind: 'main', parentMainQuestionId: null,
    evidenceIds: [evidence.id], evidenceQuotes: [{ evidenceId: evidence.id, quote: text }], primaryFunction: 'ROLE', depth: 'D2', questionIntent: objective.questionIntent,
    targetEvidence: [...objective.targetEvidence], groundingRationale: '합성 기록의 공동 탐구 참여만 근거로 개인 역할의 존재와 내용을 묻는다.', validationStatus: 'approved', validationFailures: [] };
  // A deterministic test review, not a provider call or real-student approval.
  draft.premiseValidation = finalizeQuestionPremiseReview({ verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true,
    premises: [{ questionSpan: '공동 탐구', basis: 'record', sourceId: evidence.id, supportQuote: text, supported: true }] }, buildQuestionPremiseReviewInput(draft, [evidence]), 'synthetic-reviewer');
  const session = { id: 'synthetic-offline-session', turns: [] } as unknown as InterviewSession;
  draft.questionBlueprint = createQuestionBlueprint(draft, oldContext, session, { objectiveCandidate: objective });
  draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint);
  const voice = resolveVoiceSettings('synthetic-speaker', {}), audioBytes = Buffer.from('synthetic-audio-bytes-not-real-tts');
  const candidate: PreparedMainCandidate = { id: 'synthetic-old-candidate', slotId: 'slot-1', mainIndex: 1, variant: 0, createdAt: '2026-11-05T00:00:00.000Z', draft,
    questionSha256: sha(draft.questionText), speechHash: speechAudioCacheId(draft.questionText, voice), questionAudioUrl: `/api/audio/${speechAudioCacheId(draft.questionText, voice)}`,
    audioSha256: sha(audioBytes), voiceSettings: voice };
  const slot: InterviewPlanSlot = { id: 'slot-1', index: 1, topicArea: 'community_values', label: '합성 역할', evidenceIds: [evidence.id], activityIds: [entity.id], primaryFunction: 'ROLE', questionIntent: objective.questionIntent,
    depth: 'D2', interviewerId: 'interviewer-1', interviewerRole: 'community_talent', schoolConnections: [], objective, semanticKey: objective.semanticKey };
  const plan: InterviewPlan = { policyVersion: 'synthetic-plan', durationSeconds: 720, mainQuestionTarget: 1, slots: [slot], limitations: [], purpose: 'candidate_pool' };
  const body = { schemaVersion: 'synthetic-bank', status: 'ready', key: sha('synthetic-bank'), createdAt: candidate.createdAt, completedAt: candidate.createdAt, plan,
    target: oldContext.target, rulesVersion: 'synthetic-rules', activitiesContentSha256: null, sourceFingerprint: sha('synthetic-context'), questionModel: 'synthetic-reviewer', voices: { primary: voice, secondary: voice },
    slots: [{ slotId: slot.id, mainIndex: 1, candidates: [candidate] }] };
  const bank = { ...body, contentSha256: deepRebindDigest(body) } as PreparedQuestionBank;
  const stagedContext = structuredClone(oldContext), stagedPlan = structuredClone(plan);
  Object.assign(stagedContext.studentAnalysis!, { revision: 'deep-revision', contentSha256: sha('deep-common') });
  stagedContext.targetAnalysis!.contentSha256 = sha('deep-target');
  stagedContext.targetAnalysis!.objectives[0].analysisRevision = 'deep-revision';
  stagedContext.targetAnalysis!.objectives[0].priority = 'S';
  stagedPlan.slots[0].objective!.analysisRevision = 'deep-revision';
  return { oldContext, stagedContext, bank, stagedPlan, stagedVoices: bank.voices, source, candidate, audioBytes };
}

test('new common hash and priority do not grant approval: exact demand is only ready for a fresh independent review', () => {
  const input = fixture(), before = JSON.stringify(input);
  const row = compareDeepBankRebindQuestion(input, input.candidate, input.audioBytes);
  assert.equal(row.status, 'ready_for_independent_review'); assert.deepEqual(row.reasons, []);
  assert.equal(row.reviewInput?.question.questionText, input.candidate.draft.questionText);
  assert.equal(row.reviewInput?.sources[0].text, input.oldContext.student.evidence[0].text);
  assert.equal('premiseValidation' in row.reviewInput!, false);
  assert.equal(JSON.stringify(input), before, 'donor question, approval, context and new analysis are immutable');
});

test('same ID or semanticKey cannot silently approve a broadened purpose or a new hidden required answer', () => {
  const input = fixture();
  input.stagedContext.targetAnalysis!.objectives[0].targetEvidence.push('성과와 배운 점까지 설명');
  input.stagedPlan.slots[0].objective!.targetEvidence.push('성과와 배운 점까지 설명');
  const row = compareDeepBankRebindQuestion(input, input.candidate, input.audioBytes);
  assert.equal(row.status, 'pending_manual_match'); assert.ok(row.objectiveContractDifferences.includes('targetEvidence'));
  assert.equal(row.reviewInput, null);
});

test('a missing objective is held even when another ID has exactly the same semanticKey and wording', () => {
  const input = fixture(); input.stagedPlan.slots[0].objective!.id = 'new-id-with-same-words';
  const row = compareDeepBankRebindQuestion(input, input.candidate, input.audioBytes);
  assert.ok(row.reasons.includes('EXACT_OBJECTIVE_ID_AND_KEY_MISSING'));
  assert.equal(row.stagedObjectiveId, null); assert.equal(row.reviewInput, null);
  assert.equal(row.originalTargetObjective?.id, 'objective-1', 'the report exposes an explicit manual import candidate without importing it');
});

test('an ephemeral matching plan cannot stand in for a purpose missing from the pinned target analysis', () => {
  const input = fixture(); input.stagedContext.targetAnalysis!.objectives = [];
  const row = compareDeepBankRebindQuestion(input, input.candidate, input.audioBytes);
  assert.ok(row.reasons.includes('TARGET_OBJECTIVE_NOT_IN_PINNED_ANALYSIS'));
  assert.equal(row.status, 'pending_manual_match'); assert.equal(row.reviewInput, null);
});

test('changed unknown or prohibited premise is not dismissed as harmless revision metadata', () => {
  for (const field of ['unknowns', 'forbiddenPremises'] as const) {
    const input = fixture(); input.stagedContext.targetAnalysis!.objectives[0][field] = ['다르게 확인해야 하는 조건'];
    const row = compareDeepBankRebindQuestion(input, input.candidate, input.audioBytes);
    assert.ok(row.objectiveContractDifferences.includes(field)); assert.equal(row.status, 'pending_manual_match');
  }
});

test('original source spans and literal bytes must still match the same PDF; old approval cannot authorize changed text', () => {
  const input = fixture(); input.stagedContext.student.evidence[0].text += ' 개인 실험을 주도함.';
  const row = compareDeepBankRebindQuestion(input, input.candidate, input.audioBytes);
  assert.ok(row.reasons.includes('EXACT_RECORD_EVIDENCE_CHANGED:source-1')); assert.equal(row.reviewInput, null);
  const offsets = fixture(); offsets.stagedContext.student.evidence[0].sourceRef.endOffset--;
  assert.equal(compareDeepBankRebindQuestion(offsets, offsets.candidate, offsets.audioBytes).status, 'pending_manual_match');
});

test('added source-bound entity facts are visible to the required new review, while loss of a seed fact is held', () => {
  const input = fixture(), current = input.stagedContext.studentAnalysis!.activities[0];
  current.unknowns.push('새로 확인할 지점');
  const row = compareDeepBankRebindQuestion(input, input.candidate, input.audioBytes);
  assert.equal(row.status, 'ready_for_independent_review'); assert.deepEqual(row.changedEntityContextIds, ['activity-1']);
  assert.deepEqual((row.currentMeaningContext!.entities[0] as typeof current).unknowns, current.unknowns);
  current.facts.recordedContext = [];
  assert.ok(compareDeepBankRebindQuestion(input, input.candidate, input.audioBytes).reasons.includes('REFERENCED_ENTITY_OR_FACT_NOT_PRESERVED:activity-1'));
});

test('a second evidence row carries its own academic entity and cannot lose typed literal metadata behind the primary origin ID', () => {
  const input = fixture(), second = { ...structuredClone(input.oldContext.student.evidence[0]), id: 'source-2', activityId: '', sourceKind: 'academic_record' as const, originEntityId: 'academic-2' };
  const academic = { id: 'academic-2', localId: 'C2', grade: 2, semester: 1, subject: '수학Ⅱ', gradingSystem: 'achievement' as const, recordedValues: ['A'], proofs: [], interpretationLimit: '합성 고정 행', comparisonEligible: true, literalValues: [] };
  for (const context of [input.oldContext, input.stagedContext]) { context.student.evidence.push(structuredClone(second)); context.studentAnalysis!.academicRecords.push(structuredClone(academic)); }
  input.bank.plan.slots[0].objective!.evidenceIds.push(second.id);
  input.stagedPlan.slots[0].objective!.evidenceIds.push(second.id);
  const row = compareDeepBankRebindQuestion(input, input.candidate, input.audioBytes);
  assert.equal(row.status, 'ready_for_independent_review');
  assert.ok(row.currentMeaningContext!.entities.some(entity => (entity as { id: string }).id === academic.id));
  input.stagedContext.studentAnalysis!.academicRecords[0].gradingSystem = 'nine_grade';
  assert.ok(compareDeepBankRebindQuestion(input, input.candidate, input.audioBytes).reasons.includes('REFERENCED_ENTITY_OR_FACT_NOT_PRESERVED:academic-2'));
});

test('missing/corrupt audio or changed voice settings is held without synthesizing a replacement', () => {
  const input = fixture();
  for (const bytes of [null, Buffer.from('wrong-bytes')]) assert.ok(compareDeepBankRebindQuestion(input, input.candidate, bytes).reasons.includes('DURABLE_AUDIO_BYTES_NOT_VERIFIED'));
  input.stagedVoices.primary = { ...input.stagedVoices.primary, speed: input.stagedVoices.primary.speed + 1 };
  assert.ok(compareDeepBankRebindQuestion(input, input.candidate, input.audioBytes).reasons.includes('VOICE_SETTINGS_OR_ROLE_CHANGED'));
});

test('old utterance or approval corruption fails instead of carrying forward an approved flag', () => {
  const input = fixture(); input.candidate.draft.questionText += ' 결과도 말해 주세요.';
  assert.throws(() => compareDeepBankRebindQuestion(input, input.candidate, input.audioBytes), /QUESTION_CONTRACT_MUTATED/u);
});

test('a complete dry-run verifies disk bytes and reports zero API/TTS, no approval and no activation', async t => {
  const input = fixture(), root = await mkdtemp(path.join(os.tmpdir(), 'deep-bank-plan-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('deep-bank-plan-')); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'data/audio'), { recursive: true }); await writeFile(path.join(root, 'data/audio', `${input.candidate.speechHash}.mp3`), input.audioBytes);
  const report = await planDeepBankRebind(input, root);
  assert.deepEqual(report.counts, { total: 1, readyForIndependentReview: 1, pendingManualMatch: 0 });
  assert.equal(report.externalProviderCalls, 0); assert.equal(report.ttsCalls, 0); assert.equal(report.approvalGranted, false); assert.equal(report.activated, false);
  assert.equal(report.paidPreparationPlan.maxPhysicalLlmCalls, 30); assert.equal(report.paidPreparationPlan.questionGenerationCalls, 0);
  const otherStudent = fixture(); otherStudent.stagedContext.studentAnalysis!.studentId = 'another-student';
  await assert.rejects(planDeepBankRebind(otherStudent, root), /STUDENT_RECORD_OR_TARGET_CHANGED/u);
  const otherPolicy = fixture(); otherPolicy.stagedContext.manifest.files[0].sha256 = sha('changed-policy');
  await assert.rejects(planDeepBankRebind(otherPolicy, root), /POLICY_OR_OFFICIAL_SOURCE_CHANGED/u);
});

test('check command reserves a new report before context loading, and refuses implicit paid or activation options', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deep-bank-check-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('deep-bank-check-')); await rm(root, { recursive: true, force: true }); });
  await mkdir(path.join(root, 'artifacts')); const file = path.join(root, 'artifacts/original.json'); await writeFile(file, 'preserved original');
  await assert.rejects(checkDeepBankRebind({ root, revisionPath: 'missing-analysis', output: 'artifacts/original.json' }), { code: 'EEXIST' });
  assert.equal(await readFile(file, 'utf8'), 'preserved original');
  for (const option of ['--run-live', '--activate', '--max-llm-calls=30']) await assert.rejects(prepareDeepBankRebindCli(['--check', '--revision=missing', '--output=artifacts/new.json', option], root), /CHECK_REVISION_AND_NEW_OUTPUT_ONLY|EXPLICIT_LIVE_PHASE_AND_CAPS_REQUIRED/u);
});

test('explicit staged-context read-only option preserves the existing source manifest and analysis pointer', async () => {
  const pointerBytes = await readFile(FULL_ANALYSIS_CURRENT), manifestBytes = await readFile('data/prepared/source-manifest.json');
  const pointer = JSON.parse(pointerBytes.toString('utf8')) as { path: string };
  const loaded = await loadStagedInterviewContextAt(process.cwd(), pointer.path, { writeManifest: false });
  assert.equal(loaded.context.errors.length, 0);
  assert.equal(sha(await readFile(FULL_ANALYSIS_CURRENT)), sha(pointerBytes));
  assert.equal(sha(await readFile('data/prepared/source-manifest.json')), sha(manifestBytes));
});
