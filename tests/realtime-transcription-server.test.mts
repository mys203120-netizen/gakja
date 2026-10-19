import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const studentId = '00000000-0000-4000-8000-000000000001';
const sessionId = '00000000-0000-4000-8000-000000000002';
const attemptId = '00000000-0000-4000-8000-000000000003';
const callId = 'rtc_test_call';
const offer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const input = { sessionId, itemIndex: 0, attemptId, consent: true, sdp: offer };
class FeatureError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_FAILED') { super(message); }
}

function harness() {
  const state = {
    active: true, state: 'active', mode: 'oral', currentIndex: 0, revision: 3,
    logs: [] as any[], fetches: [] as any[], queryCalls: [] as any[], settlements: [] as any[],
    afterFetch: null as null | (() => void), upstreamStatus: 201, upstreamLocation: `/v1/realtime/calls/${callId}`,
    upstreamSdp: offer, upstreamFailure: false, failAccounting: false, dailyLimit: false,
    hangupFailure: false, hangupStatus: 200,
    env: { OPENAI_API_KEY: 'synthetic-key-never-exposed' } as Record<string, string>,
  };
  let reservationLock = Promise.resolve();
  const query = async (sql: string, params: any[]) => {
    state.queryCalls.push({ sql, params });
    if (sql.startsWith('select s.id')) return state.active ? [{ id: sessionId, state: state.state, mode: state.mode, current_index: state.currentIndex, revision: state.revision, total: 1 }] : [];
    if (sql.startsWith('select count(*)')) {
      const rows = state.logs.filter(log => log.studentId === params[0] && log.feature === params[3]);
      return [{ count: rows.length, attempt_count: rows.filter(log => log.contextId === params[1] || log.contextId.startsWith(params[1] + ':')).length, question_cooldown: rows.some(log => log.contextId.startsWith(params[2]) && !log.old) }];
    }
    if (sql.startsWith('update ai_usage_logs')) {
      if (state.failAccounting) throw Error('Accounting unavailable');
      const log = state.logs.find(log => log.id === params[0] && log.studentId === params[1]);
      if (log) { log.contextId = params[2]; log.status = params[3]; }
      return [];
    }
    if (sql.startsWith('select id,status')) return state.logs.filter(log => log.studentId === params[0] && log.feature === params[1] && log.contextId === params[2]);
    throw Error('Unexpected query');
  };
  const ai = {
    FeatureError, aiEnabled: () => Boolean(state.env.OPENAI_API_KEY?.trim()),
    reserveUsage: async (id: string, feature: string, contextId: string, model: string) => {
      if (state.dailyLimit) throw new FeatureError(429, 'Daily quota reached', 'AI_DAILY_LIMIT');
      const usageId = `usage-${state.logs.length}`;
      state.logs.push({ id: usageId, studentId: id, feature, contextId, model, status: 'pending' });
      return usageId;
    },
    completeUsage: async (id: string, status: string) => {
      state.settlements.push({ id, status });
      const log = state.logs.find(log => log.id === id); if (log) log.status = status;
    },
  };
  const fetch = async (url: string, options: any) => {
    state.fetches.push({ url, options });
    if (url.endsWith('/hangup')) {
      if (state.hangupFailure) throw new Error('Secret vendor credential in network error');
      return new Response(null, { status: state.hangupStatus });
    }
    state.afterFetch?.();
    if (state.upstreamFailure) throw Error('Secret vendor token must not leak');
    return new Response(state.upstreamSdp, { status: state.upstreamStatus, headers: state.upstreamLocation ? { location: state.upstreamLocation } : {} });
  };
  const module = { exports: {} as Record<string, any> };
  const source = readFileSync(new URL('../apps/web/src/lib/realtime-transcription.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, process: { env: state.env }, fetch, Response, Request, FormData, TextDecoder, AbortSignal, Uint8Array, Error, URL,
    require(dependency: string) {
      if (dependency === 'server-only') return {};
      if (dependency === './ai') return ai;
      if (dependency === './db') return { query };
      if (dependency === './recording-transcription') return { withRecordingTranscriptionLock: async (_key: string, work: () => Promise<unknown>) => {
        const result = reservationLock.then(work); reservationLock = result.then(() => {}, () => {}); return result;
      } };
      return require(dependency);
    },
  });
  return { state, api: module.exports, ai };
}

