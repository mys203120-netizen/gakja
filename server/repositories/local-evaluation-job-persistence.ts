import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { EvaluationJobFileOptions, EvaluationJobPersistence } from './evaluation-job-ports';
import { withLocalWriterFence } from '../transition/local-writer-fence';

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export const localEvaluationJobDirectory = (root = process.cwd()) => path.join(root, 'data/evaluation-jobs');
/** Existing file names, JSON bytes, replace retries and short transaction lock.
 * No cache, new lease policy, distributed lock, cleanup or fsync is introduced. */
export function createLocalEvaluationJobPersistence(directory = localEvaluationJobDirectory(), io: EvaluationJobFileOptions = {}): EvaluationJobPersistence {
  const file = (id: string, suffix: string) => {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('EVALUATION_JOB_ID_INVALID');
    if (!['job', 'snapshot', 'result', 'quarantine', 'lock'].includes(suffix)) throw new Error('EVALUATION_DOCUMENT_KIND_INVALID');
    return path.join(directory, `${id}.${suffix}.json`);
  };
  return {
    read: reference => readFile(file(reference.id, reference.kind)),
    async listJobIds() {
      const files = await readdir(directory).catch(error => { if (isMissing(error)) return []; throw error; });
      return files.filter(name => /^[a-f0-9]{64}\.job\.json$/u.test(name)).map(name => name.slice(0, 64));
    },
    async atomic(reference, value) {
      return withLocalWriterFence(path.dirname(path.dirname(directory)), async () => {
      const destination = file(reference.id, reference.kind);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      const delays = [10, 25, 50, 100, 150, 200];
      for (let attempt = 0; ; attempt++) {
        try { await (io.replaceFile ?? rename)(temporary, destination); return; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= delays.length) throw error;
          await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        }
      }
      });
    },
    async locked(id, operation) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const lockFile = file(id, 'lock'), token = randomUUID();
      const deadline = Date.now() + 3_000;
      for (;;) {
        try {
          const handle = await open(lockFile, 'wx', 0o600);
          await handle.writeFile(JSON.stringify({ token, pid: process.pid, expiresAt: Date.now() + 30_000 }));
          await handle.close(); break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          let old: { token?: string; pid?: number; expiresAt?: number };
          try { old = JSON.parse(await (io.readLockFile?.(lockFile) ?? readFile(lockFile, 'utf8'))); }
          catch (readError) {
            if (isMissing(readError)) continue;
            const transientRead = ['EPERM', 'EACCES', 'EBUSY'].includes((readError as NodeJS.ErrnoException).code ?? '');
            if ((readError instanceof SyntaxError || transientRead) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 15)); continue; }
            throw new Error('EVALUATION_LOCK_INVALID', { cause: readError });
          }
          if (old.expiresAt && old.expiresAt < Date.now()) {
            let alive = true;
            try { if (old.pid) process.kill(old.pid, 0); } catch (probe) { alive = (probe as NodeJS.ErrnoException).code !== 'ESRCH'; }
            if (!alive && (JSON.parse(await readFile(lockFile, 'utf8')) as { token: string }).token === old.token) {
              await unlink(lockFile).catch(error => { if (!isMissing(error)) throw error; }); continue;
            }
          }
          if (Date.now() >= deadline) throw new Error('EVALUATION_JOB_BUSY');
          await new Promise(resolve => setTimeout(resolve, 15));
        }
      }
      try { return await operation(); }
      finally {
        const current = JSON.parse(await readFile(lockFile, 'utf8')) as { token: string };
        if (current.token === token) await unlink(lockFile);
      }
    },
  };
}
/** Compatibility composition for callers supplying the old directory-based
 * constructor. New worker compositions may pass an explicit review repository. */
export const localEvaluationReviewRoot = (directory: string) => path.dirname(path.dirname(directory));
