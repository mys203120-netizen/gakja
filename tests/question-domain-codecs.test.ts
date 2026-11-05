import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { decodeApprovedQuestionContract, decodePreparedMainCandidate, decodeStudentObjectiveCandidate,
  approvedQuestionContractSchema, preparedMainCandidateSchema, studentObjectiveCandidateSchema } from '../server/contracts/question-domain-codecs';
import { assertQuestionContractIntegrity } from '../server/question-objective';
import type { ApprovedQuestionContract } from '../server/question-objective';
import type { PreparedMainCandidate } from '../server/data/prepared-question-bank';
import { readVerifiedQuestionDomainExport } from '../server/contracts/question-domain-adapters';
import { loadInterviewContext } from './fixtures/runtime-context';
import { localDevelopmentOwner } from '../server/session-runtime';
import { createQuestionDomainFixtureCases } from './fixtures/question-domain-contracts';
import { analysisDomainFixture } from './fixtures/analysis-domain';
import { analysisDocumentHash, validateAnalysisEnvelopeSemantics } from '../server/contracts/analysis-domain-adapters';
import { createDomainEnvelope, decodeDomainEnvelope, emptyDomainScope } from '../server/contracts/domain-envelope';

const cases = await createQuestionDomainFixtureCases();
const schemaFor = (kind: typeof cases[number]['kind']) => kind === 'student-objective-candidate' ? studentObjectiveCandidateSchema
  : kind === 'prepared-main-candidate' ? preparedMainCandidateSchema : approvedQuestionContractSchema;
const decode = (item: typeof cases[number]) => item.kind === 'student-objective-candidate' ? decodeStudentObjectiveCandidate(item.payload)
  : item.kind === 'prepared-main-candidate' ? decodePreparedMainCandidate(item.payload) : decodeApprovedQuestionContract(item.payload, { draft: item.draft });
for (const item of cases) test(`current question domain codec: ${item.id}`, () => {
  assert.equal(schemaFor(item.kind).safeParse(item.payload).success, item.schemaExpected);
  if (!item.expected) { assert.throws(() => decode(item)); return; }
  const before = JSON.stringify(item.payload), value = decode(item);
  assert.deepEqual(value, item.payload); assert.notEqual(value, item.payload);
  assert.equal(JSON.stringify(value), before, 'no field reorder, default injection or stripping in a hash-bound payload');
});

test('draft/contract provenance and all existing hashes survive decode/encode without approving evaluation', () => {
  const candidate = decodePreparedMainCandidate(cases.find(item => item.id === 'candidate-current-v0')!.payload);
  const original = candidate.draft.approvedQuestion!;
  const decoded = decodeApprovedQuestionContract(JSON.parse(JSON.stringify(original)), { draft: candidate.draft });
  assertQuestionContractIntegrity(candidate.draft, decoded);
  for (const field of ['contentSha256', 'blueprintSha256', 'finalUtteranceSha256', 'semanticContractSha256', 'reviewTraceSha256'] as const) assert.equal(decoded[field], original[field]);
  assert.equal(Object.hasOwn(decoded, 'evaluationScope'), false); assert.equal(decoded.policyDigest, null);
  assert.equal(Object.hasOwn(decoded.validation, 'independentPremiseReview'), false);
});

test('absent, explicit undefined, null and empty stay distinct at the current-domain boundary', () => {
  const original = cases.find(item => item.id === 'objective-record-utf16')!.payload as Record<string, unknown>;
  const absent = decodeStudentObjectiveCandidate(original);
  assert.equal(Object.hasOwn(absent, 'priority'), false);
  const explicitUndefined = decodeStudentObjectiveCandidate({ ...original, priority: undefined });
  assert.equal(Object.hasOwn(explicitUndefined, 'priority'), true); assert.equal(explicitUndefined.priority, undefined);
  assert.throws(() => decodeStudentObjectiveCandidate({ ...original, priority: null }));
  const empty = decodeStudentObjectiveCandidate({ ...original, unknowns: [] });
  assert.deepEqual(empty.unknowns, []); assert.equal(empty.anchorRefs[0].start, 3, 'emoji occupies two UTF-16 code units before the following space');
  assert.equal(JSON.stringify(explicitUndefined), JSON.stringify(absent), 'JSON serialization omits undefined; codecs never replace it with null');
});

