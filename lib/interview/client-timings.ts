export type ClientTimes = Record<string, number>;
type Row = { turnId: string; playback: ClientTimes; answer: ClientTimes; transition: ClientTimes; nextTurnId?: string };
/** Current-question timestamps and submit→next-question timestamps deliberately occupy separate scopes. */
export class ClientTimingLedger {
  private rows = new Map<string, Row>();
  private row(turnId: string) { let row = this.rows.get(turnId); if (!row) { row = { turnId, playback: {}, answer: {}, transition: {} }; this.rows.set(turnId, row); } return row; }
  mark(turnId: string, scope: 'playback' | 'answer' | 'transition', key: string, now: number, replace = false) { if (Number.isFinite(now)) { if (replace) this.row(turnId)[scope][key] = now; else this.row(turnId)[scope][key] ??= now; } }
  link(sourceTurnId: string, nextTurnId: string) { this.row(sourceTurnId).nextTurnId = nextTurnId; }
  sourceFor(nextTurnId: string) { return [...this.rows.values()].find(row => row.nextTurnId === nextTurnId)?.turnId; }
  answer(turnId: string) { return { ...this.row(turnId).answer }; }
  transition(turnId: string) { const row = this.row(turnId); return { ...row.answer, ...row.transition }; }
  transitionSnapshot() { return Object.fromEntries([...this.rows.keys()].map(id => [id, this.transition(id)])); }
  playbackSnapshot() { return Object.fromEntries([...this.rows.values()].map(row => [row.turnId, { ...row.playback }])); }
  snapshot() { return [...this.rows.values()].map(row => ({ ...row, playback: { ...row.playback }, answer: { ...row.answer }, transition: { ...row.transition } })); }
  clear() { this.rows.clear(); }
}
