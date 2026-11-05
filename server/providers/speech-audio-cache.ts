import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type SpeechRole = "primary" | "secondary";
export interface SpeechSynthesisSettings { speaker: string; speed: number; pitch: number; volume: number; format: "mp3" }
export interface SpeechSynthesisTiming {
  cache: "memory" | "disk" | "provider" | "shared";
  durationMs: number;
  providerMs: number | null;
  audioId: string;
  settings?: SpeechSynthesisSettings;
}
export interface SpeechSynthesisOptions { role?: SpeechRole; settings?: SpeechSynthesisSettings; signal?: AbortSignal; onTiming?: (timing: SpeechSynthesisTiming) => void }

type SynthesisResult = { cache: "disk" | "provider"; providerMs: number | null };
interface SharedSynthesis {
  controller: AbortController;
  subscribers: Set<symbol>;
  promise: Promise<SynthesisResult>;
  settled: boolean;
}

/** Bounded private audio cache. Readiness means real bytes are available, not that a disk write finished. */
export class SpeechAudioCache {
  private memory = new Map<string, Buffer>();
  private memoryBytes = 0;
  private inFlight = new Map<string, SharedSynthesis>();
  private writes = new Map<string, Promise<void>>();
  constructor(private directory: string, private maxBytes = 32 * 1024 * 1024, private maxEntries = 192,
    private persistBytes: (file: string, bytes: Buffer) => Promise<void> = async (file, bytes) => { await writeFile(file, bytes, { mode: 0o600 }); }) {}

  private inMemory(id: string) {
    const bytes = this.memory.get(id);
    if (bytes) { this.memory.delete(id); this.memory.set(id, bytes); }
    return bytes;
  }
  private remember(id: string, bytes: Buffer) {
    if (bytes.length > this.maxBytes) return;
    const previous = this.memory.get(id);
    if (previous) { this.memoryBytes -= previous.length; this.memory.delete(id); }
    this.memory.set(id, bytes); this.memoryBytes += bytes.length;
    while (this.memoryBytes > this.maxBytes || this.memory.size > this.maxEntries) {
      const oldest = this.memory.keys().next().value;
      if (!oldest) break;
      this.memoryBytes -= this.memory.get(oldest)!.length;
      this.memory.delete(oldest);
    }
  }
  private file(id: string) { return path.join(this.directory, `${id}.mp3`); }
  private persist(id: string, bytes: Buffer) {
    const write = (async () => { await mkdir(this.directory, { recursive: true }); await this.persistBytes(this.file(id), bytes); })()
      .catch(() => { console.warn("면접 음성의 디스크 캐시 저장에 실패했습니다. 현재 음성은 메모리에 보존합니다."); });
    this.writes.set(id, write);
    void write.then(() => { if (this.writes.get(id) === write) this.writes.delete(id); });
  }

  private start(id: string, load: (signal: AbortSignal) => Promise<Buffer>): SharedSynthesis {
    const operation: SharedSynthesis = { controller: new AbortController(), subscribers: new Set(), promise: null!, settled: false };
    this.inFlight.set(id, operation);
    const active = () => {
      operation.controller.signal.throwIfAborted();
      if (this.inFlight.get(id) !== operation) throw new DOMException("음성 합성 요청이 종료되었습니다.", "AbortError");
    };
    operation.promise = (async () => {
      let disk: Buffer | null = null;
      try { disk = await readFile(this.file(id)); }
      catch { /* A missing private cache entry is synthesized by the real provider. */ }
      active();
      if (disk?.length) { this.remember(id, disk); return { cache: "disk" as const, providerMs: null }; }
      const providerStarted = performance.now();
      const bytes = await load(operation.controller.signal);
      active(); // Providers that ignore abort cannot publish late or superseded bytes.
      const providerMs = performance.now() - providerStarted;
      if (!bytes.length) throw new Error("음성 합성 결과가 비어 있습니다.");
      this.remember(id, bytes);
      this.persist(id, bytes);
      return { cache: "provider" as const, providerMs };
    })();
    const finish = () => { operation.settled = true; if (this.inFlight.get(id) === operation) this.inFlight.delete(id); };
    // An abandoned producer may reject after its last subscriber has left.
    // Always observe that rejection, without retaining the abandoned operation.
    void operation.promise.then(finish, finish);
    return operation;
  }

  private subscribe(id: string, operation: SharedSynthesis, signal?: AbortSignal): Promise<SynthesisResult> {
    return new Promise((resolve, reject) => {
      const subscriber = Symbol(id);
      let finished = false;
      const leave = () => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", cancel);
        operation.subscribers.delete(subscriber);
        if (!operation.settled && operation.subscribers.size === 0) {
          operation.controller.abort(new DOMException("음성 합성을 기다리는 요청이 없습니다.", "AbortError"));
          if (this.inFlight.get(id) === operation) this.inFlight.delete(id);
        }
      };
      const cancel = () => { leave(); reject(signal!.reason); };
      operation.subscribers.add(subscriber);
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      void operation.promise.then(result => {
        if (finished) return;
        if (signal?.aborted) { cancel(); return; }
        leave(); resolve(result);
      }, error => { if (!finished) { leave(); reject(error); } });
    });
  }

  async getOrCreate(id: string, load: (signal: AbortSignal) => Promise<Buffer>, options: SpeechSynthesisOptions = {}) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("음성 캐시 식별자가 유효하지 않습니다.");
    options.signal?.throwIfAborted();
    const started = performance.now();
    const report = (cache: SpeechSynthesisTiming["cache"], providerMs: number | null) => {
      try { options.onTiming?.({ cache, durationMs: performance.now() - started, providerMs, audioId: id }); }
      catch { /* Observation callbacks cannot break real audio playback. */ }
    };
    if (this.inMemory(id)) { report("memory", null); options.signal?.throwIfAborted(); return `/api/audio/${id}`; }
    const shared = this.inFlight.get(id);
    const operation = shared ?? this.start(id, load);
    const result = await this.subscribe(id, operation, options.signal);
    options.signal?.throwIfAborted();
    report(shared ? "shared" : result.cache, shared ? null : result.providerMs);
    options.signal?.throwIfAborted();
    return `/api/audio/${id}`;
  }

  async read(id: string): Promise<Buffer | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    const bytes = this.inMemory(id);
    if (bytes) return bytes;
    await this.writes.get(id);
    try { const stored = await readFile(this.file(id)); if (!stored.length) return null; this.remember(id, stored); return stored; }
    catch { return null; }
  }

  /** Offline bank publication needs durable bytes. Real-time playback continues
   * to use read(), which intentionally returns ready RAM bytes immediately. */
  async readDurable(id: string): Promise<Buffer | null> {
    if (!/^[a-f0-9]{64}$/.test(id)) return null;
    await this.writes.get(id);
    try {
      const stored = await readFile(this.file(id)), memory = this.inMemory(id);
      if (!stored.length || memory && !stored.equals(memory)) return null;
      return stored;
    } catch { return null; }
  }

  /** Also used by shutdown/integration tests; synthesis itself never waits for persistence. */
  async flushWrites() { await Promise.all(this.writes.values()); }
}
