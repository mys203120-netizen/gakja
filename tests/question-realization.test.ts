import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { availableQuestionOperations, assertQuestionAnchorBinding, assertRenderedQuestionIntegrity, buildQuestionAnchorCandidates, questionAnchorProjection, questionIRWireSchema, questionOperations, renderQuestionIR, restoreQuestionIR, type QuestionIR } from '../server/providers/question-realization';
import { assertInterviewQuestionSpeech } from '../server/providers/interview-speech';

function fixture(raw = '자료의 작성 시점을 비교했습니다. 온도는 12도로 측정했습니다.') {
  const anchors = buildQuestionAnchorCandidates({ turnId: 'turn-0', answerId: 'answer-0', rawTranscript: raw, quoteOptions: ['자료의 작성 시점을 비교했습니다', '온도는 12도로 측정했습니다'] });
  return { raw, anchors, seed: 'test-seed' };
}

test('IR anchors are exact source-bound server candidates and no hidden source text is sent in the model projection', () => {
  const setup = fixture();
  assert.equal(setup.anchors.length, 2);
  for (const anchor of setup.anchors) {
    assert.ok(Object.isFrozen(anchor));
    assert.equal(setup.raw.slice(anchor.start, anchor.end), anchor.quote);
    assert.equal(assertQuestionAnchorBinding(anchor), setup.raw);
    assert.throws(() => assertQuestionAnchorBinding({ ...anchor }), /IR_SOURCE_INVALID/, 'serialized claims are not source approval');
  }
  assert.deepEqual(Object.keys(questionAnchorProjection(setup.anchors)[0]), ['id', 'sourceId', 'quote']);
  assert.equal(JSON.stringify(setup.anchors).includes('rawTranscript'), false);
  assert.deepEqual(buildQuestionAnchorCandidates({ turnId: 't', answerId: 'a', rawTranscript: '실제 발화입니다.', quoteOptions: ['없는 주장', '같은', '실제 발화입니다'] }).map(anchor => anchor.quote), ['실제 발화입니다']);
});

test('omitted spoken quotes retain exact internal proof without inventing spoken quote offsets', () => {
  const setup = fixture();
  const result = renderQuestionIR({ operation: 'evidence_verification', anchorId: setup.anchors[0].id, anchorMode: 'none', secondaryAnchorId: null }, setup);
  assert.equal(result.questionText.includes(setup.anchors[0].quote), false);
  assert.equal(result.proof.length, 0);
  assert.equal(result.anchorProof.length, 1);
  assert.equal(result.anchorProof[0].questionStartOffset, null);
  assert.equal(result.anchorProof[0].sourceStartOffset, setup.anchors[0].start);
  assert.equal(result.validation.independentSemanticReview, false);
  assert.doesNotThrow(() => assertRenderedQuestionIntegrity(result));
});

test('all speakable strategies have single-request polite forms and exact quote proof stays within speech budget', () => {
  const setup = fixture();
  const prior = buildQuestionAnchorCandidates({ turnId: 'turn-old', answerId: 'answer-old', rawTranscript: '작성 연도를 보지 않았습니다.', quoteOptions: ['작성 연도를 보지 않았습니다'] });
  const anchors = [...setup.anchors, ...prior];
  const contradictionPairs = [[setup.anchors[0].id, prior[0].id] as const];
  for (const operation of questionOperations) {
    const anchor = operation === 'numeric_verification' ? setup.anchors[1] : setup.anchors[0];
    for (const anchorMode of ['none', 'short_context', 'exact_quote'] as const) {
      const ir = { operation, anchorId: anchor.id, anchorMode, secondaryAnchorId: operation === 'contradiction' ? prior[0].id : null };
      const result = renderQuestionIR(ir, { anchors, contradictionPairs, seed: `${operation}:${anchorMode}` });
      assert.ok([...result.questionText].length <= 75, result.questionText);
      assert.equal((result.questionText.match(/[?？]/gu) ?? []).length <= 1, true, result.questionText);
      assert.equal(result.targetEvidence.length, 1);
      assert.ok(!/맡은|성공|잘\s*들었습니다|확인해\s*보겠습니다|안녕하세요/u.test(result.questionText), result.questionText);
      assert.doesNotThrow(() => assertInterviewQuestionSpeech(result.questionText, { isFirstTurn: false }));
      if (anchorMode === 'exact_quote') {
        const proof = result.proof[0];
        assert.equal(result.questionText.slice(proof.questionStartOffset, proof.questionEndOffset), anchor.quote);
        assert.equal(setup.raw.slice(proof.sourceStartOffset, proof.sourceEndOffset), anchor.quote);
      }
    }
  }
});

