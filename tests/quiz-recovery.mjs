import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {buildSpeechTelemetry} from '../apps/web/src/lib/speech-telemetry.ts';
import {validateSpeechTelemetry} from '../apps/web/src/lib/speech-analysis.ts';

const load=(path,require=()=>{throw new Error('Unexpected import');})=>{const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require,Set});return module.exports;};
const view=load('../apps/web/src/lib/quiz-session-view.ts');
const contracts=load('../packages/content-contracts/src/workflows.ts',name=>name==='./index'?{}:{});
const target={id:'target',university:'서울시립대학교',campus:'본교',department:'환경공학부',admission_year:2027,admission_type:'학생부종합전형Ⅰ(면접형)',interview_stage:'2단계'};
const savedTarget={...target,interview_stage:undefined};
const item={id:'m1',question_id:'q1',prompt:'본인 역할은 무엇인가요?',activity_ids:['a1'],source_kind:'personal',target_id:'target',target_snapshot:savedTarget};
const info={serverTime:new Date().toISOString(),session:{id:'session',student_id:'student',state:'active',mode:'answer',current_index:0,content_version:6,items:[item],metadata:{targetId:'target',targetSnapshot:savedTarget,drafts:{0:{response:'서버에 저장한 초안'}}}},responses:[],recordings:[],learning:{questions:[{id:'q1',prompt:item.prompt}],support_targets:[savedTarget],memory_items:[]}};
const state={values:[],refs:[],hook:0,refHook:0,effects:[],calls:[],toasts:[],listener:null,adapter:null,apiAdapter:null,storage:new Map(),local:new Map(),now:0,capture:null,uploads:[],finishCount:0,tracksStopped:0,captureAvailable:true,uploadError:false,deviceRequests:0,timers:new Map(),confirm:false,events:new Map(),visibility:'visible',deviceGate:null,reservationGate:null,assertGate:null,cancelledReservations:0};
let timerId=0;
class FakeRecorder {
  static isTypeSupported(){return true;}
  state='inactive';mimeType='audio/webm';
  constructor(){state.capture=this;}
  start(){this.state='recording';this.onstart?.();}
  stop(){this.state='inactive';}
  async deliverStop(){this.ondataavailable?.({data:new Blob(['fake-recorded-audio'],{type:this.mimeType})});await this.onstop?.();}
}
let uuid=0;
const durableAudio=new Map();
const recoveryRemovals=[];
const module={exports:{}};
const actionButton=({pending=false,pendingLabel,disabled,children,type='button',...props})=>({type:'button',props:{...props,type,disabled:disabled||pending,'aria-busy':pending||undefined,children:pending?[{type:'LoaderCircle',props:{size:16,'aria-hidden':true}},pendingLabel??children]:children}});
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/quiz-v3.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,console,Date,Set,JSON,Blob,FormData,URL,URLSearchParams,AbortController,requestAnimationFrame:callback=>{callback();return 1;},cancelAnimationFrame(){},performance:{now:()=>state.now},crypto:{randomUUID:()=>`request-${++uuid}`},setTimeout:(callback,ms)=>{const id=++timerId;state.timers.set(id,{callback,ms});return id;},clearTimeout:id=>state.timers.delete(id),setInterval:(callback,ms)=>{const id=++timerId;state.timers.set(id,{callback,ms});return id;},clearInterval:id=>state.timers.delete(id),HTMLElement:class {},document:{activeElement:null,get visibilityState(){return state.visibility;},addEventListener(name,listener){state.events.set(name,listener);},removeEventListener(name){state.events.delete(name);}},navigator:{sendBeacon:(url,body)=>{state.calls.push({url,beacon:body});return true;},mediaDevices:{getUserMedia:async()=>{state.deviceRequests++;await state.deviceGate;return{getTracks:()=>[{stop(){state.tracksStopped++;}}]};}}},MediaRecorder:FakeRecorder,localStorage:{getItem:key=>state.local.get(key)??null,setItem:(key,value)=>state.local.set(key,value),removeItem:key=>state.local.delete(key)},sessionStorage:{getItem:key=>state.storage.get(key)??null,setItem:(key,value)=>state.storage.set(key,value),removeItem:key=>state.storage.delete(key)},window:{matchMedia:()=>({matches:true}),MediaRecorder:FakeRecorder,confirm:()=>state.confirm,addEventListener:(name,listener)=>{state.events.set(name,listener);if(name==='gakja:open-on')state.listener=listener;},removeEventListener(name){state.events.delete(name);}},require(name){
  if(name==='react')return{useState(initial){const index=state.hook++;if(!(index in state.values))state.values[index]=typeof initial==='function'?initial():initial;return[state.values[index],value=>{state.values[index]=typeof value==='function'?value(state.values[index]):value;}];},useRef(initial){const index=state.refHook++;if(!(index in state.refs))state.refs[index]={current:initial};return state.refs[index];},useEffect(callback){state.effects.push(callback);},useCallback:callback=>callback};
  if(name==='react/jsx-runtime')return{jsx:(type,props)=>type===actionButton?actionButton(props):({type,props}),jsxs:(type,props)=>type===actionButton?actionButton(props):({type,props}),Fragment:'Fragment'};
  if(name==='next/link')return{__esModule:true,default:'Link'};
  if(name==='next/navigation')return{useRouter:()=>({push:path=>state.calls.push({navigate:path})}),useSearchParams:()=>new URLSearchParams()};
  if(name==='lucide-react')return new Proxy({},{get:(_,key)=>String(key)});
  if(name==='./app-shell')return{useApp:()=>({data:{user:{id:'student'},targets:[target]},refresh:async()=>{},toast:text=>state.toasts.push(text),openResource(){}})};
  if(name==='./shared')return{ActionButton:actionButton,post:async(url,payload)=>{state.calls.push({url,payload});return state.adapter?state.adapter(url,payload):info;},api:async url=>{state.calls.push({url,method:'GET'});return state.apiAdapter?state.apiAdapter(url):info;},PageTitle:'PageTitle',Breadcrumb:'Breadcrumb',Alert:'Alert',Empty:'Empty',Spinner:'Spinner'};
  if(name==='./practice-writing-help')return{PracticeWritingHelp:'PracticeWritingHelp'};
  if(name==='./learning-help')return{LearningHelp:'LearningHelp'};
  if(name==='./audio-level-dot')return{AudioLevelDot:'AudioLevelDot'};
  if(name==='./playful-flow')return{animateStudyReceipt(){}};
  if(name==='@/lib/client/speech-recorder')return{startSpeechCapture(){if(!state.captureAvailable)return null;const started=state.now;return{elapsedMs:()=>state.now-started,dispose(){},pause(){},resume(){},finish(){state.finishCount++;const elapsed=state.now-started;return buildSpeechTelemetry([{atMs:0,rms:0},{atMs:elapsed-.1,rms:.04}],elapsed);}};}};
  if(name==='@/lib/client/recording-recovery')return{installRecordingExitGuard:()=>()=>{},readRecordingRecovery:async scope=>durableAudio.get(JSON.stringify(scope))||null,removeRecordingRecovery:async key=>{recoveryRemovals.push(key);durableAudio.delete(key);},beginRecordingRecovery:async(scope,mimeType)=>{await state.reservationGate;const key=JSON.stringify(scope),chunks=[];let closed=false;return{key,assertActive:async()=>{await state.assertGate;if(closed)throw Error('closed');},assertFresh:()=>{if(closed)throw Error('closed');},cancel:async()=>{if(chunks.length)throw Error('pending audio');closed=true;state.cancelledReservations++;durableAudio.delete(key);},append:async blob=>{if(closed)throw Error("closed");chunks.push(blob);durableAudio.set(key,{...scope,key,blob:new Blob(chunks,{type:mimeType||blob.type}),durationMs:1,complete:false});},finish:async measurement=>{if(closed)throw Error("closed");const saved={...scope,key,blob:new Blob(chunks,{type:mimeType||chunks[0]?.type}),...measurement,complete:true};durableAudio.set(key,saved);return saved;},flush:async()=>{}};}};
  if(name==='@/lib/recording-upload-client')return{uploadRecording:async(url,form)=>{const durationMs=Number(form.get('durationMs')),telemetry=form.get('speechTelemetry')?JSON.parse(form.get('speechTelemetry')):null;assert.ok(!telemetry||validateSpeechTelemetry(telemetry));assert.ok(!telemetry||Math.abs(telemetry.durationMs-durationMs)<=500);state.uploads.push({durationMs,telemetry,blob:form.get('recording')});if(state.uploadError)throw new Error('synthetic upload failed');return{recording:{id:'new-recording',session_id:'session',item_index:0,url:'/owned-recording'}};}};
  if(name==='@gakja/content-contracts/workflows')return contracts;
  if(name==='@/lib/quiz-session-view')return view;
  if(name==='./quiz-session-ui.module.css')return{__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
  throw new Error(name);
}});
const render=()=>{state.hook=0;state.refHook=0;state.effects=[];return module.exports.QuizSession({id:'session'});};
const reset=(dto=info)=>{state.values=[dto,'',false,10,'내 역할은 채취 조건 설계였습니다.'];state.values[23]=true;durableAudio.clear();recoveryRemovals.length=0;state.refs=[];state.effects=[];state.calls=[];state.toasts=[];state.listener=null;state.adapter=null;state.apiAdapter=null;state.storage.clear();state.local.clear();state.now=0;state.capture=null;state.uploads=[];state.finishCount=0;state.tracksStopped=0;state.captureAvailable=true;state.uploadError=false;state.deviceRequests=0;state.timers.clear();state.confirm=false;state.events.clear();state.visibility='visible';state.deviceGate=null;state.reservationGate=null;state.assertGate=null;state.cancelledReservations=0;};
const nodes=tree=>Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children),...nodes(tree.props?.aside)]:[];
const text=value=>Array.isArray(value)?value.map(text).join(''):value&&typeof value==='object'?text(value.props?.children):typeof value==='string'?value:'';
const saveButton=tree=>nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='답변 저장');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
let checks=0;const check=(value,message)=>{assert.ok(value,message);checks++;};

