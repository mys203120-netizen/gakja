'use client';
import { SubmissionWait, TURN_WAIT_TIMEOUT_MESSAGE } from '@/lib/interview/submission-wait';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AudioDevices } from './useAudioDevices';
import type { ClosingUtterance } from '@/server/session-runtime';
import { calculateSpeechMetrics } from '@/lib/interview/speech-metrics';
import { observeSpeechHabits } from '@/lib/interview/speech-habits';
import { finalizedAnswerAction, retirePlaybackRun } from '@/lib/interview/session-lifecycle';
import { AnswerCaptureLifecycle, answerCaptureTailAction, shouldDrainAnswerTail, type AnswerStopSource, type CaptureScope, type SpeechEndingObservation } from '@/lib/interview/answer-capture';
import { InterviewDurationBudget, isInterviewDurationSeconds } from '@/lib/interview/timing';
import { InterviewAudioPreloader, InterviewPlaybackGate } from '@/lib/interview/audio-preload';
import { FirstQuestionPreparation, type PreparedFirstQuestion } from '@/lib/interview/first-question-preparation';
import { canStartListeningAfterAudio, ProgressiveInterviewAudio } from '@/lib/interview/progressive-audio';
import { playNativeInterviewAudio } from '@/lib/interview/native-audio-playback';
import { bestEffortClosing, DurableEndRegistration, durableEndRequestInit, endingAnswerObservations } from '@/lib/interview/durable-end';
import { NextTurnOperation, NextTurnResponseError, readNextTurnResponse, type AcknowledgementReady } from '@/lib/interview/next-turn-stream';
import { ClientTimingLedger } from '@/lib/interview/client-timings';
import { InterviewClientEventJournal, phaseEventTurnId, readClientEventReceipt, type InterviewClientEvent } from '@/lib/interview/client-events';
import { serviceDisplayMessage } from '@/lib/interview/service-errors';
import { microphoneErrorMessage } from '@/lib/interview/audio-devices';
import { acceptStartupDeviceResult, FullscreenRequestGate, initialStartupState, InterviewStartupCountdown, isPreQuestionStartupPhase, mayStartInterview, phaseAfterAcknowledgement, requestConfirmedFullscreen, startupFailureMessage, startupPlaybackAction, startupReducer, type StartupAction } from '@/lib/interview/startup-flow';
export type { AcknowledgementReady, NextTurnProgress } from '@/lib/interview/next-turn-stream';

export type Phase = 'idle' | 'device_check' | 'countdown' | 'preparing' | 'speaking_question' | 'listening' | 'finalizing_transcript' | 'preparing_next' | 'speaking_acknowledgement' | 'suspended' | 'ending' | 'completed' | 'error';
export type PreparedTurn = { id: string; questionText: string; questionKind: 'main' | 'follow_up' | 'clarification'; parentMainQuestionId: string; mainIndex: number; mainCount: number; mainCountIsLimit?: boolean; followUpIndex: number; evidenceIds: string[]; questionAudioUrl: string; acknowledgement: string | null; acknowledgementAudioUrl: string | null; interviewerId: string };
export type ConversationMessage = { id: string; role: 'interviewer' | 'candidate'; kind: 'question' | 'acknowledgement' | 'answer'; text: string; pending?: boolean; time: number };
export type ActiveInterviewerSpeech = { turnId: string; speakerId: 'interviewer-1' | 'interviewer-2' };
export function matchesSessionScope(event: { sessionId?: string; turnId?: string; answerId?: string }, current: { sessionId: string | null; turnId?: string; answerId: string; epoch: number }, responseEpoch: number) {
  return responseEpoch === current.epoch && (!event.sessionId || event.sessionId === current.sessionId) && (!event.turnId || event.turnId === current.turnId) && (!event.answerId || event.answerId === current.answerId);
}
export type InterviewOverview = { lines: [string, string, string]; durationSeconds: number; source: { id: string; title: string; url: string; academicYear: number; location: string; verificationStatus: string }; trackId: string };
export type PreparationStatus = { ready: boolean; missingKeys: string[]; errors: string[]; realtimePort: number; target: { university: string; department: string; track: string; year: number; studentName: string }; durationSeconds?: number; turnWaitTimeoutMs?: number; interviewOverview?: InterviewOverview | null; sources?: unknown; preparationReady?: boolean; firstPrepared?: boolean };
type SpeechObservation = SpeechEndingObservation;
type EndingObservation = { stopSource: AnswerStopSource; lastSpeechMs: number | null; trailingSilenceMs: number | null; speechActiveAtEnd: boolean | null; vadAvailable: boolean; microphoneEnabled?: boolean; tailDrainMs?: number; requestedAtMs?: number };
type AnswerCandidateResult = { action: 'CONTINUE_ANSWER' | 'ADVANCE'; candidateId: string; captureRevision: number; rawTranscript: string; acceptedClientEventIds?: string[] };
type AnswerCandidateOperation = { scope: CaptureScope; endingObservation: EndingObservation; promise?: Promise<AnswerCandidateResult>; result?: AnswerCandidateResult };
type AnswerObservation = { turnId: string; answerId: string; speech: ReturnType<typeof calculateSpeechMetrics>; habits: ReturnType<typeof observeSpeechHabits> };
type EndPayload = { metrics: Record<string, unknown>; elapsedMs: number };
type EndAcceptance = { status?: string; evaluationStatus?: string };
// React retirement/unmount must not abort a confirmed end request. The server
// supplies durable idempotence across reloads; this shares one browser request.
const durableEnds = new DurableEndRegistration<EndPayload, EndAcceptance>();
export function preparationDurationSeconds(preparation: PreparationStatus | null) {
  const overview = preparation?.interviewOverview;
  if (!overview || !Array.isArray(overview.lines) || overview.lines.length !== 3 || overview.lines.some(line => typeof line !== 'string' || !line.trim()) || !isInterviewDurationSeconds(overview.durationSeconds)) return null;
  if (preparation?.durationSeconds !== undefined && preparation.durationSeconds !== overview.durationSeconds) return null;
  return overview.durationSeconds;
}
type State = { phase: Phase; visibleTurn: PreparedTurn | null; activeSpeech: ActiveInterviewerSpeech | null; messages: ConversationMessage[]; error: string; sessionId: string | null; elapsedMs: number; evaluationStatus: string; endingRequested: boolean };
export const initialSessionState: State = { phase: 'idle', visibleTurn: null, activeSpeech: null, messages: [], error: '', sessionId: null, elapsedMs: 0, evaluationStatus: '', endingRequested: false };
export type SessionAction = { type: 'phase'; phase: Phase } | { type: 'restore'; sessionId: string; elapsedMs: number; messages: ConversationMessage[] } | { type: 'reveal'; turn: PreparedTurn } | { type: 'speech_started'; turnId: string; speakerId: string } | { type: 'speech_cleared' } | { type: 'message'; message: ConversationMessage } | { type: 'error'; message: string } | { type: 'time'; elapsedMs: number } | { type: 'session'; sessionId: string } | { type: 'evaluation'; status: string } | { type: 'reset' } | { type: 'request_end' };
export function sessionReducer(state: State, action: SessionAction): State {
  if (action.type === 'reset') return { ...initialSessionState };
  if (action.type === 'restore') return { ...initialSessionState, phase: 'suspended', sessionId: action.sessionId, elapsedMs: action.elapsedMs, messages: action.messages };
  if (state.phase === 'ending' || state.phase === 'completed') {
    if (['reveal', 'message', 'session', 'time', 'speech_started'].includes(action.type)) return state;
    if (action.type === 'phase' && (state.phase === 'completed' ? action.phase !== 'completed' : action.phase !== 'ending' && action.phase !== 'completed')) return state;
    if (action.type === 'error' && state.phase === 'completed') return state;
  }
  if (action.type === 'request_end') return { ...state, endingRequested: true, visibleTurn: null };
  // Keep the owner while pending audio is paused, including an interrupted
  // opening's device check/countdown. Native playing is announced only once.
  if (action.type === 'phase') return { ...state, phase: action.phase, visibleTurn: action.phase === 'ending' || action.phase === 'completed' ? null : state.visibleTurn, activeSpeech: ['idle', 'listening', 'finalizing_transcript', 'preparing_next', 'ending', 'completed'].includes(action.phase) ? null : state.activeSpeech, error: '' };
  if (action.type === 'speech_started') {
    if (state.phase !== 'speaking_question' && state.phase !== 'speaking_acknowledgement') return state;
    const speakerId = action.speakerId;
    return { ...state, activeSpeech: action.turnId && (speakerId === 'interviewer-1' || speakerId === 'interviewer-2') ? { turnId: action.turnId, speakerId } : null };
  }
  if (action.type === 'speech_cleared') return state.activeSpeech ? { ...state, activeSpeech: null } : state;
  if (action.type === 'reveal') return state.phase === 'speaking_question' && !state.endingRequested ? { ...state, visibleTurn: action.turn } : state;
  if (action.type === 'message') { const existing = state.messages.findIndex(m => m.id === action.message.id); return { ...state, messages: existing < 0 ? [...state.messages, action.message] : state.messages.map((m, i) => i === existing ? { ...m, ...action.message } : m) }; }
  if (action.type === 'error') return { ...state, phase: 'error', error: action.message };
  if (action.type === 'time') return { ...state, elapsedMs: action.elapsedMs };
  if (action.type === 'session') return { ...state, sessionId: action.sessionId };
  if (action.type === 'evaluation') return { ...state, evaluationStatus: action.status };
  return state;
}
const activePhases = new Set<Phase>(['speaking_question', 'listening', 'finalizing_transcript', 'preparing_next', 'speaking_acknowledgement']);
export const isInterviewClockPhase = (phase: Phase) => activePhases.has(phase);
const activeSessionStorageKey = 'each-answer-active-session-v1';
function rememberActiveSession(id: string | null) { try { if (id) localStorage.setItem(activeSessionStorageKey, id); else localStorage.removeItem(activeSessionStorageKey); } catch { /* Local persistence may be unavailable; server state remains authoritative. */ } }
async function api<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, body === undefined ? { cache: 'no-store', signal } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const result = await response.json(); if (!response.ok) throw new NextTurnResponseError(serviceDisplayMessage(result.error ?? result.message), typeof result.code === 'string' ? result.code : undefined); return result;
}

