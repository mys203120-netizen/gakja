import dotenv from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { zodTextFormat } from 'openai/helpers/zod';
import { loadInterviewContextAt, type InterviewContext } from '../server/data/load-interview-context';
import { createSessionQuestionPlan, loadQuestionBank, selectPreparedMainQuestion, type PreparedQuestionBank } from '../server/data/prepared-question-bank';
import { mayAskFollowUp } from '../server/interview-planner';
import { mayAskClarification, mayReplayQuestion, type InterviewSession, type RecordedTurn } from '../server/protocol';
import { observeAnswerSubmission } from '../server/answer-submission';
import { assertQuestionContractIntegrity, bindQuestionContractToTurn } from '../server/question-objective';
import { createSessionRuntime } from '../server/session-runtime';
import { assertRealtimeCoreSource, type RealtimeCoreRequest } from '../server/providers/realtime-core';
import { SINGLE_CORE_CONTRACT_VERSION, encodeSingleCoreCandidateResponse, singleCoreCandidateWireSchema, type SingleCoreDecision } from '../server/providers/single-core-contract';
import { runSingleCoreRuntime, SINGLE_CORE_ENGINE_VERSION } from '../server/providers/single-core-runtime';

const SOURCE_SESSION_ID = '8f54631b-d1ce-404a-97ba-17394fd111b9';
const sourcePath = `data/sessions/${SOURCE_SESSION_ID}.json`;
const journalPath = `data/conversation-logs/${SOURCE_SESSION_ID}.jsonl`;
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

export interface RevisedBankReplaySpec {
  id: string; sourceNumber: 10 | 11 | 19; objectiveId: string; slotId: string; questionText: string;
}
/** Exact reviewed identities and utterances, not a fuzzy topic/keyword lookup. */
export const revisedBankReplaySpecs: readonly RevisedBankReplaySpec[] = [
  { id: 'REVISED-PROCEDURE-Q19', sourceNumber: 19, objectiveId: 'OBJ-ef635c5a46537ba902953c53', slotId: 'objective-slot-OBJ-ef635c5a46537ba902953c53', questionText: '급우들의 진학 고민에 관한 정보를 제공하기까지 어떤 절차를 거쳤나요?' },
  { id: 'REVISED-SURVEY-Q10', sourceNumber: 10, objectiveId: 'OBJ-973c892ff6ef9c6e8e683651', slotId: 'objective-slot-OBJ-973c892ff6ef9c6e8e683651', questionText: '설문 보고서에서 무응답 처리로 평균이 왜곡된 문제를 어떻게 바로잡았나요?' },
  { id: 'REVISED-SURVEY-Q11', sourceNumber: 11, objectiveId: 'OBJ-973c892ff6ef9c6e8e683651', slotId: 'objective-slot-OBJ-973c892ff6ef9c6e8e683651', questionText: '설문 보고서에서 무응답 처리로 평균이 왜곡된 문제를 어떻게 바로잡았나요?' },
];

/** Caller must first load the active bank through loadQuestionBank's source,
 * independent-review, contract and audio validators. This never approves a
 * new sentence: it only rebinds that unchanged Q0 to isolated synthetic IDs. */
