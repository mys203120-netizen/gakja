import { randomUUID } from 'node:crypto';
import type { InterviewSession } from './protocol';
import { createTurnWorkContext, TurnWorkError, type TurnWorkClock, type TurnWorkContext } from './turn-work';

export interface SubmissionWorkScope { turnId: string; answerId: string; captureRevision: number }
export interface SubmissionWorkRecord extends SubmissionWorkScope {
  attemptId: string; epoch: number; startedAt: string; deadlineAt: string;
  status: 'running' | 'expired' | 'cancelled' | 'completed';
}
const scopeKey = (scope: SubmissionWorkScope) => `${scope.turnId}:${scope.answerId}:${scope.captureRevision}`;
/** The trusted monotonic deadline stays in process; persisted attempts cannot revive it after restart. */
export class SubmissionWorkRegistry {
  private contexts = new Map<string, TurnWorkContext>();
  constructor(private timeoutMs: number, private clock?: TurnWorkClock) {}
  get(session: InterviewSession, scope: SubmissionWorkScope, attemptId?: string, allowCreate = !attemptId) {
    const runtime = session.runtime!;
    const records = runtime.submissionAttempts ??= {};
    const key = scopeKey(scope), saved = records[key];
    const contextKey = `${session.id}:${key}`;
    if (saved) {
      if (attemptId && saved.attemptId !== attemptId) throw new TurnWorkError('TURN_WORK_RETIRED');
      const existing = this.contexts.get(contextKey);
      if (!existing || saved.epoch !== runtime.epoch) {
        if (saved.status === 'running') saved.status = 'expired';
        throw new TurnWorkError(saved.status === 'cancelled' ? 'TURN_WORK_CANCELLED' : 'TURN_WORK_TIMEOUT');
      }
      existing.assertLive(); return existing;
    }
    if (!allowCreate) throw new TurnWorkError('TURN_WORK_RETIRED');
    const started = Date.now();
    const record: SubmissionWorkRecord = { ...scope, attemptId: attemptId ?? randomUUID(), epoch: runtime.epoch,
      startedAt: new Date(started).toISOString(), deadlineAt: new Date(started + this.timeoutMs).toISOString(), status: 'running' };
    records[key] = record;
    const context = createTurnWorkContext({ attemptId: record.attemptId, timeoutMs: this.timeoutMs, clock: this.clock,
      assertCurrent: () => { if (session.status !== 'active' || runtime.epoch !== record.epoch || runtime.endRequestedAt || runtime.evaluationInputFrozenAt || runtime.evaluationJob) throw new TurnWorkError('TURN_WORK_RETIRED'); },
      onCancelled: code => { record.status = code === 'TURN_WORK_TIMEOUT' ? 'expired' : 'cancelled'; },
    });
    this.contexts.set(contextKey, context); return context;
  }
  complete(session: InterviewSession, scope: SubmissionWorkScope) {
    const key = scopeKey(scope), record = session.runtime?.submissionAttempts?.[key];
    if (record?.status === 'running') record.status = 'completed';
    this.contexts.get(`${session.id}:${key}`)?.complete();
  }
  cancel(session: InterviewSession, scope: SubmissionWorkScope, attemptId: string) {
    // A browser cancellation may overtake a finish still queued behind stream setup.
    // Record a terminal attempt without touching the separately owned PCM producer.
    if (!session.runtime?.submissionAttempts?.[scopeKey(scope)]) this.get(session, scope, attemptId, true);
    const record = session.runtime?.submissionAttempts?.[scopeKey(scope)];
    if (!record || record.attemptId !== attemptId || record.epoch !== session.runtime?.epoch) return false;
    this.contexts.get(`${session.id}:${scopeKey(scope)}`)?.cancel(); return true;
  }
  cancelSession(sessionId: string) { for (const [key, context] of this.contexts) if (key.startsWith(`${sessionId}:`)) { context.cancel(); this.contexts.delete(key); } }
}
