import test from 'node:test';
import assert from 'node:assert/strict';
import { clovaStreamingConfiguration, currentQuestionVocabulary, STREAMING_VOCABULARY_POLICY } from '../server/providers/speech-vocabulary';
import type { InterviewContext } from '../server/data/load-interview-context';

test('streaming vocabulary uses only the current question and linked evidence', () => {
  const context = { student: { evidence: [{ id: 'e1', text: '변곡점과 신뢰구간을 탐구함. DNA 메틸화' }, { id: 'e2', text: 'PRIVATE_OTHER_ACTIVITY' }] } } as unknown as InterviewContext;
  const words = currentQuestionVocabulary(context, { questionText: '신뢰구간은 어떤 방법으로 계산했나요?', evidenceIds: ['e1'] });
  assert.ok(words.includes('변곡점')); assert.ok(words.includes('신뢰구간')); assert.ok(words.includes('DNA'));
  assert.equal(words.includes('PRIVATE_OTHER_ACTIVITY'), false);
  const config = clovaStreamingConfiguration(words);
  assert.equal(config.transcription.language, 'ko');
  assert.ok(config.keywordBoosting!.boostings[0].words.includes('변곡점'));
  assert.equal('boostingIDs' in config.keywordBoosting!, false); assert.equal('domainId' in config, false);
});
test('direct keywords are bounded and comma-safe, without changing returned transcripts', () => {
  const config = clovaStreamingConfiguration(['변곡점', '변곡점', ' bad,word ', '신뢰구간', ...Array.from({ length: 100 }, (_, i) => `X${i}`)]);
  const boost = config.keywordBoosting!.boostings[0];
  assert.equal(boost.words.split(',').length, STREAMING_VOCABULARY_POLICY.maxTerms); assert.equal(boost.words.includes('bad'), false);
  assert.ok(boost.weight <= 0.3);
  assert.equal('keywordBoosting' in clovaStreamingConfiguration(), false);
});

test('source phrases and broken OCR stems are not acoustic keyword hints', () => {
  const context = { student: { evidence: [{ id: 'e1', text: '학우들이 제작한 버추얼 시티의 역할을 완벽히 수행해내고 관심사였다면 이어졌나요. 암모니아 크래킹과 열역학을 탐구해 발표함.' }] } } as unknown as InterviewContext;
  const words = currentQuestionVocabulary(context, { questionText: '두 활동의 연결을 쉽게 설명해 주세요.', evidenceIds: ['e1'] });
  assert.ok(words.includes('암모니아')); assert.ok(words.includes('열역학'));
  for (const bad of ['관심사였다면','이어졌나요','학우들','시티의','역할','완벽히','탐구해','발표함']) assert.ok(!words.includes(bad));
  assert.equal('keywordBoosting' in clovaStreamingConfiguration(['쉽게','설명','관심사였다면']), false);
});
