import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { RequestContext } from '../auth/request-identity';
import { validatePdfStructure, PdfStructureError } from './pdf-structure';
import { inspectAudioFormat, inspectImageFormat } from './media-format';
import {
  privateObjectKinds, type ObjectAdmission, type ObjectRegistration, type ObjectStorageProvider,
  type PrivateObjectKind, type PrivateObjectRepository, type PrivateObjectScope, type PrivateObjectSelector,
  type StorageObjectRef, type VerifiedPrivateObject,
} from './private-object-ports';

export class PrivateObjectError extends Error {
  constructor(readonly code: 'OBJECT_NOT_FOUND' | 'OBJECT_INPUT_INVALID' | 'OBJECT_INTEGRITY_FAILED' | 'OBJECT_STATE_CONFLICT' |
    'OBJECT_EXPIRED' | 'OBJECT_BUSY' | 'OBJECT_PROVIDER_UNAVAILABLE' | 'OBJECT_RANGE_UNSUPPORTED' | 'OBJECT_INTERNAL_AUTHORITY_REQUIRED') {
    super(code); this.name = 'PrivateObjectError';
  }
}
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim();
const hash = /^[a-f0-9]{64}$/u;
const terminal = (value: ObjectRegistration) => ['cancelled', 'rejected', 'expired'].includes(value.state);
const sameOptional = (left: object, right: object, key: 'sourceRevision' | 'domainSha256' | 'mediaType') =>
  Object.hasOwn(left, key) === Object.hasOwn(right, key) && Reflect.get(left, key) === Reflect.get(right, key);
function sameScope(left: PrivateObjectScope, right: PrivateObjectScope) {
  return left.kind === right.kind && left.ownerId === right.ownerId && left.studentId === right.studentId &&
    (left.kind === 'common' || right.kind === 'target' && left.applicationTargetId === right.applicationTargetId && left.supportTargetId === right.supportTargetId);
}
const sameRef = (left: StorageObjectRef, right: StorageObjectRef) => left.bucket === right.bucket && left.key === right.key;
function sameVerified(left: VerifiedPrivateObject, right: VerifiedPrivateObject) {
  return left.receiptId === right.receiptId && left.objectId === right.objectId && sameScope(left.scope, right.scope) &&
    left.kind === right.kind && left.revision === right.revision && sameRef(left.ref, right.ref) &&
    left.sizeBytes === right.sizeBytes && left.contentSha256 === right.contentSha256 &&
    sameOptional(left, right, 'sourceRevision') && sameOptional(left, right, 'domainSha256') && sameOptional(left,right,'mediaType');
}
function sameRegistration(left: ObjectRegistration, right: ObjectRegistration) {
  return left.receiptId === right.receiptId && left.objectId === right.objectId && sameScope(left.scope, right.scope) &&
    left.kind === right.kind && left.revision === right.revision && left.state === right.state && left.expiresAt === right.expiresAt &&
    left.expectedSize === right.expectedSize && left.expectedSha256 === right.expectedSha256 && sameRef(left.stagingRef, right.stagingRef) &&
    sameRef(left.finalRef, right.finalRef) && sameOptional(left, right, 'sourceRevision') && sameOptional(left, right, 'domainSha256') && sameOptional(left,right,'mediaType');
}

/** Finite server-issued object authority. This is not an Auth role or an
 * evaluation approval. Trusted composition must connect checkCurrent to its
 * actual job/capability binding; nothing derives it from an HTTP input DTO. */
export interface InternalObjectCapability { readonly kind: 'internal-object-capability-v1' }
interface InternalAuthority {
  scope: PrivateObjectScope;
  sourceRevision?: string | null;
  kinds: readonly PrivateObjectKind[];
  idempotencyKeys: readonly string[];
  objectIds: readonly string[];
  expiresAt: number;
  checkCurrent(): Promise<boolean>;
}
const internalAuthorities = new WeakMap<InternalObjectCapability, Readonly<InternalAuthority>>();
export function createInternalObjectCapability(authority: InternalAuthority): InternalObjectCapability {
  if (!nonempty(authority.scope.ownerId) || !nonempty(authority.scope.studentId) ||
    authority.scope.kind === 'target' && (!nonempty(authority.scope.applicationTargetId) || !nonempty(authority.scope.supportTargetId)) ||
    !authority.kinds.length || authority.kinds.some(kind => !privateObjectKinds.includes(kind)) ||
    !Array.isArray(authority.idempotencyKeys) || authority.idempotencyKeys.some(key => !nonempty(key)) ||
    !Array.isArray(authority.objectIds) || authority.objectIds.some(id => !nonempty(id)) ||
    authority.idempotencyKeys.length + authority.objectIds.length === 0 || !Number.isFinite(authority.expiresAt) ||
    typeof authority.checkCurrent !== 'function' || Object.hasOwn(authority, 'sourceRevision') && authority.sourceRevision !== null && !nonempty(authority.sourceRevision)) {
    throw new PrivateObjectError('OBJECT_INTERNAL_AUTHORITY_REQUIRED');
  }
  const capability = Object.freeze({ kind: 'internal-object-capability-v1' as const });
  internalAuthorities.set(capability, Object.freeze({ ...authority, scope: Object.freeze({ ...authority.scope }),
    kinds: Object.freeze([...new Set(authority.kinds)]), idempotencyKeys: Object.freeze([...new Set(authority.idempotencyKeys)]),
    objectIds: Object.freeze([...new Set(authority.objectIds)]), checkCurrent: authority.checkCurrent.bind(authority) }));
  return capability;
}

