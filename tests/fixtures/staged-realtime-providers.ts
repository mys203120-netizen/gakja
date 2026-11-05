/** Explicit synthetic boundaries for HTTP/WS capture races; no external provider requests. */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import * as providers from './realtime-providers';
import type { InterviewContext } from '../../server/data/load-interview-context';
import type { InterviewSession } from '../../server/protocol';
import type { RealtimeCoreResult } from '../../server/providers/realtime-core';
import type { StrategyCoreOptions } from '../../server/providers/realtime-strategy-core';
import type { SingleCoreAnswerCandidate, SingleCoreCandidateResult } from '../../server/providers/single-core-runtime';
import { observeAnswerSubmission } from '../../server/answer-submission';
import { SINGLE_CORE_CONTRACT_VERSION } from '../../server/providers/single-core-contract';
export * from './realtime-providers';
import { SubmissionWorkRegistry as ActualSubmissionWorkRegistry } from '../../server/submission-work';
import { WorkTestClock } from './work-test-clock';
const workClock = new WorkTestClock();
export class SubmissionWorkRegistry extends ActualSubmissionWorkRegistry { constructor(timeoutMs: number) { super(timeoutMs, workClock); } }

const configuration = { holdSttFinish: false, holdClosingTts: false, nextContinue: false, holdCandidate: false, holdPreparation: false, mutateCandidateSource: false, failCandidateDecisionSave: false, holdCaptureFinalSave: false, failPlaybackBatchSave: false, holdPlaybackBatchSave: false, failPreparedCommitSave: false, cacheRepairWithoutProof: false, cacheRepairWithoutAuthority: false };
const stats = { sttFinishBlocked: false, closingTtsBlocked: false, candidateCalls: 0, candidateBlocked: false, preparationBlocked: false, candidateReuse: 0, providerFinishes: 0, candidateSaveFailures: 0, captureSaveBlocked: false, playbackBatchSaveFailures: 0, playbackBatchSaveBlocked: false, lastCandidateAllowFollowUp: false };
const prepared = new Map<string, RealtimeCoreResult>();
let releaseClosingTts: (() => void) | undefined;
let releaseSttFinish: (() => void) | undefined;
let releaseCandidate: (() => void) | undefined, releasePreparation: (() => void) | undefined, releaseCaptureSave: (() => void) | undefined, releasePlaybackBatchSave: (() => void) | undefined;
const key = (session: InterviewSession, revision: number) => `${session.id}:${session.turns.at(-1)!.id}:${session.turns.at(-1)!.answerId}:${revision}`;
const nativeFs = createRequire(path.join(process.cwd(), 'staged-fixture.cjs'))('node:fs/promises') as typeof import('node:fs/promises');
const rename = nativeFs.rename.bind(nativeFs);
Object.defineProperty(nativeFs, 'rename', { configurable: true, writable: true, value: async (from: string, to: string) => {
  if (configuration.failPreparedCommitSave && from.endsWith('.json.tmp')) {
    const snapshot = JSON.parse(await nativeFs.readFile(from, 'utf8')) as InterviewSession;
    if (snapshot.turns?.length > 1 && snapshot.turns.at(-1)?.transcriptStatus === undefined && Object.values(snapshot.runtime?.operations ?? {}).some(operation => operation.status === 'committed' && operation.result?.turn?.id === snapshot.turns.at(-1)?.id)) {
      configuration.failPreparedCommitSave = false;
      throw Object.assign(new Error('SYNTHETIC_PREPARED_COMMIT_SAVE_FAILURE'), { code: 'EIO' });
    }
  }
  if ((configuration.failPlaybackBatchSave || configuration.holdPlaybackBatchSave) && from.endsWith('.json.tmp')) {
    const snapshot = JSON.parse(await nativeFs.readFile(from, 'utf8')) as InterviewSession;
    if (snapshot.questionPresentationEventIds?.length) {
      if (configuration.holdPlaybackBatchSave) {
        configuration.holdPlaybackBatchSave = false; stats.playbackBatchSaveBlocked = true;
        await new Promise<void>(resolve => { releasePlaybackBatchSave = resolve; }); stats.playbackBatchSaveBlocked = false;
      }
      if (configuration.failPlaybackBatchSave) {
        configuration.failPlaybackBatchSave = false; stats.playbackBatchSaveFailures++;
        throw Object.assign(new Error('SYNTHETIC_PLAYBACK_BATCH_SAVE_FAILURE'), { code: 'EIO' });
      }
    }
  }
  if (configuration.holdCaptureFinalSave && from.endsWith('.json.tmp')) {
    const snapshot = JSON.parse(await nativeFs.readFile(from, 'utf8')) as InterviewSession;
    if (snapshot.turns?.at(-1)?.transcriptStatus === 'paused' && snapshot.turns.at(-1)?.metadata.answerCommitStatus === 'staged') {
      configuration.holdCaptureFinalSave = false; stats.captureSaveBlocked = true;
      await new Promise<void>(resolve => { releaseCaptureSave = resolve; }); stats.captureSaveBlocked = false;
    }
  }
  if (configuration.failCandidateDecisionSave && from.endsWith('.json.tmp')) {
    const snapshot = JSON.parse(await nativeFs.readFile(from, 'utf8')) as InterviewSession;
    if (['advance_ready', 'continuing'].includes(snapshot.turns?.at(-1)?.metadata.answerCommitStatus ?? '')) {
      configuration.failCandidateDecisionSave = false; stats.candidateSaveFailures++;
      throw Object.assign(new Error('SYNTHETIC_CANDIDATE_DECISION_SAVE_FAILURE'), { code: 'EIO' });
    }
  }
  return rename(from, to);
} });
syncBuiltinESMExports();
const control = http.createServer(async (request, response) => {
  if (request.headers['x-recovery-test-token'] !== process.env.RECOVERY_TEST_TOKEN) { response.writeHead(403); response.end(); return; }
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'GET' && request.url === '/state') { response.end(JSON.stringify(stats)); return; }
  let body = ''; for await (const chunk of request) body += chunk.toString();
  if (request.url === '/advance-work-clock') { const input = JSON.parse(body || '{}') as { milliseconds: number }; workClock.advance(input.milliseconds); }
  else if (request.url === '/release-closing-tts') { releaseClosingTts?.(); releaseClosingTts = undefined; }
  else if (request.url === '/release-stt-finish') { releaseSttFinish?.(); releaseSttFinish = undefined; }
  else if (request.url === '/configure') {
    const input = JSON.parse(body || '{}') as Record<string, unknown>;
    for (const name of Object.keys(configuration) as Array<keyof typeof configuration>) if (typeof input[name] === 'boolean') configuration[name] = input[name];
  } else if (request.url === '/release-candidate') { releaseCandidate?.(); releaseCandidate = undefined; }
  else if (request.url === '/release-preparation') { releasePreparation?.(); releasePreparation = undefined; }
  else if (request.url === '/release-capture-save') { releaseCaptureSave?.(); releaseCaptureSave = undefined; }
  else if (request.url === '/release-playback-save') { releasePlaybackBatchSave?.(); releasePlaybackBatchSave = undefined; }
  else { response.writeHead(404); response.end('{}'); return; }
  response.end('{"ok":true}');
});
control.listen(Number(process.env.STAGED_TEST_CONTROL_PORT), '127.0.0.1');
process.once('SIGTERM', () => { releaseClosingTts?.(); releaseSttFinish?.(); releaseCandidate?.(); releasePreparation?.(); releaseCaptureSave?.(); releasePlaybackBatchSave?.(); control.close(); });

