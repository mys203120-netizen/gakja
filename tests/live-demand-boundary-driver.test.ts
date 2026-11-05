import test from 'node:test';
import assert from 'node:assert/strict';
import { demandDriverOptions, onlyThisSyntheticJob, endBeforeOptionalClosing, createDemandCheckpoint, runDemandBoundaryE2E } from '../scripts/live-demand-boundary-e2e';
import type { EvaluationJob } from '../server/evaluation-job-store';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { PreparedQuestionBank } from '../server/data/prepared-question-bank';

test('driver needs explicit live opt-in, reserves its own output and caps captures at six', async () => {
  const options = demandDriverOptions([]);
  assert.equal(options.runLive, false);
  await assert.rejects(runDemandBoundaryE2E(options), /EXPLICIT_RUN_LIVE_REQUIRED/u);
  await assert.rejects(runDemandBoundaryE2E({ ...options, runLive: true, maxTurns: 7 }), /MAX_TURNS_MUST_BE_1_TO_6/u);
  for (const value of ['0', '7', '1.5', 'NaN']) assert.throws(() => demandDriverOptions([`--max-turns=${value}`]));
  for (const value of ['1', '6']) assert.equal(demandDriverOptions([`--max-turns=${value}`]).maxTurns, Number(value));
  for (const output of ['../old.json', 'data/sessions/a.json', 'artifacts/live-demand-boundary-e2e-../x.json']) assert.throws(() => demandDriverOptions([`--output=${output}`]));
});

test('evaluation driver cannot claim another synthetic run or a human owner queue', () => {
  const jobs = [
    { ownerId: 'synthetic-demand-boundary-a', sessionId: 'a' },
    { ownerId: 'synthetic-demand-boundary-a', sessionId: 'b' },
    { ownerId: 'local-development-owner', sessionId: 'a' },
    { ownerId: 'synthetic-demand-boundary-b', sessionId: 'a' },
  ] as EvaluationJob[];
  assert.deepEqual(onlyThisSyntheticJob(jobs, 'synthetic-demand-boundary-a', 'a'), [jobs[0]]);
  assert.throws(() => onlyThisSyntheticJob(jobs, 'local-development-owner', 'a'), /SYNTHETIC_OWNER_REQUIRED/u);
  assert.equal(jobs.length, 4);
});

test('missing approved root fails before a checkpoint can fabricate a replacement premise', () => {
  assert.throws(() => createDemandCheckpoint({} as InterviewContext, { status: 'ready', slots: [] } as unknown as PreparedQuestionBank,
    'synthetic-demand-boundary-test'), /APPROVED_Q14_ROOT_MISSING/u);
});

test('end is committed first and optional closing failure does not block evaluation continuation', async () => {
  const order: string[] = [];
  const result = await endBeforeOptionalClosing(async () => { order.push('end'); return 'queued'; },
    async () => { order.push('optional-closing'); throw new Error('CLOSING_TTS_FAILED'); },
    () => { order.push('closing-error-recorded'); });
  order.push('evaluation');
  assert.equal(result, 'queued');
  assert.deepEqual(order, ['end', 'optional-closing', 'closing-error-recorded', 'evaluation']);
  await assert.rejects(endBeforeOptionalClosing(async () => { throw new Error('END_FAILED'); },
    async () => { assert.fail('closing cannot happen before accepted end'); }, () => {}), /END_FAILED/u);
});