export function useInterviewSession(media: AudioDevices, metrics: () => unknown, speechReset: () => void) {
  const [state, setState] = useState<State>(initialSessionState), stateRef = useRef(state);
  const [preparation, setPreparation] = useState<PreparationStatus | null>(null);
  const [preparationError, setPreparationError] = useState('');
  const [capturingTail, setCapturingTail] = useState(false);
  const recoveryChecked = useRef(false), recoveryClosing = useRef<ClosingUtterance | null>(null), closingPlayback = useRef(false), closingPlayed = useRef<string | null>(null), endingWork = useRef(false);
  const pendingEnd = useRef<{ sessionId: string; promise: Promise<void> } | null>(null);
  const endingClosingAbort = useRef<AbortController | null>(null);
  const recoveringAnswerTurn = useRef<string | null>(null);
  const questionRecoveryRequiresEnd = useRef(false);
  const [startup, setStartup] = useState(initialStartupState), startupRef = useRef(initialStartupState), startupCountdown = useRef(new InterviewStartupCountdown());
  const mediaRef = useRef(media), firstLaunch = useRef(false);
  const startupTarget = useRef<HTMLElement | null>(null), startupMicrophoneRequest = useRef(0), startupCameraRequest = useRef(0);
  const fullscreenRequests = useRef(new FullscreenRequestGate());
  mediaRef.current = media;
  const updateStartup = useCallback((action: StartupAction) => { const next = startupReducer(startupRef.current, action); startupRef.current = next; setStartup(next); }, []);
  const duration = useRef(new InterviewDurationBudget()), preparationRequest = useRef(0);
  const generation = useRef(0), socket = useRef<WebSocket | null>(null), turn = useRef<PreparedTurn | null>(null), answerId = useRef('');
  const socketIdentity = useRef(''), pauseFinished = useRef<Promise<void>>(Promise.resolve()), pauseResolve = useRef<(() => void) | null>(null);
  const transcript = useRef(''), submitted = useRef(false), submitting = useRef(false), resumePhase = useRef<Phase>('idle');
  const pcmAllowed = useRef(false);
  const answerFinalized = useRef(false), nextCommitted = useRef<string | null>(null);
  const answerCapture = useRef(new AnswerCaptureLifecycle()), candidateOperation = useRef<AnswerCandidateOperation | null>(null);
  const pendingFinish = useRef<(CaptureScope & { type: 'finish'; staged: boolean; submissionAttemptId?: string }) | null>(null);
  const submissionWait = useRef<SubmissionWait | null>(null);
  const actions = useRef<{ start: () => Promise<void>; next: (epoch: number) => Promise<void>; candidate: (epoch: number) => Promise<void>; resume: () => Promise<void>; end: () => Promise<void> }>({ start: async () => {}, next: async () => {}, candidate: async () => {}, resume: async () => {}, end: async () => {} });
  const finalized = useRef<{ resolve: (text: string) => void; reject: (reason: Error) => void } | null>(null);
  const retryAction = useRef<(() => void) | null>(null), pendingTurn = useRef<PreparedTurn | null>(null);
  const accumulated = useRef(0), activeStarted = useRef<number | null>(null), hadBegun = useRef(false);
  const lastCheckpointAt = useRef(0);
  const metricsRef = useRef(metrics), resetSpeechRef = useRef(speechReset), pauseRef = useRef<() => void>(() => {}), endRef = useRef<() => Promise<void>>(async () => {});
  const finishAfterAnswer = useRef(false), timingLedger = useRef(new ClientTimingLedger());
  const audioPreloader = useRef(new InterviewAudioPreloader()), playbackGate = useRef(new InterviewPlaybackGate());
  const audioSequencer = useRef<{ epoch: number; player: ProgressiveInterviewAudio } | null>(null), nextOperation = useRef<NextTurnOperation | null>(null);
  const pendingAudioCancel = useRef<(() => void) | null>(null), playbackRole = useRef<Phase | null>(null), listeningTurn = useRef<string | null>(null);
  const answerObservations = useRef(new Map<string, AnswerObservation>()), submittedSpeech = useRef(new Map<string, SpeechObservation>());
  const pendingTimingWrites = useRef(new Map<Promise<void>, string>());
  const clientEvents = useRef(new InterviewClientEventJournal((sessionId, event) => api(`/api/sessions/${encodeURIComponent(sessionId)}/events`, event, AbortSignal.timeout(8_000))));
  const playbackTurn = useRef<string | null>(null);
  const firstQuestionPreparation = useRef(new FirstQuestionPreparation());
  metricsRef.current = metrics; resetSpeechRef.current = speechReset;
  const dispatch = useCallback((action: SessionAction) => {
    const previous = stateRef.current;
    const next = sessionReducer(previous, action);
    const wasActive = isInterviewClockPhase(previous.phase), isActive = isInterviewClockPhase(next.phase);
    if (wasActive && !isActive && activeStarted.current !== null) { accumulated.current += performance.now() - activeStarted.current; activeStarted.current = null; }
    if (!wasActive && isActive && hadBegun.current && activeStarted.current === null) activeStarted.current = performance.now();
    stateRef.current = next; setState(next);
    if ((action.type === 'session' || action.type === 'restore') && next.sessionId) { clientEvents.current.bind(next.sessionId, generation.current); rememberActiveSession(next.sessionId); }
    if (action.type === 'reset' || action.type === 'phase' && action.phase === 'completed') rememberActiveSession(null);
    const phaseTurnId = phaseEventTurnId(next.phase, { playbackTurnId: playbackTurn.current, pendingTurnId: pendingTurn.current?.id, currentTurnId: turn.current?.id });
    if (next.sessionId && (previous.phase !== next.phase || previous.sessionId !== next.sessionId)) clientEvents.current.emit({ sessionId: next.sessionId, epoch: generation.current }, { type: 'phase_changed', phase: next.phase, turnId: phaseTurnId, payload: { elapsedMs: accumulated.current + (activeStarted.current === null ? 0 : performance.now() - activeStarted.current) } });
    if (next.sessionId && action.type === 'error' && next.phase === 'error') clientEvents.current.emit({ sessionId: next.sessionId, epoch: generation.current }, { type: 'client_error', phase: next.phase, turnId: pendingTurn.current?.id ?? turn.current?.id, payload: { message: action.message.slice(0, 400) } });
  }, []);
  const retireRun = useCallback(() => {
    questionRecoveryRequiresEnd.current = false;
    const waiting = submissionWait.current;
    if (waiting?.finishSent && socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'cancel_submission', ...waiting.scope, submissionAttemptId: waiting.attemptId }));
    submissionWait.current?.cancel(); submissionWait.current = null;
    startupCountdown.current.cancel(); firstLaunch.current = false; startupTarget.current = null;
    clientEvents.current.retire(); playbackTurn.current = null;
    const epoch = retirePlaybackRun({ generation, turn, pendingTurn, answerId, transcript, submitted, submitting, answerFinalized, nextCommitted, resumePhase, retryAction, pcmAllowed, socketIdentity, socket, audio: media.audio, finalized, pauseResolve, pauseFinished });
    pendingAudioCancel.current?.(); pendingAudioCancel.current = null; playbackRole.current = null;
    dispatch({ type: 'speech_cleared' });
    nextOperation.current?.controller.abort(); nextOperation.current = null;
    answerCapture.current.reset(); candidateOperation.current = null; pendingFinish.current = null; setCapturingTail(false);
    audioPreloader.current.dispose(); playbackGate.current.dispose(); audioSequencer.current = null; listeningTurn.current = null;
    return epoch;
  }, [dispatch, media.audio]);
  const observeClientEvent = useCallback((event: Omit<InterviewClientEvent, 'eventId' | 'atMs'> & { atMs?: number }, epoch: number) => { const sessionId = stateRef.current.sessionId; if (sessionId && epoch === generation.current) clientEvents.current.emit({ sessionId, epoch }, event); }, []);
  const elapsed = useCallback(() => accumulated.current + (activeStarted.current === null ? 0 : performance.now() - activeStarted.current), []);
  const preparationKey = preparation?.ready ? JSON.stringify([preparation.target, preparation.durationSeconds, preparation.sources]) : null;
  useEffect(() => {
    if (!preparation || recoveryChecked.current || stateRef.current.sessionId) return;
    recoveryChecked.current = true;
    let savedId: string | null = null; try { savedId = localStorage.getItem(activeSessionStorageKey); } catch { return; }
    if (!savedId) return;
    const controller = new AbortController(), responseEpoch = generation.current;
    void api<{ sessionId: string; target: unknown; status: string; evaluationStatus: string; durationSeconds: number; recovery: { currentTurn: PreparedTurn | null; elapsedMs: number; transcript: string; transcriptStatus: string | null; answerId: string | null; captureRevision?: number; answerCommitStatus?: 'capturing' | 'staged' | 'deciding' | 'continuing' | 'advance_ready' | 'advancing' | 'committed'; candidateId?: string; endingObservation?: EndingObservation; deliveryUncertain: boolean; closingUtterance: ClosingUtterance | null; closingDelivered?: boolean; messages?: ConversationMessage[] } }>(`/api/sessions/${encodeURIComponent(savedId)}`, undefined, controller.signal).then(result => {
      if (responseEpoch !== generation.current || stateRef.current.phase !== 'idle' || stateRef.current.sessionId || !result.recovery?.currentTurn) return;
      if (JSON.stringify(result.target) !== JSON.stringify(preparation.target)) throw new Error('이전 면접의 학생·지원처가 현재 준비 자료와 다릅니다. 저장된 기록은 보존했습니다.');
      const recovered = result.recovery, current = recovered.currentTurn!;
      duration.current.updatePreparation(result.durationSeconds); duration.current.beginSession();
      accumulated.current = recovered.elapsedMs; activeStarted.current = null; hadBegun.current = true;
      turn.current = current; answerId.current = recovered.answerId || crypto.randomUUID(); transcript.current = recovered.transcript;
      recoveringAnswerTurn.current = recovered.answerId ? current.id : null;
      const captureScope = { turnId: current.id, answerId: answerId.current, captureRevision: recovered.captureRevision ?? 0 };
      const candidatePending = recovered.answerCommitStatus === 'staged' || recovered.answerCommitStatus === 'deciding';
      const advanceLocked = ['advance_ready', 'advancing', 'committed'].includes(recovered.answerCommitStatus ?? '') || recovered.transcriptStatus === 'finalized';
      answerCapture.current.restore(captureScope, advanceLocked ? 'advance_locked' : candidatePending ? 'stt_final' : 'capturing', recovered.candidateId ?? null);
      candidateOperation.current = candidatePending ? { scope: captureScope, endingObservation: recovered.endingObservation ?? { stopSource: 'button', lastSpeechMs: null, trailingSilenceMs: null, speechActiveAtEnd: null, vadAvailable: false } } : null;
      answerFinalized.current = advanceLocked; submitted.current = candidatePending || advanceLocked;
      recoveryClosing.current = recovered.closingUtterance;
      if (recovered.closingDelivered && recovered.closingUtterance) closingPlayed.current = recovered.closingUtterance.id;
      if (recovered.deliveryUncertain || !recovered.transcriptStatus) { pendingTurn.current = current; resumePhase.current = 'speaking_question'; }
      else resumePhase.current = candidatePending ? 'finalizing_transcript' : answerFinalized.current ? 'preparing_next' : 'listening';
      playbackGate.current.pause();
      dispatch({ type: 'restore', sessionId: result.sessionId, elapsedMs: recovered.elapsedMs, messages: recovered.messages ?? [] });
      if (result.status === 'completed' || result.status === 'ending' && !recovered.closingUtterance) { hadBegun.current = false; dispatch({ type: 'evaluation', status: result.evaluationStatus }); dispatch({ type: 'phase', phase: 'completed' }); }
    }).catch(error => { if (!controller.signal.aborted && responseEpoch === generation.current) { rememberActiveSession(null); setPreparationError(serviceDisplayMessage(error)); } });
    return () => { controller.abort(); if (!stateRef.current.sessionId) recoveryChecked.current = false; };
  }, [dispatch, preparation]);
  const warmFirstQuestion = useCallback(() => {
    if (!preparationKey || stateRef.current.sessionId) return;
    void firstQuestionPreparation.current.ensure(preparationKey, async signal => {
      const response = await fetch('/api/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal });
      if (!response.ok) throw new Error('첫 질문을 준비하지 못했습니다.');
      return response.json() as Promise<PreparedFirstQuestion>;
    }).then(result => {
      // Approved audio is downloaded quietly; the countdown and native playing gate control reveal/time.
      if (firstQuestionPreparation.current.readyId(preparationKey) === result.preparationId && !stateRef.current.sessionId && ['idle', 'device_check', 'countdown', 'preparing'].includes(stateRef.current.phase)) {
        const urls = [result.questionAudioUrl, ...(Array.isArray(result.questionAudioUrls) ? result.questionAudioUrls : [])].filter((url): url is string => typeof url === 'string' && url.startsWith('/api/audio/'));
        for (const url of new Set(urls)) void audioPreloader.current.prepare(url).catch(() => {});
      }
    }).catch(() => {});
  }, [preparationKey]);
  const retryMicrophone = useCallback(async () => {
    const epoch = generation.current, request = ++startupMicrophoneRequest.current; updateStartup({ type: 'microphone', status: 'checking' });
    try { if (media.micStream?.active && !media.micEnabled) await media.toggleMic(); else await media.requestMic(); if (acceptStartupDeviceResult(epoch, generation.current, undefined, request, startupMicrophoneRequest.current)) updateStartup(media.isMicrophoneReady() ? { type: 'microphone', status: 'ready' } : { type: 'microphone', status: 'error', error: '마이크 입력이 일시 중단되어 있습니다. 장치 연결과 음소거 상태를 확인하고 다시 눌러 주세요.' }); }
    catch (failure) { if (acceptStartupDeviceResult(epoch, generation.current, undefined, request, startupMicrophoneRequest.current)) updateStartup({ type: 'microphone', status: 'error', error: microphoneErrorMessage(failure, { id: media.selectedMicId, label: media.selectedMicLabel, groupId: '' }) }); }
  }, [media, updateStartup]);
  useEffect(() => {
    if (state.phase !== 'device_check') return;
    if (media.isMicrophoneReady() && startupRef.current.microphone !== 'ready') updateStartup({ type: 'microphone', status: 'ready' });
    else if (!media.isMicrophoneReady() && startupRef.current.microphone === 'ready' && ['muted', 'unavailable', 'disconnected'].includes(media.micStatus)) updateStartup({ type: 'microphone', status: 'error', error: '마이크 입력이 일시 중단되어 있습니다. 장치 연결과 음소거 상태를 확인한 뒤 다시 눌러 주세요.' });
  }, [media, state.phase, updateStartup]);
  const retryCamera = useCallback(async () => {
    const epoch = generation.current, request = ++startupCameraRequest.current; updateStartup({ type: 'camera', status: 'checking' });
    try { await media.requestCamera(); if (acceptStartupDeviceResult(epoch, generation.current, startupRef.current.camera, request, startupCameraRequest.current)) updateStartup({ type: 'camera', status: 'ready' }); }
    catch { if (acceptStartupDeviceResult(epoch, generation.current, startupRef.current.camera, request, startupCameraRequest.current)) updateStartup({ type: 'camera', status: 'error', error: '카메라 권한을 확인하거나 카메라 없이 진행을 선택해 주세요.' }); }
  }, [media, updateStartup]);
  const prepareDevices = useCallback(() => {
    if (stateRef.current.phase !== 'idle' || !preparation?.ready) return;
    retireRun(); dispatch({ type: 'reset' }); dispatch({ type: 'phase', phase: 'device_check' }); updateStartup({ type: 'open' });
    duration.current.resetSession(); timingLedger.current.clear(); answerObservations.current.clear(); submittedSpeech.current.clear();
    accumulated.current = 0; activeStarted.current = null; hadBegun.current = false; finishAfterAnswer.current = false; media.capture(false);
    warmFirstQuestion();
    if (media.micEnabled && media.micStream?.active) updateStartup({ type: 'microphone', status: 'ready' }); else void retryMicrophone();
    if (media.cameraEnabled && media.cameraStream?.active) updateStartup({ type: 'camera', status: 'ready' }); else void retryCamera();
  }, [dispatch, media, preparation?.ready, retireRun, retryCamera, retryMicrophone, updateStartup, warmFirstQuestion]);
  const continueWithoutCamera = useCallback(() => { ++startupCameraRequest.current; media.disableCamera(); updateStartup({ type: 'camera', status: 'skipped' }); }, [media, updateStartup]);
  const cancelPreparation = useCallback(() => { retireRun(); media.stop(); duration.current.resetSession(); dispatch({ type: 'reset' }); updateStartup({ type: 'open' }); }, [dispatch, media, retireRun, updateStartup]);
  const interruptStartup = useCallback(() => {
    if (hadBegun.current || closingPlayback.current || !isPreQuestionStartupPhase(stateRef.current.phase)) return;
    startupCountdown.current.cancel(); playbackGate.current.pause(); media.capture(false); media.audio.current?.pause();
    updateStartup({ type: 'blocked', message: '전체화면으로 돌아온 뒤 면접 시작을 다시 눌러 주세요.' }); dispatch({ type: 'phase', phase: 'device_check' });
  }, [dispatch, media, updateStartup]);
  const startFullscreen = useCallback((element: HTMLElement | null) => {
    if (stateRef.current.phase !== 'device_check' || !mayStartInterview(startupRef.current, { microphoneLive: mediaRef.current.micEnabled, cameraLive: mediaRef.current.cameraEnabled })) return;
    const epoch = generation.current;
    const requestToken = fullscreenRequests.current.begin();
    startupTarget.current = element;
    // This native request executes in this button handler, before permission or asynchronous waits.
    const fullscreen = requestConfirmedFullscreen(element, document);
    const unlocked = media.unlock(); updateStartup({ type: 'fullscreen_request' });
    void Promise.all([fullscreen, unlocked]).then(() => {
      if (!fullscreenRequests.current.isCurrent(requestToken)) return;
      if (epoch !== generation.current || stateRef.current.phase !== 'device_check') { if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {}); return; }
      const valid = () => fullscreenRequests.current.isCurrent(requestToken) && epoch === generation.current && document.fullscreenElement === element && !document.hidden && mediaRef.current.micEnabled && (startupRef.current.camera === 'skipped' || mediaRef.current.cameraEnabled);
      warmFirstQuestion();
      startupCountdown.current.start({ valid, tick: value => { updateStartup({ type: 'countdown', value }); dispatch({ type: 'phase', phase: 'countdown' }); }, ready: () => { updateStartup({ type: 'launch' }); dispatch({ type: 'phase', phase: 'preparing' }); void actions.current.start(); }, interrupted: () => { if (epoch === generation.current && fullscreenRequests.current.isCurrent(requestToken)) { updateStartup({ type: 'blocked', message: '장치와 전체화면 상태를 확인한 뒤 다시 시작해 주세요.' }); dispatch({ type: 'phase', phase: 'device_check' }); } } });
    }).catch(error => { if (!fullscreenRequests.current.isCurrent(requestToken)) return; if (document.fullscreenElement === element) void document.exitFullscreen().catch(() => {}); if (epoch === generation.current) { updateStartup({ type: 'blocked', message: startupFailureMessage(error) }); dispatch({ type: 'phase', phase: 'device_check' }); } });
  }, [dispatch, media, updateStartup, warmFirstQuestion]);
  const refreshPreparation = useCallback(async () => {
    const request = ++preparationRequest.current;
    try {
      const result = await api<PreparationStatus>('/api/status');
      if (request !== preparationRequest.current) return;
      const seconds = preparationDurationSeconds(result);
      if (seconds !== null) duration.current.updatePreparation(seconds);
      setPreparation({ ...result, ready: result.ready && seconds !== null }); setPreparationError('');
    }
    catch (error) { if (request === preparationRequest.current) setPreparationError(serviceDisplayMessage(error)); }
  }, []);
  const invalidatePreparation = useCallback(() => { ++preparationRequest.current; }, []);
  useEffect(() => { void refreshPreparation(); return invalidatePreparation; }, [invalidatePreparation, refreshPreparation]);
  useEffect(() => {
    if (['idle', 'device_check', 'countdown'].includes(state.phase)) warmFirstQuestion();
  }, [state.phase, warmFirstQuestion]);
  const cancelWarmup = useCallback(() => { firstQuestionPreparation.current.cancel(); }, []);
  useEffect(() => cancelWarmup, [cancelWarmup]);
  const message = useCallback((id: string, role: ConversationMessage['role'], kind: ConversationMessage['kind'], text: string, pending = false) => { dispatch({ type: 'message', message: { id, role, kind, text, pending, time: Date.now() } }); }, [dispatch]);
  const send = useCallback((data: unknown) => { if (socket.current?.readyState !== WebSocket.OPEN) throw new Error('음성 연결이 끊겼습니다. 이어하기를 눌러 주세요.'); socket.current.send(JSON.stringify(data)); }, []);
  const connect = useCallback(async (sessionId: string, port: number, epoch: number) => {
    if (epoch !== generation.current || sessionId !== stateRef.current.sessionId) return;
    const identity = `${sessionId}:${epoch}`;
    if (socket.current?.readyState === WebSocket.OPEN && socketIdentity.current === identity) return;
    if (socket.current) { socket.current.onclose = null; socket.current.close(); }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${port}/api/realtime?sessionId=${encodeURIComponent(sessionId)}`);
    socket.current = ws; socketIdentity.current = identity; ws.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { ws.close(); reject(new Error('음성 연결 시간이 초과되었습니다. 다시 시도해 주세요.')); }, 10000);
      ws.onopen = () => { clearTimeout(timeout); resolve(); };
      ws.onerror = () => { clearTimeout(timeout); reject(new Error('음성 서버에 연결할 수 없습니다. 서버 실행 상태를 확인해 주세요.')); };
    });
    if (epoch !== generation.current || sessionId !== stateRef.current.sessionId) { ws.onopen = null; ws.onerror = null; ws.onclose = null; ws.close(); return; }
    ws.onmessage = ({ data }) => {
      if (epoch !== generation.current || typeof data !== 'string') return;
      let event; try { event = JSON.parse(data); } catch { return; }
      if (!matchesSessionScope(event, { sessionId: stateRef.current.sessionId, turnId: turn.current?.id, answerId: answerId.current, epoch: generation.current }, epoch)) return;
      if (event.type === 'started') answerCapture.current.bindStream(event);
      if (event.type === 'paused' && answerCapture.current.acceptsTranscript(event)) { if (typeof event.rawTranscript === 'string') transcript.current = event.rawTranscript; pauseResolve.current?.(); pauseResolve.current = null; }
      if (event.type === 'transcript' && answerCapture.current.acceptsTranscript(event)) {
        if (typeof event.rawTranscript === 'string') transcript.current = event.rawTranscript;
        if (submitted.current) message(answerId.current, 'candidate', 'answer', transcript.current, true);
      }
      if (event.type === 'finalized' && answerCapture.current.finalize(event)) {
        if (typeof event.rawTranscript === 'string') transcript.current = event.rawTranscript;
        if (submitted.current) message(answerId.current, 'candidate', 'answer', transcript.current, true);
        finalized.current?.resolve(transcript.current); finalized.current = null; pendingFinish.current = null;
      }
      if (event.type === 'error') {
        if (event.captureRevision !== undefined && !answerCapture.current.acceptsTranscript(event)) return;
        if (typeof event.rawTranscript === 'string' && answerCapture.current.acceptsTranscript(event)) transcript.current = event.rawTranscript;
        const error = new NextTurnResponseError(serviceDisplayMessage(event.message, event.code === 'SAVE_ERROR' ? 'storage' : 'speech'), event.code);
        if (typeof event.code === 'string' && event.code.startsWith('TURN_WORK_')) questionRecoveryRequiresEnd.current = true;
        finalized.current?.reject(error); finalized.current = null;
        if (stateRef.current.phase !== 'suspended') { playbackGate.current.pause(); pcmAllowed.current = false; media.capture(false); media.audio.current?.pause(); resumePhase.current = stateRef.current.phase; dispatch({ type: 'error', message: error.message }); }
      }
    };
    ws.onclose = () => { if (epoch === generation.current && activePhases.has(stateRef.current.phase)) pauseRef.current(); };
  }, [dispatch, media, message]);

  const beginListening = useCallback((continuation = false) => {
    if (!turn.current || !canStartListeningAfterAudio(stateRef.current.phase, playbackGate.current.paused)) return;
    if (!continuation && listeningTurn.current === turn.current.id) return;
    if (socket.current?.readyState !== WebSocket.OPEN) throw new Error('음성 연결이 끊겼습니다. 이어하기를 눌러 주세요.');
    if (!continuation) { answerId.current = crypto.randomUUID(); transcript.current = ''; submitted.current = false; resetSpeechRef.current(); timingLedger.current.mark(turn.current.id, 'playback', 'listeningStarted', performance.now()); listeningTurn.current = turn.current.id; answerCapture.current.begin(turn.current.id, answerId.current); }
    else if (!answerCapture.current.continueAnswer()) return;
    const capture = answerCapture.current.snapshot(); if (!capture) return;
    submissionWait.current?.complete(); submissionWait.current = null;
    candidateOperation.current = null; pendingFinish.current = null;
    submitting.current = false; submitted.current = false; answerFinalized.current = false;
    send({ type: 'start', turnId: turn.current.id, answerId: answerId.current, captureRevision: capture.captureRevision });
    dispatch({ type: 'phase', phase: 'listening' }); pcmAllowed.current = true; media.capture(true);
  }, [dispatch, media, send]);
  const playAudio = useCallback((url: string, onPlaying: () => void, epoch: number) => {
    if (epoch !== generation.current || stateRef.current.phase === 'ending' || stateRef.current.phase === 'completed') return Promise.resolve();
    const audio = media.audio.current; if (!audio) return Promise.reject(new Error('음성 재생을 준비하지 못했습니다.'));
    pendingAudioCancel.current?.();
    return playNativeInterviewAudio({
      audio, url, onPlaying,
      current: () => epoch === generation.current && !['ending', 'completed'].includes(stateRef.current.phase),
      action: () => closingPlayback.current ? 'play' : startupPlaybackAction({ phase: stateRef.current.phase, fullscreenElement: document.fullscreenElement, startupTarget: startupTarget.current, hidden: document.hidden, hadBegun: hadBegun.current, paused: playbackGate.current.paused }),
      onBlocked: () => { playbackGate.current.pause(); interruptStartup(); },
      onEnded: () => observeClientEvent({ type: 'audio_ended', turnId: playbackTurn.current ?? undefined, phase: stateRef.current.phase, payload: { role: closingPlayback.current ? 'closing' : playbackRole.current === 'speaking_acknowledgement' ? 'acknowledgement' : 'question' } }, epoch),
      registerCancel: cancel => { pendingAudioCancel.current = cancel; },
      unregisterCancel: cancel => {
        // The native player unregisters on ended, cancellation and failure. Only
        // the owner of this playback may clear the identity of the shared audio.
        if (pendingAudioCancel.current === cancel) { pendingAudioCancel.current = null; dispatch({ type: 'speech_cleared' }); }
      },
    });
  }, [dispatch, interruptStartup, media, observeClientEvent]);
  const playClosing = useCallback(async (closing: ClosingUtterance, epoch: number) => {
    if (closingPlayed.current === closing.id || epoch !== generation.current) return;
    closingPlayback.current = true; recoveryClosing.current = closing;
    pcmAllowed.current = false; media.capture(false); hadBegun.current = false;
    dispatch({ type: 'phase', phase: 'suspended' }); dispatch({ type: 'phase', phase: 'speaking_acknowledgement' });
    playbackTurn.current = closing.id; playbackRole.current = 'speaking_acknowledgement';
    try {
      await playAudio(closing.audioUrl, () => { dispatch({ type: 'speech_started', turnId: closing.id, speakerId: closing.interviewerId }); observeClientEvent({ type: 'acknowledgement_playing', turnId: closing.id, phase: 'closing', payload: { role: 'closing' } }, epoch); message(`${closing.id}:closing`, 'interviewer', 'acknowledgement', closing.text); }, epoch);
      if (epoch === generation.current) closingPlayed.current = closing.id;
    } finally { closingPlayback.current = false; }
  }, [dispatch, media, message, observeClientEvent, playAudio]);
  const writeTransitionTimings = useCallback((sessionId: string, sourceTurnId: string) => {
    const clientTimings = timingLedger.current.transition(sourceTurnId);
    const write = api<void>(`/api/sessions/${encodeURIComponent(sessionId)}/timings`, { turnId: sourceTurnId, clientTimings }, AbortSignal.timeout(10_000));
    pendingTimingWrites.current.set(write, sessionId);
    void write.catch(() => {}).finally(() => pendingTimingWrites.current.delete(write));
  }, []);
  const getAudioSequencer = useCallback((epoch: number) => {
    if (audioSequencer.current?.epoch === epoch) return audioSequencer.current.player;
    const player = new ProgressiveInterviewAudio({
      prepare: url => audioPreloader.current.prepare(url),
      wait: () => playbackGate.current.wait(),
      current: () => epoch === generation.current && !submissionWait.current?.signal.aborted && !stateRef.current.endingRequested && stateRef.current.phase !== 'ending' && stateRef.current.phase !== 'completed',
      play: (url, onPlaying) => playAudio(url, onPlaying, epoch),
      acknowledgementPlaying: event => {
        playbackRole.current = 'speaking_acknowledgement'; playbackTurn.current = event.turnId;
        observeClientEvent({ type: 'acknowledgement_playing', turnId: event.turnId, phase: 'speaking_acknowledgement' }, epoch);
        dispatch({ type: 'phase', phase: 'speaking_acknowledgement' }); dispatch({ type: 'speech_started', turnId: event.turnId, speakerId: event.interviewerId }); message(`${event.turnId}:ack`, 'interviewer', 'acknowledgement', event.acknowledgement);
        const now = performance.now(); timingLedger.current.mark(event.turnId, 'playback', 'acknowledgementStarted', now);
        const source = timingLedger.current.sourceFor(event.turnId); if (source) timingLedger.current.mark(source, 'transition', 'acknowledgementStarted', now);
      },
      acknowledgementEnded: event => {
        const now = performance.now(); timingLedger.current.mark(event.turnId, 'playback', 'acknowledgementEnded', now);
        const source = timingLedger.current.sourceFor(event.turnId); if (source) timingLedger.current.mark(source, 'transition', 'acknowledgementEnded', now);
        playbackRole.current = null;
        if (stateRef.current.phase === 'speaking_acknowledgement') dispatch({ type: 'phase', phase: phaseAfterAcknowledgement(hadBegun.current) });
      },
      questionPlaying: next => {
        submissionWait.current?.complete();
        turn.current = next; playbackRole.current = 'speaking_question'; playbackTurn.current = next.id;
        observeClientEvent({ type: 'question_playing', turnId: next.id, phase: 'speaking_question' }, epoch);
        hadBegun.current = true; if (activeStarted.current === null) activeStarted.current = performance.now();
        dispatch({ type: 'phase', phase: 'speaking_question' }); dispatch({ type: 'speech_started', turnId: next.id, speakerId: next.interviewerId }); dispatch({ type: 'reveal', turn: next }); message(`${next.id}:question`, 'interviewer', 'question', next.questionText);
        const now = performance.now(); timingLedger.current.mark(next.id, 'playback', 'questionStarted', now);
        const source = timingLedger.current.sourceFor(next.id);
        if (source) { timingLedger.current.mark(source, 'transition', 'questionStarted', now); const id = stateRef.current.sessionId; if (id) writeTransitionTimings(id, source); }
      },
    });
    audioSequencer.current = { epoch, player }; return player;
  }, [dispatch, message, observeClientEvent, playAudio, writeTransitionTimings]);
  const playTurn = useCallback(async (next: PreparedTurn, epoch: number) => {
    if (epoch !== generation.current || stateRef.current.endingRequested || stateRef.current.phase === 'ending' || stateRef.current.phase === 'completed') return;
    if (stateRef.current.phase === 'error') dispatch({ type: 'phase', phase: 'preparing_next' });
    pendingTurn.current = next; media.capture(false);
    await getAudioSequencer(epoch).playTurn(next);
    if (epoch !== generation.current) return;
    playbackRole.current = null; timingLedger.current.mark(next.id, 'playback', 'questionEnded', performance.now());
    if (!canStartListeningAfterAudio(stateRef.current.phase, playbackGate.current.paused)) return;
    pendingTurn.current = null;
    if (recoveringAnswerTurn.current === next.id) {
      recoveringAnswerTurn.current = null;
      if (answerFinalized.current) { dispatch({ type: 'phase', phase: 'preparing_next' }); await actions.current.next(epoch); }
      else if (candidateOperation.current) { dispatch({ type: 'phase', phase: 'finalizing_transcript' }); await actions.current.candidate(epoch); }
      else beginListening(true);
    } else beginListening();
  }, [beginListening, dispatch, getAudioSequencer, media]);
  const fail = useCallback((error: unknown, retry?: () => void) => {
    if (error instanceof NextTurnResponseError && ['TURN_WORK_TIMEOUT', 'TURN_WORK_CANCELLED', 'TURN_WORK_RETIRED'].includes(error.code ?? '')) { questionRecoveryRequiresEnd.current = true; retry = undefined; }
    playbackGate.current.pause(); media.capture(false); media.audio.current?.pause(); retryAction.current = retry ?? null;
    dispatch({ type: 'error', message: serviceDisplayMessage(error) });
  }, [dispatch, media]);
  const resumePlayback = useCallback(async (epoch: number) => {
    if (epoch !== generation.current) return;
    playbackGate.current.resume();
    const audio = media.audio.current;
    if (pendingAudioCancel.current && audio?.paused && !audio.ended) { if (playbackRole.current) dispatch({ type: 'phase', phase: playbackRole.current }); await audio.play(); }
  }, [dispatch, media]);

  const start = useCallback(async (): Promise<void> => {
    const preparedDuration = preparationDurationSeconds(preparation);
    if (!preparation?.ready || preparedDuration === null || stateRef.current.phase !== 'preparing') return;
    const epoch = generation.current;
    try {
      if (firstLaunch.current) { await resumePlayback(epoch); return; }
      firstLaunch.current = true; playbackGate.current.resume();
      if (stateRef.current.sessionId && pendingTurn.current) { const pending = pendingTurn.current; getAudioSequencer(epoch).retry(pending.id); await connect(stateRef.current.sessionId, preparation.realtimePort, epoch); if (epoch === generation.current) await playTurn(pending, epoch); return; }
      duration.current.resetSession(); duration.current.updatePreparation(preparedDuration); duration.current.beginSession();
      const preparationId = preparationKey ? firstQuestionPreparation.current.readyId(preparationKey) : undefined;
      const result = await api<{ sessionId: string; turn: PreparedTurn; durationSeconds: number }>('/api/sessions', preparationId ? { preparationId } : {});
      if (epoch !== generation.current) return;
      firstQuestionPreparation.current.cancel();
      pendingTurn.current = result.turn; dispatch({ type: 'session', sessionId: result.sessionId }); duration.current.confirmSession(result.durationSeconds);
      void getAudioSequencer(epoch).prepareTurn(result.turn).catch(() => {});
      await connect(result.sessionId, preparation.realtimePort, epoch);
      if (epoch !== generation.current) return;
      await playTurn(result.turn, epoch);
    } catch (error) { if (epoch === generation.current && !stateRef.current.endingRequested) { firstLaunch.current = false; if (!hadBegun.current) { firstQuestionPreparation.current.cancel(); playbackGate.current.pause(); updateStartup({ type: 'blocked', message: startupFailureMessage(error) }); dispatch({ type: 'phase', phase: 'device_check' }); } else fail(error, () => { if (pendingTurn.current) { getAudioSequencer(epoch).retry(pendingTurn.current.id); void playTurn(pendingTurn.current, epoch).catch(e => { if (epoch === generation.current) fail(e); }); } }); } }
  }, [connect, dispatch, fail, getAudioSequencer, playTurn, preparation, preparationKey, resumePlayback, updateStartup]);

  const nextQuestion = useCallback(async function requestNext(epoch: number, preparationRecoveryAttempt = 0): Promise<void> {
    if (epoch !== generation.current || stateRef.current.endingRequested || stateRef.current.phase === 'ending' || stateRef.current.phase === 'completed') return;
    const current = turn.current, sessionId = stateRef.current.sessionId; if (!current || !sessionId) return;
    if (stateRef.current.phase !== 'speaking_acknowledgement') dispatch({ type: 'phase', phase: 'preparing_next' });
    try {
      if (finishAfterAnswer.current || duration.current.hasExpired(elapsed())) { await endRef.current(); return; }
      let operation = nextOperation.current;
      if (!operation || operation.epoch !== epoch || operation.sourceTurnId !== current.id) {
        operation = new NextTurnOperation(epoch, current.id, sessionId); nextOperation.current = operation;
      }
      const active = operation;
      const result = await active.load(() => {
        const observation = answerObservations.current.get(current.id);
        const capture = answerCapture.current.snapshot();
        return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/next`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ turnId: current.id, answerId: answerId.current, ...(capture?.candidateId ? { candidateId: capture.candidateId, captureRevision: capture.captureRevision } : {}), metrics: observation ? { speech: observation.speech, habits: observation.habits } : {}, elapsedMs: elapsed(), clientTimings: timingLedger.current.answer(current.id), clientEvents: clientEvents.current.outstandingPlayback(sessionId), ...(submissionWait.current ? { submissionAttemptId: submissionWait.current.attemptId } : {}) }), signal: submissionWait.current ? AbortSignal.any([active.controller.signal, submissionWait.current.signal]) : active.controller.signal })
          .then(response => readNextTurnResponse(response, (event: AcknowledgementReady) => {
            if (epoch !== generation.current || stateRef.current.endingRequested || submissionWait.current?.signal.aborted) return;
            active.acknowledge(event.turnId); timingLedger.current.link(current.id, event.turnId);
            timingLedger.current.mark(current.id, 'transition', 'acknowledgementReady', performance.now());
            void getAudioSequencer(epoch).acknowledge(event).catch(error => { if (nextOperation.current === active && epoch === generation.current && !stateRef.current.endingRequested && stateRef.current.phase !== 'suspended') fail(error, () => { getAudioSequencer(epoch).retry(event.turnId); void actions.current.next(epoch); }); });
          })).then(result => {
            clientEvents.current.acknowledge(sessionId, result.acceptedClientEventIds ?? []);
            active.complete(result);
            if (epoch === generation.current && result.turn) { timingLedger.current.link(current.id, result.turn.id); void getAudioSequencer(epoch).prepareTurn(result.turn).catch(() => {}); }
            return result;
          });
      });
      if (epoch !== generation.current || stateRef.current.endingRequested) return;
      submissionWait.current?.assertLive();
      if (stateRef.current.phase === 'suspended' || stateRef.current.phase === 'error') { pendingTurn.current = result.turn; return; }
      if (!active.startPlayback()) return;
      nextCommitted.current = current.id;
      if (result.done || !result.turn) { if (result.closingUtterance) recoveryClosing.current = result.closingUtterance; await endRef.current(); return; }
      await playTurn(result.turn, epoch);
    } catch (error) {
      if (epoch !== generation.current || stateRef.current.endingRequested) return;
      const operation = nextOperation.current;
      if (error instanceof NextTurnResponseError && ['QUESTION_ACTION_BUDGET_EXHAUSTED', 'QUESTION_REPAIR_PROOF_INVALID', 'QUESTION_REPAIR_RECOVERY_UNAVAILABLE'].includes(error.code ?? '')) {
        // The server durably retired an uncommitted preparation. Keep this answer/candidate,
        // but retire its reserved playback identity before one bounded replan.
        nextOperation.current = null;
        operation?.controller.abort();
        if (playbackTurn.current === operation?.acknowledgementTurnId) { pendingAudioCancel.current?.(); playbackRole.current = null; }
        if (error.code === 'QUESTION_REPAIR_RECOVERY_UNAVAILABLE') { questionRecoveryRequiresEnd.current = true; fail(error); return; }
        if (preparationRecoveryAttempt === 0 && stateRef.current.phase !== 'suspended') { await requestNext(epoch, 1); return; }
      }
      operation?.retryPlayback();
      fail(error, () => { const pending = pendingTurn.current; const next = pending?.id ?? nextOperation.current?.acknowledgementTurnId; if (next) getAudioSequencer(epoch).retry(next); if (pending) void playTurn(pending, epoch).catch(e => { if (epoch === generation.current) fail(e); }); else void actions.current.next(epoch); });
    }
  }, [dispatch, elapsed, fail, getAudioSequencer, playTurn]);
  const reviewCandidate = useCallback(async (epoch: number): Promise<void> => {
    const operation = candidateOperation.current, sessionId = stateRef.current.sessionId;
    if (!operation || !sessionId || epoch !== generation.current) return;
    const observation = answerObservations.current.get(operation.scope.turnId);
    try {
      if (!operation.promise) operation.promise = api<AnswerCandidateResult>(`/api/sessions/${encodeURIComponent(sessionId)}/answer-candidate`, { ...operation.scope, elapsedMs: elapsed(), metrics: observation ? { speech: observation.speech, habits: observation.habits } : {}, endingObservation: operation.endingObservation, clientTimings: timingLedger.current.answer(operation.scope.turnId), clientEvents: clientEvents.current.outstandingPlayback(sessionId), ...(submissionWait.current ? { submissionAttemptId: submissionWait.current.attemptId } : {}) }, submissionWait.current?.signal).catch(error => { operation.promise = undefined; throw error; });
      const result = operation.result ?? await operation.promise;
      submissionWait.current?.assertLive();
      if (epoch !== generation.current || candidateOperation.current !== operation || !answerCapture.current.matches(operation.scope)) return;
      if (!['CONTINUE_ANSWER', 'ADVANCE'].includes(result.action) || !result.candidateId || result.captureRevision !== operation.scope.captureRevision || result.rawTranscript !== transcript.current) throw new Error('현재 답변의 확인 결과를 다시 확인해 주세요.');
      clientEvents.current.acknowledge(sessionId, readClientEventReceipt(result.acceptedClientEventIds) ?? []);
      operation.result = result;
      if (finishAfterAnswer.current) {
        answerFinalized.current = true; message(answerId.current, 'candidate', 'answer', transcript.current);
        await endRef.current(); return;
      }
      if (result.action === 'CONTINUE_ANSWER') {
        submitting.current = false; answerFinalized.current = false;
        message(answerId.current, 'candidate', 'answer', transcript.current, true);
        if (stateRef.current.phase === 'suspended') { resumePhase.current = 'listening'; return; }
        beginListening(true); return;
      }
      const capture = answerCapture.current.snapshot();
      if (capture?.stage === 'stt_final') answerCapture.current.stageCandidate(operation.scope, result.candidateId);
      if (answerCapture.current.snapshot()?.stage === 'candidate') answerCapture.current.lockAdvance();
      answerFinalized.current = true;
      message(answerId.current, 'candidate', 'answer', transcript.current);
      if (stateRef.current.phase === 'suspended') { resumePhase.current = 'preparing_next'; return; }
      await nextQuestion(epoch);
    } catch (error) { if (epoch === generation.current && candidateOperation.current === operation) fail(error, () => { void actions.current.candidate(epoch); }); }
  }, [beginListening, elapsed, fail, message, nextQuestion]);
  const submit = useCallback(async (stopSource: AnswerStopSource = 'button') => {
    if (stateRef.current.phase !== 'listening' || submitting.current || !turn.current) return;
    const capture = answerCapture.current.requestEnd(); if (!capture) return;
    submitting.current = true; submitted.current = true; const epoch = generation.current;
    const submittedTurnId = turn.current.id, submittedAnswerId = answerId.current;
    const requestedObservation = (metricsRef.current() as { speech?: SpeechObservation }).speech;
    const requestedMicrophoneEnabled = mediaRef.current.micEnabled;
    timingLedger.current.mark(submittedTurnId, 'answer', 'submittedAt', performance.now(), true);
    submissionWait.current?.cancel();
    const wait = new SubmissionWait(capture, crypto.randomUUID(), preparation?.turnWaitTimeoutMs ?? 95_000, () => {
      if (epoch !== generation.current || stateRef.current.endingRequested || submissionWait.current !== wait) return;
      const error = new NextTurnResponseError(TURN_WAIT_TIMEOUT_MESSAGE, 'TURN_WORK_TIMEOUT');
      timingLedger.current.mark(submittedTurnId, 'answer', 'waitTimedOutAt', performance.now());
      questionRecoveryRequiresEnd.current = true; pcmAllowed.current = false;
      if (wait.finishSent) { try { send({ type: 'cancel_submission', ...capture, submissionAttemptId: wait.attemptId }); } catch { /* The server deadline remains authoritative while disconnected. */ } }
      nextOperation.current?.controller.abort(error); pendingAudioCancel.current?.(); audioPreloader.current.dispose();
      finalized.current?.reject(error); finalized.current = null; fail(error);
    });
    submissionWait.current = wait;
    setCapturingTail(stopSource === 'space');
    dispatch({ type: 'phase', phase: 'finalizing_transcript' });
    message(answerId.current, 'candidate', 'answer', transcript.current, true);
    try {
      const drainStartedAt = performance.now();
      while (epoch === generation.current && String(stateRef.current.phase) !== 'suspended' && shouldDrainAnswerTail(stopSource, (metricsRef.current() as { speech?: SpeechObservation }).speech, performance.now() - drainStartedAt)) await new Promise<void>(resolve => setTimeout(resolve, 40));
      if (epoch !== generation.current) return;
      const tailDrainMs = performance.now() - drainStartedAt;
      if (!stateRef.current.endingRequested && answerCaptureTailAction(stopSource, (metricsRef.current() as { speech?: SpeechObservation }).speech, tailDrainMs) === 'continue_capture' && answerCapture.current.cancelEnd(capture)) {
        // No provider finish or semantic request has started. Keep this exact
        // stream, revision, PCM route, transcript and speech clock running.
        wait.complete(); submissionWait.current = null;
        submitting.current = false; submitted.current = false; setCapturingTail(false);
        dispatch({ type: 'phase', phase: 'listening' }); return;
      }
      wait.assertLive();
      await media.flush(); if (epoch !== generation.current) return;
      wait.assertLive();
      pcmAllowed.current = false; media.capture(false); setCapturingTail(false);
      const speech = (metricsRef.current() as { speech?: SpeechObservation }).speech ?? { durationMs: 0, speakingMs: null, firstSpeechMs: null };
      submittedSpeech.current.set(submittedTurnId, { ...speech });
      const final = new Promise<string>((resolve, reject) => { finalized.current = { resolve, reject }; });
      const timeout = setTimeout(() => { finalized.current?.reject(new Error('마지막 음성을 확인하는 데 시간이 걸리고 있습니다. 음성 연결을 확인하고 다시 답변해 주세요.')); finalized.current = null; }, 20000);
      try { pendingFinish.current = { type: 'finish', turnId: submittedTurnId, answerId: submittedAnswerId, captureRevision: capture.captureRevision, staged: !finishAfterAnswer.current, submissionAttemptId: wait.attemptId }; wait.finishSent = true; send(pendingFinish.current); }
      catch (error) { finalized.current?.reject(error instanceof Error ? error : new Error('음성 연결을 확인해 주세요.')); finalized.current = null; }
      const text = await final.finally(() => clearTimeout(timeout));
      wait.assertLive();
      if (epoch !== generation.current) return;
      timingLedger.current.mark(submittedTurnId, 'answer', 'finalizedAt', performance.now(), true);
      answerObservations.current.set(submittedTurnId, { turnId: submittedTurnId, answerId: submittedAnswerId, speech: { ...speech, ...calculateSpeechMetrics({ ...speech, rawTranscript: text }) }, habits: observeSpeechHabits(submittedAnswerId, text, speech.durationMs) });
      const action = finalizedAnswerAction(text, finishAfterAnswer.current);
      if (action === 'end') { answerFinalized.current = true; message(answerId.current, 'candidate', 'answer', text); await endRef.current(); return; }
      candidateOperation.current = { scope: { turnId: submittedTurnId, answerId: submittedAnswerId, captureRevision: capture.captureRevision }, endingObservation: { stopSource, lastSpeechMs: speech.lastSpeechMs ?? null, trailingSilenceMs: speech.trailingSilenceMs ?? null, speechActiveAtEnd: requestedObservation?.speechActiveAtEnd ?? null, vadAvailable: speech.vadAvailable === true && speech.vadCoverageComplete !== false, microphoneEnabled: requestedMicrophoneEnabled, tailDrainMs, ...(requestedObservation ? { requestedAtMs: requestedObservation.durationMs } : {}) } };
      await reviewCandidate(epoch);
    } catch (error) { setCapturingTail(false); if (epoch === generation.current) fail(error, () => { if (stateRef.current.endingRequested) { void actions.current.end(); return; } try { beginListening(true); } catch (e) { fail(e); } }); }
  }, [beginListening, dispatch, fail, media, message, preparation?.turnWaitTimeoutMs, reviewCandidate, send]);

  const pause = useCallback(() => {
    // End registration owns final capture draining. A visibility/fullscreen
    // interruption may discard optional closing audio, never the durable work.
    if (endingWork.current) { endingClosingAbort.current?.abort(); if (closingPlayback.current) pendingAudioCancel.current?.(); return; }
    if (!hadBegun.current && !closingPlayback.current) { interruptStartup(); return; }
    if (!activePhases.has(stateRef.current.phase)) return;
    const epoch = generation.current;
    playbackGate.current.pause(); setCapturingTail(false);
    resumePhase.current = stateRef.current.phase; dispatch({ type: 'phase', phase: 'suspended' });
    media.audio.current?.pause();
    pauseFinished.current = new Promise<void>(resolve => { pauseResolve.current = resolve; setTimeout(() => { if (pauseResolve.current === resolve) { resolve(); pauseResolve.current = null; } }, 5000); });
    void media.flush().then(() => { if (epoch !== generation.current) return; pcmAllowed.current = false; media.capture(false); if (socket.current?.readyState === WebSocket.OPEN && turn.current && resumePhase.current === 'listening') socket.current.send(JSON.stringify({ type: 'pause', turnId: turn.current.id, answerId: answerId.current, captureRevision: answerCapture.current.snapshot()?.captureRevision })); else { pauseResolve.current?.(); pauseResolve.current = null; } });
  }, [dispatch, interruptStartup, media]);
  pauseRef.current = pause;
  const resume = useCallback(async (): Promise<void> => {
    const epoch = generation.current, sessionId = stateRef.current.sessionId; if (!sessionId || !preparation || stateRef.current.phase === 'ending' || stateRef.current.phase === 'completed') return;
    try {
      if (recoveryClosing.current) { await media.unlock(); await endRef.current(); return; }
      if (!mediaRef.current.micEnabled) await media.requestMic();
      await media.unlock(); if (epoch !== generation.current) return;
      await pauseFinished.current; if (epoch !== generation.current) return;
      await connect(sessionId, preparation.realtimePort, epoch); if (epoch !== generation.current) return;
      const previous = resumePhase.current;
      if (previous !== 'listening') dispatch({ type: 'phase', phase: previous === 'finalizing_transcript' ? 'finalizing_transcript' : playbackRole.current ?? 'preparing_next' });
      playbackGate.current.resume();
      if (previous === 'listening') { dispatch({ type: 'phase', phase: 'preparing_next' }); beginListening(true); }
      else if (previous === 'finalizing_transcript') { if (answerFinalized.current) await nextQuestion(epoch); else if (candidateOperation.current) await reviewCandidate(epoch); else { dispatch({ type: 'phase', phase: 'finalizing_transcript' }); if (pendingFinish.current && finalized.current) send(pendingFinish.current); } }
      else if (pendingTurn.current) { const pending = pendingTurn.current; getAudioSequencer(epoch).retry(pending.id); await resumePlayback(epoch); await playTurn(pending, epoch); }
      else if (previous === 'speaking_question' || previous === 'speaking_acknowledgement' || previous === 'preparing_next') { if (!pendingAudioCancel.current) dispatch({ type: 'phase', phase: 'preparing_next' }); await resumePlayback(epoch); await nextQuestion(epoch); }
      else if (retryAction.current) retryAction.current();
    } catch (error) { if (epoch === generation.current) fail(error, () => { void actions.current.resume(); }); }
  }, [beginListening, connect, dispatch, fail, getAudioSequencer, media, nextQuestion, playTurn, preparation, resumePlayback, reviewCandidate, send]);
  const end = useCallback(async (): Promise<void> => {
    const sessionId = stateRef.current.sessionId;
    if (sessionId && pendingEnd.current?.sessionId === sessionId) return pendingEnd.current.promise;
    if (stateRef.current.phase === 'ending' || stateRef.current.phase === 'completed') return;
    dispatch({ type: 'request_end' });
    if (!sessionId) { retireRun(); media.stop(); duration.current.resetSession(); dispatch({ type: 'reset' }); return; }
    finishAfterAnswer.current = true;
    submissionWait.current?.cancel(); submissionWait.current = null;
    nextOperation.current?.controller.abort();
    endingWork.current = true;
    const optionalClosing = new AbortController();
    endingClosingAbort.current = optionalClosing;
    submitting.current = true;
    const epoch = generation.current, endingTurn = turn.current, endingAnswerId = answerId.current;
    const capture = answerCapture.current.snapshot(), endingSocket = socket.current;
    const captureMatches = capture?.turnId === endingTurn?.id && capture?.answerId === endingAnswerId;
    const finishScope = captureMatches && capture.stage !== 'advance_locked' ? { turnId: capture.turnId, answerId: capture.answerId, captureRevision: capture.captureRevision } : null;
    if (finishScope && capture?.stage === 'capturing') answerCapture.current.requestEnd();
    if (finishScope) submitted.current = true;
    // Detach a semantic candidate without waiting for it or changing its raw
    // source. The server end intent rejects its late next-turn result.
    candidateOperation.current = null;
    const initialObserved = structuredClone(metricsRef.current()) as Record<string, unknown>;
    const initialTranscript = transcript.current;
    const initialAnswers = [...answerObservations.current.values()].map(row => structuredClone(row));
    pendingAudioCancel.current?.();
    dispatch({ type: 'phase', phase: 'finalizing_transcript' });
    if (activeStarted.current !== null) { accumulated.current += performance.now() - activeStarted.current; activeStarted.current = null; }
    hadBegun.current = false;
    const endedElapsedMs = elapsed();
    observeClientEvent({ type: 'phase_changed', phase: 'ending', turnId: endingTurn?.id }, epoch);
    const timingBackup = timingLedger.current.transitionSnapshot(), playbackBackup = timingLedger.current.playbackSnapshot();
    void media.unlock().catch(() => {});
    const isCurrent = () => epoch === generation.current && stateRef.current.sessionId === sessionId;
    const operation = (async () => {
      try {
        const accepted = await durableEnds.register(sessionId, async () => {
          // Flush the worklet before sending existing WS finish. PCM and finish
          // share one ordered socket; /end persists intent before waiting for
          // that exact capture barrier and final STT on the server.
          let flushFailed = false, finishSendFailed = false;
          try { await media.flush(); } catch { flushFailed = true; }
          let captureFinishScope: CaptureScope | null = null;
          if (isCurrent()) { pcmAllowed.current = false; media.capture(false); setCapturingTail(false); }
          if (finishScope && endingSocket?.readyState === WebSocket.OPEN) {
            try { endingSocket.send(JSON.stringify({ type: 'finish', ...finishScope, staged: false })); captureFinishScope = finishScope; }
            catch { finishSendFailed = true; }
          } else if (finishScope) finishSendFailed = true;
          const observed = isCurrent() ? structuredClone(metricsRef.current()) as Record<string, unknown> : initialObserved;
          const words = isCurrent() ? transcript.current : initialTranscript;
          const speech = observed.speech as SpeechObservation | undefined;
          const { answers, last } = endingAnswerObservations(initialAnswers, captureMatches && endingTurn && endingAnswerId ? { turnId: endingTurn.id, answerId: endingAnswerId } : null, speech, words);
          return { metrics: { ...observed, ...(last ? { speech: last.speech, habits: last.habits, lastObservedAnswerTurnId: last.turnId } : {}),
            answers, clientTimingsByTurn: timingBackup, questionPlaybackTimingsByTurn: playbackBackup, clientEventsBackup: clientEvents.current.snapshot(sessionId),
            ...(captureFinishScope ? { captureFinishScope } : {}),
            ...(flushFailed || finishSendFailed ? { captureEndTransport: { flushFailed, finishSendFailed } } : {}) }, elapsedMs: endedElapsedMs };
        }, async body => {
          const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/end`, durableEndRequestInit(body));
          const result = await response.json(); if (!response.ok) throw new NextTurnResponseError(serviceDisplayMessage(result.error ?? result.message), typeof result.code === 'string' ? result.code : undefined);
          return result as EndAcceptance;
        });
        if (!isCurrent()) return; // Network acceptance is independent of retired UI.
        answerFinalized.current = true;
        if (captureMatches && endingAnswerId) message(endingAnswerId, 'candidate', 'answer', transcript.current);
        dispatch({ type: 'evaluation', status: accepted.evaluationStatus ?? 'processing' });
        let closingAllowed = true;
        await bestEffortClosing(async () => {
          if (optionalClosing.signal.aborted) return;
          const closing = recoveryClosing.current ?? (await api<{ closingUtterance: ClosingUtterance | null }>(`/api/sessions/${encodeURIComponent(sessionId)}/closing`,
            { reason: duration.current.hasExpired(endedElapsedMs) ? 'time_expired' : 'user_ended', elapsedMs: endedElapsedMs })).closingUtterance;
          if (closingAllowed && !optionalClosing.signal.aborted && isCurrent() && closing) await playClosing(closing, epoch);
        }, () => { closingAllowed = false; if (isCurrent()) pendingAudioCancel.current?.(); }, 10_000, optionalClosing.signal);
        closingAllowed = false;
        if (!isCurrent()) return;
        void clientEvents.current.flush(sessionId);
        retireRun(); media.capture(false); dispatch({ type: 'phase', phase: 'ending' }); media.stop();
        dispatch({ type: 'phase', phase: 'completed' });
      } catch (error) { if (isCurrent()) fail(error, () => { void actions.current.end(); }); }
    })();
    const pending = { sessionId, promise: operation };
    pendingEnd.current = pending;
    try { await operation; }
    finally { if (pendingEnd.current === pending) { pendingEnd.current = null; endingWork.current = false; if (endingClosingAbort.current === optionalClosing) endingClosingAbort.current = null; } }
  }, [dispatch, elapsed, fail, media, message, observeClientEvent, playClosing, retireRun]);
  endRef.current = end;
  actions.current = { start, next: nextQuestion, candidate: reviewCandidate, resume, end };
  const retry = useCallback(() => { if (questionRecoveryRequiresEnd.current) { void actions.current.end(); return; } const epoch = generation.current; if (retryAction.current) { const action = retryAction.current; void resumePlayback(epoch).then(() => { if (epoch === generation.current) action(); }).catch(error => { if (epoch === generation.current) fail(error, action); }); } else if (stateRef.current.sessionId) void resume(); else void start(); }, [fail, resume, resumePlayback, start]);
  const reset = useCallback(() => { retireRun(); media.stop(); duration.current.resetSession(); dispatch({ type: 'reset' }); hadBegun.current = false; accumulated.current = 0; activeStarted.current = null; finishAfterAnswer.current = false; recoveryClosing.current = null; closingPlayed.current = null; closingPlayback.current = false; endingWork.current = false; timingLedger.current.clear(); answerObservations.current.clear(); submittedSpeech.current.clear(); }, [dispatch, media, retireRun]);
  useEffect(() => {
    media.setPcmHandler(buffer => { if (pcmAllowed.current && socket.current?.readyState === WebSocket.OPEN) { if (socket.current.bufferedAmount > 1024 * 1024) { pauseRef.current(); return; } socket.current.send(buffer); } });
  }, [media]);
  useEffect(() => {
    const timer = setInterval(() => { if (hadBegun.current && isInterviewClockPhase(stateRef.current.phase)) { const elapsedMs = elapsed(); dispatch({ type: 'time', elapsedMs }); const now = performance.now(); if (now - lastCheckpointAt.current >= 5000) { lastCheckpointAt.current = now; observeClientEvent({ type: 'phase_changed', phase: stateRef.current.phase, turnId: turn.current?.id, payload: { elapsedMs, checkpoint: true } }, generation.current); } if (duration.current.hasExpired(elapsedMs)) { finishAfterAnswer.current = true; if (stateRef.current.phase !== 'listening' && stateRef.current.phase !== 'finalizing_transcript') void endRef.current(); } } }, 250);
    return () => clearInterval(timer);
  }, [dispatch, elapsed, observeClientEvent]);
  useEffect(() => {
    if (state.phase !== 'completed' || !state.sessionId || state.evaluationStatus === 'completed') return;
    const epoch = generation.current;
    const poll = setInterval(() => { void api<{ evaluationStatus: string }>(`/api/sessions/${encodeURIComponent(state.sessionId!)}`).then(result => { if (epoch === generation.current && stateRef.current.sessionId === state.sessionId) dispatch({ type: 'evaluation', status: result.evaluationStatus }); }).catch(() => {}); }, 1800);
    return () => clearInterval(poll);
  }, [dispatch, state.evaluationStatus, state.phase, state.sessionId]);
  const invalidateSession = useCallback(() => { retireRun(); }, [retireRun]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (activePhases.has(stateRef.current.phase) || stateRef.current.phase === 'suspended') { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => { window.removeEventListener('beforeunload', handler); invalidateSession(); };
  }, [invalidateSession]);
  return { ...state, preparation, preparationError, capturingTail, refreshPreparation, startup, prepareDevices, retryMicrophone, retryCamera, continueWithoutCamera, cancelPreparation, interruptStartup, startFullscreen, start, submit, pause, resume, end, retry, reset, questionRecoveryRequiresEnd: questionRecoveryRequiresEnd.current, durationSeconds: duration.current.seconds, remainingSeconds: duration.current.remainingSeconds(state.elapsedMs), finishAfterAnswer: finishAfterAnswer.current };
}
