import test from 'node:test';
import assert from 'node:assert/strict';
import {appendStudentSentence,speakingLayouts,sameTranscriptWords,speakingSuggestions,isSafeSpeakingSuggestion} from '../apps/web/src/lib/practice-writing';
test('every speaking option preserves original numbers, negation, uncertain claims and repeated words',()=>{
  const original='저는 30명이 아니라 3명과 했습니다. 아마 2.5%였고, 제가 제가 직접 확인하지 못했습니다. 결과는 아직 몰라요.';
  const options=speakingLayouts(original);assert.equal(options.length,3);
  for(const option of options){assert.equal(sameTranscriptWords(original,option.text),true);assert.match(option.text,/2\.5%/);assert.match(option.text,/제가\s+제가/);assert.match(option.text,/확인하지\s+못했습니다/);}
  assert.equal(sameTranscriptWords(original,original.replace('3명','30명')),false);
});
test('direction application appends only student supplied facts while preserving the original',()=>{
  const original='제가 한 일은 설문 정리였어요.\n수상한 적은 없어요.';
  assert.equal(appendStudentSentence(original,'응답 3개를 다시 확인했어요.'),original+'\n\n응답 3개를 다시 확인했어요.');
});
test('tone alternatives change only known sentence endings, retain uncertainty and reject invented facts',()=>{
  const original='저는 3명과 했어요. 성공한 건 아니에요. 아마 2.5%인 것 같아요. 결과는 몰라요.';
  const options=speakingSuggestions(original);assert.equal(options.length,3);
  assert.match(options[1].text,/3명과 했습니다/);assert.match(options[1].text,/성공한 건 아닙니다/);assert.match(options[1].text,/아마 2\.5%인 것 같습니다/);assert.match(options[1].text,/결과는 모릅니다/);
  assert.equal(isSafeSpeakingSuggestion(original,options[1].text),true);assert.equal(isSafeSpeakingSuggestion(original,options[1].text.replace('3명','30명')),false);assert.equal(isSafeSpeakingSuggestion(original,options[1].text.replace('아닙니다','맞습니다')),false);
  assert.equal(speakingSuggestions('상대가 “했다.”라고 말한 것은 아니에요.')[1].text,'상대가 “했다.”라고 말한 것은 아닙니다.');
});
