import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
const execute = promisify(execFile);
const normalized = value => value.replaceAll('\\', '/').toLowerCase();
const registryPath = root => path.join(root, '.local', 'server-processes.json');
const workspaceId = root => createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16);
export async function processSnapshot(root, ports = [], pids = []) {
  if (![...ports, ...pids].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('INVALID_PROCESS_QUERY');
  const source = await readFile(path.join(root, 'scripts/local-server-processes.ps1'), 'utf8');
  const command = `& {\n${source}\n} -Ports '${ports.join(',')}' -ExtraPids '${pids.join(',')}'`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.replace(/^\uFEFF/u, '').trim());
}
async function registry(root) {
  try { const value = JSON.parse(await readFile(registryPath(root), 'utf8')); return value.workspaceId === workspaceId(root) && normalized(value.root) === normalized(path.resolve(root)) ? value.processes : []; }
  catch (error) { if (error.code === 'ENOENT') return []; throw new Error('서버 실행 기록을 확인하지 못했습니다. .local/server-processes.json을 확인해 주세요.'); }
}
/** A PID alone is never ownership: command and creation timestamp must match. */
export function resetOwner(listener, records, root) {
  const base = normalized(path.resolve(root));
  const entries = ['/scripts/start-local.mjs', '/server/realtime.ts', '/node_modules/next/dist/bin/next'];
  const chain = []; let childCreatedAt = Infinity;
  for (const item of listener.chain) {
    const createdAt = Date.parse(item.createdAt);
    if (!Number.isFinite(createdAt) || createdAt > childCreatedAt) break;
    chain.push(item); childCreatedAt = createdAt;
  }
  return chain.reverse().find(item => item.pid !== process.pid && item.name?.toLowerCase() === 'node.exe' && (
    records.some(record => record.pid === item.pid && record.createdAt === item.createdAt && record.commandLine === item.commandLine) ||
    entries.some(entry => normalized(item.commandLine ?? '').includes(base + entry))
  ));
}
export async function recordServerProcess(root, pid, ports = []) {
  if (process.platform !== 'win32') return;
  const item = (await processSnapshot(root, [], [pid])).processes[0];
  if (!item) throw new Error('시작한 서버의 프로세스 정보를 확인하지 못했습니다.');
  const processes = [...(await registry(root)).filter(record => record.pid !== pid), { ...item, ports }].slice(-16);
  const file = registryPath(root); await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ workspaceId: workspaceId(root), root: path.resolve(root), processes }, null, 2)); await rename(temporary, file);
}
export async function portIsFree(port) {
  return new Promise(resolve => { const server = net.createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
}
export async function resetLocalServerPorts(root, ports, log = console.log) {
  if (process.platform !== 'win32') throw new Error('포트 초기화는 Windows 실행기를 사용해 주세요.');
  const records = await registry(root), snapshot = await processSnapshot(root, ports);
  const owners = new Map();
  for (const listener of snapshot.listeners) {
    const owner = resetOwner(listener, records, root);
    if (!owner) throw new Error(`${listener.port} 포트를 이 프로젝트로 확인되지 않은 프로그램이 사용 중입니다. 해당 프로그램을 종료한 뒤 다시 실행해 주세요.`);
    owners.set(owner.pid, owner);
  }
  // Some Windows environments cannot enumerate TCP owners. Explicit launch
  // records still permit stopping our own unchanged process, never a foreign PID.
  for (const port of ports) {
    if (snapshot.listeners.some(listener => listener.port === port) || await portIsFree(port)) continue;
    const candidates = records.filter(record => record.ports?.includes(port));
    let found = false;
    for (const record of candidates) {
      const item = (await processSnapshot(root, [], [record.pid])).processes[0];
      if (item && item.createdAt === record.createdAt && item.commandLine === record.commandLine && item.pid !== process.pid) { owners.set(item.pid, item); found = true; }
    }
    if (!found) throw new Error(`${port} 포트를 이 프로젝트로 확인되지 않은 프로그램이 사용 중입니다. 해당 프로그램을 종료한 뒤 다시 실행해 주세요.`);
  }
  for (const owner of owners.values()) {
    const current = (await processSnapshot(root, [], [owner.pid])).processes[0];
    if (!current) continue;
    if (current.createdAt !== owner.createdAt || current.commandLine !== owner.commandLine) throw new Error('서버 프로세스가 변경되어 포트 초기화를 중단했습니다.');
    await execute('taskkill.exe', ['/PID', String(owner.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
    log(`이 프로젝트의 기존 서버를 종료했습니다 (PID ${owner.pid}).`);
  }
  const until = Date.now() + 10000;
  while (Date.now() < until) { if ((await Promise.all(ports.map(portIsFree))).every(Boolean)) { log(`포트 초기화 완료: ${ports.join(', ')}`); return; } await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error(`${ports.join(', ')} 포트가 해제되지 않았습니다. 실행 중인 프로그램을 확인해 주세요.`);
}
