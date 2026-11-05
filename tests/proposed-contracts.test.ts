import test from 'node:test';
import assert from 'node:assert/strict';
import { draft7ReferenceProjection, loadProposedContractReference, referenceDateTime } from '../scripts/proposed-contract-reference.mjs';

const reference = await loadProposedContractReference();
test('received proposed-v2 artifact hashes and original manifest stay unchanged', () => {
  assert.equal(reference.schemaCount, 5);
  assert.equal(reference.shapes.length, 52); assert.equal(reference.sources.length, 4);
  assert.equal(reference.metadata.runtime_integrated, false);
});
for (const outcome of [...reference.shapes, ...reference.sources, ...reference.additional]) {
  test(`proposed contract reference: ${outcome.name}`, () => assert.equal(outcome.actual_valid, outcome.expected_valid));
}
test('the draft-7 compatibility adapter fails closed on 2020-12-only schema features', () => {
  assert.throws(() => draft7ReferenceProjection({ type: 'object', unevaluatedProperties: false }), /Unsupported/);
  assert.throws(() => draft7ReferenceProjection({ type: 'array', items: { type: 'object', dependentRequired: {} } }), /Unsupported/);
  assert.equal(referenceDateTime('2026-02-30T10:00:00+09:00'), false);
  assert.equal(referenceDateTime('2024-02-29T10:00:00+09:00'), true);
});
