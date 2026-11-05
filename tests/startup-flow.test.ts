import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptStartupDeviceResult, browserInterruptionAction, FullscreenRequestGate, initialStartupState, InterviewStartupCountdown, mayBeginFirstQuestion, mayStartInterview, requestConfirmedFullscreen, startupFailureMessage, startupPlaybackAction, startupReducer } from '../lib/interview/startup-flow';
import { InterviewPlaybackGate } from '../lib/interview/audio-preload';
import { initialSessionState, isInterviewClockPhase, sessionReducer } from '../hooks/useInterviewSession';
import { finalizedAnswerAction } from '../lib/interview/session-lifecycle';
import { readNextTurnResponse } from '../lib/interview/next-turn-stream';
import { QuestionCard } from '../components/interview/QuestionCard';
import { renderToStaticMarkup } from 'react-dom/server';

test('permission prompts stay in device check with no running clock, question or paused interview', () => {
  const state = sessionReducer(initialSessionState, { type: 'phase', phase: 'device_check' });
  assert.equal(state.sessionId, null); assert.equal(state.elapsedMs, 0); assert.equal(state.visibleTurn, null);
  for (const phase of ['idle', 'device_check', 'countdown', 'preparing'] as const) assert.equal(isInterviewClockPhase(phase), false);
  assert.equal(browserInterruptionAction('device_check'), 'ignore'); assert.equal(browserInterruptionAction('idle'), 'ignore');
  assert.equal(browserInterruptionAction('countdown'), 'return_to_check'); assert.equal(browserInterruptionAction('preparing'), 'return_to_check');
  assert.equal(browserInterruptionAction('listening'), 'pause'); assert.equal(isInterviewClockPhase('speaking_question'), true);
});

test('real microphone is required and camera denial needs explicit opt-out before fullscreen can start', () => {
  let state = startupReducer(initialStartupState, { type: 'open' });
  assert.equal(mayStartInterview(state, { microphoneLive: true, cameraLive: true }), false);
  state = startupReducer(state, { type: 'microphone', status: 'ready' }); state = startupReducer(state, { type: 'camera', status: 'error', error: 'Permission denied' });
  assert.equal(mayStartInterview(state, { microphoneLive: true, cameraLive: false }), false);
  state = startupReducer(state, { type: 'camera', status: 'skipped' });
  assert.equal(mayStartInterview(state, { microphoneLive: true, cameraLive: false }), true); assert.equal(mayStartInterview(state, { microphoneLive: false, cameraLive: false }), false);
  assert.equal(acceptStartupDeviceResult(1, 1, state.camera), false); assert.equal(acceptStartupDeviceResult(1, 2), false); assert.equal(acceptStartupDeviceResult(2, 2), true);
  assert.equal(acceptStartupDeviceResult(2, 2, 'checking', 1, 2), false, 'An opt-out followed by a new camera request must not accept the previous pending result');
  state = startupReducer(state, { type: 'fullscreen_request' }); assert.equal(mayStartInterview(state, { microphoneLive: true, cameraLive: false }), false);
  state = startupReducer(state, { type: 'blocked', message: 'Fullscreen denied' }); assert.equal(state.countdown, null); assert.equal(state.camera, 'skipped'); assert.equal(mayStartInterview(state, { microphoneLive: true, cameraLive: false }), true);
});

test('first queued native playing cannot reveal a question or start its timer after fullscreen loss or hiding', () => {
  const target = {}, input = { phase: 'preparing', fullscreenElement: target, startupTarget: target, hidden: false };
  assert.equal(mayBeginFirstQuestion(input), true);
  assert.equal(mayBeginFirstQuestion({ ...input, fullscreenElement: null }), false); assert.equal(mayBeginFirstQuestion({ ...input, hidden: true }), false);
  for (const phase of ['idle', 'device_check', 'countdown', 'suspended', 'completed']) assert.equal(mayBeginFirstQuestion({ ...input, phase }), false);
  assert.equal(mayBeginFirstQuestion({ ...input, fullscreenElement: null, startupTarget: null }), false);
});

