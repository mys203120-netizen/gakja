import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import ts from 'typescript';
import {z} from 'zod';
import * as contracts from '@gakja/content-contracts';
import {observedAnswerText} from '../apps/web/src/lib/transcript-provenance';

const code=ts.transpileModule(readFileSync(new URL('../apps/web/src/lib/learning-history.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const root={id:'root',prompt:'탐구 원리를 설명해 주세요.',question_types:['concept'],activity_ids:['archived-activity'],answer_elements:['본질문의 설명 요소'],support_target_ids:[]};
const archived={activities:[],questions:[root],answer_designs:[],memory_items:[],source_refs:[]};
const turn=(overrides:Record<string,any>={})=>({id:randomUUID(),session_id:randomUUID(),question_id:'generated:followup',kind:'video',content_version:1,created_at:'2026-10-20T08:00:00Z',data:{question:'그 방법을 선택한 이유는 무엇인가요?',answer:'같은 조건에서 비교하려고 선택했어요.',rootQuestionId:'root',submissionSource:'text'},...overrides});
async function workflow(interviews:Record<string,any>[],edits:Record<string,any>[]=[]){
  const module={exports:{}} as {exports:any};
  vm.runInNewContext(code,{module,exports:module.exports,Date,console,require(name:string){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};
    if(name==='server-only')return {};
    if(name==='node:crypto')return {randomUUID};
    if(name==='zod')return {z};
    if(name==='@gakja/content-contracts')return contracts;
    if(name==='./data')return {getLearning:async()=>({learning:{...archived,questions:[{...root,activity_ids:['new-publication-activity']}]}})};
    if(name==='./db')return {ApiError:class extends Error{},query:async(sql:string)=>{
      if(sql.startsWith('select r.*,a.question_id'))return edits;
      if(sql.startsWith('select t.id,t.session_id'))return interviews;
      if(sql.startsWith('select v.version,v.data'))return [{version:1,data:archived}];
      return [];
    }};
    if(name==='./transcript-provenance')return {observedAnswerText};
    if(['./record-cursor','./learning-record-rules'].includes(name))return {};
    throw Error('Unexpected workflow dependency: '+name);
  }});
  return module.exports.projectLearningHistory({versions:edits,interviews,quizAnswers:[],attempts:[],assignments:[],archivedContent:[{version:1,data:archived}],preferenceRows:[]}) as Record<string,any>[];
}

test('generated follow-ups join their saved root activity without inheriting the root comparison rubric',async()=>{
  const rows=await workflow([
    turn({id:'context',context_questions:[{...root,activity_ids:['snapshot-activity']}]}),
    turn({id:'archive'}),
    turn({id:'missing',data:{question:'새 꼬리질문',answer:'답변',rootQuestionId:'missing'}}),
  ]);
  assert.deepEqual(Array.from(rows.find(row=>row.turn_id==='context')!.activity_ids),['snapshot-activity']);
  assert.deepEqual(Array.from(rows.find(row=>row.turn_id==='archive')!.activity_ids),['archived-activity']);
  assert.deepEqual(Array.from(rows.find(row=>row.turn_id==='missing')!.activity_ids),[]);
  for(const row of rows){assert.equal(row.question_id,'generated:followup');assert.equal(row.practice_kind,'personal');assert.equal(row.comparison.required_meanings.length,0);}
});

test('response modality follows the submitted input even inside a video or chat session',async()=>{
  const speechSource={cleanupStatus:'completed',rawText:'어 같은 조건으로 비교해요'};
  const rows=await workflow([
    turn({id:'typed-video',data:{answer:'직접 쓴 답변',submissionSource:'text',speechSource}}),
    turn({id:'recorded-video',data:{answer:'녹음 답변',submissionSource:'recording'}}),
    turn({id:'recorded-chat',kind:'chat',data:{answer:'녹음 답변',submissionSource:'recording'}}),
    turn({id:'legacy-chat',kind:'chat',data:{answer:'글 답변'}}),
    turn({id:'legacy-video',data:{answer:'화면 전사',speechSource}}),
    turn({id:'unknown-video',data:{answer:'이전 답변'}}),
  ]);
  for(const [id,mode] of [['typed-video','text'],['recorded-video','audio'],['recorded-chat','audio'],['legacy-chat','text'],['legacy-video','audio'],['unknown-video','unknown']])assert.equal(rows.find(row=>row.turn_id===id)?.response_mode,mode,id);
});

test('authored revisions preserve snapshot or archived activity IDs after republication',async()=>{
  const data={contentVersion:1};
  const rows=await workflow([], [
    {id:'saved',question_id:'root',script:'원래 답변',created_at:'2026-10-20T08:00:00Z',data:{...data,question:{...root,activity_ids:['saved-activity']}}},
    {id:'archived',question_id:'root',script:'이전 답변',created_at:'2026-10-20T08:00:00Z',data},
  ]);
  assert.deepEqual(Array.from(rows.find(row=>row.id==='saved')!.activity_ids),['saved-activity']);
  assert.deepEqual(Array.from(rows.find(row=>row.id==='archived')!.activity_ids),['archived-activity']);
  assert.ok(rows.every(row=>row.response_mode==='text'));
});
