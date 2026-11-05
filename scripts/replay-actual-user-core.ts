import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { readFile, open, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession } from '../server/protocol';
import { createSessionRuntime } from '../server/session-runtime';
import { assertRealtimeCoreSource } from '../server/providers/realtime-core';
import { assertQuestionContractIntegrity } from '../server/question-objective';
import { findVerifiedSourceQuote } from '../server/providers/question-grounding';
import { verifyAcknowledgement } from '../server/providers/interview-speech';
import { mayAskFollowUp } from '../server/interview-planner';
import { mayAskClarification, mayReplayQuestion } from '../server/protocol';
import { SINGLE_CORE_ENGINE_VERSION, runSingleCoreRuntime } from '../server/providers/single-core-runtime';
import { SINGLE_CORE_CONTRACT_VERSION, SINGLE_CORE_DIALOGUE_RULES, type SingleCoreDecision } from '../server/providers/single-core-contract';
import type { ProviderUsageObservation } from '../server/observability/provider-cost';
import { replayEngineSourceFingerprints } from './live-e2e-replay';
import { FULL_ANALYSIS_CURRENT } from '../server/data/full-student-analysis';
import { verifyStudentSourceText } from '../server/data/verify-student-source';
import { z } from 'zod';
import { interviewConfig } from '../interview.config';
import { loadOfflineSemanticBinding } from './lib/semantic-release-gate';

export const actualUserSourcePins = [
  { round: 1, path: 'data/sessions/2c31b6ae-151c-481c-a39a-1abe97f9ef5a.json', sha256: '1b033dd00ae720b7f7633444703c276a694da1b1be4da37fc8e316293ed1cfe5', count: 9 },
  { round: 2, path: 'data/sessions/c2d3e0bc-e332-4c10-bef0-0a39ce5106f6.json', sha256: 'ecea630f211a7a25d4108145b51b6bfb5f1e7e532fb8d3a3395c1a8fae8512ca', count: 9 },
  { round: 3, path: 'data/sessions/aa8dd0b8-b372-4a70-b068-0dff607c0e7d.json', sha256: '87517330803c5dc5d034ac9c94cfc9319e5f8fd6ddc9332426edad358d7d02c1', count: 7 },
] as const;
export const ACTUAL_USER_MANIFEST_PATH = 'artifacts/actual-user-core-input-manifest-20261104.json';
const archivePath = 'artifacts/actual-user-interviews-20261104-0313-0325.txt';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
interface ExpectedOutcome {
  critical: boolean; coverage: Array<'met' | 'partial' | 'unknown'> | null;
  response: Array<'answered' | 'unavailable' | 'unrelated' | 'unclear'> | null;
  actions: SingleCoreDecision['next']['action'][];
  manualReview: string[];
  mdBasis: string[];
}
const ordinary: ExpectedOutcome = { critical: false, coverage: ['met'], response: ['answered'], actions: ['TRANSITION'],
  manualReview: ['현재 실제 질문에 답한 범위를 유지하며, 새 미답 요구·칭찬·점수·교훈을 만들지 않는다. 호응은 선택 사항이다.'],
  mdBasis: ['MD8 v2.0 §§8,10,13–15', 'MD9 v2.3 §§15–17', 'MD10 v2.3 §§5–7'] };
