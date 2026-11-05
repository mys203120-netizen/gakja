import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialSessionState, sessionReducer, matchesSessionScope, preparationDurationSeconds, type PreparedTurn, type PreparationStatus } from '../hooks/useInterviewSession';
import { finalizedAnswerAction, retirePlaybackRun } from '../lib/interview/session-lifecycle';
import { QuestionCard } from '../components/interview/QuestionCard';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActiveClock, INITIAL_INTERVIEW_DURATION_SECONDS, InterviewDurationBudget } from '../lib/interview/timing';

const question: PreparedTurn = { id: 'q1', questionText: '실제 질문', questionKind: 'main', parentMainQuestionId: 'q1', mainIndex: 1, mainCount: 4, followUpIndex: 0, evidenceIds: ['source:1'], questionAudioUrl: '/api/audio/opaque', acknowledgement: null, acknowledgementAudioUrl: null, interviewerId: 'one' };
const prepared: PreparationStatus = {
  ready: true, missingKeys: [], errors: [], realtimePort: 3001,
  target: { university: '서울시립대학교', department: '융합응용화학과', track: '학생부종합전형I (면접형)', year: 2027, studentName: '테스트 학생' },
  durationSeconds: 720,
  interviewOverview: { lines: ['제공된 서류 기반 면접 안내', '면접위원 2명 · 약 12분', '제공된 역량 평가 안내'], durationSeconds: 720, trackId: 'test-track', source: { id: 'test-source', title: '시험용 공식 자료', url: 'https://example.test/official.pdf', academicYear: 2027, location: 'p.25', verificationStatus: 'official_2027' } },
};

test('ready banner renders the three API lines and no device/setup readiness copy', () => {
  const html = renderToStaticMarkup(QuestionCard({ turn: null, phase: 'idle', preparation: prepared, loadingError: '', refresh: () => {}, micReady: false, cameraReady: false }));
  for (const line of prepared.interviewOverview!.lines) assert.ok(html.includes(line));
  assert.match(html, /class="interview-overview"/);
  assert.doesNotMatch(html, /readiness-list|마이크|카메라|음성 연결|configuration-note|\.env.local/);
  const other = { ...prepared, durationSeconds: 900, interviewOverview: { ...prepared.interviewOverview!, lines: ['다른 제공 안내 1', '다른 제공 안내 2', '다른 제공 안내 3'] as [string, string, string], durationSeconds: 900 } };
  const changed = renderToStaticMarkup(QuestionCard({ turn: null, phase: 'idle', preparation: other, loadingError: '', refresh: () => {} }));
  for (const line of other.interviewOverview.lines) assert.ok(changed.includes(line));
  assert.doesNotMatch(changed, /약 12분|면접위원 2명/);
});

test('missing overview stays loading instead of inventing school interview facts', () => {
  for (const preparation of [null, { ...prepared, interviewOverview: null }]) {
    const html = renderToStaticMarkup(QuestionCard({ turn: null, phase: 'idle', preparation, loadingError: '', refresh: () => {} }));
    assert.match(html, /면접 개요를 확인하고 있어요/);
    assert.doesNotMatch(html, /면접위원 2명|약 12분|서류 기반 면접 안내|configuration-note/);
  }
});

test('actual configuration/fetch failures retain actionable diagnostics', () => {
  const failure = { ...prepared, ready: false, missingKeys: ['OPENAI_API_KEY'], errors: ['학교 자료를 확인해 주세요.'], interviewOverview: null };
  const html = renderToStaticMarkup(QuestionCard({ turn: null, phase: 'idle', preparation: failure, loadingError: '', refresh: () => {} }));
  assert.match(html, /configuration-note/); assert.match(html, /OPENAI_API_KEY/); assert.match(html, /학교 자료를 확인해 주세요/);
  const unavailable = renderToStaticMarkup(QuestionCard({ turn: null, phase: 'idle', preparation: null, loadingError: '연결을 확인해 주세요.', refresh: () => {} }));
  assert.match(unavailable, /연결을 확인해 주세요/); assert.match(unavailable, /다시 확인/);
});

