import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretTranscriptTerms } from '../server/providers/transcript-interpretation';

test('pronunciation hints retain exact raw spans and all negatives, quantities and uncertainty', () => {
  const raw = '시엔T를 넣은 맥신 전극입니다. 62%인지는 기억나지 않고 직접 측정하지 않았습니다.';
  const result = interpretTranscriptTerms(raw, ['CNT', 'MXene']);
  assert.equal(result.normalizedReading, 'CNT를 넣은 MXene 전극입니다. 62%인지는 기억나지 않고 직접 측정하지 않았습니다.');
  for (const reading of result.readings) assert.equal(raw.slice(reading.start, reading.end), reading.surface);
  assert.equal(result.rawTranscriptPreserved, true);
  assert.equal(raw, '시엔T를 넣은 맥신 전극입니다. 62%인지는 기억나지 않고 직접 측정하지 않았습니다.');
});
test('unknown context and ambiguous or omitted words are never inferred', () => {
  assert.deepEqual(interpretTranscriptTerms('시엔T를 넣었습니다.', []).readings, []);
  assert.equal(interpretTranscriptTerms('신 전극을 쓰지 않았고 신청방', ['CNT', 'MXene']).normalizedReading, '신 전극을 쓰지 않았고 신청방');
  assert.deepEqual(interpretTranscriptTerms('변맥신용어', ['MXene']).readings, []);
});
