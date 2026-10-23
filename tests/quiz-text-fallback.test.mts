import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';
import * as rules from '../apps/web/src/lib/quiz-rules.ts';

/** Exercise the real route through an isolated transaction adapter, with no HTTP/DB/media calls. */
const sessionId='10000000-0000-4000-8000-000000000001',studentId='10000000-0000-4000-8000-000000000002',recordingId='10000000-0000-4000-8000-000000000003';
function harness(){
  const item:any={id:'memory',question_id:'question',practice_kind:'personal',prompt:'내가 한 역할은 무엇인가요?',kind:'short_answer',category:'experiential',activity_ids:['activity'],target_id:'school',source_kind:'common',common_revision:4,modelAnswer:'',source_ref_ids:[],memory_keywords:[]};
  let session:any={id:sessionId,student_id:studentId,state:'active',current_index:0,content_version:0,mode:'oral',items:[item],metadata:{targetId:'school',targetSnapshot:{university:'합성 대학'}},item_elapsed_ms:0,item_started_at:new Date().toISOString()};
  const responses:any[]=[],attempts:any[]=[],events:any[]=[],scopeReads:string[]=[];let speechSnapshots=0;
  async function query(sql:string,params:any[]=[]):Promise<any[]>{
    if(sql.startsWith('select data from student_preferences')){scopeReads.push('preferences');return[{data:{selectedTargetId:'unsupported-target'}}];}
    if(sql.startsWith('select id,data from support_targets')){scopeReads.push('target');return[{id:'unsupported-target',data:{university:'합성 미지원 전형 대학'}}];}
    if(sql.startsWith('select id,student_id,mode')||sql.startsWith('select memory_item_id,rating'))return[];
    if(sql.startsWith('select * from quiz_sessions'))return params[0]===session.id&&params[1]===studentId?[session]:[];
    if(sql.startsWith('select id,metadata from quiz_recordings'))return params[0]===recordingId&&params[1]===studentId&&params[2]===sessionId&&params[3]===0?[{id:recordingId,metadata:{transcript:'원전사',displayTranscript:'원전사.'}}]:[];
    if(sql.startsWith('insert into quiz_responses')){const row={id:'response',item_index:params[2],memory_item_id:params[3],response:params[4],selected_option_id:params[5],outcome:params[6],timed_out:params[7],rating:params[10],data:JSON.parse(params[11])};responses.push(row);return[row];}
    if(sql.startsWith('insert into memory_attempts')){attempts.push(JSON.parse(params[3]));return[];}
    if(sql.startsWith('update quiz_sessions')){session={...session,state:params[1],current_index:1,metadata:JSON.parse(params[2])};return[session];}
    if(sql.startsWith('select * from quiz_responses'))return responses;
    if(sql.startsWith('select id,item_index,mime'))return[];
    throw new Error('Unexpected isolated query: '+sql);
  }
  class ApiError extends Error{constructor(public status:number,message:string){super(message);}}
  const db={query:async(sql:string,params:any[])=>({rows:await query(sql,params)})};
  const module={exports:{} as any};
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../apps/web/src/app/api/quiz/route.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
    module,exports:module.exports,Response,Date,JSON,Buffer,URL,URLSearchParams,Set,Number,String,
    require(name:string){
      if(name==='@/lib/privacy-policy')return {PRIVACY_POLICY_VERSION:'2026-10-22'};
      if(name==='zod')return{z};if(name==='node:crypto')return{};
      if(name==='@/lib/auth')return{checkOrigin(){},requireUser:async()=>({id:studentId,role:'student'})};
      if(name==='@/lib/db')return{ApiError,query,transaction:async(work:any)=>work(db),errorResponse:(error:any)=>Response.json({error:error.message},{status:error.status||500})};
      if(name==='@/lib/quiz-rules')return rules;
      if(name==='@/lib/quiz-assistance')return{quizHelpFacts:()=>({assistance_recorded:true,assisted:false,helpKinds:[]})};
      if(name==='@/lib/school-quiz')return{quizSchoolMetadata:()=>({source_kind:'common',common_revision:4,target_id:'school'}),schoolQuizItems:(_questions:any,target:any)=>target?[]:[item],schoolQuizTargetIdentity:(target:any)=>target};
      if(name==='@/lib/data')return{getLearning:async()=>({learning:{memory_items:[],questions:[],activities:[],source_refs:[]},package:null})};
      if(name==='@/lib/school-learning')return{commonInterviewQuestions:async()=>[]};
      if(name==='@/lib/quiz-selection')return{selectQuizItems:(items:any[])=>({items,wrong:0,due:0,unseen:items.length,reason:'합성 공통 질문'})};
      if(name==='@/lib/study-sessions')return{recordStudyEvent:async(_db:any,_student:string,event:any)=>events.push(event)};
      if(name==='@/lib/transcript-provenance')return{snapshotSpeechAnswer:()=>{speechSnapshots++;return{recordingId};}};
      if(['@/lib/recording-upload','@/lib/speech-analysis'].includes(name))return{};
      throw new Error('Unexpected isolated import: '+name);
    },
  });
  return{responses,attempts,events,scopeReads,get speechSnapshots(){return speechSnapshots;},get:(query:string)=>module.exports.GET({url:'https://gakja.test/api/quiz?'+query}),async answer(extra:any={}){return module.exports.POST({headers:new Headers({'Content-Type':'application/json'}),json:async()=>({action:'answer',sessionId,itemIndex:0,response:'저는 관찰 순서를 정리했습니다.',recallStatus:'remembered',...extra})});}};
}
test('explicit text alternative saves the same oral question as writing with no invented speech source',async()=>{
  const h=harness(),response=await h.answer({responseMode:'text'});assert.equal(response.status,200);
  const saved=h.responses[0];assert.equal(saved.data.question_id,'question');assert.equal(saved.data.target_id,'school');assert.equal(saved.data.common_revision,4);
  assert.equal(saved.data.response_mode,'text');assert.equal(saved.data.original_mode,'oral');assert.equal(saved.data.submitted_mode,'answer');assert.equal(saved.data.recording_id,null);assert.equal(saved.data.speech_source,undefined);assert.equal(h.speechSnapshots,0);
  assert.equal(h.events[0].data.mode,'answer');assert.equal(h.events[0].data.audioId,null);assert.equal(h.attempts[0].recording_id,null);
});
test('implicit text cannot silently count as an oral response',async()=>{
  const h=harness();assert.equal((await h.answer()).status,400);assert.equal(h.responses.length,0);assert.equal(h.events.length,0);
});
test('ambiguous retry matches the trimmed saved text without inserting a duplicate response',async()=>{
  const h=harness();assert.equal((await h.answer({responseMode:'text',response:'  내 역할은 관찰 순서 정리였습니다.  '})).status,200);
  assert.equal((await h.answer({responseMode:'text',response:'  내 역할은 관찰 순서 정리였습니다.  '})).status,200);assert.equal(h.responses.length,1);assert.equal(h.events.length,1);
  assert.equal((await h.answer({recordingId,response:'내 역할은 관찰 순서 정리였습니다.'})).status,409);assert.equal(h.responses.length,1);
});
test('text fallback rejects an audio attachment and voice retries still check recording ownership',async()=>{
  const both=harness();assert.equal((await both.answer({responseMode:'text',recordingId})).status,400);assert.equal(both.responses.length,0);
  const foreign=harness();assert.equal((await foreign.answer({recordingId:'10000000-0000-4000-8000-000000000099'})).status,404);assert.equal(foreign.responses.length,0);
  const voice=harness();assert.equal((await voice.answer({recordingId})).status,200);assert.equal(voice.responses[0].data.response_mode,'voice');assert.equal(voice.events[0].data.mode,'oral');assert.equal(voice.speechSnapshots,1);
});
test('legacy general catalog bypasses the selected target but does not add written practice to choice-only quiz',async()=>{
  const general=harness(),response=await general.get('sourceType=common&general=1');assert.equal(response.status,200);const body=await response.json();assert.equal(body.target,null);assert.equal(body.library.answer.length,0);assert.equal(body.library.oral.length,0);assert.equal(body.library.choice.length,0);assert.deepEqual(general.scopeReads,[]);
  const normal=harness(),scoped=await normal.get('sourceType=common');assert.equal(scoped.status,200);assert.equal((await scoped.json()).library.answer.length,0);assert.deepEqual(normal.scopeReads,['preferences','target']);
  for(const query of ['sourceType=personal&general=1','general=1','sourceType=common&general=1&targetId=unsupported-target','sourceType=common&general=1&mode=choice','sourceType=common&general=1&activityId=activity']){const invalid=harness();assert.equal((await invalid.get(query)).status,400);assert.deepEqual(invalid.scopeReads,[]);}
});