test('measurement and comparison operations cannot borrow a different clause or a negated observation', () => {
  const setup = fixture();
  const schema = questionIRWireSchema(setup.anchors);
  assert.equal(schema.safeParse({ operation: 'numeric_verification', anchorId: setup.anchors[0].id, anchorMode: 'none', secondaryAnchorId: null }).success, false);
  assert.equal(schema.safeParse({ operation: 'comparison', anchorId: setup.anchors[1].id, anchorMode: 'none', secondaryAnchorId: null }).success, false);
  const anchors = buildQuestionAnchorCandidates({ turnId: 't', answerId: 'a', rawTranscript: '수치는 없었고 비교하지 않았습니다.', quoteOptions: ['수치는 없었고 비교하지 않았습니다'] });
  const operations = availableQuestionOperations(anchors);
  assert.equal(operations.includes('numeric_verification'), false);
  assert.equal(operations.includes('comparison'), false);
  assert.equal(operations.includes('answer_anchor'), true);
  for (const raw of ['자료 3번을 선택했습니다.', '3번째 자료를 골랐습니다.', '질문 2번을 참고했습니다.']) {
    const ids = buildQuestionAnchorCandidates({ turnId: 't', answerId: 'a', rawTranscript: raw, quoteOptions: [raw.replace(/[.]$/u, '')] });
    assert.equal(availableQuestionOperations(ids).includes('numeric_verification'), false, raw);
  }
});

test('contradiction requires two actual bound anchors and a server supplied pair; secondary slots cannot inject facts', () => {
  const setup = fixture();
  assert.equal(availableQuestionOperations(setup.anchors).includes('contradiction'), false);
  const pair = [setup.anchors[0].id, setup.anchors[1].id] as const;
  const schema = questionIRWireSchema(setup.anchors, { contradictionPairs: [pair] });
  assert.equal(schema.safeParse({ operation: 'contradiction', anchorId: pair[0], secondaryAnchorId: pair[1], anchorMode: 'none' }).success, true);
  assert.equal(schema.safeParse({ operation: 'contradiction', anchorId: pair[0], secondaryAnchorId: 'new-fiction', anchorMode: 'none' }).success, false);
  assert.equal(schema.safeParse({ operation: 'answer_anchor', anchorId: pair[0], secondaryAnchorId: pair[1], anchorMode: 'none' }).success, false);
  assert.equal(schema.safeParse({ operation: 'answer_anchor', anchorId: pair[0], secondaryAnchorId: null, anchorMode: 'none', freeSentence: '성과를 냈다고 하셨는데' }).success, false);
});

test('same-cluster prior answers may support a secondary pair but never replace the actual latest answer anchor', () => {
  const setup = fixture();
  const prior = buildQuestionAnchorCandidates({ turnId: 'prior-turn', answerId: 'prior-answer', rawTranscript: '결과는 9도로 측정했습니다.', quoteOptions: ['결과는 9도로 측정했습니다'] });
  const anchors = [...setup.anchors, ...prior];
  const schema = questionIRWireSchema(anchors, { primaryTurnId: 'turn-0', contradictionPairs: [[setup.anchors[1].id, prior[0].id], [prior[0].id, setup.anchors[1].id]] });
  assert.equal(schema.safeParse({ operation: 'numeric_verification', anchorId: prior[0].id, anchorMode: 'none', secondaryAnchorId: null }).success, false);
  assert.equal(schema.safeParse({ operation: 'contradiction', anchorId: setup.anchors[1].id, anchorMode: 'none', secondaryAnchorId: prior[0].id }).success, true);
  assert.equal(schema.safeParse({ operation: 'contradiction', anchorId: prior[0].id, anchorMode: 'none', secondaryAnchorId: setup.anchors[1].id }).success, false);
});

test('grouped contradiction schema preserves exact allowed pairs rather than accepting a union cross-product', () => {
  const current = buildQuestionAnchorCandidates({ turnId: 'current', answerId: 'now', rawTranscript: '첫째 설명입니다. 둘째 설명입니다.', quoteOptions: ['첫째 설명입니다', '둘째 설명입니다'] });
  const prior = buildQuestionAnchorCandidates({ turnId: 'prior', answerId: 'then', rawTranscript: '이전 첫 설명입니다. 이전 둘 설명입니다.', quoteOptions: ['이전 첫 설명입니다', '이전 둘 설명입니다'] });
  const pairs = [[current[0].id, prior[0].id], [current[0].id, prior[1].id], [current[1].id, prior[1].id]] as const;
  const schema = questionIRWireSchema([...current, ...prior], { primaryTurnId: 'current', allowedOperations: ['contradiction', 'answer_anchor'], contradictionPairs: pairs });
  for (const first of current) for (const second of prior) {
    const expected = pairs.some(([a, b]) => a === first.id && b === second.id);
    assert.equal(schema.safeParse({ operation: 'contradiction', anchorId: first.id, anchorMode: 'none', secondaryAnchorId: second.id }).success, expected);
  }
  const wire = JSON.parse(JSON.stringify(zodTextFormat(z.object({ questionIR: schema }), 'grouped_question_ir').schema));
  assert.equal(wire.properties.questionIR.anyOf.length, 3, 'two primary-source branches plus the ordinary operation branch');
});

