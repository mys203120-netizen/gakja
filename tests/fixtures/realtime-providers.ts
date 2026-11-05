/** Provider substitutes used only by the isolated realtime recovery test bundle. */
import http from "node:http";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { InterviewContext } from "../../server/data/load-interview-context";
import type { InterviewSession, QuestionDraft } from "../../server/protocol";
import type { AnswerReaction } from "../../server/providers/answer-reaction";
import { aggregateSessionEvaluation } from "../../server/providers/evaluation-aggregation";
import { createInterviewPlan } from '../../server/interview-planner';
import type { PreparedQuestionBank } from '../../server/data/prepared-question-bank';
import type { RealtimeCoreResult } from '../../server/providers/realtime-core';
import { normalizeProviderUsage, type ProviderUsageObservation } from '../../server/observability/provider-cost';

const configuration = { failNextQuestionTts: false, failNextAcknowledgementTts: false, holdNextCore: false, holdNextQuestionTts: false, followUpNextCore: false, providerUnavailableNextCore: false, emitUsageNextCore: false, questionReviewUnavailableNextCore: false, blockSecondTurnSave: false, failNextAnswerSave: false, failNextEvaluationSave: false, holdNextEvaluationSave: false, silentNextStream: false, failNextStream: false, failNextStreamAtConstruction: false, failNextStreamAtFinish: false, lateTranscriptAfterFailure: false, lateCallbacksOnClose: false, exhaustMainPool: false, commonMainNext: false };
const stats = { generationCalls: 0, coreCalls: 0, coreInvocations: 0, bankLoads: 0, bankHits: 0, offlinePreparedCandidates: 0, evaluationCalls: 0, questionTtsAttempts: 0, questionTtsProviderCalls: 0, questionTtsFailures: 0, acknowledgementTtsAttempts: 0, acknowledgementTtsProviderCalls: 0, acknowledgementTtsFailures: 0, openingTtsAttempts: 0, closingTtsAttempts: 0, pcmBytes: 0, coreBlocked: false, questionTtsBlocked: false, saveBlocked: false, answerSaveFailures: 0, evaluationSaveFailures: 0, evaluationSaveBlocked: false, sttCloses: 0 };
const audio = new Map<string, Buffer>();
function stableFixtureValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableFixtureValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableFixtureValue(item)]));
  return value;
}
const preparedAudio = new Map<string, Buffer>(), pendingAudio = new Map<string, Promise<void>>();
let syntheticBank: PreparedQuestionBank | null = null;
let releaseCore: (() => void) | undefined, releaseQuestionTts: (() => void) | undefined, releaseSave: (() => void) | undefined, blockedSaveUsed = false;

