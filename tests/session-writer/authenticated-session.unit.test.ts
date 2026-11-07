import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadInterviewContext } from '../fixtures/runtime-context';
import { createInterviewPlan } from '../../server/interview-planner';
import { createInterviewSession, acceptSessionEndRequest, finalizeSessionEndState, applySessionClientEvent, observeFinalizedAnswer } from '../../server/session-lifecycle';
import { createSessionRuntime, createAuthenticatedSessionRuntime, restoreAuthenticatedSession, restoreLogicalSession, SESSION_RECOVERY_WINDOW_MS } from '../../server/session-runtime';
import { encodeAuthenticatedSessionEnvelope, decodeAuthenticatedSessionEnvelope } from '../../server/contracts/authenticated-session-codec';
import { LocalSessionStore } from '../../server/storage/local-session-store';
import type { RecordedTurn } from '../../server/protocol';
import type { ConversationEvent } from '../../server/storage/conversation-log';
import { createSessionClosingPreparer } from '../../server/session-closing';
import { SessionDomainError } from '../../server/session-lifecycle';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const instant = '2026-11-07T00:00:00.000Z';
async function fixture() {
  const context = await loadInterviewContext();
  context.target = { ...context.target, studentName: '익명 합성 학생', university: '합성대학교', department: '합성학과', track: '합성전형' } as unknown as typeof context.target;
  context.manifest.target = context.target;
  const plan = createInterviewPlan(context, 'auth-session-fixture');
  const runtime = createAuthenticatedSessionRuntime(context, 'owner-a', instant);
  const session = createInterviewSession(context, plan, runtime, { id: '11111111-1111-4111-8111-111111111111', now: instant });
  const turn: RecordedTurn = { id: '22222222-2222-4222-8222-222222222222', questionText: '합성 탐구에서 비교한 자료를 설명해 주세요.', questionKind: 'main', parentMainQuestionId: '22222222-2222-4222-8222-222222222222',
    mainIndex: 1, mainCount: plan.mainQuestionTarget, followUpIndex: 0, evidenceIds: ['e-synthetic'], questionAudioUrl: '/api/audio/synthetic.mp3', acknowledgement: null, acknowledgementAudioUrl: null, interviewerId: 'interviewer-1',
    metadata: { acknowledgementQuote: null, evidenceQuotes: [], primaryFunction: 'FACT', questionIntent: '합성 탐구의 자료 확인', targetEvidence: ['선택한 자료'], depth: 'D1', groundingRationale: '구조용 합성 자료', validationStatus: 'approved', validationFailures: [],
      rulesVersion: context.manifest.rulesVersion, generatedAt: instant, answerTurnId: null, sourceRefIds: [], activityIds: [], supportTarget: context.target, questionClusterId: '22222222-2222-4222-8222-222222222222', parentQuestionId: null },
  };
  session.turns.push(turn); session.followUpCountByMainQuestion[turn.id] = 0;
  return { context, session, turn };
}

test('E authenticated codec preserves raw CRLF, numeric spelling, Unicode and unknown metadata independently of context domain pins', async () => {
  const { context, session } = await fixture();
  session.metrics = { quote: 'A🙂한글\r\n인용', utf16: [1, 3], unknown: null };
  const original = encodeAuthenticatedSessionEnvelope(session, context);
  const sessionJson = JSON.stringify(session, null, 2).replaceAll('\n', '\r\n').replace('"elapsedMs": 0', '"elapsedMs": 0e0');
  const contextJson = JSON.stringify(context, null, 2).replaceAll('\n', '\r\n');
  const raw = { ...original, sessionJson, sessionSha256: sha(sessionJson), contextJson, contextSha256: sha(contextJson) };
  const decoded = decodeAuthenticatedSessionEnvelope(raw, 'owner-a');
  assert.equal(decoded.envelope.sessionJson, sessionJson); assert.equal(decoded.envelope.contextJson, contextJson);
  assert.notEqual(raw.contextSha256, session.runtime!.contextSnapshotSha256);
  assert.deepEqual(decoded.session, session); assert.equal((decoded.session.metrics as { quote: string }).quote.slice(1, 3), '🙂');
  assert.equal(JSON.stringify(decoded.envelope), JSON.stringify(raw));
});

