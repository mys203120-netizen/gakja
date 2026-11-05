import { calculateSpeechMetrics } from './speech-metrics';
import { observeSpeechHabits } from './speech-habits';
import type { SpeechEndingObservation } from './answer-capture';

export type EndingAnswerObservation = { turnId: string; answerId: string; speech: ReturnType<typeof calculateSpeechMetrics>; habits: ReturnType<typeof observeSpeechHabits> };

/** Keep observations with their exact answer identity. The raw text here is a
 * client snapshot; the server recomputes text counts after its final STT drain. */
export function endingAnswerObservations(answers: readonly EndingAnswerObservation[], scope: { turnId: string; answerId: string } | null, speech: SpeechEndingObservation | undefined, rawTranscript: string) {
  const observations = answers.map(row => structuredClone(row));
  if (scope && speech) {
    const current: EndingAnswerObservation = { ...scope, speech: { ...speech, ...calculateSpeechMetrics({ ...speech, rawTranscript }) }, habits: observeSpeechHabits(scope.answerId, rawTranscript, speech.durationMs) };
    const index = observations.findIndex(row => row.turnId === scope.turnId && row.answerId === scope.answerId);
    if (index < 0) observations.push(current); else observations[index] = current;
  }
  const last = scope ? observations.find(row => row.turnId === scope.turnId && row.answerId === scope.answerId) : observations.at(-1);
  return { answers: observations, last };
}

/** The server owns idempotence across reloads. This coordinator also shares an
 * in-flight request within the browser and preserves its exact input on retry.
 * Neither audio playback nor a UI generation/AbortController owns this work. */
export class DurableEndRegistration<TBody, TResult> {
  private entries = new Map<string, { payload?: { value: TBody }; accepted?: { value: TResult }; pending?: Promise<TResult> }>();
  register(sessionId: string, prepare: () => Promise<TBody>, send: (body: TBody) => Promise<TResult>): Promise<TResult> {
    let entry = this.entries.get(sessionId);
    if (entry?.accepted) return Promise.resolve(entry.accepted.value);
    if (entry?.pending) return entry.pending;
    if (!entry) { entry = {}; this.entries.set(sessionId, entry); }
    const current = entry;
    const pending = Promise.resolve().then(async () => {
      if (!current.payload) current.payload = { value: structuredClone(await prepare()) };
      const result = await send(structuredClone(current.payload.value));
      current.accepted = { value: result }; delete current.payload;
      return result;
    });
    current.pending = pending;
    // Retain the prepared snapshot after rejection, including a lost response
    // after server acceptance. A retry cannot replace the accepted end metrics.
    void pending.then(() => { if (current.pending === pending) delete current.pending; }, () => { if (current.pending === pending) delete current.pending; });
    return pending;
  }
}

/** Never truncate observations to fit keepalive's browser quota. Large payloads
 * still use an un-aborted request; full-page unload delivery is best effort. */
export function durableEndRequestInit(payload: unknown): RequestInit {
  const body = JSON.stringify(payload);
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    keepalive: new TextEncoder().encode(body).byteLength <= 60 * 1024 };
}

/** Optional closing audio runs only after durable acceptance. Failure, pause
 * without ended, or a stuck preparation cannot hold the UI forever. */
export async function bestEffortClosing(play: () => Promise<void>, cancel: () => void, timeoutMs = 10_000, signal?: AbortSignal): Promise<'played' | 'failed' | 'timed_out' | 'cancelled'> {
  if (signal?.aborted) return 'cancelled';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const outcome = await Promise.race([
    Promise.resolve().then(() => { if (!signal?.aborted) return play(); }).then(() => signal?.aborted ? 'cancelled' as const : 'played' as const, () => 'failed' as const),
    new Promise<'timed_out'>(resolve => { timer = setTimeout(() => resolve('timed_out'), timeoutMs); }),
    ...(signal ? [new Promise<'cancelled'>(resolve => { onAbort = () => resolve('cancelled'); signal.addEventListener('abort', onAbort, { once: true }); })] : []),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (onAbort) signal?.removeEventListener('abort', onAbort);
  if (outcome !== 'played') { try { cancel(); } catch { /* Audio cleanup cannot undo durable end acceptance. */ } }
  return outcome;
}
