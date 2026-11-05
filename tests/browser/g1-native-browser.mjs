/** Actual isolated Chrome + production InterviewShell/hooks. All HTTP/WS,
 * transcript, audio and devices are explicitly synthetic; never loads .env. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { WebSocket, WebSocketServer } from 'ws';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const quick = process.argv.includes('--quick');
const output = path.join(workspace, 'artifacts/browser-g1', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const evidence = { startedAt: new Date().toISOString(), quick, status: 'running', scope: 'actual Chrome; actual InterviewShell and production hooks; synthetic localhost backend, fake microphone, generated tone WAV; camera explicitly skipped; no live STT/TTS/LLM', paidApiCalls: 0, snapshots: [], requests: [], sockets: [], browserErrors: [], networkFailures: [], assertions: [] };
evidence.productionSourceSha256 = Object.fromEntries(await Promise.all(['components/interview/InterviewShell.tsx', 'hooks/useInterviewSession.ts', 'hooks/useAudioDevices.ts', 'lib/interview/submission-wait.ts'].map(async relative => [relative, createHash('sha256').update(await readFile(path.join(workspace, relative))).digest('hex')])));
const note = message => { process.stdout.write(`${new Date().toISOString()} ${message}\n`); };
const json = (response, value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
const body = async request => { let text = ''; for await (const chunk of request) text += chunk; return text ? JSON.parse(text) : {}; };
function wav(seconds = 1.1) {
  const samples = Math.round(seconds * 16000), data = Buffer.alloc(44 + samples * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 1300), 44 + i * 2);
  return data;
}
const target = { university: '합성대학교', department: '합성학과', track: '합성전형', year: 2027, studentName: '합성학생' };
const turn = (index, id = randomUUID()) => ({ id, questionText: `합성 브라우저 질문 ${index}: 직접 한 일을 한 가지 설명해 주세요.`, questionKind: 'main', parentMainQuestionId: id, mainIndex: index, mainCount: 5, followUpIndex: 0, evidenceIds: ['synthetic-source'], questionAudioUrl: `/api/audio/question-${index}.wav`, acknowledgement: index === 1 ? '합성 면접을 시작합니다.' : null, acknowledgementAudioUrl: index === 1 ? '/api/audio/opening.wav' : null, interviewerId: 'interviewer-1' });
const first = turn(1), next = turn(2);
const mock = { sessionId: randomUUID(), current: first, status: 'active', evaluationStatus: 'pending', answerId: null, captureRevision: 1, transcript: '', transcriptStatus: null, elapsedMs: 0, nextRequests: 0, endRequests: 0, nextPending: null, audioFails: false, readyAt: null, clientEvents: [], pcmBytes: 0 };
const wss = new WebSocketServer({ noServer: true });
const seenAudios = new Set();
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/favicon.ico') { response.writeHead(204); return response.end(); }
    if (url.pathname.startsWith('/api/')) evidence.requests.push({ at: new Date().toISOString(), method: request.method, route: url.pathname });
    if (url.pathname === '/api/status') return json(response, { ready: true, missingKeys: [], errors: [], realtimePort: server.address().port, durationSeconds: 720, turnWaitTimeoutMs: 95_000, target, sources: ['explicit-synthetic-browser-source'], interviewOverview: { lines: ['합성 브라우저 검증', '실제 UI · 합성 자료', '외부 API 호출 없음'], durationSeconds: 720, source: { id: 'synthetic', title: '합성 검증', url: 'https://example.invalid', academicYear: 2027, location: 'fixture', verificationStatus: 'synthetic' }, trackId: 'synthetic-track' } });
    if (url.pathname === '/api/prepare') { await body(request); return json(response, { ready: true, preparationId: 'browser-synthetic-preparation', questionAudioUrls: [first.questionAudioUrl, first.acknowledgementAudioUrl] }); }
    if (url.pathname === '/api/sessions') { await body(request); return json(response, { sessionId: mock.sessionId, turn: first, durationSeconds: 720 }, 201); }
    if (url.pathname.startsWith('/api/audio/')) {
      seenAudios.add(url.pathname);
      if (mock.audioFails && url.pathname.includes('question-2')) return json(response, { error: 'Explicit synthetic local audio-fetch failure' }, 503);
      response.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }); return response.end(wav(url.pathname.includes('opening') || url.pathname.includes('closing') ? .35 : 1.1));
    }
    if (url.pathname === `/api/sessions/${mock.sessionId}` && request.method === 'GET') return json(response, { sessionId: mock.sessionId, target, status: mock.status, evaluationStatus: mock.evaluationStatus, durationSeconds: 720, recovery: { currentTurn: mock.current, elapsedMs: mock.elapsedMs, transcript: mock.transcript, transcriptStatus: mock.transcriptStatus, answerId: mock.answerId, captureRevision: mock.captureRevision, answerCommitStatus: mock.transcriptStatus === 'finalized' ? 'committed' : 'capturing', deliveryUncertain: false, closingUtterance: null, messages: [] } });
    if (url.pathname.endsWith('/events')) { const value = await body(request); mock.clientEvents.push(value); if (typeof value.payload?.elapsedMs === 'number') mock.elapsedMs = value.payload.elapsedMs; return json(response, { acceptedClientEventIds: value.eventId ? [value.eventId] : [] }); }
    if (url.pathname.endsWith('/timings')) { await body(request); return json(response, {}); }
    if (url.pathname.endsWith('/answer-candidate')) { const value = await body(request); return json(response, { action: 'ADVANCE', candidateId: `synthetic-candidate-${value.captureRevision}`, captureRevision: value.captureRevision, rawTranscript: mock.transcript, acceptedClientEventIds: [] }); }
    if (url.pathname.endsWith('/next')) { const value = await body(request); mock.nextRequests++; evidence.submitAt ??= new Date().toISOString(); mock.nextPending = () => { mock.current = next; mock.answerId = null; mock.transcript = ''; mock.transcriptStatus = null; mock.readyAt = new Date().toISOString(); return json(response, { turn: next, done: false, acceptedClientEventIds: [] }); }; if (mock.nextRequests > 1) return mock.nextPending(); evidence.nextInput = value; return; }
    if (url.pathname.endsWith('/end')) { const value = await body(request); mock.endRequests++; mock.status = 'ending'; mock.evaluationStatus = 'review_required'; evidence.endInput = value; return json(response, { status: 'ending', evaluationStatus: 'review_required' }, 202); }
    if (url.pathname.endsWith('/closing')) { await body(request); return json(response, { closingUtterance: { id: 'synthetic-browser-closing', text: '합성 면접을 마칩니다.', audioUrl: '/api/audio/closing.wav', interviewerId: 'interviewer-1', nonEvaluative: true, reason: 'user_ended' } }); }
    if (url.pathname.startsWith('/api/')) return json(response, { error: 'Unknown synthetic endpoint' }, 404);
    if (url.pathname === '/' || url.pathname === '/interview') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Permissions-Policy': 'camera=(self), microphone=(self), fullscreen=(self)' });
      return response.end('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>G1 isolated native browser verification</title><link rel="stylesheet" href="/g1-ui.css"><body><div id="root"></div><script src="/g1-ui.js"></script></body></html>');
    }
    const base = ['/g1-ui.js', '/g1-ui.css'].includes(url.pathname) ? output : path.join(workspace, 'public');
    const file = path.resolve(base, '.' + url.pathname), relative = path.relative(base, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(file)).isFile()) return json(response, {}, 404);
    const extension = path.extname(file), types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.onnx': 'application/octet-stream' };
    response.writeHead(200, { 'Content-Type': types[extension] ?? 'application/octet-stream' }); response.end(await readFile(file));
  } catch (error) { evidence.browserErrors.push({ source: 'mock-server', route: url.pathname, message: String(error) }); if (!response.headersSent) json(response, { error: String(error) }, 500); else response.end(); }
});
server.on('upgrade', (request, socket, head) => wss.handleUpgrade(request, socket, head, client => wss.emit('connection', client, request)));
wss.on('connection', socket => {
  const connectionId = randomUUID(); evidence.sockets.push({ type: 'connected', connectionId, at: new Date().toISOString() });
  socket.on('close', () => evidence.sockets.push({ type: 'closed', connectionId, at: new Date().toISOString() }));
  socket.on('message', (bytes, binary) => {
    if (binary) { mock.pcmBytes += bytes.length; return; }
    const value = JSON.parse(bytes.toString()); evidence.sockets.push({ type: value.type, connectionId, ...value, at: new Date().toISOString() });
    const scope = { sessionId: mock.sessionId, turnId: value.turnId, answerId: value.answerId, captureRevision: value.captureRevision ?? 1, streamId: 'synthetic-stream-' + connectionId };
    if (value.type === 'start') { mock.answerId = value.answerId; mock.captureRevision = value.captureRevision ?? 1; mock.transcriptStatus = 'streaming'; socket.send(JSON.stringify({ type: 'started', ...scope })); }
    if (value.type === 'pause') { mock.transcriptStatus = 'paused'; socket.send(JSON.stringify({ type: 'paused', ...scope, rawTranscript: mock.transcript })); }
    if (value.type === 'finish') { mock.transcript = '이것은 실제 음성 인식 결과가 아닌 명시적인 합성 답변입니다.'; mock.transcriptStatus = 'finalized'; setTimeout(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'finalized', ...scope, rawTranscript: mock.transcript })); }, 80); }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const hook = path.join(workspace, 'hooks/useInterviewSession.ts'), shell = path.join(workspace, 'components/interview/InterviewShell.tsx');
await build({ stdin: { resolveDir: workspace, sourcefile: 'g1-browser-entry.tsx', loader: 'tsx', contents: `import React from 'react';import {createRoot} from 'react-dom/client';import ${JSON.stringify(path.join(workspace, 'app/globals.css'))};import {InterviewShell} from ${JSON.stringify(shell)};window.__g1Trace=[];window.__g1Media=[];createRoot(document.getElementById('root')).render(<InterviewShell/>);` }, outfile: path.join(output, 'g1-ui.js'), bundle: true, platform: 'browser', format: 'iife', target: 'chrome130', jsx: 'automatic', tsconfig: path.join(workspace, 'tsconfig.json'), logLevel: 'silent', define: { 'process.env.NODE_ENV': '"development"' }, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' }, plugins: [{ name: 'observe-real-session-hook', setup(builder) {
  builder.onResolve({ filter: /^onnxruntime-web(?:\/wasm)?$/ }, () => ({ path: path.join(workspace, 'node_modules/onnxruntime-web/dist/ort.wasm.min.mjs') }));
  builder.onResolve({ filter: /^tailwindcss$/ }, () => ({ path: path.join(workspace, 'node_modules/tailwindcss/index.css') }));
  builder.onResolve({ filter: /^@\/hooks\/useInterviewSession$/ }, args => args.importer === shell ? { path: 'observe-hook', namespace: 'g1' } : undefined);
  builder.onLoad({ filter: /.*/, namespace: 'g1' }, () => ({ resolveDir: workspace, loader: 'tsx', contents: `export * from ${JSON.stringify(hook)};import {useInterviewSession as actual} from ${JSON.stringify(hook)};import {useEffect} from 'react';const seen=new WeakSet();export function useInterviewSession(...args){const s=actual(...args);window.__g1={phase:s.phase,error:s.error,sessionId:s.sessionId,visibleTurn:s.visibleTurn,messages:s.messages,elapsedMs:s.elapsedMs,evaluationStatus:s.evaluationStatus,endingRequested:s.endingRequested,questionRecoveryRequiresEnd:s.questionRecoveryRequiresEnd,fullscreen:!!document.fullscreenElement,hidden:document.hidden,at:performance.now(),microphone:args[0].micStatus,startup:s.startup};useEffect(()=>{window.__g1Trace.push({...window.__g1,wall:new Date().toISOString()});const a=args[0].audio.current;if(a&&!seen.has(a)){seen.add(a);for(const event of ['playing','ended','pause','error'])a.addEventListener(event,()=>window.__g1Media.push({event,src:a.currentSrc,position:a.currentTime,duration:a.duration,at:performance.now(),wall:new Date().toISOString()}));}},[s.phase,s.visibleTurn?.id,s.error,s.elapsedMs,s.evaluationStatus]);return s;}` }));
} }] });