test('E codec refuses local masquerade, changed raw bytes, owner mismatch and context substitution', async () => {
  const { context, session } = await fixture(), encoded = encodeAuthenticatedSessionEnvelope(session, context);
  assert.throws(() => decodeAuthenticatedSessionEnvelope(encoded, 'owner-b'), /AUTH_SESSION_OWNER_MISMATCH/u);
  assert.throws(() => decodeAuthenticatedSessionEnvelope({ ...encoded, sessionJson: encoded.sessionJson + ' ' }, 'owner-a'), /AUTH_SESSION_BYTES_CHANGED/u);
  const local = structuredClone(session); local.runtime = createSessionRuntime(context, { id: 'owner-a', mode: 'local-development' }, instant);
  assert.throws(() => encodeAuthenticatedSessionEnvelope(local, context), /AUTH_SESSION_ENVELOPE_INVALID/u);
  const changed = JSON.stringify({ ...context, questionGuidelines: '다른 합성 규정' });
  assert.throws(() => decodeAuthenticatedSessionEnvelope({ ...encoded, contextJson: changed, contextSha256: sha(changed) }, 'owner-a'), /AUTH_SESSION_CONTEXT_CHANGED/u);
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/export-authenticated-session-schemas.ts', '--check'], { cwd: process.cwd(), windowsHide: true });
});

