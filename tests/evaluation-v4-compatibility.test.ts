import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildEvaluationClusterInputs, evaluationSessionSourceFingerprint, historicalEvaluationSourceFingerprint,
  HISTORICAL_REVIEWED_KNOWLEDGE_PIPELINE_VERSION } from '../server/providers/evaluation-input';
import { evaluationV4CompatibilityFixture, V4_COMPATIBILITY_MODEL } from './fixtures/evaluation-v4-compatibility';

/** These constants were computed by executing evaluationSessionSourceFingerprint
 * and buildEvaluationClusterInputs from the ACTUAL a666f7a81dd2e80851f8589d135a0aac67c1eae2
 * git archive, not the new historical helper. The archived engine consumed this
 * deterministic synthetic Q0 + clarification + F1 input with two nonempty,
 * approved record_consistency_only bindings. No private source or provider call.
 * CI needs only the frozen values, never the local archive or a git checkout. */
const V4_SOURCE_GOLDEN = '246de1ed727ad963c831f9c4fd6355a756ddc199708724c2085dfa06868b90a6';
const V4_CLUSTERS_GOLDEN = '85cf6dfe511253503b4649f45db84969af442b985fca16f056acd6755ec17466';
const V4_BINDING_GOLDENS = [
  '9df706c63ddab8bb5e5fb602c28de980df69306e631fa2a6e20bae8a6d27b5f0',
  'b718020a62b11e029ef3db93d4d58b0960c823f6ddd1c2591034615094e76a0d',
];

test('historical v4 fingerprint equals the actual a666f7a golden for approved Q0/F1 and clarification inputs', () => {
  const { context, session } = evaluationV4CompatibilityFixture();
  const originalBytes = JSON.stringify({ context, session });
  assert.equal(historicalEvaluationSourceFingerprint(context, session, HISTORICAL_REVIEWED_KNOWLEDGE_PIPELINE_VERSION, V4_COMPATIBILITY_MODEL), V4_SOURCE_GOLDEN);
  const clusters = buildEvaluationClusterInputs(context, session).map(cluster => ({ ...cluster, version: HISTORICAL_REVIEWED_KNOWLEDGE_PIPELINE_VERSION }));
  assert.equal(createHash('sha256').update(JSON.stringify(clusters)).digest('hex'), V4_CLUSTERS_GOLDEN);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].answers.map(answer => answer.id), ['v4-q0', 'v4-f1']);
  assert.deepEqual(clusters[0].answers[0].answerAttempts.map(attempt => attempt.sourceTurnId), ['v4-q0', 'v4-c1']);
  assert.deepEqual(clusters[0].answers.map(answer => answer.knowledge.bindingSha256), V4_BINDING_GOLDENS);
  for (const answer of clusters[0].answers) {
    assert.equal(answer.knowledge.scope, 'record_consistency_only');
    assert.deepEqual(answer.knowledge.holdReasons, []);
    assert.ok(answer.knowledge.binding);
    assert.equal(answer.knowledge.scientificTruthAuthority, 'none');
  }
  assert.notEqual(evaluationSessionSourceFingerprint(context, session, V4_COMPATIBILITY_MODEL), V4_SOURCE_GOLDEN, 'the new pipeline must not relabel a stored v4 source hash');
  assert.equal(JSON.stringify({ context, session }), originalBytes);
});
