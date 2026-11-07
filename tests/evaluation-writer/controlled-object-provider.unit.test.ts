import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createControlledObjectProvider } from './controlled-object-provider';

test('controlled storage reads exported field-order variants as the same object and preserves exact bytes across copy/removal', async () => {
  const provider = createControlledObjectProvider(), bytes = Buffer.from('Exact public source\r\n😀', 'utf8');
  const admitted = { key: 'owned/final/source', bucket: 'owned-bucket' }, exported = { bucket: 'owned-bucket', key: 'owned/final/source' };
  const options = { maxBytes: bytes.length };
  await provider.upload(admitted, bytes, { contentType: 'text/plain' });
  const read = await provider.read(exported, options); assert.deepEqual(read, bytes);
  assert.equal(createHash('sha256').update(read).digest('hex'), createHash('sha256').update(bytes).digest('hex'));
  const copy = { bucket: 'owned-bucket', key: 'owned/final/copy' };
  await provider.copy(exported, copy); await provider.remove({ bucket: admitted.bucket, key: admitted.key });
  await assert.rejects(provider.read(admitted, options), /PR07F_CONTROLLED_BODY_MISSING/u);
  assert.deepEqual(await provider.read({ key: copy.key, bucket: copy.bucket }, options), bytes);
  await assert.rejects(provider.read({ ...copy, bucket: 'different-bucket' }, options), /PR07F_CONTROLLED_BODY_MISSING/u);
});
