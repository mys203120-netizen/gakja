import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisDomainSchemas } from '../server/contracts/analysis-domain-codecs';
import { analysisDocumentHash, decodeAnalysisWireV2PreservingOrder, decodeFullAnalysisPreservingOrder, decodeTargetAnalysisPreservingOrder, encodeAnalysisWireV2, encodeFullAnalysis, encodeTargetAnalysis, validateAnalysisEnvelopeSemantics } from '../server/contracts/analysis-domain-adapters';
import { analysisDomainFixture, analysisDomainFixtureCases } from './fixtures/analysis-domain';

test('G2 actual analysis contracts preserve typed wire and v1/v2 canonical shape distinctions', () => {
  for (const fixture of analysisDomainFixtureCases()) {
    assert.equal(analysisDomainSchemas[fixture.contract].safeParse(fixture.input).success, fixture.expectedValid, fixture.name);
    let accepted = true;
    try {
      if (fixture.contract === 'student-analysis-codec-v2') decodeAnalysisWireV2PreservingOrder(fixture.source, fixture.input);
      else if (fixture.contract === 'full-student-analysis') decodeFullAnalysisPreservingOrder(fixture.input);
      else decodeTargetAnalysisPreservingOrder(fixture.input);
    } catch { accepted = false; }
    assert.equal(accepted, fixture.expectedSemanticValid, fixture.name + ': semantic validation remains separate from shape');
  }
});

test('G2 decode/encode is byte-preserving for original insertion order and does not promote v1 or change target/objective IDs', () => {
  const { source, wire, v1, v2 } = analysisDomainFixture();
  const reorderedWire = Object.fromEntries(Object.entries(wire).reverse());
  assert.equal(encodeAnalysisWireV2(source, reorderedWire), JSON.stringify(reorderedWire));
  for (const value of [v1, v2]) {
    const original = JSON.stringify(value), commonBytes = encodeFullAnalysis(value.common), targetBytes = encodeTargetAnalysis(value.target);
    assert.equal(commonBytes, JSON.stringify(value.common)); assert.equal(targetBytes, JSON.stringify(value.target));
    const decodedCommon = decodeFullAnalysisPreservingOrder(JSON.parse(commonBytes)), decodedTarget = decodeTargetAnalysisPreservingOrder(JSON.parse(targetBytes));
    assert.equal(decodedCommon.contentSha256, value.common.contentSha256); assert.equal(decodedTarget.contentSha256, value.target.contentSha256);
    assert.deepEqual(decodedTarget.objectives.map(item => item.id), value.target.objectives.map(item => item.id));
    assert.equal(JSON.stringify(value), original); assert.notEqual(decodedCommon, value.common);
  }
  assert.equal('codecVersion' in decodeFullAnalysisPreservingOrder(v1.common), false);
  assert.equal('literalValues' in decodeFullAnalysisPreservingOrder(v1.common).academicRecords[0], false);
  const legacySelection = analysisDomainFixtureCases().find(row => row.name === 'target-v2-historical-pool-selection-v1-no-imports-invented')!;
  assert.equal(encodeTargetAnalysis(legacySelection.input), JSON.stringify(legacySelection.input), 'observed legacy provenance remains byte-identical and is not filled with v2 defaults');
});

test('G2 source/target pins and UTF-16 proof anchors remain exact without granting owner or scientific approval', () => {
  const { source, v2 } = analysisDomainFixture(), before = JSON.stringify(v2);
  const report = validateAnalysisEnvelopeSemantics(v2, source, { studentId: source.studentId, sourceRevision: source.revision, commonRevision: v2.common.revision, supportTargetId: v2.target.supportTargetId, profileRevision: v2.target.profileRevision });
  assert.equal(report.providerCalls, 0); assert.equal(report.canonicalMutation, false); assert.equal(report.evidenceSha256, analysisDocumentHash(v2.evidence));
  const proof = v2.common.activities[0].facts.recordedContext[0]; assert.equal(source.pages[0].text.slice(proof.pageStart, proof.pageEnd), proof.quote); assert.ok(proof.quote.includes('🧪'));
  assert.throws(() => validateAnalysisEnvelopeSemantics(v2, source, { supportTargetId: 'another-target' }), /CONTEXT_MISMATCH/);
  assert.throws(() => validateAnalysisEnvelopeSemantics(v2, source, { sourceRevision: 'another-extraction' }), /CONTEXT_MISMATCH/);
  assert.equal(v2.common.coverage.independentSemanticReview, false); assert.equal(JSON.stringify(v2), before);
});
