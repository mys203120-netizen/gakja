import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localDevelopmentOwner } from '../session-runtime';
import { assertAudioOwner, type AudioReadRequest, type AudioRepository } from './audio-ports';
import { withLocalWriterFence } from '../transition/local-writer-fence';

export interface LocalAudioFileSystem {
  mkdir: typeof mkdir; readFile: typeof readFile; writeFile: typeof writeFile; rename: typeof rename; unlink: typeof unlink;
}
export interface LocalAudioRepositoryOptions {
  /** Existing SpeechAudioCache(directory, ...) compatibility. The exact
   * directory spelling is retained for its existing persist callback. */
  directory?: string;
  persistBytes?: (file: string, bytes: Buffer) => Promise<void>;
  /** Narrow isolated writer fault-injection seam; production uses native fs. */
  io?: Partial<LocalAudioFileSystem>;
  temporaryId?: () => string;
}

/** Local byte storage only. Synthesis, shared subscriptions, RAM readiness and
 * question/audio approval remain with their existing callers. */
export function createLocalAudioRepository(root = process.cwd(), options: LocalAudioRepositoryOptions = {}): AudioRepository {
  const directory = options.directory ?? path.resolve(root, 'data/audio');
  const io: LocalAudioFileSystem = { mkdir, readFile, writeFile, rename, unlink, ...options.io };
  const temporaryId = options.temporaryId ?? randomUUID;
  const file = (request: AudioReadRequest) => {
    assertAudioOwner(repository, request.scope);
    if (!/^[a-f0-9]{64}$/u.test(request.id)) throw new Error('AUDIO_REPOSITORY_ID_INVALID');
    return path.join(directory, `${request.id}.mp3`);
  };
  const repository: AudioRepository = {
    ownerId: localDevelopmentOwner().id,
    async read(request) { return io.readFile(file(request)); },
    async publish(request) {
      return withLocalWriterFence(root, async () => {
      const destination = file(request);
      if (request.publication === 'speech-cache') {
        await io.mkdir(directory, { recursive: true });
        if (options.persistBytes) await options.persistBytes(destination, request.bytes);
        else await io.writeFile(destination, request.bytes, { mode: 0o600 });
        return;
      }
      await io.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      const temporary = `${destination}.${temporaryId()}.tmp`;
      try {
        await io.writeFile(temporary, request.bytes, { mode: 0o600, flag: 'wx' });
        await io.rename(temporary, destination);
      } finally { await io.unlink(temporary).catch(() => {}); }
      });
    },
  };
  return repository;
}
