import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localDevelopmentOwner } from '../session-runtime';
import type { QuestionBankRepository, QuestionBankRequest } from './question-bank-ports';

type LocalBankIo = { mkdir: typeof mkdir; readFile: typeof readFile; rename: typeof rename; unlink: typeof unlink; writeFile: typeof writeFile };
/** Same ready/partial files and wx-temp → rename → own-temp cleanup as before.
 * There is no new cache, retry, transaction or approval authority here. */
export function createLocalQuestionBankRepository(root = process.cwd(), options: { io?: LocalBankIo; temporaryId?: () => string } = {}): QuestionBankRepository {
  const io = options.io ?? { mkdir, readFile, rename, unlink, writeFile }, temporaryId = options.temporaryId ?? randomUUID;
  const ownerId = localDevelopmentOwner().id;
  const file = (request: QuestionBankRequest, partial: boolean) => {
    if (!request.scope.ownerId || request.scope.ownerId !== ownerId) throw new Error('QUESTION_BANK_REPOSITORY_OWNER_MISMATCH');
    if (!/^[a-f0-9]{64}$/u.test(request.scope.bankKey)) throw new Error('질문 은행 식별자가 유효하지 않습니다.');
    return path.resolve(root, 'data/prepared/question-banks', `${request.scope.bankKey}${partial ? '.partial' : ''}.json`);
  };
  const read = async (request: QuestionBankRequest, partial: boolean) => {
    const target = file(request, partial);
    try { return JSON.parse(await io.readFile(target, 'utf8')); } catch { return null; }
  };
  const write = async (request: QuestionBankRequest & { value: { key: string } }, partial: boolean) => {
    const target = file(request, partial);
    if (request.value.key !== request.scope.bankKey) throw new Error('QUESTION_BANK_REPOSITORY_KEY_MISMATCH');
    await io.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const nonce = temporaryId();
    if (!/^[0-9a-f-]{36}$/iu.test(nonce)) throw new Error('QUESTION_BANK_TEMPORARY_ID_INVALID');
    const temporary = `${target}.${nonce}.tmp`;
    try { await io.writeFile(temporary, JSON.stringify(request.value, null, 2), { mode: 0o600, flag: 'wx' }); await io.rename(temporary, target); }
    finally { await io.unlink(temporary).catch(() => {}); }
  };
  return { ownerId,
    readReady: request => read(request, false), readPartial: request => read(request, true),
    writePartial: request => write(request, true), publishReady: request => write(request, false),
    async removePartial(request) { const target = file(request, true); await io.unlink(target).catch(() => {}); },
  };
}
