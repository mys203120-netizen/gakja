type AudioPreloadDependencies = Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'> & { fetch: typeof fetch };
const cancelled = () => new DOMException('음성 준비가 취소되었습니다.', 'AbortError');

/** Private, per-run audio cache. Object URLs never outlive the interview run that created them. */
export class InterviewAudioPreloader {
  private entries = new Map<string, { controller: AbortController; promise: Promise<string>; objectUrl?: string; retired: boolean }>();
  constructor(private dependencies: AudioPreloadDependencies = { fetch: (...args) => fetch(...args), createObjectURL: blob => URL.createObjectURL(blob), revokeObjectURL: url => URL.revokeObjectURL(url) }) {}
  prepare(sourceUrl: string) {
    const existing = this.entries.get(sourceUrl); if (existing) return existing.promise;
    const controller = new AbortController();
    const entry = { controller, promise: Promise.resolve(''), objectUrl: undefined as string | undefined, retired: false };
    entry.promise = (async () => {
      const response = await this.dependencies.fetch(sourceUrl, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`면접관 음성을 준비하지 못했습니다. (${response.status})`);
      const blob = await response.blob();
      if (entry.retired || controller.signal.aborted) throw cancelled();
      entry.objectUrl = this.dependencies.createObjectURL(blob);
      return entry.objectUrl;
    })().catch(error => { if (this.entries.get(sourceUrl) === entry) this.entries.delete(sourceUrl); throw error; });
    // A question may preload before its acknowledgement finishes; retain errors for the eventual consumer.
    void entry.promise.catch(() => {});
    this.entries.set(sourceUrl, entry);
    return entry.promise;
  }
  dispose() {
    for (const entry of this.entries.values()) { entry.retired = true; entry.controller.abort(); if (entry.objectUrl) this.dependencies.revokeObjectURL(entry.objectUrl); }
    this.entries.clear();
  }
}

/** Pausing blocks new sounds while the current HTML audio element retains its playback position. */
export class InterviewPlaybackGate {
  paused = false;
  private waiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  pause() { this.paused = true; }
  resume() { this.paused = false; const waiting = this.waiters.splice(0); waiting.forEach(item => item.resolve()); }
  wait() { return this.paused ? new Promise<void>((resolve, reject) => this.waiters.push({ resolve, reject })) : Promise.resolve(); }
  dispose() { this.paused = false; const waiting = this.waiters.splice(0); waiting.forEach(item => item.reject(cancelled())); }
}
