import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {tsImport} from 'tsx/esm/api';

const timer=await tsImport('../apps/web/src/lib/interview-timer.ts',import.meta.url);

// The real event handlers run with deterministic browser and API adapters.
// No camera, DB or paid AI request is used by this regression suite.
const source=fs.readFileSync(new URL('../apps/web/src/components/interview.tsx',import.meta.url),'utf8');
const module={exports:{}};
const state={values:[],refs:[],hook:0,refHook:0,effects:[],calls:[],resources:[],toasts:[],storage:new Map(),listener:null,answerCalls:0,adapter:null,apiAdapter:null};
const session={id:'session',state:'active',kind:'chat',data:{context:{questionId:'q',contentVersion:6,questions:[{id:'q'}],activities:[],sources:[]},panelists:[{id:'A',name:'면접관 A'}],feedbackTiming:'end'}};
const info={session,question:{id:'q',rootQuestionId:'q',turnId:'turn',prompt:'맡은 역할은 무엇인가요?',draft:'초안'},turns:[]};
let uuid=0;
vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,console,Date,Set,JSON,Blob,URL,performance,crypto:{randomUUID:()=>`request-${++uuid}`},setTimeout,clearTimeout,setInterval,clearInterval,sessionStorage:{getItem:key=>state.storage.get(key)||null,setItem:(key,value)=>state.storage.set(key,value),removeItem:key=>state.storage.delete(key)},window:{addEventListener:(name,listener)=>{if(name==='gakja:open-on')state.listener=listener;},removeEventListener:()=>{}},require(name){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value)=>value};
  if(name==='react')return{useState(initial){const index=state.hook++;if(!(index in state.values))state.values[index]=typeof initial==='function'?initial():initial;return[state.values[index],value=>{state.values[index]=typeof value==='function'?value(state.values[index]):value;}];},useRef(initial){const index=state.refHook++;if(!(index in state.refs))state.refs[index]={current:initial};return state.refs[index];},useEffect(callback){state.effects.push(callback);}};
  if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'Fragment'};
  if(name==='next/link')return{__esModule:true,default:'Link'};
  if(name==='next/navigation')return{useRouter:()=>({push:path=>state.calls.push({navigate:path})})};
  if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
  if(name==='./app-shell')return{useApp:()=>({data:{user:{id:'owner'}},refresh:async()=>{},toast:text=>state.toasts.push(text),openResource:resource=>state.resources.push(resource)})};
  if(name==='./shared')return{post:async(url,payload)=>{state.calls.push({url,payload});return state.adapter?state.adapter(url,payload):{};},api:async url=>{state.calls.push({url,method:'GET'});return state.apiAdapter?state.apiAdapter(url):info;},PageTitle:'PageTitle',Breadcrumb:'Breadcrumb',Alert:'Alert',Empty:'Empty',Modal:'Modal',targetName:()=>''};
  if(name==='./interview-setup')return{InterviewSetup:'InterviewSetup'};
  if(name==='./interview-session.module.css')return{__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
  if(name==='./practice-writing-help')return{PracticeWritingHelp:'PracticeWritingHelp'};
  if(name==='./chat-composer')return{ChatComposer:'ChatComposer'};
  if(name==='./markdown-message')return{MarkdownMessage:'MarkdownMessage'};
  if(name==='./interviewer-character')return{Interviewer:'Interviewer'};
  if(name==='./playful-flow')return{animateStudyReceipt:()=>{}};
  if(name==='./audio-level-dot')return{AudioLevelDot:'AudioLevelDot'};
  if(name==='./live-interview-session')return{LiveInterviewSession:'LiveInterviewSession'};
  if(name==='@/lib/client/draft-save')return {registerDraftSaver:()=>()=>{}};
      if(name==='@/lib/interview-timer')return timer;
  if(name==='@/lib/recording-upload-client')return{uploadRecording:()=>{throw new Error('No upload in Chat recovery regression');}};
  if(name==='@/lib/client/speech-recorder')return{startSpeechCapture:()=>{throw new Error('No hardware access');}};
  throw new Error(name);
}});
function render(){state.hook=0;state.refHook=0;state.effects=[];return module.exports.ChatInterviewSession({id:'session',kind:'chat'});}
function reset(){state.values=[info,'내 역할은 채취 조건 설계였습니다.'];state.refs=[];state.effects=[];state.calls=[];state.resources=[];state.toasts=[];state.storage.clear();state.listener=null;state.adapter=null;state.apiAdapter=null;}
function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);if(!tree||typeof tree!=='object')return[];return[tree,...nodes(tree.props?.children),...nodes(tree.props?.actions)];}
let checks=0;function check(value,message){assert.ok(value,message);checks++;}
reset();let tree=render();let grounding=nodes(tree).find(node=>node.type==='button'&&node.props.children==='근거 보기');
await grounding.props.onClick();check(state.calls[0].payload.action==='help'&&state.calls[0].payload.turnId==='turn'&&state.calls[0].payload.helpKind==='evidence','source opening records the exact owned turn first');check(state.resources.length===1,'evidence opens only after the server receipt');
reset();state.adapter=async()=>{throw new Error('receipt failed');};tree=render();grounding=nodes(tree).find(node=>node.type==='button'&&node.props.children==='근거 보기');await grounding.props.onClick();check(state.resources.length===0,'failed durable receipt prevents untracked source display');

