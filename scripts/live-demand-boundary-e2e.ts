import dotenv from 'dotenv';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { loadInterviewContextAt, type InterviewContext } from '../server/data/load-interview-context';
import { loadQuestionBank, createSessionQuestionPlan, selectPreparedMainQuestion, type PreparedQuestionBank } from '../server/data/prepared-question-bank';
import { bindQuestionContractToTurn } from '../server/question-objective';
import { createSessionRuntime } from '../server/session-runtime';
import { LocalSessionStore } from '../server/storage/local-session-store';
import { EvaluationJobStore, type EvaluationJob } from '../server/evaluation-job-store';
import { runEvaluationWorkerOnce } from '../server/evaluation-worker';
import { synthesizeSpeech, readSpeechAudio } from '../server/providers/clova-tts';
import { maskConversationSecrets } from '../server/storage/conversation-log';
import type { InterviewSession, PreparedTurn, RecordedTurn } from '../server/protocol';
import { decodeSyntheticAudio } from './live-e2e-audio';
import { replayEngineSourceFingerprints, replayHash } from './live-e2e-replay';
import { loadOfflineSemanticBinding } from './lib/semantic-release-gate';

type Data = Record<string, any>;
export const DEMAND_BOUNDARY_ROOT = '표본 크기에 따라 95% 신뢰구간의 폭이 달라진다는 점은 데이터의 불확실성을 어떻게 보여 주나요?';
export const FIXED_DEMAND_ANSWERS = Object.freeze({
  firstSegment: '구간 폭이 넓으면 맞히기 쉬워지지만',
  continuedSegment: '너무 넓으면 구체적인 추정은 아닙니다.',
  followUpOne: '다른 조건과 신뢰수준이 같으면 표본이 많아질수록 폭은 좁아집니다. 그리고 구간이 좁아졌다면 반드시 참값을 포함한다고 생각했습니다.',
  followUpTwo: '반드시 포함한다는 말은 제가 과장했습니다. 구간이 좁다는 것과 항상 참값을 포함한다는 것은 같은 뜻이 아닙니다.',
});

export function demandDriverOptions(args: string[]) {
  const value = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const maxTurns = Number(value('max-turns') ?? 6);
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 6) throw new Error('MAX_TURNS_MUST_BE_1_TO_6');
  const output = value('output') ?? `artifacts/live-demand-boundary-e2e-${new Date().toISOString().replace(/[:.]/gu, '-')}.json`;
  if (!/^artifacts\/live-demand-boundary-e2e-[a-zA-Z0-9-]+\.json$/u.test(output)) throw new Error('OUTPUT_PATH_INVALID');
  return { runLive: args.includes('--run-live'), maxTurns, output };
}

/** Queue isolation only; the real production evaluator and result store remain intact. */
export function onlyThisSyntheticJob(jobs: EvaluationJob[], owner: string, sessionId: string) {
  if (!owner.startsWith('synthetic-demand-boundary-')) throw new Error('SYNTHETIC_OWNER_REQUIRED');
  return jobs.filter(job => job.ownerId === owner && job.sessionId === sessionId);
}

/** Lifecycle control, not a semantic test adapter. Optional speech cannot prevent enqueue. */
export async function endBeforeOptionalClosing<T>(end: () => Promise<T>, closing: () => Promise<unknown>, optionalError: (error: unknown) => void): Promise<T> {
  const result = await end();
  try { await closing(); } catch (error) { optionalError(error); }
  return result;
}

