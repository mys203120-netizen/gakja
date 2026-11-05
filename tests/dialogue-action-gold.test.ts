import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dialogueActionGoldCases, dialogueActionGoldMdSources, dialogueActionGoldProvenance } from './fixtures/dialogue-action-gold';
import { dialogueActionHistoricalGoldCases, dialogueActionHistoricalGoldProvenance } from './fixtures/dialogue-action-historical-gold';

test('MD-authored expectations explicitly await human review and never claim independent human labels', () => {
  for (const provenance of [dialogueActionGoldProvenance, dialogueActionHistoricalGoldProvenance]) {
    assert.equal(provenance.labelAuthor, 'Codex (MD-based)');
    assert.equal(provenance.humanReviewed, false);
    assert.equal(provenance.humanReviewStatus, 'pending');
    assert.equal(provenance.modelOutputsUsedAsGold, false);
  }
  assert.equal(dialogueActionHistoricalGoldProvenance.syntheticCurrentAnswers, true);
  assert.equal(dialogueActionHistoricalGoldProvenance.expectedLabelsAreProviderInput, false);
});

test('base scenarios and paraphrases have unique identities and are counted separately', () => {
  assert.equal(dialogueActionGoldCases.length, 32);
  assert.equal(dialogueActionGoldCases.reduce((sum, item) => sum + item.variants.length, 0), 96);
  assert.equal(dialogueActionHistoricalGoldCases.length, 24);
  assert.equal(dialogueActionHistoricalGoldCases.reduce((sum, item) => sum + item.variants.length, 0), 36);
  const all = [...dialogueActionGoldCases, ...dialogueActionHistoricalGoldCases];
  assert.equal(new Set(all.map(item => item.id)).size, all.length);
  const variantIds = all.flatMap(item => item.variants.map(variant => variant.id));
  assert.equal(new Set(variantIds).size, variantIds.length);
  for (const item of dialogueActionGoldCases) assert.equal(item.variants.length, 3, item.id);
  for (const item of dialogueActionHistoricalGoldCases) assert.equal(item.variants.length, item.criticalVariants ? 3 : 1, item.id);
  for (const item of all) {
    assert.equal(new Set(item.variants.map(variant => variant.answer.trim())).size, item.variants.length, item.id);
    assert.ok(item.expected.questionScope.length > 10, item.id);
    assert.ok(item.expected.forbiddenProbes.length >= 2, item.id);
    assert.ok(item.mdRefs.length >= 2, item.id);
  }
});

test('all case references point to existing ranges in the latest canonical MD documents', async () => {
  const sources = new Map<string, string[]>();
  for (const [key, path] of Object.entries(dialogueActionGoldMdSources)) {
    const contents = await readFile(path, 'utf8');
    assert.ok(contents.length > 1000, path);
    sources.set(key, contents.split(/\r?\n/u));
  }
  for (const item of [...dialogueActionGoldCases, ...dialogueActionHistoricalGoldCases]) {
    for (const ref of item.mdRefs) {
      const lines = sources.get(ref.document);
      assert.ok(lines, `${item.id}: ${ref.document}`);
      assert.ok(Number.isInteger(ref.startLine) && ref.startLine > 0, item.id);
      assert.ok(ref.endLine >= ref.startLine && ref.endLine <= lines.length, item.id);
      assert.ok(lines.slice(ref.startLine - 1, ref.endLine).join('\n').trim().length > 20, item.id);
      assert.ok(ref.clause && ref.rationale, item.id);
    }
  }
});

test('historical live cases retain the exact frozen question and source identity', async () => {
  const bytes = await readFile(dialogueActionHistoricalGoldProvenance.anchorArtifact);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), dialogueActionHistoricalGoldProvenance.anchorArtifactSha256);
  const source = JSON.parse(bytes.toString('utf8')) as { cases: Array<{ question: string }> };
  for (const item of dialogueActionHistoricalGoldCases) {
    assert.equal(item.sourceAnchor.artifactPath, dialogueActionHistoricalGoldProvenance.anchorArtifact);
    assert.equal(source.cases[item.sourceAnchor.sourceRowIndex]?.question, item.expectedQuestion, item.id);
  }
  assert.equal(dialogueActionHistoricalGoldCases.filter(item => item.criticalVariants).length, 6);
});

test('scoring expectations separate real follow-ups from same-demand rephrase, replay and non-evaluative speech', () => {
  for (const item of [...dialogueActionGoldCases, ...dialogueActionHistoricalGoldCases]) {
    assert.equal(item.expected.scoring.preserveCurrentCoverageWhenChoosingNext, true, item.id);
    assert.deepEqual(item.expected.scoring.nextByAction.map(rule => rule.action), item.expected.actions, item.id);
    for (const rule of item.expected.scoring.nextByAction) {
      assert.equal(rule.independentAnswerScore, rule.action === 'FOLLOW_UP', item.id);
      assert.equal(rule.consumesFollowUp, rule.action === 'FOLLOW_UP', item.id);
      assert.equal(rule.consumesMeaningRephrase, rule.action === 'CLARIFICATION', item.id);
    }
  }
  const closing = dialogueActionGoldCases.find(item => item.id === 'DG-31')!;
  assert.equal(closing.runtimeEligibility, 'prompt_rubric_only');
  assert.equal(closing.expected.scoring.currentAnswer, 'non_evaluative_closing');
});