test('large actual-statement pair sets expand schema by primary anchors rather than every permitted pair', () => {
  const currentQuotes = Array.from({ length: 16 }, (_, index) => `현재 설명 ${index}입니다`), priorQuotes = Array.from({ length: 6 }, (_, index) => `이전 설명 ${index}입니다`);
  const current = buildQuestionAnchorCandidates({ turnId: 'current', answerId: 'now', rawTranscript: currentQuotes.join('. '), quoteOptions: currentQuotes });
  const prior = buildQuestionAnchorCandidates({ turnId: 'prior', answerId: 'then', rawTranscript: priorQuotes.join('. '), quoteOptions: priorQuotes });
  const pairs = current.flatMap(first => prior.map(second => [first.id, second.id] as const));
  assert.equal(pairs.length, 96);
  const schema = questionIRWireSchema([...current, ...prior], { primaryTurnId: 'current', allowedOperations: ['contradiction'], contradictionPairs: pairs });
  const wire = JSON.parse(JSON.stringify(zodTextFormat(z.object({ questionIR: schema }), 'bounded_question_ir').schema));
  assert.equal(wire.properties.questionIR.anyOf.length, 16, 'the 96 actual pairs require only sixteen bounded primary-source branches');
  for (const [anchorId, secondaryAnchorId] of pairs) assert.equal(schema.safeParse({ operation: 'contradiction', anchorId, anchorMode: 'none', secondaryAnchorId }).success, true);
});

test('question wording varies by stable seed and recent sentence family without changing the selected operation', () => {
  const setup = fixture(), history: Array<{ templateId: string; family: string }> = [], selected = new Set<string>();
  const ir: QuestionIR = { operation: 'own_action', anchorId: setup.anchors[0].id, secondaryAnchorId: null, anchorMode: 'none' };
  for (let index = 0; index < 18; index++) {
    const input = { ...setup, seed: `a-${index}`, history };
    const result = renderQuestionIR(ir, input);
    assert.deepEqual(result, renderQuestionIR(ir, input));
    if (history.length) assert.notEqual(result.family, history.at(-1)!.family);
    selected.add(result.templateId); history.push(result);
  }
  assert.equal(selected.size, 3);
});

test('tampered rendered requests and metadata do not inherit a source-bound approval', () => {
  const setup = fixture();
  const result = renderQuestionIR({ operation: 'process', anchorId: setup.anchors[0].id, anchorMode: 'none', secondaryAnchorId: null }, setup);
  const text = '성공한 실험의 수치를 설명해 주세요.';
  assert.throws(() => assertRenderedQuestionIntegrity({ ...result, questionText: text, validation: { ...result.validation, questionSha256: createHash('sha256').update(text).digest('hex') } }), /IR_SURFACE_INVALID/);
  assert.throws(() => assertRenderedQuestionIntegrity({ ...result, targetEvidence: ['원문에 없는 역할의 성공 이유'] }), /IR_SURFACE_INVALID/);
  assert.throws(() => assertRenderedQuestionIntegrity({ ...result, anchorProof: [{ ...result.anchorProof[0], sourceStartOffset: 999 }] }), /IR_SOURCE_INVALID/);
  assert.throws(() => assertRenderedQuestionIntegrity({ ...result, ir: { ...result.ir, anchorMode: 'fictional' as never } }), /IR_SURFACE_INVALID/);
});

test('saved IR speech restores its exact approved wording only after rebinding the original transcript', () => {
  const setup = fixture();
  const ir: QuestionIR = { operation: 'evidence_verification', anchorId: setup.anchors[0].id, anchorMode: 'none', secondaryAnchorId: null };
  const original = renderQuestionIR(ir, setup);
  const fresh = fixture();
  const restored = restoreQuestionIR(ir, { anchors: fresh.anchors, templateId: original.templateId, questionText: original.questionText });
  assert.equal(restored.questionText, original.questionText);
  assert.deepEqual(restored.anchorProof, original.anchorProof);
  assert.equal(restored.proof.length, 0);
  assert.throws(() => restoreQuestionIR(ir, { anchors: fresh.anchors, templateId: original.templateId, questionText: '새로운 성과 수치를 설명해 주세요.' }), /IR_SURFACE_INVALID/);
  assert.throws(() => restoreQuestionIR(ir, { anchors: fresh.anchors, templateId: 'unregistered-book-phrase', questionText: original.questionText }), /IR_SURFACE_INVALID/);
  const changed = buildQuestionAnchorCandidates({ turnId: 'turn-0', answerId: 'answer-0', rawTranscript: `${setup.raw} 수정되었습니다.`, quoteOptions: [setup.anchors[0].quote] });
  assert.throws(() => restoreQuestionIR(ir, { anchors: changed, templateId: original.templateId, questionText: original.questionText }), /IR_INVALID/);
});