/** Bind one existing approved root before server start. No answer or decision is seeded. */
export function createDemandCheckpoint(context: InterviewContext, bank: PreparedQuestionBank, owner: string): InterviewSession {
  if (!owner.startsWith('synthetic-demand-boundary-') || bank.status !== 'ready') throw new Error('SYNTHETIC_READY_BANK_REQUIRED');
  const row = bank.slots.find(slot => !slot.quarantine && slot.candidates.some(candidate => candidate.variant === 0 && candidate.draft.questionText === DEMAND_BOUNDARY_ROOT));
  if (!row) throw new Error('APPROVED_Q14_ROOT_MISSING');
  const plan = createSessionQuestionPlan(context, bank);
  const chosen = plan.slots.find(slot => (slot.candidateSlotId ?? slot.id) === row.slotId);
  if (!chosen) throw new Error('APPROVED_Q14_PLAN_SLOT_MISSING');
  plan.slots = [chosen, ...plan.slots.filter(slot => slot !== chosen)].map((slot, index) => ({ ...slot, index: index + 1 }));
  if (plan.selectionContext?.scope) plan.selectionContext.scope.ownerId = owner;
  if (plan.selectionContext) plan.selectionContext.historySessionIds = [];
  const now = new Date().toISOString(), runtime = createSessionRuntime(context, { id: owner, mode: 'local-development' }, now);
  const session: InterviewSession = { id: randomUUID(), createdAt: now, updatedAt: now, status: 'active', evaluationStatus: 'pending',
    target: structuredClone(context.target), runtime, sourceManifest: { ...structuredClone(context.manifest), interviewPlan: structuredClone(plan) },
    durationSeconds: context.interviewOverview!.durationSeconds, interviewOverview: structuredClone(context.interviewOverview), plan,
    mainQuestionTarget: plan.mainQuestionTarget, hasGreeted: false, turns: [], questionPresentations: [], questionPresentationEventIds: [], followUpCountByMainQuestion: {}, elapsedMs: 0,
    metrics: { verification: { syntheticTest: true, syntheticVoice: true, syntheticClientObservation: true, scenario: 'demand-boundary-staged-and-consecutive-F', noAnswerInjectedAtCheckpoint: true } } };
  const selected = selectPreparedMainQuestion(bank, session, 1);
  if (!selected || selected.draft.questionText !== DEMAND_BOUNDARY_ROOT) throw new Error('APPROVED_Q14_SELECTION_MISMATCH');
  const id = randomUUID(), draft = selected.draft;
  const binding = bindQuestionContractToTurn(draft, context, session, id);
  const turn: RecordedTurn = { id, questionText: draft.questionText, questionKind: 'main', parentMainQuestionId: id,
    mainIndex: 1, mainCount: plan.mainQuestionTarget, followUpIndex: 0, evidenceIds: [...draft.evidenceIds], questionAudioUrl: selected.audioUrl,
    acknowledgement: null, acknowledgementAudioUrl: null, interviewerId: 'interviewer-1', metadata: { ...structuredClone(draft), ...binding,
      rulesVersion: context.manifest.rulesVersion, generatedAt: now, answerTurnId: null, sourceAnswerId: null, sourceRefIds: [...draft.evidenceIds],
      supportTarget: structuredClone(context.target), parentQuestionId: null, questionClusterId: id, activityIds: [...selected.slot.activityIds],
      planSlotId: selected.slot.id, topicArea: selected.slot.topicArea, providerTimings: { preparedMainBankHit: 1 } } };
  Object.assign(turn.metadata, { questionBankKey: bank.key, questionBankCandidateId: selected.candidateId, voiceSettings: { question: selected.voiceSettings } });
  session.turns.push(turn); session.followUpCountByMainQuestion[id] = 0;
  runtime.checkpoint = { phase: 'question_prepared', at: now, turnId: id, answerId: null };
  return session;
}

