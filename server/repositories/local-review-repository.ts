import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReviewRepository } from './review-ports';

export const BANK_SCOPE_REGISTRY_DIRECTORY = 'data/prepared/evaluation-scope-registry';
export interface ReviewFileSystem {
  mkdir: typeof mkdir; open: typeof open; readFile: typeof readFile;
  rename: typeof rename; unlink: typeof unlink; writeFile: typeof writeFile;
}
/** No read cache: registry and receipt reads must remain fresh before execution
 * and again before result publication. Existing local writers are unchanged. */
export function createLocalReviewRepository(root = process.cwd(), options: {
  io?: Partial<ReviewFileSystem>; temporaryId?: () => string;
} = {}): ReviewRepository {
  const io = { mkdir, open, readFile, rename, unlink, writeFile, ...options.io }, temporaryId = options.temporaryId ?? randomUUID;
  const base = path.resolve(root, BANK_SCOPE_REGISTRY_DIRECTORY);
  const checked = (value: string) => { if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error('REVIEW_REPOSITORY_REFERENCE_INVALID'); return value; };
  const knowledgeRevisionPath = (digest: string) => `data/prepared/approved-knowledge/revisions/${checked(digest)}.json`;
  const evaluationContextPath = (digest: string) => `data/prepared/approved-knowledge/evaluation-contexts/${checked(digest)}.json`;
  const receiptFile = (digest: string) => path.resolve(root, 'data/prepared/approved-knowledge/session-receipts', `${checked(digest)}.json`);
  const immutable = async (file: string, content: string, encoding?: 'utf8') => {
    try { await io.writeFile(file, content, { ...(encoding ? { encoding } : {}), flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await io.readFile(file, 'utf8') !== content) throw error; }
  };
  const immutableInDirectory = async (file: string, content: string, encoding?: 'utf8') => {
    await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await immutable(file, content, encoding);
  };
  return {
    async readRegistryPointer() { return io.readFile(path.join(base, 'current.json'), 'utf8'); },
    async readRegistryRevision(digest) { return io.readFile(path.join(base, 'revisions', `${checked(digest)}.json`), 'utf8'); },
    async ensureRegistryRevisions() { await io.mkdir(path.join(base, 'revisions'), { recursive: true, mode: 0o700 }); },
    async acquireRegistryPublishLock() {
      const lockPath = path.join(base, 'publish.lock'), lock = await io.open(lockPath, 'wx', 0o600);
      return { async release() { await lock.close(); await io.unlink(lockPath); } };
    },
    async writeRegistryRevision(digest, content) { await immutable(path.join(base, 'revisions', `${checked(digest)}.json`), content); },
    async publishRegistryPointer(content) {
      const temporary = path.join(base, `current.${temporaryId()}.tmp`);
      await io.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await io.rename(temporary, path.join(base, 'current.json'));
    },
    async readSessionReceipt(digest) { return io.readFile(receiptFile(digest), 'utf8'); },
    async writeSessionReceipt(digest, content) { await immutableInDirectory(receiptFile(digest), content); },
    async writeKnowledgeRevision(digest, content, settings) { await immutableInDirectory(path.resolve(root, knowledgeRevisionPath(digest)), content, settings?.encoding); },
    knowledgeRevisionPath,
    async writeEvaluationContext(digest, content, settings) { await immutableInDirectory(path.resolve(root, evaluationContextPath(digest)), content, settings?.encoding); },
    evaluationContextPath,
  };
}
