import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { maskConversationSecrets } from '../server/storage/conversation-log';
import type { InterviewSession } from '../server/protocol';

if (!process.argv.includes('--run-live')) throw new Error('EXPLICIT_RUN_LIVE_REQUIRED');
const sourcePath = 'artifacts/live-interview-e2e-20261103T125455Z-coverage.json';
const outputPath = 'artifacts/live-interview-e2e-evaluation-recovery.json';
const sourceBytes = await readFile(sourcePath);
const source = JSON.parse(sourceBytes.toString()) as { owner: string; sessionId: string };
if (source.sessionId !== '710e9390-5015-4a75-a56f-bf82ba14692d' || !source.owner.startsWith('synthetic-e2e-')) throw new Error('EXPECTED_SYNTHETIC_SESSION_REQUIRED');
const sessionPath = `data/sessions/${source.sessionId}.json`;
const logPath = `data/conversation-logs/${source.sessionId}.jsonl`;
const saved = async () => JSON.parse(await readFile(sessionPath, 'utf8')) as InterviewSession;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const answerProjection = (session: InterviewSession) => session.turns.map(turn => ({ id: turn.id, answerId: turn.answerId, transcriptStatus: turn.transcriptStatus, rawTranscript: turn.rawTranscript, questionText: turn.questionText }));
const before = await saved();
if (before.runtime?.owner.id !== source.owner || before.evaluationStatus !== 'failed' || before.status === 'active') throw new Error('FAILED_ENDED_SYNTHETIC_SESSION_REQUIRED');
const logBefore = await readFile(logPath, 'utf8');
const beforeAnswers = hash(JSON.stringify(answerProjection(before)));
const beforeEntries = before.providerUsageLedger?.entries ?? [];
const port = await new Promise<number>((resolve, reject) => {
  const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => {
    const chosen = (server.address() as net.AddressInfo).port; server.close(error => error ? reject(error) : resolve(chosen));
  });
});
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['--import', 'tsx', 'server/realtime.ts'], { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, REALTIME_PORT: String(port), LOCAL_INTERVIEW_OWNER_ID: source.owner } });
let serverTail = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { serverTail = (serverTail + String(chunk)).slice(-4000); });
const report: Record<string, unknown> = { sourcePath, sourceSha256: hash(sourceBytes), sessionId: source.sessionId,
  provenance: { syntheticTest: true, actualHttpRetry: true, retryRequests: 0, engineCodeModified: false, sourceArtifactModified: false },
  startedAt: new Date().toISOString(), before: { status: before.status, evaluationStatus: before.evaluationStatus, evaluationError: before.evaluationError,
    turns: before.turns.length, finalizedAnswers: before.turns.filter(turn => turn.transcriptStatus === 'finalized').length,
    answersSha256: beforeAnswers, ledger: before.providerUsageLedger?.summary, unknownEntryIdentities: beforeEntries.filter(entry => entry.cost.usd === null).map(entry => entry.identity) } };
let retryStarted = 0;
const request = async (route: string, body?: unknown) => {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000) });
  const value = await response.json();
  if (!response.ok) throw new Error(`HTTP_${response.status}: ${JSON.stringify(value).slice(0, 350)}`);
  return { status: response.status, body: value };
};
try {
  const deadline = Date.now() + 30000;
  while (true) {
    if (child.exitCode !== null) throw new Error('ISOLATED_SERVER_EXITED');
    try { if ((await request('/api/health')).body.ok) break; } catch { /* bounded startup */ }
    if (Date.now() > deadline) throw new Error('ISOLATED_SERVER_STARTUP_TIMEOUT'); await sleep(250);
  }
  retryStarted = performance.now();
  (report.provenance as Record<string, unknown>).retryRequests = 1;
  report.retryResponse = await request(`/api/sessions/${source.sessionId}/retry-evaluation`, {});
  const deadlineEvaluation = Date.now() + 100000;
  while (Date.now() < deadlineEvaluation) {
    const current = await saved();
    if (['completed', 'failed'].includes(current.evaluationStatus)) break;
    await sleep(500);
  }
  report.retryElapsedMs = performance.now() - retryStarted;
  report.publicAfter = (await request(`/api/sessions/${source.sessionId}`)).body;
} catch (error) {
  report.failure = { message: error instanceof Error ? error.message : 'unknown', serverTail: maskConversationSecrets(serverTail) };
} finally {
  const after = await saved(), logAfter = await readFile(logPath, 'utf8');
  const afterEntries = after.providerUsageLedger?.entries ?? [], known = new Set(beforeEntries.map(entry => entry.identity));
  const newEntries = afterEntries.filter(entry => !known.has(entry.identity));
  const rows = logAfter.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  report.completedAt = new Date().toISOString();
  report.after = { status: after.status, evaluationStatus: after.evaluationStatus, evaluationError: after.evaluationError ?? null,
    turns: after.turns.length, finalizedAnswers: after.turns.filter(turn => turn.transcriptStatus === 'finalized').length,
    answersSha256: hash(JSON.stringify(answerProjection(after))), ledger: after.providerUsageLedger?.summary,
    newUsageEntries: newEntries, evaluationResultPresent: Boolean(after.evaluation) };
  report.checks = { answersAndQuestionIdentitiesUnchanged: beforeAnswers === hash(JSON.stringify(answerProjection(after))),
    originalLedgerEntriesUnchanged: beforeEntries.every(entry => JSON.stringify(entry) === JSON.stringify(afterEntries.find(candidate => candidate.identity === entry.identity))),
    originalUnknownUsagePreserved: beforeEntries.filter(entry => entry.cost.usd === null).every(entry => afterEntries.some(candidate => candidate.identity === entry.identity && candidate.cost.usd === null)),
    originalLogPrefixPreserved: logAfter.startsWith(logBefore), originalSourceArtifactUnchanged: hash(await readFile(sourcePath)) === hash(sourceBytes),
    logAppendBytes: Buffer.byteLength(logAfter) - Buffer.byteLength(logBefore), newEvaluationUsageEntries: newEntries.filter(entry => entry.stage === 'evaluation').length,
    persistedEvaluationCompleted: after.evaluationStatus === 'completed' && Boolean(after.evaluation),
    allLogEventIdsUnique: new Set(rows.map(row => row.eventId)).size === rows.length };
  await writeFile(outputPath, JSON.stringify(maskConversationSecrets(report), null, 2), { mode: 0o600 });
  child.kill();
  if (child.exitCode === null) await Promise.race([new Promise<void>(resolve => child.once('exit', () => resolve())), sleep(3000)]);
}
console.log(JSON.stringify({ outputPath, sessionId: source.sessionId, after: report.after, checks: report.checks }, null, 2));
if (report.failure || !(report.checks as Record<string, unknown>).persistedEvaluationCompleted) process.exitCode = 1;
