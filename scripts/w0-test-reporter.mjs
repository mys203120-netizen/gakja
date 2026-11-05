import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const root = process.cwd();
const dependencyRoot = existsSync(path.join(root, 'node_modules')) ? realpathSync(path.join(root, 'node_modules')) : null;
const secrets = Object.entries(process.env)
  .filter(([key, value]) => /key|secret|token|password|credential|authorization/i.test(key) && value && value.length >= 8)
  .map(([, value]) => value)
  .sort((left, right) => right.length - left.length);

function replaceLiteral(text, target, replacement) {
  if (!target) return text;
  return text.split(target).join(replacement);
}

function replaceRoot(text, target, replacement) {
  if (!target) return text;
  for (const spelling of new Set([target, target.replaceAll('\\', '/'), target.replaceAll('/', '\\')])) {
    text = replaceLiteral(text, spelling, replacement);
  }
  return text;
}

function privatePdfPath(text) {
  // Only filenames of source PDFs are withheld. A stable basename digest keeps
  // distinct missing assets distinguishable without printing a student's name.
  return text.replace(/([^/\\'"\r\n]+)\.pdf\b/giu, (_match, name) => `<private-pdf-${digest(name).slice(0, 16)}>.pdf`);
}

export function normalizeText(value) {
  let text = String(value);
  for (const secret of secrets) text = replaceLiteral(text, secret, '<credential-redacted>');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer <credential-redacted>');
  text = replaceRoot(text, dependencyRoot, '<NODE_MODULES>');
  text = replaceRoot(text, root, '<ROOT>');
  text = replaceRoot(text, os.tmpdir(), '<TMP>');
  text = text.replace(/<(ROOT|NODE_MODULES|TMP)>[^'"\r\n]*/gu, (match) => match.replaceAll('\\', '/'));
  // fs.mkdtemp appends six random characters. Retain the named directory prefix
  // and everything beneath it; do not mask arbitrary numbers or error details.
  text = text.replace(/<TMP>\/([A-Za-z0-9_.-]*-)[A-Za-z0-9]{6}(?=\/|['"\s]|$)/gu, '<TMP>/$1<random>');
  return privatePdfPath(text);
}

export function normalizeFile(value) {
  if (!value) return null;
  let filename = String(value);
  if (filename.startsWith('file:')) {
    try { filename = fileURLToPath(filename); } catch { /* preserve an invalid location for the report */ }
  }
  const relative = path.relative(root, filename);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return normalizeText(relative.replaceAll('\\', '/'));
  return normalizeText(filename);
}

function stableValue(value, seen = new WeakSet()) {
  if (typeof value === 'string') return normalizeText(value);
  if (value === undefined) return { type: 'undefined' };
  if (typeof value === 'bigint') return { type: 'bigint', value: String(value) };
  if (typeof value === 'number' && !Number.isFinite(value)) return { type: 'number', value: String(value) };
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return { type: 'circular' };
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key], seen)]));
}

function describeValue(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return { type: typeof value, value };
  const normalized = JSON.stringify(stableValue(value));
  return {
    type: Array.isArray(value) ? 'array' : typeof value,
    ...(typeof value === 'string' || Array.isArray(value) ? { length: value.length } : {}),
    sha256: digest(normalized),
  };
}

function isAssertion(error) {
  return error && typeof error === 'object' && (error.code === 'ERR_ASSERTION' || /AssertionError/u.test(error.name ?? '') || isAssertion(error.cause));
}

export function describeError(error, depth = 0) {
  if (depth > 8) return { type: 'cause-depth-limit' };
  if (!error || typeof error !== 'object') return describeValue(error);
  const normalizedMessage = normalizeText(error.message ?? '');
  const assertion = isAssertion(error);
  const result = {
    name: error.name ?? 'Error',
    // Assertion diffs can contain private source text. The heading and exact
    // normalized-value fingerprints retain comparison semantics without text.
    message: assertion ? normalizedMessage.split(/\r?\n/u)[0] : normalizedMessage.slice(0, 4096),
    messageSha256: digest(normalizedMessage),
  };
  for (const key of ['code', 'failureType', 'syscall', 'operator']) {
    if (error[key] !== undefined) result[key] = normalizeText(error[key]);
  }
  for (const key of ['path', 'dest']) {
    if (error[key] !== undefined) result[key] = normalizeText(error[key]);
  }
  if (error.code === 'ENOENT' && typeof error.path === 'string') {
    result.assetExistsAtFailure = existsSync(error.path);
    result.assetKind = path.extname(error.path).toLowerCase() === '.pdf' ? 'private-pdf' : 'baseline-file';
  }
  for (const key of ['actual', 'expected']) {
    if (key in error) result[key] = describeValue(error[key]);
  }
  if (error.cause !== undefined) result.cause = describeError(error.cause, depth + 1);
  if (Array.isArray(error.errors)) result.errors = error.errors.map((item) => describeError(item, depth + 1));
  if (error.stack) {
    result.frames = String(error.stack).split(/\r?\n/u).filter((line) => /^\s+at /u.test(line)).slice(0, 16).map(normalizeText);
  }
  return result;
}

const locatedEvents = new Set(['test:enqueue', 'test:dequeue', 'test:start', 'test:complete', 'test:pass', 'test:fail']);

export default async function* w0TestReporter(source) {
  yield `${JSON.stringify({ type: 'w0:reporter', schemaVersion: 1, node: process.version, root: '<ROOT>' })}\n`;
  for await (const event of source) {
    const data = event.data ?? {};
    if (locatedEvents.has(event.type)) {
      const record = {
        type: event.type,
        name: normalizeText(data.name ?? ''),
        file: normalizeFile(data.file),
        entryFile: normalizeFile(data.entryFile),
        line: data.line ?? null,
        column: data.column ?? null,
        nesting: data.nesting ?? 0,
        testId: data.testId ?? null,
        parentId: data.parentId ?? null,
        testNumber: data.testNumber ?? null,
        testType: data.details?.type ?? data.type ?? 'test',
      };
      if (data.skip) record.skip = typeof data.skip === 'string' ? normalizeText(data.skip) : true;
      if (data.todo) record.todo = typeof data.todo === 'string' ? normalizeText(data.todo) : true;
      if (data.details?.duration_ms !== undefined) record.duration_ms = data.details.duration_ms;
      if (event.type === 'test:complete') record.passed = data.details?.passed;
      if (data.details?.error !== undefined) record.error = describeError(data.details.error);
      yield `${JSON.stringify(record)}\n`;
    } else if (event.type === 'test:summary') {
      yield `${JSON.stringify({ type: event.type, file: normalizeFile(data.file), counts: data.counts, success: data.success, duration_ms: data.duration_ms })}\n`;
    } else if (event.type === 'test:diagnostic') {
      const message = String(data.message ?? '');
      if (/^(?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) [\d.]+$/u.test(message)) {
        yield `${JSON.stringify({ type: event.type, file: normalizeFile(data.file), nesting: data.nesting ?? 0, message })}\n`;
      }
    } else if (event.type === 'test:stdout' || event.type === 'test:stderr') {
      // Test stdout may contain actual replay material. Preserve only a digest
      // and size, never its body, in the machine-comparable shared log.
      const text = normalizeText(data.message ?? '');
      yield `${JSON.stringify({ type: event.type, file: normalizeFile(data.file), bytes: Buffer.byteLength(text), sha256: digest(text) })}\n`;
    }
  }
}