test('E runtime uses the existing ten-minute recovery policy and the local writer refuses authenticated payloads before filesystem writes', async () => {
  const { context, session, turn } = await fixture();
  turn.answerId = 'answer-1'; turn.rawTranscript = '미확정 합성 원문'; turn.transcriptStatus = 'streaming';
  const restored = restoreAuthenticatedSession(session, 'owner-a', Date.parse(instant) + 1_000);
  assert.equal(restored.runtime!.owner.mode, 'authenticated'); assert.equal(restored.runtime!.epoch, 1); assert.equal(restored.turns[0].transcriptStatus, 'paused');
  assert.equal(session.turns[0].transcriptStatus, 'streaming'); assert.equal(restored.turns[0].rawTranscript, turn.rawTranscript);
  assert.throws(() => restoreAuthenticatedSession(session, 'owner-a', Date.parse(instant) + SESSION_RECOVERY_WINDOW_MS + 1), /SESSION_RECOVERY_EXPIRED/u);
  assert.throws(() => restoreLogicalSession(session, 'owner-a', Date.parse(instant)), /SESSION_OWNER_MISMATCH/u);
  const local = structuredClone(session); local.runtime = createSessionRuntime(context, { id: 'owner-a', mode: 'local-development' }, instant);
  assert.throws(() => restoreAuthenticatedSession(local, 'owner-a', Date.parse(instant)), /AUTHENTICATED_SESSION_OWNER_MISMATCH/u);
  const directory = path.resolve(os.tmpdir(), 'auth-must-not-write-' + randomUUID());
  assert.throws(() => new LocalSessionStore(directory).save(session), /LOCAL_SESSION_WRITER_ONLY/u);
  await assert.rejects(access(directory), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
});

test('E shares first accepted end input and confirmed-capture finalization while preserving device failure and frozen playback boundaries', async () => {
  const { session, turn } = await fixture(), events: ConversationEvent[] = [];
  turn.answerId = 'answer-1'; turn.rawTranscript = '아직 확인되지 않은 전사'; turn.transcriptStatus = 'paused';
  turn.metadata.answerSubmissionMode = 'staged-v2'; turn.metadata.answerCaptureRevision = 1;
  const scope = { turnId: turn.id, answerId: turn.answerId, captureRevision: 1 };
  acceptSessionEndRequest(session, { elapsedMs: 1234, metrics: { captureFinishScope: scope, marker: 'first' } }, { now: () => instant });
  acceptSessionEndRequest(session, { elapsedMs: 9999, metrics: { captureFinishScope: { ...scope, answerId: 'stale' }, marker: 'second' } });
  assert.equal(session.runtime!.acceptedEndRequest!.elapsedMs, 1234); assert.equal(session.runtime!.acceptedEndRequest!.metrics.marker, 'first');
  finalizeSessionEndState(session, { activeStreamsFlushed: false, now: () => instant, onEvent: event => events.push(event) });
  assert.equal(session.status, 'ending'); assert.equal(turn.transcriptStatus, 'error'); assert.equal(turn.rawTranscript, '아직 확인되지 않은 전사');
  assert.equal(session.runtime!.evaluationJob, undefined); assert.equal(session.runtime!.evaluationInputFrozenAt, undefined);
  session.runtime!.evaluationInputFrozenAt = instant;
  const frozen = JSON.stringify(session);
  const applied = applySessionClientEvent(session, { eventId: randomUUID(), type: 'question_playing', turnId: turn.id, atMs: 10, clockId: randomUUID(), payload: { elapsedMs: 9999 } });
  assert.equal(applied.persist, false); assert.equal(JSON.stringify(session), frozen);
  assert.ok(events.some(event => event.type === 'error')); assert.ok(events.some(event => event.type === 'session.ended'));
  turn.transcriptStatus = 'finalized'; turn.rawTranscript = ''; turn.metrics = { speech: { durationMs: 1000, speakingMs: 0, firstSpeechMs: null } };
  turn.metadata.answerEndingObservation = { stopSource: 'session_end', lastSpeechMs: null, trailingSilenceMs: 1000, speechActiveAtEnd: false, vadAvailable: true, microphoneEnabled: false };
  observeFinalizedAnswer(session, turn); assert.equal(turn.answerObservation!.classification, 'empty_transcript'); assert.equal(turn.answerObservation!.speechDetected, null);
  turn.metadata.answerEndingObservation.microphoneEnabled = true;
  observeFinalizedAnswer(session, turn); assert.equal(turn.answerObservation!.classification, 'silence_observed');
});

test('E shares the original pinned closing voice and rejects an observed epoch change before publishing late audio', async () => {
  const { session, turn } = await fixture(), events: ConversationEvent[] = [], audioOwners = new Map<string, string>();
  const settings = { speaker: 'pinned-synthetic', speed: 0, pitch: 1, volume: 0, format: 'mp3' as const };
  Object.assign(turn.metadata, { voiceSettings: { question: settings } });
  const defaults = { primary: 'vdaeseong', secondary: 'vmikyung', speed: 0, primarySpeed: 0, secondarySpeed: -1, pitch: 1 } as const;
  let calls = 0;
  const prepare = createSessionClosingPreparer({ ownerId: 'owner-a', audioOwners, HttpError: SessionDomainError, interviewerVoiceDefaults: defaults,
    journal: (_session, event) => events.push(event),
    async synthesizeSpeech(text, speaker, options) { calls++; assert.equal(speaker, settings.speaker); assert.equal(text, '면접은 여기까지 하겠습니다. 수고하셨습니다.');
      assert.deepEqual(options?.settings, settings); options?.onTiming?.({ cache: 'memory', durationMs: 0, providerMs: 0, audioId: 'synthetic', settings }); return '/api/audio/synthetic-closing'; } });
  const first = await prepare(session, 'user_ended'); assert.equal(await prepare(session, 'user_ended'), first); assert.equal(calls, 1);
  assert.equal(first.nonEvaluative, true); assert.equal(first.reason, 'user_ended'); assert.deepEqual(first.voiceSettings, settings); assert.equal(events.length, 1);
  const other = await fixture(); let release!: (audio: string) => void;
  const delayed = createSessionClosingPreparer({ ownerId: 'owner-a', audioOwners, HttpError: SessionDomainError, interviewerVoiceDefaults: defaults,
    journal: (_session, event) => events.push(event), synthesizeSpeech: () => new Promise<string>(resolve => { release = resolve; }) });
  const pending = delayed(other.session, 'user_ended'); other.session.runtime!.epoch++; release('/api/audio/late');
  await assert.rejects(pending, /늦은 음성/u); assert.equal(other.session.runtime!.closingUtterance, undefined); assert.equal(audioOwners.has('/api/audio/late'), false);
});
