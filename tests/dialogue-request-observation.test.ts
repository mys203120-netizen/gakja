import test from 'node:test';
import assert from 'node:assert/strict';
import { observePureDialogueRequest } from '../server/providers/dialogue-request-observation';

test('pure polite re-listening requests preserve exact full-transcript source span', () => {
  for (const raw of ['죄송하지만질문을 한 번만 다시 말씀해 주시겠어요.', '질문을 다시 들려주세요.', '다시 한번 말씀해 주실 수 있을까요?', '방금 질문이 잘 안 들렸습니다. 다시 들려주세요.']) {
    const observed = observePureDialogueRequest(raw);
    assert.equal(observed?.kind, 'repeat_audio', raw);
    assert.equal(observed?.sourceStartOffset, 0);
    assert.equal(observed?.sourceEndOffset, raw.length);
    assert.equal(raw.slice(observed!.sourceStartOffset, observed!.sourceEndOffset), raw);
  }
});

test('pure meaning requests include embedded interrogative topics without requiring a specific activity name', () => {
  for (const raw of ['질문이 무슨 뜻인가요?', '질문을 다시 설명해 주세요.', '질문이 무슨 뜻인지 쉽게 설명해 주시겠어요?', '질문의 뜻을 좀 더 쉽게 설명해 주시겠어요?', '주 활동이 어떻게 연결된 관심사라는 뜻인지 쉽게 설명해 주실 수 있을까요.', '두 경험이 어떤 관련이 있다는 뜻인지 설명해 주세요.', '질문이 잘 이해가 안 됩니다. 질문을 쉽게 설명해 주세요.']) {
    assert.equal(observePureDialogueRequest(raw)?.kind, 'explain_question', raw);
  }
});

test('mixed factual answers and requests are never collapsed into a fast-path dialogue command', () => {
  for (const raw of ['자료는 작성 시점으로 비교했습니다. 질문을 다시 들려주세요.', '제가 혼자 정리했는데 질문이 무슨 뜻인가요?', '조건은 기억나지 않지만 질문을 쉽게 설명해 주세요.', '연결된 관심사는 없었습니다. 질문을 다시 들려주세요.', '활동은 제가 한 것이라는 뜻인지 쉽게 설명해 주세요.']) {
    assert.equal(observePureDialogueRequest(raw), null, raw);
  }
});

test('cannot recall, negated commands, quoted speech and reported requests stay with the semantic core', () => {
  for (const raw of ['모르겠습니다.', '기억나지 않습니다.', '질문을 다시 들려주시지 않아도 됩니다.', '다시 들려주지 마세요.', '“질문을 다시 들려주세요”라고 친구에게 말했습니다.', '질문을 다시 들려주세요라고 말한 적은 없습니다.', '질문을 다시 들려주세요라는 문장을 읽었습니다.', '다시 설명하는 방법을 선택했습니다.']) {
    assert.equal(observePureDialogueRequest(raw), null, raw);
  }
});

test('non-request text, oversized input and incomplete recognition are not guessed into requests', () => {
  for (const raw of ['', '  ', '주 활동이 어떻게 연결된 관심사을까요 ', '이온의 뜻을 정의했습니다.', '질문을 다음에 드리겠습니다.', 'x'.repeat(401)]) assert.equal(observePureDialogueRequest(raw), null, raw);
});
