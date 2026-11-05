import test from 'node:test';
import assert from 'node:assert/strict';
import { personalActionWitness } from '../server/providers/local-demand-witness';
import type { RecordedTurn } from '../server/protocol';
const fixture = (rawTranscript: string, questionText = '뉴스카드 제작과 양로원 안내 활동에서 본인이 직접 한 일이 있다면 무엇인가요?') => ({ questionText, rawTranscript, metadata: { primaryFunction: 'ROLE' } }) as RecordedTurn;
test('one actual personal action satisfies an undivided what-did-you-do demand without requiring every topic', () => {
  const turn = fixture('뉴스카드의 글자 크기를 조정하고 신청 안내 문구를 직접 고쳤습니다.');
  const proof = personalActionWitness(turn);
  assert.ok(proof); assert.equal(turn.rawTranscript!.slice(proof.start, proof.end), proof.quote);
});
test('generic team effort, another actor, reported speech, negation and unrelated actions never become met witnesses', () => {
  for (const raw of ['다 같이 열심히 뉴스카드를 만들었습니다.', '팀원이 직접 뉴스카드를 고쳤습니다.', '저는 팀원이 뉴스카드를 고쳤다고 들었습니다.', '뉴스카드를 직접 고치지 않았습니다.', '저는 라면 가게를 직접 만들었습니다.']) {
    assert.equal(personalActionWitness(fixture(raw)), null, raw);
  }
});
test('separately requested roles, reasons and comparisons retain semantic review rather than one-action shortcut', () => {
  for (const question of ['뉴스카드 제작과 양로원 안내에서 본인이 직접 한 일을 각각 말씀해 주세요.', '뉴스카드에서 본인이 맡은 역할을 선택한 이유는 무엇인가요?', '뉴스카드 제작에서 본인과 팀원의 역할을 비교해 주세요.']) {
    assert.equal(personalActionWitness(fixture('뉴스카드의 글자 크기를 직접 고쳤습니다.', question)), null);
  }
});
