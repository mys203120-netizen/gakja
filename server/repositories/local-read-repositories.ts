import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { interviewConfig } from '../../interview.config';
import { localDevelopmentOwner } from '../session-runtime';
import type { FullRecordSource, AnalysisQAManifest } from '../data/full-student-analysis';
import { assertReadOwner, type ReadRepositories, type ScopedRead, type StoredFile, type StoredJson,
  type AnalysisPointer, type FullRecordPointer, type AnalysisPayload, type ConfiguredSourceRead } from './analysis-read-ports';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Composition boundary for the existing single-owner local mode. A fresh
 * instance pins reads for one operation; it is not a process-global cache. */
export function createLocalReadRepositories(root: string): ReadRepositories {
  const ownerId = localDevelopmentOwner().id;
  const base = path.resolve(root);
  const scope = (request: ScopedRead) => assertReadOwner(repositories, request.scope);
  const bounded = (reference: string, directory: string, error: string, filename?: string, nonempty = false) => {
    const file = path.resolve(base, reference), relative = path.relative(path.resolve(base, directory), file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || nonempty && !relative || filename && path.basename(file) !== filename) throw new Error(error);
    return file;
  };
  const fileCache = new Map<string, Promise<Buffer>>();
  const raw = (absolute: string) => {
    let pending = fileCache.get(absolute);
    if (!pending) { pending = readFile(absolute); fileCache.set(absolute, pending); }
    return pending;
  };
  const stored = async (absolute: string, storedPath: string): Promise<StoredFile> => {
    const bytes = Buffer.from(await raw(absolute)); return { path: storedPath, bytes, sha256: sha(bytes) };
  };
  const json = async <T>(absolute: string, storedPath: string): Promise<StoredJson<T>> => {
    const result = await stored(absolute, storedPath); return { ...result, value: JSON.parse(result.bytes.toString('utf8')) as T };
  };
  const optionalJson = async <T>(relative: string): Promise<StoredJson<T> | null> => {
    try { return await json<T>(path.resolve(base, relative), relative); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const analysisFile = (reference: string, selection: 'current' | 'staged' | 'revision' | 'review-parent') =>
    bounded(reference, 'data/prepared/student-analysis-revisions', 'ANALYSIS_PATH_INVALID', selection === 'current' ? undefined : 'analysis.json', selection !== 'current');
  let configured: Promise<ConfiguredSourceRead> | undefined;
  const repositories: ReadRepositories = { ownerId,
    source: {
      async readConfiguredInputs(request) {
        scope(request);
        configured ??= (async () => {
          const missing: ConfiguredSourceRead['missing'] = [];
          const inputs = await Promise.all(Object.entries(interviewConfig.files).filter(([role]) => role !== 'sourceManifest').map(async ([role, reference]) => {
            try { const file = await stored(path.resolve(base, reference), reference); return { role, path: reference, bytes: file.bytes, sha256: file.sha256 }; }
            catch (readError) { missing.push({ role, path: reference }); return { role, path: reference, bytes: null, sha256: null, readError }; }
          }));
          return { inputs, missing };
        })();
        const result = await configured;
        return { inputs: result.inputs.map(row => ({ ...row, bytes: row.bytes === null ? null : Buffer.from(row.bytes) })), missing: result.missing.map(row => ({ ...row })) };
      },
      async readPinnedInput(request) {
        scope(request);
        const configuredPath = interviewConfig.files[request.pin.role as keyof typeof interviewConfig.files];
        if (!configuredPath || request.pin.role === 'sourceManifest' || path.resolve(base, request.pin.path) !== path.resolve(base, configuredPath)) throw new Error('STAGED_CONTEXT_SOURCE_CHANGED');
        return stored(path.resolve(base, request.pin.path), request.pin.path);
      },
      async readCurrentRecord(request) {
        scope(request);
        const pointer = await optionalJson<FullRecordPointer>('data/prepared/full-record-current.json');
        if (!pointer) return null;
        const file = bounded(pointer.value.path, 'data/prepared/record-revisions', 'FULL_RECORD_PATH_INVALID');
        const document = await json<FullRecordSource>(file, pointer.value.path);
        return { pointer, document };
      },
    },
    analysis: {
      async readCurrentPointer(request) { scope(request); return optionalJson<AnalysisPointer>('data/prepared/student-analysis-current.json'); },
      async readAnalysis(request) {
        scope(request); const file = analysisFile(request.reference, request.selection);
        return json<AnalysisPayload>(file, request.selection === 'current' ? request.reference : path.relative(base, file));
      },
      async readQaManifest(request) {
        scope(request); const file = path.join(path.dirname(analysisFile(request.analysisReference, 'staged')), 'analysis-qa.json');
        return json<AnalysisQAManifest>(file, path.relative(base, file));
      },
      async readReviewFile(request) {
        scope(request);
        const error = request.kind === 'objective-source-review' ? 'OBJECTIVE_SOURCE_REVIEW_ARTIFACT_INVALID' : 'ANALYSIS_SOURCE_REVIEW_ARTIFACT_INVALID';
        const directory = request.kind === 'parent-proposal' ? 'data/prepared/student-analysis-proposals' : 'artifacts';
        return stored(bounded(request.reference, directory, error, undefined, true), request.reference);
      },
      async currentPointerUnchanged(request) {
        scope(request);
        // This is a consistency comparison, not a second pointer selection.
        const bytes = await readFile(path.resolve(base, 'data/prepared/student-analysis-current.json'));
        return bytes.equals(request.captured.bytes);
      },
      async analysisDocumentUnchanged(request) {
        scope(request);
        return (await readFile(analysisFile(request.captured.path, 'current'))).equals(request.captured.bytes);
      },
    },
  };
  return repositories;
}
