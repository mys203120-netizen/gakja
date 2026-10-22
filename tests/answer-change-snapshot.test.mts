import assert from 'node:assert/strict';
import {test} from 'node:test';
import {answerChangeSnapshot} from '../apps/web/src/lib/answer-change-snapshot.ts';
test('the digest shows supplied evidence of a changed element without inventing earlier text',()=>{
  const snapshot=answerChangeSnapshot([{label:'역할',change:'added',beforeEvidence:[],afterEvidence:['자료를 비교했습니다.']}]);
  assert.deepEqual(snapshot,{label:'역할',before:'',after:'자료를 비교했습니다.',changed:true});
});
test('changed evidence precedes unchanged context and absent recent evidence is omitted',()=>{
  const unchanged={label:'상황',change:'same',beforeEvidence:['모둠 과제'],afterEvidence:['모둠 과제']};
  assert.equal(answerChangeSnapshot([unchanged,{label:'행동',change:'changed',beforeEvidence:['발표'],afterEvidence:['발표 자료 검토']}])?.label,'행동');
  assert.equal(answerChangeSnapshot([{label:'결과',change:'not_found',beforeEvidence:['수상'],afterEvidence:[]}]),null);
});
