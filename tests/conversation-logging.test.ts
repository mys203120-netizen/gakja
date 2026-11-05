import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationLogger, maskConversationSecrets } from '../server/storage/conversation-log';
import { buildConversationReview, exportPrivateReview, parseConversationJsonl, reviewLogsCli, reviewMarkdown } from '../scripts/review-interview-logs';

const sessionId = '11111111-1111-4111-8111-111111111111', turnId = '22222222-2222-4222-8222-222222222222';
async function temporary(run: (directory: string) => Promise<void>) { const directory = await mkdtemp(path.join(os.tmpdir(), 'interview-log-')); try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); } }

test('recursive log masking removes actual environment credentials, secret fields, error causes and binary media', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const error = Object.assign(new Error('request clova-real-secret failed sk-proj-unknownCredential123'), { cause: new Error('Bearer unrelated-token'), apiKey: 'arbitrary-key-field-value' });
  const masked = maskConversationSecrets({ nested: [{ text: 'hello clova-real-secret', clientSecret: 'non-env-secret' }], headers: { 'x-ncp-apigw-api-key-id': 'id-not-in-env' }, apiKeys: { provider: 'another-unconfigured-key' }, keyNames: ['OPENAI_API_KEY'], error, pcm: Buffer.from([1, 2]), cycle }, { CLOVA_SPEECH_SECRET_KEY: 'clova-real-secret' });
  const output = JSON.stringify(masked);
  for (const value of ['clova-real-secret', 'sk-proj-unknownCredential123', 'unrelated-token', 'arbitrary-key-field-value', 'non-env-secret', 'id-not-in-env', 'another-unconfigured-key']) assert.ok(!output.includes(value));
  assert.match(output, /OPENAI_API_KEY/); assert.match(output, /binary_omitted/); assert.match(output, /circular/); assert.ok(!output.includes('stack'));
});

test('numeric provider usage survives redaction while credential tokens and counter-shaped strings remain hidden', () => {
  const value = maskConversationSecrets({ providerTimings: { inputTokens: 1234, outputTokens: 90, cachedInputTokens: 1024, reviewInputTokens: 800, reviewOutputTokens: 42, reviewCachedInputTokens: 0 }, usage: { input_tokens: 1234, output_tokens: 90 }, accessToken: 123456, token: 'bearer-secret', inputTokens: '1234', outputTokens: -1, reviewInputTokens: Number.POSITIVE_INFINITY }) as Record<string, any>;
  assert.deepEqual(value.providerTimings, { inputTokens: 1234, outputTokens: 90, cachedInputTokens: 1024, reviewInputTokens: 800, reviewOutputTokens: 42, reviewCachedInputTokens: 0 });
  assert.deepEqual(value.usage, { input_tokens: 1234, output_tokens: 90 });
  for (const key of ['accessToken', 'token', 'inputTokens', 'outputTokens', 'reviewInputTokens']) assert.equal(value[key], '[redacted]');
});

test('cache-write billing counters remain numeric without exposing counter-shaped credentials',()=>{
  const value=maskConversationSecrets({usage:{cache_write_tokens:1024,ttl_30m_tokens:1024,ttl_12h_tokens:0},cache_write_tokens:'secret-counter',ttl_30m_tokens:-1}) as Record<string,unknown>;
  assert.deepEqual(value.usage,{cache_write_tokens:1024,ttl_30m_tokens:1024,ttl_12h_tokens:0});
  assert.equal(value.cache_write_tokens,'[redacted]');assert.equal(value.ttl_30m_tokens,'[redacted]');
});