test('realtime server negotiates fixed Korean transcription and never returns the API credential', async () => {
  const { state, api } = harness();
  const result = await api.startQuizRealtimeTranscription(studentId, input, new AbortController().signal);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { sdp: offer, callId });
  assert.ok(!JSON.stringify(result).includes(state.env.OPENAI_API_KEY));
  const request = state.fetches[0];
  assert.equal(request.url, 'https://api.openai.com/v1/realtime/calls');
  assert.equal(request.options.body.get('sdp'), offer);
  assert.deepEqual(JSON.parse(request.options.body.get('session')), { type: 'transcription', audio: { input: { transcription: { model: 'gpt-live-transcribe', languages: ['ko'], delay: 'low' }, turn_detection: null } } });
  assert.equal(state.logs[0].status, 'connected');
  assert.equal(state.logs[0].model, 'openai:gpt-live-transcribe');
  assert.equal(state.queryCalls.filter(call => call.sql.startsWith('select s.id')).length, 2);
  assert.ok(state.queryCalls.find(call => call.sql.includes('p.active=true')));
});

test('invalid consent, SDP and cleanup identifiers are rejected before negotiation', () => {
  const { api } = harness();
  assert.equal(api.realtimeTranscriptionInput.safeParse({ ...input, consent: false }).success, false);
  assert.equal(api.realtimeTranscriptionInput.safeParse({ ...input, sdp: 'x'.repeat(60_001) }).success, false);
  assert.equal(api.realtimeTranscriptionInput.safeParse({ ...input, sdp: 'v=0\r\nm=video 9 OTHER' }).success, false);
  assert.equal(api.realtimeTranscriptionCloseInput.safeParse({ ...input, callId: '../other' }).success, false);
});

