import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotSpeechAnswer,observedAnswerText} from '../apps/web/src/lib/transcript-provenance';
import {compareAnswerGrowth} from '../apps/web/src/lib/learning-growth';
test('failed or missing cleanup cannot masquerade as completed speech formatting',()=>{
  assert.equal(snapshotSpeechAnswer('음 원문','원문',{status:'failed'},'원문','recording'),null);
  assert.equal(snapshotSpeechAnswer('음 원문',null,{status:'completed'},'원문','recording'),null);
});
test('a submitted speech source freezes the raw, display and student edited views',()=>{
  const cleanup={status:'completed',modelId:'gpt-6-luna',promptVersion:'copyedit',rawHash:'frozen'};
  const saved=snapshotSpeechAnswer('음 제가 맡았습니다.','제가 맡았습니다.',cleanup,'제가 맡았습니다. 추가 정정','own-media')!;
  cleanup.modelId='another-model';
  assert.equal(saved.rawText,'음 제가 맡았습니다.');assert.equal(saved.studentEdited,true);assert.equal(saved.cleanupModel,'gpt-6-luna');
  assert.equal(saved.submittedText,'제가 맡았습니다. 추가 정정');
});
test('automatic copy editing cannot add role evidence or a new detail to content growth',()=>{
  const base={question_id:'same-question',question:'무엇을 맡았나요?',created_at:'2026-10-14T00:00:00Z',required_meanings:['본인 역할'],response_mode:'audio' as const};
  const before={...base,id:'before',script:'음 결과를 봤습니다.',raw_script:'음 결과를 봤습니다.'};
  const after={...base,id:'after',created_at:'2026-10-14T00:10:00Z',script:'제가 시료 준비를 맡았습니다.',raw_script:'음 결과를 봤습니다.'};
  const result=compareAnswerGrowth(before,after);
  assert.deepEqual(result.addedDetails,[]);assert.deepEqual(result.addedElements,[]);assert.deepEqual(result.elements[0].afterEvidence,[]);
  assert.equal(result.after.script,'제가 시료 준비를 맡았습니다.');
});
test('raw spoken evidence is quoted while the formatted answer stays readable',()=>{
  const before={id:'a',question_id:'q',script:'역할이 생각나지 않습니다.',created_at:'2026-10-14T00:00:00Z',required_meanings:['본인 역할']};
  const after={...before,id:'b',created_at:'2026-10-14T00:05:00Z',script:'제 담당은 측정표를 작성하는 일이었습니다.',raw_script:'음 제 담당은 측정표를 작성하는 일이었습니다.'};
  const compared=compareAnswerGrowth(before,after);
  assert.deepEqual(compared.elements[0].afterEvidence,[after.raw_script]);assert.equal(compared.after.script,after.script);
});
test('legacy typed answers and empty raw values retain their original observation source',()=>{
  assert.equal(observedAnswerText({script:'기존 입력'}),'기존 입력');
  assert.equal(observedAnswerText({script:'기존 입력',raw_script:'  '}),'기존 입력');
});