reset();let tree=render();state.effects.find(effect=>effect.toString().includes("metadata?.drafts"))();check(state.values[4]==='서버에 저장한 초안','fresh browser uses the server draft');check(state.values[15]==='unchecked','new recall self-check starts unchecked');
reset();state.local.set('gakja-quiz:student:session:0','로컬 최신 초안');tree=render();state.effects.find(effect=>effect.toString().includes("metadata?.drafts"))();check(state.values[4]==='로컬 최신 초안','newer local fallback survives interrupted network saving');

reset();tree=render();state.effects.find(effect=>effect.toString().includes('gakja:open-on'))();let prevented=false;state.listener({preventDefault(){prevented=true;}});await settle();check(prevented,'global ON navigation is held until saving');check(state.calls[0].payload.action==='draft'&&state.calls[0].payload.response===state.values[4],'the draft is saved before leaving');check(state.calls[1].payload.action==='pause','the owned quiz is paused before ON');const destination=new URL(state.calls.find(call=>call.navigate).navigate,'https://local.test');check(destination.searchParams.get('quizSessionId')==='session'&&destination.searchParams.get('quizItemIndex')==='0'&&destination.searchParams.get('sourceVersion')==='6','ON receives the exact session, item and original content version');

for(const blocked of ['choice','recording','blob']){reset(blocked==='choice'?{...info,session:{...info.session,mode:'choice',items:[{...item,options:[]}]}}:info);if(blocked==='recording')state.values[11]='recording';if(blocked==='blob')state.values[17]={blob:new Blob(['unsaved']),index:0,durationMs:500,telemetry:undefined};tree=render();state.effects.find(effect=>effect.toString().includes('gakja:open-on'))();state.listener({preventDefault(){}});await settle();check(state.calls.length===0,`${blocked} cannot leave the current answer through ON`);check(state.toasts.length===1,'save-first instruction is visible');}