// The real LocalSessionStore executes unchanged. Only this owned child's rename boundary is fault-injected.
const nativeFs = createRequire(path.join(process.cwd(), "recovery-fixture.cjs"))("node:fs/promises") as typeof import("node:fs/promises");
const rename = nativeFs.rename.bind(nativeFs);
Object.defineProperty(nativeFs, "rename", { configurable: true, writable: true, value: async (from: string, to: string) => {
  // The new worker commits versioned results separately from the immutable
  // session. Inject the same storage fault at that actual atomic boundary.
  if (to.endsWith('.result.json')) {
    if (configuration.holdNextEvaluationSave) {
      configuration.holdNextEvaluationSave = false; stats.evaluationSaveBlocked = true;
      await new Promise<void>(resolve => { releaseSave = resolve; }); stats.evaluationSaveBlocked = false;
    }
    if (configuration.failNextEvaluationSave) {
      configuration.failNextEvaluationSave = false; stats.evaluationSaveFailures++;
      throw Object.assign(new Error('SYNTHETIC_EVALUATION_SAVE_FAILURE'), { code: 'EIO' });
    }
  }
  if (from.endsWith(".json.tmp") && (configuration.failNextAnswerSave || configuration.failNextEvaluationSave || configuration.holdNextEvaluationSave)) {
    const snapshot = JSON.parse(await nativeFs.readFile(from, "utf8")) as { turns?: Array<{ metrics?: unknown }>; status?: string; evaluationStatus?: string };
    if (configuration.failNextAnswerSave && snapshot.status === "active" && snapshot.turns?.length === 1 && snapshot.turns[0].metrics) {
      configuration.failNextAnswerSave = false; stats.answerSaveFailures++;
      throw Object.assign(new Error("SYNTHETIC_ANSWER_SAVE_FAILURE"), { code: "EIO" });
    }
    if (snapshot.evaluationStatus === "completed") {
      if (configuration.holdNextEvaluationSave) {
        configuration.holdNextEvaluationSave = false; stats.evaluationSaveBlocked = true;
        await new Promise<void>(resolve => { releaseSave = resolve; }); stats.evaluationSaveBlocked = false;
      }
      if (configuration.failNextEvaluationSave) {
        configuration.failNextEvaluationSave = false; stats.evaluationSaveFailures++;
        throw Object.assign(new Error("SYNTHETIC_EVALUATION_SAVE_FAILURE"), { code: "EIO" });
      }
    }
  }
  if (configuration.blockSecondTurnSave && !blockedSaveUsed && from.endsWith(".json.tmp")) {
    const snapshot = JSON.parse(await nativeFs.readFile(from, "utf8")) as { turns?: unknown[]; status?: string };
    if (snapshot.turns?.length === 2 && snapshot.status === "active") {
      blockedSaveUsed = true; stats.saveBlocked = true;
      await new Promise<void>(resolve => { releaseSave = resolve; });
      stats.saveBlocked = false;
    }
  }
  return rename(from, to);
} });
syncBuiltinESMExports();

const control = http.createServer(async (request, response) => {
  if (request.headers["x-recovery-test-token"] !== process.env.RECOVERY_TEST_TOKEN) { response.writeHead(403); response.end(); return; }
  response.setHeader("Content-Type", "application/json");
  if (request.method === "GET" && request.url === "/state") { response.end(JSON.stringify(stats)); return; }
  let body = ""; for await (const chunk of request) body += chunk.toString();
  if (request.url === "/reset") {
    releaseCore?.(); releaseQuestionTts?.(); releaseSave?.(); releaseCore = undefined; releaseQuestionTts = undefined; releaseSave = undefined;
    Object.assign(configuration, { failNextQuestionTts: false, failNextAcknowledgementTts: false, holdNextCore: false, holdNextQuestionTts: false, followUpNextCore: false, providerUnavailableNextCore: false, emitUsageNextCore: false, questionReviewUnavailableNextCore: false, blockSecondTurnSave: false, failNextAnswerSave: false, failNextEvaluationSave: false, holdNextEvaluationSave: false, silentNextStream: false, failNextStream: false, failNextStreamAtConstruction: false, failNextStreamAtFinish: false, lateTranscriptAfterFailure: false, lateCallbacksOnClose: false, exhaustMainPool: false, commonMainNext: false });
    for (const key of Object.keys(stats) as Array<keyof typeof stats>) Object.assign(stats, { [key]: typeof stats[key] === "boolean" ? false : 0 });
    audio.clear(); pendingAudio.clear(); stats.offlinePreparedCandidates = preparedAudio.size; blockedSaveUsed = false;
  } else if (request.url === "/configure") {
    const input = JSON.parse(body || "{}") as Record<string, unknown>;
    for (const key of Object.keys(configuration) as Array<keyof typeof configuration>) if (typeof input[key] === "boolean") configuration[key] = input[key];
  } else if (request.url === "/release-core") { releaseCore?.(); releaseCore = undefined; }
  else if (request.url === '/release-question-tts') { releaseQuestionTts?.(); releaseQuestionTts = undefined; }
  else if (request.url === "/release-save") { releaseSave?.(); releaseSave = undefined; }
  else { response.writeHead(404); response.end("{}"); return; }
  response.end(JSON.stringify({ ok: true }));
});
control.listen(Number(process.env.RECOVERY_TEST_CONTROL_PORT), "127.0.0.1");
process.once("SIGTERM", () => { releaseCore?.(); releaseQuestionTts?.(); releaseSave?.(); control.close(); });