export async function runDemandBoundaryE2E(options: ReturnType<typeof demandDriverOptions>) {
  if (!options.runLive) throw new Error('EXPLICIT_RUN_LIVE_REQUIRED');
  demandDriverOptions(['--run-live', `--max-turns=${options.maxTurns}`, `--output=${options.output}`]);
  dotenv.config({ path: '.env.local', quiet: true });
  const semanticReleaseIdentity = await loadOfflineSemanticBinding(process.argv.slice(2));
  await mkdir('artifacts', { recursive: true });
  // Reserve before source loading, session writes, server start or paid audio.
  const handle = await open(options.output, 'wx', 0o600);
  const owner = `synthetic-demand-boundary-${randomUUID()}`, start = performance.now();
  const report: Data = { version: 'live-demand-boundary-e2e-v1', semanticReleaseIdentity, startedAt: new Date().toISOString(), owner, maxTurns: options.maxTurns,
    sdkMaxRetries: 0, studentGenerationCalls: 0, fixedAnswers: FIXED_DEMAND_ANSWERS, captures: [], advances: [], failures: [],
    semanticReviewComplete: false, expectedSemanticChecks: { F1: '기답한 폭의 의미·불확실성 설명을 재요구하지 않고 미답 표본 크기→폭 관계만 확인',
      F2: '실제 새 항상 참값 포함 주장을 검증할 실익이 있을 때만 선택. F1 충족을 partial로 소급하지 않음',
      afterF2: '과장한 보장 주장의 정정을 수용하고 T. F3 없음' },
    provenance: { syntheticTest: true, syntheticVoice: true, syntheticClientObservation: true, actualBrowserPlayback: false,
      humanMicrophoneUsed: false, answerTextInjectedIntoServer: false, engineStubbed: false, approvedBankCheckpointSeededBeforeServerStart: true,
      scope: 'Real HTTP/WS/CLOVA STT/core/fact-review/TTS/worker; decoded question audio and synthetic delivery events, not observed browser playback.' } };
  const save = async () => { const bytes = Buffer.from(JSON.stringify(maskConversationSecrets(report), null, 2)); await handle.truncate(0);
    for (let offset = 0; offset < bytes.length;) { const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset); if (!bytesWritten) throw new Error('REPORT_WRITE_STALLED'); offset += bytesWritten; } };
  let child: ReturnType<typeof spawn> | undefined, session: InterviewSession | undefined, base = '', logicalMs = 0, serverOutput = '';
  const clockId = randomUUID(), store = new LocalSessionStore();
  const request = async (route: string, body?: unknown, timeout = 90000): Promise<Data> => {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, 'Content-Type': 'application/json', Connection: 'close' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
    const value = await response.json(); if (!response.ok) throw new Error(`HTTP_${response.status}:${JSON.stringify(value).slice(0, 350)}`); return value as Data;
  };
  const persisted = async () => { if (!session) throw new Error('SESSION_MISSING'); const saved = await store.load(session.id, owner); if (!saved) throw new Error('SESSION_NOT_SAVED'); return saved; };
  const event = async (type: string, turn: PreparedTurn, payload: Data = {}) => request(`/api/sessions/${session!.id}/events`, { eventId: randomUUID(), clockId, type,
    turnId: turn.id, phase: type === 'phase_changed' ? 'listening' : 'speaking_question', atMs: logicalMs, payload: { ...payload, verification: 'synthetic-client-observation', actualBrowserPlayback: false } });
  const audio = async (url: string) => { const response = await fetch(base + url, { headers: { Origin: base }, signal: AbortSignal.timeout(20000) });
    if (!response.ok || !response.headers.get('content-type')?.includes('audio')) throw new Error('QUESTION_AUDIO_UNREADABLE');
    const bytes = Buffer.from(await response.arrayBuffer()), decoded = await decodeSyntheticAudio(bytes); return { bytes: bytes.length, sha256: replayHash(bytes), durationMs: decoded.durationMs }; };
  const present = async (turn: PreparedTurn) => {
    const proof: Data = { turnId: turn.id, question: turn.questionText, kind: turn.questionKind };
    if (turn.acknowledgement && turn.acknowledgementAudioUrl) { proof.acknowledgement = await audio(turn.acknowledgementAudioUrl); await event('acknowledgement_playing', turn); logicalMs += proof.acknowledgement.durationMs; await event('audio_ended', turn, { role: 'acknowledgement' }); }
    proof.questionAudio = await audio(turn.questionAudioUrl); await event('question_playing', turn); logicalMs += proof.questionAudio.durationMs;
    await event('audio_ended', turn, { role: 'question' }); await event('phase_changed', turn); report.presentations ??= []; report.presentations.push(proof); await save();
  };
  const capture = async (turn: PreparedTurn, text: string, answerId: string, revision: number, priorAudioMs: number, activeAtSpace: boolean) => {
    if (report.captures.length >= options.maxTurns) throw new Error('CAPTURE_LIMIT_REACHED');
    const synthAt = performance.now(), timing: Data[] = [];
    const url = await synthesizeSpeech(text, 'nara', { settings: { speaker: 'nara', speed: 0, pitch: 0, volume: 0, format: 'mp3' }, onTiming: t => timing.push(t) });
    const bytes = await readSpeechAudio(url.slice('/api/audio/'.length)); if (!bytes) throw new Error('STUDENT_AUDIO_MISSING');
    const decoded = await decodeSyntheticAudio(bytes), socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/realtime?sessionId=${session!.id}`, { origin: base });
    const messages: Data[] = [], waits = new Map<string, { resolve: (v: Data) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    let terminal: Error | null = null;
    const fail = (error: Error) => { terminal = error; for (const wait of waits.values()) { clearTimeout(wait.timer); wait.reject(error); } waits.clear(); };
    const wait = (type: string, ms: number) => new Promise<Data>((resolve, reject) => { if (terminal) return reject(terminal); const timer = setTimeout(() => { waits.delete(type); reject(new Error(`WS_${type}_TIMEOUT`)); }, ms); waits.set(type, { resolve, reject, timer }); });
    socket.on('error', fail); socket.on('message', data => { try { const msg = JSON.parse(data.toString()) as Data; messages.push(msg); if (msg.type === 'error') return fail(new Error(`WS_${msg.code}`)); const pending = waits.get(msg.type); if (pending) { clearTimeout(pending.timer); waits.delete(msg.type); pending.resolve(msg); } } catch { fail(new Error('WS_BAD_MESSAGE')); } });
    const row: Data = { turnId: turn.id, answerId, captureRevision: revision, fixedText: text, fixedTextSha256: replayHash(text), mp3Sha256: replayHash(bytes), pcmSha256: replayHash(decoded.pcm), pcmBytes: decoded.pcm.length,
      audioDurationMs: decoded.durationMs, totalAudioMs: priorAudioMs + decoded.durationMs, ttsMs: performance.now() - synthAt, ttsTiming: timing, messages };
    report.captures.push(row); await save();
    try {
      // Saving the report can yield past a fast local handshake. Do not wait
      // for an open event that has already occurred.
      if (terminal) throw terminal;
      if (socket.readyState !== WebSocket.OPEN) await Promise.race([new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }), sleep(10000).then(() => { throw new Error('WS_OPEN_TIMEOUT'); })]);
      const ready = wait('started', 25000); socket.send(JSON.stringify({ type: 'start', turnId: turn.id, answerId, captureRevision: revision })); await ready;
      const streamedAt = performance.now();
      for (let offset = 0; offset < decoded.pcm.length; offset += 3200) { if (terminal) throw terminal; socket.send(decoded.pcm.subarray(offset, offset + 3200), { binary: true }); const delay = streamedAt + Math.min(offset + 3200, decoded.pcm.length) / 32 - performance.now(); if (delay > 0) await sleep(delay); }
      row.submittedAt = performance.now(); const done = wait('finalized', 25000); socket.send(JSON.stringify({ type: 'finish', turnId: turn.id, answerId, captureRevision: revision, staged: true }));
      const finalized = await done; row.sttFinalizeMs = performance.now() - row.submittedAt; row.rawTranscript = finalized.rawTranscript; row.streamId = finalized.streamId;
      logicalMs += decoded.durationMs;
      const speechDuration = row.totalAudioMs;
      row.candidateRequest = { turnId: turn.id, answerId, captureRevision: revision, elapsedMs: logicalMs,
        endingObservation: { stopSource: 'space', lastSpeechMs: speechDuration, trailingSilenceMs: 0, speechActiveAtEnd: activeAtSpace, vadAvailable: true, microphoneEnabled: true, tailDrainMs: 0, requestedAtMs: speechDuration },
        metrics: { speech: { durationMs: speechDuration, speakingMs: null, firstSpeechMs: null }, verification: { syntheticTest: true, syntheticVoice: true, syntheticClientObservation: true, scenario: 'demand-boundary-fixed-audio' } } };
      const candidateAt = performance.now(); row.candidate = await request(`/api/sessions/${session!.id}/answer-candidate`, row.candidateRequest); row.candidateMs = performance.now() - candidateAt;
      const saved = await persisted(), current = saved.turns.at(-1)!; row.persistedAnswerId = current.answerId; row.persistedRawTranscript = current.rawTranscript;
      row.captureParts = current.metadata.captureParts; row.sourcePreserved = current.answerId === answerId && current.rawTranscript === finalized.rawTranscript;
      if (!row.sourcePreserved) throw new Error('PERSISTED_CAPTURE_SOURCE_CHANGED');
      const decision = Object.values(saved.runtime?.answerCandidates ?? {}).find(c => c.id === row.candidate.candidateId); row.candidateState = decision;
      await save(); return row;
    } finally { for (const pending of waits.values()) clearTimeout(pending.timer); socket.close(); }
  };
  const advance = async (turn: PreparedTurn, captured: Data): Promise<PreparedTurn | null> => {
    if (captured.candidate.action === 'CONTINUE_ANSWER') throw new Error('CANNOT_ADVANCE_CONTINUING_ANSWER');
    const at = performance.now(), response = await fetch(`${base}/api/sessions/${session!.id}/next`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
      body: JSON.stringify({ turnId: turn.id, answerId: captured.answerId, captureRevision: captured.captureRevision, candidateId: captured.candidate.candidateId, elapsedMs: logicalMs, metrics: captured.candidateRequest.metrics }), signal: AbortSignal.timeout(90000) });
    const text = await response.text(), responseCompleteAt = performance.now(), events = text.split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    const saved = await persisted(), current = saved.turns.find(t => t.id === turn.id)!;
    const delivered = events.find((event: Data) => event.type === 'turn_ready')?.turn;
    const deliveredRecord = delivered ? saved.turns.find(t => t.id === delivered.id) : null;
    report.advances.push({ caseId: `DEMAND-STEP-${report.advances.length + 1}`, turnId: turn.id, question: turn.questionText, responseStatus: response.status, events, nextMs: responseCompleteAt - at,
      historySha256: replayHash(JSON.stringify(saved.turns.slice(0, saved.turns.indexOf(current)))),
      deliveredProof: deliveredRecord ? { turnId: deliveredRecord.id, questionSha256: replayHash(deliveredRecord.questionText),
        premiseValidationSha256: deliveredRecord.metadata.premiseValidation ? replayHash(JSON.stringify(deliveredRecord.metadata.premiseValidation)) : null,
        validationStatus: deliveredRecord.metadata.validationStatus } : null,
      finishToTurnReadyResponseMs: responseCompleteAt - captured.submittedAt,
      latencyScope: 'Synthetic WS finish send to completed HTTP turn_ready response; includes harness gaps, excludes browser decode/playback start.',
      coreDecision: current.metadata.coreDecision, providerTimings: current.metadata.providerTimings,
      rawTranscript: current.rawTranscript, answerId: current.answerId, rawAndAnswerIdPreserved: current.answerId === captured.answerId && current.rawTranscript === captured.rawTranscript, followUpCounts: saved.followUpCountByMainQuestion });
    await save(); if (!response.ok) throw new Error(`NEXT_HTTP_${response.status}`);
    const ready = events.find((event: Data) => event.type === 'turn_ready'); if (!ready) throw new Error('TURN_READY_MISSING'); return ready.turn ?? null;
  };
  try {
    const context = await loadInterviewContextAt(process.cwd(), { writeManifest: false }), bank = await loadQuestionBank(context);
    if (context.errors.length || !bank || !context.interviewOverview) throw new Error('VERIFIED_BANK_REQUIRED');
    report.engineSourceSha256 = await replayEngineSourceFingerprints(); report.bankIdentity = bank.key; report.bankContentSha256 = bank.contentSha256;
    session = createDemandCheckpoint(context, bank, owner); report.sessionId = session.id; await store.saveContext(context, owner); await store.save(session); await save();
    const port = await new Promise<number>(resolve => { const socket = net.createServer(); socket.listen(0, '127.0.0.1', () => { const p = (socket.address() as net.AddressInfo).port; socket.close(() => resolve(p)); }); });
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['--import', 'tsx', 'server/realtime.ts'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, REALTIME_PORT: String(port), LOCAL_INTERVIEW_OWNER_ID: owner } });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => { serverOutput = (serverOutput + String(bytes)).slice(-5000); });
    const deadline = Date.now() + 30000; while (true) { if (child.exitCode !== null) throw new Error('ISOLATED_SERVER_EXITED'); try { if ((await request('/api/health', undefined, 1000)).ok) break; } catch { /* bounded startup */ } if (Date.now() > deadline) throw new Error('SERVER_STARTUP_TIMEOUT'); await sleep(250); }
    report.sourceStatus = await request('/api/status'); if (!report.sourceStatus.ready || report.sourceStatus.sources.questionBankKey !== bank.key) throw new Error('SERVER_SOURCE_BANK_CHANGED');
    await request(`/api/sessions/${session.id}`); // Restore exactly the pre-start approved checkpoint and its audio ownership.
    let turn: PreparedTurn | null = session.turns[0]; await present(turn);
    const answerId = randomUUID(), first = await capture(turn, FIXED_DEMAND_ANSWERS.firstSegment, answerId, 1, 0, true);
    if (first.candidate.action !== 'CONTINUE_ANSWER') { report.pathNotReached = 'open-segment-continuation-not-selected'; }
    else {
      const second = await capture(turn, FIXED_DEMAND_ANSWERS.continuedSegment, answerId, 2, first.totalAudioMs, false);
      report.stagedContinuation = { sameTurn: first.turnId === second.turnId, sameAnswerId: first.answerId === second.answerId,
        revisions: [first.captureRevision, second.captureRevision], firstTranscriptPreservedAsPrefix: second.rawTranscript.startsWith(first.rawTranscript),
        parts: second.captureParts, bothProviderPartsStored: second.captureParts?.length === 2 && second.captureParts.every((p: Data) => p.sha256 === replayHash(p.rawTranscript)),
        finalTranscript: second.rawTranscript, clientTranscriptInjected: false };
      if (!report.stagedContinuation.sameTurn || !report.stagedContinuation.sameAnswerId || !report.stagedContinuation.bothProviderPartsStored ||
        second.captureParts[0].rawTranscript !== first.rawTranscript) throw new Error('STAGED_PROVIDER_PARTS_NOT_PRESERVED');
      if (second.candidate.action === 'CONTINUE_ANSWER') report.pathNotReached = 'completed-fixed-answer-still-continuing';
      else {
        turn = await advance(turn, second);
        for (let ordinal = 1; ordinal <= 2; ordinal++) {
          if (!turn || turn.questionKind !== 'follow_up' || turn.parentMainQuestionId !== session.turns[0].id || turn.followUpIndex !== ordinal) { report.pathNotReached = `F${ordinal}-not-selected`; break; }
          await present(turn); const reply = await capture(turn, ordinal === 1 ? FIXED_DEMAND_ANSWERS.followUpOne : FIXED_DEMAND_ANSWERS.followUpTwo, randomUUID(), 1, 0, false);
          if (reply.candidate.action === 'CONTINUE_ANSWER') { report.pathNotReached = `completed-F${ordinal}-reply-continuing`; break; }
          turn = await advance(turn, reply);
          if (ordinal === 2) { report.consecutiveFPathReached = true; report.finalTransitionObserved = !turn || turn.questionKind === 'main';
            if (!report.finalTransitionObserved) report.pathNotReached = 'transition-after-F2-not-selected';
            if (turn?.questionKind === 'follow_up') throw new Error('UNEXPECTED_THIRD_FOLLOWUP'); }
        }
      }
    }
  } catch (error) { report.failures.push({ stage: 'live', error: error instanceof Error ? error.message : String(error), serverOutput }); }
  finally {
    if (session && base) {
      // End is mandatory and first. Optional closing can never prevent durable enqueue.
      try { await endBeforeOptionalClosing(async () => { const at = performance.now(); report.endResponse = await request(`/api/sessions/${session!.id}/end`, { elapsedMs: logicalMs, metrics: { verification: { syntheticTest: true, syntheticVoice: true, syntheticClientObservation: true, scenario: 'demand-boundary-fixed-audio' } } }); report.endMs = performance.now() - at; report.endedThroughApi = true;
          const sourceFile = `data/sessions/${session!.id}.json`, before = await readFile(sourceFile), pinned = (await persisted()).runtime!.evaluationJob!;
          const retryAt = performance.now();
          await Promise.all([1, 2].map(index => request(`/api/sessions/${session!.id}/end`, { elapsedMs: logicalMs + index * 10000, metrics: { retryMustNotReplace: index } })));
          const after = await readFile(sourceFile), resumed = (await persisted()).runtime!.evaluationJob!;
          const matchingJobs = [];
          for (const name of (await readdir('data/evaluation-jobs')).filter(name => name.endsWith('.job.json'))) {
            const job = JSON.parse(await readFile(`data/evaluation-jobs/${name}`, 'utf8')) as EvaluationJob;
            if (job.sessionId === session!.id && job.ownerId === owner) matchingJobs.push(job.id);
          }
          report.duplicateEndProof = { concurrentRetries: 2, retryMs: performance.now() - retryAt, sessionBytesUnchanged: before.equals(after), jobIdUnchanged: pinned.id === resumed.id, matchingJobs };
          if (!before.equals(after) || pinned.id !== resumed.id || matchingJobs.length !== 1 || matchingJobs[0] !== pinned.id) throw new Error('DUPLICATE_END_CHANGED_SOURCE_OR_JOB');
        },
        async () => { const closing = await request(`/api/sessions/${session!.id}/closing`, { reason: 'user_ended', elapsedMs: logicalMs }); report.closing = closing.closingUtterance; if (report.closing?.audioUrl) report.closingAudio = await audio(report.closing.audioUrl); },
        error => { report.optionalClosingError = String(error); }); }
      catch (error) { report.failures.push({ stage: 'end', error: String(error) }); }
      if (report.endedThroughApi) {
        try {
          const sid = session.id;
          class ThisTestJobs extends EvaluationJobStore { override async pending(now?: number) { return onlyThisSyntheticJob(await super.pending(now), owner, sid); } }
          const jobs = new ThisTestJobs(), deadline = Date.now() + 180000;
          while (Date.now() < deadline) {
            await runEvaluationWorkerOnce({ jobs, sessions: store, workerId: `demand-boundary-${randomUUID()}` });
            const projection = await request(`/api/sessions/${sid}`), saved = await persisted(), id = saved.runtime?.evaluationJob?.id;
            const job = id ? await jobs.get(id) : null, result = job ? await jobs.result(job) : null;
            report.finalSession = saved; report.finalEvaluation = { projectedStatus: projection.evaluationStatus, job, result };
            if (projection.evaluationStatus === 'completed' || projection.evaluationStatus === 'failed') break; await sleep(500);
          }
          if (report.finalEvaluation?.projectedStatus !== 'completed' || !report.finalEvaluation?.result) report.failures.push({ stage: 'evaluation', error: 'VERIFIED_EVALUATION_RESULT_NOT_COMPLETED' });
        } catch (error) { report.failures.push({ stage: 'evaluation', error: String(error) }); }
      }
    }
    report.completedAt = new Date().toISOString(); report.wallMs = performance.now() - start; report.logicalInterviewMs = logicalMs;
    if (report.engineSourceSha256) { const after = await replayEngineSourceFingerprints(); report.engineSourceUnchanged = JSON.stringify(after) === JSON.stringify(report.engineSourceSha256); if (!report.engineSourceUnchanged) report.engineSourceSha256After = after; }
    report.logPath = session ? `data/conversation-logs/${session.id}.jsonl` : null;
    if (session) {
      try { const [savedBytes, journalBytes] = await Promise.all([readFile(`data/sessions/${session.id}.json`), readFile(report.logPath)]);
        report.persistenceProof = { sessionSha256: replayHash(savedBytes), journalSha256: replayHash(journalBytes), originalSyntheticSessionId: session.id,
          originalOwner: owner, journalBytes: journalBytes.length, rawTranscripts: (JSON.parse(savedBytes.toString('utf8')) as InterviewSession).turns.map(turn => ({ turnId: turn.id, answerId: turn.answerId ?? null, transcriptSha256: replayHash(turn.rawTranscript ?? '') })) };
      } catch (error) { report.persistenceProofError = String(error); }
    }
    report.semanticScope = 'Actual questions and raw STT must be read independently: F1 should only ask missing size-width relation; F2 is discretionary new-claim verification. Driver never approves meaning from action labels alone.';
    try { await save(); } finally { child?.kill(); await handle.close(); }
  }
  return { output: options.output, sessionId: session?.id, failures: report.failures.length,
    pathReached: report.consecutiveFPathReached === true && report.finalTransitionObserved === true, pathNotReached: report.pathNotReached ?? null, evaluation: report.finalEvaluation?.projectedStatus };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = demandDriverOptions(process.argv.slice(2));
  if (!options.runLive) throw new Error('EXPLICIT_RUN_LIVE_REQUIRED');
  const result = await runDemandBoundaryE2E(options); console.log(JSON.stringify(result));
  if (result.failures || !result.pathReached) process.exitCode = result.failures ? 1 : 2;
}
