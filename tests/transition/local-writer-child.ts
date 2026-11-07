import { LocalSessionStore } from '../../server/storage/local-session-store';
import { rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InterviewSession } from '../../server/protocol';
const [root, mode, legacyModule] = process.argv.slice(2);
if (!root || !process.send) throw new Error('OWNED_CHILD_REQUIRED');
const session = { id:'10000000-0000-4000-8000-000000000001', status:'completed', turns:[], elapsedMs:7 } as unknown as InterviewSession;
const Store = mode === 'legacy' ? (await import(pathToFileURL(legacyModule).href)).LocalSessionStore : LocalSessionStore;
const store = new Store(path.join(root, 'data/sessions'), { async replaceFile(from: string,to: string) {
  process.send?.({ type:'before-rename',pid:process.pid });
  await new Promise<void>(resolve=>process.once('message',()=>resolve()));
  return rename(from,to);
} });
process.send({type:'boot',pid:process.pid});
try { await store.save(session); process.send({type:'written'}); }
catch(error) { process.send({type:'rejected',code:(error as NodeJS.ErrnoException).code??(error as Error).message}); }
process.disconnect?.();
