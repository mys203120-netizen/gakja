import test from 'node:test';
import assert from 'node:assert/strict';
import { interviewConfig } from '../../interview.config';
import type { InterviewSession } from '../../server/protocol';
import { getDurableSubmissionWork, completeDurableSubmissionWork } from '../../server/session-writer/submission-deadline';
import { WorkTestClock } from '../fixtures/work-test-clock';

const scope = { turnId: 'synthetic-turn', answerId: 'synthetic-answer', captureRevision: 1 };
const instant = Date.parse('2026-11-07T00:00:00.000Z');
const fixture = () => ({ id: 'synthetic-session', status: 'active', runtime: { owner: { mode: 'authenticated', id: 'synthetic-owner' }, epoch: 0, operations: {} } }) as unknown as InterviewSession;

test('staged finish, candidate, answer and next share the original deadline across server processes', () => {
  const session = fixture(), firstClock = new WorkTestClock();
  const finish = getDurableSubmissionWork(session, scope, 'submission-attempt', instant, { allowCreate: true, clock: firstClock });
  firstClock.advance(10_000); finish.workContext.complete();
  const candidateServer = structuredClone(session), candidate = getDurableSubmissionWork(candidateServer, scope, 'submission-attempt', instant + 10_000, { clock: new WorkTestClock() });
  assert.equal(candidate.workContext.remainingMs(), 85_000);
  candidate.workContext.complete();
  const nextServer = structuredClone(candidateServer), next = getDurableSubmissionWork(nextServer, scope, undefined, instant + 94_000, { clock: new WorkTestClock() });
  assert.equal(next.workContext.remainingMs(), 1_000);
  assert.equal(next.record.startedAt, finish.record.startedAt); assert.equal(next.record.deadlineAt, finish.record.deadlineAt);
  next.workContext.complete();
  assert.throws(() => getDurableSubmissionWork(nextServer, scope, undefined, instant + interviewConfig.turnWaitTimeoutMs, { allowCreate: true }), { code: 'TURN_WORK_TIMEOUT' });
  assert.throws(() => getDurableSubmissionWork(nextServer, scope, 'new-browser-attempt', instant + 96_000, { allowCreate: true }), { code: 'TURN_WORK_RETIRED' });
});

test('an ignored-abort provider cannot publish after the remaining database budget or revive on retry', async () => {
  const session = fixture(), clock = new WorkTestClock();
  const first = getDurableSubmissionWork(session, scope, 'submission-attempt', instant, { allowCreate: true, clock }); first.workContext.complete();
  const waiting = getDurableSubmissionWork(session, scope, 'submission-attempt', instant + 94_000, { clock });
  let resolve!: (value: string) => void;
  const result = waiting.workContext.run(Infinity, async () => new Promise<string>(done => { resolve = done; }));
  const rejected = assert.rejects(result, { code: 'TURN_WORK_TIMEOUT' });
  clock.advance(1_000); await rejected;
  assert.equal(waiting.record.status, 'expired'); resolve('late decision'); await Promise.resolve();
  assert.throws(() => waiting.workContext.assertLive(), { code: 'TURN_WORK_TIMEOUT' });
  waiting.workContext.complete();
  assert.throws(() => getDurableSubmissionWork(structuredClone(session), scope, undefined, instant + 95_001), { code: 'TURN_WORK_TIMEOUT' });
});

test('CONTINUE completes only its capture; a later capture receives a new budget and old identities stay terminal', () => {
  const session = fixture(), clock = new WorkTestClock();
  const first = getDurableSubmissionWork(session, scope, 'first-attempt', instant, { allowCreate: true, clock });
  completeDurableSubmissionWork(session, scope, first.record.attemptId); first.workContext.complete();
  assert.throws(() => getDurableSubmissionWork(session, scope, 'first-attempt', instant + 30_000, { allowCreate: true, clock }), { code: 'TURN_WORK_RETIRED' });
  const secondScope = { ...scope, captureRevision: 2 }, second = getDurableSubmissionWork(session, secondScope, 'second-attempt', instant + 30_000, { allowCreate: true, clock });
  assert.equal(second.workContext.remainingMs(), interviewConfig.turnWaitTimeoutMs);
  assert.notEqual(second.record.deadlineAt, first.record.deadlineAt); assert.equal(first.record.status, 'completed'); second.workContext.complete();
});

test('candidate cannot create a missing finish record and recovery cannot revive a former epoch', () => {
  const session = fixture();
  assert.throws(() => getDurableSubmissionWork(session, scope, undefined, instant), { code: 'TURN_WORK_RETIRED' });
  const finish = getDurableSubmissionWork(session, scope, undefined, instant, { allowCreate: true, clock: new WorkTestClock() }); finish.workContext.complete();
  session.runtime!.epoch++;
  assert.throws(() => getDurableSubmissionWork(session, scope, finish.record.attemptId, instant + 1_000), { code: 'TURN_WORK_TIMEOUT' });
  assert.equal(finish.record.status, 'expired');
});