test('preparation accepts a complete overview and rejects absent or contradictory duration metadata', () => {
  assert.equal(preparationDurationSeconds(prepared), 720);
  assert.equal(preparationDurationSeconds(null), null);
  assert.equal(preparationDurationSeconds({ ...prepared, interviewOverview: null }), null);
  assert.equal(preparationDurationSeconds({ ...prepared, durationSeconds: 600 }), null);
  assert.equal(preparationDurationSeconds({ ...prepared, interviewOverview: { ...prepared.interviewOverview!, durationSeconds: 0 } }), null);
  assert.equal(preparationDurationSeconds({ ...prepared, interviewOverview: { ...prepared.interviewOverview!, lines: ['', '두 번째', '세 번째'] } }), null);
});

test('initial timer shows twelve minutes, then follows the verified preparation duration', () => {
  const timer = new InterviewDurationBudget();
  assert.equal(INITIAL_INTERVIEW_DURATION_SECONDS, 720);
  assert.equal(timer.remainingSeconds(0), 720);
  assert.equal(timer.updatePreparation(900), true);
  assert.equal(timer.remainingSeconds(0), 900);
  for (const invalid of [0, -1, NaN, Infinity, '720', null, 2.5]) assert.equal(timer.updatePreparation(invalid), false);
  assert.equal(timer.seconds, 900);
});

test('session budget freezes through preparation refresh and confirms the server session duration', () => {
  const timer = new InterviewDurationBudget();
  timer.updatePreparation(720); timer.beginSession();
  timer.updatePreparation(900);
  assert.equal(timer.seconds, 720);
  timer.confirmSession(780);
  timer.updatePreparation(600);
  assert.equal(timer.seconds, 780);
  assert.throws(() => timer.confirmSession(720));
  assert.throws(() => timer.confirmSession(undefined));
  timer.resetSession();
  assert.equal(timer.seconds, 600);
  timer.beginSession(); timer.confirmSession(600);
  assert.equal(timer.remainingSeconds(60_000), 540);
});