const mime: Record<PrivateObjectKind, string> = {
  'source-pdf': 'application/pdf', 'source-markdown': 'text/markdown; charset=utf-8', 'source-json': 'application/json',
  'analysis-json': 'application/json', audio: 'audio/wav', 'review-bundle': 'application/json', 'source-image':'image/png', 'review-journal':'application/x-ndjson',
};
/** Container checks only. Content/source QA, analysis codecs and signed review
 * authority remain in their existing layers; bytes are never normalized. */
async function validateFormat(kind: PrivateObjectKind, bytes: Buffer, mediaType?: ObjectAdmission['mediaType']) {
  try {
    if (kind === 'source-pdf') {
      await validatePdfStructure(bytes);
    } else if (kind === 'audio') {
      if (inspectAudioFormat(bytes).mediaType !== (mediaType ?? 'audio/wav')) throw new Error();
    } else if (kind === 'source-image') {
      if (!mediaType || inspectImageFormat(bytes).mediaType !== mediaType) throw new Error();
    } else {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!text.length) throw new Error();
      if(kind==='review-journal') {
        const rows=text.split(/\r?\n/u).filter(row=>row.trim().length>0);
        if(!rows.length)throw new Error();for(const row of rows)JSON.parse(row);
      } else if(kind!=='source-markdown'&&JSON.parse(text)===undefined)throw new Error();
    }
  } catch (error) {
    if (error instanceof PdfStructureError && error.code === 'PDF_VALIDATION_BUSY') throw new PrivateObjectError('OBJECT_BUSY');
    throw new PrivateObjectError('OBJECT_INPUT_INVALID');
  }
}