class CDP {
  pending = new Map(); listeners = new Map(); sequence = 0;
  constructor(socket) { this.socket = socket; socket.on('message', bytes => { const event = JSON.parse(bytes.toString()); if (event.id) { const pending = this.pending.get(event.id); this.pending.delete(event.id); if (event.error) pending?.reject(new Error(JSON.stringify(event.error))); else pending?.resolve(event.result); } else for (const callback of this.listeners.get(event.method) ?? []) void callback(event.params); }); socket.on('close', () => { for (const pending of this.pending.values()) pending.reject(new Error('Isolated browser protocol closed')); this.pending.clear(); }); }
  send(method, params = {}) { const id = ++this.sequence; return new Promise((resolve, reject) => { if(this.socket.readyState!==WebSocket.OPEN)return reject(new Error('Closed CDP for '+method)); const timeout=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timeout: '+method));},20_000);this.pending.set(id,{resolve:v=>{clearTimeout(timeout);resolve(v)},reject:e=>{clearTimeout(timeout);reject(e)}}); this.socket.send(JSON.stringify({ id, method, params })); }); }
  on(method, callback) { this.listeners.set(method, [...this.listeners.get(method) ?? [], callback]); }
  async evaluate(expression) { const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description); return result.result.value; }
}
async function freePort() { const value = createServer(); await new Promise(resolve => value.listen(0, '127.0.0.1', resolve)); const port = value.address().port; await new Promise(resolve => value.close(resolve)); return port; }
async function until(read, predicate, label, timeout = 25_000) { const started = Date.now(); let value; while (Date.now() - started < timeout) { value = await read(); if (predicate(value)) return value; await delay(100); } throw new Error(`Timed out: ${label}; latest=${JSON.stringify(value)}`); }
const port = await freePort();
const executable = process.env.G1_CHROME_EXECUTABLE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--metrics-recording-only', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--window-size=1440,1000', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${path.join(output, 'isolated-chrome-profile')}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
let cdp;
try {
  const tabs = await until(async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return []; } }, value => value.some(item => item.type === 'page'), 'isolated Chrome launch');
  const socket = new WebSocket(tabs.find(item => item.type === 'page').webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }); cdp = new CDP(socket);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 1000 });
  evidence.browser = await cdp.send('Browser.getVersion');
  cdp.on('Page.javascriptDialogOpening', async value => { evidence.sockets.push({ type: 'native-browser-dialog', dialogType: value.type, message: value.message, action: 'accept_reload' }); await cdp.send('Page.handleJavaScriptDialog', { accept: true }); });
  cdp.on('Runtime.exceptionThrown', value => evidence.browserErrors.push(value));
  cdp.on('Network.loadingFailed', value => evidence.networkFailures.push(value));
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  cdp.on('Fetch.requestPaused', async value => { if (value.request.url.startsWith(base + '/') || /^(blob:|data:)/.test(value.request.url)) await cdp.send('Fetch.continueRequest', { requestId: value.requestId }); else { evidence.networkFailures.push({ blockedExternalUrl: value.request.url }); await cdp.send('Fetch.failRequest', { requestId: value.requestId, errorReason: 'BlockedByClient' }); } });
  const screenshot = async name => { const image = await cdp.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, name + '.png'), Buffer.from(image.data, 'base64')); };
  const snapshot = async name => { await cdp.evaluate("document.querySelector('.center-copy')?.scrollIntoView({block:'center',inline:'nearest'})"); const state = await cdp.evaluate('window.__g1'); const value = { name, wall: new Date().toISOString(), state, nextRequests: mock.nextRequests, readyAt: mock.readyAt }; evidence.snapshots.push(value); await screenshot(name); note(name + ' ' + state.phase); return value; };
  const click = async (text, selector = 'button') => { const point = await until(() => cdp.evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>(b.textContent.trim().includes(${JSON.stringify(text)})||b.getAttribute('aria-label')===${JSON.stringify(text)})&&!b.disabled);if(!b)return null;b.scrollIntoView({block:'center',inline:'center'});const r=b.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`), Boolean, 'button ' + text); await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); };
  const phase = (expected, timeout) => until(() => cdp.evaluate('window.__g1').catch(() => null), value => value?.phase === expected, 'phase ' + expected, timeout);
  await cdp.send('Page.navigate', { url: base + '/interview' });
  await until(() => cdp.evaluate('window.__g1'), value => value?.phase === 'idle', 'production UI mount');
  await snapshot('01-ready'); await click('면접 준비하기'); await phase('device_check'); await click('카메라 없이 진행');
  await until(() => cdp.evaluate('window.__g1'), value => value?.startup.microphone === 'ready', 'native fake microphone');
  await click('전체화면으로 면접 시작'); await phase('listening'); await snapshot('02-first-question-listening');
  const submittedAt = Date.now(); evidence.submissionWallStart = new Date(submittedAt).toISOString(); await click('다 말했어요');
  await until(() => Promise.resolve(mock.nextRequests), value => value === 1, 'held next request');
  await cdp.evaluate('document.exitFullscreen()'); await phase('suspended');
  mock.audioFails = true; mock.nextPending(); mock.nextPending = null;
  await until(() => Promise.resolve(seenAudios.has(next.questionAudioUrl)), Boolean, 'ready question audio preparation');
  await snapshot('03-prepared-while-suspended');
  const boundaries = quick ? [3_000] : [94_000, 95_000, 96_000];
  for (const milliseconds of boundaries) {
    while (Date.now() - submittedAt < milliseconds) await delay(Math.min(5000, milliseconds - (Date.now() - submittedAt)));
    const result = await snapshot(`04-paused-at-${milliseconds / 1000}s`);
    assert.equal(result.state.phase, 'suspended'); assert.equal(result.state.error, ''); assert.equal(result.state.questionRecoveryRequiresEnd, false); assert.equal(mock.nextRequests, 1);
    evidence.assertions.push({ name: `prepared result survives ${milliseconds}ms real elapsed`, elapsedMs: Date.now() - submittedAt, passed: true });
  }
  await click('전체화면으로 이어하기'); await phase('error'); await snapshot('05-local-audio-failure');
  assert.equal((await cdp.evaluate('window.__g1')).questionRecoveryRequiresEnd, false);
  mock.audioFails = false; await click('다시 시도'); await phase('listening');
  const resumed = await snapshot('06-same-question-after-retry'); assert.equal(resumed.state.visibleTurn.id, next.id); assert.equal(mock.nextRequests, 1);
  evidence.assertions.push({ name: 'local audio retry reuses exact prepared utterance without regeneration', utteranceId: next.id, nextRequests: mock.nextRequests, passed: true });
  await cdp.evaluate('document.exitFullscreen()'); await phase('suspended'); await delay(200);
  evidence.clientTraceBeforeReload = await cdp.evaluate('window.__g1Trace'); evidence.nativeMediaTraceBeforeReload = await cdp.evaluate('window.__g1Media'); let reloadTimeout; const reloadFinished = new Promise((resolve,reject) => { reloadTimeout=setTimeout(()=>reject(new Error('Reload load event timed out')),20_000); cdp.on('Page.loadEventFired', value=>{clearTimeout(reloadTimeout);resolve(value)}); }); note('refresh navigation begin'); await cdp.send('Page.reload', { ignoreCache: true }); await reloadFinished; note('refresh document loaded'); await phase('suspended');
  const refreshed = await snapshot('07-refresh-restores-same-session'); assert.equal(refreshed.state.sessionId, mock.sessionId); assert.equal(mock.current.id, next.id);
  await click('전체화면으로 이어하기'); await phase('listening');
  for (const client of wss.clients) client.close(1012, 'Explicit synthetic reconnect test');
  await phase('suspended'); await snapshot('08-real-websocket-disconnect');
  await click('전체화면으로 이어하기'); await phase('listening'); await snapshot('09-reconnected-same-session');
  assert.equal((await cdp.evaluate('window.__g1')).sessionId, mock.sessionId); assert.equal(mock.nextRequests, 1);
  await click('면접 종료'); await click('면접 종료', '[role="dialog"] button'); await phase('completed'); await snapshot('10-explicit-end');
  assert.equal(mock.endRequests, 1); assert.equal((await cdp.evaluate('window.__g1')).evaluationStatus, 'review_required');
  evidence.assertions.push({ name: 'refresh/reconnect/end preserve same session; one end request', sessionId: mock.sessionId, endRequests: mock.endRequests, passed: true });
  evidence.status = quick ? 'setup_passed_not_95_second_proof' : 'passed';
} catch (error) { evidence.status = 'failed'; evidence.failure = error.stack ?? String(error); note('FAILED ' + String(error)); if (cdp) { try { evidence.failureState = await cdp.evaluate('({state:window.__g1,text:document.body.innerText,trace:window.__g1Trace,media:window.__g1Media})'); const image = await cdp.send('Page.captureScreenshot', { format: 'png' }); await writeFile(path.join(output, 'failure.png'), Buffer.from(image.data, 'base64')); } catch { /* Keep original failure. */ } } process.exitCode = 1; }
finally {
  if (cdp) { try { evidence.clientTrace = await cdp.evaluate('window.__g1Trace'); evidence.nativeMediaTrace = await cdp.evaluate('window.__g1Media'); await cdp.send('Browser.close'); } catch { /* Browser.close intentionally closes the protocol. */ } cdp.socket.close(); }
  if (browser.exitCode === null) browser.kill();
  for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  evidence.finishedAt = new Date().toISOString(); evidence.mock = { sessionId: mock.sessionId, finalTurnId: mock.current.id, nextRequests: mock.nextRequests, endRequests: mock.endRequests, readyAt: mock.readyAt, pcmBytes: mock.pcmBytes, clientEvents: mock.clientEvents };
  await writeFile(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2)); note(`REPORT ${path.join(output, 'evidence.json')}`);
}