export function createRevisedBankCheckpoint(context: InterviewContext, bank: PreparedQuestionBank, source: RecordedTurn, spec: RevisedBankReplaySpec) {
  if (!source.answerId || source.transcriptStatus !== 'finalized' || typeof source.rawTranscript !== 'string' || !source.rawTranscript.trim()) throw new Error('REVISED_SOURCE_ANSWER_INVALID');
  const matches = bank.slots.flatMap(row => row.candidates.map(candidate => ({ row, candidate }))).filter(({ candidate }) => candidate.draft.questionText === spec.questionText);
  if (matches.length !== 1) throw new Error('REVISED_BANK_EXACT_UTTERANCE_NOT_UNIQUE:' + spec.id);
  const { row, candidate } = matches[0], slot = bank.plan.slots.find(item => item.id === spec.slotId);
  if (!slot || row.quarantine || row.slotId !== slot.id || candidate.slotId !== slot.id || candidate.mainIndex !== slot.index || slot.objective?.id !== spec.objectiveId || candidate.variant !== 0) throw new Error('REVISED_BANK_OBJECTIVE_BINDING_MISMATCH:' + spec.id);
  const draft = structuredClone(candidate.draft);
  if (draft.questionKind !== 'main' || draft.parentMainQuestionId !== null || !draft.approvedQuestion || draft.premiseValidation?.method !== 'bounded_semantic_review' || draft.premiseValidation.status !== 'approved' ||
    draft.primaryFunction !== 'PROCESS' || draft.depth !== 'D2' || slot.primaryFunction !== draft.primaryFunction || slot.depth !== draft.depth ||
    slot.objective.questionIntent !== draft.questionIntent || !same(slot.objective.targetEvidence, draft.targetEvidence) || draft.targetEvidence.length !== 1 || candidate.questionSha256 !== digest(draft.questionText)) throw new Error('REVISED_BANK_REVIEWED_CONTRACT_MISMATCH:' + spec.id);
  assertQuestionContractIntegrity(draft, draft.approvedQuestion);
  const now = new Date().toISOString();
  const plan = createSessionQuestionPlan(context, bank, { sessionSeed: 'revised-bank-exact-answer-' + spec.id, history: [], mode: 'mock' });
  const first = plan.slots.find(item => item.candidateSlotId === slot.id);
  if (!first) throw new Error('REVISED_BANK_APPROVED_SLOT_UNAVAILABLE:' + spec.id);
  plan.slots = [first, ...plan.slots.filter(item => item !== first)].map((item, index) => ({ ...item, index: index + 1 }));
  const session: InterviewSession = {
    id: randomUUID(), createdAt: now, updatedAt: now, status: 'active', evaluationStatus: 'pending', target: structuredClone(context.target),
    runtime: createSessionRuntime(context, { id: 'synthetic-revised-bank-answer-replay', mode: 'local-development' }, now),
    sourceManifest: { ...structuredClone(context.manifest), interviewPlan: structuredClone(plan) },
    durationSeconds: plan.durationSeconds, mainQuestionTarget: plan.mainQuestionTarget, plan, hasGreeted: true,
    turns: [], questionPresentations: [], questionPresentationEventIds: [], followUpCountByMainQuestion: {}, elapsedMs: 30_000,
    metrics: { verification: { syntheticTest: true, syntheticFrozenHumanReplay: true, voiceFree: true, persistedAsHumanSession: false,
      scenario: 'revised-approved-question-with-exact-historical-answer', sourceSessionId: SOURCE_SESSION_ID, sourceTurnId: source.id, sourceAnswerId: source.answerId } },
  };
  const selected = selectPreparedMainQuestion(bank, session, 1);
  if (!selected || selected.candidateId !== candidate.id || selected.draft.questionText !== spec.questionText) throw new Error('REVISED_BANK_SELECTION_CHANGED:' + spec.id);
  const id = randomUUID(), answerId = randomUUID();
  const binding = bindQuestionContractToTurn(draft, context, session, id, { objectiveCandidate: slot.objective });
  const turn: RecordedTurn = {
    id, answerId, questionText: draft.questionText, questionKind: 'main', parentMainQuestionId: id,
    mainIndex: 1, mainCount: plan.mainQuestionTarget, followUpIndex: 0, evidenceIds: [...draft.evidenceIds],
    questionAudioUrl: selected.audioUrl, acknowledgement: null, acknowledgementAudioUrl: null, interviewerId: selected.slot.interviewerId,
    rawTranscript: source.rawTranscript, transcriptStatus: 'finalized',
    metrics: structuredClone(source.metrics),
    answerObservation: observeAnswerSubmission(source.rawTranscript, source.metrics, source.metadata.answerEndingObservation),
    metadata: { ...draft, ...binding, rulesVersion: context.manifest.rulesVersion, generatedAt: now,
      answerTurnId: null, sourceAnswerId: null, sourceRefIds: [...draft.evidenceIds], activityIds: [...slot.activityIds],
      supportTarget: structuredClone(context.target), questionClusterId: id, parentQuestionId: null,
      planSlotId: selected.slot.id, topicArea: selected.slot.topicArea, interviewerRole: selected.slot.interviewerRole,
      answerCaptureRevision: 0, ...(source.metadata.answerEndingObservation ? { answerEndingObservation: structuredClone(source.metadata.answerEndingObservation) } : {}),
    },
  };
  Object.assign(turn.metadata, { questionBankKey: bank.key, questionBankCandidateId: candidate.id });
  session.turns.push(turn); session.followUpCountByMainQuestion[id] = 0;
  assertQuestionContractIntegrity({ ...draft, ...binding }, binding.approvedQuestion);
  assertRealtimeCoreSource(context, session);
  return { session, candidate, slot, binding };
}

