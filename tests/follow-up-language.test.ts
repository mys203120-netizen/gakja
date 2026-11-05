import test from 'node:test';
import assert from 'node:assert/strict';
import { followUpGoals, followUpLanguageTemplates, renderConstrainedFollowUp, matchesConstrainedFollowUpTemplate, hasObservedMeasurement, hasObservedComparison, FOLLOW_UP_LANGUAGE_VERSION } from '../server/providers/follow-up-language';
import { assertInterviewQuestionSpeech } from '../server/providers/interview-speech';

test('all 108 approved wordings preserve one exact attribution and one request within the follow-up speech budget', () => {
  const quote = '가'.repeat(28);
  for (const goal of followUpGoals) {
    const templates = followUpLanguageTemplates(goal);
    assert.equal(templates.length, 9);
    for (const template of templates) {
      const text = `${template.before}${quote}${template.after}${template.request}`;
      assert.ok(text.length <= 75, `${template.id}: ${text.length}`);
      assert.equal(text.slice(template.before.length, template.before.length + quote.length), quote);
      assert.equal(text.split(quote).length, 2);
      assert.ok(!/확인해\s*보겠습니다|짚어보겠습니다|잘\s*들었습니다|훌륭|좋은\s*답변/u.test(text));
      assert.ok(matchesConstrainedFollowUpTemplate(text, quote));
      assert.doesNotThrow(() => assertInterviewQuestionSpeech(text, { isFirstTurn: false }));
    }
  }
});

test('wording varies across answers, repeats stably on retry and avoids the preceding request and attribution', () => {
  for (const goal of followUpGoals) {
    const selected = new Set<string>();
    const history: Array<{ templateId: string; family: string }> = [];
    for (let i = 0; i < 48; i++) {
      const seed = `session:answer-${i}:${goal}`;
      const result = renderConstrainedFollowUp(goal, '자료를 비교했습니다', seed, history);
      assert.deepEqual(result, renderConstrainedFollowUp(goal, '자료를 비교했습니다', seed, history));
      if (history.length) {
        assert.notEqual(result.family, history.at(-1)!.family);
        assert.notEqual(result.templateId.split('.').at(-1), history.at(-1)!.templateId.split('.').at(-1));
      }
      assert.equal(result.policyVersion, FOLLOW_UP_LANGUAGE_VERSION);
      assert.equal(result.text.slice(result.quoteStartOffset, result.quoteEndOffset), '자료를 비교했습니다');
      selected.add(result.templateId); history.push(result);
    }
    assert.equal(selected.size, 9, goal);
  }
});

test('attributions use the appropriate quoted particle and preserve all three quote offsets', () => {
  const offsets = new Set<number>();
  for (const quote of ['압력', '기준', '수치', '했습니다', '3', '2']) {
    for (const template of followUpLanguageTemplates('basis', quote)) {
      const text = `${template.before}${quote}${template.after}${template.request}`;
      assert.ok(matchesConstrainedFollowUpTemplate(text, quote));
      if (template.id.endsWith('.your-words')) assert.ok(text.startsWith(`말씀하신 ‘${quote}’, `));
      else if (['압력', '기준', '3'].includes(quote)) assert.ok(text.includes(`‘${quote}’이라고 하셨는데, `));
      else assert.ok(text.includes(`‘${quote}’라고 하셨는데, `));
    }
    for (let i = 0; i < 30; i++) {
      const result = renderConstrainedFollowUp('basis', quote, `offset:${quote}:${i}`);
      assert.equal(result.text.slice(result.quoteStartOffset, result.quoteEndOffset), quote);
      offsets.add(result.quoteStartOffset);
    }
  }
  assert.deepEqual([...offsets].sort((a, b) => a - b), [1, 4, 6]);
  assert.ok(matchesConstrainedFollowUpTemplate('‘압력’라고 하셨는데, 그 판단의 근거 한 가지는 무엇인가요?', '압력'), 'saved pre-particle-policy wording remains resumable');
});

