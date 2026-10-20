import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';
import * as trainingFlow from '../apps/web/src/lib/training-flow';
import * as targetScope from '../apps/web/src/lib/learning-target-scope';

const compile=(file:string)=>ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const routeCode=compile('apps/web/src/app/api/training/route.ts');
const uiCode=compile('apps/web/src/components/training-run.tsx');
const studentId=randomUUID(),turnId=randomUUID(),secondTurnId=randomUUID();
const question={id:'root-question',activity_ids:['activity-a','activity-b']};
class ApiError extends Error {constructor(public status:number,message:string){super(message);}}
const nodes=(value:any):any[]=>Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];
const text=(value:any):string=>typeof value==='string'?value:Array.isArray(value)?value.map(text).join(''):value?.props?text(value.props.children):'';

function endpoint(){
 const preferences:any={trainingActivityNotes:[]},module={exports:{} as any};
 const db={query:async(sql:string,args:any[])=>{
  if(sql.startsWith('select t.question_id'))return {rows:args[1]===studentId&&[turnId,secondTurnId].includes(args[0])?[{question_id:question.id,data:{answer:'실제 제출 답변',rootQuestionId:question.id},session_data:{context:{questions:[question]}}}]:[]};
  if(sql.startsWith('insert into student_preferences'))return {rows:[]};
  if(sql.startsWith('select data from student_preferences'))return {rows:[{data:structuredClone(preferences)}]};
  if(sql.startsWith('update student_preferences')){preferences.trainingActivityNotes=JSON.parse(args[1]);return {rows:[]};}
  throw Error('Unexpected SQL: '+sql);
 }};
 vm.runInNewContext(routeCode,{module,exports:module.exports,Date,Request,Response,URL,JSON,require(name:string){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};
  if(name==='node:crypto')return {randomUUID};if(name==='zod')return {z};
  if(name==='@/lib/auth')return {requireUser:async()=>({id:studentId,role:'student'}),checkOrigin:(request:Request)=>assert.equal(request.headers.get('origin'),'http://fixture.test')};
  if(name==='@/lib/db')return {ApiError,query:async(sql:string,args:any[])=> (await db.query(sql,args)).rows,transaction:async(fn:Function)=>fn(db),errorResponse:(error:any)=>Response.json({error:error.message},{status:error.status||500})};
  if(name==='next/server')return {after(){}};
  if(name.startsWith('@/lib/'))return {};
  throw Error(name);
 }});
 const post=async(input:any)=>{const response=await module.exports.POST(new Request('http://fixture.test/api/training',{method:'POST',headers:{origin:'http://fixture.test','content-type':'application/json'},body:JSON.stringify(input)}));return {status:response.status,body:await response.json()};};
 return {post,preferences};
}

test('activity note retries are idempotent only for the same activity, text and submitted turn',async()=>{
 const api=endpoint(),input={action:'activity_note',turnId,activityId:'activity-a',body:'직접 확인한 행동',requestId:randomUUID()};
 assert.equal((await api.post(input)).status,200);
 assert.equal((await api.post(input)).status,200);
 assert.equal(api.preferences.trainingActivityNotes.length,1);
 for(const change of [{activityId:'activity-b'},{body:'다른 확인 내용'},{turnId:secondTurnId}])assert.equal((await api.post({...input,...change})).status,409);
 assert.equal(api.preferences.trainingActivityNotes.length,1,'a conflicting receipt cannot silently claim another activity was updated');
 assert.equal((await api.post({...input,activityId:'activity-b',requestId:randomUUID()})).status,200);
 assert.deepEqual(api.preferences.trainingActivityNotes.map((note:any)=>note.activityId),['activity-a','activity-b']);
});