reset();state.adapter=async()=>{throw new Error('draft failed');};tree=render();state.effects.find(effect=>effect.toString().includes('gakja:open-on'))();state.listener({preventDefault(){}});await settle();check(!state.calls.some(call=>call.navigate),'failed durable draft blocks navigation');check(state.values[16]==='failed','failed draft saving remains visible and retryable');

reset();state.adapter=async()=>{throw new Error('response lost');};tree=render();await saveButton(tree).props.onClick();const first=state.calls.find(call=>call.payload?.action==='answer');check(first.payload.rating==='hard'&&first.payload.recallStatus==='unchecked','saving without self-check does not rate recall good');check(state.calls.some(call=>call.method==='GET'),'ambiguous submit checks the server receipt');check(state.values[4].includes('채취 조건'),'unconfirmed submit keeps the draft');tree=render();await saveButton(tree).props.onClick();const answers=state.calls.filter(call=>call.payload?.action==='answer');check(answers[0].payload.requestId===answers[1].payload.requestId,'unchanged retry reuses its answer request identity');

reset();state.adapter=async()=>{throw new Error('response lost after commit');};state.apiAdapter=async()=>{const request=state.calls.find(call=>call.payload?.action==='answer').payload;return{...info,session:{...info.session,state:'completed',current_index:1},responses:[{id:'response',item_index:0,response:request.response,outcome:null,rating:request.rating,data:{requestId:request.requestId,recall_state:request.recallStatus,assistance_recorded:true}}]};};tree=render();await saveButton(tree).props.onClick();check(state.values[0].session.state==='completed','committed answer is recovered without a second answer write');check(state.toasts.includes('저장된 답변을 다시 불러왔어요.'),'recovered commit is explicit');