test('actual streamed byte limit applies without trusting Content-Length', async () => {
  const { api } = harness();
  const request = new Request('http://localhost/api/quiz/realtime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '가'.repeat(24_000) }) });
  await assert.rejects(() => api.readRealtimeTranscriptionBody(request), (error: any) => error.status === 413);
  const invalid = new Request('http://localhost/api/quiz/realtime', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  await assert.rejects(() => api.readRealtimeTranscriptionBody(invalid), (error: any) => error.status === 400);
  const wrongType = new Request('http://localhost/api/quiz/realtime', { method: 'POST', body: JSON.stringify(input) });
  await assert.rejects(() => api.readRealtimeTranscriptionBody(wrongType), (error: any) => error.status === 415);
});

test('missing, paused, old-item and choice sessions never reserve paid usage', async () => {
  for (const change of [{ active: false }, { state: 'paused' }, { state: 'ended' }, { currentIndex: 1 }, { mode: 'choice' }]) {
    const { state, api } = harness(); Object.assign(state, change);
    await assert.rejects(() => api.startQuizRealtimeTranscription(studentId, input, new AbortController().signal), (error: any) => error.status === 404 || error.status === 409);
    assert.equal(state.fetches.length, 0); assert.equal(state.logs.length, 0);
  }
});

test('missing credential and already aborted connection are free', async () => {
  const { state, api } = harness(); delete state.env.OPENAI_API_KEY;
  await assert.rejects(() => api.startQuizRealtimeTranscription(studentId, input, new AbortController().signal), (error: any) => error.code === 'REALTIME_NOT_CONFIGURED');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => api.startQuizRealtimeTranscription(studentId, input, controller.signal), (error: any) => error.code === 'REALTIME_CANCELLED');
  assert.equal(state.logs.length, 0); assert.equal(state.fetches.length, 0);
});

test('duplicate concurrent attempt is reserved once across the shared advisory lock', async () => {
  const { state, api } = harness();
  const results = await Promise.allSettled([0, 1].map(() => api.startQuizRealtimeTranscription(studentId, input, new AbortController().signal)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(state.fetches.length, 1); assert.equal(state.logs.length, 1);
  assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'REALTIME_ATTEMPT_USED');
});

test('the existing daily AI quota still gates realtime calls before contacting OpenAI', async () => {
  const { state, api } = harness(); state.dailyLimit = true;
  await assert.rejects(() => api.startQuizRealtimeTranscription(studentId, input, new AbortController().signal), (error: any) => error.code === 'AI_DAILY_LIMIT');
  assert.equal(state.logs.length, 0); assert.equal(state.fetches.length, 0);
});

test('rapid reconnect and student minute quota stop before upstream requests', async () => {
  const { state, api } = harness();
  await api.startQuizRealtimeTranscription(studentId, input, new AbortController().signal);
  await assert.rejects(() => api.startQuizRealtimeTranscription(studentId, { ...input, attemptId: '00000000-0000-4000-8000-000000000004' }, new AbortController().signal), (error: any) => error.code === 'REALTIME_RATE_LIMIT');
  state.logs[0].old = true;
  for (let i = 0; i < 5; i++) state.logs.push({ studentId, feature: 'quiz_realtime_transcription', contextId: `other-${i}`, old: true });
  await assert.rejects(() => api.startQuizRealtimeTranscription(studentId, { ...input, attemptId: '00000000-0000-4000-8000-000000000005' }, new AbortController().signal), (error: any) => error.code === 'REALTIME_RATE_LIMIT');
  assert.equal(state.fetches.length, 1);
});

test('pause, pause-resume or deactivation during handshake closes the remote call', async () => {
  for (const change of [{ state: 'paused' }, { revision: 5 }, { active: false }]) {
    const { state, api } = harness(); state.afterFetch = () => Object.assign(state, change);
    await assert.rejects(() => api.startQuizRealtimeTranscription(studentId, input, new AbortController().signal), (error: any) => error.code === 'REALTIME_QUIZ_CHANGED' || error.code === 'QUIZ_NOT_FOUND');
    assert.ok(state.fetches.some(call => call.url.endsWith(`/${callId}/hangup`)));
    assert.equal(state.logs[0].status, 'failed');
  }
});

test('cancellation after negotiation hangs up a call rather than exposing a stale answer', async () => {
  const { state, api } = harness(), controller = new AbortController();
  state.afterFetch = () => controller.abort();
  await assert.rejects(() => api.startQuizRealtimeTranscription(studentId, input, controller.signal), (error: any) => error.code === 'REALTIME_CANCELLED');
  assert.ok(state.fetches.some(call => call.url.endsWith('/hangup')));
});

test('upstream failures and malformed SDP expose a safe retry message', async () => {
  for (const change of [{ upstreamStatus: 500 }, { upstreamFailure: true }, { upstreamSdp: 'Secret vendor result' }, { upstreamLocation: 'https://evil.example/v1/realtime/calls/rtc_evil' }]) {
    const { state, api } = harness(); Object.assign(state, change);
    await assert.rejects(() => api.startQuizRealtimeTranscription(studentId, input, new AbortController().signal), (error: any) => error.code === 'REALTIME_CONNECT_FAILED' && !error.message.includes('Secret'));
    assert.equal(state.logs[0].status, 'failed');
    assert.ok(state.fetches.every(call => call.url.startsWith('https://api.openai.com/v1/realtime/calls')));
  }
});

test('failed durable call ownership closes upstream instead of returning an unmanageable session', async () => {
  const { state, api } = harness(); state.failAccounting = true;
  await assert.rejects(() => api.startQuizRealtimeTranscription(studentId, input, new AbortController().signal), (error: any) => error.code === 'REALTIME_CONNECT_FAILED');
  assert.ok(state.fetches.some(call => call.url.endsWith('/hangup')));
});

test('cleanup is exact to student, session, item and attempt and remains usable while paused', async () => {
  const { state, api } = harness();
  await api.startQuizRealtimeTranscription(studentId, input, new AbortController().signal);
  const closeInput = { ...input, callId };
  for (const [actor, candidate] of [
    ['other-student', closeInput], [studentId, { ...closeInput, itemIndex: 1 }],
    [studentId, { ...closeInput, attemptId: '00000000-0000-4000-8000-000000000006' }],
  ] as const) await assert.rejects(() => api.closeQuizRealtimeTranscription(actor, candidate), (error: any) => error.code === 'REALTIME_CALL_NOT_FOUND');
  assert.equal(state.fetches.length, 1);
  state.state = 'paused';
  await api.closeQuizRealtimeTranscription(studentId, closeInput);
  assert.equal(state.logs[0].status, 'completed');
  await api.closeQuizRealtimeTranscription(studentId, closeInput);
  assert.equal(state.fetches.filter(call => call.url.endsWith('/hangup')).length, 1);
});

test('a failed remote hangup remains retryable and returns only a safe provider error', async () => {
  for (const failure of [{ hangupFailure: true }, { hangupStatus: 503 }]) {
    const { state, api } = harness();
    await api.startQuizRealtimeTranscription(studentId, input, new AbortController().signal);
    Object.assign(state, failure);
    await assert.rejects(() => api.closeQuizRealtimeTranscription(studentId, { ...input, callId }), (error: any) => error.status === 502 && error.code === 'REALTIME_CLOSE_FAILED' && !error.message.includes('Secret'));
    assert.equal(state.logs[0].status, 'connected');
    state.hangupFailure = false; state.hangupStatus = 200;
    await api.closeQuizRealtimeTranscription(studentId, { ...input, callId });
    assert.equal(state.logs[0].status, 'completed');
    await api.closeQuizRealtimeTranscription(studentId, { ...input, callId });
    assert.equal(state.fetches.filter(call => call.url.endsWith('/hangup')).length, 2);
  }
});
