import type { ClientPlaybackEvent } from './client-event-contract';
export type InterviewClientEventType = 'phase_changed' | 'acknowledgement_playing' | 'question_playing' | 'audio_ended' | 'client_error';
export interface InterviewClientEvent { eventId: string; type: InterviewClientEventType; turnId?: string; phase?: string; atMs: number; clockId?: string; payload?: unknown }
export interface ClientEventScope { sessionId: string; epoch: number }
export function readClientEventReceipt(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4096 || !value.every(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id))) throw new Error('재생 기록의 저장 결과를 확인하지 못했습니다.');
  return [...value] as string[];
}
export function phaseEventTurnId(phase: string, scope: { playbackTurnId?: string | null; pendingTurnId?: string | null; currentTurnId?: string | null }) { return phase === 'speaking_acknowledgement' || phase === 'speaking_question' ? scope.playbackTurnId ?? scope.pendingTurnId ?? scope.currentTurnId ?? undefined : scope.pendingTurnId ?? scope.currentTurnId ?? undefined; }

/** Non-blocking, per-run observation journal; failed sends remain available for explicit end backup. */
export class InterviewClientEventJournal {
  private scope: ClientEventScope | null = null;
  private events = new Map<string, Map<string, InterviewClientEvent>>();
  private outstanding = new Map<string, Map<string, ClientPlaybackEvent>>();
  private pending = new Map<Promise<void>, string>();
  private failures = 0;
  private readonly clockId = crypto.randomUUID();
  constructor(private send: (sessionId: string, event: InterviewClientEvent) => Promise<unknown>, private createId: () => string = () => crypto.randomUUID(), private now = () => performance.now()) {}
  bind(sessionId: string, epoch: number) { this.scope = { sessionId, epoch }; if (!this.events.has(sessionId)) this.events.set(sessionId, new Map()); if (!this.outstanding.has(sessionId)) this.outstanding.set(sessionId, new Map()); }
  retire() { this.scope = null; }
  emit(scope: ClientEventScope, input: Omit<InterviewClientEvent, 'eventId' | 'atMs'> & { atMs?: number }) {
    if (!this.scope || scope.sessionId !== this.scope.sessionId || scope.epoch !== this.scope.epoch) return null;
    const event: InterviewClientEvent = structuredClone({ ...input, eventId: this.createId(), atMs: input.atMs ?? this.now(), clockId: this.clockId });
    this.events.get(scope.sessionId)!.set(event.eventId, event);
    if (event.turnId && ['question_playing', 'audio_ended', 'acknowledgement_playing'].includes(event.type)) this.outstanding.get(scope.sessionId)!.set(event.eventId, event as ClientPlaybackEvent);
    const operation = Promise.resolve().then(() => this.send(scope.sessionId, structuredClone(event))).then(() => { this.acknowledge(scope.sessionId, [event.eventId]); }, () => { this.failures++; });
    this.pending.set(operation, scope.sessionId);
    void operation.finally(() => this.pending.delete(operation));
    return event.eventId;
  }
  snapshot(sessionId: string) { return structuredClone([...this.events.get(sessionId)?.values() ?? []]); }
  outstandingPlayback(sessionId: string) { return structuredClone([...this.outstanding.get(sessionId)?.values() ?? []]); }
  acknowledge(sessionId: string, eventIds: readonly string[]) { for (const eventId of eventIds) this.outstanding.get(sessionId)?.delete(eventId); }
  async flush(sessionId: string) { await Promise.all([...this.pending].filter(([, id]) => id === sessionId).map(([operation]) => operation)); return this.status(); }
  status() { return { pending: this.pending.size, failedWrites: this.failures }; }
}
