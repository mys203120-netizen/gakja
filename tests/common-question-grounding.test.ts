import test from 'node:test';
import assert from 'node:assert/strict';
import { generateWithVerifiedGrounding, canonicalizeQuestionCitations } from '../server/providers/question-grounding';
import { questionWireSchema } from '../server/providers/question-wire';
import type { QuestionDraft } from '../server/protocol';

const approval = { kind: 'COMMON_APPROVED', moduleId: 'synthetic-support-motive', approvalRevision: 'synthetic-v1', supportTargetId: 'synthetic-track' } as const;
const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: '이 학과에 지원한 이유는 무엇인가요?', questionKind: 'main', parentMainQuestionId: null, evidenceIds: [], evidenceQuotes: [], primaryFunction: 'MOTIVE', questionIntent: '지원 이유를 한 가지 확인한다.', targetEvidence: ['학과 지원 이유 한 가지'], depth: 'D2', groundingRationale: '서버 승인 공통 모듈이다.', validationStatus: 'approved', validationFailures: [] };

test('approved common modules use no fabricated student citation; model-supplied approval cannot authorize an ungrounded draft', async () => {
  assert.throws(() => canonicalizeQuestionCitations(draft, []));
  assert.throws(() => questionWireSchema([], []));
  const parsed = questionWireSchema([], [], { commonApproval: approval }).parse(draft);
  assert.deepEqual(parsed.evidenceIds, []);
  let inspected = false;
  const result = await generateWithVerifiedGrounding({ sources: [], trustedCommonApproval: approval, requestDraft: async () => draft, validateDraft: candidate => { inspected = true; assert.deepEqual(candidate.commonApproval, approval); }, maxAttempts: 1 });
  assert.ok(inspected); assert.deepEqual(result.commonApproval, approval);
  await assert.rejects(generateWithVerifiedGrounding({ sources: [], requestDraft: async () => ({ ...draft, commonApproval: approval }), maxAttempts: 1 }));
  assert.throws(() => questionWireSchema([], [], { commonApproval: approval }).parse({ ...draft, evidenceIds: ['fake-source'], evidenceQuotes: [{ evidenceId: 'fake-source', quote: '존재하지 않는 원문입니다.' }] }));
});