export async function classifySingleCoreAnswerCandidate(context: InterviewContext, session: InterviewSession, candidate: SingleCoreAnswerCandidate, options: StrategyCoreOptions): Promise<SingleCoreCandidateResult> {
  stats.candidateCalls++;
  stats.lastCandidateAllowFollowUp = options.allowFollowUp;
  const observation = observeAnswerSubmission(candidate.text, session.turns.at(-1)?.metrics);
  const unobservedEmptyCapture = !candidate.text.trim() && (candidate.endingObservation?.microphoneEnabled === false || observation.classification !== 'silence_observed');
  const observedSilence = !candidate.text.trim() && !unobservedEmptyCapture;
  const continuing = unobservedEmptyCapture || configuration.nextContinue; configuration.nextContinue = false;
  if (configuration.holdCandidate) { configuration.holdCandidate = false; stats.candidateBlocked = true; await new Promise<void>(resolve => { releaseCandidate = resolve; }); stats.candidateBlocked = false; }
  const result = unobservedEmptyCapture ? null : await providers.runRealtimeCore(context, session, options);
  if (result) prepared.set(key(session, candidate.captureRevision), result);
  const turn = session.turns.at(-1)!;
  const response: SingleCoreCandidateResult = {
    kind: continuing ? 'CONTINUE' : 'ADVANCE', sourceTurnId: turn.id, sourceAnswerId: turn.answerId!,
    sourceTranscriptSha256: createHash('sha256').update(candidate.text).digest('hex'), captureRevision: candidate.captureRevision,
    engineVersion: 'semantic-single-core-v7', contractVersion: SINGLE_CORE_CONTRACT_VERSION, policySha256: 'explicit-synthetic-policy',
    semanticDecision: continuing ? { assessment: null, next: { action: 'CONTINUE_ANSWER', question: null }, reaction: null }
      : observedSilence ? { assessment: { coverage: 'unknown', response: 'unavailable', reason: 'Explicit synthetic VAD zero observation; no knowledge inference.' }, next: { action: 'REPLAY', question: null }, reaction: null }
      : result?.draft?.questionKind === 'follow_up' ? { assessment: { coverage: 'partial', response: 'answered', reason: 'Explicit synthetic follow-up decision.' }, next: { action: 'FOLLOW_UP', question: { text: result.draft.questionText, target: result.draft.targetEvidence[0], primaryFunction: result.draft.primaryFunction, depth: result.draft.depth, strategyId: null } }, reaction: null }
      : { assessment: { coverage: 'met', response: 'answered', reason: 'Explicit fixture advancement decision.' }, next: { action: 'TRANSITION', question: null }, reaction: null },
    providerTimings: result?.providerTimings ?? { coreMs: 0, coreModelCalls: 0, coreFallback: 0 },
  };
  if (configuration.mutateCandidateSource) { configuration.mutateCandidateSource = false; turn.rawTranscript += ' [synthetic invalid source mutation]'; }
  return response;
}

