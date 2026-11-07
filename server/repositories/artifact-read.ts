import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BankScopeRegistryReader } from './review-ports';
import { emptyReadScope, type AnalysisReadOptions, type LocatedStoredFile as StoredFile, type LocatedStoredJson as StoredJson } from './analysis-read-ports';

/** Only this local fallback opens a filesystem path. A shadow composition must
 * supply its explicit artifact port; missing injection is a failure. */
export async function readDependency(root: string, reference: string, role: string, options: AnalysisReadOptions = {}, optional = false): Promise<StoredFile | null> {
  const repositories=options.repositories;
  if (repositories?.artifacts) {
    const result=await repositories.artifacts.read({ scope:{...emptyReadScope(repositories.ownerId),...options.scope},
      purpose:options.purpose ?? 'runtime-context',role,reference,optional });
    if (!result && !optional) throw Object.assign(new Error('DEPENDENCY_CONFIRMED_ABSENT'),{code:'ENOENT'});
    return result;
  }
  if (repositories?.kind === 'shadow') throw new Error('SHADOW_ARTIFACT_READER_REQUIRED');
  try {
    const bytes=await readFile(path.resolve(root,reference));
    return {path:reference,bytes,sha256:createHash('sha256').update(bytes).digest('hex')};
  } catch(error) { if(optional && (error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error; }
}
export async function readDependencyJson<T>(root: string, reference: string, role: string, options: AnalysisReadOptions = {}, optional = false): Promise<StoredJson<T> | null> {
  const stored=await readDependency(root,reference,role,options,optional);
  return stored ? {...stored,value:JSON.parse(stored.bytes.toString('utf8')) as T} : null;
}
export const isShadowRead = (options: AnalysisReadOptions) => options.repositories?.kind === 'shadow';
export const isConfirmedAbsence = (error: unknown) => !!error && typeof error==='object' && 'code' in error && error.code==='ENOENT';
/** Older local loaders intentionally collapse some domain failures into null.
 * A candidate must not collapse authorization/provider/SQL failures that way. */
export function throwIfShadowReadFailure(error: unknown, options: AnalysisReadOptions = {}): void {
  if (!isShadowRead(options) || !(error instanceof Error)) return;
  const code='code' in error ? String(error.code) : error.message;
  if (['RequestAccessError','DatabaseAuthorityError','PrivateObjectError','ObjectProviderError','ShadowReadError','AbortError'].includes(error.name) ||
    /^(?:SHADOW_|DB_|AUTH_|ACCESS_|STORAGE_|OBJECT_)/u.test(code)) throw error;
}
export function artifactBankScopeRegistryReader(root: string, options: AnalysisReadOptions): BankScopeRegistryReader {
  const text=async(reference:string,role:string)=>(await readDependency(root,reference,role,options))!.bytes.toString('utf8');
  return {
    readRegistryPointer:()=>text('data/prepared/evaluation-scope-registry/current.json','bank-scope-registry-pointer'),
    readRegistryRevision:digest=>{
      if(!/^[a-f0-9]{64}$/u.test(digest))throw new Error('REVIEW_REPOSITORY_REFERENCE_INVALID');
      return text(`data/prepared/evaluation-scope-registry/revisions/${digest}.json`,'bank-scope-registry-revision');
    },
  };
}
