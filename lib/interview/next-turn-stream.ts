import type { PreparedTurn } from '../../server/protocol';
import type { ClosingUtterance } from '../../server/session-runtime';
import { serviceDisplayMessage } from './service-errors';
import type { ClientEventReceipt } from './client-event-contract';
import { readClientEventReceipt } from './client-events';
export type AcknowledgementReady = { type: 'acknowledgement_ready'; turnId: string; acknowledgement: string; acknowledgementAudioUrl: string; interviewerId: string };
export type NextTurnResult = { turn: PreparedTurn | null; done: boolean; closingUtterance?: ClosingUtterance } & ClientEventReceipt;
export type NextTurnProgress = AcknowledgementReady | ({ type: 'turn_ready' } & NextTurnResult) | { type: 'error'; message: string };
/** Share a request across resume/retry callers; only one caller may start its resulting playback. */
export class NextTurnOperation {
  readonly controller = new AbortController();
  readonly epoch: number;
  readonly sourceTurnId: string;
  readonly sessionId: string;
  acknowledgementTurnId?: string;
  result?: NextTurnResult;
  private response?: Promise<NextTurnResult>;
  private playbackStarted = false;
  constructor(epoch: number, sourceTurnId: string, sessionId: string) { this.epoch = epoch; this.sourceTurnId = sourceTurnId; this.sessionId = sessionId; }
  acknowledge(turnId: string) { if (this.acknowledgementTurnId && this.acknowledgementTurnId !== turnId) throw new Error('다음 질문의 식별자가 변경되었습니다.'); this.acknowledgementTurnId = turnId; }
  complete(value: NextTurnResult) { if (this.acknowledgementTurnId && value.turn?.id !== this.acknowledgementTurnId) throw new Error('연결 멘트와 다음 질문의 식별자가 일치하지 않습니다.'); this.result = value; }
  load(request: () => Promise<NextTurnResult>) { if (!this.response) { this.response = request().catch(error => { this.response = undefined; throw error; }); } return this.response; }
  startPlayback() { if (this.playbackStarted) return false; this.playbackStarted = true; return true; }
  retryPlayback() { this.playbackStarted = false; }
}
const invalid = () => new Error('다음 질문 응답을 확인하지 못했습니다. 같은 화면에서 다시 시도해 주세요.');
export class NextTurnResponseError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
function result(value: unknown): NextTurnResult {
  const row = record(value), turn = record(row.turn);
  if (typeof row.done !== 'boolean' || (row.turn !== null && (typeof turn.id !== 'string' || typeof turn.questionText !== 'string' || typeof turn.questionAudioUrl !== 'string' || !['main', 'follow_up', 'clarification'].includes(String(turn.questionKind))))) throw invalid();
  if (!row.done && row.turn === null) throw invalid();
  const closing = record(row.closingUtterance);
  if (row.closingUtterance !== undefined && (typeof closing.id !== 'string' || typeof closing.text !== 'string' || typeof closing.audioUrl !== 'string' || !closing.audioUrl.startsWith('/api/audio/') || typeof closing.interviewerId !== 'string' || closing.nonEvaluative !== true)) throw invalid();
  const receipt = readClientEventReceipt(row.acceptedClientEventIds);
  return { turn: row.turn as PreparedTurn | null, done: row.done, ...(row.closingUtterance ? { closingUtterance: row.closingUtterance as ClosingUtterance } : {}), ...(receipt ? { acceptedClientEventIds: receipt } : {}) };
}

/** Read progress without waiting for audio playback, so question preparation overlaps the acknowledgement. */
export async function readNextTurnResponse(response: Response, onAcknowledgement: (event: AcknowledgementReady) => void): Promise<NextTurnResult> {
  if (!response.ok) { const body = record(await response.json().catch(() => null)); throw new NextTurnResponseError(serviceDisplayMessage(body.error ?? body.message, 'question'), typeof body.code === 'string' ? body.code : undefined); }
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) return result(await response.json());
  if (!response.body) throw invalid();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const acknowledgements = new Map<string, string>();
  let acknowledgementTurnId: string | null = null;
  let pending = '';
  const parse = (line: string): NextTurnResult | null => {
    if (!line.trim()) return null;
    let raw; try { raw = JSON.parse(line); } catch { throw invalid(); }
    const row = record(raw);
    if (row.type === 'error') throw new NextTurnResponseError(serviceDisplayMessage(row.message, 'question'), typeof row.code === 'string' ? row.code : undefined);
    if (row.type === 'turn_ready') { const complete = result(row); if (acknowledgementTurnId && complete.turn?.id !== acknowledgementTurnId) throw invalid(); return complete; }
    if (row.type !== 'acknowledgement_ready' || typeof row.turnId !== 'string' || typeof row.acknowledgement !== 'string' || typeof row.acknowledgementAudioUrl !== 'string' || typeof row.interviewerId !== 'string') throw invalid();
    const signature = JSON.stringify([row.acknowledgement, row.acknowledgementAudioUrl, row.interviewerId]);
    if (acknowledgementTurnId && acknowledgementTurnId !== row.turnId) throw invalid(); acknowledgementTurnId = row.turnId;
    const previous = acknowledgements.get(row.turnId);
    if (previous && previous !== signature) throw invalid();
    if (!previous) { acknowledgements.set(row.turnId, signature); onAcknowledgement(row as AcknowledgementReady); }
    return null;
  };
  try {
    while (true) {
      const chunk = await reader.read(); pending += decoder.decode(chunk.value, { stream: !chunk.done });
      if (pending.length > 1_000_000) throw invalid();
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) { const complete = parse(pending.slice(0, newline)); pending = pending.slice(newline + 1); if (complete) return complete; }
      if (chunk.done) { const complete = parse(pending); if (complete) return complete; throw invalid(); }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
