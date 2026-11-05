import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildInterviewerQuality, isSyntheticInterviewSession } from '../server/interviewer-quality';

const validId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
async function safePath(root: string, relative: string, options: { createParents?: boolean; allowMissingFile?: boolean; directory?: boolean } = {}) {
  const absoluteRoot = path.resolve(root), file = path.resolve(absoluteRoot, relative), inside = path.relative(absoluteRoot, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('QUALITY_PATH_OUTSIDE_WORKSPACE');
  let current = absoluteRoot;
  const components = inside.split(path.sep);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || index < components.length - 1 && !info.isDirectory() || index === components.length - 1 && (options.directory ? !info.isDirectory() : !info.isFile())) throw new Error('QUALITY_LINK_OR_PATH_INVALID');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (index < components.length - 1 && options.createParents) await mkdir(current, { mode: 0o700 });
      else if (index < components.length - 1 || !options.allowMissingFile) throw error;
    }
  }
  return file;
}
async function latestSession(root: string, includeSynthetic: boolean) {
  const directory = await safePath(root, 'data/sessions', { directory: true });
  const files = await readdir(directory);
  const candidates = await Promise.all(files.filter(file => file.endsWith('.json') && validId(file.slice(0, -5))).map(async file => {
    const verified = await safePath(root, path.join('data/sessions', file));
    return { id: file.slice(0, -5), time: (await lstat(verified)).mtimeMs };
  }));
  for (const candidate of candidates.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id))) {
    if (includeSynthetic) return candidate.id;
    const session = JSON.parse(await readFile(await safePath(root, path.join('data/sessions', candidate.id + '.json')), 'utf8'));
    if (!isSyntheticInterviewSession(session)) return candidate.id;
  }
  return undefined;
}

export async function evaluateInterviewerQualityCli(args: string[], root = process.cwd()): Promise<string> {
  if (!args.length || args.includes('--help')) return '사용법: npx tsx scripts/evaluate-interviewer-quality.ts --latest [--include-synthetic] | --session UUID [--out artifacts/report.json]\n--latest는 합성 검증 회차를 기본 제외합니다. --include-synthetic은 --latest에서만 사용하며 --session은 지정한 합성 회차도 조회합니다. 로컬 저장 관찰만 집계하며 원문·추가 모델 호출·기존 로그 수정은 없습니다. --out은 프로젝트 내부의 새 JSON 파일만 생성합니다.';
  let latest = false, includeSynthetic = false, sessionId: string | undefined, output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--latest') latest = true;
    else if (arg === '--include-synthetic') includeSynthetic = true;
    else if (arg === '--session' || arg === '--out') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error('QUALITY_OPTION_VALUE_MISSING');
      if (arg === '--session') sessionId = value; else output = value;
    } else throw new Error('QUALITY_OPTION_UNKNOWN');
  }
  if (Number(latest) + Number(Boolean(sessionId)) !== 1) throw new Error('QUALITY_SESSION_SELECTION_INVALID');
  if (includeSynthetic && !latest) throw new Error('QUALITY_SYNTHETIC_OPTION_REQUIRES_LATEST');
  if (latest) sessionId = await latestSession(root, includeSynthetic);
  if (!sessionId || !validId(sessionId)) throw new Error('QUALITY_SESSION_ID_INVALID');
  const input = await safePath(root, path.join('data/sessions', sessionId + '.json'));
  const session = JSON.parse(await readFile(input, 'utf8'));
  if (session.id !== sessionId) throw new Error('QUALITY_SESSION_ID_MISMATCH');
  let log = '';
  try { log = await readFile(await safePath(root, path.join('data/conversation-logs', sessionId + '.jsonl')), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const events: unknown[] = []; let malformed = 0;
  for (const line of log.split('\n')) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.seq) || row.seq < 1) throw new Error('INVALID_ROW'); events.push(row); }
    catch { malformed++; }
  }
  const report = buildInterviewerQuality(session, events, { malformedLogLines: malformed });
  const serialized = JSON.stringify(report, null, 2);
  if (output) {
    const relative = path.relative(path.resolve(root), path.resolve(root, output));
    if (!output.endsWith('.json') || relative.toLowerCase().startsWith('data' + path.sep)) throw new Error('QUALITY_OUTPUT_PATH_INVALID');
    const destination = await safePath(root, output, { createParents: true, allowMissingFile: true });
    await writeFile(destination, serialized + '\n', { mode: 0o600, flag: 'wx' });
  }
  return serialized;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) evaluateInterviewerQualityCli(process.argv.slice(2)).then(output => process.stdout.write(output + '\n')).catch(() => { process.stderr.write('면접 품질 관찰 집계에 실패했습니다. UUID·옵션·로컬 파일 경로를 확인해 주세요.\n'); process.exitCode = 1; });
