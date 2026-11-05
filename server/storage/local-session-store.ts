import { mkdir, writeFile, rename, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { InterviewSession } from "../protocol";
import type { InterviewContext } from '../data/load-interview-context';
import { assertSessionOwner, snapshotHash } from '../session-runtime';
import type { SessionStore } from './session-store';
export type { SessionStore } from './session-store';

export interface LocalSessionStoreOptions {
  replaceFile?: typeof rename;
  wait?: (milliseconds: number) => Promise<void>;
}
/** Local-only adapter. A future DB adapter can implement the same boundary. */
export class LocalSessionStore implements SessionStore {
  private writes = new Map<string, Promise<void>>();
  constructor(private directory = path.join(process.cwd(), "data", "sessions"), private readonly io: LocalSessionStoreOptions = {}) {}
  async load(id: string, ownerId: string): Promise<InterviewSession | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('INVALID_SESSION_ID');
    let text: string;
    try { text = await readFile(path.join(this.directory, `${id}.json`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const session = JSON.parse(text) as InterviewSession;
    if (session.id !== id || !Array.isArray(session.turns) || !['active', 'ending', 'completed'].includes(session.status) || !Number.isFinite(session.elapsedMs)) throw new Error('SESSION_SNAPSHOT_INVALID');
    assertSessionOwner(session, ownerId);
    return session;
  }
  async list(ownerId: string): Promise<InterviewSession[]> {
    const files = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const rows = await Promise.all(files.filter(file => /^[0-9a-f-]{36}\.json$/i.test(file)).map(file => this.load(file.slice(0, -5), ownerId).catch(() => null)));
    return rows.filter((row): row is InterviewSession => row !== null);
  }
  async saveContext(context: InterviewContext, ownerId: string) {
    const contentSha256 = snapshotHash(context), directory = path.join(path.dirname(this.directory), 'session-contexts');
    const file = path.join(directory, `${snapshotHash(ownerId)}-${contentSha256}.json`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const envelope = { version: 1, ownerId, contentSha256, context };
    try { await writeFile(file, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return contentSha256;
  }
  async loadContext(contentSha256: string, ownerId: string): Promise<InterviewContext> {
    if (!/^[a-f0-9]{64}$/i.test(contentSha256)) throw new Error('CONTEXT_SNAPSHOT_INVALID');
    const file = path.join(path.dirname(this.directory), 'session-contexts', `${snapshotHash(ownerId)}-${contentSha256}.json`);
    const envelope = JSON.parse(await readFile(file, 'utf8')) as { version: number; ownerId: string; contentSha256: string; context: InterviewContext };
    if (envelope.version !== 1 || envelope.ownerId !== ownerId || envelope.contentSha256 !== contentSha256 || snapshotHash(envelope.context) !== contentSha256) throw new Error('CONTEXT_SNAPSHOT_INVALID');
    return envelope.context;
  }
  save(session: InterviewSession) {
    if (!/^[0-9a-f-]{36}$/.test(session.id)) throw new Error("잘못된 세션 ID");
    const content = JSON.stringify(session, null, 2);
    const pending = (this.writes.get(session.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.directory, { recursive: true });
      const file = path.join(this.directory, `${session.id}.json`);
      const temporary = `${file}.tmp`;
      await writeFile(temporary, content, { mode: 0o600 });
      // Windows readers/security software can briefly deny an atomic replace.
      // Retry this exact snapshot, never delete the previous record or rebuild
      // its accepted end payload while another write is queued behind it.
      const delays = [10, 25, 50, 100, 150, 200];
      for (let attempt = 0; ; attempt++) {
        try { await (this.io.replaceFile ?? rename)(temporary, file); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= delays.length) throw error;
          await (this.io.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(delays[attempt]);
        }
      }
    });
    this.writes.set(session.id, pending);
    return pending;
  }
}

/** Composition owns the existing directory convention. Callers retain this
 * instance for their operation/server lifetime so its write queue is preserved. */
export function createLocalSessionStore(root = process.cwd(), options: LocalSessionStoreOptions = {}): LocalSessionStore {
  return new LocalSessionStore(path.join(root, 'data/sessions'), options);
}
