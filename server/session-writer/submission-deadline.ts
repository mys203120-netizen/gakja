import { randomUUID } from 'node:crypto';
import { interviewConfig } from '../../interview.config';
import type { InterviewSession } from '../protocol';
import type { SubmissionWorkRecord, SubmissionWorkScope } from '../submission-work';
import { createTurnWorkContext, TurnWorkError, type TurnWorkClock } from '../turn-work';

const scopeKey = (scope: SubmissionWorkScope) => `${scope.turnId}:${scope.answerId}:${scope.captureRevision}`;
export interface DurableSubmissionWorkOptions {
  /** Only the first staged finish may establish a new submission deadline. */
  allowCreate?: boolean;
  /** Injectable monotonic clock; database time remains the persisted authority. */
  clock?: TurnWorkClock;
}

/** Reconstruct an endpoint's waiter from one database-clock deadline. Unlike the
 * local registry, this permits a different server to continue the same pending
 * submission without issuing another 95 seconds. The caller must persist a new
 * record before draining STT and pass its deadline to the final SQL CAS guard.
 * Completing the returned context releases that endpoint's timer only. */
export function getDurableSubmissionWork(session: InterviewSession, scope: SubmissionWorkScope, attemptId: string | undefined,
  serverNowMs: number, options: DurableSubmissionWorkOptions = {}) {
  const runtime = session.runtime;
  if (!runtime || runtime.owner.mode !== 'authenticated' || !Number.isFinite(serverNowMs) || !Number.isInteger(scope.captureRevision) || scope.captureRevision <= 0) throw new TurnWorkError('TURN_WORK_RETIRED');
  const records = runtime.submissionAttempts ??= {}, key = scopeKey(scope);
  let record = records[key];
  if (!record) {
    if (!options.allowCreate) throw new TurnWorkError('TURN_WORK_RETIRED');
    record = { ...scope, attemptId: attemptId ?? randomUUID(), epoch: runtime.epoch,
      startedAt: new Date(serverNowMs).toISOString(), deadlineAt: new Date(serverNowMs + interviewConfig.turnWaitTimeoutMs).toISOString(), status: 'running' };
    records[key] = record;
  }
  if (attemptId && record.attemptId !== attemptId) throw new TurnWorkError('TURN_WORK_RETIRED');
  if (record.turnId !== scope.turnId || record.answerId !== scope.answerId || record.captureRevision !== scope.captureRevision) throw new TurnWorkError('TURN_WORK_RETIRED');
  if (record.status === 'cancelled') throw new TurnWorkError('TURN_WORK_CANCELLED');
  if (record.status === 'completed') throw new TurnWorkError('TURN_WORK_RETIRED');
  if (record.status === 'expired') throw new TurnWorkError('TURN_WORK_TIMEOUT');
  const startedAt = Date.parse(record.startedAt), deadlineAt = Date.parse(record.deadlineAt);
  if (record.epoch !== runtime.epoch || !Number.isFinite(startedAt) || !Number.isFinite(deadlineAt) ||
    deadlineAt - startedAt !== interviewConfig.turnWaitTimeoutMs || serverNowMs < startedAt) {
    record.status = 'expired'; throw new TurnWorkError('TURN_WORK_TIMEOUT');
  }
  const remainingMs = deadlineAt - serverNowMs;
  if (remainingMs <= 0) { record.status = 'expired'; throw new TurnWorkError('TURN_WORK_TIMEOUT'); }
  const workContext = createTurnWorkContext({ attemptId: record.attemptId, timeoutMs: remainingMs, clock: options.clock,
    assertCurrent: () => {
      if (session.status !== 'active' || runtime.epoch !== record.epoch || runtime.endRequestedAt || runtime.evaluationInputFrozenAt || runtime.evaluationJob || records[key] !== record || record.status !== 'running') throw new TurnWorkError('TURN_WORK_RETIRED');
    },
    onCancelled: code => { record.status = code === 'TURN_WORK_TIMEOUT' ? 'expired' : 'cancelled'; },
  });
  try { workContext.assertLive(); } catch (error) { workContext.complete(); throw error; }
  return { record, workContext };
}

/** The successful CONTINUE or committed next turn ends this capture's work.
 * A later capture revision receives a separate record and a fresh deadline. */
export function completeDurableSubmissionWork(session: InterviewSession, scope: SubmissionWorkScope, attemptId?: string) {
  return markDurableSubmissionWork(session, scope, attemptId, 'completed');
}

export function cancelDurableSubmissionWork(session: InterviewSession, scope: SubmissionWorkScope, attemptId?: string) {
  return markDurableSubmissionWork(session, scope, attemptId, 'cancelled');
}

function markDurableSubmissionWork(session: InterviewSession, scope: SubmissionWorkScope, attemptId: string | undefined,
  status: Extract<SubmissionWorkRecord['status'], 'completed' | 'cancelled'>) {
  const runtime = session.runtime, record = runtime?.submissionAttempts?.[scopeKey(scope)];
  if (!runtime || !record || record.epoch !== runtime.epoch || attemptId && record.attemptId !== attemptId) throw new TurnWorkError('TURN_WORK_RETIRED');
  if (record.status === 'expired') throw new TurnWorkError('TURN_WORK_TIMEOUT');
  if (record.status === 'cancelled') throw new TurnWorkError('TURN_WORK_CANCELLED');
  if (record.status === 'running') record.status = status;
  return record;
}
