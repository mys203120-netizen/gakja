import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildBankQualityReviewRows, selectedQuestionReviewMd, validateBankQualityReviewCoverage, type BankQualityReviewInput, type BankQualityReviewRow } from '../scripts/review-bank-quality';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { PreparedQuestionBank } from '../server/data/prepared-question-bank';

const input = { candidateId: 'candidate-a', objectiveId: 'purpose-a', questionSha256: 'a'.repeat(64), questionText: '이 활동에서 직접 한 일은 무엇인가요?', questionIntent: '개인 역할', targetEvidence: ['개인 역할'], primaryFunction: 'ROLE', depth: 'D1', origin: 'activity', openCheck: true, commonApproval: null, sourceQuotes: [], forbiddenPremises: [] } satisfies BankQualityReviewInput;
const keep = { candidateId: input.candidateId, actualSpokenDemand: '학생이 직접 담당한 행동 한 가지', coreIntentCount: 1, intentMatchesSpokenDemand: true, targetMatchesSpokenDemand: true, noUnspokenRequiredElements: true, noLeadingAnswerDisclosure: true, classificationMatchesSpokenDemand: true, disposition: 'keep', recommendedIntent: '학생이 직접 담당한 행동 한 가지', recommendedTarget: '학생이 직접 담당한 행동 한 가지', recommendedFunction: 'ROLE', recommendedDepth: 'D1', proposedQuestion: null, preservesVerificationPurpose: true, reason: '열린 개인 역할 한 가지를 확인하는 요구와 일치한다.' } satisfies BankQualityReviewRow;

test('offline review cannot silently omit a candidate, duplicate an ID, or add a candidate outside the frozen bank', () => {
  assert.equal(validateBankQualityReviewCoverage([input], { questions: [keep] }).questions.length, 1);
  assert.throws(() => validateBankQualityReviewCoverage([input, { ...input, candidateId: 'b' }], { questions: [keep] }), /COVERAGE_INVALID/u);
  assert.throws(() => validateBankQualityReviewCoverage([input, { ...input, candidateId: 'b' }], { questions: [keep, keep] }), /COVERAGE_INVALID/u);
  assert.throws(() => validateBankQualityReviewCoverage([input], { questions: [{ ...keep, candidateId: 'invented-id' }] }), /COVERAGE_INVALID/u);
});

test('a reviewer cannot mark a leading or multi-demand question as keep, and a contract revision cannot hide a new utterance', () => {
  for (const change of [{ coreIntentCount: 2 }, { noUnspokenRequiredElements: false }, { noLeadingAnswerDisclosure: false }, { classificationMatchesSpokenDemand: false }]) {
    assert.throws(() => validateBankQualityReviewCoverage([input], { questions: [{ ...keep, ...change }] }), /KEEP_CONTRACT_INCONSISTENT/u);
  }
  assert.throws(() => validateBankQualityReviewCoverage([input], { questions: [{ ...keep, disposition: 'revise_contract', proposedQuestion: '학생이 직접 한 행동을 설명해 주세요.' }] }), /CONTRACT_MUST_PRESERVE_UTTERANCE/u);
  assert.throws(() => validateBankQualityReviewCoverage([input], { questions: [{ ...keep, disposition: 'rewrite_question', proposedQuestion: '관심을 가진 이유와 방법을 모두 말해 주세요.', preservesVerificationPurpose: false }] }), /REWRITE_PURPOSE_UNAPPROVED/u);
});

test('review inputs preserve exact record spans and reject a forged bank question hash or citation', () => {
  const source = '친구들과 자료를 조사하고 각자의 의견을 모아 발표했다.';
  const context = { student: { evidence: [{ id: 'source-a', text: source }] } } as unknown as InterviewContext;
  const candidate = { id: 'candidate-a', questionSha256: createHash('sha256').update(input.questionText).digest('hex'), draft: { ...input, evidenceQuotes: [{ evidenceId: 'source-a', quote: '자료를 조사하고 각자의 의견을 모아 발표했다.' }] } };
  const bank = { plan: { slots: [{ id: 'slot-a', objective: { id: 'purpose-a', requiresOpenCheck: true } }] }, slots: [{ slotId: 'slot-a', candidates: [candidate] }] } as unknown as PreparedQuestionBank;
  const result = buildBankQualityReviewRows(context, bank);
  assert.equal(source.slice(result[0].sourceQuotes[0].start, result[0].sourceQuotes[0].end), result[0].sourceQuotes[0].quote);
  assert.equal(result[0].sourceQuotes[0].sourceSha256, createHash('sha256').update(source).digest('hex'));
  const altered = structuredClone(bank); altered.slots[0].candidates[0].draft.questionText = '본인이 전체 과정을 주도한 방법은 무엇인가요?';
  assert.throws(() => buildBankQualityReviewRows(context, altered), /UTTERANCE_HASH_MISMATCH/u);
  const invented = structuredClone(bank); invented.slots[0].candidates[0].draft.evidenceQuotes[0].quote = '전체 과정을 혼자 주도했다.';
  assert.throws(() => buildBankQualityReviewRows(context, invented), /SOURCE_QUOTE_MISMATCH/u);
});

test('the bounded offline review receives exact applicable MD articles instead of unmarked paraphrases or case answers', () => {
  const context = { fullMdPolicyOriginals: { documents: [{ role: 'operatingGuidelines', sha256: 'a'.repeat(64), text: '안내\n### 제10조 (표현)\n같은 의도를 유지한다.\n### 제30조 (다른 단계)\n숨은 예제 답변' }, { role: 'questionGuidelines', sha256: 'b'.repeat(64), text: '### 제5조 (최소 단위)\n하나의 평가 목적을 둔다.\n### 제24조 (중복)\n요구 의미로 판단한다.\n### 제99조 (예제)\n가상 학생의 정답' }] } } as unknown as InterviewContext;
  const result = selectedQuestionReviewMd(context);
  assert.match(result[0].text, /같은 의도를 유지한다/u); assert.match(result[1].text, /하나의 평가 목적/u);
  assert.doesNotMatch(result.map(row => row.text).join('\n'), /숨은 예제 답변|가상 학생의 정답/u);
});