test('a delayed native playing event after startup interruption preserves the new countdown and pending first question', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = new InterviewPlaybackGate(), countdown = new InterviewStartupCountdown(), target = {};
  let phase = 'countdown', launches = 0, interruptions = 0, questions = 0;
  // The previous startup was interrupted after audio.play(), before its native playing event arrived.
  gate.pause();
  countdown.start({ valid: () => true, tick: () => {}, ready: () => { phase = 'preparing'; gate.resume(); launches++; }, interrupted: () => { interruptions++; } });
  const playing = () => {
    const action = startupPlaybackAction({ phase, fullscreenElement: target, startupTarget: target, hidden: false, hadBegun: false, paused: gate.paused });
    if (action === 'return_to_check') { countdown.cancel(); phase = 'device_check'; interruptions++; }
    if (action === 'play') questions++;
    return action;
  };
  assert.equal(playing(), 'pause'); assert.equal(phase, 'countdown'); assert.equal(questions, 0);
  context.mock.timers.tick(1000); context.mock.timers.tick(1000); context.mock.timers.tick(1000);
  assert.equal(launches, 1); assert.equal(interruptions, 0); assert.equal(playing(), 'play'); assert.equal(questions, 1);
  assert.equal(startupPlaybackAction({ phase: 'preparing', fullscreenElement: null, startupTarget: target, hidden: false, hadBegun: false, paused: false }), 'return_to_check');
});

test('native fullscreen is requested synchronously in the gesture and success requires the actual fullscreen element', async () => {
  let inGesture = true, requested = false, complete!: () => void;
  const document: { fullscreenEnabled: boolean; fullscreenElement: unknown } = { fullscreenEnabled: true, fullscreenElement: null };
  const target = { requestFullscreen() { assert.equal(inGesture, true); requested = true; return new Promise<void>(resolve => { complete = resolve; }); } };
  const entering = requestConfirmedFullscreen(target, document); assert.equal(requested, true); inGesture = false;
  document.fullscreenElement = target; complete(); await entering;
  await assert.rejects(requestConfirmedFullscreen({ requestFullscreen: async () => {} }, { fullscreenEnabled: true, fullscreenElement: null }), /확인하지 못했습니다/);
  await assert.rejects(requestConfirmedFullscreen({ requestFullscreen: async () => { throw new Error('Denied'); } }, { fullscreenEnabled: true, fullscreenElement: null }));
  await assert.rejects(requestConfirmedFullscreen(null, { fullscreenEnabled: false, fullscreenElement: null }));
});

test('three-second countdown starts once after confirmation and cancellation prevents old timers from launching', context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const countdown = new InterviewStartupCountdown(); const values: number[] = []; let launches = 0, interruptions = 0, valid = true;
  const callbacks = { valid: () => valid, tick: (value: number) => values.push(value), ready: () => { launches++; }, interrupted: () => { interruptions++; } };
  countdown.start(callbacks); assert.deepEqual(values, [3]); context.mock.timers.tick(1000); context.mock.timers.tick(1000); assert.deepEqual(values, [3, 2, 1]); assert.equal(launches, 0);
  countdown.cancel(); context.mock.timers.tick(1000); assert.equal(launches, 0);
  countdown.start(callbacks); context.mock.timers.tick(1000); valid = false; context.mock.timers.tick(1000); assert.equal(interruptions, 1); assert.equal(launches, 0);
  valid = true; countdown.start(callbacks); context.mock.timers.tick(1000); context.mock.timers.tick(1000); context.mock.timers.tick(1000); assert.equal(launches, 1); context.mock.timers.tick(5000); assert.equal(launches, 1);
});