reset({...info,session:{...info.session,state:'completed',current_index:1},responses:[{id:'r',item_index:0,response:'저장된 답변',outcome:null,rating:'hard',data:{recall_state:'unchecked',helpKinds:['evidence'],assistance_recorded:true}}]});tree=render();const flat=nodes(tree);check(flat.some(node=>node.type==='Link'&&node.props.href?.startsWith('/interview/chat?')),'omitted old stage still exposes the same-question interview path');check(!text(tree).includes('지원 정보가 바뀌었어요'),'unknown old stage does not claim the support target changed');check(text(tree).includes('근거 확인')&&!text(tree).includes('AI 도움'),'source help is not labelled AI assistance');check(text(tree).includes('다시 볼 답변'),'unchecked answer is included in review');
const oralRecording={id:'owned-oral-recording',item_index:0,url:'/api/quiz?recordingId=owned-oral-recording',raw_transcript:'음 저는 관찰 했습니다',display_transcript:'저는 관찰했습니다.',transcript_cleanup:{status:'completed'}};
const oralInfo={...info,session:{...info.session,mode:'oral',metadata:{...info.session.metadata,drafts:{}}},recordings:[oralRecording]};
reset(oralInfo);tree=render();state.effects.find(effect=>effect.toString().includes('metadata?.drafts'))();check(state.values[4]==='저는 관찰했습니다.','restored oral draft uses finished display rather than raw STT');
reset({...oralInfo,recordings:[{...oralRecording,display_transcript:null,transcript_cleanup:{status:'failed'}}]});tree=render();state.effects.find(effect=>effect.toString().includes('metadata?.drafts'))();check(state.values[4]==='','failed formatting does not restore raw STT into the main answer');
reset(oralInfo);state.values[9]={...oralRecording,display_transcript:null,transcript_cleanup:{status:'failed'}};tree=render();state.adapter=async(url,payload)=>({transcript:'저는 관찰했습니다.',rawTranscript:oralRecording.raw_transcript,cleanupStatus:'completed',transcriptionStatus:'completed'});const retry=nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='문장 정리 다시 시도');await retry.props.onClick();check(state.calls[0].url==='/api/reports'&&state.calls[0].payload.recordingId===oralRecording.id,'oral retry formats the same stored owned recording');check(state.values[4]==='내 역할은 채취 조건 설계였습니다.','formatted oral retry preserves a manually typed draft');check(state.values[9].display_transcript==='저는 관찰했습니다.'&&state.values[9].raw_transcript===oralRecording.raw_transcript,'finished oral display and raw source remain separately available');
for(const evidence of [true,false]){
  reset();state.values[10]=true;state.captureAvailable=evidence;state.adapter=async()=>({rawTranscript:'합성 전사',transcript:'합성 전사.',cleanupStatus:'completed',transcriptionStatus:'completed'});
  tree=render();await nodes(tree).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();
  state.now=999.7;tree=render();nodes(tree).find(node=>node.type==='button'&&text(node.props.children).startsWith('녹음 완료')).props.onClick();
  state.now=3500;await state.capture.deliverStop();
  check(state.uploads[0].durationMs===1000,'duration freezes at stop request before delayed final audio delivery');
  check(state.finishCount===(evidence?1:0),'microphone telemetry finishes once, including onstop fallback');
  check(!evidence||state.uploads[0].telemetry.speechSegments.length===0,'fractional final frame does not invalidate upload timing');
  check(state.calls.some(call=>call.payload?.action==='transcribe'&&call.payload.recordingId==='new-recording'),'successful owned upload reaches transcription');
  check(state.values[4]==='내 역할은 채취 조건 설계였습니다.','automatic transcription preserves the typed draft');
  check(state.values[17]===null&&state.tracksStopped===1,'successful recording clears pending audio and releases the device');
}
reset();state.values[10]=true;tree=render();await nodes(tree).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();tree=render();const stopTimers=state.effects.find(effect=>effect.toString().includes('179_750'))();
state.now=181000;state.timers.values().next().value.callback();state.now=184000;await state.capture.deliverStop();stopTimers();tree=render();
check(state.uploads.length===0&&state.values[17].durationMs===181000,'background-delayed stop preserves the actual over-limit duration without uploading false metadata');
check(text(tree).includes('원본 내려받기')&&!text(tree).includes('녹음 다시 저장'),'over-limit recovery exposes the original file and avoids an impossible upload retry');
const discard=()=>nodes(render()).find(node=>node.type==='button'&&text(node.props.children)==='저장 안 된 녹음 지우기');await discard().props.onClick();check(!!state.values[17],'declining discard preserves the unsaved file');state.confirm=true;await discard().props.onClick();check(state.values[17]===null,'explicit discard unblocks a fresh recording');
reset({...info,session:{...info.session,mode:'oral'}});state.values[10]=true;state.uploadError=true;tree=render();await nodes(tree).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();state.now=1200;tree=render();nodes(tree).find(node=>node.type==='button'&&text(node.props.children).startsWith('녹음 완료')).props.onClick();await state.capture.deliverStop();
check(state.values[17]?.blob.size>0&&durableAudio.size===1&&recoveryRemovals.length===0,'upload failure retains both original in memory and durable media without a false receipt');
// A mount cleanup must keep the final MediaRecorder events alive until durable finish.
reset({...info,session:{...info.session,mode:'oral'}});state.values[10]=true;
tree=render();const mountedCleanup=state.effects.find(effect=>effect.toString().includes('mounted.current = true'))();
await nodes(tree).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();
state.now=2200;mountedCleanup();state.now=4000;await state.capture.deliverStop();
check(state.uploads.length===0,'unmounted recorder does not start an unreviewed server upload');
const recoveredLocal=[...durableAudio.values()][0];
check(recoveredLocal?.blob.size>0&&await recoveredLocal.blob.text()==='fake-recorded-audio','final chunk survives unmount in device storage');
check(recoveredLocal.durationMs===2200,'unmount freezes honest duration before delayed final data event');
check(JSON.parse(state.local.get('gakja-quiz-activity:student:session')).hasRecording===true,'even a first-question recording without text remains discoverable from the dashboard');
reset({...info,session:{...info.session,mode:'oral'}});durableAudio.set(recoveredLocal.key,recoveredLocal);tree=render();
state.effects.find(effect=>effect.toString().includes('readRecordingRecovery'))();await settle();tree=render();
check(text(tree).includes('아직 저장되지 않았어요.')&&text(tree).includes('원본 내려받기'),'same owned question restores explicit retry/download recovery controls');
check(state.uploads.length===0,'restoring audio never uploads it automatically');
await nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='녹음 다시 저장').props.onClick();
check(recoveryRemovals.includes(recoveredLocal.key)&&!durableAudio.has(recoveredLocal.key),'only a confirmed server recording receipt removes the local original');