for(const field of [6,7]){reset();state.values[field]=field===6?true:new Blob(['unsaved']);tree=render();const effect=state.effects.find(callback=>callback.toString().includes('gakja:open-on'));effect();state.listener({preventDefault(){}});await Promise.resolve();check(state.calls.length===0,field===6?'global ON cannot discard active recording':'global ON cannot discard an unsaved recording');check(state.toasts.length===1,'a concrete save-first message explains why navigation was blocked');}

reset();state.adapter=async(url,payload)=>{if(payload.action==='answer'){state.answerCalls++;if(state.answerCalls===1)throw new Error('network response lost');return{session,turn:{id:'turn',answer:payload.answer,requestId:payload.requestId},nextQuestion:null};}return{};};
tree=render();let composer=nodes(tree).find(node=>node.type==='ChatComposer');await composer.props.onSend();const first=state.calls.find(call=>call.payload?.action==='answer');check(state.calls.some(call=>call.method==='GET'),'ambiguous submit retrieves the durable server receipt');tree=render();composer=nodes(tree).find(node=>node.type==='ChatComposer');await composer.props.onSend();const submitted=state.calls.filter(call=>call.payload?.action==='answer');check(submitted.length===2&&submitted[1].payload.requestId===first.payload.requestId,'an unresolved answer retries the same request identity');

reset();state.adapter=async()=>{throw new Error('response lost after save');};state.apiAdapter=async()=>({...info,question:null,turns:[{id:'turn',answer:'내 역할은 채취 조건 설계였습니다.',requestId:state.calls.find(call=>call.payload?.action==='answer').payload.requestId}]});tree=render();composer=nodes(tree).find(node=>node.type==='ChatComposer');await composer.props.onSend();check(state.values[1]===''&&state.values[0].turns.length===1,'a committed answer is recovered instead of resubmitted');check(state.toasts.includes('저장된 답변을 다시 불러왔어요.'),'the recovered receipt is explicit to the student');

reset();state.values[0]={...info,turns:[{id:'old',answer:'옛 답변',question:'q',data:{},assisted:false}]};tree=render();check(JSON.stringify(tree).includes('도움 기록 없음'),'legacy false is labelled unknown rather than independently proven');
reset();state.values[0]={...info,session:{...session,kind:'video'},media:[{id:'new-own-recording',text:'음 원전사입니다.',metadata:{kind:'answer_recording',turnId:'turn',transcriptCleanup:{status:'completed'},displayTranscript:'새 녹음의 정리된 문장입니다.'}}]};
state.adapter=async(url,payload)=>({session:{...session,kind:'video'},question:{...info.question,draft:'새 녹음의 정리된 문장입니다.'},turn:{id:'turn',draft:'새 녹음의 정리된 문장입니다.',mediaId:payload.mediaId,rawTranscriptMediaId:payload.mediaId}});tree=render();
const select=nodes(tree).find(node=>node.type==='button'&&node.props.children==='정리된 전사 사용');await select.props.onClick();
check(state.calls[0].payload.action==='use_transcript'&&state.calls[0].payload.turnId==='turn'&&state.calls[0].payload.mediaId==='new-own-recording','choosing a rerecording requests an owned current-turn attachment instead of replacing only client text');
check(state.values[1]==='새 녹음의 정리된 문장입니다.'&&state.values[0].turns[0].mediaId==='new-own-recording','selected transcript and its server-owned recording identity stay together');
reset();state.values[0]={...info,session:{...session,kind:'video'},media:[{id:'new-own-recording',text:'음 원전사입니다.',metadata:{kind:'answer_recording',turnId:'turn',transcriptCleanup:{status:'completed'},displayTranscript:'새 녹음의 정리된 문장입니다.'}}]};state.adapter=async()=>{throw new Error('owned selection failed');};tree=render();await nodes(tree).find(node=>node.type==='button'&&node.props.children==='정리된 전사 사용').props.onClick();
check(state.values[1]==='내 역할은 채취 조건 설계였습니다.','a failed ownership attachment preserves the existing manually typed draft');
console.log(`interview recovery: ${checks} checks passed; no DB, device or provider calls`);