test('after a committed note loses its response, changing the activity creates a new receipt from the actual training UI',async()=>{
 const api=endpoint(),hooks:any[]=[],effects:any[]=[],pending:Function[]=[],requests:any[]=[];
 let cursor=0,dirty=true,tree:any,loseFirstResponse=true;
 const react={Suspense:'Suspense',useCallback:(fn:Function)=>fn,useState(initial:any){const index=cursor++;if(!(index in hooks))hooks[index]=initial;return [hooks[index],(value:any)=>{const next=typeof value==='function'?value(hooks[index]):value;if(!Object.is(next,hooks[index])){hooks[index]=next;dirty=true;}}];},useRef(initial:any){return hooks[cursor++]??={current:initial};},useEffect(fn:Function,deps:any[]){const index=cursor++,previous=effects[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]))){effects[index]={deps};pending.push(()=>{previous?.cleanup?.();effects[index].cleanup=fn();});}}};
 const jsx={jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
 const module={exports:{} as any};
 vm.runInNewContext(uiCode,{module,exports:module.exports,AbortController,URLSearchParams,crypto:{randomUUID},require(name:string){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};
  if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;
  if(name==='@/lib/training-flow')return trainingFlow;
  if(name==='@/lib/learning-target-scope')return targetScope;
  if(name==='next/link')return {default:'Link'};if(name==='next/navigation')return {useRouter:()=>({push(){}}),useSearchParams:()=>new URLSearchParams()};
  if(name==='lucide-react')return {ArrowRight:'ArrowRight',Check:'Check',Mic:'Mic'};
  if(name==='./app-shell')return {useApp:()=>({targetId:'target',target:{id:'target',university:'검증대학',department:'검증학과',admission_year:2027},data:{user:{id:studentId},package:{id:'fixture-package',active_version:1}},refresh:async()=>{},learningRevision:1})};
  if(name==='./shared')return {Alert:'Alert',Spinner:'Spinner',ActionButton:'ActionButton',InfoTip:'InfoTip',api:async()=>({today:{tasks:[]},selectedTask:{sessionId:'completed-session'},readiness:{items:[{id:'activity-a',title:'활동 A'},{id:'activity-b',title:'활동 B'}]}}),post:async(url:string,input:any)=>{
   assert.equal(url,'/api/training');requests.push(structuredClone(input));const result=await api.post(input);if(result.status!==200)throw Error(result.body.error);if(loseFirstResponse){loseFirstResponse=false;throw Error('응답 유실');}return result.body;
  }};
  if(name==='./interview')return {InterviewSession:'InterviewSession'};
  if(name==='./question-experience-picker')return {QuestionExperiencePicker:'QuestionExperiencePicker'};
  if(name==='./markdown-message')return {MarkdownMessage:'MarkdownMessage'};
  if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
  throw Error(name);
 }});
 const run=module.exports.TrainingRun({diagnostic:true}).props.children;
 async function flush(){for(let i=0;i<10;i++){if(dirty){dirty=false;cursor=0;tree=run.type(run.props);while(pending.length)pending.shift()!();}await new Promise(resolve=>setImmediate(resolve));if(!dirty)return;}throw Error('Render loop');}
 await flush();
 nodes(tree).find(node=>node.type==='InterviewSession').props.onTrainingUpdate({session:{state:'completed',data:{context:{questions:[question]}}},turns:[{id:turnId,rootQuestionId:question.id,question:'활동 설명',answer:'저장한 답변'}]});
 await flush();
 nodes(tree).find(node=>node.type==='select').props.onChange({target:{value:'activity-a'}});
 nodes(tree).find(node=>node.type==='textarea'&&node.props.maxLength===1500).props.onChange({target:{value:'동일한 확인 내용'}});await flush();
 const save=()=>nodes(tree).find(node=>node.type==='ActionButton'&&text(node).includes('내가 한 일로 확인하고 반영'));
 await save().props.onClick();await flush();
 assert.equal(api.preferences.trainingActivityNotes.length,1);assert.ok(text(tree).includes('응답 유실'));
 nodes(tree).find(node=>node.type==='select').props.onChange({target:{value:'activity-b'}});await flush();
 await save().props.onClick();await flush();
 assert.notEqual(requests[0].requestId,requests[1].requestId,'activity-only edits must not reuse the ambiguous first receipt');
 assert.deepEqual(api.preferences.trainingActivityNotes.map((note:any)=>note.activityId),['activity-a','activity-b']);
 assert.ok(text(tree).includes('활동에 반영됨'));
});