/** Capture(v1) is intentionally compatible with benchmark-latest-interview.ts.
 * The neutral adapter only observes a request; its decision is never a result,
 * independent review, speech approval, or a modification to an actual session. */
export async function captureRevisedBankRequests(root = process.cwd()) {
  const sourceBytes = await readFile(path.resolve(root, sourcePath)), journalBytes = await readFile(path.resolve(root, journalPath));
  const original = JSON.parse(sourceBytes.toString('utf8')) as InterviewSession;
  if (original.id !== SOURCE_SESSION_ID || original.turns.length !== 22 || original.runtime?.owner.id !== 'local-development-owner') throw new Error('REVISED_HUMAN_SOURCE_INVALID');
  const context = await loadInterviewContextAt(root, { writeManifest: false });
  if (context.errors.length) throw new Error('REVISED_CONTEXT_INVALID:' + context.errors.join('|'));
  const sourceManifest = original.sourceManifest as InterviewContext['manifest'];
  const pdf = context.manifest.files.find(file => file.role === 'studentPdf')?.sha256;
  if (!pdf || pdf !== sourceManifest.files.find(file => file.role === 'studentPdf')?.sha256) throw new Error('REVISED_HUMAN_PDF_CHANGED');
  const bank = await loadQuestionBank(context, { root });
  if (!bank) throw new Error('REVISED_ACTIVE_APPROVED_BANK_NOT_READY');
  const bankPath = `data/prepared/question-banks/${bank.key}.json`, bankBytes = await readFile(path.resolve(root, bankPath));
  const cases = [];
  for (const spec of revisedBankReplaySpecs) {
    const source = original.turns[spec.sourceNumber - 1];
    const { session, candidate, slot, binding } = createRevisedBankCheckpoint(context, bank, source, spec);
    let request: RealtimeCoreRequest | undefined, adapters = 0;
    const neutral: SingleCoreDecision = { assessment: { coverage: 'unknown', response: 'answered', reason: '입력 캡처 전용이며 실제 모델의 답변 판정이 아님' }, next: { action: 'TRANSITION', question: null }, reaction: null };
    const result = await runSingleCoreRuntime(context, session, {
      candidateOnly: true, policyMode: 'compiled', coreReasoningEffort: 'low',
      allowFollowUp: mayAskFollowUp(session, session.durationSeconds!, 2),
      allowClarification: mayAskClarification(session, session.durationSeconds!), allowReplay: mayReplayQuestion(session, session.durationSeconds!),
      requestSingleCore: async input => { adapters++; request = structuredClone(input); return encodeSingleCoreCandidateResponse(neutral); },
      requestFactReview: async () => { throw new Error('REVISED_CAPTURE_MUST_NOT_REVIEW'); },
      requestSurfaceRepair: async () => { throw new Error('REVISED_CAPTURE_MUST_NOT_REPAIR'); },
    });
    if (!request || adapters !== 1 || result.execution?.status !== 'ready') throw new Error('REVISED_REQUEST_NOT_CAPTURED:' + spec.id);
    const current = session.turns[0];
    cases.push({ id: spec.id, number: spec.sourceNumber, turnId: current.id, answerId: current.answerId!,
      question: current.questionText, rawTranscript: current.rawTranscript!, questionSha256: digest(current.questionText), transcriptSha256: digest(current.rawTranscript!),
      endingObservation: current.metadata.answerEndingObservation ?? null, elapsedMs: session.elapsedMs,
      expected: { actions: ['TRANSITION', 'FOLLOW_UP'], coverage: ['met'], critical: true,
        note: '이미 말한 수행 방법을 수용한다. F는 실제 미답 하위 지점이나 새 주장에만 허용하며 전체 요구를 C/F로 다시 묻지 않는다. 행동 라벨 통과와 별도로 원문 의미 검토가 필요하다.' },
      request, requestSha256: digest(JSON.stringify(request)), oldDecision: null, policyTrace: result.policyTrace,
      provenance: { syntheticTest: true, sourceSessionId: SOURCE_SESSION_ID, sourceNumber: spec.sourceNumber, sourceTurnId: source.id, sourceAnswerId: source.answerId,
        originalQuestion: source.questionText, originalQuestionSha256: digest(source.questionText), originalTranscriptSha256: digest(source.rawTranscript!),
        changedQuestionWithUnchangedHistoricalAnswer: true, originalQuestionAnswerPairReplayed: false,
        observationOrigin: 'historical answer capture timing, not a new voice measurement',
        bankKey: bank.key, bankContentSha256: bank.contentSha256, candidateId: candidate.id, slotId: slot.id, objectiveId: slot.objective!.id,
        sourceApprovedContractSha256: candidate.draft.approvedQuestion!.contentSha256, boundApprovedContractSha256: binding.approvedQuestion.contentSha256,
        contract: { questionIntent: current.metadata.questionIntent, targetEvidence: current.metadata.targetEvidence, primaryFunction: current.metadata.primaryFunction, depth: current.metadata.depth },
        independentPremiseReview: 'existing active bank approval; capture adapter performs no new review', questionPlayed: false, voiceCalls: 0, providerCalls: 0 },
    });
  }
  if (digest(await readFile(path.resolve(root, sourcePath))) !== digest(sourceBytes) || digest(await readFile(path.resolve(root, journalPath))) !== digest(journalBytes) || digest(await readFile(path.resolve(root, bankPath))) !== digest(bankBytes)) throw new Error('REVISED_CAPTURE_SOURCE_CHANGED');
  return { version: 'latest-human-frozen-requests-v1' as const, label: 'quality-v12-revised-approved-bank-exact-historical-answers', createdAt: new Date().toISOString(),
    sourcePath, sourceSha256: digest(sourceBytes), journalPath, journalSha256: digest(journalBytes), contextManifestSha256: digest(JSON.stringify(context.manifest)),
    moduleRoot: root, engineVersion: SINGLE_CORE_ENGINE_VERSION, contractVersion: SINGLE_CORE_CONTRACT_VERSION,
    schema: zodTextFormat(singleCoreCandidateWireSchema, 'single_interview_decision') as unknown as Record<string, unknown>, cases,
    sourceRecordsModified: false as const, providerCalls: 0 as const,
    provenance: { syntheticTest: true, originalHumanSessionChanged: false, newHumanInterview: false, fullAudioE2E: false, originalQuestionAnswerPairReplayed: false,
      bankPath, bankFileSha256: digest(bankBytes), bankKey: bank.key, bankContentSha256: bank.contentSha256,
      note: '새 승인 문항에 과거 실제 답변 원문을 대입하는 독립 입력 캡처. 모델 판정과 최종 사실 검수·음성 재생은 별도 실행해야 한다.' },
  };
}

