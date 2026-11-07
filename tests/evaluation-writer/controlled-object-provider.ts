import type { ObjectStorageProvider, StorageObjectRef } from '../../server/storage/private-object-ports';

/** Diagnostic storage identity is the bucket/key tuple. JSON object property
 * order is transport detail, and never part of a stored object's content hash. */
export function createControlledObjectProvider(): ObjectStorageProvider {
  const bodies = new Map<string, Buffer>();
  const key = (ref: StorageObjectRef) => JSON.stringify([ref.bucket, ref.key]);
  return {
    async read(ref) { const bytes = bodies.get(key(ref)); if (!bytes) throw new Error('PR07F_CONTROLLED_BODY_MISSING'); return Buffer.from(bytes); },
    async upload(ref, bytes) { if (bodies.has(key(ref))) throw new Error('PR07F_CONTROLLED_BODY_EXISTS'); bodies.set(key(ref), Buffer.from(bytes)); },
    async copy(from, to) { const bytes = bodies.get(key(from)); if (!bytes) throw new Error('PR07F_CONTROLLED_BODY_MISSING'); bodies.set(key(to), Buffer.from(bytes)); },
    async remove(ref) { bodies.delete(key(ref)); },
  };
}