test('concurrent append is ordered, append-only, private and idempotent across reopened logger instances', async () => temporary(async directory => {
  const first = new ConversationLogger({ directory }), second = new ConversationLogger({ directory });
  const replies = await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? first : second).append(sessionId, { eventId: `event-${index}`, type: 'stt.partial', actor: 'candidate', turnId, payload: { revision: index, rawTranscript: `관찰 ${index}` } })));
  assert.ok(replies.every(reply => reply.ok));
  const file = path.join(directory, `${sessionId}.jsonl`), prefix = await readFile(file, 'utf8');
  const rows = prefix.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.seq), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.ok(rows.every(row => row.schemaVersion === 1 && /^\d{4}-\d\d-\d\dT/.test(row.timestamp)));
  const reopened = new ConversationLogger({ directory });
  const duplicate = await reopened.append(sessionId, { eventId: 'event-1', type: 'stt.partial', actor: 'candidate', payload: 'must not replace original' });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.seq, replies[1].seq);
  assert.equal((await reopened.append(sessionId, { type: 'session.ended', actor: 'server' })).seq, 41);
  await reopened.flush(); assert.ok((await readFile(file, 'utf8')).startsWith(prefix));
  assert.equal(reopened.getStatus()[0].lastSeq, 41); assert.equal(reopened.getStatus()[0].queued, 0);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
}));

test('simultaneous duplicate event IDs write one row and preserve one sequence', async () => temporary(async directory => {
  const logger = new ConversationLogger({ directory });
  const results = await Promise.all(Array.from({ length: 20 }, () => logger.append(sessionId, { eventId: 'same-event', type: 'playback.started', actor: 'client', role: 'question' })));
  assert.equal(results.filter(result => result.duplicate).length, 19); assert.ok(results.every(result => result.seq === 1));
  assert.equal((await readFile(path.join(directory, `${sessionId}.jsonl`), 'utf8')).trim().split('\n').length, 1);
}));

test('reopening an incomplete JSONL tail keeps old bytes and continues after the last valid sequence', async () => temporary(async directory => {
  const file = path.join(directory, `${sessionId}.jsonl`), original = `${JSON.stringify({ sessionId, seq: 7, eventId: 'old-event' })}\n{"incomplete":`;
  await writeFile(file, original);
  const logger = new ConversationLogger({ directory }); assert.equal((await logger.append(sessionId, { type: 'phase.changed', actor: 'server' })).seq, 8);
  assert.ok((await readFile(file, 'utf8')).startsWith(`${original}\n`)); assert.equal(logger.getStatus()[0].malformedLines, 1);
}));

test('write failure is non-throwing, diagnosable and does not interrupt the caller or escape the log directory', async () => temporary(async directory => {
  const blocker = path.join(directory, 'not-directory'); await writeFile(blocker, 'keep');
  const logger = new ConversationLogger({ directory: path.join(blocker, 'logs') });
  const result = await logger.append(sessionId, { type: 'error', actor: 'server', payload: new Error('hidden') });
  assert.equal(result.ok, false); assert.match(result.error!.code, /ENOTDIR|EEXIST/); assert.equal(logger.getStatus()[0].available, false);
  assert.equal((await logger.flush())[0].failedCount, 1); assert.equal(logger.getStatus()[0].queued, 0);
  assert.equal((await logger.append('../../escape', { type: 'error', actor: 'server' })).error?.code, 'INVALID_LOG_EVENT');
  assert.equal(await readFile(blocker, 'utf8'), 'keep');
}));