export async function writeRevisedBankCapture(file: string, value: unknown, root = process.cwd()) {
  const resolved = path.resolve(root, file), relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !/^(?:artifacts|\.local)[/\\]/u.test(relative)) throw new Error('REVISED_CAPTURE_OUTPUT_OUTSIDE_WORKSPACE');
  await mkdir(path.dirname(resolved), { recursive: true });
  const handle = await open(resolved, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); } finally { await handle.close(); }
}

async function main() {
  dotenv.config({ path: '.env.local', quiet: true });
  const args = process.argv.slice(2);
  if (args.some(value => !value.startsWith('--out='))) throw new Error('USE_OPTIONAL_OUT_ONLY_NO_LIVE_PROVIDER_CALLS');
  const output = args.find(value => value.startsWith('--out='))?.slice('--out='.length) ?? '.local/engine-refactor-bench/quality-v12-revised-bank-requests.json';
  const captured = await captureRevisedBankRequests();
  await writeRevisedBankCapture(output, captured);
  console.log(JSON.stringify({ path: output, cases: captured.cases.map(item => item.id), providerCalls: 0, sourceRecordsModified: false, fullAudioE2E: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => {
  console.error(error instanceof Error ? error.message : 'REVISED_CAPTURE_FAILED'); process.exitCode = 1;
});
