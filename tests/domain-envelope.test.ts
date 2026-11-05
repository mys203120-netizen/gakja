import assert from 'node:assert/strict';
import test from 'node:test';
import { createDomainEnvelope, decodeDomainEnvelope, emptyDomainScope, inspectDomainEnvelope, parseTransportJson,
  transportDigest, verifyUtf16Span } from '../server/contracts/domain-envelope';
import { createQuestionDomainFixtureCases } from './fixtures/question-domain-contracts';
import { analysisDomainFixture } from './fixtures/analysis-domain';

test('shared transport forwards exact current approval bytes without changing legacy hash order', async () => {
  const item = (await createQuestionDomainFixtureCases()).find(row => row.id === 'contract-current-nullable-digests')!;
  const envelope = createDomainEnvelope(item.kind, item.payload, emptyDomainScope(), { draft: item.draft });
  const roundtrip = decodeDomainEnvelope(JSON.parse(JSON.stringify(envelope)), { draft: item.draft });
  assert.equal(JSON.stringify(roundtrip), JSON.stringify(item.payload));
  assert.equal(transportDigest(envelope.payloadJson), envelope.payloadSha256);
  assert.equal(envelope.authority, 'transport_only_not_approval_or_authentication');
  assert.throws(() => inspectDomainEnvelope({ ...envelope, payloadJson: envelope.payloadJson + ' ' }), /HASH_CHANGED/);
  assert.throws(() => inspectDomainEnvelope({ ...envelope, payloadVersion: 'approved-question-contract-v2' }), /VERSION_MISMATCH/);
});
test('ambiguous transport rejected; legacy storage is not normalized', () => {
  assert.throws(() => parseTransportJson('{"a":1,"a":2}'), /DUPLICATE/);
  assert.throws(() => parseTransportJson('{"a":1,"\\u0061":2}'), /DUPLICATE/);
  assert.throws(() => parseTransportJson('{"a":"\\ud800"}'), /SURROGATE/);
  assert.throws(() => parseTransportJson('{"a":9007199254740992}'), /NUMBER_RANGE/);
  assert.deepEqual(parseTransportJson('{"a":{"x":1},"b":{"x":2},"text":"a:{x}"}'), { a: { x: 1 }, b: { x: 2 }, text: 'a:{x}' });
});
test('UTF-16 offsets retain astral quotes and reject split codepoints or empty spans', () => {
  assert.equal(verifyUtf16Span('가🙂나', 1, 3, '🙂'), true);
  assert.equal(verifyUtf16Span('가🙂나', 1, 2, '\ud83d'), false);
  assert.equal(verifyUtf16Span('가🙂나', 2, 3, '\ude42'), false);
  assert.equal(verifyUtf16Span('가🙂나', 3, 3, ''), false);
  assert.equal(verifyUtf16Span('가🙂나', 1.5, 3, '🙂'), false);
});
test('wire transport pins must match the actual source supplied to its domain decoder', () => {
  const { source, wire } = analysisDomainFixture();
  const scope = { ...emptyDomainScope(), studentId: source.studentId, sourceRevision: source.revision,
    recordRevision: source.recordRevision, sourceContentSha256: source.contentSha256 };
  const envelope = createDomainEnvelope('student-analysis-codec-v2', wire, scope, { source });
  for (const key of ['studentId', 'sourceRevision', 'recordRevision', 'sourceContentSha256'] as const) {
    const wrongScope = { ...scope, [key]: key === 'sourceContentSha256' ? 'f'.repeat(64) : 'wrong' };
    assert.throws(() => createDomainEnvelope('student-analysis-codec-v2', wire, wrongScope, { source }), /EXPECTED_SCOPE_MISMATCH/);
    assert.throws(() => decodeDomainEnvelope({ ...envelope, scope: wrongScope }, { source }), /EXPECTED_SCOPE_MISMATCH/);
  }
  assert.throws(() => decodeDomainEnvelope(envelope), /SOURCE_CONTEXT_REQUIRED/);
});
