import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession } from '../server/protocol';
import { buildActualUserCoreManifest, actualUserCoreCheckpoint, rebindActualUserCheckpoint, actualUserCriticalLabels, checkActualUserOutcome } from '../scripts/replay-actual-user-core';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const manifestPromise = buildActualUserCoreManifest();

test('actual-user replay freezes precisely the immutable 3 real sessions and 25 original question-answer pairs', async () => {
  const manifest = await manifestPromise;
  assert.equal(manifest.sources.length, 3); assert.equal(manifest.cases.length, 25);
  assert.deepEqual(manifest.sources.map(source => source.count), [9, 9, 7]);
  assert.equal(manifest.liveProviderCalls, 0); assert.equal(manifest.historicalEndingObservation, null);
  assert.equal(manifest.cases.filter(row => row.expected.critical).length, Object.keys(actualUserCriticalLabels).length);
  for (const source of manifest.sources) {
    const bytes = await readFile(source.path), original = JSON.parse(bytes.toString('utf8')) as InterviewSession;
    assert.equal(hash(bytes), source.sha256);
    for (const row of manifest.cases.filter(item => item.sourcePath === source.path)) {
      const turn = original.turns[row.turnIndex];
      assert.equal(row.question, turn.questionText); assert.equal(row.rawTranscript, turn.rawTranscript);
      assert.equal(row.prefixTurnIds.length, row.turnIndex + 1); assert.equal(row.endingObservation, null);
      assert.equal(row.elapsedObservation.type, 'answer.metrics'); assert.ok(row.elapsedMs >= 0);
    }
  }
});

test('same-prefix checkpoint deletes its old current decision, excludes future turns, and never invents ending observations', async () => {
  const manifest = await manifestPromise, row = manifest.cases.find(item => item.id === 'R2-Q6')!;
  const original = JSON.parse(await readFile(row.sourcePath, 'utf8')) as InterviewSession, before = JSON.stringify(original);
  const context = { manifest: original.sourceManifest, errors: [], student: { evidence: [] }, school: {} } as unknown as InterviewContext;
  const checkpoint = actualUserCoreCheckpoint(context, original, row);
  assert.equal(checkpoint.turns.length, 6); assert.equal(checkpoint.turns.at(-1)?.rawTranscript, row.rawTranscript);
  assert.equal(checkpoint.turns.at(-1)?.metadata.coreDecision, undefined);
  assert.equal(checkpoint.turns.at(-1)?.metadata.answerEndingObservation, undefined);
  assert.equal(checkpoint.elapsedMs, row.elapsedMs);
  assert.equal(JSON.stringify(original), before);
  assert.throws(() => actualUserCoreCheckpoint(context, original, { ...row, rawTranscript: '변경한 답변' }), /FROZEN_QUESTION_ANSWER_CHANGED/u);
  assert.throws(() => actualUserCoreCheckpoint(context, original, { ...row, turnIndex: 8 }), /PREFIX_CHANGED/u);
});

test('verified diagnostic rebind proves identical student PDF and exact surviving quotations while disclosing changed context', async () => {
  const manifest = await manifestPromise, row = manifest.cases[0];
  const original = JSON.parse(await readFile(row.sourcePath, 'utf8')) as InterviewSession, before = JSON.stringify(original);
  const historical = original.sourceManifest as InterviewContext['manifest'];
  const pdfSha256 = historical.files.find(file => file.role === 'studentPdf')!.sha256!;
  const context = { target: original.target, manifest: structuredClone(historical), errors: [],
    student: { evidence: original.turns[0].metadata.evidenceQuotes.map(quote => ({ id: quote.evidenceId, text: quote.quote, sourceRef: { pdfSha256, page: 1, startOffset: 0, endOffset: quote.quote.length } })) }, school: {} } as unknown as InterviewContext;
  context.manifest.recordIds = { ...context.manifest.recordIds, studentAnalysisRevision: 'explicit-new-test-revision' };
  const checkpoint = actualUserCoreCheckpoint(context, original, row), trace = rebindActualUserCheckpoint(context, original, checkpoint);
  assert.equal(trace.stableStudentPdfSha256, pdfSha256);
  assert.notEqual(trace.historicalSourceManifestSha256, trace.currentSourceManifestSha256);
  assert.ok(trace.comparisonLimit.includes('not an otherwise-identical-prompt A/B'));
  assert.notEqual(checkpoint.sourceManifest, context.manifest);
  assert.deepEqual(checkpoint.sourceManifest, context.manifest); assert.equal(JSON.stringify(original), before);
  const bad = structuredClone(context); bad.manifest.files.find(file => file.role === 'studentPdf')!.sha256 = 'b'.repeat(64);
  assert.throws(() => rebindActualUserCheckpoint(bad, original, checkpoint), /STUDENT_PDF_CHANGED/u);
  const missing = structuredClone(context); missing.student.evidence = [];
  assert.throws(() => rebindActualUserCheckpoint(missing, original, checkpoint), /HISTORICAL_EVIDENCE_NOT_VERIFIED/u);
});

test('manual semantic labels separate met comparison and optional concept deepening from unfinished negation and refusal', async () => {
  const manifest = await manifestPromise, get = (id: string) => manifest.cases.find(row => row.id === id)!.expected;
  assert.deepEqual(get('R1-Q6').coverage, ['met']); assert.ok(get('R1-Q6').actions.includes('FOLLOW_UP'));
  assert.deepEqual(get('R2-Q6').actions, ['CONTINUE_ANSWER']); assert.equal(get('R2-Q6').coverage, null);
  const pending = { assessment: null, next: { action: 'CONTINUE_ANSWER' as const, question: null }, reaction: null };
  assert.equal(checkActualUserOutcome(pending, get('R2-Q6')).structuralLabelsPassed, true);
  assert.equal(checkActualUserOutcome({ assessment: { coverage: 'met', response: 'answered', reason: '부정으로 답함' }, next: { action: 'TRANSITION', question: null }, reaction: null }, get('R2-Q6')).structuralLabelsPassed, false);
  assert.deepEqual(get('R2-Q8').actions, ['TRANSITION']); assert.deepEqual(get('R3-Q5').actions, ['TRANSITION']);
});