const fixtureSession = () => ({ id: sessionId, createdAt: '2026-11-02T00:00:00Z', status: 'completed', evaluationStatus: 'completed', elapsedMs: 12000, turns: [
  { id: turnId, acknowledgement: '안녕하세요', questionText: '첫 질문 고유 원문', rawTranscript: '첫 답변 고유 원문', transcriptStatus: 'finalized', metadata: { clientTimings: { submittedAt: 100, finalizedAt: 180, acknowledgementStarted: 250, questionStarted: 500 }, providerTimings: { llmMs: 55 } } },
  { id: '33333333-3333-4333-8333-333333333333', acknowledgement: '안녕하세요', questionText: '둘째 질문 원문', rawTranscript: '둘째 답변 원문', transcriptStatus: 'finalized', metadata: {} },
] });
test('default offline review reports measured metadata and repetitions without original dialogue; full is explicit', () => {
  const events = [{ sessionId, seq: 1, timestamp: '2026-11-02T00:00:00Z', type: 'provider.config', actor: 'server', payload: { voices: [{ speaker: 'vdaeseong', speed: -1, pitch: 1 }], apiKey: 'NEVER_SHOW' } }];
  const report = buildConversationReview(fixtureSession(), events);
  const output = JSON.stringify(report); assert.doesNotMatch(output, /첫 질문|첫 답변|둘째 질문|안녕하세요|NEVER_SHOW/);
  assert.equal(report.observations.regreetingTurnCount, 1); assert.equal(report.observations.repeatedAcknowledgements[0].count, 2); assert.equal(report.observations.voiceSettings?.[0].speed, -1);
  assert.equal(report.latency.measured.submitToQuestionMs.p50Ms, 400);
  assert.equal(report.session.syntheticTest, null); assert.equal(report.session.provenance, null);
  const full = buildConversationReview(fixtureSession(), events, { full: true }); assert.match(JSON.stringify(full), /첫 질문 고유 원문/); assert.doesNotMatch(reviewMarkdown(full), /NEVER_SHOW/);
  assert.equal(buildConversationReview(fixtureSession(), []).observations.voiceSettings, null);
});

test('review marks provider harness provenance only from explicit stored verification and never guesses real-user origin', () => {
  const session = { ...fixtureSession(), metrics: { verification: { syntheticVoice: true, scenario: 'reaction_repair_transition_fixture', note: '원문 비공개 내용' } } };
  const report = buildConversationReview(session, []);
  assert.equal(report.session.syntheticTest, true); assert.equal(report.session.provenance?.source, 'session.metrics.verification'); assert.equal(report.session.provenance?.scenario, 'reaction_repair_transition_fixture');
  assert.match(reviewMarkdown(report), /합성 테스트 표시: true/); assert.match(reviewMarkdown(report), /reaction_repair_transition_fixture/);
  assert.doesNotMatch(JSON.stringify(report), /원문 비공개 내용/);
  assert.equal(buildConversationReview({ ...fixtureSession(), metrics: { verification: { syntheticVoice: true, syntheticScenario: 'reaction_repair_transition_fixture' } } }, []).session.provenance?.scenario, 'reaction_repair_transition_fixture');
  assert.equal(buildConversationReview({ ...fixtureSession(), metrics: { verification: { scenario: 'arbitrary_fixture_name' } } }, []).session.syntheticTest, null);
});

test('review deduplicates stored reaction metadata and event observations without reclassifying answers', () => {
  const session = fixtureSession(); const reaction = { sourceTurnId: turnId, classification: 'off_topic', action: 'transition', reasonCode: 'RECONFIRMATION_ALREADY_USED', missingTarget: '개인 원문 내용' };
  Object.assign(session.turns[0].metadata, { answerReaction: reaction });
  const report = buildConversationReview(session, [{ seq: 1, type: 'answer.relevance', turnId, payload: reaction }]);
  assert.equal(report.observations.relevance.observedAssessments, 1); assert.equal(report.observations.relevance.offTopicTransitions, 1); assert.equal(report.observations.relevance.reasonCodes.RECONFIRMATION_ALREADY_USED, 1);
  assert.doesNotMatch(JSON.stringify(report), /개인 원문 내용/);
});

test('offline whole-answer signals catch repeated apologies while preserving full-answer scope and no semantic inference', () => {
  const session = fixtureSession();
  session.turns[0].rawTranscript = '죄송합니다.'; session.turns[1].rawTranscript = '죄송합니다.';
  const review = buildConversationReview(session, []);
  assert.equal(review.observations.repeatedAnswers[0].count, 2); assert.equal(review.observations.answerPatternSignals.filter(signal => signal.reasonCode === 'APOLOGY_ONLY').length, 2);
  assert.doesNotMatch(JSON.stringify(review), /죄송합니다/); assert.equal(review.observations.relevance.observedAssessments, 0);
  session.turns[1].rawTranscript = '죄송합니다. 제가 실험 과정에서 맡은 역할은 기록이었습니다.';
  assert.equal(buildConversationReview(session, []).observations.answerPatternSignals.length, 1);
});