// stop() makes MediaRecorder inactive before its last chunk/onstop are delivered.
// Leaving in that gap must not cancel what still looks like an empty reservation.
reset({...info,session:{...info.session,mode:'oral'}});state.values[10]=true;tree=render();
const stoppedCleanup=state.effects.find(effect=>effect.toString().includes('mounted.current = true'))();
await nodes(tree).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();
state.now=1500;tree=render();nodes(tree).find(node=>node.type==='button'&&text(node.props.children).startsWith('녹음 완료')).props.onClick();
check(state.capture.state==='inactive'&&durableAudio.size===0,'stop-before-final-event leaves an empty but owned recording reservation');
stoppedCleanup();state.now=3500;await state.capture.deliverStop();
check(state.uploads.length===0&&durableAudio.size===1,'leaving after stop preserves final events without an unreviewed upload');
check(await [...durableAudio.values()][0].blob.text()==='fake-recorded-audio','the stopped recorder final chunk survives even when the reservation was empty at unmount');

reset({...info,session:{...info.session,mode:'oral'}});tree=render();
check(saveButton(tree).props.disabled,'oral save still requires recording unless the learner explicitly changes response mode');
nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='이 질문은 글로 답하기').props.onClick();tree=render();
check(!saveButton(tree).props.disabled,'same oral question supports explicit text alternative without a microphone');
await saveButton(tree).props.onClick();const textRequest=state.calls.find(call=>call.payload?.action==='answer').payload;
check(textRequest.responseMode==='text'&&!textRequest.recordingId&&textRequest.itemIndex===0,'text fallback submits the original question without voice media or invented voice metrics');