export const actualUserCriticalLabels: Record<string, Partial<ExpectedOutcome>> = {
  'R1-Q1': { coverage: ['partial', 'unknown'], response: ['answered'], actions: ['FOLLOW_UP', 'CLARIFICATION', 'TRANSITION'],
    manualReview: ['GPT 검색 경로는 비교 근거나 원자료가 아니다. 현재 비교 근거 전체를 다시 물으면 SAME이며 F로 반복하지 않는다. F라면 실제 미답 하위 범위(예: 확인 가능한 원자료 존재) 하나를 좁혀야 한다.'] },
  'R1-Q2': { coverage: ['partial', 'unknown'], response: ['answered', 'unavailable'], actions: ['TRANSITION'],
    manualReview: ['같은 검색 경로 답변 반복을 무관/장난으로 단정하지 않고, 원자료 근거를 새로 제시했다고도 해석하지 않는다. 같은 비교 근거를 계속 재추궁하지 않는다.'] },
  'R1-Q6': { actions: ['TRANSITION', 'FOLLOW_UP'], manualReview: ['변화 방향의 비교 요구는 met이다. 기록된 개념의 작동 원리를 묻는 별도 심화 F는 실익을 설명할 때만 가능하다. 원리를 안 말했다는 이유로 원래 비교를 partial로 소급하지 않는다.'] },
  'R1-Q7': { coverage: ['unknown'], response: ['unavailable'], actions: ['TRANSITION'], manualReview: ['메커니즘 모름을 인정한 범위는 종료한다. 합격 요청을 빌미로 합격 판단·훈계·정답 힌트를 하지 않는다.'] },
  'R1-Q8': { manualReview: ['연결된 관심사가 없다는 부정은 질문의 조건 부재에 대한 유효한 답변이다. 관심사를 새로 꾸며 설명하게 하지 않는다.'] },
  'R2-Q1': { coverage: ['partial', 'unknown'], response: ['answered', 'unavailable'], manualReview: ['아무 근거 없다는 인정의 범위를 받아들이고 비교 근거를 재추궁하지 않는다. 정직성·인성·합격을 평가하지 않는다.'] },
  'R2-Q2': { manualReview: ['본인이 한 일이 있다면 묻는 조건부 역할 질문의 없음 답변은 met이다. 없던 기여를 만들어 설명하도록 요구하지 않는다.'] },
  'R2-Q3': { actions: ['TRANSITION', 'FOLLOW_UP'], manualReview: ['교수님에게 좋은 인상을 주는 활동이라는 선택 기준을 도덕 판단 없이 읽는다. 기준을 제시한 사실과 그 기준의 필요한 심화를 분리한다.'] },
  'R2-Q4': { coverage: ['partial', 'unknown'], response: ['answered', 'unavailable'], actions: ['CLARIFICATION', 'TRANSITION'], manualReview: ['교수님이 잘 알 것이라는 범위 한정·회피를 이전 전체 답변 포기로 확대하지 않는다. 재진술은 같은 전체 요구이며 F를 늘리지 않는다.'] },
  'R2-Q6': { coverage: null, response: null, actions: ['CONTINUE_ANSWER'], manualReview: ['아니었으나로 끝난 실제 발화는 이어질 설명이 남아 있다. 종료 관찰을 지어내지 않고 assessment/reaction/question=null로 계속 받는다.'] },
  'R2-Q7': { actions: ['TRANSITION', 'FOLLOW_UP'], manualReview: ['강전해질/약전해질 문맥 속 방전의 질/약전의 질을 읽되 원문과 반비례/정비례를 보존한다. 불확실한 단어 자체를 정의시키는 F를 만들지 않는다. 과학적 정오와 비교 요구 충족을 구분한다.'] },
  'R2-Q8': { coverage: ['unknown'], response: ['unavailable', 'answered'], actions: ['TRANSITION'], manualReview: ['제대로 못 알아들었으면 꼬리질문하지 말라는 명확한 추가 질문 거절의 범위를 지킨다. 같은 요구로 재진술하여 재추궁하지 않는다.'] },
  'R2-Q9': { coverage: ['partial', 'met', 'unknown'], response: ['answered', 'unavailable'], manualReview: ['이전 거절·부정·비교 방향을 함께 읽고 같은 전도도 설명을 반복 추궁하지 않는다. 앞선 잘못 들은 표현을 새 사실로 승격하지 않는다.'] },
  'R3-Q5': { manualReview: ['이동성/이온화 평형 차이까지 이미 설명했다. 원리 미설명을 이유로 partial 또는 반복 WHY를 만들지 않는다.'] },
};
function expectedFor(id: string): ExpectedOutcome {
  return { ...ordinary, ...actualUserCriticalLabels[id], critical: id in actualUserCriticalLabels };
}
interface FrozenSource {
  round: number; path: string; sha256: string; count: number; sessionId: string; journalPath: string; journalSha256: string;
  historicalSourceManifestSha256: string; historicalSourceFiles: InterviewContext['manifest']['files'];
  historicalRecordIds: InterviewContext['manifest']['recordIds']; studentPdfSha256: string;
}
interface FrozenCase {
  id: string; sourcePath: string; sourceSha256: string; turnIndex: number; turnId: string; answerId: string;
  question: string; rawTranscript: string; questionSha256: string; rawTranscriptSha256: string;
  prefixSha256: string; prefixTurnIds: string[]; originalDecision: unknown;
  originalAcknowledgement: string | null; endingObservation: null; elapsedMs: number;
  elapsedObservation: { journalPath: string; eventId: string; type: 'answer.metrics'; timestamp: string };
  expected: ExpectedOutcome;
}
export interface ActualUserCoreManifest {
  version: 'actual-user-core-input-v1'; createdAt: string; scope: string;
  archive: { path: string; sha256: string }; sources: FrozenSource[]; cases: FrozenCase[];
  historicalEndingObservation: null; sourceRecordsModified: false; liveProviderCalls: 0;
}
interface JournalEvent { eventId: string; timestamp: string; type: string; turnId?: string; answerId?: string; payload?: { elapsedMs?: number; rawTranscript?: string } }
export async function buildActualUserCoreManifest(): Promise<ActualUserCoreManifest> {
  const manifest: ActualUserCoreManifest = { version: 'actual-user-core-input-v1', createdAt: new Date().toISOString(),
    scope: '25 actual user answers with their exact spoken questions and historical prefixes; independent voice-free semantic checkpoints, not continuous or real-voice/STT/TTS E2E.',
    archive: { path: archivePath, sha256: hash(await readFile(archivePath)) }, sources: [], cases: [], historicalEndingObservation: null,
    sourceRecordsModified: false, liveProviderCalls: 0 };
  for (const pin of actualUserSourcePins) {
    const bytes = await readFile(pin.path);
    if (hash(bytes) !== pin.sha256) throw new Error('ACTUAL_USER_ORIGINAL_SESSION_CHANGED');
    const session = JSON.parse(bytes.toString('utf8')) as InterviewSession;
    if (session.turns.length !== pin.count) throw new Error('ACTUAL_USER_ORIGINAL_TURN_COUNT_CHANGED');
    const journalPath = `data/conversation-logs/${session.id}.jsonl`, journalBytes = await readFile(journalPath);
    const events = journalBytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line) as JournalEvent);
    const historical = session.sourceManifest as InterviewContext['manifest'];
    const studentPdfSha256 = historical.files.find(file => file.role === 'studentPdf')?.sha256;
    if (!studentPdfSha256) throw new Error('ACTUAL_USER_ORIGINAL_PDF_HASH_MISSING');
    manifest.sources.push({ ...pin, sessionId: session.id, journalPath, journalSha256: hash(journalBytes),
      historicalSourceManifestSha256: hash(JSON.stringify(historical)), historicalSourceFiles: historical.files,
      historicalRecordIds: historical.recordIds, studentPdfSha256 });
    for (const [index, turn] of session.turns.entries()) {
      const timing = events.find(event => event.type === 'answer.metrics' && event.turnId === turn.id && event.answerId === turn.answerId);
      if (!turn.answerId || turn.transcriptStatus !== 'finalized' || typeof turn.rawTranscript !== 'string' || !Number.isFinite(timing?.payload?.elapsedMs)) throw new Error('ACTUAL_USER_CHECKPOINT_SOURCE_MISSING');
      if (timing!.payload?.rawTranscript !== turn.rawTranscript) throw new Error('ACTUAL_USER_JOURNAL_TRANSCRIPT_MISMATCH');
      manifest.cases.push({ id: `R${pin.round}-Q${index + 1}`, sourcePath: pin.path, sourceSha256: pin.sha256, turnIndex: index,
        turnId: turn.id, answerId: turn.answerId, question: turn.questionText, rawTranscript: turn.rawTranscript,
        questionSha256: hash(turn.questionText), rawTranscriptSha256: hash(turn.rawTranscript), prefixSha256: hash(JSON.stringify(session.turns.slice(0, index + 1))),
        prefixTurnIds: session.turns.slice(0, index + 1).map(item => item.id), originalDecision: structuredClone(turn.metadata.coreDecision ?? null),
        originalAcknowledgement: turn.acknowledgement ?? null, endingObservation: null, elapsedMs: timing!.payload!.elapsedMs!,
        elapsedObservation: { journalPath, eventId: timing!.eventId, type: 'answer.metrics', timestamp: timing!.timestamp }, expected: expectedFor(`R${pin.round}-Q${index + 1}`) });
    }
  }
  if (manifest.cases.length !== 25) throw new Error('ACTUAL_USER_EXPECTED_25_CASES');
  return manifest;
}

