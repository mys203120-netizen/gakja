import { TurnWorkContext, TurnWorkError, systemTurnWorkClock, type TurnWorkClock } from '../turn-work';

/** One producer's external result. Closing a provider does not make an ignored
 * abort trustworthy, and a failed database commit does not renew its budget. */
export interface CaptureFinishCache<T> {
  promise?: Promise<T>;
  result?: { value: T; observedAt: number };
  endDeadline?: { deadlineAt: string; monotonicAt: number };
  terminalEndTimeout?: boolean;
}
export function cachedCaptureFinish<T>(cache: CaptureFinishCache<T>, operation: () => Promise<T>, clock: TurnWorkClock = systemTurnWorkClock) {
  return cache.promise ??= Promise.resolve().then(operation).then(value => { cache.result = { value, observedAt: clock.now() }; return value; });
}
export function captureFinishMayPublish<T>(cache: CaptureFinishCache<T>) {
  return !cache.terminalEndTimeout && Boolean(cache.result) && (!cache.endDeadline || cache.result!.observedAt <= cache.endDeadline.monotonicAt);
}
export async function captureFinishForEnd<T>(cache: CaptureFinishCache<T>, operation: () => Promise<T>, options: {
  deadlineAt: string; serverNowMs: number; attemptId: string; clock?: TurnWorkClock;
}) {
  const clock = options.clock ?? systemTurnWorkClock, absolute = Date.parse(options.deadlineAt);
  if (!Number.isFinite(absolute) || !Number.isFinite(options.serverNowMs)) throw new TurnWorkError('TURN_WORK_RETIRED');
  if (cache.endDeadline && cache.endDeadline.deadlineAt !== options.deadlineAt) throw new TurnWorkError('TURN_WORK_RETIRED');
  const monotonicAt = clock.now() + absolute - options.serverNowMs;
  cache.endDeadline ??= { deadlineAt: options.deadlineAt, monotonicAt };
  if (cache.terminalEndTimeout) throw new TurnWorkError('TURN_WORK_TIMEOUT');
  // A timely confirmed result survives a later failed CAS, even when the retry
  // itself starts after expiry. No external waiter is restarted for this case.
  if (cache.result && captureFinishMayPublish(cache)) return cache.result.value;
  const remaining = cache.endDeadline.monotonicAt - clock.now();
  if (cache.result || remaining <= 0) { cache.terminalEndTimeout = true; throw new TurnWorkError('TURN_WORK_TIMEOUT'); }
  const work = new TurnWorkContext({ attemptId: options.attemptId, timeoutMs: remaining, clock });
  try {
    const value = await work.run(Infinity, () => cachedCaptureFinish(cache, operation, clock));
    if (!captureFinishMayPublish(cache)) { cache.terminalEndTimeout = true; throw new TurnWorkError('TURN_WORK_TIMEOUT'); }
    return value;
  } catch (cause) {
    if (cause instanceof TurnWorkError && ['TURN_WORK_TIMEOUT', 'TURN_STAGE_TIMEOUT'].includes(cause.code)) cache.terminalEndTimeout = true;
    throw cause;
  } finally { work.complete(); }
}
