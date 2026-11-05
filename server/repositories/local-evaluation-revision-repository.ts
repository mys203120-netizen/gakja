import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { snapshotHash } from '../session-runtime';
import type { EvaluationRevisionRepository, EvaluationRevisionScope } from './evaluation-revision-ports';

export interface EvaluationRevisionFileSystem {
  link: typeof link; mkdir: typeof mkdir; readFile: typeof readFile;
  readdir: typeof readdir; unlink: typeof unlink; writeFile: typeof writeFile;
}
export function createLocalEvaluationRevisionRepository(root = process.cwd(), options: {
  io?: Partial<EvaluationRevisionFileSystem>; temporaryId?: () => string;
} = {}): EvaluationRevisionRepository {
  const io = { link, mkdir, readFile, readdir, unlink, writeFile, ...options.io };
  const directory = (scope: EvaluationRevisionScope) => path.join(root, 'data/evaluation-revisions', snapshotHash([scope.ownerId, scope.sessionId]));
  const filename = (scope: EvaluationRevisionScope, contentSha256: string) => {
    if (!/^[a-f0-9]{64}$/u.test(contentSha256)) throw new Error('EVALUATION_REVISION_ID_INVALID');
    return path.join(directory(scope), `${contentSha256}.json`);
  };
  return {
    list(scope) { return io.readdir(directory(scope)); },
    read(scope, contentSha256) { return io.readFile(filename(scope, contentSha256), 'utf8'); },
    async publish(scope, contentSha256, value) {
      const base = directory(scope);
      await io.mkdir(base, { recursive: true, mode: 0o700 });
      const file = filename(scope, contentSha256), content = JSON.stringify(value);
      // Preserve create-if-absent publication and existing partial-write cleanup:
      // a write failure occurs before the original try/finally cleanup boundary.
      const temporary = path.join(base, `.${contentSha256}.${(options.temporaryId ?? randomUUID)()}.tmp`);
      await io.writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      try {
        try { await io.link(temporary, file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await io.readFile(file, 'utf8') !== content) throw error; }
      } finally { await io.unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
    },
  };
}