/** This reconstructs only the state visible through the submitted answer. It
 * never invents a stop key, VAD edge, audio input, or future answer. */
export function actualUserCoreCheckpoint(context: InterviewContext, original: InterviewSession, row: FrozenCase): InterviewSession {
  if (original.turns[row.turnIndex]?.id !== row.turnId || hash(JSON.stringify(original.turns.slice(0, row.turnIndex + 1))) !== row.prefixSha256) throw new Error('ACTUAL_USER_PREFIX_CHANGED');
  const sourceTurn = original.turns[row.turnIndex];
  if (sourceTurn.questionText !== row.question || sourceTurn.rawTranscript !== row.rawTranscript || sourceTurn.answerId !== row.answerId ||
    hash(row.question) !== row.questionSha256 || hash(row.rawTranscript) !== row.rawTranscriptSha256 || row.endingObservation !== null) throw new Error('ACTUAL_USER_FROZEN_QUESTION_ANSWER_CHANGED');
  const checkpoint = structuredClone(original);
  const digest = hash(`actual-user-core-checkpoint-v1:${original.id}:${row.turnId}`);
  checkpoint.id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-${((parseInt(digest[16], 16) & 3) | 8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  checkpoint.turns = checkpoint.turns.slice(0, row.turnIndex + 1);
  checkpoint.status = 'active'; checkpoint.evaluationStatus = 'pending'; checkpoint.elapsedMs = row.elapsedMs;
  delete checkpoint.evaluation; delete checkpoint.evaluationError; delete checkpoint.providerUsageLedger; delete checkpoint.conversationLedger;
  checkpoint.runtime = createSessionRuntime(context, { id: `actual-user-core-replay-${checkpoint.id}`, mode: 'local-development' });
  const turnIds = new Set(checkpoint.turns.map(turn => turn.id));
  checkpoint.questionPresentations = checkpoint.questionPresentations?.filter(item => turnIds.has(item.turnId));
  checkpoint.questionPresentationEventIds = [];
  checkpoint.followUpCountByMainQuestion = {};
  for (const turn of checkpoint.turns) if (turn.questionKind === 'follow_up') checkpoint.followUpCountByMainQuestion[turn.parentMainQuestionId] = (checkpoint.followUpCountByMainQuestion[turn.parentMainQuestionId] ?? 0) + 1;
  const current = checkpoint.turns.at(-1)!;
  delete current.metadata.coreDecision; delete current.metadata.answerReaction; delete current.metadata.answerContext;
  delete current.metadata.answerEndingObservation; delete current.metadata.answerCandidateId; delete current.metadata.answerCommitStatus;
  if (checkpoint.plan?.selectionContext) delete checkpoint.plan.selectionContext.lastSelection;
  checkpoint.metrics = { verification: { actualUserHistoricalPrefix: true, originalTranscriptUnchanged: true,
    historicalEndingObservation: null, voiceFreeCoreOnly: true, continuousE2E: false } };
  return checkpoint;
}

/** Explicit diagnostic rebind: an updated analysis is allowed only over the
 * very same student PDF and surviving exact historical evidence quotations.
 * This is never described as an identical-prompt A/B comparison. */
export function rebindActualUserCheckpoint(context: InterviewContext, original: InterviewSession, checkpoint: InterviewSession) {
  const historical = original.sourceManifest as InterviewContext['manifest'];
  const oldPdf = historical.files.find(file => file.role === 'studentPdf'), newPdf = context.manifest.files.find(file => file.role === 'studentPdf');
  if (!oldPdf?.sha256 || oldPdf.sha256 !== newPdf?.sha256) throw new Error('ACTUAL_USER_STUDENT_PDF_CHANGED');
  if (JSON.stringify(original.target) !== JSON.stringify(context.target)) throw new Error('ACTUAL_USER_TARGET_CHANGED');
  const verifiedQuoteRefs = [];
  for (const turn of checkpoint.turns) for (const quote of turn.metadata.evidenceQuotes) {
    const source = context.student.evidence.find(item => item.id === quote.evidenceId);
    const span = source ? findVerifiedSourceQuote(source.text.slice(0, 2200), quote.quote) : null;
    if (!source || source.sourceRef.pdfSha256 !== oldPdf.sha256 || !span) throw new Error('ACTUAL_USER_HISTORICAL_EVIDENCE_NOT_VERIFIED_IN_CURRENT_CONTEXT');
    verifiedQuoteRefs.push({ turnId: turn.id, evidenceId: source.id, quoteSha256: hash(quote.quote), currentEvidenceTextSha256: hash(source.text),
      currentSourceRef: source.sourceRef, verifiedStart: span.sourceStartOffset, verifiedEnd: span.sourceEndOffset });
  }
  const trace = { mode: 'explicit-verified-same-pdf-context-rebind', historicalSessionSnapshotSha256: hash(JSON.stringify(original)),
    historicalSourceManifestSha256: hash(JSON.stringify(historical)), currentSourceManifestSha256: hash(JSON.stringify(context.manifest)),
    historicalSourceFiles: historical.files, currentSourceFiles: context.manifest.files,
    historicalRecordIds: historical.recordIds, currentRecordIds: context.manifest.recordIds,
    stableStudentPdfSha256: oldPdf.sha256, historicalPdfPath: oldPdf.path, currentPdfPath: newPdf!.path,
    historicalRulesVersion: historical.rulesVersion, currentRulesVersion: context.manifest.rulesVersion,
    historicalAnalysisAvailability: 'Historical manifests are pinned. Any available original analysis excerpt used by the separate diagnostic projection is read from its exact hashed file; missing old analysis bodies and old model prompts are never reconstructed.',
    comparisonLimit: 'Same actual questions, raw answers and chronological prefixes under the current analysis/policy. Source-context revisions may differ, so this is not an otherwise-identical-prompt A/B experiment.',
    verifiedQuoteRefs };
  checkpoint.sourceManifest = structuredClone(context.manifest);
  for (const turn of checkpoint.turns) turn.metadata.rulesVersion = context.manifest.rulesVersion;
  return trace;
}

/** Historical delivered questions can reference an excerpt the new analysis
 * intentionally does not project under that old ID. For this diagnostic only,
 * preserve that original ID from the actual pinned prepared source after exact
 * PDF-page offset verification. No new objective, bank or semantic ID mapping
 * is created and no production context is saved. */
export async function projectHistoricalQuestionEvidence(context: InterviewContext, manifest: ActualUserCoreManifest) {
  const needed = new Set<string>();
  for (const source of manifest.sources) {
    const session = JSON.parse(await readFile(source.path, 'utf8')) as InterviewSession;
    for (const turn of session.turns) for (const quote of turn.metadata.evidenceQuotes) needed.add(quote.evidenceId);
  }
  const missing = [...needed].filter(id => !context.student.evidence.some(source => source.id === id));
  const currentManifestSha256 = hash(JSON.stringify(context.manifest));
  if (!missing.length) return { context, trace: { mode: 'no_additional_historical_evidence', currentManifestSha256, addedEvidence: [] } };
  const preparedPin = context.manifest.files.find(file => file.role === 'preparedStudent'), pdfPin = context.manifest.files.find(file => file.role === 'studentPdf');
  if (!preparedPin?.sha256 || !pdfPin?.sha256) throw new Error('ACTUAL_USER_HISTORICAL_PREPARED_SOURCE_MISSING');
  if (manifest.sources.some(source => !source.historicalSourceFiles.some(file => file.role === 'preparedStudent' && file.sha256 === preparedPin.sha256))) throw new Error('ACTUAL_USER_HISTORICAL_PREPARED_SOURCE_CHANGED');
  const preparedBytes = await readFile(preparedPin.path), pdfBytes = await readFile(pdfPin.path);
  if (hash(preparedBytes) !== preparedPin.sha256 || hash(pdfBytes) !== pdfPin.sha256) throw new Error('ACTUAL_USER_DIAGNOSTIC_SOURCE_CHANGED');
  const prepared = JSON.parse(preparedBytes.toString('utf8')) as InterviewContext['student'];
  const historicalEvidence = [...prepared.evidence];
  const historicalAnalysisFiles = [];
  const analysisPins = new Map(manifest.sources.flatMap(source => source.historicalSourceFiles.filter(file => file.role === 'fullStudentAnalysis')).map(pin => [pin.path, pin]));
  for (const pin of analysisPins.values()) {
    const bytes = await readFile(pin.path).catch(() => null);
    if (!bytes) continue;
    if (!pin.sha256 || hash(bytes) !== pin.sha256) throw new Error('ACTUAL_USER_HISTORICAL_ANALYSIS_FILE_CHANGED');
    const envelope = JSON.parse(bytes.toString('utf8')) as { evidence: InterviewContext['student']['evidence'] };
    historicalEvidence.push(...envelope.evidence);
    historicalAnalysisFiles.push({ path: pin.path, sha256: pin.sha256, available: true });
  }
  const supplement = missing.map(id => historicalEvidence.find(source => source.id === id));
  if (!prepared.pageCount || supplement.some(source => !source || source.sourceRef.pdfSha256 !== pdfPin.sha256)) throw new Error('ACTUAL_USER_LEGACY_EXCERPT_UNAVAILABLE');
  const verified = supplement.filter((source): source is NonNullable<typeof source> => Boolean(source));
  if (!await verifyStudentSourceText(pdfBytes, verified, prepared.pageCount)) throw new Error('ACTUAL_USER_LEGACY_PDF_COORDINATES_INVALID');
  const overlay = structuredClone(context);
  overlay.student.evidence.push(...structuredClone(verified));
  overlay.manifest.evidenceIds = overlay.student.evidence.map(source => source.id);
  overlay.manifest.sourceIntegrity.evidenceCount = overlay.student.evidence.length;
  overlay.manifest.selectionNotes.push('Diagnostic-only historical-question excerpts reverified at exact immutable PDF coordinates; no new-bank activation, objective or semantic ID merge.');
  return { context: overlay, trace: { mode: 'diagnostic_only_exact_pdf_legacy_question_excerpts', currentManifestSha256,
    diagnosticManifestSha256: hash(JSON.stringify(overlay.manifest)), preparedSourceSha256: preparedPin.sha256, studentPdfSha256: pdfPin.sha256,
    historicalAnalysisFiles,
    addedEvidence: verified.map(source => ({ id: source.id, activityId: source.activityId, textSha256: hash(source.text), sourceRef: source.sourceRef })),
    productionContextSaved: false, newBankFactsPromoted: false } };
}
export function checkActualUserOutcome(decision: SingleCoreDecision | undefined, expected: ExpectedOutcome) {
  const failures: string[] = [];
  if (!decision) return { structuralLabelsPassed: false, failures: ['CORE_DECISION_MISSING'], manualReview: expected.manualReview };
  if (!expected.actions.includes(decision.next.action)) failures.push('ACTION_OUTSIDE_MANUAL_LABEL');
  if (expected.coverage === null || expected.response === null) {
    if (decision.assessment !== null || decision.reaction !== null || decision.next.question !== null) failures.push('UNFINISHED_ANSWER_WAS_EVALUATED');
  } else if (!decision.assessment || !expected.coverage.includes(decision.assessment.coverage) || !expected.response.includes(decision.assessment.response)) failures.push('ASSESSMENT_OUTSIDE_MANUAL_LABEL');
  return { structuralLabelsPassed: failures.length === 0, failures, manualReviewRequired: true, manualReview: expected.manualReview };
}
async function writeNewJson(file: string, value: unknown) {
  if (!/^artifacts\/[A-Za-z0-9-]+\.json$/u.test(file)) throw new Error('ACTUAL_USER_OUTPUT_PATH_INVALID');
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); } finally { await handle.close(); }
}
async function assertFrozenSources(manifest: ActualUserCoreManifest) {
  if (manifest.version !== 'actual-user-core-input-v1' || manifest.cases.length !== 25 || manifest.sources.length !== 3 || hash(await readFile(manifest.archive.path)) !== manifest.archive.sha256) throw new Error('ACTUAL_USER_MANIFEST_INVALID');
  for (const source of manifest.sources) {
    const pin = actualUserSourcePins.find(item => item.path === source.path);
    if (!pin || pin.sha256 !== source.sha256 || hash(await readFile(source.path)) !== pin.sha256 || hash(await readFile(source.journalPath)) !== source.journalSha256) throw new Error('ACTUAL_USER_FROZEN_SOURCE_CHANGED');
  }
}
async function main() {
  const semanticReleaseIdentity = await loadOfflineSemanticBinding(process.argv.slice(2));
  const live = process.argv.includes('--run-live'), ready = process.argv.includes('--verify-ready');
  const manifestPath = process.argv.find(arg => arg.startsWith('--manifest='))?.slice(11) ?? ACTUAL_USER_MANIFEST_PATH;
  if (!live && !ready) {
    const manifest = await buildActualUserCoreManifest(); await writeNewJson(manifestPath, manifest);
    console.log(JSON.stringify({ manifestPath, actualSessions: manifest.sources.length, actualAnswers: manifest.cases.length, providerCalls: 0, sourceRecordsModified: false })); return;
  }
  const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes.toString('utf8')) as ActualUserCoreManifest;
  await assertFrozenSources(manifest);
  const only = new Set((process.argv.find(arg => arg.startsWith('--only='))?.slice(7) ?? '').split(',').filter(Boolean));
  if ([...only].some(id => !manifest.cases.some(row => row.id === id))) throw new Error('ACTUAL_USER_CASE_UNKNOWN');
  const repeats = Number(process.argv.find(arg => arg.startsWith('--critical-repeats='))?.slice(19) ?? 1);
  const maxCalls = Number(process.argv.find(arg => arg.startsWith('--max-core-calls='))?.slice(17) ?? 25);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 3 || repeats > 1 && (!only.size || [...only].some(id => !actualUserCriticalLabels[id]))) throw new Error('ACTUAL_USER_REPEATS_REQUIRE_EXPLICIT_CRITICAL_CASES');
  const selected = manifest.cases.filter(row => !only.size || only.has(row.id));
  const coreReasoningEffort = z.enum(['none', 'low', 'medium']).parse(process.argv.find(arg => arg.startsWith('--core-effort='))?.slice('--core-effort='.length) ?? interviewConfig.coreReasoningEffort);
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 25 || selected.length * repeats > maxCalls) throw new Error('ACTUAL_USER_25_CORE_CALL_BOUND_EXCEEDED');
  if (repeats > 1 && selected.length * repeats > 6) throw new Error('ACTUAL_USER_CRITICAL_REPEAT_6_CALL_BOUND_EXCEEDED');
  dotenv.config({ path: '.env.local', quiet: true });
  const analysisRevisionPath = process.argv.find(arg => arg.startsWith('--analysis-revision='))?.slice('--analysis-revision='.length);
  const activePointerBefore = await readFile(FULL_ANALYSIS_CURRENT).then(hash, () => null);
  const baseContext = analysisRevisionPath
    ? (await (await import('../server/data/staged-interview-context')).loadStagedInterviewContextAt(process.cwd(), analysisRevisionPath)).context
    : await (await import('../server/data/load-interview-context')).loadInterviewContext();
  if (baseContext.errors.length) throw new Error('ACTUAL_USER_CURRENT_CONTEXT_INVALID');
  const { context, trace: historicalEvidenceProjection } = await projectHistoricalQuestionEvidence(baseContext, manifest);
  const prepared = [];
  // Validate every historical checkpoint BEFORE any paid request. An explicit
  // same-PDF/exact-quote rebind is recorded separately from the original pins.
  for (const row of selected) {
    const original = JSON.parse(await readFile(row.sourcePath, 'utf8')) as InterviewSession;
    const checkpoint = actualUserCoreCheckpoint(context, original, row), current = checkpoint.turns.at(-1)!;
    const contextRebind = rebindActualUserCheckpoint(context, original, checkpoint);
    assertRealtimeCoreSource(context, checkpoint);
    if (!current.metadata.approvedQuestion) throw new Error('ACTUAL_USER_APPROVED_QUESTION_MISSING');
    assertQuestionContractIntegrity({ ...current.metadata, acknowledgement: null, questionText: current.questionText, questionKind: current.questionKind,
      parentMainQuestionId: current.questionKind === 'main' ? null : current.parentMainQuestionId, evidenceIds: current.evidenceIds }, current.metadata.approvedQuestion);
    prepared.push({ row, checkpoint, contextRebind });
  }
  if (!live) {
    if (activePointerBefore !== await readFile(FULL_ANALYSIS_CURRENT).then(hash, () => null)) throw new Error('ACTUAL_USER_ANALYSIS_POINTER_CHANGED');
    console.log(JSON.stringify({ ready: true, cases: prepared.length, providerCalls: 0, historicalEndingObservation: null, analysisRevisionPath: analysisRevisionPath ?? null,
      diagnosticHistoricalEvidenceCount: historicalEvidenceProjection.addedEvidence.length, activePointerUnchanged: true })); return;
  }
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  const output = process.argv.find(arg => arg.startsWith('--out='))?.slice(6) ?? `artifacts/actual-user-core-v6-${stamp}.json`;
  const cases: Array<Record<string, unknown>> = [];
  const report = { version: 'actual-user-core-replay-v1', semanticReleaseIdentity, startedAt: new Date().toISOString(), completedAt: null as string | null,
    manifest: { path: manifestPath, sha256: hash(manifestBytes) }, engineVersion: SINGLE_CORE_ENGINE_VERSION, contractVersion: SINGLE_CORE_CONTRACT_VERSION,
    semanticPromptSha256: hash(SINGLE_CORE_DIALOGUE_RULES), engineSourceSha256: await replayEngineSourceFingerprints(),
    coreReasoningEffort, coreOutputTokenBudget: coreReasoningEffort === 'medium' ? 4000 : coreReasoningEffort === 'low' ? 2000 : 600,
    engineSourceUnchanged: null as boolean | null,
    analysisRevisionPath: analysisRevisionPath ?? null, activePointerSha256Before: activePointerBefore, activePointerUnchanged: null as boolean | null,
    historicalEvidenceProjection,
    scope: manifest.scope, historicalEndingObservation: null, sourceRecordsModified: false, maxCoreCalls: maxCalls,
    selectedCases: selected.map(row => row.id), criticalRepeats: repeats, providerRequests: 0, proposedReactionCount: 0, acceptedReactionCount: 0, cases };
  // Claim the output before spending anything. A checkpoint is independent; no
  // generated question is substituted for an actually heard historical one.
  await writeNewJson(output, report);
  const reportFile = await open(output, 'r+');
  const save = async () => { await reportFile.truncate(0); await reportFile.write(JSON.stringify(report, null, 2), 0, 'utf8'); await reportFile.sync(); };
  try {
    for (let repeat = 1; repeat <= repeats; repeat++) for (const { row, checkpoint, contextRebind } of prepared) {
      await assertFrozenSources(manifest);
      if (report.providerRequests >= maxCalls) throw new Error('ACTUAL_USER_CORE_CALL_BUDGET_EXHAUSTED');
      const observedUsage: Array<{ stage: string; observation: ProviderUsageObservation }> = [];
      const startedAt = new Date().toISOString();
      const started = performance.now(), duration = checkpoint.durationSeconds ?? context.interviewOverview!.durationSeconds;
      const result = await runSingleCoreRuntime(context, structuredClone(checkpoint), { candidateOnly: true, policyMode: 'compiled', coreReasoningEffort,
        allowFollowUp: mayAskFollowUp(checkpoint, duration, 2), allowClarification: mayAskClarification(checkpoint, duration), allowReplay: mayReplayQuestion(checkpoint, duration),
        onProviderUsage: (stage, observation) => { observedUsage.push({ stage, observation }); report.providerRequests++; } });
      if ((result.providerTimings.coreModelCalls ?? 0) !== 1 || result.providerTimings.premiseReviewAttempts || result.providerTimings.repairModelCalls || observedUsage.some(item => item.stage !== 'core')) throw new Error('ACTUAL_USER_SINGLE_CORE_CALL_CONTRACT_FAILED');
      const proposedReaction = result.semanticDecision?.reaction;
      const acceptedAcknowledgement = proposedReaction ? verifyAcknowledgement(row.rawTranscript, proposedReaction.quote, proposedReaction.text,
        checkpoint.turns.flatMap(turn => turn.acknowledgement ? [turn.acknowledgement] : []), { semanticGrounding: 'single_core' }) : null;
      if (proposedReaction) report.proposedReactionCount++;
      if (acceptedAcknowledgement) report.acceptedReactionCount++;
      cases.push({ id: row.id, repeat, question: row.question, rawTranscript: row.rawTranscript, sourceQuestionSha256: row.questionSha256,
        sourceAnswerSha256: row.rawTranscriptSha256, sourceSessionPath: row.sourcePath, sourceSessionSha256: row.sourceSha256,
        historicalPrefixSha256: row.prefixSha256, endingObservation: null,
        oldDecision: row.originalDecision, newDecision: result.semanticDecision ?? null, execution: result.execution, contextRebind, acceptedAcknowledgement,
        labelCheck: checkActualUserOutcome(result.semanticDecision, row.expected), expected: row.expected,
        startedAt, completedAt: new Date().toISOString(), wallMs: performance.now() - started,
        providerTimings: result.providerTimings, providerUsage: observedUsage, policyTrace: result.policyTrace,
        failure: result.failureDetail ?? null });
      await save();
      console.log(JSON.stringify({ id: row.id, repeat, action: result.semanticDecision?.next.action, coverage: result.semanticDecision?.assessment?.coverage ?? null,
        wallMs: Math.round(performance.now() - started), providerCalls: observedUsage.length, failure: result.failureDetail ?? null }));
    }
    await assertFrozenSources(manifest);
    report.engineSourceUnchanged = JSON.stringify(report.engineSourceSha256) === JSON.stringify(await replayEngineSourceFingerprints());
    report.activePointerUnchanged = activePointerBefore === await readFile(FULL_ANALYSIS_CURRENT).then(hash, () => null);
    report.completedAt = new Date().toISOString(); await save();
  } finally { await reportFile.close(); }
  console.log(JSON.stringify({ output, cases: cases.length, providerRequests: report.providerRequests,
    proposedReactionCount: report.proposedReactionCount, acceptedReactionCount: report.acceptedReactionCount, sourceRecordsModified: false }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
