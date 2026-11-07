import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { localDevelopmentOwner } from '../session-runtime';
import type { ConversationLogRepository, ConversationLogScope } from './conversation-log-ports';
import { withLocalWriterFence } from '../transition/local-writer-fence';

export interface ConversationLogFileSystem { mkdir: typeof mkdir; open: typeof open; readFile: typeof readFile }
export function createLocalConversationLogRepository(root = process.cwd(), options: {
  directory?: string; io?: Partial<ConversationLogFileSystem>;
} = {}): ConversationLogRepository {
  const directory = path.resolve(options.directory ?? path.join(root, 'data/conversation-logs'));
  const io = { mkdir, open, readFile, ...options.io }, ownerId = localDevelopmentOwner().id;
  const file = (scope: ConversationLogScope) => {
    if (!scope.ownerId || scope.ownerId !== ownerId) throw new Error('CONVERSATION_LOG_OWNER_MISMATCH');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(scope.sessionId)) throw new Error('CONVERSATION_LOG_SESSION_INVALID');
    return path.join(directory, `${scope.sessionId}.jsonl`);
  };
  return { ownerId,
    coordinationKey: file,
    async ensureDirectory(scope) { file(scope); await withLocalWriterFence(root, () => io.mkdir(directory, { recursive: true, mode: 0o700 })); },
    async read(scope) { return io.readFile(file(scope), 'utf8'); },
    async append(request) {
      return withLocalWriterFence(root, async () => {
      const handle = await io.open(file(request), 'a', 0o600);
      try { await handle.chmod(0o600); await handle.writeFile(request.text); }
      finally { await handle.close(); }
      });
    },
    async sync(scope) {
      return withLocalWriterFence(root, async () => {
      const handle = await io.open(file(scope), 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      });
    },
  };
}
