import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TransitionScope } from './transition-ports';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export class LocalWriterFenceError extends Error {}
interface Control {
  version: 'scoped-local-writer-v1'; rootHash: string; scope: TransitionScope;
  state: 'local-primary' | 'blocked' | 'sealed'; generation: string; archive: string | null;
}
const paths = (root: string) => {
  const resolved = path.resolve(root), controlRoot = path.join(resolved, '.local/scoped-writer');
  return { root: resolved, controlRoot, control: path.join(controlRoot, 'control.json'), lock: path.join(controlRoot, 'writer.lock'), data: path.join(resolved, 'data') };
};
async function readControl(root: string): Promise<Control | null> {
  const p = paths(root);
  let raw: string;
  try { raw = await readFile(p.control, 'utf8'); } catch (error) { if (missing(error)) return null; throw error; }
  const value = JSON.parse(raw) as Control;
  if (value.version !== 'scoped-local-writer-v1' || value.rootHash !== sha(p.root) ||
      !['local-primary', 'blocked', 'sealed'].includes(value.state)) throw new LocalWriterFenceError('LOCAL_WRITER_CONTROL_INVALID');
  return value;
}
async function lock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const p = paths(root), token = randomUUID(), deadline = Date.now() + 3_000;
  for (;;) {
    try {
      const handle = await open(p.lock, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname(), rootHash: sha(p.root) })); await handle.sync(); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new LocalWriterFenceError('LOCAL_WRITER_BUSY');
      await wait(15);
    }
  }
  try { return await operation(); }
  finally {
    const current = JSON.parse(await readFile(p.lock, 'utf8')) as { token: string };
    if (current.token !== token) throw new LocalWriterFenceError('LOCAL_WRITER_LOCK_CHANGED');
    await unlink(p.lock);
  }
}
async function store(root: string, value: Control) {
  const p = paths(root), temporary = `${p.control}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  await rename(temporary, p.control);
}

/** Opt-in only. The same cross-process lock covers the final rename/append and
 * activation. Unregistered old binaries are blocked separately by a physical
 * barrier; a DB read followed by an unlocked local rename is never a fence. */
export async function withLocalWriterFence<T>(root: string, operation: () => Promise<T>): Promise<T> {
  if (!await readControl(root)) return operation();
  return lock(root, async () => {
    const control = await readControl(root);
    if (!control || control.state !== 'local-primary') throw new LocalWriterFenceError('LOCAL_WRITER_FENCED');
    return operation();
  });
}
export async function assertLocalCommandAllowed(root: string) {
  const control = await readControl(root);
  if (control && control.state !== 'local-primary') throw new LocalWriterFenceError('LOCAL_WRITER_FENCED');
}

export interface LocalSourceAuthority { readonly kind: 'registered-local-source-v1' }
interface SourceRegistration {
  root: string; scope: TransitionScope;
  /** Must recheck the finite DB operator grant and actual stopped participant
   * inventory. Not supplied by a user/session DTO or inferred from ENV. */
  authorize: (action: 'prepare' | 'activate' | 'rollback-empty' | 'recover') => Promise<void>;
}
const sources = new WeakMap<LocalSourceAuthority, SourceRegistration>();
export function registerLocalSource(input: SourceRegistration): LocalSourceAuthority {
  if (!path.isAbsolute(input.root) || !input.scope.ownerId || !input.scope.studentId || !input.scope.applicationTargetId || !input.scope.supportTargetId)
    throw new LocalWriterFenceError('LOCAL_SOURCE_REGISTRATION_INVALID');
  const authority = Object.freeze({ kind: 'registered-local-source-v1' as const });
  sources.set(authority, { ...input, root: path.resolve(input.root) }); return authority;
}
function source(authority: LocalSourceAuthority) {
  const value = sources.get(authority); if (!value) throw new LocalWriterFenceError('LOCAL_SOURCE_AUTHORITY_REQUIRED'); return value;
}
async function ordinaryDirectory(file: string) {
  const value = await lstat(file);
  if (!value.isDirectory() || value.isSymbolicLink() || path.relative(path.resolve(file),await realpath(file)) !== '') throw new LocalWriterFenceError('LOCAL_SOURCE_DIRECTORY_REQUIRED');
}
export async function installLocalWriterFence(authority: LocalSourceAuthority) {
  const value = source(authority), p = paths(value.root); await value.authorize('prepare');
  await ordinaryDirectory(p.root); await ordinaryDirectory(p.data);
  await mkdir(p.controlRoot, { recursive: true, mode: 0o700 });
  await ordinaryDirectory(p.controlRoot);
  return lock(value.root, async () => {
    const existing = await readControl(value.root);
    if (existing) {
      if (JSON.stringify(existing.scope) !== JSON.stringify(value.scope)) throw new LocalWriterFenceError('LOCAL_SOURCE_SCOPE_CHANGED');
      return existing;
    }
    const initial: Control = { version: 'scoped-local-writer-v1', rootHash: sha(p.root), scope: value.scope, state: 'local-primary', generation: '0', archive: null };
    await store(value.root, initial); return initial;
  });
}
async function inventory(root: string) {
  const files: { path: string; bytes: number; sha256: string }[] = [];
  let activeLegacySessions = 0, pendingJobs = 0;
  async function walk(directory: string, prefix: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name, absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new LocalWriterFenceError('LOCAL_SOURCE_SYMLINK_REJECTED');
      if (entry.isDirectory()) { await walk(absolute, relative); continue; }
      if (!entry.isFile()) throw new LocalWriterFenceError('LOCAL_SOURCE_SPECIAL_FILE_REJECTED');
      const bytes = await readFile(absolute); files.push({ path: relative, bytes: bytes.length, sha256: sha(bytes) });
      if (/^sessions\/[0-9a-f-]+\.json$/iu.test(relative)) {
        const session = JSON.parse(bytes.toString('utf8')) as { status?: string; runtime?: { version?: string } };
        if (['active', 'ending'].includes(session.status ?? '')) activeLegacySessions++;
        if (session.runtime && session.runtime.version !== 'session-runtime-v1') throw new LocalWriterFenceError('LOCAL_SOURCE_AUTHENTICATED_SESSION_REJECTED');
      }
      if (/^evaluation-jobs\/.*\.job\.json$/u.test(relative)) {
        const job = JSON.parse(bytes.toString('utf8')) as { status?: string };
        if (['queued', 'running'].includes(job.status ?? '')) pendingJobs++;
      }
      if (/\.(?:tmp|lock)$/u.test(relative) || /\.lock\.json$/u.test(relative)) throw new LocalWriterFenceError('LOCAL_SOURCE_UNCONFIRMED_WRITE');
    }
  }
  await walk(root, ''); files.sort((a, b) => a.path.localeCompare(b.path));
  if (activeLegacySessions || pendingJobs) throw new LocalWriterFenceError('LOCAL_SOURCE_ACTIVE_WORK_EXCLUDED');
  return { version: 'scoped-local-checkpoint-v1', files, activeLegacySessions, pendingJobs };
}
const barrier = (control: Control) => JSON.stringify({ version: 'scoped-local-data-barrier-v1', rootHash: control.rootHash, generation: control.generation });
/** `activate` runs while holding the exact lock used by participating writes.
 * The original data path becomes a regular file: a restarted unmodified old
 * process cannot mkdir/rename below it. No ACL or original source is changed. */
export async function sealLocalSource<T>(authority: LocalSourceAuthority, input: {
  generation: string; stoppedParticipantProofSha256: string;
  activate: (evidence: { localEvidenceJson: string; localEvidenceSha256: string; checkpointJson: string; checkpointSha256: string }) => Promise<T>;
}) {
  const value = source(authority), p = paths(value.root); await value.authorize('activate');
  if (!/^[a-f0-9]{64}$/u.test(input.stoppedParticipantProofSha256) || !/^\d+$/u.test(input.generation)) throw new LocalWriterFenceError('LOCAL_SOURCE_STOP_PROOF_REQUIRED');
  return lock(value.root, async () => {
    let control = await readControl(value.root);
    if (!control) throw new LocalWriterFenceError('LOCAL_WRITER_NOT_INSTALLED');
    if (control.state === 'local-primary') {
      await ordinaryDirectory(p.data);
      await inventory(p.data); // reject an active legacy scope before fencing it
      // Persist blocked before moving anything. A crash is fail-closed and can
      // resume using the recorded archive; never recreate an empty source.
      control = { ...control, state: 'blocked', generation: input.generation, archive: `snapshots/${input.generation}/data` };
      await store(value.root, control);
    }
    if (control.generation !== input.generation || !control.archive) throw new LocalWriterFenceError('LOCAL_SOURCE_GENERATION_CHANGED');
    const archive = path.resolve(p.controlRoot, control.archive);
    if (!archive.startsWith(`${p.controlRoot}${path.sep}snapshots${path.sep}`)) throw new LocalWriterFenceError('LOCAL_SOURCE_ARCHIVE_INVALID');
    const dataStat = await lstat(p.data).catch(error => { if (missing(error)) return null; throw error; });
    if (dataStat?.isDirectory()) {
      await inventory(p.data);
      await mkdir(path.dirname(archive), { recursive: true, mode: 0o700 });
      if (await lstat(archive).then(() => true).catch(error => { if (missing(error)) return false; throw error; })) throw new LocalWriterFenceError('LOCAL_SOURCE_ARCHIVE_CONFLICT');
      await rename(p.data, archive);
    } else if (dataStat && (!dataStat.isFile() || await readFile(p.data, 'utf8') !== barrier(control))) throw new LocalWriterFenceError('LOCAL_SOURCE_BARRIER_CONFLICT');
    await ordinaryDirectory(archive);
    // wx cannot overwrite a concurrently recreated directory/file. Failure
    // leaves DB activation uncalled and source blocked for operator recovery.
    if (!dataStat || dataStat.isDirectory()) await writeFile(p.data, barrier(control), { flag: 'wx', mode: 0o600 });
    const checkpointJson = JSON.stringify(await inventory(archive));
    const localEvidenceJson = JSON.stringify({ scope: value.scope, inventoryComplete: true, activeLegacySessions: 0,
      unparticipatingProcesses: 0, writeBarrierInstalled: true, stoppedParticipantProofSha256: input.stoppedParticipantProofSha256 });
    control = { ...control, state: 'sealed' }; await store(value.root, control);
    return input.activate({ localEvidenceJson, localEvidenceSha256: sha(localEvidenceJson), checkpointJson, checkpointSha256: sha(checkpointJson) });
  });
}
export async function restoreLocalSourceAfterEmptyRollback(authority: LocalSourceAuthority, verifyDurableEmptyReceipt: () => Promise<void>) {
  const value = source(authority), p = paths(value.root); await value.authorize('rollback-empty');
  return lock(value.root, async () => {
    await verifyDurableEmptyReceipt();
    const control = await readControl(value.root);
    if (!control || control.state !== 'sealed' || !control.archive || await readFile(p.data, 'utf8') !== barrier(control)) throw new LocalWriterFenceError('LOCAL_SOURCE_ROLLBACK_NOT_SAFE');
    const archive = path.resolve(p.controlRoot, control.archive);
    if (!archive.startsWith(`${p.controlRoot}${path.sep}snapshots${path.sep}`)) throw new LocalWriterFenceError('LOCAL_SOURCE_ARCHIVE_INVALID');
    await ordinaryDirectory(archive); await unlink(p.data); await rename(archive, p.data);
    await store(value.root, { ...control, state: 'local-primary', archive: null });
  });
}
/** No lease/time-based stealing. Explicit operator recovery only, same host,
 * exact token and confirmed ESRCH. PID reuse/live/unknown hosts stay blocked. */
export async function recoverDeadLocalWriterLock(authority: LocalSourceAuthority) {
  const value = source(authority), p = paths(value.root); await value.authorize('recover');
  const recovery = await open(`${p.lock}.recovery`, 'wx', 0o600);
  try {
    const raw = await readFile(p.lock, 'utf8'), old = JSON.parse(raw) as { pid: number; host: string; rootHash: string; token: string };
    if (!old.token || !Number.isSafeInteger(old.pid) || old.host !== hostname() || old.rootHash !== sha(p.root)) throw new LocalWriterFenceError('LOCAL_WRITER_RECOVERY_UNCONFIRMED');
    try { process.kill(old.pid, 0); throw new LocalWriterFenceError('LOCAL_WRITER_STILL_ALIVE'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    if (await readFile(p.lock, 'utf8') !== raw) throw new LocalWriterFenceError('LOCAL_WRITER_LOCK_CHANGED');
    await unlink(p.lock);
  } finally { await recovery.close(); await unlink(`${p.lock}.recovery`); }
}

/** A finite operator-approved complete inventory must supply every participant
 * on this root/host. This verifies actual OS liveness; unknown hosts/EPERM/PID
 * reuse remain blocked. It cannot discover or fence another computer. */
export function inspectStoppedLocalParticipants(input: { root: string; inventoryComplete: boolean;
  participants: readonly { pid: number; host: string; rootHash: string }[] }) {
  const rootHash = sha(path.resolve(input.root)); let unparticipatingProcesses = 0;
  for (const row of input.participants) {
    if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || row.host !== hostname() || row.rootHash !== rootHash) { unparticipatingProcesses++; continue; }
    try { process.kill(row.pid,0); unparticipatingProcesses++; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') unparticipatingProcesses++; }
  }
  return { complete: input.inventoryComplete, unparticipatingProcesses,
    proofSha256: sha(JSON.stringify({ version:'stopped-local-participants-v1', rootHash, participants:input.participants, inventoryComplete:input.inventoryComplete })) };
}
