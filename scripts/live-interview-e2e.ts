import dotenv from 'dotenv';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { loadInterviewContext } from '../server/data/load-interview-context';
import { loadQuestionBank } from '../server/data/prepared-question-bank';
import { synthesizeSpeech, readSpeechAudio } from '../server/providers/clova-tts';
import { speechAudioCacheId } from '../server/providers/clova-tts';
import { normalizeProviderUsage, estimateProviderCost } from '../server/observability/provider-cost';
import { maskConversationSecrets } from '../server/storage/conversation-log';
import { decodeSyntheticAudio } from './live-e2e-audio';
import type { InterviewSession, PreparedTurn } from '../server/protocol';
import { LocalSessionStore } from '../server/storage/local-session-store';
import { EvaluationJobStore } from '../server/evaluation-job-store';
import { recordSessionProviderUsage } from '../server/observability/session-provider-ledger';
import { assertReplayBank, createReplayCheckpoint, nextReplayAnswer, maySupplementReplayRoot, replayEngineSourceFingerprints, replayHash, type ReplayBaseline } from './live-e2e-replay';

if (!process.argv.includes('--run-live')) throw new Error('EXPLICIT_RUN_LIVE_REQUIRED');
dotenv.config({ path: '.env.local', quiet: true });
const replayPath = process.argv.find(arg => arg.startsWith('--replay='))?.slice('--replay='.length);
if (replayPath && !/^artifacts\/live-interview-e2e-[a-zA-Z0-9-]+\.json$/u.test(replayPath)) throw new Error('REPLAY_SOURCE_PATH_INVALID');
const replaySource = replayPath ? await readFile(replayPath, 'utf8') : null;
const replay: ReplayBaseline | null = replaySource ? JSON.parse(replaySource) : null;
const supplementLimit = Number(process.argv.find(arg => arg.startsWith('--adaptive-supplement-limit='))?.slice(28) ?? 0);
if (!Number.isInteger(supplementLimit) || supplementLimit < 0 || supplementLimit > 4 || supplementLimit > 0 && !replay) throw new Error('ADAPTIVE_SUPPLEMENT_LIMIT_INVALID');
if (replay && (replay.provenance?.syntheticTest !== true || !/^[0-9a-f-]{36}$/u.test(replay.sessionId))) throw new Error('SYNTHETIC_REPLAY_SOURCE_REQUIRED');
const replayOriginal: InterviewSession | null = replay ? JSON.parse(await readFile(`data/sessions/${replay.sessionId}.json`, 'utf8')) : null;
const replayInputManifest = replay ? JSON.parse(await readFile('artifacts/live-e2e-replay-input-manifest.json', 'utf8')) : null;
if (replay && !replayInputManifest.sources.some((source: any) => source.sourcePath === replayPath && source.sourceSha256 === replayHash(replaySource!))) throw new Error('FROZEN_REPLAY_SOURCE_CHANGED');
const scenario = replay ? `${replay.scenario}-replay${supplementLimit ? '-adaptive' : ''}` : process.argv.includes('--silence') ? 'silence' : process.argv.includes('--coverage') ? 'coverage' : 'conversation';
const stagedCapture = process.argv.includes('--staged-capture');
const probeAbsurd = process.argv.includes('--probe-absurd');
if (probeAbsurd && (replay || scenario !== 'conversation')) throw new Error('ABSURD_PROBE_REQUIRES_FRESH_CONVERSATION');
const turnLimit = Number(process.argv.find(arg => arg.startsWith('--max-turns='))?.split('=')[1] ?? (replay ? replay.turns.length + supplementLimit + 2 : scenario === 'silence' ? 2 : 18));
if (!Number.isSafeInteger(turnLimit) || turnLimit < 1 || turnLimit > 24) throw new Error('TURN_LIMIT_INVALID');
const stagedCaptures = new Map<string, { answerId: string; captureRevision: number; totalAudioMs: number }>();
const stagedAdvancements = new Map<string, string>();
const trailingSilenceMs = replay ? Number(replay.trailingSilenceMs ?? 0) : Number(process.argv.find(arg => arg.startsWith('--tail-silence-ms='))?.split('=')[1] ?? 0);
if (!Number.isInteger(trailingSilenceMs) || trailingSilenceMs < 0 || trailingSilenceMs > 2000) throw new Error('TAIL_SILENCE_OUT_OF_RANGE');
const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
const output = `artifacts/live-interview-e2e-${stamp}-${scenario}.json`;
const context = await loadInterviewContext(), bank = await loadQuestionBank(context);
if (context.errors.length || !bank) throw new Error('VERIFIED_QUESTION_BANK_REQUIRED');
if (replay) { assertReplayBank(replay, bank, replayOriginal!); if (replayInputManifest.bankIdentity !== bank.key || replayInputManifest.bankContentSha256 !== bank.contentSha256) throw new Error('FROZEN_REPLAY_BANK_CHANGED'); }
const model = process.env.OPENAI_QUESTION_MODEL || 'gpt-6-luna';
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 20000 });
const engineSourceSha256 = await replayEngineSourceFingerprints();
const report: Record<string, any> = {
  startedAt: new Date().toISOString(), scenario, stagedCapture, probeAbsurd, turnLimit, trailingSilenceMs, bankKey: bank.key, bankIdentity: bank.key, bankContentSha256: bank.contentSha256,
  engineSourceSha256,
  bankApprovedCandidates: bank.slots.reduce((n, s) => n + s.candidates.length, 0), bankPlannedSlots: bank.plan.slots.length,
  provenance: { syntheticTest: true, syntheticVoice: true, syntheticClientObservation: true,
    realHttpSession: true, realWebSocket: true, realClovaStt: true, realInterviewerCore: true,
    realIndependentReviewWhenRequested: true, realClovaTts: true, actualBrowserPlayback: false,
    humanMicrophoneUsed: false, answerTextInjectedIntoServer: false, engineStubbed: false,
    realSessionCreationEndpoint: !replay, approvedBankCheckpointSeededBeforeServerStart: Boolean(replay),
    presentation: 'Decoded audio duration with simulated client events; not observed browser playback.' },
  owner: `synthetic-e2e-${stamp}-${scenario}`, turns: [], failures: [],
  ...(replay ? { replay: { sourcePath: replayPath, sourceSha256: replayHash(replaySource!), sourceSessionId: replay.sessionId,
    sourceScenario: replay.scenario, originalAnswerCount: replay.turns.length, newStudentGenerationCalls: 0,
    adaptiveSupplementLimit: supplementLimit, adaptiveSupplementCount: 0,
    adaptiveScope: supplementLimit ? 'Additional synthetic answers only for subordinate questions in an exhausted original root while other fixed source answers remain. These are separate from frozen-input comparisons.' : null,
    scope: 'Same approved Q0 plan restored at an unanswered checkpoint; real HTTP/WS/STT/core/review/TTS afterward. Not a fresh start-endpoint or timed human browser test.' } } : {}),
};
await mkdir('artifacts', { recursive: true });
const save = () => writeFile(output, JSON.stringify(maskConversationSecrets(report), null, 2), { mode: 0o600 });
let sessionId: string | undefined;
let replayCheckpoint: InterviewSession | null = null;
if (replay) {
  const original = replayOriginal!;
  if (original.id !== replay.sessionId || original.metrics && (original.metrics as any).verification?.syntheticTest !== true) throw new Error('REPLAY_ORIGINAL_SESSION_NOT_SYNTHETIC');
  replayCheckpoint = createReplayCheckpoint(context, bank, original, report.owner);
  sessionId = replayCheckpoint.id; report.sessionId = sessionId;
  const store = new LocalSessionStore(); await store.saveContext(context, report.owner); await store.save(replayCheckpoint);
  report.replay.checkpoint = { sessionId, question: replayCheckpoint.turns[0].questionText,
    answerCount: replayCheckpoint.turns.filter(turn => turn.answerId || turn.rawTranscript).length,
    contextSnapshotSha256: replayCheckpoint.runtime!.contextSnapshotSha256 };
}
const availablePort = await new Promise<number>(resolve => {
  const server = net.createServer(); server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${availablePort}`, origin = base;
const child = spawn(process.execPath, ['--import', 'tsx', 'server/realtime.ts'], {
  cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, REALTIME_PORT: String(availablePort), LOCAL_INTERVIEW_OWNER_ID: report.owner },
});
const evaluationWorker = spawn(process.execPath, ['--import', 'tsx', 'scripts/run-evaluation-worker.ts'], {
  cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
});
let serverOutput = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { serverOutput = (serverOutput + String(chunk)).slice(-6000); });
for (const stream of [evaluationWorker.stdout, evaluationWorker.stderr]) stream.on('data', chunk => { serverOutput = (serverOutput + String(chunk)).slice(-6000); });
const start = performance.now(), clockId = randomUUID();
let logicalMs = 0, ended = false;
const replayedIndices = new Set<number>();
let supplementCount = 0;
const marks = new Map<string, number>();
async function request(route: string, body?: unknown, timeout = 90000) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', Connection: 'close' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout) });
  const value = await response.json();
  if (!response.ok) throw new Error(`HTTP_${response.status}: ${JSON.stringify(value).slice(0, 350)}`);
  return value;
}
async function persisted() {
  const saved = JSON.parse(await readFile(`data/sessions/${sessionId}.json`, 'utf8')) as InterviewSession;
  if (saved.status === 'active') return saved;
  // New evaluation revisions live in the durable result store. Query the same
  // projection used by the browser; never expect a worker to rewrite raw logs.
  const projected = await request(`/api/sessions/${sessionId}`);
  const jobId = saved.runtime?.evaluationJob?.id;
  if (jobId) {
    const jobs = new EvaluationJobStore(), job = await jobs.get(jobId);
    if (job) {
      const result = await jobs.result(job);
      for (const item of job.usage) saved.providerUsageLedger = recordSessionProviderUsage(saved.providerUsageLedger,
        { stage: 'evaluation', attemptId: item.attemptId, observation: item.observation });
      report.finalEvaluationJob = { id: job.id, status: job.status, resultSha256: job.resultSha256,
        completedClusters: job.checkpoints.length, providerCalls: job.usage.length, verifiedResultPresent: Boolean(result),
        storage: 'versioned-job-result-original-session-not-overwritten' };
    }
  }
  return { ...saved, status: projected.status, evaluationStatus: projected.evaluationStatus,
    evaluationError: projected.evaluationError, ...(projected.evaluation ? { evaluation: projected.evaluation } : {}) } as InterviewSession;
}
async function event(type: string, turn: PreparedTurn, phase: string, extra: Record<string, unknown> = {}) {
  return request(`/api/sessions/${sessionId}/events`, { eventId: randomUUID(), clockId, type, turnId: turn.id,
    phase, atMs: logicalMs, payload: { ...extra, verification: 'synthetic-client-observation', actualBrowserPlayback: false } });
}
async function fetchAudio(url: string) {
  const response = await fetch(base + url, { headers: { Origin: origin, Connection: 'close' } });
  if (!response.ok || !response.headers.get('content-type')?.includes('audio')) throw new Error('AUDIO_NOT_READABLE');
  return decodeSyntheticAudio(Buffer.from(await response.arrayBuffer()));
}
async function present(turn: PreparedTurn) {
  const at = performance.now();
  let acknowledgementDurationMs = 0;
  if (turn.acknowledgement && turn.acknowledgementAudioUrl) {
    const audio = await fetchAudio(turn.acknowledgementAudioUrl); acknowledgementDurationMs = audio.durationMs;
    await event('acknowledgement_playing', turn, 'speaking_question'); logicalMs += audio.durationMs;
    await event('audio_ended', turn, 'speaking_question', { role: 'acknowledgement' });
  }
  const audio = await fetchAudio(turn.questionAudioUrl);
  await event('question_playing', turn, 'speaking_question'); logicalMs += audio.durationMs;
  await event('audio_ended', turn, 'speaking_question', { role: 'question' });
  await event('phase_changed', turn, 'listening');
  return { downloadedAndDecodedMs: performance.now() - at, questionDurationMs: audio.durationMs, acknowledgementDurationMs,
    actualPlaybackObserved: false, simulatedPresentationClockMs: logicalMs };
}
function chooseScenario(turn: PreparedTurn, saved: InterviewSession) {
  if (scenario === 'silence' && report.turns.length === 1) return { name: 'healthy_silence', instruction: '' };
  if (scenario === 'silence') return { name: 'silence_recovery_answer', instruction: '질문의 요구에 맞춰 짧지만 구체적인 답변을 합니다.' };
  const root = saved.turns.find(t => t.id === turn.parentMainQuestionId)!;
  const q = root.questionText;
  const key = root.id, count = marks.get(key) ?? 0; marks.set(key, count + 1);
  if (probeAbsurd && report.turns.length <= 2) return {
    name: report.turns.length === 1 ? 'probe_absurd_first_answer' : 'probe_absurd_repeated_answer',
    instruction: '현재 질문이 어떤 내용이든 질문에 답하지 않습니다. "달고양이라면"이라는 표현을 그대로 포함해, 달나라 고양이가 라면 가게에서 감자 동전으로 라면값을 냈다는 터무니없는 말만 존댓말 한 문장으로 합니다. 실험·학과·지원·조사·학업 내용과 연결하거나 비유로 포장하지 않습니다.',
  };
  if (scenario === 'coverage' && /뉴스카드/u.test(q)) return { name: 'sufficient_specific_role', instruction: '뉴스카드의 글자 크기와 신청 안내 문구를 본인이 고쳤다는 개인 행동을 한 문장으로 분명하게 답합니다. 다른 조건을 덧붙이지 않습니다.' };
  if (scenario === 'coverage' && /지원 전공으로 선택/u.test(q)) return { name: 'sufficient_major_motive', instruction: '수업에서 화학 원리를 배우며 실제 환경·에너지 문제에 적용하고 싶어졌다는 개인적인 지원 계기 한 가지를 짧게 답합니다.' };
  if (/온도.*전해질/u.test(q)) return count === 0
    ? { name: 'partial_concept', instruction: '약전해질의 온도 상승에 따른 전도도 변화만 짧게 설명합니다. 강전해질 설명은 의도적으로 생략합니다.' }
    : { name: 'complete_missing_concept', instruction: '현재 질문에서 빠졌다고 묻는 강전해질의 전도도 변화와 이유를 짧게 설명합니다. 잘못 말한 부분이 있다면 명시적으로 정정하고 설명합니다.' };
  if (/지원 전공으로 선택/u.test(q)) return count === 0
    ? { name: 'first_absurd_off_topic', instruction: '질문과 전혀 무관한 답변을 합니다. 달에서 고양이와 라면 가게를 열었다는 터무니없는 이야기를 한 문장으로 말하며, 화학·학과·지원동기와 연결하지 않습니다.' }
    : count === 1 ? { name: 'repeated_absurd_off_topic', instruction: '재안내에도 질문과 전혀 무관하게, 달나라 고양이가 라면값을 감자로 냈다는 터무니없는 이야기만 한 문장으로 합니다. 지원동기로 포장하지 않습니다.' }
    : { name: 'unexpected_extra_motive_probe', instruction: '질문을 반복해도 계기는 떠오르지 않는다고 정중하게 말합니다.' };
  if (/뉴스카드/u.test(q)) return count === 0
    ? { name: 'vague_role', instruction: '본인이 맡은 구체 행동을 말하지 않고 다 같이 열심히 했고 잘 끝났다는 막연한 한 문장으로만 답합니다.' }
    : { name: 'specific_role_with_correction', instruction: '제가 인쇄도 했다고 할 뻔했는데 인쇄는 팀원이 맡았다고 분명히 바로잡습니다. 본인은 뉴스카드의 글자 크기와 안내 문구를 고치고 양로원에서 신청 방법을 설명했다고 답합니다.' };
  if (/버추얼 시티/u.test(q)) return count === 0
    ? { name: 'repeat_audio_request', instruction: '질문 내용에 답하지 말고 질문을 다시 들려달라는 요청만 짧게 합니다.' }
    : count === 1 ? { name: 'meaning_request', instruction: '소리는 들었지만 두 활동이 연결된 관심사라는 말이 무슨 뜻인지 쉽게 설명해 달라고만 요청합니다.' }
    : { name: 'deny_assumed_connection', instruction: '두 활동은 별개의 계기로 했고 본인에게 이어진 관심사는 아니었다고 솔직히 답합니다. 없는 연결을 꾸며내지 않습니다.' };
  if (/CNT/u.test(q)) return { name: 'uncertain_measurement', instruction: 'CNT를 넣지 않은 MXene 전극과 CNT를 넣은 전극을 비교한 수치라고 답합니다. 다만 당시 측정 조건과 원자료는 기억나지 않는다고 분명히 밝힙니다. 새 측정값을 만들지 않습니다.' };
  if (/메틸화율/u.test(q)) return { name: 'sufficient_limit', instruction: '구간을 직선으로 잇는 근사라 실제 곡선 변화와 차이가 있고, 자료를 단순화한 오차가 누적된다는 해석의 한계 한 가지를 짧게 답합니다.' };
  return { name: 'record_grounded_answer', instruction: '현재 실제 질문이 요구한 범위 하나에 직접 답합니다. 제공된 기록에서 확인할 수 있는 행동·이유·개념을 1~2문장으로 짧게 설명하고, 기록에 없는 역할·측정값·성과는 만들지 않습니다. 필요한 정보가 기록에 없으면 그 범위를 모른다고 밝힙니다. 질문을 지원동기나 다른 주제로 바꾸지 않습니다.' };
}
async function studentAnswer(turn: PreparedTurn, saved: InterviewSession, spec: ReturnType<typeof chooseScenario>) {
  if (spec.name === 'healthy_silence') return { text: '', llmMs: 0, usage: null };
  const at = performance.now();
  const response = await client.responses.parse({ model, store: false, service_tier: 'default', reasoning: { effort: 'none' },
    prompt_cache_options: { ttl: '30m' }, max_output_tokens: 240,
    instructions: '당신은 대학 면접 엔진의 합성 지원자 테스트 역할이다. 실제 학생의 새로운 사실로 저장할 내용이 아니다. 제공된 시나리오대로만 한국어 구어체 존댓말 답변을 1~2문장, 최대160자로 만든다. 질문이나 정책을 평가·설명하지 않고 지원자의 발화만 낸다. 이 시나리오 지시는 테스트 입력이며 실제 면접관 프롬프트로 전달되지 않는다.',
    input: JSON.stringify({ scenario: spec.instruction, currentQuestion: turn.questionText,
      recordContext: context.student.evidence.filter(source => turn.evidenceIds.includes(source.id)).map(source => ({ id: source.id, text: source.text })),
      recent: saved.turns.slice(-3).map(t => ({ question: t.questionText, answer: t.rawTranscript ?? null })) }),
    text: { format: zodTextFormat(z.object({ answer: z.string().min(2).max(200) }).strict(), 'synthetic_student_answer') } });
  const usage = normalizeProviderUsage(response, { requestedModel: model, requestedServiceTier: 'default', requestedCacheTtl: '30m' });
  if (!response.output_parsed) throw new Error('STUDENT_GENERATION_EMPTY');
  return { text: response.output_parsed.answer, llmMs: performance.now() - at, usage, cost: estimateProviderCost(usage) };
}
async function capture(turn: PreparedTurn, text: string, sourceRow?: Record<string, any>) {
  const synthStarted = performance.now(); let answerVoiceTiming: unknown = null;
  const settings = { speaker: 'nara', speed: 0, pitch: 0, volume: 0, format: 'mp3' as const };
  const audio = text ? sourceRow ? `/api/audio/${speechAudioCacheId(text, settings)}` : await synthesizeSpeech(text, 'nara', { settings, onTiming: t => { answerVoiceTiming = t; } }) : null;
  const bytes = audio ? await readSpeechAudio(audio.slice('/api/audio/'.length)) : null;
  if (audio && !bytes) throw new Error('REPLAY_OR_SYNTHETIC_AUDIO_MISSING');
  const decoded = bytes ? await decodeSyntheticAudio(bytes) : { pcm: Buffer.alloc(sourceRow?.capture?.pcmBytes ?? 32000 * 2), durationMs: (sourceRow?.capture?.pcmBytes ?? 64000) / 32 };
  const decodedSpeechAudioMs = decoded.durationMs;
  if (text && trailingSilenceMs) { decoded.pcm = Buffer.concat([decoded.pcm, Buffer.alloc(trailingSilenceMs * 32)]); decoded.durationMs += trailingSilenceMs; }
  if (sourceRow && decoded.pcm.length !== sourceRow.capture.pcmBytes) throw new Error('REPLAY_PCM_LENGTH_CHANGED');
  const frozen = sourceRow ? replayInputManifest.answers.find((input: any) => input.sourcePath === replayPath && input.sourceIndex === sourceRow.index) : null;
  if (sourceRow && (!frozen || frozen.answerSha256 !== replayHash(text) || frozen.reconstructedBaselinePcmSha256 !== replayHash(decoded.pcm) || frozen.mp3Sha256 !== (bytes ? replayHash(bytes) : null))) throw new Error('FROZEN_REPLAY_AUDIO_CHANGED');
  const exactReplayInput = sourceRow ? { sourceIndex: sourceRow.index, answerSha256: replayHash(text),
    baselineAnswerSha256: replayHash(sourceRow.syntheticStudent.text), mp3Sha256: bytes ? replayHash(bytes) : null,
    pcmSha256: replayHash(decoded.pcm), pcmBytesEqual: decoded.pcm.length === sourceRow.capture.pcmBytes,
    reconstructedBaselinePcmSha256: frozen.reconstructedBaselinePcmSha256,
    pcmHashEqualToFrozenBaseline: replayHash(decoded.pcm) === frozen.reconstructedBaselinePcmSha256,
    originalPcmBytes: sourceRow.capture.pcmBytes, studentTtsProviderCalls: 0,
    note: 'Baseline PCM hash reconstructed from the same immutable cached MP3, decoder and recorded tail; old run did not store a PCM hash.' } : null;
  const captureState = stagedCaptures.get(turn.id) ?? { answerId: randomUUID(), captureRevision: 0, totalAudioMs: 0 };
  captureState.captureRevision++; captureState.totalAudioMs += decoded.durationMs;
  if (stagedCapture) stagedCaptures.set(turn.id, captureState);
  const answerSynthMs = performance.now() - synthStarted, answerId = stagedCapture ? captureState.answerId : randomUUID(), events: Array<Record<string, any>> = [];
  const captureScope = { turnId: turn.id, answerId, ...(stagedCapture ? { captureRevision: captureState.captureRevision } : {}) };
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/realtime?sessionId=${sessionId}`, { origin });
  let startedAt = 0, submittedAt = 0, finalizedAt = 0;
  const waits = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let terminalError: Error | null = null;
  const wait = (type: string, ms: number) => new Promise<any>((resolve, reject) => {
    if (terminalError) return reject(terminalError);
    const timer = setTimeout(() => { waits.delete(type); reject(new Error(`WS_${type}_TIMEOUT`)); }, ms);
    waits.set(type, { resolve, reject, timer });
  });
  socket.on('message', bytes => {
    const event = JSON.parse(bytes.toString()); events.push({ ...event, observedAtMs: performance.now() - start });
    if (event.type === 'error') {
      terminalError = new Error(`WS_${event.code}: ${event.message}`);
      for (const pending of waits.values()) { clearTimeout(pending.timer); pending.reject(terminalError); } waits.clear();
    }
    const pending = waits.get(event.type);
    if (pending) { clearTimeout(pending.timer); waits.delete(event.type); pending.resolve(event); }
  });
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const ready = wait('started', 25000); socket.send(JSON.stringify({ type: 'start', ...captureScope })); await ready;
    startedAt = performance.now();
    // Actual real-time PCM transmission; only question delivery uses a simulated clock.
    for (let offset = 0; offset < decoded.pcm.length; offset += 3200) {
      if (terminalError) throw terminalError;
      socket.send(decoded.pcm.subarray(offset, offset + 3200), { binary: true });
      const delay = startedAt + Math.min(offset + 3200, decoded.pcm.length) / 32 - performance.now();
      if (delay > 0) await sleep(delay);
    }
    submittedAt = performance.now();
    const done = wait('finalized', 20000); socket.send(JSON.stringify({ type: 'finish', ...captureScope, ...(stagedCapture ? { staged: true } : {}) }));
    const final = await done; finalizedAt = performance.now(); logicalMs += decoded.durationMs;
    return { answerId, captureRevision: stagedCapture ? captureState.captureRevision : undefined, metricsDurationMs: stagedCapture ? captureState.totalAudioMs : decoded.durationMs, rawTranscript: final.rawTranscript, knownSyntheticSilence: !text, pcmBytes: decoded.pcm.length, audioDurationMs: decoded.durationMs,
      audioInputProof: { studentTextSha256: replayHash(text), mp3Sha256: bytes ? replayHash(bytes) : null,
        pcmSha256: replayHash(decoded.pcm), source: sourceRow ? 'frozen-original' : 'new-synthetic-test-audio' },
      answerSynthMs, answerVoiceTiming, decodedSpeechAudioMs, trailingSilenceMs: text ? trailingSilenceMs : 0,
      exactReplayInput,
      streamWallMs: submittedAt - startedAt, sttFinalizeMs: finalizedAt - submittedAt,
      submittedAt, finalizedAt, events };
  } finally { socket.close(); for (const pending of waits.values()) clearTimeout(pending.timer); }
}
async function advance(turn: PreparedTurn, captured: Awaited<ReturnType<typeof capture>>) {
  const events: Array<Record<string, any>> = [], at = performance.now();
  const body = { turnId: turn.id, answerId: captured.answerId, elapsedMs: logicalMs, ...(stagedCapture ? { captureRevision: captured.captureRevision } : {}),
    metrics: { speech: { durationMs: captured.metricsDurationMs, speakingMs: captured.knownSyntheticSilence && captured.metricsDurationMs === captured.audioDurationMs ? 0 : null, firstSpeechMs: null },
      verification: { syntheticTest: true, syntheticVoice: true, syntheticClientObservation: true, scenario } } };
  let candidateId: string | undefined;
  if (stagedCapture) {
    const candidateKey = `${turn.id}:${captured.answerId}:${captured.captureRevision}`;
    candidateId = stagedAdvancements.get(candidateKey);
    if (!candidateId) {
    const candidate = await request(`/api/sessions/${sessionId}/answer-candidate`, { ...body,
      endingObservation: { stopSource: 'button', lastSpeechMs: null, trailingSilenceMs: null, speechActiveAtEnd: null, vadAvailable: false } }, 90000);
    candidateId = candidate.candidateId;
    if (candidate.action === 'CONTINUE_ANSWER') return { status: 200, events: [{ type: 'answer_continues', candidateId }], nextMs: performance.now() - at, submitToNextReadyMs: performance.now() - captured.submittedAt, requestBody: body };
    if (candidateId) stagedAdvancements.set(candidateKey, candidateId);
    }
  }
  const response = await fetch(`${base}/api/sessions/${sessionId}/next`, { method: 'POST', headers: { Origin: origin,
    'Content-Type': 'application/json', Accept: 'application/x-ndjson', Connection: 'close' }, body: JSON.stringify({ ...body, ...(candidateId ? { candidateId } : {}) }), signal: AbortSignal.timeout(90000) });
  if (!response.ok) return { status: response.status, error: await response.json(), events, nextMs: performance.now() - at, requestBody: body };
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let pending = '';
  const consume = (line: string) => { if (line.trim()) events.push({ ...JSON.parse(line), afterSubmitMs: performance.now() - captured.submittedAt, afterNextRequestMs: performance.now() - at }); };
  try { while (true) { const chunk = await reader.read(); if (chunk.done) break; pending += decoder.decode(chunk.value, { stream: true }); let idx; while ((idx = pending.indexOf('\n')) >= 0) { consume(pending.slice(0, idx)); pending = pending.slice(idx + 1); } } consume(pending + decoder.decode()); }
  finally { reader.releaseLock(); }
  return { status: response.status, events, nextMs: performance.now() - at, submitToNextReadyMs: performance.now() - captured.submittedAt, requestBody: body };
}
try {
  const deadline = Date.now() + 30000;
  while (true) {
    if (child.exitCode !== null) throw new Error('ISOLATED_REALTIME_SERVER_EXITED');
    try { const h = await request('/api/health', undefined, 1000); if (h.ok) break; } catch { /* bounded startup poll */ }
    if (Date.now() > deadline) throw new Error('SERVER_STARTUP_TIMEOUT'); await sleep(250);
  }
  report.sourceStatus = await request('/api/status');
  if (!report.sourceStatus.ready || report.sourceStatus.sources.questionBankKey !== bank.key) throw new Error('LIVE_SOURCE_NOT_READY');
  const preparing = performance.now();
  const initial = replayCheckpoint ? { sessionId: replayCheckpoint.id, turn: replayCheckpoint.turns[0], durationSeconds: replayCheckpoint.durationSeconds }
    : await request('/api/sessions', { preparationId: (await request('/api/prepare', {})).preparationId });
  report.prepareMs = performance.now() - preparing;
  if (replayCheckpoint) { await request(`/api/sessions/${replayCheckpoint.id}`); report.prepareScope = 'bank checkpoint restoration; no prepare/create endpoint measured'; }
  sessionId = initial.sessionId; report.sessionId = sessionId; report.durationSeconds = initial.durationSeconds;
  report.runtimePolicy = (await persisted()).runtime?.runtimePolicy;
  let turn: PreparedTurn | null = initial.turn;
  const presented = new Set<string>();
  for (let index = 0; turn && index < turnLimit; index++) {
    const row: Record<string, any> = { index, turnId: turn.id, question: turn.questionText, questionKind: turn.questionKind,
      clusterId: turn.parentMainQuestionId, mainIndex: turn.mainIndex, followUpIndex: turn.followUpIndex,
      acknowledgement: turn.acknowledgement, interviewerId: turn.interviewerId };
    report.turns.push(row); await save();
    const pendingState = await persisted();
    const rootQuestion = pendingState.turns.find(current => current.id === turn!.parentMainQuestionId)!.questionText;
    const replayRow = replay ? nextReplayAnswer(replay, rootQuestion, replayedIndices) : null;
    const supplement = Boolean(replay && !replayRow && turn.questionKind !== 'main' && supplementCount < supplementLimit &&
      maySupplementReplayRoot(replay, rootQuestion, replayedIndices));
    if (replay && !replayRow && !supplement) {
      row.notAnswered = true;
      report.turns.pop();
      report.replay.unansweredPreparedQuestion = row;
      report.replay.divergence = { type: replayedIndices.size === replay.turns.length ? 'baseline_answer_set_exhausted' : 'unmatched_or_exhausted_cluster',
        actualQuestion: turn.questionText, actualRoot: rootQuestion, unusedSourceIndices: replay.turns.filter(item => !replayedIndices.has(item.index)).map(item => item.index) };
      await save(); break;
    }
    if (!presented.has(turn.id)) { row.presentation = await present(turn); presented.add(turn.id); }
    else row.presentation = { continuedSameQuestion: true, questionReplayed: false };
    const before = await persisted(); row.followUpsBefore = before.followUpCountByMainQuestion[turn.parentMainQuestionId] ?? 0;
    const spec = replayRow ? { name: replayRow.scenario, instruction: '' } : supplement ? {
      name: 'adaptive_synthetic_supplement',
      instruction: '합성 면접 테스트의 추가 답변입니다. 현재 질문이 새로 묻는 범위에만 답하고 이미 말한 행동·정정과 모순되지 않게 합니다. 기준이나 이유를 물으면 구체적인 기준 하나만 짧게 설명합니다. 측정값·성과·팀원의 일을 새로 만들지 않으며 기억나지 않는 범위는 모른다고 밝힙니다. 실제 학생의 공식 기록이 아닙니다.',
    } : chooseScenario(turn, before); row.scenario = spec.name;
    if (scenario === 'silence' && index === 0 && spec.name !== 'healthy_silence') throw new Error('SILENCE_SCENARIO_NOT_EXERCISED');
    if (supplement) {
      supplementCount++; report.replay.adaptiveSupplementCount = supplementCount;
      report.replay.newStudentGenerationCalls++;
      row.adaptiveSupplement = { index: supplementCount, rootQuestion, reason: 'original-root-answer-set-exhausted', comparedAsFrozenInput: false };
    }
    try { row.syntheticStudent = replayRow ? { text: replayRow.syntheticStudent.text, llmMs: 0, usage: null,
      replaySourceIndex: replayRow.index, originalLlmGenerationMs: replayRow.syntheticStudent.llmMs,
      answerSha256: replayHash(replayRow.syntheticStudent.text) } : await studentAnswer(turn, before, spec); }
    catch (error) {
      const usage = normalizeProviderUsage(null, { requestedModel: model, requestedServiceTier: 'default', requestedCacheTtl: '30m' });
      row.syntheticStudentGenerationFailure = { usage, estimatedCost: estimateProviderCost(usage) }; await save(); throw error;
    }
    if (replayRow) { replayedIndices.add(replayRow.index); row.baseline = { index: replayRow.index, question: replayRow.question,
      questionKind: replayRow.questionKind, scenario: replayRow.scenario, rootQuestion,
      questionSurfaceChanged: turn.questionText !== replayRow.question, questionKindChanged: turn.questionKind !== replayRow.questionKind,
      action: replayRow.coreDecision?.nextAction, rawTranscript: replayRow.capture.rawTranscript,
      nextQuestion: replayRow.next?.question, nextKind: replayRow.next?.kind, responseStatus: replayRow.response?.status,
      submitToNextReadyMs: replayRow.response?.submitToNextReadyMs, sttFinalizeMs: replayRow.capture.sttFinalizeMs };
    }
    await save();
    row.capture = await capture(turn, row.syntheticStudent.text, replayRow ?? undefined); await save();
    row.response = await advance(turn, row.capture);
    if (process.argv.includes('--retry-once') && row.response.status === 503) {
      row.firstFailedResponse = row.response;
      row.firstFailedDecision = (await persisted()).turns.find(t => t.id === turn!.id)?.metadata.coreDecision;
      // An explicitly requested retry of the SAME finalized answer; never replay PCM or skip a topic.
      row.response = await advance(turn, row.capture);
      row.explicitRetryCount = 1;
    }
    const snapshot = await persisted(), previous = snapshot.turns.find(t => t.id === turn!.id)!;
    row.coreDecision = previous.metadata.coreDecision; row.answerObservation = previous.answerObservation;
    const candidate = Object.values(snapshot.runtime?.answerCandidates ?? {}).find(candidate => candidate.turnId === turn!.id && candidate.answerId === row.capture.answerId && candidate.captureRevision === row.capture.captureRevision);
    row.answerCandidateId = candidate?.id ?? null;
    row.candidateDecision = candidate?.decision ?? null;
    row.coreCallsForCandidate = candidate?.decision?.providerTimings.coreModelCalls ?? null;
    row.providerTimings = previous.metadata.providerTimings;
    row.followUpsAfter = snapshot.followUpCountByMainQuestion[turn.parentMainQuestionId] ?? 0;
    row.answerIdPreserved = previous.answerId === row.capture.answerId;
    row.transcriptPreserved = previous.rawTranscript === row.capture.rawTranscript;
    const final = row.response.events.find((e: any) => e.type === 'turn_ready');
    row.next = final?.turn ? { turnId: final.turn.id, question: final.turn.questionText, kind: final.turn.questionKind,
      clusterId: final.turn.parentMainQuestionId, followUpIndex: final.turn.followUpIndex,
      acknowledgement: final.turn.acknowledgement, interviewerId: final.turn.interviewerId } : null;
    row.closing = final?.closingUtterance ?? null;
    console.log(JSON.stringify({ index, scenario: row.scenario, kind: row.questionKind, transcript: row.capture.rawTranscript,
      action: row.coreDecision?.nextAction, next: row.next?.question, nextKind: row.next?.kind,
      sttMs: Math.round(row.capture.sttFinalizeMs), nextMs: Math.round(row.response.nextMs), status: row.response.status,
      failure: row.coreDecision?.failureDetail ?? null }));
    await save();
    if (row.response.events.some((event: any) => event.type === 'answer_continues')) { row.continuedSameAnswer = true; continue; }
    if (!final || row.response.status !== 200) { report.failures.push({ index, response: row.response }); break; }
    if (final.done) { report.naturalEnding = { reason: final.closingUtterance?.reason, remainingMs: initial.durationSeconds * 1000 - logicalMs, closing: final.closingUtterance }; break; }
    turn = final.turn;
  }
} catch (error) {
  report.failures.push({ error: error instanceof Error ? error.message : 'unknown', serverOutput: maskConversationSecrets(serverOutput) });
} finally {
  if (sessionId) {
    try {
      const closing = await request(`/api/sessions/${sessionId}/closing`, { reason: 'user_ended', elapsedMs: logicalMs });
      report.closing = closing.closingUtterance;
      if (closing.closingUtterance?.audioUrl) report.closingAudio = { ...(await fetchAudio(closing.closingUtterance.audioUrl)), pcm: undefined, actualPlaybackObserved: false };
    } catch (error) { report.failures.push({ stage: 'closing', error: error instanceof Error ? error.message : 'unknown' }); }
    // Mark/end the synthetic session even when optional closing preparation fails.
    try {
      if (process.argv.includes('--defer-evaluation')) {
        report.evaluationNotRequested = true; report.finalSession = await persisted();
        report.endedThroughApi = false;
      } else {
      await request(`/api/sessions/${sessionId}/end`, { elapsedMs: logicalMs, metrics: { verification: {
        syntheticTest: true, syntheticVoice: true, syntheticClientObservation: true, scenario: `live-http-ws-${scenario}`,
        actualBrowserPlayback: false, rawTranscriptCorrected: false } } }); ended = true;
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const saved = await persisted();
        if (['completed', 'failed'].includes(saved.evaluationStatus)) { report.finalSession = saved; break; }
        await sleep(500);
      }
      report.finalSession ??= await persisted();
      if (report.finalSession.evaluationStatus !== 'completed' || !report.finalSession.evaluation) {
        report.failures.push({ stage: 'evaluation', status: report.finalSession.evaluationStatus,
          error: report.finalSession.evaluationError ?? 'EVALUATION_RESULT_NOT_COMPLETED' });
      }
      }
    } catch (error) { report.failures.push({ stage: 'end', error: error instanceof Error ? error.message : 'unknown' }); }
  }
  report.endedThroughApi = ended; report.completedAt = new Date().toISOString();
  report.wallMs = performance.now() - start; report.simulatedInterviewElapsedMs = logicalMs;
  if (probeAbsurd) {
    const probes = report.turns.filter((row: any) => row.scenario?.startsWith('probe_absurd_'));
    report.absurdProbe = { requested: true, intendedAnswerCount: 2, attemptedAnswers: probes.length,
      sameRootObserved: probes.length === 2 && probes[0].clusterId === probes[1].clusterId,
      sameQuestionTurnObserved: probes.length === 2 && probes[0].turnId === probes[1].turnId,
      scenarioInstructionsDeliveredOnlyToSyntheticStudent: true, runtimeInstructionsInjected: false };
    if (probes.length === 2 && !report.absurdProbe.sameRootObserved) report.failures.push({ stage: 'absurd_probe', reason: 'ENGINE_MOVED_TO_DIFFERENT_ROOT_BEFORE_SECOND_PROBE' });
  }
  report.coreCallAccounting = { candidates: [...new Map(report.turns.filter((row: any) => row.answerCandidateId).map((row: any) => [row.answerCandidateId, { candidateId: row.answerCandidateId, coreModelCalls: row.coreCallsForCandidate }])).values()],
    studentGenerationCalls: report.turns.filter((row: any) => row.syntheticStudent?.usage).length };
  if (replay) { const captured = report.turns.filter((row: any) => row.capture?.exactReplayInput);
    const finalizedSourceIndices = new Set<number>(captured.map((row: any) => row.capture.exactReplayInput.sourceIndex));
    report.replay.attemptedSourceIndices = [...replayedIndices]; report.replay.replayedSourceIndices = [...finalizedSourceIndices];
    report.replay.unusedSourceIndices = replay.turns.filter(row => !finalizedSourceIndices.has(row.index)).map(row => row.index);
    report.replay.allOriginalAnswersFinalized = captured.length === replay.turns.length;
    report.replay.allOriginalAnswersReady = captured.length === replay.turns.length && captured.every((row: any) => row.response?.status === 200);
    report.replay.allReplayedAnswersIdentical = captured.length > 0 && captured
      .every((row: any) => row.capture.exactReplayInput.answerSha256 === row.capture.exactReplayInput.baselineAnswerSha256 && row.capture.exactReplayInput.pcmHashEqualToFrozenBaseline);
  }
  report.logPath = sessionId ? `data/conversation-logs/${sessionId}.jsonl` : null;
  const endingSource = await replayEngineSourceFingerprints();
  report.engineSourceUnchanged = JSON.stringify(engineSourceSha256) === JSON.stringify(endingSource);
  if (!report.engineSourceUnchanged) report.engineSourceSha256After = endingSource;
  await save();
  child.kill();
  evaluationWorker.kill();
}
console.log(JSON.stringify({ output, sessionId, turns: report.turns.length, failures: report.failures.length,
  evaluation: report.finalSession?.evaluationStatus, elapsedMs: logicalMs, wallMs: report.wallMs }));
if (report.failures.length || !ended && !report.evaluationNotRequested) process.exitCode = 1;