export function assertSingleCoreCandidateBinding(_context: InterviewContext, session: InterviewSession, decision: SingleCoreCandidateResult) {
  const turn = session.turns.at(-1)!;
  if (decision.sourceTurnId !== turn.id || decision.sourceAnswerId !== turn.answerId || decision.captureRevision !== turn.metadata.answerCaptureRevision ||
    decision.sourceTranscriptSha256 !== createHash('sha256').update(turn.rawTranscript ?? '').digest('hex') || decision.policySha256 !== 'explicit-synthetic-policy') throw new Error('SYNTHETIC_CORE_CANDIDATE_SOURCE_CHANGED');
}

export async function runRealtimeCore(context: InterviewContext, session: InterviewSession, options: StrategyCoreOptions): Promise<RealtimeCoreResult> {
  if (configuration.holdPreparation) { configuration.holdPreparation = false; stats.preparationBlocked = true; await new Promise<void>(resolve => { releasePreparation = resolve; }); stats.preparationBlocked = false; }
  if (!options.pendingCandidateDecision) return providers.runRealtimeCore(context, session, options);
  const result = prepared.get(key(session, options.pendingCandidateDecision.captureRevision));
  if (!result) throw new Error('SYNTHETIC_SOURCE_BOUND_DECISION_NOT_FOUND');
  stats.candidateReuse++;
  const reused = structuredClone(result);
  if ((configuration.cacheRepairWithoutProof || configuration.cacheRepairWithoutAuthority) && reused.draft) {
    const missingAuthority = configuration.cacheRepairWithoutAuthority;
    configuration.cacheRepairWithoutProof = false; configuration.cacheRepairWithoutAuthority = false;
    reused.draft.questionText = '검증 근거가 없는 합성 복구 질문은 무엇인가요?';
    reused.engineVersion = 'semantic-single-core-v7';
    reused.semanticDecision = missingAuthority ? undefined : options.pendingCandidateDecision.semanticDecision;
    reused.execution = { status: 'ready', action: 'FOLLOW_UP', surfaceOrigin: 'bounded_surface_repair', semanticAuthority: 'single_core' };
    reused.providerTimings.repairModelCalls = 1;
    if (missingAuthority) {
      const candidate = session.runtime?.answerCandidates?.[session.turns.at(-1)!.metadata.answerCandidateId ?? ''];
      if (candidate) delete candidate.decision;
    }
  }
  // Match production's live execution guard without making another semantic provider call.
  if (!options.allowFollowUp && reused.reaction.directive.startsWith('follow_up')) {
    reused.reaction = { ...reused.reaction, directive: 'next_main', action: 'transition' };
    reused.draft = null;
  }
  return reused;
}

export class ClovaSpeechStream extends providers.ClovaSpeechStream {
  private stagedFinish?: Promise<string>;
  override finish() {
    stats.providerFinishes++;
    if (this.stagedFinish) return this.stagedFinish;
    if (!configuration.holdSttFinish) return super.finish();
    configuration.holdSttFinish = false; stats.sttFinishBlocked = true;
    this.stagedFinish = (async () => { await new Promise<void>(resolve => { releaseSttFinish = resolve; }); stats.sttFinishBlocked = false; return super.finish(); })();
    return this.stagedFinish;
  }
}

export async function synthesizeSpeech(text: string, speaker: string, options: import('../../server/providers/speech-audio-cache').SpeechSynthesisOptions = {}) {
  if (configuration.holdClosingTts && text.startsWith('면접은 여기까지')) {
    configuration.holdClosingTts = false; stats.closingTtsBlocked = true;
    await new Promise<void>(resolve => { releaseClosingTts = resolve; }); stats.closingTtsBlocked = false;
  }
  return providers.synthesizeSpeech(text, speaker, { onTiming: timing => options.onTiming?.({ ...timing,
    providerMs: timing.cache === 'provider' ? timing.durationMs : null, audioId: createHash('sha256').update(`${speaker}:${text}`).digest('hex') }) });
}
