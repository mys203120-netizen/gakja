import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import {learningScopeIdentity} from '../apps/web/src/lib/learning-target-scope';
import {registerDraftSaver,flushPendingDrafts} from '../apps/web/src/lib/client/draft-save';
import {learningTargetIdentityMatches} from '../packages/content-contracts/src/workflows';
import {readQuickStartStream} from '../apps/web/src/lib/quick-start-stream';
import {sendOnEnter} from '../apps/web/src/lib/client/enter-send';
const code=ts.transpileModule(fs.readFileSync('apps/web/src/components/quick-start.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const common={id:'common-item',question_id:'common_motivation',prompt:'지원 동기를 내 경험과 연결해 말해보세요.',source_kind:'common',common_revision:1};
const proposal={draft:'저는 수질 기록을 비교했습니다.',followup_question:'어떤 기준을 맞춰 비교했나요?',support_quotes:['수질 기록 비교']};
const text=(node:any):string=>node==null||typeof node==='boolean'?'':typeof node==='string'?node:Array.isArray(node)?node.map(text).join(''):text(node.props?.children);
const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.props?.children)]:[];
function controlledStream(){let controller!:ReadableStreamDefaultController;return {response:new Response(new ReadableStream({start(value){controller=value;}}),{headers:{'content-type':'text/event-stream'}}),emit(event:any){const frame=new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n');for(let i=0;i<frame.length;i+=3)controller.enqueue(frame.slice(i,i+3));},close(){controller.close();}};}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function harness(options:{storage?:Map<string,string>;foreignSession?:boolean;failAnswer?:boolean;lostAnswerResponse?:boolean;failReceiptReads?:number;failGeneration?:boolean;failDraft?:boolean;failStorage?:boolean;stream?:ReturnType<typeof controlledStream>;recoveredProposal?:any;beforeAction?:(action:string)=>void|Promise<void>}={}){
 const storage=options.storage||new Map<string,string>(),hooks:any[]=[],effects:any[]=[],pending:Array<()=>void>=[],timers=new Map<number,()=>void>(),requests:any[]=[];
 let cursor=0,dirty=true,tree:any,timerId=0,refreshes=0,generationCalls=0;const app:any={data:{user:{id:'student'},targets:[]},target:undefined,refresh:async()=>{refreshes++;}};
 let responses:any[]=[],session:any={id:'session-1',student_id:'student',mode:'answer',state:'ready',current_index:0,total:1,items:[common],metadata:{targetId:null,targetSnapshot:null}};
 const react={...React,useState(initial:any){const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return [hooks[i],(value:any)=>{const next=typeof value==='function'?value(hooks[i]):value;if(!Object.is(hooks[i],next)){hooks[i]=next;dirty=true;}}];},useRef(initial:any){const i=cursor++;return hooks[i]??={current:initial};},useEffect(effect:()=>void,deps:any[]){const i=cursor++,previous=effects[i];if(!previous||deps.some((value,index)=>!Object.is(value,previous.deps[index]))){effects[i]={deps};pending.push(()=>{previous?.cleanup?.();effects[i].cleanup=effect();});}}};
 const api=async(url:string)=>{requests.push({url});if(url.startsWith('/api/quick-start/draft?'))return {status:options.recoveredProposal?'completed':'failed',proposal:options.recoveredProposal};if(url.startsWith('/api/quiz?sourceType=common'))return {library:{answer:[{id:'personal',source_kind:'personal'},common]}};if(url==='/api/quiz?sessionId=session-1'){if(options.failReceiptReads){options.failReceiptReads--;throw Error('receipt temporarily unavailable');}return {session:{...session,student_id:options.foreignSession?'other':session.student_id},responses};}throw Error('Unexpected read '+url);};
 const post=async(url:string,input:any)=>{requests.push({url,input:structuredClone(input)});assert.equal(url,'/api/quiz');await options.beforeAction?.(input.action);if(input.action==='create')return {session:structuredClone(session)};assert.equal(input.sessionId,'session-1');if(input.action==='pause'){session.state='paused';return {session:structuredClone(session)};}if(input.action==='draft'){if(options.failDraft)throw Error('draft offline');session.metadata.drafts={'0':{response:input.response,updatedAt:new Date().toISOString()}};return {session:structuredClone(session)};}if(input.action==='start'){session.state='active';return {session:structuredClone(session)};}if(input.action==='answer'){if(options.failAnswer)throw Error('저장 응답을 확인하지 못했어요.');assert.equal(session.state,'active');session.state='completed';session.current_index=1;session.metadata.drafts={};responses=[{item_index:0,response:input.response,data:{assisted:session.metadata.assistedIndices?.includes(0)||false}}];if(options.lostAnswerResponse)throw Error('response lost after commit');return {session:structuredClone(session),response:responses[0]};}throw Error(input.action);};
 const fetch=async(url:string,init:RequestInit)=>{const input=JSON.parse(String(init.body));requests.push({url,input,signal:init.signal});generationCalls++;assert.equal(input.stream,true);assert.equal(input.sessionId,'session-1');assert.equal(input.targetId,null);if(options.failGeneration)return Response.json({error:'AI 연결을 확인해 주세요.'},{status:503});session.metadata.assistedIndices=[0];return options.stream?.response||Response.json({proposal:{...proposal,...(generationCalls>1?{draft:'저는 수질 기록의 단위를 맞춘 뒤 비교했습니다.',followup_question:null}:{})},assisted:true});};
 const module={exports:{} as any};vm.runInNewContext(code,{module,exports:module.exports,URLSearchParams,AbortController,Date,fetch,crypto:{randomUUID},setTimeout:(callback:()=>void)=>{timers.set(++timerId,callback);return timerId;},clearTimeout:(id:number)=>timers.delete(id),localStorage:{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>{if(options.failStorage)throw Error('storage blocked');storage.set(key,value);},removeItem:(key:string)=>storage.delete(key)},require(name:string){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;if(name==='lucide-react')return icons;if(name==='next/link')return {default:'Link'};if(name==='next/navigation')return {useSearchParams:()=>new URLSearchParams()};if(name==='./app-shell')return {useApp:()=>app};if(name==='./shared')return {api,post,ActionButton:'ActionButton',Alert:'Alert',FloatingNotice:'FloatingNotice'};if(name==='@/lib/client/enter-send')return {sendOnEnter};if(name==='@/lib/client/draft-save')return {registerDraftSaver};if(name==='@/lib/quick-start-stream')return {readQuickStartStream};if(name==='@/lib/learning-target-scope')return {learningScopeIdentity};if(name==='@gakja/content-contracts/workflows')return {learningTargetIdentityMatches};if(name.endsWith('.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};throw Error(name);}});
 async function flush(){for(let i=0;i<25;i++){if(dirty){dirty=false;cursor=0;tree=module.exports.QuickStart();while(pending.length)pending.shift()!();}await new Promise(resolve=>setImmediate(resolve));if(!dirty)return;}throw Error('Render loop');}
 const button=(label:string)=>{const values=nodes(tree).filter(node=>['button','ActionButton'].includes(node.type)&&(text(node).includes(label)||node.props?.['aria-label']===label));assert.equal(values.length,1,label);return values[0];};
 return {flush,button,storage,requests,app,get tree(){return tree;},get refreshes(){return refreshes;},get generationCalls(){return generationCalls;},get session(){return session;},change(){dirty=true;},async start(){await flush();button('답변 시작하기').props.onClick();await flush();},async write(value:string,id='first-thoughts'){nodes(tree).find(node=>node.props?.id===id&&node.type==='textarea').props.onChange({target:{value}});await flush();},async timers(){const callbacks=[...timers.values()];timers.clear();callbacks.forEach(callback=>callback());await flush();},dispose(){effects.forEach(effect=>effect?.cleanup?.());}};
}

test('AI organization starts on, accepts free prose, asks one follow-up and updates the whole answer before explicit final save',async()=>{
 const h=harness();await h.start();assert.equal(h.button('AI와 함께 정리').props['aria-checked'],true);assert.doesNotMatch(text(h.tree),/키워드|3분|6개|한 줄에 하나|AI 글쓰기 도움/);
 const prose=Array(20).fill('수질 기록 비교가 기억나요').join('\n');await h.write(prose);h.button('답변 정리하기').props.onClick();await h.flush();assert.equal(h.generationCalls,1);assert.equal(h.session.state,'active');assert.equal(h.requests.some(call=>call.input?.action==='answer'),false);assert.match(text(h.tree),/어떤 기준을 맞춰 비교했나요/);
 await h.write('측정 단위를 맞췄어요.');h.button('답변에 이어서 정리').props.onClick();await h.flush();const modelCalls=h.requests.filter(call=>call.url==='/api/quick-start/draft');assert.equal(modelCalls[1].input.history[0].answer,prose);assert.equal(modelCalls[1].input.thoughts,'측정 단위를 맞췄어요.');
 const editor=nodes(h.tree).find(node=>node.props?.id==='first-answer-text');assert.equal(editor.props.value,'저는 수질 기록의 단위를 맞춘 뒤 비교했습니다.');await h.write('저는 직접 단위를 확인한 뒤 수질 기록을 비교했습니다.','first-answer-text');h.button('답변 확인하고 저장').props.onClick();await h.flush();assert.equal(h.session.state,'completed');assert.match(text(h.tree),/내 답변을 저장했어요/);assert.equal(h.requests.filter(call=>call.input?.action==='answer').length,1);h.dispose();
});

test('actual streamed chunks remain temporary preview until done, and cancel preserves the thought plus previous validated draft',async()=>{
 const stream=controlledStream(),h=harness({stream});await h.start();await h.write('수질 기록 비교');const generate=h.button('답변 정리하기');generate.props.onClick();generate.props.onClick();await h.flush();assert.equal(h.generationCalls,1);
 stream.emit({type:'delta',delta:'아직 검증 전인 문장'});await h.flush();assert.match(text(h.tree),/아직 검증 전인 문장/);assert.equal(h.button('답변 정리하기').props.disabled,true);assert.equal(nodes(h.tree).filter(node=>node.type==='ActionButton').length,1);await h.timers();assert.equal(h.requests.some(call=>call.input?.action==='draft'&&call.input.response.includes('검증 전')),false);
 h.button('멈추기').props.onClick();await h.flush();assert.equal(nodes(h.tree).find(node=>node.props?.id==='first-thoughts').props.value,'수질 기록 비교');assert.doesNotMatch(text(h.tree),/아직 검증 전/);assert.equal(h.requests.find(call=>call.url==='/api/quick-start/draft').signal.aborted,true);
 stream.emit({type:'done',proposal});stream.close();await h.flush();assert.equal(nodes(h.tree).some(node=>node.props?.id==='first-answer-text'),false,'a late done after cancel is not a valid editor draft');h.dispose();
});

test('a delayed old-school stream never replaces the new school input or completion state',async()=>{
 const stream=controlledStream(),h=harness({stream});await h.start();await h.write('옛 학교의 생각');h.button('답변 정리하기').props.onClick();await h.flush();const target={id:'new-school',university:'서울시립대학교',department:'환경공학부',admission_year:2027,admission_type:'학생부종합'};h.app.data.targets=[target];h.app.target=target;h.change();await h.flush();stream.emit({type:'done',proposal});stream.close();await h.flush();assert.doesNotMatch(text(h.tree),/어떤 기준을 맞춰/);assert.equal(h.button('답변 시작하기').props.pending,false);h.dispose();
});

test('failed generation keeps free text and reuses the same attempt until the student changes it',async()=>{
 const h=harness({failGeneration:true});await h.start();await h.write('불완전한 자유문장');h.button('답변 정리하기').props.onClick();await h.flush();h.button('답변 정리하기').props.onClick();await h.flush();let calls=h.requests.filter(call=>call.url==='/api/quick-start/draft');assert.equal(calls[0].input.requestId,calls[1].input.requestId);assert.equal(nodes(h.tree).find(node=>node.props?.id==='first-thoughts').props.value,'불완전한 자유문장');await h.write('수정한 자유문장');h.button('답변 정리하기').props.onClick();await h.flush();calls=h.requests.filter(call=>call.url==='/api/quick-start/draft');assert.notEqual(calls[1].input.requestId,calls[2].input.requestId);h.dispose();
});

test('logout restores free text, conversation and an interrupted generation without promoting partial preview',async()=>{
 const stream=controlledStream(),h=harness({stream});await h.start();await h.write('보관할 원래 이야기');h.button('답변 정리하기').props.onClick();await h.flush();stream.emit({type:'delta',delta:'미완성 미리보기'});await h.flush();await flushPendingDrafts('student');await h.flush();const saved=JSON.parse(h.storage.get('gakja-first-question:student:common')!);assert.equal(saved.thoughts,'보관할 원래 이야기');assert.equal(saved.answer,'');assert.ok(saved.pendingAI.body.requestId);assert.equal(saved.aiMode,true);assert.equal(h.session.state,'paused');h.dispose();stream.emit({type:'done',proposal});stream.close();
 const restored=harness({storage:h.storage,recoveredProposal:proposal});await restored.flush();assert.equal(nodes(restored.tree).find(node=>node.props?.id==='first-answer-text').props.value,proposal.draft);assert.match(text(restored.tree),/어떤 기준을 맞춰/);assert.equal(restored.generationCalls,0,'owned receipt recovery does not generate twice');restored.dispose();
});

test('logout uses a verified persistent device copy during outage and blocks when both save paths fail',async()=>{
 const h=harness({failDraft:true});await h.start();await h.write('보관할 생각');await flushPendingDrafts('student');assert.equal(JSON.parse(h.storage.get('gakja-first-question:student:common')!).thoughts,'보관할 생각');h.dispose();
 const blocked=harness({failDraft:true,failStorage:true});await blocked.start();await blocked.write('반드시 보존할 이야기');await assert.rejects(flushPendingDrafts('student'),/초안을 보관하지 못했어요/);assert.equal(blocked.requests.some(call=>call.input?.action==='answer'),false);blocked.dispose();
});

test('direct writing still submits only explicitly, resumes after a failed logout and recovers a lost answer receipt',async()=>{
 const h=harness({lostAnswerResponse:true});await h.start();h.button('AI와 함께 정리').props.onClick();await h.flush();await h.write('  내가 직접 쓴 답변  ','first-answer-text');await assert.rejects(async()=>{await flushPendingDrafts('student');throw Error('auth logout 503');},/auth logout 503/);await h.flush();const pause=h.requests.findIndex(call=>call.input?.action==='pause');assert.equal(h.requests.some(call=>call.input?.action==='answer'),false);h.button('답변 확인하고 저장').props.onClick();await h.flush();assert.equal(h.session.state,'completed');assert.deepEqual(h.requests.slice(pause+1).filter(call=>call.input).map(call=>call.input.action),['start','answer']);assert.equal(h.requests.filter(call=>call.input?.action==='answer').length,1);h.dispose();
});

test('local pointers cannot restore a foreign owned attempt, and old free text migrates without old UI vocabulary',async()=>{
 const scope=JSON.stringify(['student',null,null]),storage=new Map([['gakja-first-question:student:common',JSON.stringify({scope,sessionId:'session-1',answer:'외부 계정의 답',keywordText:'예전에 적은 자유문장'})]]);
 const foreign=harness({storage,foreignSession:true});await foreign.flush();assert.equal(nodes(foreign.tree).some(node=>node.type==='textarea'),false);foreign.dispose();const own=harness({storage});await own.flush();assert.equal(nodes(own.tree).find(node=>node.props?.id==='first-thoughts').props.value,'예전에 적은 자유문장');assert.doesNotMatch(text(own.tree),/키워드/);own.dispose();
});

test('logout waits for both create and start receipts before preserving and pausing the new attempt',async()=>{
 const creating=deferred(),starting=deferred(),h=harness({beforeAction:action=>action==='create'?creating.promise:action==='start'?starting.promise:undefined});await h.flush();
 const start=h.button('답변 시작하기');start.props.onClick();start.props.onClick();await h.flush();assert.equal(h.requests.filter(call=>call.input?.action==='create').length,1,'synchronous start lock prevents a second owned attempt');
 let saved=false;const saving=flushPendingDrafts('student').then(()=>{saved=true;});await h.flush();assert.equal(saved,false);assert.equal(h.requests.some(call=>call.input?.action==='pause'),false);
 creating.resolve();await h.flush();assert.equal(saved,false);assert.equal(h.requests.filter(call=>call.input?.action==='start').length,1);assert.equal(h.requests.some(call=>call.input?.action==='pause'),false);
 starting.resolve();await saving;await h.flush();assert.equal(h.session.state,'paused');assert.deepEqual(h.requests.filter(call=>call.input).map(call=>call.input.action),['create','start','draft','pause']);assert.equal(JSON.parse(h.storage.get('gakja-first-question:student:common')!).sessionId,'session-1');assert.equal(h.requests.some(call=>call.input?.action==='answer'),false);h.dispose();
});

test('logout waits for a user-confirmed answer and its lost receipt recovery without racing a pause or resubmitting',async()=>{
 const answering=deferred(),h=harness({lostAnswerResponse:true,beforeAction:action=>action==='answer'?answering.promise:undefined});await h.start();h.button('AI와 함께 정리').props.onClick();await h.flush();await h.write('내가 확인하고 보낸 답변','first-answer-text');
 const submit=h.button('답변 확인하고 저장');submit.props.onClick();submit.props.onClick();await h.flush();assert.equal(h.requests.filter(call=>call.input?.action==='answer').length,1);
 let saved=false;const saving=flushPendingDrafts('student').then(()=>{saved=true;});await h.flush();assert.equal(saved,false);assert.equal(h.session.state,'active');assert.equal(h.requests.some(call=>call.input?.action==='pause'),false);
 answering.resolve();await saving;await h.flush();assert.equal(h.session.state,'completed');assert.match(text(h.tree),/내 답변을 저장했어요/);assert.equal(h.requests.filter(call=>call.input?.action==='answer').length,1);assert.equal(h.requests.some(call=>['draft','pause'].includes(call.input?.action)),false,'completed receipt must not be overwritten by a logout draft');assert.equal(h.refreshes,1);h.dispose();
});

test('logout reconciles a committed explicit answer after the first receipt read fails and clears its stale error',async()=>{
 const answering=deferred(),h=harness({lostAnswerResponse:true,failReceiptReads:1,beforeAction:action=>action==='answer'?answering.promise:undefined});await h.start();h.button('AI와 함께 정리').props.onClick();await h.flush();await h.write('응답이 끊겨도 이미 보낸 답변','first-answer-text');h.button('답변 확인하고 저장').props.onClick();await h.flush();const saving=flushPendingDrafts('student');await h.flush();answering.resolve();await saving;await h.flush();
 assert.equal(h.session.state,'completed');assert.equal(h.requests.filter(call=>call.input?.action==='answer').length,1);assert.equal(h.requests.filter(call=>call.url==='/api/quiz?sessionId=session-1').length,2);assert.equal(h.requests.some(call=>['draft','pause'].includes(call.input?.action)),false);assert.match(text(h.tree),/내 답변을 저장했어요/);assert.doesNotMatch(text(h.tree),/temporarily unavailable/);assert.equal(h.refreshes,1);h.dispose();
});

test('an unresolved explicit answer blocks logout, preserves the text and remains retryable with its original request',async()=>{
 const options={failAnswer:true},h=harness(options);await h.start();h.button('AI와 함께 정리').props.onClick();await h.flush();await h.write('저장이 확인되어야 하는 답변','first-answer-text');h.button('답변 확인하고 저장').props.onClick();await h.flush();const request=h.requests.find(call=>call.input?.action==='answer').input;
 await assert.rejects(flushPendingDrafts('student'),/초안을 보관하지 못했어요/);await h.flush();assert.equal(h.session.state,'active');assert.equal(h.requests.some(call=>call.input?.action==='pause'),false);assert.equal(nodes(h.tree).find(node=>node.props?.id==='first-answer-text').props.value,request.response);
 options.failAnswer=false;h.button('답변 확인하고 저장').props.onClick();await h.flush();const answers=h.requests.filter(call=>call.input?.action==='answer');assert.equal(answers[1].input.requestId,request.requestId);assert.equal(h.session.state,'completed');h.dispose();
});

test('an old-scope pending start cannot pause or populate a newly selected school during logout',async()=>{
 const starting=deferred(),h=harness({beforeAction:action=>action==='start'?starting.promise:undefined});await h.start();const saving=flushPendingDrafts('student');await h.flush();
 const target={id:'new-school',university:'서울시립대학교',department:'환경공학부',admission_year:2027,admission_type:'학생부종합'};h.app.data.targets=[target];h.app.target=target;h.change();await h.flush();starting.resolve();await saving;await h.flush();
 assert.equal(h.requests.some(call=>['draft','pause','answer'].includes(call.input?.action)),false);assert.equal(nodes(h.tree).some(node=>node.type==='textarea'),false);assert.equal(h.button('답변 시작하기').props.pending,false);assert.equal(h.storage.has('gakja-first-question:student:new-school'),false);h.dispose();
});

test('one action slot advances organization to confirmation and returns to organization only when new thoughts are entered',async()=>{
 const h=harness();await h.start();
 const action=()=>{const slot=nodes(h.tree).find(node=>node.props?.['data-quick-start-action']!==undefined);assert.ok(slot);const primary=nodes(slot).filter(node=>node.type==='ActionButton');assert.equal(primary.length,1);assert.equal(nodes(h.tree).filter(node=>node.type==='ActionButton').length,1);return primary[0];};
 assert.equal(text(action()),'답변 정리하기');assert.equal(action().props.disabled,true);await h.write('수질 기록 비교');action().props.onClick();await h.flush();assert.equal(text(action()),'답변 확인하고 저장');assert.equal(h.generationCalls,1);assert.equal(h.requests.some(call=>call.input?.action==='answer'),false);
 await h.write('추가로 측정 단위를 맞췄어요.');assert.equal(text(action()),'답변에 이어서 정리');assert.equal(nodes(h.tree).some(node=>node.type==='ActionButton'&&text(node)==='답변 확인하고 저장'),false);action().props.onClick();await h.flush();assert.equal(text(action()),'답변 확인하고 저장');assert.equal(h.generationCalls,2);
 await h.write('내가 직접 확인하고 수정한 답변','first-answer-text');assert.equal(text(action()),'답변 확인하고 저장');action().props.onClick();await h.flush();assert.equal(h.generationCalls,2);assert.equal(h.requests.filter(call=>call.input?.action==='answer').length,1);
 const notice=nodes(h.tree).find(node=>node.type==='FloatingNotice');assert.equal(notice.props.children,'내 답변을 저장했어요.');assert.equal(nodes(h.tree).find(node=>node.type==='h1').props.children,'완성한 내 답변');notice.props.onDismiss();await h.flush();assert.equal(nodes(h.tree).some(node=>node.type==='FloatingNotice'),false);h.dispose();
});

test('QuickStart Enter follows the current single action and never treats Korean composition or Shift+Enter as submission',async()=>{
 const h=harness();await h.start();await h.write('수질 기록 비교');
 const input=(id='first-thoughts')=>nodes(h.tree).find(node=>node.type==='textarea'&&node.props.id===id).props;
 const enter=(extra:any={},id='first-thoughts')=>{let prevented=false;input(id).onKeyDown({key:'Enter',nativeEvent:{isComposing:false,keyCode:13},preventDefault(){prevented=true;},...extra});return prevented;};
 for(const extra of [{shiftKey:true},{repeat:true},{nativeEvent:{isComposing:true,keyCode:13}},{nativeEvent:{isComposing:false,keyCode:229}}])assert.equal(enter(extra),false);
 input().onCompositionStart();assert.equal(enter(),false);input().onCompositionEnd();assert.equal(h.generationCalls,0);assert.equal(enter(),true);await h.flush();assert.equal(h.generationCalls,1);assert.equal(h.requests.some(call=>call.input?.action==='answer'),false);enter();await h.flush();assert.equal(h.requests.some(call=>call.input?.action==='answer'),false,'Enter in an empty follow-up field cannot confirm the previous AI draft');
 await h.write('측정 단위를 맞췄어요.');assert.equal(enter(),true);await h.flush();assert.equal(h.generationCalls,2);assert.equal(h.requests.some(call=>call.input?.action==='answer'),false);assert.equal(enter({},'first-answer-text'),true);await h.flush();assert.equal(h.session.state,'completed');assert.equal(h.requests.filter(call=>call.input?.action==='answer').length,1);h.dispose();
});

test('QuickStart Enter setting off leaves newlines to the field while the same explicit action remains available',async()=>{
 const h=harness();h.app.data.preferences={enterToSend:false};await h.start();await h.write('줄을 바꾸며 적는 이야기');const thoughts=()=>nodes(h.tree).find(node=>node.type==='textarea'&&node.props.id==='first-thoughts').props;
 let prevented=false;thoughts().onKeyDown({key:'Enter',nativeEvent:{isComposing:false,keyCode:13},preventDefault(){prevented=true;}});await h.flush();assert.equal(prevented,false);assert.equal(h.generationCalls,0);
 h.button('답변 정리하기').props.onClick();await h.flush();assert.equal(h.generationCalls,1);const answer=nodes(h.tree).find(node=>node.type==='textarea'&&node.props.id==='first-answer-text').props;answer.onKeyDown({key:'Enter',nativeEvent:{isComposing:false,keyCode:13},preventDefault(){prevented=true;}});await h.flush();assert.equal(prevented,false);assert.equal(h.requests.some(call=>call.input?.action==='answer'),false);
 h.button('답변 확인하고 저장').props.onClick();await h.flush();assert.equal(h.session.state,'completed');h.dispose();
});
