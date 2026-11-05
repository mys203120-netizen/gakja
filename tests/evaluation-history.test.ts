import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession } from '../server/protocol';
import { createSessionRuntime } from '../server/session-runtime';
import { EvaluationJobStore, evaluationJobId } from '../server/evaluation-job-store';
import { LocalSessionStore } from '../server/storage/local-session-store';
import { loadHistoricalCompletedEvaluation } from '../server/evaluation-history';
import { historicalEvaluationSourceFingerprint, HISTORICAL_REVIEWED_KNOWLEDGE_PIPELINE_VERSION, EVALUATION_PIPELINE_VERSION } from '../server/providers/evaluation-input';
import { reviewedRecordEvaluationFixture } from './fixtures/reviewed-evaluation-knowledge';

async function fixture(t: { after(fn: () => Promise<void>): void }, completed = true) {
  const directory = await mkdtemp(path.join(tmpdir(), 'evaluation-history-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('evaluation-history-')); await rm(directory, { recursive: true, force: true }); });
  const context = { target: { university: '합성 대학', department: '합성 학과', academicYear: 2027, admissionTrack: '합성 전형' },
    school: { schoolReferenceId: 'historical-synthetic-school' }, evaluationGuidelines: '합성 과거 평가 규칙',
    manifest: { schemaVersion: 'historical-synthetic-manifest', rulesVersion: 'historical-engine-v4', files: [], recordIds: {}, evidenceIds: ['record-historical'] },
    student: { evidence: [{ id: 'record-historical', activityId: 'activity-historical', text: '함께 자료를 정리함.', page: 1,
      sourceRef: { pdfSha256: 'a'.repeat(64), page: 1, startOffset: 0, endOffset: 13 }, scientificTruthVerification: 'not_independently_verified' }] },
  } as unknown as InterviewContext;
  const source = { id: 'bfe20cf7-674a-4e40-a578-d37a75ecfc25', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    status: 'ending', evaluationStatus: 'pending', target: context.target, sourceManifest: context.manifest, metrics: { marker: 'original-frozen-metrics' },
    elapsedMs: 3000, followUpCountByMainQuestion: {}, turns: [{ id: 'q-historical', questionKind: 'main', parentMainQuestionId: 'q-historical',
      questionText: '그 활동에서 본인이 맡은 일은 무엇인가요?', evidenceIds: ['record-historical'], answerId: 'answer-historical',
      rawTranscript: '저는 자료를 분류하고 표를 작성했습니다.', transcriptStatus: 'finalized',
      metadata: { primaryFunction: 'ROLE', questionIntent: '활동에서 본인이 한 일을 확인한다.', targetEvidence: ['본인이 직접 한 일'], depth: 'D2' } }],
    questionPresentations: [{ turnId: 'q-historical', rootTurnId: 'q-historical', questionKind: 'main', clockId: 'historical-clock', startedAtMs: 1, completedAtMs: 2 }],
  } as unknown as InterviewSession;
  const reviewed = reviewedRecordEvaluationFixture(context, source), session = reviewed.session, frozenContext = reviewed.context;
  const ownerId = 'historical-synthetic-owner', model = 'historical-synthetic-model';
  session.runtime = createSessionRuntime(frozenContext, { id: ownerId, mode: 'local-development' });
  session.runtime.evaluationInputFrozenAt = '2026-11-01T00:00:03.000Z';
  session.runtime.acceptedEndRequest = { elapsedMs: session.elapsedMs, metrics: { marker: 'original-frozen-metrics' } };
  const version = HISTORICAL_REVIEWED_KNOWLEDGE_PIPELINE_VERSION;
  const sourceSha256 = historicalEvaluationSourceFingerprint(frozenContext, session, version, model);
  const id = evaluationJobId(session.id, ownerId, sourceSha256, version);
  session.runtime.evaluationJob = { id, pipelineVersion: version, sourceSha256, model };
  const sessions = new LocalSessionStore(path.join(directory, 'sessions')), jobs = new EvaluationJobStore(path.join(directory, 'jobs'));
  await sessions.saveContext(frozenContext, ownerId); await sessions.save(session);
  const job = await jobs.enqueue(session, sourceSha256, version, Date.parse(session.createdAt), model);
  const evaluation = { summary: 'v4에 실제 저장된 합성 평가', answers: [{ turnId: 'q-historical', score: 95 }],
    evaluationPipeline: { version, model }, sessionScore: null };
  if (completed) {
    const claimed = (await jobs.claim(job.id, 'historical-synthetic-worker'))!;
    await jobs.complete(job.id, claimed.lease!.token, evaluation);
    session.status = 'completed'; session.evaluationStatus = 'completed';
    // A stale denormalized session field must never override the verified result.
    session.evaluation = { summary: 'stale-session-field-must-not-be-returned' };
    await sessions.save(session);
  }
  return { directory, context: frozenContext, session, ownerId, jobs, sessions, job, evaluation };
}

test('v5 reads a verified completed v4 result without re-running, relabeling or rewriting its immutable files', async t => {
  const value = await fixture(t), files = [path.join(value.directory, 'sessions', `${value.session.id}.json`),
    ...((await readdir(value.jobs.directory)).filter(file => file.endsWith('.json')).map(file => path.join(value.jobs.directory, file)))];
  const before = await Promise.all(files.map(file => readFile(file)));
  const result = await loadHistoricalCompletedEvaluation(value.session, value.context, value.ownerId, value.jobs);
  assert.deepEqual(result!.evaluation, value.evaluation);
  assert.equal(result!.pipelineVersion, HISTORICAL_REVIEWED_KNOWLEDGE_PIPELINE_VERSION);
  assert.notEqual(result!.pipelineVersion, EVALUATION_PIPELINE_VERSION);
  assert.equal((await value.jobs.get(value.job.id))!.attempts, 1, 'reading history never claims another worker attempt');
  assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
});

test('historical projection refuses changed captured input, manifest, metrics, owner, reference model and context', async t => {
  const value = await fixture(t);
  const mutations: Array<(session: InterviewSession, context: InterviewContext) => void> = [
    session => { session.turns[0].rawTranscript += ' 수정'; },
    session => { (session.sourceManifest as InterviewContext['manifest']).recordIds.changed = 'different'; },
    session => { session.metrics = { marker: 'changed-after-end' }; },
    session => { session.runtime!.owner.id = 'different-owner'; },
    session => { session.runtime!.evaluationJob!.model = 'new-model'; },
    (session: InterviewSession, context: InterviewContext) => { context.evaluationGuidelines += ' new policy'; },
  ];
  for (const mutate of mutations) {
    const session = structuredClone(value.session), context = structuredClone(value.context); mutate(session, context);
    await assert.rejects(loadHistoricalCompletedEvaluation(session, context, value.ownerId, value.jobs), /HISTORICAL_EVALUATION_|SESSION_OWNER_MISMATCH/);
  }
});

for (const suffix of ['snapshot', 'result'] as const) test(`historical ${suffix} tampering is detected through the existing store hash verification`, async t => {
  const value = await fixture(t), file = path.join(value.jobs.directory, `${value.job.id}.${suffix}.json`);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  if (suffix === 'snapshot') stored.session.turns[0].rawTranscript = '변조된 답변';
  else stored.evaluation.summary = '변조된 평가';
  await writeFile(file, JSON.stringify(stored));
  await assert.rejects(loadHistoricalCompletedEvaluation(value.session, value.context, value.ownerId, value.jobs), /EVALUATION_SNAPSHOT_CHANGED|EVALUATION_RESULT_CHANGED/);
});

test('unfinished and unsupported old jobs never project stale session evaluations or execute work', async t => {
  const value = await fixture(t, false); value.session.evaluation = { summary: 'stale-result' };
  assert.equal(await loadHistoricalCompletedEvaluation(value.session, value.context, value.ownerId, value.jobs), null);
  assert.equal((await value.jobs.get(value.job.id))!.status, 'queued'); assert.equal((await value.jobs.get(value.job.id))!.attempts, 0);
  value.session.runtime!.evaluationJob!.pipelineVersion = 'unsupported-historical-version';
  assert.equal(await loadHistoricalCompletedEvaluation(value.session, value.context, value.ownerId, value.jobs), null);
});