test('JSON object order remains significant for legacy approval hashes; decode does not repair a reordered contract', () => {
  const original = cases.find(item => item.id === 'contract-current-nullable-digests')!.payload as ApprovedQuestionContract;
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  assert.equal(approvedQuestionContractSchema.safeParse(reordered).success, true);
  assert.throws(() => decodeApprovedQuestionContract(reordered), /QUESTION_CONTRACT_MUTATED/);
  const candidate = cases.find(item => item.id === 'candidate-current-v0')!.payload as PreparedMainCandidate;
  const roundtrip = JSON.parse(JSON.stringify(candidate));
  assert.equal(createHash('sha256').update(JSON.stringify(decodePreparedMainCandidate(roundtrip))).digest('hex'),
    createHash('sha256').update(JSON.stringify(candidate)).digest('hex'));
});

test('schema export is draft-07 shape evidence and cannot substitute for existing hash/source/audio verification', () => {
  for (const schema of [studentObjectiveCandidateSchema, approvedQuestionContractSchema, preparedMainCandidateSchema]) {
    const exported = z.toJSONSchema(schema, { target: 'draft-07' });
    assert.equal(exported.$schema, 'http://json-schema.org/draft-07/schema#'); assert.equal(exported.type, 'object');
  }
  const tampered = cases.find(item => item.id === 'candidate-question-hash-tampered')!;
  assert.equal(schemaFor(tampered.kind).safeParse(tampered.payload).success, true);
  assert.throws(() => decode(tampered), /HASH_CHANGED/);
});

test('local export adapter rejects a different owner and never invents an absent approved bank', async () => {
  const context = await loadInterviewContext();
  await assert.rejects(readVerifiedQuestionDomainExport(context, { ownerId: localDevelopmentOwner().id + '-other' }), /OWNER_MISMATCH/);
  await assert.rejects(readVerifiedQuestionDomainExport(context, { ownerId: localDevelopmentOwner().id, root: '__missing_synthetic_bank_root__' }), /APPROVED_BANK_REQUIRED/);
});

test('target-only review revision uses its own transport scope and retains the exact common relationship', () => {
  const { source, v2 } = analysisDomainFixture();
  const { contentSha256: originalContentSha256, ...originalBody } = v2.target;
  const body = { ...originalBody, revision: 'target-synthetic-reviewed-revision', analysisRevision: 'synthetic-target-authoring-review-revision' };
  const target = { ...body, contentSha256: analysisDocumentHash(body) };
  assert.notEqual(target.contentSha256, originalContentSha256);
  assert.notEqual(target.analysisRevision, v2.common.revision);
  assert.equal(target.commonAnalysisRevision, v2.common.revision);
  validateAnalysisEnvelopeSemantics({ ...v2, target }, source);
  const scope = { ...emptyDomainScope(), studentId: target.studentId, supportTargetId: target.supportTargetId,
    profileRevision: target.profileRevision, analysisRevision: target.analysisRevision };
  const envelope = createDomainEnvelope('target-student-analysis', target, scope);
  assert.equal(envelope.payloadJson, JSON.stringify(target));
  assert.equal(JSON.stringify(decodeDomainEnvelope(envelope)), JSON.stringify(target));
  assert.throws(() => createDomainEnvelope('target-student-analysis', target, { ...scope, analysisRevision: v2.common.revision }), /SCOPE_MISMATCH:analysisRevision/);
  const invalidBody = { ...body, commonAnalysisRevision: 'another-common-revision' };
  assert.throws(() => validateAnalysisEnvelopeSemantics({ ...v2, target: { ...invalidBody, contentSha256: analysisDocumentHash(invalidBody) } }, source), /CONTEXT_MISMATCH/);
});
