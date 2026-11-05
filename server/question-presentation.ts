import type { InterviewSession, PreparedTurn, QuestionPresentation } from './protocol';

export interface PresentationEvent {
  eventId: string; type: string; turnId?: string; phase?: string; atMs: number; clockId?: string; payload?: unknown;
}
const issue = (record: QuestionPresentation, code: string) => { record.errorCodes = [...new Set([...(record.errorCodes ?? []), code])]; };
interface DeliveryAttempt {
  attemptId: string; clockId?: string; startedAtMs: number | null; completedAtMs: number | null;
  interrupted?: boolean; errorCodes?: string[]; eventIds: string[];
}
type AttemptPresentation = QuestionPresentation & { attempts?: DeliveryAttempt[]; activeAttemptId?: string };
const normalAttempt = (attempt: DeliveryAttempt) => Boolean(attempt.clockId && attempt.startedAtMs !== null && attempt.completedAtMs !== null && attempt.completedAtMs >= attempt.startedAtMs && !attempt.interrupted && !attempt.errorCodes?.length);

/** New runtime records preserve each browser-clock attempt; a later real replay never invents the earlier completion. */
function recordRuntimePresentation(session: InterviewSession, event: PresentationEvent, turn: PreparedTurn) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  const playing = event.type === 'question_playing', ended = event.type === 'audio_ended' && payload.role === 'question';
  const interrupted = event.type === 'client_error' || event.type === 'phase_changed' && ['suspended', 'error', 'ending'].includes(event.phase ?? '');
  let record = session.questionPresentations?.find(row => row.turnId === turn.id) as AttemptPresentation | undefined;
  if (!playing && !ended && !(interrupted && record?.attempts?.some(attempt => attempt.startedAtMs !== null && attempt.completedAtMs === null))) return false;
  if (!record) {
    record = { turnId: turn.id, rootTurnId: turn.parentMainQuestionId, questionKind: turn.questionKind, startedAtMs: null, completedAtMs: null, attempts: [] };
    (session.questionPresentations ??= []).push(record);
  }
  if (!record.attempts) {
    record.attempts = [{ attemptId: `saved:${turn.id}:${record.clockId ?? 'unverified'}`, clockId: record.clockId, startedAtMs: record.startedAtMs, completedAtMs: record.completedAtMs, interrupted: record.interrupted, errorCodes: record.errorCodes ? [...record.errorCodes] : undefined, eventIds: [] }];
    if (record.startedAtMs !== null) record.activeAttemptId = record.attempts[0].attemptId;
  }
  const attempts = record.attempts;
  let attempt: DeliveryAttempt | undefined;
  const fresh = () => { const row: DeliveryAttempt = { attemptId: event.eventId, clockId: event.clockId, startedAtMs: null, completedAtMs: null, eventIds: [] }; attempts.push(row); return row; };
  if (playing) {
    attempt = [...attempts].reverse().find(row => row.clockId === event.clockId && (row.startedAtMs === event.atMs || row.startedAtMs === null && (row.completedAtMs === null || event.atMs <= row.completedAtMs) || row.startedAtMs !== null && row.completedAtMs === null));
    attempt ??= fresh();
    attempt.startedAtMs = attempt.startedAtMs === null ? event.atMs : Math.min(attempt.startedAtMs, event.atMs);
    record.activeAttemptId = attempt.attemptId;
  } else if (ended) {
    attempt = [...attempts].reverse().find(row => row.clockId === event.clockId && row.startedAtMs !== null && row.completedAtMs === null);
    attempt ??= attempts.find(row => row.clockId === event.clockId && row.completedAtMs === event.atMs);
    if (!attempt) {
      const active = attempts.find(row => row.attemptId === record!.activeAttemptId);
      if (active?.startedAtMs !== null && active?.completedAtMs === null && active?.clockId !== event.clockId) active.errorCodes = [...new Set([...(active.errorCodes ?? []), 'PRESENTATION_CLOCK_CONFLICT'])];
      attempt = fresh();
    }
    attempt.completedAtMs = event.atMs;
  } else {
    attempt = attempts.find(row => row.attemptId === record!.activeAttemptId) ?? [...attempts].reverse().find(row => row.startedAtMs !== null && row.completedAtMs === null);
    if (!attempt || attempt.completedAtMs !== null) return false;
    attempt.interrupted = true;
    if (event.type === 'client_error') attempt.errorCodes = [...new Set([...(attempt.errorCodes ?? []), 'QUESTION_DELIVERY_ERROR'])];
  }
  if (!event.clockId || !attempt.clockId) attempt.errorCodes = [...new Set([...(attempt.errorCodes ?? []), 'PRESENTATION_CLOCK_UNVERIFIED'])];
  if (attempt.startedAtMs !== null && attempt.completedAtMs !== null && attempt.completedAtMs >= attempt.startedAtMs) {
    attempt.interrupted = false;
    attempt.errorCodes = attempt.errorCodes?.filter(code => code !== 'QUESTION_DELIVERY_ERROR');
  }
  attempt.eventIds.push(event.eventId); (session.questionPresentationEventIds ??= []).push(event.eventId);
  // Keep one effective record for existing evaluation consumers and retain every original attempt beside it.
  const projected = [...attempts].reverse().find(normalAttempt) ?? attempts.find(row => row.attemptId === record!.activeAttemptId) ?? [...attempts].reverse().find(row => row.startedAtMs !== null) ?? attempt;
  record.clockId = projected.clockId; record.startedAtMs = projected.startedAtMs; record.completedAtMs = projected.completedAtMs;
  record.interrupted = projected.interrupted; record.errorCodes = projected.errorCodes ? [...projected.errorCodes] : undefined;
  return true;
}
/** Never equate a prepared question or an acknowledgement with a delivered evaluation demand. */
export function recordQuestionPresentation(session: InterviewSession, event: PresentationEvent, turn: PreparedTurn | undefined) {
  if (!turn || event.turnId !== turn.id || session.status === 'completed') return false;
  if (session.questionPresentationEventIds?.includes(event.eventId)) return false;
  if (session.runtime) return recordRuntimePresentation(session, event, turn);
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  const playing = event.type === 'question_playing', ended = event.type === 'audio_ended' && payload.role === 'question';
  const interrupted = event.type === 'client_error' || event.type === 'phase_changed' && ['suspended', 'error', 'ending'].includes(event.phase ?? '');
  let record = session.questionPresentations?.find(item => item.turnId === turn.id);
  if (!playing && !ended && !(interrupted && record?.startedAtMs !== null && record?.completedAtMs === null)) return false;
  if (!record) {
    record = { turnId: turn.id, rootTurnId: turn.parentMainQuestionId, questionKind: turn.questionKind, clockId: event.clockId, startedAtMs: null, completedAtMs: null };
    (session.questionPresentations ??= []).push(record);
  }
  (session.questionPresentationEventIds ??= []).push(event.eventId);
  if (!event.clockId || !record.clockId) issue(record, 'PRESENTATION_CLOCK_UNVERIFIED');
  if (record.clockId && event.clockId && record.clockId !== event.clockId) { issue(record, 'PRESENTATION_CLOCK_CONFLICT'); return true; }
  if (playing) {
    if (record.completedAtMs !== null && event.atMs > record.completedAtMs) { record.startedAtMs = event.atMs; record.completedAtMs = null; }
    else record.startedAtMs = record.startedAtMs === null ? event.atMs : Math.min(record.startedAtMs, event.atMs);
  } else if (ended) {
    record.completedAtMs = record.completedAtMs === null ? event.atMs : Math.max(record.completedAtMs, event.atMs);
  } else if (record.completedAtMs === null) {
    record.interrupted = true;
    if (event.type === 'client_error') issue(record, 'QUESTION_DELIVERY_ERROR');
  }
  if (record.startedAtMs !== null && record.completedAtMs !== null && record.completedAtMs >= record.startedAtMs) {
    record.interrupted = false;
    record.errorCodes = record.errorCodes?.filter(code => code !== 'QUESTION_DELIVERY_ERROR');
  }
  return true;
}
