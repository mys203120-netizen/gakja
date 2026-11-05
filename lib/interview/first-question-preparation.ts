export type PreparedFirstQuestion = { ready: true; preparationId: string; questionAudioUrl?: string; questionAudioUrls?: string[] };
type PreparationEntry = { key: string; controller: AbortController; createdAt: number; promise: Promise<PreparedFirstQuestion>; result?: PreparedFirstQuestion; failed: boolean };

/** Preparation may span device checks and countdown; it never creates a session or plays audio. */
export class FirstQuestionPreparation {
  private entry: PreparationEntry | null = null;
  constructor(private now: () => number = Date.now, private maxAgeMs = 10 * 60_000) {}
  ensure(key: string, request: (signal: AbortSignal) => Promise<PreparedFirstQuestion>): Promise<PreparedFirstQuestion> {
    const current = this.entry;
    if (current?.key === key && !current.failed && !current.controller.signal.aborted && this.now() - current.createdAt < this.maxAgeMs) return current.promise;
    this.cancel();
    const entry: PreparationEntry = { key, controller: new AbortController(), createdAt: this.now(), promise: Promise.resolve(null as unknown as PreparedFirstQuestion), failed: false };
    this.entry = entry;
    entry.promise = Promise.resolve().then(() => {
      if (entry.controller.signal.aborted) throw new DOMException('질문 준비가 취소되었습니다.', 'AbortError');
      return request(entry.controller.signal);
    }).then(result => {
      if (entry.controller.signal.aborted) throw new DOMException('질문 준비가 취소되었습니다.', 'AbortError');
      if (result.ready !== true || typeof result.preparationId !== 'string' || !result.preparationId) throw new Error('첫 질문을 준비하지 못했습니다.');
      entry.result = result;
      return result;
    }).catch(error => { entry.failed = true; throw error; });
    return entry.promise;
  }
  readyId(key: string) {
    const entry = this.entry;
    return entry?.key === key && !entry.failed && !entry.controller.signal.aborted && this.now() - entry.createdAt < this.maxAgeMs ? entry.result?.preparationId : undefined;
  }
  cancel() { this.entry?.controller.abort(); this.entry = null; }
}