test('production countdown preserves the Window receiver for native scheduling and cancellation', () => {
  let next = 0, cancelled = 0; const queued = new Map<number, () => void>(), ticks: number[] = [];
  const schedule = function (this: typeof globalThis, callback: () => void, delay: number) { assert.equal(this, globalThis, 'Unbound Window.setTimeout throws Illegal invocation'); assert.equal(delay, 1000); queued.set(++next, callback); return next; } as unknown as typeof setTimeout;
  const unschedule = function (this: typeof globalThis, timer: number) { assert.equal(this, globalThis, 'Window.clearTimeout also requires its native receiver'); cancelled++; queued.delete(timer); } as unknown as typeof clearTimeout;
  const countdown = new InterviewStartupCountdown(schedule, unschedule);
  countdown.start({ valid: () => true, tick: value => ticks.push(value), ready: () => { throw new Error('Cancelled countdown must not launch'); }, interrupted: () => {} });
  queued.get(1)!(); assert.deepEqual(ticks, [3, 2]); countdown.cancel(); assert.equal(cancelled, 1); assert.equal(queued.has(2), false);
});

test('unexpected startup exceptions become useful Korean guidance instead of raw native errors', () => {
  const message = startupFailureMessage(new TypeError('Illegal invocation'));
  assert.match(message, /마이크와 전체화면/); assert.doesNotMatch(message, /Illegal invocation|TypeError/);
  assert.equal(startupFailureMessage(new Error('전체화면 전환을 확인하지 못했습니다. 다시 눌러 주세요.')), '전체화면 전환을 확인하지 못했습니다. 다시 눌러 주세요.');
});

test('a stale fullscreen completion cannot exit a newer request on the same shell, while unclaimed cancellation can clean up', async () => {
  const gate = new FullscreenRequestGate(); let resolveOld!: () => void, exits = 0;
  const document: { fullscreenEnabled: boolean; fullscreenElement: unknown } = { fullscreenEnabled: true, fullscreenElement: null };
  const target = { requestFullscreen: () => new Promise<void>(resolve => { resolveOld = resolve; }) };
  const oldToken = gate.begin();
  const oldRequest = requestConfirmedFullscreen(target, document).then(() => { if (gate.isCurrent(oldToken)) { exits++; document.fullscreenElement = null; } });
  const newToken = gate.begin(); document.fullscreenElement = target; await requestConfirmedFullscreen(target, document);
  resolveOld(); await oldRequest;
  assert.equal(exits, 0); assert.equal(document.fullscreenElement, target); assert.equal(gate.isCurrent(newToken), true);
  const cancelledToken = gate.begin();
  // Session epoch cancellation alone does not transfer fullscreen ownership to a newer request.
  await requestConfirmedFullscreen(target, document).then(() => { if (gate.isCurrent(cancelledToken)) { exits++; document.fullscreenElement = null; } });
  assert.equal(exits, 1); assert.equal(document.fullscreenElement, null);
});

test('finalized silence advances without fake transcript and clarification is parsed and shown without a new F count', async () => {
  assert.equal(finalizedAnswerAction('', false), 'next'); assert.equal(finalizedAnswerAction('', true), 'end');
  const turn = { id: 'clarification', questionText: '같은 요구를 다시 확인합니다.', questionKind: 'clarification' as const, parentMainQuestionId: 'q1', mainIndex: 1, mainCount: 4, followUpIndex: 0, evidenceIds: [], questionAudioUrl: '/api/audio/test', acknowledgement: null, acknowledgementAudioUrl: null, interviewerId: 'one' };
  const response = await readNextTurnResponse(Response.json({ turn, done: false }), () => {}); assert.equal(response.turn?.questionKind, 'clarification'); assert.equal(response.turn?.mainIndex, 1);
  const html = renderToStaticMarkup(QuestionCard({ turn, phase: 'speaking_question', preparation: null, loadingError: '', refresh() {} }));
  assert.match(html, /질문 다시 확인/); assert.doesNotMatch(html, /꼬리질문|주질문|followup-tag/);
  for (const phase of ['device_check', 'countdown', 'preparing'] as const) { const state = sessionReducer({ ...initialSessionState, phase }, { type: 'reveal', turn }); assert.equal(state.visibleTurn, null); }
});