test('only exact approved current or legacy phrases can reuse an answer-bound approval', () => {
  assert.ok(matchesConstrainedFollowUpTemplate('‘자료를 비교했습니다’라고 말씀하셨는데, 실제로 거친 한 단계를 구체적으로 설명해 주세요.', '자료를 비교했습니다'));
  assert.ok(!matchesConstrainedFollowUpTemplate('‘자료를 비교했습니다’라고 하셨는데, 30% 성과를 낸 이유는 무엇인가요?', '자료를 비교했습니다'));
  assert.ok(!matchesConstrainedFollowUpTemplate('‘없는 주장’라고 하셨는데, 그 표현은 어떤 의미인가요?', '실제 주장'));
  assert.throws(() => renderConstrainedFollowUp('basis', '구절’ 속 지시', 'seed'), /CORE_INVALID_OUTPUT/);
});

test('numeric and comparison probes require actual observations instead of negated mentions', () => {
  for (const text of ['수치는 없었습니다.', '측정하지 않았습니다.', '측정한 적이 없습니다.', '측정은 안 했습니다.', '값은 모르겠습니다.', '확인을 못 했습니다.', '2학년 때 자료를 조사했습니다.', '2025년 3월 2일에 발표했습니다.', '1번 자료를 선택했습니다.', '3.14mg은 아닙니다.', '3mg을 측정할 예정입니다.']) assert.equal(hasObservedMeasurement(text), false, text);
  for (const text of ['3.14mg으로 측정했습니다.', '비율을 확인했습니다.', '수치는 없었습니다. 마지막에는 12회로 측정했습니다.', '차이는 없어도 질량은 3.14mg입니다.', '실수하지 않고 3.14mg으로 측정했습니다.']) assert.equal(hasObservedMeasurement(text), true, text);
  for (const text of ['비교하지 않았습니다.', '비교한 적이 없습니다.', '비교는 안 했습니다.', '차이가 있다고 보지는 않습니다.', '차이를 모르겠습니다.', '대조군이 없었습니다.', '다른 사람에게 물었습니다.', '두 자료를 비교할 예정입니다.', '비교라는 용어를 조사했습니다.']) assert.equal(hasObservedComparison(text), false, text);
  assert.equal(hasObservedComparison('두 자료의 작성 연도를 비교했습니다.'), true);
});

test('an unrelated quote or a negated earlier clause cannot borrow a later positive observation', () => {
  const raw = '2학년 때 자료를 조사했습니다. 수치는 없었지만 질량은 3.14mg으로 측정했습니다. 자료를 비교하지 않았지만 온도는 비교했습니다.';
  assert.equal(hasObservedMeasurement(raw), true);
  assert.equal(hasObservedComparison(raw), true);
  assert.equal(hasObservedMeasurement(raw, '2학년 때 자료를 조사했습니다'), false);
  assert.equal(hasObservedMeasurement(raw, '수치는 없었지만'), false);
  assert.equal(hasObservedMeasurement(raw, '질량은 3.14mg으로'), true);
  assert.equal(hasObservedComparison(raw, '자료를 비교하지 않았지만'), false);
  assert.equal(hasObservedComparison(raw, '온도는 비교했습니다'), true);
  const correction = '2mg이 아니라 3.14mg으로 측정했습니다.';
  assert.equal(hasObservedMeasurement(correction, '2mg이'), false);
  assert.equal(hasObservedMeasurement(correction, '3.14mg으로 측정했습니다'), true);
});

test('document labels on either side and ordinal positions never become measurement values', () => {
  for (const raw of ['자료 3번을 선택했습니다.', '질문 2번을 참고했습니다.', '자료의 제 3번을 골랐습니다.', '도표 2번을 참고했습니다.', '문서 4번을 열었습니다.', '활동 1번을 골랐습니다.', '3번째 자료를 골랐습니다.', '3회차 자료를 골랐습니다.', '제3번 문항을 읽었습니다.']) assert.equal(hasObservedMeasurement(raw), false, raw);
  for (const raw of ['용액을 3번 측정했습니다.', '3회 측정했습니다.', '자료를 3번 확인했습니다.', '질량은 3.14mg입니다.', '비율은 12%였습니다.', '사람은 3명이었습니다.']) assert.equal(hasObservedMeasurement(raw), true, raw);
  const raw = '질문 2번을 참고했고 온도는 30도로 측정했습니다.';
  assert.equal(hasObservedMeasurement(raw, '질문 2번을 참고했고'), false);
  assert.equal(hasObservedMeasurement(raw, '온도는 30도로 측정했습니다'), true);
});