export interface PrivateObjectServiceOptions {
  repository: PrivateObjectRepository;
  provider: ObjectStorageProvider;
  now?: () => number;
  maxBytes?: number;
  maxConcurrentTransfers?: number;
  timeoutMs?: number;
}
export function createPrivateObjectService(options: PrivateObjectServiceOptions) {
  const { repository, provider } = options, now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024, concurrency = options.maxConcurrentTransfers ?? 4, timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16 ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new PrivateObjectError('OBJECT_INPUT_INVALID');
  let active = 0;
  async function transfer<T>(operation: (signal: AbortSignal) => Promise<T>, supplied?: AbortSignal) {
    if (active >= concurrency) throw new PrivateObjectError('OBJECT_BUSY');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (supplied?.aborted) throw new PrivateObjectError('OBJECT_PROVIDER_UNAVAILABLE');
    supplied?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs); active++;
    try {
      const value = await operation(controller.signal);
      if (controller.signal.aborted) throw new PrivateObjectError('OBJECT_PROVIDER_UNAVAILABLE');
      return value;
    } catch (error) {
      if (error instanceof PrivateObjectError) throw error;
      throw new PrivateObjectError('OBJECT_PROVIDER_UNAVAILABLE');
    } finally { clearTimeout(timer); supplied?.removeEventListener('abort', abort); active--; }
  }
  function issuedInternal(capability: InternalObjectCapability | undefined, value: { scope: PrivateObjectScope; kind: PrivateObjectKind; sourceRevision?: string | null }, selection: { objectId?: string; idempotencyKey?: string }) {
    const authority = capability && internalAuthorities.get(capability);
    if (!authority || now() >= authority.expiresAt || !sameScope(authority.scope, value.scope) || !sameOptional(authority, value, 'sourceRevision') ||
      !authority.kinds.includes(value.kind) || selection.objectId !== undefined && !authority.objectIds.includes(selection.objectId) ||
      selection.idempotencyKey !== undefined && !authority.idempotencyKeys.includes(selection.idempotencyKey)) throw new PrivateObjectError('OBJECT_INTERNAL_AUTHORITY_REQUIRED');
    return authority;
  }
  async function internal(capability: InternalObjectCapability | undefined, value: { scope: PrivateObjectScope; kind: PrivateObjectKind; sourceRevision?: string | null }, selection: { objectId?: string; idempotencyKey?: string }) {
    const authority = issuedInternal(capability, value, selection);
    let allowed = false; try { allowed = await authority.checkCurrent(); } catch { /* fail closed */ }
    if (!allowed || now() >= authority.expiresAt) throw new PrivateObjectError('OBJECT_INTERNAL_AUTHORITY_REQUIRED');
  }
  async function mutationAuthority(receipt: ObjectRegistration, capability?: InternalObjectCapability) {
    if (receipt.kind !== 'source-pdf') await internal(capability, receipt, { objectId: receipt.objectId });
  }
  function validateAdmission(input: ObjectAdmission) {
    const allowed = ['kind', 'scope', 'studentId', 'sourceRevision', 'expectedSize', 'expectedSha256', 'domainSha256', 'idempotencyKey', 'mediaType'];
    if (!input || Object.keys(input).some(key => !allowed.includes(key)) || !privateObjectKinds.includes(input.kind) || !['common', 'target'].includes(input.scope) || !nonempty(input.studentId) ||
      !nonempty(input.idempotencyKey) || input.idempotencyKey.length > 128 || !Number.isSafeInteger(input.expectedSize) || input.expectedSize < 1 || input.expectedSize > maxBytes ||
      !hash.test(input.expectedSha256) || Object.hasOwn(input, 'sourceRevision') && input.sourceRevision !== null && !nonempty(input.sourceRevision) ||
      Object.hasOwn(input, 'domainSha256') && input.domainSha256 !== null && !hash.test(input.domainSha256 ?? '')) throw new PrivateObjectError('OBJECT_INPUT_INVALID');
    if (Object.hasOwn(input,'mediaType') &&
      !(input.kind==='audio'?['audio/wav','audio/mpeg']:input.kind==='source-image'?['image/png','image/jpeg']:[]).includes(input.mediaType ?? '')) {
      throw new PrivateObjectError('OBJECT_INPUT_INVALID');
    }
    if (input.kind==='source-image'&&!input.mediaType) throw new PrivateObjectError('OBJECT_INPUT_INVALID');
  }
  async function receipt(context: RequestContext, id: string) {
    if (!nonempty(id)) throw new PrivateObjectError('OBJECT_NOT_FOUND');
    const value = await repository.getReceipt(context, id);
    if (!value) throw new PrivateObjectError('OBJECT_NOT_FOUND');
    return structuredClone(value);
  }
  async function live(context: RequestContext, value: ObjectRegistration) {
    if (terminal(value)) throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
    if (value.state !== 'verified' && now() >= value.expiresAt) {
      await repository.expire(context, value.receiptId); throw new PrivateObjectError('OBJECT_EXPIRED');
    }
  }
  async function checkBytes(value: { expectedSize: number; expectedSha256: string; kind: PrivateObjectKind; mediaType?:ObjectAdmission['mediaType'] }, bytes: Buffer) {
    if (!Buffer.isBuffer(bytes) || bytes.length !== value.expectedSize || bytes.length > maxBytes || sha(bytes) !== value.expectedSha256) throw new PrivateObjectError('OBJECT_INTEGRITY_FAILED');
    await validateFormat(value.kind, bytes, value.mediaType);
  }
  async function checkedRead(ref: StorageObjectRef, expected: { expectedSize: number; expectedSha256: string; kind: PrivateObjectKind; mediaType?:ObjectAdmission['mediaType'] }, signal?: AbortSignal) {
    if (expected.expectedSize > maxBytes) throw new PrivateObjectError('OBJECT_INPUT_INVALID');
    const bytes = await transfer(abortSignal => provider.read(ref, { maxBytes, timeoutMs, signal: abortSignal }), signal);
    await checkBytes(expected, bytes); return bytes;
  }
  async function unchanged(context: RequestContext, original: ObjectRegistration) {
    const current = await receipt(context, original.receiptId);
    if (!sameRegistration(original, current)) throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
    await live(context, current); return current;
  }
  async function read(context: RequestContext, selector: PrivateObjectSelector, request: { range?: string; signal?: AbortSignal } = {}, capability?: InternalObjectCapability) {
    if (request.range !== undefined) throw new PrivateObjectError('OBJECT_RANGE_UNSUPPORTED');
    const value = await repository.getVerified(context, selector);
    if (!value) throw new PrivateObjectError('OBJECT_NOT_FOUND');
    const binding = structuredClone(value);
    if (capability) await internal(capability, binding, { objectId: binding.objectId });
    const bytes = await checkedRead(binding.ref, { kind: binding.kind, expectedSize: binding.sizeBytes, expectedSha256: binding.contentSha256, mediaType:binding.mediaType }, request.signal);
    const current = await repository.getVerified(context, selector);
    if (!current || !sameVerified(binding, current)) throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
    if (capability) await internal(capability, current, { objectId: current.objectId });
    if (capability) {
      const final = await repository.getVerified(context, selector);
      if (!final || !sameVerified(binding, final)) throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
      issuedInternal(capability, final, { objectId: final.objectId });
    }
    return bytes;
  }
  async function audioMetadata(context: RequestContext, id: string) {
    const selected = await repository.audioObject(context,id);
    if (!selected) return null;
    const binding = await repository.getVerified(context,selected);
    if (!binding||binding.kind!=='audio') return null;
    const contentType=binding.mediaType??'audio/wav';
    if(contentType!=='audio/wav'&&contentType!=='audio/mpeg') throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
    return {contentType,objectIdentity:sha(Buffer.from(JSON.stringify([binding.receiptId,binding.objectId,binding.scope,
      Object.hasOwn(binding,'sourceRevision'),binding.sourceRevision??null,Object.hasOwn(binding,'domainSha256'),binding.domainSha256??null,
      Object.hasOwn(binding,'mediaType'),binding.mediaType??null,binding.revision,binding.ref,binding.sizeBytes,binding.contentSha256])))};
  }
  return Object.freeze({
    limits: Object.freeze({ maxBytes, maxConcurrentTransfers: concurrency, timeoutMs, cache: false, range: false, temporaryFiles: false }),
    /** Browser-facing student submission is PDF only. */
    async admitStudent(context: RequestContext, input: ObjectAdmission) {
      validateAdmission(input); if (input.kind !== 'source-pdf') throw new PrivateObjectError('OBJECT_INTERNAL_AUTHORITY_REQUIRED');
      return repository.admit(context, input);
    },
    async admitGenerated(context: RequestContext, input: ObjectAdmission, capability: InternalObjectCapability) {
      validateAdmission(input);
      if (context.mode !== 'authenticated' || !context.scope) throw new PrivateObjectError('OBJECT_INTERNAL_AUTHORITY_REQUIRED');
      const scope: PrivateObjectScope = input.scope === 'common' ? { kind: 'common', ownerId: context.account.ownerId, studentId: input.studentId } :
        { kind: 'target', ownerId: context.account.ownerId, studentId: input.studentId, applicationTargetId: context.scope.applicationTargetId, supportTargetId: context.scope.supportTargetId };
      const selected = { scope, kind: input.kind, ...(Object.hasOwn(input, 'sourceRevision') ? { sourceRevision: input.sourceRevision } : {}) };
      await internal(capability, selected, { idempotencyKey: input.idempotencyKey });
      const value = await repository.admit(context, input);
      await internal(capability, value, { idempotencyKey: input.idempotencyKey });
      const final = await receipt(context, value.receiptId);
      if (!sameRegistration(value, final)) throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
      issuedInternal(capability, final, { idempotencyKey: input.idempotencyKey }); return final;
    },
    async upload(context: RequestContext, id: string, bytes: Buffer, capability?: InternalObjectCapability) {
      const existing = await receipt(context, id); await mutationAuthority(existing, capability); await live(context, existing); await checkBytes(existing, bytes);
      if (existing.state === 'verified') return existing;
      if (existing.state === 'verifying') throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
      const pending = await repository.beginUpload(context, id, existing.revision);
      if (!pending) throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
      try { await transfer(signal => provider.upload(pending.stagingRef, bytes, { contentType: pending.mediaType ?? mime[pending.kind], signal })); }
      catch (error) {
        // An upload response can be lost, or a no-upsert retry can conflict.
        // Existing bytes must independently match the exact receipt to recover.
        try { await checkedRead(pending.stagingRef, pending); } catch { throw error; }
      }
      await mutationAuthority(pending, capability);
      const final = await unchanged(context, pending);
      if (capability) issuedInternal(capability, final, { objectId: final.objectId }); return final;
    },
    async complete(context: RequestContext, id: string, capability?: InternalObjectCapability) {
      const existing = await receipt(context, id); await mutationAuthority(existing, capability); await live(context, existing);
      if (existing.state === 'verified') return existing;
      const claim = await repository.beginVerification(context, id, existing.revision);
      if (!claim) throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
      try {
        await checkedRead(claim.stagingRef, claim);
        await mutationAuthority(claim, capability); await unchanged(context, claim);
        try { await transfer(signal => provider.copy(claim.stagingRef, claim.finalRef, { signal })); }
        catch {
          // Copy may have succeeded before a response/DB failure. Only a full
          // read of the same immutable destination can establish recovery.
          await checkedRead(claim.finalRef, claim);
        }
        await checkedRead(claim.finalRef, claim);
        await mutationAuthority(claim, capability); await unchanged(context, claim);
        const committed = await repository.finishVerification(context, id, claim.revision, { sizeBytes: claim.expectedSize, contentSha256: claim.expectedSha256 });
        if (!committed) {
          const concurrent = await receipt(context, id);
          if (concurrent.state === 'verified' && concurrent.objectId === claim.objectId && sameRef(concurrent.finalRef, claim.finalRef) && concurrent.actualSize === claim.expectedSize && concurrent.actualSha256 === claim.expectedSha256) return concurrent;
          throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
        }
        await mutationAuthority(committed, capability);
        const final = await receipt(context, committed.receiptId);
        if (!sameRegistration(committed, final)) throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
        if (capability) issuedInternal(capability, final, { objectId: final.objectId }); return final;
      } catch (error) {
        if (error instanceof PrivateObjectError && ['OBJECT_INTEGRITY_FAILED', 'OBJECT_INPUT_INVALID'].includes(error.code)) {
          await repository.reject(context, id, claim.revision).catch(() => null);
        }
        // Other failures intentionally retain verifying + immutable refs. A
        // retry rechecks bytes; no unknown provider/DB success is invented.
        throw error;
      }
    },
    async cancel(context: RequestContext, id: string, capability?: InternalObjectCapability) {
      const existing = await receipt(context, id); await mutationAuthority(existing, capability);
      const cancelled = await repository.cancel(context, id); if (!cancelled) throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
      if (capability) issuedInternal(capability, cancelled, { objectId: cancelled.objectId }); return cancelled;
    },
    async cleanup(context: RequestContext, id: string, capability?: InternalObjectCapability) {
      let existing = await receipt(context, id); await mutationAuthority(existing, capability);
      if (!terminal(existing) && existing.state !== 'verified' && now() >= existing.expiresAt) existing = await repository.expire(context, id) ?? existing;
      if (!terminal(existing) && existing.state !== 'verified') throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
      // Repeating even a previously clean receipt removes late staging uploads.
      // Verified objects keep their final reference; tombstones remove both.
      let cleaned = true;
      for (const ref of existing.state === 'verified' ? [existing.stagingRef] : [existing.stagingRef, existing.finalRef]) {
        await mutationAuthority(existing, capability);
        const current = await receipt(context, id);
        if (!sameRegistration(existing, current)) throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
        try { await transfer(signal => provider.remove(ref, { signal })); } catch { cleaned = false; }
      }
      await mutationAuthority(existing, capability);
      const result = await repository.markCleanup(context, id, existing.revision, cleaned ? 'clean' : 'failed');
      if (!result) throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
      if (capability) issuedInternal(capability, result, { objectId: result.objectId }); return result;
    },
    read,
    async readForInternal(context: RequestContext, selector: PrivateObjectSelector, capability: InternalObjectCapability, request: { range?: string; signal?: AbortSignal } = {}) {
      if (!capability || !internalAuthorities.has(capability)) throw new PrivateObjectError('OBJECT_INTERNAL_AUTHORITY_REQUIRED');
      return read(context, selector, request, capability);
    },
    audioMetadata,
    async audioIdentity(context: RequestContext, id: string) {return (await audioMetadata(context,id))?.objectIdentity??null;},
    async readAudio(context: RequestContext, id: string) {
      const selected = await repository.audioObject(context, id);
      if (!selected) return null;
      const bytes = await read(context, selected);
      const latest = await repository.audioObject(context, id);
      if (!latest || selected.objectId !== latest.objectId || selected.scope !== latest.scope) throw new PrivateObjectError('OBJECT_STATE_CONFLICT');
      return bytes;
    },
  });
}
export type PrivateObjectService = ReturnType<typeof createPrivateObjectService>;