test('countdown and expiry share the twelve-minute boundary and preserve overrun answer elapsed time', () => {
  const timer = new InterviewDurationBudget(); timer.beginSession(); timer.confirmSession(720);
  assert.equal(timer.hasExpired(600_000), false); assert.equal(timer.remainingSeconds(600_000), 120);
  assert.equal(timer.hasExpired(719_999), false); assert.equal(timer.remainingSeconds(719_999), 1);
  assert.equal(timer.hasExpired(720_000), true); assert.equal(timer.remainingSeconds(720_000), 0);
  const clock = new ActiveClock(); clock.start(0); clock.pause(300_000); clock.start(900_000); clock.pause(1_320_000);
  assert.equal(clock.elapsed(1_320_000), 720_000);
  assert.equal(timer.hasExpired(clock.elapsed(1_320_000)), true);
  clock.start(1_320_000); clock.pause(1_350_000);
  assert.equal(clock.elapsed(1_350_000), 750_000);
  assert.equal(timer.remainingSeconds(clock.elapsed(1_350_000)), 0);
});
test('a prepared question stays hidden until real question playback enters speaking_question', () => {
  let state = sessionReducer(initialSessionState, { type: 'phase', phase: 'preparing' });
  state = sessionReducer(state, { type: 'reveal', turn: question }); assert.equal(state.visibleTurn, null);
  state = sessionReducer(state, { type: 'phase', phase: 'speaking_acknowledgement' });
  state = sessionReducer(state, { type: 'reveal', turn: question }); assert.equal(state.visibleTurn, null);
  state = sessionReducer(state, { type: 'phase', phase: 'speaking_question' });
  state = sessionReducer(state, { type: 'reveal', turn: question }); assert.equal(state.visibleTurn?.id, 'q1');
});
test('final transcript replaces one provisional answer and retains filler words', () => {
  const base = { id: 'answer1', role: 'candidate' as const, kind: 'answer' as const, time: 1 };
  let state = sessionReducer(initialSessionState, { type: 'message', message: { ...base, text: '어, 탐구', pending: true } });
  state = sessionReducer(state, { type: 'message', message: { ...base, text: '어, 탐구 과정에서 음, 확인했습니다.', pending: false } });
  assert.equal(state.messages.length, 1); assert.match(state.messages[0].text, /어,.*음,/); assert.equal(state.messages[0].pending, false);
});
test('suspension preserves revealed question, submitted transcript, and active time', () => {
  let state = sessionReducer(initialSessionState, { type: 'phase', phase: 'speaking_question' });
  state = sessionReducer(state, { type: 'reveal', turn: question });
  state = sessionReducer(state, { type: 'time', elapsedMs: 42000 });
  state = sessionReducer(state, { type: 'phase', phase: 'suspended' });
  assert.equal(state.visibleTurn?.id, 'q1'); assert.equal(state.elapsedMs, 42000);
});
test('restart removes old question and all visible answer content', () => {
  const state = sessionReducer({ ...initialSessionState, visibleTurn: question, sessionId: 'old', phase: 'completed' }, { type: 'reset' });
  assert.equal(state.visibleTurn, null); assert.equal(state.sessionId, null); assert.equal(state.phase, 'idle');
});
test('websocket results after restart, old questions, and other answers cannot update this session', () => {
  const current = { epoch: 3, sessionId: 'new', turnId: 'q2', answerId: 'a2' };
  assert.equal(matchesSessionScope({ sessionId: 'new', turnId: 'q2', answerId: 'a2' }, current, 3), true);
  assert.equal(matchesSessionScope({ sessionId: 'old', turnId: 'q2', answerId: 'a2' }, current, 3), false);
  assert.equal(matchesSessionScope({ sessionId: 'new', turnId: 'q1', answerId: 'a2' }, current, 3), false);
  assert.equal(matchesSessionScope({ sessionId: 'new', turnId: 'q2', answerId: 'a1' }, current, 3), false);
  assert.equal(matchesSessionScope({ sessionId: 'new', turnId: 'q2', answerId: 'a2' }, current, 2), false);
});
test('ending clears the previous question and terminal phases reject late playback state', () => {
  const base = { ...initialSessionState, sessionId: 'saved-session', phase: 'speaking_question' as const, visibleTurn: question, messages: [{ id: 'answer', role: 'candidate' as const, kind: 'answer' as const, text: '어, 확정된 답변입니다.', time: 1 }] };
  const ending = sessionReducer(base, { type: 'phase', phase: 'ending' });
  assert.equal(ending.visibleTurn, null); assert.equal(ending.messages[0].text, '어, 확정된 답변입니다.'); assert.equal(ending.sessionId, 'saved-session');
  assert.equal(sessionReducer(ending, { type: 'reveal', turn: question }), ending);
  assert.equal(sessionReducer(ending, { type: 'phase', phase: 'speaking_question' }), ending);
  const completed = sessionReducer(ending, { type: 'phase', phase: 'completed' });
  assert.equal(completed.visibleTurn, null);
  assert.equal(sessionReducer(completed, { type: 'phase', phase: 'listening' }), completed);
  assert.equal(sessionReducer(completed, { type: 'error', message: 'late audio error' }), completed);
  assert.equal(sessionReducer(completed, { type: 'message', message: { id: 'late', role: 'interviewer', kind: 'question', text: 'late question', time: 2 } }), completed);
  const reset = sessionReducer(completed, { type: 'reset' });
  assert.equal(reset.visibleTurn, null); assert.deepEqual(reset.messages, []);
});
test('question card never renders a retained question in ending or completed states', () => {
  for (const phase of ['ending', 'completed'] as const) assert.equal(QuestionCard({ turn: question, phase, preparation: null, loadingError: '', refresh: () => {}, micReady: false, cameraReady: false }), null);
});
test('confirmed ending hides the question immediately while preserving finalization inputs and conversation', () => {
  const listening = { ...initialSessionState, phase: 'listening' as const, sessionId: 's1', visibleTurn: question };
  const requested = sessionReducer(listening, { type: 'request_end' });
  assert.equal(requested.phase, 'listening'); assert.equal(requested.sessionId, 's1'); assert.equal(requested.visibleTurn, null); assert.equal(requested.endingRequested, true);
  const latePlayback = sessionReducer(requested, { type: 'phase', phase: 'speaking_question' });
  assert.equal(sessionReducer(latePlayback, { type: 'reveal', turn: question }).visibleTurn, null);
  assert.equal(QuestionCard({ turn: question, phase: 'finalizing_transcript', endingRequested: true, preparation: null, loadingError: '', refresh: () => {}, micReady: false, cameraReady: false }), null);
  const finalizing = sessionReducer(requested, { type: 'phase', phase: 'finalizing_transcript' });
  const finalized = sessionReducer(finalizing, { type: 'message', message: { id: 'last-answer', role: 'candidate', kind: 'answer', text: '', pending: false, time: 1 } });
  assert.equal(finalized.messages.length, 1); assert.equal(finalized.messages[0].text, ''); assert.equal(finalized.endingRequested, true);
  assert.equal(sessionReducer(finalized, { type: 'reset' }).endingRequested, false);
});
test('empty finalized speech continues without failure, and explicit finish ends without inventing a transcript', () => {
  for (const text of ['', '  \n ']) { assert.equal(finalizedAnswerAction(text, true), 'end'); assert.equal(finalizedAnswerAction(text, false), 'next'); }
  assert.equal(finalizedAnswerAction('어, 실제 답변입니다.', false), 'next');
  assert.equal(finalizedAnswerAction('어, 실제 답변입니다.', true), 'end');
});
test('retiring the actual playback runtime cancels old voice and prevents stale result acceptance', async () => {
  let audioPaused = false, socketClosed = false, pauseResolved = false, finalizationCancelled = '';
  const socket = { onopen: () => {}, onmessage: () => {}, onerror: () => {}, onclose: () => {}, close() { socketClosed = true; } };
  const ref = <T,>(current: T) => ({ current });
  const refs = {
    generation: ref(8), turn: ref<PreparedTurn | null>(question), pendingTurn: ref<PreparedTurn | null>({ ...question, id: 'q-next' }),
    answerId: ref('a1'), transcript: ref('음, 보존된 답변'), submitted: ref(true), submitting: ref(true), answerFinalized: ref(true),
    nextCommitted: ref<string | null>('q1'), resumePhase: ref('listening'), retryAction: ref<(() => void) | null>(() => { throw new Error('old retry must never run'); }),
    pcmAllowed: ref(true), socketIdentity: ref('session:8'), socket: ref<typeof socket | null>(socket),
    audio: ref<{ pause(): void } | null>({ pause() { audioPaused = true; } }),
    finalized: ref<{ reject(reason: Error): void } | null>({ reject(error) { finalizationCancelled = error.message; } }),
    pauseResolve: ref<(() => void) | null>(() => { pauseResolved = true; }), pauseFinished: ref(new Promise<void>(() => {})),
  };
  const epoch = retirePlaybackRun(refs);
  assert.equal(epoch, 9); assert.equal(refs.turn.current, null); assert.equal(refs.pendingTurn.current, null); assert.equal(refs.retryAction.current, null);
  assert.equal(refs.answerId.current, ''); assert.equal(refs.transcript.current, ''); assert.equal(refs.pcmAllowed.current, false);
  assert.equal(refs.submitted.current, false); assert.equal(refs.submitting.current, false); assert.equal(refs.resumePhase.current, 'idle');
  assert.equal(refs.socket.current, null); assert.equal(refs.socketIdentity.current, '');
  assert.equal(socket.onmessage, null); assert.equal(socket.onclose, null); assert.equal(socketClosed, true); assert.equal(audioPaused, true);
  assert.equal(pauseResolved, true); assert.match(finalizationCancelled, /종료/); await refs.pauseFinished.current;
  assert.equal(matchesSessionScope({ sessionId: 'session', turnId: 'q1', answerId: 'a1' }, { epoch, sessionId: 'session', turnId: undefined, answerId: refs.answerId.current }, 8), false);
});
