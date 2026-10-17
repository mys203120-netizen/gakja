import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{z}=require('zod');
let selected,reads=0,foreign=false;
class FeatureError extends Error{constructor(status,message,code){super(message);this.status=status;this.code=code;}}
const module={exports:{}},source=fs.readFileSync(new URL('../apps/web/src/app/api/learning-help/route.ts',import.meta.url),'utf8');
const quizSessionId='50000000-0000-4000-8000-000000000001';
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Response,URL,require(name){
  if(name==='zod')return{z};
  if(name==='@gakja/content-contracts')return{learningTargetIdentityMatches:()=>true};
  if(name==='@/lib/school-quiz')return{schoolQuizTargetIdentity:value=>value};
  if(name==='@/lib/auth')return{requireUser:async()=>({id:'owner',role:'student'})};
  if(name==='@/lib/interview-assistance')return{ownedInterviewHelpScope:async()=>({sessionId:'owned-interview',turnId:'owned-turn'}),ownedInterviewChatContext:async()=>({questionId:'old-q',activityId:'old-a',targetId:'old-school',contentVersion:'2',questions:[{id:'old-q'}],activities:[],sources:[],target:{id:'old-school'}})};
  if(name==='@/lib/quiz-assistance')return{getQuizHelpContext:async(studentId,sessionId,itemIndex)=>{assert.equal(studentId,'owner');if(foreign)throw new FeatureError(404,'foreign','NOT_FOUND');return{sessionId,itemIndex,questionId:'owned-q',activityId:'owned-activity',targetId:'owned-school',sourceType:'personal',sourceVersion:2};}};
  if(name==='@/lib/ai')return{FeatureError,requireStudent:()=>{},featureError:error=>error instanceof FeatureError?{status:error.status,error:error.message,code:error.code}:error instanceof z.ZodError?{status:400,error:'invalid',code:'INVALID_INPUT'}:{status:500,error:'failed'},getLearningContext:async(studentId,selection)=>{reads++;selected=selection;return{questionId:selection.questionId,activityId:selection.activityId,targetId:selection.targetId,contentVersion:'2',questions:[{id:selection.questionId}],activities:[],sources:[],answerScripts:[{script:'not exposed'}],target:{id:selection.targetId}};}};
  throw new Error(name);
}});
let checks=0;function check(value,message){assert.ok(value,message);checks++;}
let response=await module.exports.GET(new Request(`http://localhost/api/learning-help?quizSessionId=${quizSessionId}&quizItemIndex=0&questionId=foreign-q&targetId=foreign-school&sourceVersion=7`));
let payload=await response.json();check(response.status===200&&selected.questionId==='owned-q'&&selected.targetId==='owned-school'&&selected.sourceVersion===2,'owned quiz identity overrides URL school/question/version');check(payload.selection.questionId==='owned-q'&&payload.quizScope.itemIndex===0,'the browser receives a fixed scope to show and return to');check(payload.learning.answer_scripts.length===0&&payload.learning.memory_items.length===0,'preview does not reveal model answers or constitute help consumption');
const before=reads;foreign=true;response=await module.exports.GET(new Request(`http://localhost/api/learning-help?quizSessionId=${quizSessionId}&quizItemIndex=0`));check(response.status===404&&reads===before,'foreign attempts fail before reading any learning context');
foreign=false;response=await module.exports.GET(new Request(`http://localhost/api/learning-help?quizSessionId=${quizSessionId}`));check(response.status===400&&reads===before,'an explicit owned item index is required');
response=await module.exports.GET(new Request('http://localhost/api/learning-help?questionId=standalone-q&sourceType=personal&sourceVersion=2'));check(response.status===200&&selected.questionId==='standalone-q','ordinary question preview remains read only and available');
response=await module.exports.GET(new Request('http://localhost/api/learning-help?interviewSessionId=10000000-0000-4000-8000-000000000001&interviewTurnId=20000000-0000-4000-8000-000000000001&sourceVersion=9'));payload=await response.json();check(response.status===200&&payload.contentVersion==='2'&&payload.learning.questions[0].id==='old-q','paused interview preview uses its original approved snapshot instead of the newest publication');
console.log(`learning help scope: ${checks} checks passed; read-only adapters only`);