reset();state.values[10]=true;state.values[23]=false;tree=render();await nodes(tree).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();tree=render();
check(state.capture===null&&state.values[22]===0&&state.deviceRequests===1,'microphone permission and level check happen before the readiness countdown');
nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='준비됐어요 · 3초 뒤 시작').props.onClick();tree=render();
check(state.values[22]===3&&state.capture===null,'learner explicitly starts the real three-second readiness countdown after the microphone check');
nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='지금 시작').props.onClick();await settle();
check(state.deviceRequests===1&&state.capture?.state==='recording','skip reuses the checked device and opens exactly one recorder');
reset();state.values[10]=true;state.values[23]=false;tree=render();await nodes(tree).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();tree=render();await nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='취소').props.onClick();
check(state.values[22]===null&&state.capture===null&&state.tracksStopped===1,'cancel microphone check releases the device without recording an answer');

const pauseButton=()=>nodes(render()).find(node=>node.props?.['aria-label']==='일시정지');
const installVisibility=()=>state.effects.find(effect=>effect.toString().includes('visibilitychange'))();
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};};
const prepareCountdown=async()=>{
  state.values[10]=true;state.values[23]=false;
  await nodes(render()).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();
  nodes(render()).find(node=>node.type==='button'&&text(node.props.children)==='준비됐어요 · 3초 뒤 시작').props.onClick();
  render();state.effects.find(effect=>effect.toString().includes('preparation > 1'))();
  return [...state.timers.values()].find(timer=>timer.ms===1000).callback;
};
const pauseResponse=async(url,payload)=>({...info,session:{...info.session,state:payload.action==='start'?'active':'paused'}});
const installPreparationTick=()=>{render();state.effects.find(effect=>effect.toString().includes('preparation > 1'))();return [...state.timers.values()].find(timer=>timer.ms===1000).callback;};
reset();await prepareCountdown();
for(let second=3;second>=1;second--){const tick=[...state.timers.entries()].find(([,timer])=>timer.ms===1000);state.timers.delete(tick[0]);await tick[1].callback();await settle();if(second>1)installPreparationTick();}
check(state.capture?.state==='recording'&&state.deviceRequests===1,'an uninterrupted explicit readiness countdown starts exactly one recorder');

for(const exit of ['pause','hidden','pagehide']){
  reset();state.adapter=pauseResponse;await prepareCountdown();state.timers.clear();state.values[22]=1;const staleTick=installPreparationTick();installVisibility();
  if(exit==='pause')await pauseButton().props.onClick();
  else{if(exit==='hidden')state.visibility='hidden';state.events.get(exit==='hidden'?'visibilitychange':'pagehide')();await settle();}
  check(state.values[22]===null&&state.timers.size===0,`${exit} clears the readiness countdown immediately`);
  await staleTick();await settle();
  check(state.capture===null&&state.tracksStopped===1&&state.cancelledReservations===1,`${exit} cannot start a recorder from a stale countdown and releases its device and reservation`);
  check(state.values[0].session.state==='paused',`${exit} pauses the session as well as readiness`);
  state.visibility='visible';state.events.get('visibilitychange')();render();await settle();
  check(state.capture===null&&state.values[22]===null,`${exit} requires an explicit restart after returning`);
}

reset();state.adapter=pauseResponse;render();
const cleanupPreparation=state.effects.find(effect=>effect.toString().includes('mounted.current = true'))();
await settle();state.values[0]=info;const unmountTick=await prepareCountdown();const cleanupVisibility=installVisibility();cleanupPreparation();cleanupVisibility();await settle();await unmountTick();
const exitPayload=JSON.parse(await state.calls.find(call=>call.beacon).beacon.text());
check(exitPayload.action==='pause'&&exitPayload.sessionId==='session'&&exitPayload.itemIndex===0&&state.capture===null,'route unmount pauses the exact server question before losing preparation ownership and never starts a recorder');
check(state.tracksStopped===1&&state.cancelledReservations===1,'route unmount releases the prepared device and exact reservation');

