import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSpeechMetrics } from '../lib/interview/speech-metrics';
import { observeSpeechHabits } from '../lib/interview/speech-habits';
import { ActiveClock, shouldSubmitSpace } from '../lib/interview/timing';

test('CPM threshold boundaries and observed speech rate use different denominators',()=>{
  for(const [characters,pace] of [[299,'slow'],[300,'reference_range'],[350,'reference_range'],[351,'fast']] as const) {
    const result=calculateSpeechMetrics({rawTranscript:'가'.repeat(characters),durationMs:60000,speakingMs:30000,firstSpeechMs:1000});
    assert.equal(result.cpm,characters); assert.equal(result.pace,pace); assert.equal(result.speakingCpm,characters*2);
  }
});
test('missing VAD, zero/invalid duration, empty and insufficient answers remain unavailable',()=>{
  for(const durationMs of [0,-10,NaN,Infinity]) assert.equal(calculateSpeechMetrics({rawTranscript:'가'.repeat(100),durationMs,speakingMs:null,firstSpeechMs:null}).cpm,null);
  assert.equal(calculateSpeechMetrics({rawTranscript:'',durationMs:10000,speakingMs:0,firstSpeechMs:null}).pace,null);
  const short=calculateSpeechMetrics({rawTranscript:'가'.repeat(100),durationMs:1000,speakingMs:null,firstSpeechMs:null});
  assert.equal(short.cpm,null); assert.equal(short.speakingCpm,null); assert.equal(short.silenceMs,null);
});
test('characters include digits and Latin, but syllable approximation counts Korean only',()=>{
  const result=calculateSpeechMetrics({rawTranscript:'가나다 ABC 123! 라마바',durationMs:60000,speakingMs:null,firstSpeechMs:null});
  assert.equal(result.characterCount,12);assert.equal(result.hangulSyllableCount,6);assert.equal(result.eojeolCount,4);
});
test('habits preserve source spans and never count substrings of ordinary words',()=>{
  const raw='어, 음 어려운 음식 그 활동 이제 다음 단계 저기에서 어어 약간';
  const observed=observeSpeechHabits('a1',raw,60000);
  assert.equal(observed.confirmedCount,2);
  assert.deepEqual(observed.occurrences.map(o=>o.surface),['어','음','그','이제','어어','약간']);
  for(const o of observed.occurrences) assert.equal(raw.slice(o.start,o.end),o.surface);
  assert.deepEqual(observed,observeSpeechHabits('a1',raw,60000));
  assert.equal(observeSpeechHabits('a1','어',60000).occurrences.length,1);
});
test('pause/resume retains answer and excludes all suspended time',()=>{
  const clock=new ActiveClock();clock.start(100);clock.pause(1100);clock.pause(6000);clock.start(10000);clock.start(11000);
  assert.equal(clock.elapsed(12000),3000);clock.pause(12000);assert.equal(clock.elapsed(20000),3000);
});
test('Space rejects repeats, composition, editable targets, and non-listening phases',()=>{
  const event={code:'Space',repeat:false,isComposing:false,target:null};
  assert.equal(shouldSubmitSpace(event,'listening'),true);
  for(const phase of ['preparing','speaking_question','suspended','finalizing_transcript']) assert.equal(shouldSubmitSpace(event,phase),false);
  assert.equal(shouldSubmitSpace({...event,repeat:true},'listening'),false);
  assert.equal(shouldSubmitSpace({...event,isComposing:true},'listening'),false);
  assert.equal(shouldSubmitSpace({...event,target:{tagName:'TEXTAREA'} as unknown as EventTarget},'listening'),false);
});
