import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { prepareRuntimeRecoveryPool, recoveryOriginal, OFFLINE_RECOVERY_REPORT_POLICY, type RuntimeRecoveryPoolProviders } from '../scripts/prepare-runtime-recovery-pool';
import { loadApprovedRecoveryVariants, recoveryVariantIdentity } from '../server/data/approved-recovery-variants';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { PreparedQuestionBank, PreparedMainCandidate } from '../server/data/prepared-question-bank';
import type { QuestionDraft } from '../server/protocol';

function fixture() {
  const context = { student: { evidence: [{ id: 'E1', text: '資料를 비교했다.' }] }, manifest: { files: [{ role: 'studentPdf', path: 'synthetic.pdf', sha256: 'a'.repeat(64) }] } } as unknown as InterviewContext;
  const draft: QuestionDraft = { questionText: '자료를 비교할 때 어떤 기준을 사용했나요?', questionKind: 'main', parentMainQuestionId: null,
    acknowledgement: null, acknowledgementQuote: null, evidenceIds: ['E1'], evidenceQuotes: [{ evidenceId: 'E1', quote: '資料를 비교했다.' }], primaryFunction: 'CHOICE', depth: 'D2',
    questionIntent: '자료 비교 기준 한 가지', targetEvidence: ['자료 비교 기준 한 가지'], groundingRationale: '기록된 비교 기준을 확인한다.', validationStatus: 'approved', validationFailures: [] };
  const candidate = { id: 'synthetic-candidate', draft, voiceSettings: { speaker: 'synthetic', speed: 0, pitch: 0, volume: 0, format: 'mp3' } } as PreparedMainCandidate;
  const bank = { key: 'synthetic-bank', contentSha256: 'b'.repeat(64), questionModel: 'explicit-synthetic-review', slots: [{ candidates: [candidate] }] } as unknown as PreparedQuestionBank;
  const providers: RuntimeRecoveryPoolProviders = {
    async generate(original) { assert.equal(original.rawTranscript, undefined); assert.equal(original.answerId, undefined); return '자료를 비교한 기준 한 가지만 말씀해 주세요.'; },
    async review(input) { assert.equal(input.answer, null); return { verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true,
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', sourceId: null, supportQuote: null, supported: true }] }; },
    async warm() { return { cache: 'synthetic-test' }; },
  };
  return { context, candidate, bank, providers };
}
async function directory(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'runtime-recovery-pool-'));
  t.after(async () => { const target = path.resolve(root); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('runtime-recovery-pool-')); await rm(target, { recursive: true, force: true }); });
  return root;
}

test('offline recovery preparation preserves the bank and stores only independently approved answer-free same-demand variants', async t => {
  const root = await directory(t), f = fixture(), before = JSON.stringify(f.bank);
  const result = await prepareRuntimeRecoveryPool(f.context, f.bank, f.providers, { root, policy: OFFLINE_RECOVERY_REPORT_POLICY });
  assert.equal(result.coverage.ready, 1); assert.equal(result.coverage.audioReady, 1);
  assert.equal(result.studentAnswerCreated, false); assert.equal(JSON.stringify(f.bank), before);
  assert.deepEqual(result.policy, OFFLINE_RECOVERY_REPORT_POLICY);
  assert.notEqual(result.policy, OFFLINE_RECOVERY_REPORT_POLICY, 'the report pins a snapshot independent of future caller mutation');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  assert.equal(hash(result.policy.generationInstructions), result.policy.generationSha256);
  assert.equal(hash(result.policy.reviewInstructions), result.policy.reviewSha256);
  const loaded = await loadApprovedRecoveryVariants(f.context, recoveryOriginal(f.candidate), root);
  assert.equal(loaded.length, 1); assert.equal(loaded[0].questionIntent, f.candidate.draft.questionIntent);
  assert.deepEqual(loaded[0].targetEvidence, f.candidate.draft.targetEvidence);
  assert.equal(loaded[0].questionKind, 'clarification');
  let calls = 0;
  const cached = await prepareRuntimeRecoveryPool(f.context, f.bank, { ...f.providers,
    async generate() { calls++; throw new Error('unexpected'); }, async review() { calls++; throw new Error('unexpected'); } }, { root });
  assert.equal(cached.coverage.cached, 1); assert.equal(calls, 0);
});