test('review CLI is local read-only by default, tolerates bad log rows, exports only new private data files', async () => temporary(async root => {
  await mkdir(path.join(root, 'data/sessions'), { recursive: true }); await mkdir(path.join(root, 'data/conversation-logs'));
  const sessionFile = path.join(root, `data/sessions/${sessionId}.json`), original = JSON.stringify(fixtureSession()); await writeFile(sessionFile, original);
  const logFile = path.join(root, `data/conversation-logs/${sessionId}.jsonl`), log = `${JSON.stringify({ sessionId, seq: 1, type: 'stt.final', actor: 'candidate', payload: { rawTranscript: '로컬 원문' } })}\ninvalid\n`; await writeFile(logFile, log);
  const output = await reviewLogsCli(['--latest'], root); assert.doesNotMatch(output, /고유 원문|로컬 원문/); assert.equal(JSON.parse(output).log.malformedLines, 1);
  assert.equal(JSON.parse(await reviewLogsCli(['--list'], root)).sessions[0].id, sessionId);
  assert.match(await reviewLogsCli(['--session', sessionId, '--full'], root), /첫 답변 고유 원문/);
  await exportPrivateReview(root, 'data/log-reviews/report.json', output); await assert.rejects(exportPrivateReview(root, 'data/log-reviews/report.json', 'overwrite'));
  await assert.rejects(exportPrivateReview(root, 'outside.json', output)); assert.equal(parseConversationJsonl(log).malformedLines, 1);
  assert.equal(await readFile(sessionFile, 'utf8'), original); assert.equal(await readFile(logFile, 'utf8'), log);
}));

test('latest log review skips newer verification runs by default while list and explicit selection retain provenance', async () => temporary(async root => {
  await mkdir(path.join(root, 'data/sessions'), { recursive: true });
  const userFile = path.join(root, 'data/sessions', sessionId + '.json');
  const syntheticId = '44444444-4444-4444-8444-444444444444';
  const syntheticFile = path.join(root, 'data/sessions', syntheticId + '.json');
  await writeFile(userFile, JSON.stringify(fixtureSession())); await utimes(userFile, new Date(1000), new Date(1000));
  for (const flag of ['syntheticTest', 'syntheticProvider', 'syntheticVoice', 'syntheticClientObservation']) {
    await writeFile(syntheticFile, JSON.stringify({ ...fixtureSession(), id: syntheticId, metrics: { verification: { syntheticTest: false, [flag]: true, scenario: 'newer-verification' } } }));
    await utimes(syntheticFile, new Date(2000), new Date(2000));
    assert.equal(JSON.parse(await reviewLogsCli(['--latest'], root)).session.id, sessionId, flag);
    const included = JSON.parse(await reviewLogsCli(['--latest', '--include-synthetic'], root));
    assert.equal(included.session.id, syntheticId); assert.equal(included.session.syntheticTest, true);
    assert.equal(JSON.parse(await reviewLogsCli(['--session', syntheticId], root)).session.syntheticTest, true);
    const listed = JSON.parse(await reviewLogsCli(['--list'], root));
    assert.equal(listed.sessions.length, 2); assert.equal(listed.sessions[0].syntheticTest, true);
    assert.equal(listed.sessions[0].provenance.scenario, 'newer-verification');
  }
  await assert.rejects(() => reviewLogsCli(['--session', sessionId, '--include-synthetic'], root), /--latest/);
  await assert.rejects(() => reviewLogsCli(['--list', '--include-synthetic'], root), /--latest/);
  await rm(userFile);
  await assert.rejects(() => reviewLogsCli(['--latest'], root), /UUID/);
}));