export const interviewerVoiceDefaults = { primary: "test-academic", secondary: "test-community" };
export const SINGLE_CORE_ENGINE_VERSION = 'semantic-single-core-v7';
/** Legacy recovery scenarios never enter the new staged candidate route. */
export async function classifySingleCoreAnswerCandidate(): Promise<never> { throw new Error('SYNTHETIC_STAGED_CLASSIFIER_NOT_CONFIGURED'); }
export function assertSingleCoreCandidateBinding(): never { throw new Error('SYNTHETIC_STAGED_BINDING_NOT_CONFIGURED'); }
export async function reactToAnswer(_context: InterviewContext, session: InterviewSession, allowFollowUp: boolean, options: { allowClarification?: boolean } = {}): Promise<AnswerReaction> {
  const turn = session.turns.at(-1)!;
  if (!turn.rawTranscript?.trim()) {
    const clarify = options.allowClarification ?? allowFollowUp;
    return { classification: "non_answer", action: clarify ? "clarify" : "transition", keywordQuote: null, reply: clarify ? "네, 같은 질문을 다시 확인할게요." : "네, 이 주제는 여기까지 확인할게요.", reasonCode: clarify ? "NO_ANSWER" : "RECONFIRMATION_ALREADY_USED", evidenceSpan: null, missingTarget: turn.metadata.targetEvidence[0] ?? null, directive: clarify ? "clarification_same_target" : "next_main", sourceTurnId: turn.id, sourceAnswerId: turn.answerId ?? null, parentMainQuestionId: turn.parentMainQuestionId, origin: "deterministic", durationMs: 0 };
  }
  return { classification: "relevant", action: "proceed", keywordQuote: "합성 테스트 응답", reply: "네, 합성 테스트 응답을 확인했습니다.", reasonCode: "ANSWER_RELATED", evidenceSpan: { start: 0, end: 9 }, missingTarget: null, directive: "next_main", sourceTurnId: turn.id, sourceAnswerId: turn.answerId ?? null, parentMainQuestionId: turn.parentMainQuestionId, origin: "model", durationMs: 0 };
}
function syntheticQuestion(context: InterviewContext, session: InterviewSession, reaction?: AnswerReaction): QuestionDraft {
  const previous = session.turns.at(-1);
  const clarification = reaction?.directive === "clarification_same_target";
  const mainIndex = clarification ? previous!.mainIndex : (previous?.mainIndex ?? 0) + 1, slot = session.plan!.slots[mainIndex - 1];
  const evidenceId = slot?.evidenceIds[0] ?? context.student.evidence[0].id;
  return { acknowledgement: previous ? "네, 합성 테스트 응답을 확인했습니다." : null, acknowledgementQuote: previous ? "합성 테스트 응답" : null, questionText: clarification ? "합성 테스트에서 실제로 확인한 방법 한 가지만 설명해 주세요." : `합성 테스트 질문 ${mainIndex}에서 확인한 방법 한 가지를 설명해 주세요.`, questionKind: clarification ? "clarification" : "main", parentMainQuestionId: clarification ? previous!.parentMainQuestionId : null, evidenceIds: [evidenceId], evidenceQuotes: [{ evidenceId, quote: "명시적인 합성 테스트 인용이며 실제 학생부 내용이 아닙니다." }], primaryFunction: clarification ? previous!.metadata.primaryFunction : slot.primaryFunction, questionIntent: clarification ? previous!.metadata.questionIntent : slot.questionIntent, targetEvidence: clarification ? [...previous!.metadata.targetEvidence] : ["합성 응답의 단일 확인 목적"], depth: clarification ? previous!.metadata.depth : slot.depth, groundingRationale: "장애 복구용 공급자 대역이며 실제 학생 경험을 생성하거나 검증하지 않습니다.", validationStatus: "approved", validationFailures: [] };
}
/** Explicit offline fixture preparation, separate from runtime TTS and core counters. */
export async function loadQuestionBank(context: InterviewContext) {
  stats.bankLoads++;
  if (syntheticBank) return syntheticBank;
  const plan = createInterviewPlan(context, 'synthetic-offline-question-bank');
  const slots = plan.slots.map(slot => {
    const session = { plan: { ...plan, slots: [slot] }, turns: [] } as unknown as InterviewSession;
    const draft = syntheticQuestion(context, session); draft.questionText = `합성 사전 준비 질문 ${slot.index}에서 확인한 방법 한 가지를 설명해 주세요.`;
    const speaker = slot.interviewerId === 'interviewer-1' ? interviewerVoiceDefaults.primary : interviewerVoiceDefaults.secondary;
    const settings = { speaker, speed: 0, pitch: 1, volume: 0, format: 'mp3' as const };
    const candidates = ([0, 1] as const).map(variant => {
      const text = variant ? draft.questionText.replace('한 가지를', '하나를') : draft.questionText;
      const speechHash = createHash('sha256').update(`${speaker}:${text}`).digest('hex');
      const bytes = Buffer.from(`ID3-explicit-offline-synthetic-audio:${slot.index}:${variant}`); preparedAudio.set(speechHash, bytes); stats.offlinePreparedCandidates++;
      const candidateDraft = { ...structuredClone(draft), questionText: text, acknowledgement: null, acknowledgementQuote: null };
      return { id: `synthetic-candidate-${slot.index}-${variant}`, slotId: slot.id, mainIndex: slot.index, variant, createdAt: '2026-11-02T00:00:00.000Z', draft: candidateDraft, questionSha256: createHash('sha256').update(text).digest('hex'), questionAudioUrl: `/api/audio/${speechHash}`, speechHash, audioSha256: createHash('sha256').update(bytes).digest('hex'), voiceSettings: settings };
    });
    return { slotId: slot.id, mainIndex: slot.index, candidates };
  });
  const content = { schemaVersion: 'prepared-q0-objective-pool-v2' as const, status: 'ready' as const, key: createHash('sha256').update('explicit-synthetic-bank').digest('hex'), createdAt: '2026-11-02T00:00:00.000Z', completedAt: '2026-11-02T00:00:00.000Z', plan, target: context.target, rulesVersion: context.manifest.rulesVersion, activitiesContentSha256: null, sourceFingerprint: createHash('sha256').update('explicit-synthetic-sources').digest('hex'), questionModel: 'synthetic-provider', voices: { primary: { speaker: interviewerVoiceDefaults.primary, speed: 0, pitch: 1, volume: 0, format: 'mp3' as const }, secondary: { speaker: interviewerVoiceDefaults.secondary, speed: 0, pitch: 1, volume: 0, format: 'mp3' as const } }, slots };
  syntheticBank = { ...content, contentSha256: createHash('sha256').update(JSON.stringify(stableFixtureValue(content))).digest('hex') };
  return syntheticBank;
}
export function selectPreparedMainQuestion(bank: PreparedQuestionBank, session: InterviewSession, mainIndex: number) {
  const row = bank.slots[mainIndex - 1], candidate = row?.candidates[0];
  if (!candidate || JSON.stringify(session.plan) !== JSON.stringify(bank.plan) || !preparedAudio.has(candidate.speechHash)) return null;
  stats.bankHits++;
  return { draft: structuredClone(candidate.draft), audioUrl: candidate.questionAudioUrl, voiceSettings: candidate.voiceSettings, bankKey: bank.key, candidateId: candidate.id };
}
function contextSupportTarget(session: InterviewSession) { return String((session.target as { track?: string } | undefined)?.track ?? 'synthetic-track'); }
export function createSessionQuestionPlan(_context: InterviewContext, bank: PreparedQuestionBank) { return structuredClone(bank.plan); }
export async function loadQuestionBankByPinnedPlan(context: InterviewContext) { return loadQuestionBank(context); }
export function selectNextPreparedMainQuestion(bank: PreparedQuestionBank, session: InterviewSession) {
  if (configuration.exhaustMainPool) return null;
  const mainIndex = (session.turns.at(-1)?.mainIndex ?? 0) + 1;
  const selected = selectPreparedMainQuestion(bank, session, mainIndex);
  if (selected && configuration.commonMainNext) { configuration.commonMainNext = false; selected.draft.evidenceIds = []; selected.draft.evidenceQuotes = []; selected.draft.commonApproval = { kind: 'COMMON_APPROVED', moduleId: 'synthetic-support-motive', approvalRevision: 'explicit-synthetic-v1', supportTargetId: contextSupportTarget(session) }; }
  return selected ? { ...selected, slot: session.plan!.slots[mainIndex - 1], selectionTrace: null } : null;
}
export function approvedRestatement(_context: InterviewContext, session: InterviewSession, _sources: unknown, reaction?: AnswerReaction) {
  const previous = session.turns.at(-1);
  if (!previous || reaction?.directive !== 'clarification_same_target') return null;
  return { ...structuredClone(previous.metadata), acknowledgement: null, acknowledgementQuote: null, questionText: previous.questionText, questionKind: 'clarification', parentMainQuestionId: previous.parentMainQuestionId, evidenceIds: previous.evidenceIds } as QuestionDraft;
}
export async function runRealtimeCore(context: InterviewContext, session: InterviewSession, options: { allowFollowUp: boolean; allowClarification: boolean; onProviderUsage?: (stage: 'core' | 'review', observation: ProviderUsageObservation) => void }): Promise<RealtimeCoreResult> {
  stats.coreInvocations++;
  const previous = session.turns.at(-1)!;
  if (!previous.evidenceIds.length && previous.metadata.commonApproval?.kind !== 'COMMON_APPROVED') throw new Error('SYNTHETIC_COMMON_APPROVAL_NOT_PROPAGATED');
  const modelCall = Boolean(previous.rawTranscript?.trim()); if (modelCall) stats.coreCalls++;
  if(configuration.emitUsageNextCore){
    configuration.emitUsageNextCore=false;
    const observation=normalizeProviderUsage({id:'resp_synthetic_'+previous.answerId,model:'gpt-6-luna',service_tier:'default',prompt_cache_options:{ttl:'30m'},usage:{input_tokens:100,output_tokens:10,total_tokens:110,input_tokens_details:{cached_tokens:20,cache_write_tokens:30}}});
    options.onProviderUsage?.('core',observation);options.onProviderUsage?.('core',observation);
  }
  if (configuration.holdNextCore) { configuration.holdNextCore = false; stats.coreBlocked = true; await new Promise<void>(resolve => { releaseCore = resolve; }); stats.coreBlocked = false; }
  let reaction = await reactToAnswer(context, session, options.allowFollowUp, options);
  let draft: QuestionDraft | null = null;
  if (configuration.questionReviewUnavailableNextCore) {
    configuration.questionReviewUnavailableNextCore = false;
    reaction = { ...reaction, classification: 'unassessed', action: 'transition', directive: 'next_main', keywordQuote: null, evidenceSpan: null, reply: null, reasonCode: 'REACTION_VALIDATION_FAILED' };
    return { reaction, draft: null, followUpGoal: null, origin: 'fallback', failureCode: 'CORE_INVALID_OUTPUT', failureStage: 'final_question_review', failureDetail: 'PREMISE_UNSUPPORTED', questionRecoveryRequired: true, fulfillment: 'partial', nextAction: 'TRANSITION', providerTimings: { coreMs: 0, coreModelCalls: Number(modelCall), coreFallback: 1 } };
  }
  if (configuration.providerUnavailableNextCore) {
    configuration.providerUnavailableNextCore = false;
    reaction = { ...reaction, classification: 'unassessed', action: 'transition', directive: 'next_main', keywordQuote: null, evidenceSpan: null, reply: null, reasonCode: 'REACTION_VALIDATION_FAILED' };
    return { reaction, draft: null, followUpGoal: null, origin: 'fallback', failureCode: 'CORE_PROVIDER_ERROR', failureStage: 'core_provider', failureDetail: 'HTTP_429', providerUnavailable: true, fulfillment: 'unknown', nextAction: 'TRANSITION', providerTimings: { coreMs: 0, coreModelCalls: Number(modelCall), coreFallback: 1 } };
  }
  if (modelCall && options.allowFollowUp && (configuration.followUpNextCore || configuration.failNextQuestionTts || configuration.holdNextQuestionTts)) {
    configuration.followUpNextCore = false;
    reaction = { ...reaction, classification: 'partial', action: 'probe', reasonCode: 'MISSING_REQUESTED_DETAIL', directive: 'follow_up_missing_target', missingTarget: '합성 응답에서 확인할 한 가지 방법', probeBasis: 'answer_detail' };
    draft = { ...syntheticQuestion(context, session), questionText: '합성 테스트 질문 2에서 답변한 방법 한 가지만 구체적으로 설명해 주세요.', questionKind: 'follow_up', parentMainQuestionId: previous.parentMainQuestionId, primaryFunction: 'CLARIFY_CONTENT', depth: previous.metadata.depth, targetEvidence: [reaction.missingTarget!], questionIntent: '실제 합성 응답에서 언급한 한 가지 방법만 확인한다.' };
  }
  return { reaction, draft, followUpGoal: draft ? 'own_action' : null, origin: modelCall ? 'model' : 'deterministic', providerTimings: { coreMs: 0, coreModelCalls: Number(modelCall), coreFallback: 0 } };
}
export async function evaluateSession(_context: InterviewContext, session: InterviewSession) { stats.evaluationCalls++; return { answers: [], verification: "synthetic-provider-recovery-test", ...aggregateSessionEvaluation(session, []) }; }
export async function synthesizeSpeech(text: string, speaker: string, options: { onTiming?: (timing: { durationMs: number; cache: "memory" | "provider"; settings: { speaker: string; speed: number; pitch: number; volume: number; format: "mp3" } }) => void } = {}) {
  const started = performance.now(), acknowledgement = text.startsWith("네,"), opening = text === '안녕하세요. 면접을 시작하겠습니다.', closing = text === '면접은 여기까지 하겠습니다. 수고하셨습니다.';
  const settings = { speaker, speed: 0, pitch: 1, volume: 0, format: "mp3" as const };
  if (opening) stats.openingTtsAttempts++; else if (closing) stats.closingTtsAttempts++; else if (acknowledgement) stats.acknowledgementTtsAttempts++; else stats.questionTtsAttempts++;
  const id = createHash("sha256").update(`${speaker}:${text}`).digest("hex");
  if (audio.has(id)) { options.onTiming?.({ durationMs: performance.now() - started, cache: "memory", settings }); return `/api/audio/${id}`; }
  let pending = pendingAudio.get(id);
  if (!pending) {
    pending = (async () => {
      if (acknowledgement) stats.acknowledgementTtsProviderCalls++; else if (!opening && !closing) stats.questionTtsProviderCalls++;
      if (acknowledgement && configuration.failNextAcknowledgementTts) {
        configuration.failNextAcknowledgementTts = false; await sleep(5); stats.acknowledgementTtsFailures++;
        throw new Error('SYNTHETIC_ACKNOWLEDGEMENT_TTS_FAILURE');
      }
      if (!acknowledgement && !opening && !closing && configuration.holdNextQuestionTts) {
        configuration.holdNextQuestionTts = false; stats.questionTtsBlocked = true;
        await new Promise<void>(resolve => { releaseQuestionTts = resolve; }); stats.questionTtsBlocked = false;
      }
      if (!acknowledgement && text.includes("질문 2") && configuration.failNextQuestionTts) {
        configuration.failNextQuestionTts = false; await sleep(100); stats.questionTtsFailures++;
        throw new Error("SYNTHETIC_QUESTION_TTS_FAILURE");
      }
      await sleep(acknowledgement ? 1 : 5);
      audio.set(id, Buffer.from("ID3-explicit-synthetic-test-audio"));
    })();
    pendingAudio.set(id, pending);
    void pending.finally(() => { if (pendingAudio.get(id) === pending) pendingAudio.delete(id); }).catch(() => {});
  }
  await pending;
  options.onTiming?.({ durationMs: performance.now() - started, cache: "provider", settings });
  return `/api/audio/${id}`;
}
export async function readSpeechAudio(id: string) { return preparedAudio.get(id) ?? audio.get(id) ?? null; }
export class ClovaSpeechStream {
  private bytes = 0;
  private revision = 0;
  private finished?: Promise<string>;
  private readonly silent = configuration.silentNextStream;
  private readonly shouldFail = configuration.failNextStream;
  private readonly failAtConstruction = configuration.failNextStreamAtConstruction;
  private readonly failAtFinish = configuration.failNextStreamAtFinish;
  private readonly lateAfterFailure = configuration.lateTranscriptAfterFailure;
  private readonly lateOnClose = configuration.lateCallbacksOnClose;
  private failed = false;
  private closed = false;
  constructor(private readonly onTranscript: (event: { text: string; rawTranscript: string; position: number; revision: number; isFinal: boolean; confidence: null; startTimestamp: null; endTimestamp: null }) => void, private readonly onError: (error: Error) => void) {
    configuration.silentNextStream = false; configuration.failNextStream = false; configuration.failNextStreamAtConstruction = false; configuration.failNextStreamAtFinish = false; configuration.lateTranscriptAfterFailure = false; configuration.lateCallbacksOnClose = false;
    if (this.failAtConstruction) { this.failed = true; this.onError(new Error('SYNTHETIC_STT_CONSTRUCTION_FAILURE')); }
  }
  private late(text: string) { this.onTranscript({ text, rawTranscript: text, position: 0, revision: ++this.revision, isFinal: true, confidence: null, startTimestamp: null, endTimestamp: null }); }
  write(bytes: Buffer) { if (this.shouldFail || bytes.length % 2) { this.failed = true; this.onError(new Error("SYNTHETIC_STT_TRANSPORT_FAILURE")); if (this.lateAfterFailure) queueMicrotask(() => this.late('실패 후 도착한 합성 전사')); } else { if (!this.silent && !this.bytes && bytes.length) this.onTranscript({ text: "합성 테스트", rawTranscript: "합성 테스트", position: 0, revision: ++this.revision, isFinal: false, confidence: null, startTimestamp: null, endTimestamp: null }); this.bytes += bytes.length; stats.pcmBytes += bytes.length; } }
  finish() {
    return this.finished ??= (async () => { if (this.failed) throw new Error("SYNTHETIC_STT_TRANSPORT_FAILURE"); if (this.failAtFinish) { this.failed = true; this.onError(new Error('SYNTHETIC_STT_FINISH_FAILURE')); await sleep(5); this.late('오류 뒤 늦게 확정된 합성 전사'); return '오류 뒤 늦게 확정된 합성 전사'; } const text = !this.silent && this.bytes ? "합성 테스트 응답입니다." : ""; this.onTranscript({ text, rawTranscript: text, position: 0, revision: ++this.revision, isFinal: true, confidence: null, startTimestamp: null, endTimestamp: null }); return text; })();
  }
  close() { if (this.closed) return; this.closed = true; stats.sttCloses++; if (this.lateOnClose) { this.onError(new Error('SYNTHETIC_STALE_STREAM_FAILURE')); queueMicrotask(() => this.late('닫힌 이전 스트림의 합성 전사')); } }
}