test('a rejected review uses at most two explicit candidates and cannot populate the runtime cache', async t => {
  const root = await directory(t), f = fixture(); let generated = 0, reviewed = 0;
  const result = await prepareRuntimeRecoveryPool(f.context, f.bank, { ...f.providers,
    async generate() { generated++; return generated === 1 ? '자료를 비교한 기준을 쉽게 말씀해 주세요.' : '어떤 기준으로 자료를 비교했는지 말씀해 주세요.'; },
    async review(input) { reviewed++; return { verdict: 'rewrite', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: false, clarificationPreservesIntent: false,
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', sourceId: null, supportQuote: null, supported: true }] }; },
  }, { root });
  assert.equal(generated, 2); assert.equal(reviewed, 2); assert.equal(result.coverage.ready, 0);
  assert.deepEqual(await loadApprovedRecoveryVariants(f.context, recoveryOriginal(f.candidate), root), []);
  assert.ok(result.questions[0].attempts.every((attempt: { approved: boolean }) => !attempt.approved));
});

test('check-only mode never generates reviews or audio and never turns a missing pool into ready', async t => {
  const root = await directory(t), f = fixture(); let calls = 0;
  const result = await prepareRuntimeRecoveryPool(f.context, f.bank, {
    async generate() { calls++; return ''; }, async review() { calls++; return {}; }, async warm() { calls++; return {}; },
  }, { root, checkOnly: true });
  assert.equal(calls, 0); assert.equal(result.coverage.ready, 0); assert.equal(result.usage.length, 0);
});

test('same-demand review receives the actual Q0 separately from broader internal targets and rejects an added task', async t => {
  const root = await directory(t), f = fixture();
  const source = '무응답자를 0점으로 처리한 뒤 유효 응답만 표본으로 재설정했다.';
  f.context.student.evidence[0].text = source;
  f.candidate.draft.questionText = '유효 응답만 표본으로 다시 정한 방법을 설명해 주세요.';
  f.candidate.draft.questionIntent = '무응답 처리 문제와 수정 과정';
  f.candidate.draft.targetEvidence = ['무응답을 0점으로 처리한 문제와 재설정 과정을 확인한다.'];
  f.candidate.draft.evidenceQuotes = [{ evidenceId: 'E1', quote: source }];
  const actual = f.candidate.draft.questionText, broader = [...f.candidate.draft.targetEvidence];
  const candidates = ['무응답을 0점으로 계산한 문제와 표본을 다시 정한 과정을 설명해 주세요.', '유효 응답만 남겨 표본을 정한 과정은 무엇인가요?'];
  let generated = 0;
  const result = await prepareRuntimeRecoveryPool(f.context, f.bank, { ...f.providers,
    async generate() { return candidates[generated++]; },
    async review(input) {
      assert.equal(input.originalQuestion?.questionText, actual);
      assert.deepEqual(input.originalQuestion?.targetEvidence, broader);
      assert.deepEqual(input.question.targetEvidence, broader);
      const expanded = input.question.questionText === candidates[0];
      return { verdict: expanded ? 'rewrite' : 'allowed', completeAssertionCoverage: true, coreIntentCount: expanded ? 2 : 1, intentMatches: !expanded, clarificationPreservesIntent: !expanded,
        premises: [{ questionSpan: input.question.questionText, basis: 'open_check', sourceId: null, supportQuote: null, supported: true }] };
    },
  }, { root });
  assert.equal(result.coverage.ready, 1);
  assert.equal(result.questions[0].attempts[0].approved, false);
  assert.equal(result.questions[0].variant, candidates[1]);
  assert.equal(f.candidate.draft.questionText, actual);
  assert.deepEqual((await loadApprovedRecoveryVariants(f.context, recoveryOriginal(f.candidate), root))[0].targetEvidence, broader, 'review never silently changes the immutable original demand metadata');
});

test('a contradictory rewrite verdict for an open conditional role is never automatically promoted to approved', async t => {
  const root = await directory(t), f = fixture();
  f.candidate.draft.questionText = '공동 실험에서 본인이 직접 한 일이 있다면 무엇인가요?';
  const result = await prepareRuntimeRecoveryPool(f.context, f.bank, { ...f.providers,
    async generate() { return '공동 실험에서 직접 담당한 부분이 있다면 무엇인가요?'; },
    async review(input) { return { verdict: 'rewrite', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true,
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', sourceId: null, supportQuote: null, supported: true }] }; },
  }, { root, maxCandidatesPerQuestion: 1 });
  assert.equal(result.coverage.ready, 0);
  assert.equal(result.questions[0].attempts[0].failure, 'PREMISE_UNSUPPORTED');
  assert.deepEqual(await loadApprovedRecoveryVariants(f.context, recoveryOriginal(f.candidate), root), []);
});

test('offline precision review records its actual reviewer separately from generation and never approves a rejected review', async t => {
  const root = await directory(t), rejectedRoot = await directory(t), f = fixture(), reviewer = 'explicit-synthetic-precision-review';
  const result = await prepareRuntimeRecoveryPool(f.context, f.bank, f.providers, { root, reviewModel: reviewer });
  assert.equal(result.coverage.ready, 1);
  assert.equal(result.generationModel, f.bank.questionModel);
  assert.equal(result.reviewModel, reviewer);
  const original = recoveryOriginal(f.candidate), loaded = await loadApprovedRecoveryVariants(f.context, original, root);
  assert.equal(loaded[0].premiseValidation?.reviewModel, reviewer);
  const artifact = JSON.parse(await readFile(path.join(root, 'data/prepared/recovery-variants', `${recoveryVariantIdentity(f.context, original)}.json`), 'utf8'));
  assert.equal(artifact.variants[0].reviewModel, reviewer);
  assert.notEqual(artifact.variants[0].reviewModel, f.bank.questionModel);
  const cached = await prepareRuntimeRecoveryPool(f.context, f.bank, f.providers, { root, checkOnly: true });
  assert.deepEqual(cached.questions[0].cachedReviewModels, [reviewer], 'a later default-model check must retain the stored reviewer label');
  const rejected = await prepareRuntimeRecoveryPool(f.context, f.bank, { ...f.providers,
    async review(input) { return { verdict: 'rewrite', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: false, clarificationPreservesIntent: false,
      premises: [{ questionSpan: input.question.questionText, basis: 'open_check', sourceId: null, supportQuote: null, supported: true }] }; },
  }, { root: rejectedRoot, reviewModel: reviewer, maxCandidatesPerQuestion: 1 });
  assert.equal(rejected.coverage.ready, 0);
  assert.ok(rejected.usage.some((row: { stage: string; observation: { requestedModel?: string } }) => row.stage === 'review' && row.observation.requestedModel === reviewer));
  assert.deepEqual(await loadApprovedRecoveryVariants(f.context, original, rejectedRoot), []);
});
