import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_POLICY_VERSION, identifyBridgeText, selectBridge, topicBridgeTexts } from '../server/providers/acknowledgement-phrases';
import { selectNonRepeatingTemplate, type UtteranceHistoryItem } from '../server/providers/utterance-variation';
import { verifyAcknowledgement } from '../server/providers/interview-speech';

test('seeded receipt variation has broad distribution and a stable retry result', () => {
  const counts = new Map<string, number>();
  for (let answer = 0; answer < 600; answer++) {
    const input = { kind: 'topic' as const, seed: `session:answer:${answer}`, quote: '온도 조건' };
    const chosen = selectBridge(input);
    assert.deepEqual(selectBridge(input), chosen);
    assert.equal(chosen.trace.policyVersion, BRIDGE_POLICY_VERSION);
    assert.equal(chosen.trace.selection, 'seeded_shuffle');
    counts.set(chosen.trace.templateId!, (counts.get(chosen.trace.templateId!) ?? 0) + 1);
    if (chosen.text) assert.ok(verifyAcknowledgement('온도 조건을 달리했습니다.', input.quote, chosen.text));
  }
  assert.equal(counts.size, 4);
  for (const count of counts.values()) assert.ok(count >= 70 && count <= 250, `Unexpected seeded-template distribution: ${count}`);
});

test('different answer keywords cannot disguise a repeated receipt sentence family', () => {
  const history: UtteranceHistoryItem[] = [];
  const seen = new Set<string>();
  for (let answer = 0; answer < 48; answer++) {
    const quote = `조건 ${answer}`;
    const selected = selectBridge({ kind: 'topic', seed: `session:${answer}`, quote, history });
    assert.notEqual(selected.trace.family, history.at(-1)?.family);
    seen.add(selected.trace.templateId!);
    if (selected.text) {
      assert.ok(verifyAcknowledgement(`${quote}을 설명했습니다.`, quote, selected.text));
      assert.deepEqual(identifyBridgeText(selected.text), { templateId: selected.trace.templateId, family: selected.trace.family });
    }
    history.push({ templateId: selected.trace.templateId!, family: selected.trace.family! });
  }
  assert.equal(seen.size, 4);
});

test('an already spoken exact topic sentence is excluded rather than echoing it or changing the quote', () => {
  const previousTexts = topicBridgeTexts('온도 조건');
  for (let answer = 0; answer < 20; answer++) {
    const selected = selectBridge({ kind: 'topic', seed: `answer:${answer}`, quote: '온도 조건', previousTexts });
    assert.equal(selected.text, null);
    assert.equal(selected.trace.templateId, 'topic-direct');
    assert.equal(selected.trace.suppressionReason, 'direct_transition');
  }
});

test('a silent direct turn cannot hide the last audible receipt family from selection', () => {
  const previousTexts = ['‘이전 조건’이라고 하셨군요.'];
  const history = [
    { templateId: 'topic-quoted', family: 'quoted-echo' },
    { templateId: 'topic-direct', family: 'direct' },
  ];
  for (let answer = 0; answer < 24; answer++) {
    const input = { kind: 'topic' as const, seed: `after-silence:${answer}`, quote: '온도 조건', history, previousTexts };
    const selected = selectBridge(input);
    assert.notEqual(selected.trace.family, 'quoted-echo');
    assert.deepEqual(selectBridge(input), selected);
    if (selected.text) assert.ok(verifyAcknowledgement('온도 조건을 비교했습니다.', '온도 조건', selected.text, previousTexts));
  }
});

test('a shuffle bag uses every available unique family before recycling and rejects duplicate IDs', () => {
  const candidates = ['a', 'b', 'c', 'd'].map(id => ({ id, family: id }));
  const history: UtteranceHistoryItem[] = [];
  for (let cycle = 0; cycle < 6; cycle++) {
    const bag = new Set<string>();
    for (let answer = 0; answer < candidates.length; answer++) {
      const input = `answer:${cycle}:${answer}`;
      const chosen = selectNonRepeatingTemplate(candidates, input, history)!;
      assert.deepEqual(selectNonRepeatingTemplate(candidates, input, history), chosen);
      assert.notEqual(chosen.family, history.at(-1)?.family);
      bag.add(chosen.id); history.push({ templateId: chosen.id, family: chosen.family });
    }
    assert.equal(bag.size, candidates.length);
  }
  assert.throws(() => selectNonRepeatingTemplate([{ id: 'a', family: 'x' }, { id: 'a', family: 'y' }], 'answer'), /Duplicate utterance/u);
  assert.equal(selectNonRepeatingTemplate([], 'answer'), null);
});

test('optional topic receipt and its verifier share the unfinished-phrase boundary', () => {
  for (const quote of ['같은', '그리고', '실험을 통해', '차이를 알아보기 위해']) {
    const selected = selectBridge({ kind: 'topic', seed: 'source', quote });
    assert.equal(selected.text, null); assert.equal(selected.trace.suppressionReason, 'incomplete_topic_quote');
    for (const sentence of topicBridgeTexts(quote)) assert.equal(verifyAcknowledgement(`${quote} 다음 내용`, quote, sentence), null);
  }
  assert.equal(selectBridge({ kind: 'topic', seed: 'source', quote: null }).trace.suppressionReason, 'no_topic_quote');
  // A short concrete answer is a valid quotation; it is never discarded merely for being brief.
  assert.ok(verifyAcknowledgement('압력이요.', '압력', '네, ‘압력’ 말씀이군요.'));
});

test('Korean quotation particles follow the actual surface and preserve decimals', () => {
  for (const [quote, expected] of [['조건', '‘조건’이라고 하셨군요.'], ['차이', '‘차이’라고 하셨군요.'], ['3', '‘3’이라고 하셨군요.'], ['2', '‘2’라고 하셨군요.']]) {
    assert.ok(topicBridgeTexts(quote).includes(expected));
    assert.equal(identifyBridgeText(expected)?.family, 'quoted-echo');
  }
  for (const text of topicBridgeTexts('3.14mg')) assert.ok(verifyAcknowledgement('시료 3.14mg을 썼습니다.', '3.14mg', text));
});

test('silence, apology and transitions use separate non-evaluative pools; technical uncertainty has no candidate-blaming bridge', () => {
  const texts = new Set<string>();
  for (const kind of ['silence', 'apology', 'unclear', 'transition'] as const) {
    const history: UtteranceHistoryItem[] = [];
    const ids = new Set<string>();
    for (let answer = 0; answer < 30; answer++) {
      const selected = selectBridge({ kind, seed: `answer:${answer}`, history });
      assert.equal(selected.trace.kind, kind);
      assert.notEqual(selected.trace.family, history.at(-1)?.family);
      ids.add(selected.trace.templateId!);
      if (selected.text) {
        assert.doesNotMatch(selected.text, /잘 들었습니다|확인해보|짚어보|살펴보|훌륭|좋은 답변|점수|틀렸|정답|안녕|마이크|인식 오류|긴장/u);
        texts.add(selected.text);
      }
      history.push({ templateId: selected.trace.templateId!, family: selected.trace.family! });
    }
    assert.equal(ids.size, kind === 'transition' ? 4 : 3);
  }
  assert.equal(texts.size, 12);
  const technical = selectBridge({ kind: 'stt_retry', seed: 'answer' });
  assert.equal(technical.text, null); assert.equal(technical.trace.selection, 'suppressed');
  assert.equal(technical.trace.suppressionReason, 'technical_uncertainty');
});