reset();const staleSaveTick=await prepareCountdown(),draftGate=deferred();state.adapter=async()=>draftGate.promise;
const pendingPause=pauseButton().props.onClick();await settle();
check(state.values[22]===null&&state.values[0].session.state==='paused'&&state.tracksStopped===1,'pause cancels readiness and releases the microphone before a draft save responds');
draftGate.reject(new Error('synthetic draft failure'));await pendingPause;await staleSaveTick();await settle();
check(state.capture===null&&state.values[0].session.state==='paused','failed draft saving cannot revive a cancelled recording countdown');

for(const pending of ['reservation','permission','assert']){
  reset();state.adapter=pauseResponse;state.values[10]=true;state.values[23]=pending!=='assert';const gate=deferred();
  if(pending==='reservation')state.reservationGate=gate.promise;
  if(pending==='permission')state.deviceGate=gate.promise;
  const request=nodes(render()).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();
  await settle();
  if(pending==='assert'){
    await request;state.assertGate=gate.promise;
    nodes(render()).find(node=>node.type==='button'&&text(node.props.children)==='지금 시작').props.onClick();await settle();
  }
  render();installVisibility();state.visibility='hidden';state.events.get('visibilitychange')();await settle();gate.resolve();await request;await settle();
  check(state.capture===null&&state.values[0].session.state==='paused',`hiding during ${pending} cancels the pending recording start`);
  check(state.deviceRequests===(pending==='reservation'?0:1)&&state.tracksStopped===(pending==='reservation'?0:1),`late ${pending} response releases only the owned device`);
}

for(const lateResult of ['permission','permission-error','assert']){
  reset();state.adapter=pauseResponse;state.values[10]=true;state.values[23]=lateResult!=='assert';const gate=deferred();
  if(lateResult.startsWith('permission'))state.deviceGate=gate.promise;
  const oldRequest=nodes(render()).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();await settle();
  if(lateResult==='assert'){await oldRequest;state.assertGate=gate.promise;nodes(render()).find(node=>node.type==='button'&&text(node.props.children)==='지금 시작').props.onClick();await settle();}
  render();installVisibility();state.visibility='hidden';state.events.get('visibilitychange')();await settle();
  // The student explicitly resumes and starts again before the old browser/IDB response arrives.
  state.visibility='visible';state.values[0]=info;state.values[23]=true;state.deviceGate=null;state.assertGate=null;
  await nodes(render()).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();const newCapture=state.capture;
  if(lateResult==='permission-error')gate.reject(new Error('old permission request failed'));else gate.resolve();await oldRequest;await settle();
  check(state.capture===newCapture&&newCapture.state==='recording'&&state.values[11]==='recording',`late ${lateResult} cannot stop or reset a newer explicit recording`);
  state.now=1200;nodes(render()).find(node=>node.type==='button'&&text(node.props.children).startsWith('녹음 완료')).props.onClick();await newCapture.deliverStop();
  check(state.uploads.length===1&&state.values[17]===null,`new recording remains saveable after late ${lateResult}`);
}
reset();state.values[4]='';state.values[17]={blob:new Blob(['private-audio']),index:0,durationMs:1200};tree=render();const autosave=state.effects.find(effect=>effect.toString().includes('450'));autosave();autosave();
check(JSON.parse(state.local.get('gakja-quiz-activity:student:session')).hasRecording===true,'blank text autosave retains first-question audio-only resume evidence');

reset();tree=render();const heading=nodes(tree).find(node=>node.type==='h2'&&node.props.className==='quiz-prompt');let focusOptions,scrollOptions;
heading.props.ref.current={focus:options=>{focusOptions=options;},scrollIntoView:options=>{scrollOptions=options;}};
state.effects.find(effect=>effect.toString().includes('questionHeading.current'))();
check(focusOptions?.preventScroll===true&&scrollOptions?.block==='start'&&scrollOptions?.behavior==='instant','new question gets logical focus and scroll while respecting reduced motion');
console.log(`Quiz recovery: ${checks} handler/render checks passed; no DB, provider or device calls.`);
