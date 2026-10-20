import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {buildSpeechTelemetry} from '../apps/web/src/lib/speech-telemetry.ts';
import {validateSpeechTelemetry} from '../apps/web/src/lib/speech-analysis.ts';

const load=(path,require=()=>{throw new Error('Unexpected import');})=>{const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require,Set});return module.exports;};
const view=load('../apps/web/src/lib/quiz-session-view.ts');
const enterSend=load('../apps/web/src/lib/client/enter-send.ts');
const contracts=load('../packages/content-contracts/src/workflows.ts',name=>name==='./index'?{}:{});
const target={id:'target',university:'서울시립대학교',campus:'본교',department:'환경공학부',admission_year:2027,admission_type:'학생부종합전형Ⅰ(면접형)',interview_stage:'2단계'};
const savedTarget={...target,interview_stage:undefined};
const item={id:'m1',question_id:'q1',prompt:'본인 역할은 무엇인가요?',activity_ids:['a1'],source_kind:'personal',target_id:'target',target_snapshot:savedTarget};
const info={serverTime:new Date().toISOString(),session:{id:'session',student_id:'student',state:'active',mode:'answer',current_index:0,content_version:6,items:[item],metadata:{targetId:'target',targetSnapshot:savedTarget,drafts:{0:{response:'서버에 저장한 초안'}}}},responses:[],recordings:[],learning:{questions:[{id:'q1',prompt:item.prompt}],support_targets:[savedTarget],memory_items:[]}};
const state={values:[],refs:[],hook:0,refHook:0,effects:[],calls:[],toasts:[],listener:null,adapter:null,apiAdapter:null,storage:new Map(),local:new Map(),now:0,capture:null,uploads:[],finishCount:0,tracksStopped:0,captureAvailable:true,uploadError:false,deviceRequests:0,timers:new Map(),confirm:false,events:new Map(),visibility:'visible',deviceGate:null,reservationGate:null,assertGate:null,cancelledReservations:0,live:null,liveGate:null};
let timerId=0;
class FakeRecorder {
  static isTypeSupported(){return true;}
  state='inactive';mimeType='audio/webm';requestedData=0;
  constructor(){state.capture=this;}
  start(){this.state='recording';this.onstart?.();}
  stop(){this.state='inactive';}
  requestData(){this.requestedData++;}
  async deliverStop(){this.ondataavailable?.({data:new Blob(['fake-recorded-audio'],{type:this.mimeType})});await this.onstop?.();}
}
function createDevice(){
  const listeners=new Map(),track={kind:'audio',readyState:'live',muted:false,
    stop(){if(this.readyState==='ended')return;this.readyState='ended';state.tracksStopped++;},
    addEventListener(name,callback){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(callback);},
    removeEventListener(name,callback){listeners.get(name)?.delete(callback);},
    emit(name){if(name==='mute')this.muted=true;if(name==='ended')this.readyState='ended';for(const callback of [...(listeners.get(name)||[])])callback({type:name,target:this});},
  };
  state.track=track;
  return{getTracks:()=>[track],getAudioTracks:()=>[track]};
}
let uuid=0;
const durableAudio=new Map();
const recoveryRemovals=[];
const module={exports:{}};
const actionButton=({pending=false,pendingLabel,disabled,children,type='button',...props})=>({type:'button',props:{...props,type,disabled:disabled||pending,'aria-busy':pending||undefined,children:pending?[{type:'LoaderCircle',props:{size:16,'aria-hidden':true}},pendingLabel??children]:children}});
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/quiz-v3.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,console,Date,Set,JSON,Blob,FormData,URL,URLSearchParams,AbortController,requestAnimationFrame:callback=>{callback();return 1;},cancelAnimationFrame(){},performance:{now:()=>state.now},crypto:{randomUUID:()=>`request-${++uuid}`},setTimeout:(callback,ms)=>{const id=++timerId;state.timers.set(id,{callback,ms});return id;},clearTimeout:id=>state.timers.delete(id),setInterval:(callback,ms)=>{const id=++timerId;state.timers.set(id,{callback,ms});return id;},clearInterval:id=>state.timers.delete(id),HTMLElement:class {},document:{activeElement:null,get visibilityState(){return state.visibility;},addEventListener(name,listener){state.events.set(name,listener);},removeEventListener(name){state.events.delete(name);}},navigator:{sendBeacon:(url,body)=>{state.calls.push({url,beacon:body});return true;},mediaDevices:{getUserMedia:async()=>{state.deviceRequests++;await state.deviceGate;return createDevice();}}},MediaRecorder:FakeRecorder,localStorage:{getItem:key=>state.local.get(key)??null,setItem:(key,value)=>state.local.set(key,value),removeItem:key=>state.local.delete(key)},sessionStorage:{getItem:key=>state.storage.get(key)??null,setItem:(key,value)=>state.storage.set(key,value),removeItem:key=>state.storage.delete(key)},window:{matchMedia:()=>({matches:true}),MediaRecorder:FakeRecorder,confirm:()=>{state.confirmCalls=(state.confirmCalls||0)+1;return state.confirm;},addEventListener:(name,listener)=>{state.events.set(name,listener);if(name==='gakja:open-on')state.listener=listener;},removeEventListener(name){state.events.delete(name);}},require(name){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value)=>value};
  if(name==='@/lib/client/draft-save')return{registerDraftSaver:(userId,save)=>{state.logoutSaver=save;return()=>{if(state.logoutSaver===save)state.logoutSaver=null;};}};
  if(name==='@/lib/client/enter-send')return enterSend;
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
  if(name==='@/lib/client/realtime-transcription')return{connectLiveTranscription:(device,scope,update)=>{const live={scope,update,started:false,closed:false,finished:false,ready:Promise.resolve(state.liveGate),start(){this.started=true;update({phase:'listening',text:''});},close(){this.closed=true;},finish(){this.finished=true;}};state.live=live;return live;}};
  if(name==='@/lib/client/speech-recorder')return{decodeRecordingTelemetry:async()=>{state.decodeCalls=(state.decodeCalls||0)+1;await state.decodeGate;return state.decodeResult??null;},startSpeechCapture(){if(!state.captureAvailable)return null;const started=state.now;return{elapsedMs:()=>state.now-started,dispose(){},pause(){},resume(){},finish(){state.finishCount++;const elapsed=state.now-started;return buildSpeechTelemetry([{atMs:0,rms:0},{atMs:elapsed-.1,rms:.04}],elapsed);}};}};
  if(name==='@/lib/client/recording-recovery')return{installRecordingExitGuard:()=>()=>{},readRecordingRecovery:async scope=>durableAudio.get(JSON.stringify(scope))||null,removeRecordingRecovery:async key=>{recoveryRemovals.push(key);durableAudio.delete(key);},beginRecordingRecovery:async(scope,mimeType)=>{await state.reservationGate;const key=JSON.stringify(scope),chunks=[];let closed=false;return{key,assertActive:async()=>{await state.assertGate;if(closed)throw Error('closed');},assertFresh:()=>{if(closed)throw Error('closed');},cancel:async()=>{if(chunks.length)throw Error('pending audio');closed=true;state.cancelledReservations++;durableAudio.delete(key);},append:async blob=>{if(closed)throw Error("closed");chunks.push(blob);durableAudio.set(key,{...scope,key,blob:new Blob(chunks,{type:mimeType||blob.type}),durationMs:1,complete:false});},finish:async measurement=>{if(closed)throw Error("closed");const saved={...scope,key,blob:new Blob(chunks,{type:mimeType||chunks[0]?.type}),...measurement,complete:true};durableAudio.set(key,saved);return saved;},flush:async()=>{}};}};
  if(name==='@/lib/recording-upload-client')return{uploadRecording:async(url,form)=>{const durationMs=Number(form.get('durationMs')),telemetry=form.get('speechTelemetry')?JSON.parse(form.get('speechTelemetry')):null;assert.ok(!telemetry||validateSpeechTelemetry(telemetry));assert.ok(!telemetry||Math.abs(telemetry.durationMs-durationMs)<=500);state.uploads.push({durationMs,telemetry,blob:form.get('recording')});if(state.uploadError)throw new Error('synthetic upload failed');return{recording:{id:'new-recording',session_id:'session',item_index:0,url:'/owned-recording'}};}};
  if(name==='@gakja/content-contracts/workflows')return contracts;
  if(name==='@/lib/quiz-session-view')return view;
  if(name==='./quiz-session-ui.module.css')return{__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
  throw new Error(name);
}});
const render=()=>{state.hook=0;state.refHook=0;state.effects=[];return module.exports.QuizSession({id:'session'});};
const reset=(dto=info)=>{state.values=[dto,'',false,10,'내 역할은 채취 조건 설계였습니다.'];state.values[23]=true;durableAudio.clear();recoveryRemovals.length=0;state.refs=[];state.effects=[];state.calls=[];state.toasts=[];state.listener=null;state.adapter=null;state.apiAdapter=null;state.storage.clear();state.local.clear();state.now=0;state.capture=null;state.uploads=[];state.finishCount=0;state.tracksStopped=0;state.captureAvailable=true;state.uploadError=false;state.deviceRequests=0;state.timers.clear();state.confirm=false;state.events.clear();state.visibility='visible';state.deviceGate=null;state.reservationGate=null;state.assertGate=null;state.cancelledReservations=0;state.live=null;state.liveGate=null;state.logoutSaver=null;state.decodeResult=buildSpeechTelemetry([{atMs:0,rms:.04},{atMs:1499,rms:.04}],1500);state.decodeCalls=0;state.decodeGate=null;state.confirmCalls=0;};
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
reset({...oralInfo,recordings:[]});state.values[4]='';tree=render();
const oralNodes=nodes(tree),firstRecord=oralNodes.findIndex(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음'),firstEditor=oralNodes.findIndex(node=>node.type==='textarea'&&node.props['aria-label']==='내 답변');
check(firstRecord>=0&&firstRecord<firstEditor,'oral practice puts the recording action before the editor and writing help');
check(oralNodes.some(node=>node.type==='details'&&node.props.className==='answerEditor'&&!node.props.open),'a fresh oral question keeps the optional memo closed');
check(oralNodes.some(node=>node.type==='details'&&node.props.className==='practiceTools'&&!node.props.open)&&oralNodes.some(node=>node.type==='details'&&node.props.className==='selfReview'&&!node.props.open),'help and self reflection stay available without preceding the first recording action');
check(oralNodes.some(node=>node.type==='button'&&text(node.props.children)==='말로 답하기'&&node.props['aria-pressed']===true),'voice is the explicit selected response mode for oral practice');
nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='글로 답하기').props.onClick();tree=render();
check(!nodes(tree).some(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음')&&nodes(tree).some(node=>node.type==='textarea'&&node.props['aria-label']==='내 답변'),'switching to writing exposes the same answer editor without requesting a microphone');
check(state.deviceRequests===0&&state.values[4]==='','response mode selection preserves the draft without opening a microphone');
reset(oralInfo);state.values[9]=oralRecording;tree=render();
check(nodes(tree).some(node=>node.type==='details'&&node.props.className==='answerEditor'&&node.props.open),'a restored recording opens its transcript editor after the recording controls');
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
nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='글로 답하기').props.onClick();tree=render();
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
const installVisibility=()=>state.effects.find(effect=>effect.toString().includes('const hide ='))();
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return{promise,resolve,reject};};
const finishResumeCountdown=async()=>{
  for(let second=3;second>=1;second--){
    render();state.effects.find(effect=>effect.toString().includes('countdown === null'))();
    const timer=[...state.timers.entries()].find(([,value])=>value.ms===400);state.timers.delete(timer[0]);await timer[1].callback();
  }
};
for(const arrival of ['countdown','recording','rejected']){
  reset();const oldPause=deferred();state.adapter=async(url,payload)=>payload.action==='pause'?oldPause.promise:info;
  render();installVisibility();state.visibility='hidden';state.events.get('visibilitychange')();await settle();
  check(state.values[0].session.state==='paused','hiding still pauses the screen immediately while the response is pending');
  state.visibility='visible';nodes(render()).find(node=>node.type==='button'&&text(node.props.children)==='이어서 풀기').props.onClick();
  if(arrival==='countdown'){oldPause.resolve({...info,session:{...info.session,state:'paused'},pauseReceipt:'old'});await settle();check(state.values[0].pauseReceipt!=='old'&&state.values[7]===3,'resume intent rejects an old pause before the start request is sent');}
  await finishResumeCountdown();state.values[10]=true;state.values[23]=true;
  await nodes(render()).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();
  if(arrival==='recording')oldPause.resolve({...info,session:{...info.session,state:'paused'},pauseReceipt:'old'});
  if(arrival==='rejected')oldPause.reject(new Error('old pause response failed'));
  await settle();tree=render();
  check(state.values[0].session.state==='active'&&state.capture?.state==='recording',`late pause ${arrival} cannot replace the resumed session`);
  check(state.values[0].pauseReceipt!=='old'&&state.values[1]==='',`late pause ${arrival} cannot apply stale data or errors`);
  const finish=nodes(tree).find(node=>node.type==='button'&&text(node.props.children).startsWith('녹음 완료'));
  check(!!finish,`the recording stop control remains visible after late pause ${arrival}`);
  state.now=1200;finish.props.onClick();await state.capture.deliverStop();
  check(state.uploads.length===1&&state.values[17]===null,`recording still saves after late pause ${arrival}`);
}
reset();const currentPause=deferred();state.adapter=async()=>currentPause.promise;render();installVisibility();state.visibility='hidden';state.events.get('visibilitychange')();
currentPause.resolve({...info,session:{...info.session,state:'paused'},pauseReceipt:'current'});await settle();
check(state.values[0].pauseReceipt==='current','the current pause response still applies when no newer action has started');
reset();const firstPause=deferred(),secondPause=deferred();let pauseCount=0;
state.adapter=async(url,payload)=>payload.action==='pause'?(++pauseCount===1?firstPause.promise:secondPause.promise):info;
render();installVisibility();state.visibility='hidden';state.events.get('visibilitychange')();state.visibility='visible';nodes(render()).find(node=>node.type==='button'&&text(node.props.children)==='이어서 풀기').props.onClick();await finishResumeCountdown();
render();state.visibility='hidden';state.events.get('visibilitychange')();secondPause.resolve({...info,session:{...info.session,state:'paused'},pauseReceipt:'second'});await settle();
firstPause.resolve({...info,session:{...info.session,state:'paused'},pauseReceipt:'first'});await settle();
check(state.values[0].pauseReceipt==='second','an earlier pause cannot replace the latest pause even when both responses have paused state');
reset();const failedCurrentPause=deferred();state.adapter=async()=>failedCurrentPause.promise;render();installVisibility();state.visibility='hidden';state.events.get('visibilitychange')();failedCurrentPause.reject(new Error('current pause failed'));await settle();
check(state.values[1]==='current pause failed','a current pause error remains visible instead of suppressing all pause errors');
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

for(const pending of ['reservation','permission','realtime']){
  reset(mobilePreparationInfo());state.values[10]=true;state.adapter=pauseResponse;
  const gate=deferred();
  if(pending==='reservation')state.reservationGate=gate.promise;
  if(pending==='permission')state.deviceGate=gate.promise;
  if(pending==='realtime')state.liveGate=gate.promise;
  const preparingRequest=nodes(render()).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();await settle();
  const visiblePause=pauseButton();
  check(visiblePause?.props.disabled===false,`${pending} preparation leaves the rendered pause button enabled so a student can actually cancel it`);
  await visiblePause.props.onClick();gate.resolve();await preparingRequest;await settle();
  check(state.capture===null&&state.values[0].session.state==='paused',`${pending} can be cancelled from the enabled pause control before its delayed response arrives`);
}
function mobilePreparationInfo(){return{...info,session:{...info.session,mode:'oral'}};}

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

// Live captions are separate from the durable answer and cannot reopen cancelled preparation.
reset({...oralInfo,recordings:[]});state.values[10]=true;tree=render();
await nodes(tree).find(n=>n.type==='button'&&text(n.props.children).trim()==='답변 녹음').props.onClick();
const liveAttempt=state.live;liveAttempt.update({phase:'listening',text:'실시간으로 말한 내용'});tree=render();
check(liveAttempt.started&&text(tree).includes('실시간으로 말한 내용'),'live captions appear while the same recording is active');
check(state.values[4]==='내 역할은 채취 조건 설계였습니다.','live captions never overwrite the editable draft');
check(nodes(tree).some(n=>n.type==='button'&&text(n.props.children).startsWith('녹음 완료')),'live captions leave the stop control available');
nodes(tree).find(n=>n.type==='button'&&text(n.props.children).startsWith('녹음 완료')).props.onClick();check(liveAttempt.finished,'stopping the recorder drains the corresponding live connection');
reset({...oralInfo,recordings:[]});state.values[10]=true;let connectDone;state.liveGate=new Promise(resolve=>connectDone=resolve);tree=render();
const pendingConnect=nodes(tree).find(n=>n.type==='button'&&text(n.props.children).trim()==='답변 녹음').props.onClick();await settle();const cancelledLive=state.live;
check(!cancelledLive.started,'the transcription track stays disabled while preparing');
tree=render();state.effects.find(effect=>effect.toString().includes('const hide ='))();state.visibility='hidden';state.events.get('visibilitychange')();
connectDone();await pendingConnect;cancelledLive.update({phase:'listening',text:'취소 후 오래된 전사'});tree=render();
check(cancelledLive.closed&&!cancelledLive.started&&state.values[11]==='idle','hidden preparation closes live transcription without recording');
check(!text(tree).includes('취소 후 오래된 전사'),'late live captions cannot resurrect cancelled preparation');
console.log('Live transcription component checks passed');

// Mobile browsers may suspend JS for minutes after these lifecycle events.
// Freeze at the interruption, preserve final chunks, and wait for an explicit save.
const mobileInfo={...info,session:{...info.session,mode:'oral',metadata:{...info.session.metadata,drafts:{}}},recordings:[]};
const mobileText='전사와 별도로 직접 다듬어 둔 답변';
const mobileResponse=async(url,payload)=>url==='/api/reports'
  ?{rawTranscript:'녹음에서 전사한 말',transcript:'녹음에서 전사한 말.',cleanupStatus:'completed',transcriptionStatus:'completed'}
  :{...mobileInfo,session:{...mobileInfo.session,state:payload.action==='start'?'active':'paused'}};
const startMobileRecording=async({mount=false}={})=>{
  reset(mobileInfo);state.values[10]=true;state.values[4]=mobileText;state.adapter=mobileResponse;
  let cleanup;
  if(mount){render();cleanup=state.effects.find(effect=>effect.toString().includes('mounted.current = true'))();await settle();state.values[0]=mobileInfo;}
  await nodes(render()).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();
  render();installVisibility();
  return cleanup;
};
const interruptMobile=kind=>{
  if(kind==='hidden'){state.visibility='hidden';state.events.get('visibilitychange')();}
  else if(kind==='pagehide'||kind==='freeze')state.events.get(kind)();
  else if(kind==='mute'||kind==='ended')state.track.emit(kind);
  else{if(kind==='recorder-error-inactive')state.capture.state='inactive';state.capture.onerror?.({error:new Error('Synthetic microphone interruption')});}
};
for(const interruption of ['hidden','pagehide','freeze','mute','ended','recorder-error','recorder-error-inactive']){
  await startMobileRecording();const interruptedRecorder=state.capture,interruptedLive=state.live;
  state.now=1500;interruptMobile(interruption);await settle();
  check(interruptedRecorder.state==='inactive',`${interruption} stops the native recorder before the browser can suspend timers`);
  check(state.track.readyState==='ended'&&interruptedLive.closed,`${interruption} closes the original microphone and the realtime clone`);
  check(state.values[0].session.state==='paused',`${interruption} pauses the exact current question`);
  // Returning before the delayed final data event must not convert interruption
  // into an ordinary automatic upload.
  state.visibility='visible';state.events.get('visibilitychange')();
  state.now=181000;await interruptedRecorder.deliverStop();await settle();
  tree=render();
  check(state.values[17]?.durationMs===1500&&state.values[17]?.blob.size>0,`${interruption} freezes 1500ms honestly despite a final stop event delayed past three minutes`);
  check(state.uploads.length===0&&durableAudio.size===1&&recoveryRemovals.length===0,`${interruption} preserves both pending audio and durable recovery without an automatic upload`);
  check(state.values[4]===mobileText&&state.capture===interruptedRecorder&&state.deviceRequests===1,`${interruption} never resumes the microphone or changes the typed answer on return`);
  const retry=nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='녹음 다시 저장');
  check(!!retry,`${interruption} offers an explicit save for the same recovered question`);
  await retry.props.onClick();await settle();
  check(state.calls.some(call=>call.payload?.action==='start'&&call.payload.itemIndex===0)&&state.uploads.length===1&&state.uploads[0].durationMs===1500,`${interruption} explicitly resumes the same question before saving the bounded original`);
  check(state.values[17]===null&&durableAudio.size===0&&state.values[9]?.id==='new-recording',`${interruption} removes only the acknowledged recovery after the server confirms the recording`);
  check(state.values[4]===mobileText&&state.values[9]?.display_transcript==='녹음에서 전사한 말.',`${interruption} keeps the typed edit while making the finished transcription available separately`);
}

await startMobileRecording();state.now=1500;state.capture.stop();await state.capture.deliverStop();await settle();
check(state.values[17]?.durationMs===1500&&state.uploads.length===0&&state.values[0].session.state==='paused','an unsolicited native recorder stop is treated as an interruption with a recoverable original');

await startMobileRecording();state.now=1500;state.capture.stop();state.now=181000;
await state.capture.deliverStop();await settle();tree=render();
check(state.values[17]?.needsMeasurement===true&&state.values[17]?.durationMs===181000&&state.uploads.length===0,'a native stop reported after suspension marks its elapsed clock as untrusted without inventing an audio duration');
check([...durableAudio.values()][0]?.needsMeasurement===true,'the uncertain native-stop measurement flag survives in durable recording recovery');
let measuredRetry=nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='녹음 다시 저장');
check(!!measuredRetry,'an uncertain over-limit clock still exposes original-audio remeasurement and save');
state.decodeResult=buildSpeechTelemetry([{atMs:0,rms:.04},{atMs:1199,rms:.04}],1200);await measuredRetry.props.onClick();await settle();
check(state.decodeCalls===1&&state.uploads.length===1&&state.uploads[0].durationMs===1200,'explicit native-stop recovery measures the actual audio and uploads 1200ms rather than the delayed 181000ms wall clock');
check(state.values[4]===mobileText&&state.values[17]===null,'measured native-stop recovery preserves the edited answer and clears only the acknowledged original');

await startMobileRecording();state.now=1500;state.capture.stop();state.now=181000;
await state.capture.deliverStop();await settle();tree=render();state.decodeResult=null;
measuredRetry=nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='녹음 다시 저장');await measuredRetry.props.onClick();await settle();
check(state.uploads.length===0&&state.values[17]?.needsMeasurement===true&&durableAudio.size===1,'a failed actual-audio measurement leaves the original recoverable and never sends false duration metadata');
check(state.values[4]===mobileText&&state.values[1].includes('재생 시간'),'measurement failure gives a retryable explanation without replacing the student’s typed answer');

await startMobileRecording();state.now=1500;state.capture.stop();await state.capture.deliverStop();await settle();tree=render();
const pendingDecode=deferred();state.decodeGate=pendingDecode.promise;state.confirm=true;
const lockedRetry=nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='녹음 다시 저장');
const lockedDiscard=nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='저장 안 된 녹음 지우기');
const firstRecoverySave=lockedRetry.props.onClick();await settle();
const duplicateRecoverySave=lockedRetry.props.onClick();const blockedDiscard=lockedDiscard.props.onClick();await settle();
check(state.decodeCalls===1&&state.calls.filter(call=>call.payload?.action==='start').length===1,'a double-click during actual-audio measurement starts and decodes the pending original only once');
check(state.confirmCalls===0&&recoveryRemovals.length===0&&state.values[17]?.blob.size>0&&state.uploads.length===0,'discard cannot confirm or delete the original while its explicit recovery save is waiting on measurement');
pendingDecode.resolve();await Promise.all([firstRecoverySave,duplicateRecoverySave,blockedDiscard]);await settle();
check(state.uploads.length===1&&state.values[17]===null&&state.values[4]===mobileText,'the single measured recovery save confirms exactly one upload and preserves the typed answer');

const cleanupDuringDecode=await startMobileRecording({mount:true});state.now=1500;state.capture.stop();await state.capture.deliverStop();await settle();tree=render();
const unmountedDecode=deferred();state.decodeGate=unmountedDecode.promise;
const pendingUnmountSave=nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='녹음 다시 저장').props.onClick();await settle();
check(state.decodeCalls===1&&state.uploads.length===0,'recovery decoding can be interrupted before a new server upload starts');
cleanupDuringDecode();unmountedDecode.resolve();await pendingUnmountSave;await settle();
check(state.uploads.length===0&&durableAudio.size===1&&recoveryRemovals.length===0,'leaving during recovery measurement never starts an unreviewed upload or removes the original');
check(state.values[4]===mobileText&&state.values[17]?.needsMeasurement===true,'leaving during recovery measurement retains the typed edit and the uncertain original for the next visit');

const cleanupDuringRestart=await startMobileRecording({mount:true});state.now=1500;state.capture.stop();await state.capture.deliverStop();await settle();tree=render();
const pendingRestart=deferred();state.adapter=async(url,payload)=>payload.action==='start'?pendingRestart.promise:mobileResponse(url,payload);
const pendingRestartSave=nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='녹음 다시 저장').props.onClick();await settle();
cleanupDuringRestart();pendingRestart.resolve(await mobileResponse('/api/quiz',{action:'start'}));await pendingRestartSave;await settle();
check(state.decodeCalls===0&&state.uploads.length===0&&durableAudio.size===1&&recoveryRemovals.length===0,'leaving while the question restart response is delayed prevents both subsequent decode and upload without deleting the recoverable original');
check(state.values[4]===mobileText,'a late question restart response after leaving cannot replace the student’s edited answer');

await startMobileRecording();const delayedMobilePause=deferred();
state.adapter=async(url,payload)=>payload.action==='pause'?delayedMobilePause.promise:mobileResponse(url,payload);
state.now=1500;interruptMobile('hidden');await settle();state.visibility='visible';state.events.get('visibilitychange')();
await state.capture.deliverStop();await settle();tree=render();
await nodes(tree).find(node=>node.type==='button'&&text(node.props.children)==='녹음 다시 저장').props.onClick();await settle();
delayedMobilePause.resolve({...mobileInfo,session:{...mobileInfo.session,state:'paused'},pauseReceipt:'old-mobile-interruption'});await settle();
check(state.values[0].session.state==='active'&&state.values[0].pauseReceipt!=='old-mobile-interruption'&&state.values[9]?.id==='new-recording','an old mobile interruption pause response cannot replace the explicit recovered save state');
check(state.values[4]===mobileText,'delayed pause completion never replaces the student’s edited answer');
for(const revisit of ['focus','pageshow','visibilitychange','lease-poll']){
  reset(mobileInfo);state.values[4]=mobileText;
  const scope={studentId:'student',sessionId:'session',itemIndex:0,kind:'quiz'},key=JSON.stringify(scope);
  const recovered={...scope,key,blob:new Blob(['recovered-after-lease']),durationMs:1500,complete:true};
  durableAudio.set(key,{...recovered,inUse:true});render();
  const cleanupRecovery=state.effects.find(effect=>effect.toString().includes('const recover ='))();await settle();
  tree=render();
  check(state.values[27]===true&&nodes(tree).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음')?.props.disabled,`${revisit} initially respects the active recording lease and disables a conflicting new recording`);
  check(state.timers.size===1&&[...state.timers.values()][0].ms===5000,`${revisit} schedules a bounded lease recheck while another recording owns the recovery`);
  durableAudio.set(key,{...recovered,inUse:false});
  if(revisit==='lease-poll'){
    const timer=[...state.timers.entries()][0];state.timers.delete(timer[0]);await timer[1].callback();
  }else state.events.get(revisit)();
  await settle();tree=render();
  check(state.values[27]===false&&state.values[17]?.recoveryKey===key&&state.values[17]?.blob.size>0,`${revisit} discovers the same recoverable recording after the previous lease is released`);
  check(state.uploads.length===0&&state.deviceRequests===0&&state.values[4]===mobileText,`${revisit} restores a pending choice without automatic microphone use, upload, or typed-answer replacement`);
  cleanupRecovery();
}
console.log(`Quiz mobile lifecycle: ${checks} total handler/render checks passed; synthetic native events only.`);

// Logout flushes only a draft or private recovery copy. It never publishes an answer.
const registerLogout=()=>{render();state.effects.find(effect=>effect.toString().includes('registerDraftSaver'))();return state.logoutSaver;};
reset();state.adapter=pauseResponse;tree=render();const saveLogout=registerLogout();
nodes(tree).find(node=>node.type==='textarea'&&node.props['aria-label']==='내 답변').props.onChange({target:{value:'디바운스 전 마지막 문장'}});
await saveLogout();
check(state.calls.filter(call=>call.payload).map(call=>call.payload.action).join(',')==='draft,pause','logout saves a draft and pauses without answer/end');
check(state.calls[0].payload.response==='디바운스 전 마지막 문장'&&state.local.get('gakja-quiz:student:session:0')==='디바운스 전 마지막 문장','logout reads the immediate input ref before a debounce or rerender');

reset();state.adapter=async(url,payload)=>{if(payload.action==='draft')throw Error('offline draft');return pauseResponse(url,payload);};
await assert.rejects(registerLogout(),/offline draft/);
check(!state.calls.some(call=>['pause','answer','end'].includes(call.payload?.action))&&state.local.has('gakja-quiz:student:session:0'),'failed server draft blocks logout and keeps the private local text');

reset();state.adapter=pauseResponse;tree=render();const autosaveEffect=()=>state.effects.find(effect=>effect.toString().includes('loadedDraft.current !== draftKey'))();
autosaveEffect();render();autosaveEffect();
const olderDraft=deferred();let draftCount=0;state.adapter=async(url,payload)=>{if(payload.action==='draft'&&++draftCount===1)await olderDraft.promise;return pauseResponse(url,payload);};
const oldTick=[...state.timers.values()].find(timer=>timer.ms===450);oldTick.callback();await settle();tree=render();
nodes(tree).find(node=>node.type==='textarea'&&node.props['aria-label']==='내 답변').props.onChange({target:{value:'이전 저장 뒤에도 남겨야 할 최신 문장'}});
const queuedLogout=registerLogout()();await settle();check(!state.calls.some(call=>call.payload?.action==='pause'),'logout waits for an older queued draft before pausing');
olderDraft.resolve();await queuedLogout;
check(state.calls.filter(call=>call.payload?.action==='draft').at(-1).payload.response==='이전 저장 뒤에도 남겨야 할 최신 문장','the newest text wins after older queued autosave');

await startMobileRecording();state.now=1500;const activeRecordingLogout=registerLogout()();await settle();
check(state.capture.state==='inactive'&&!state.calls.some(call=>call.payload?.action==='pause'),'logout stops capture and waits for final native media events before pause');
await state.capture.deliverStop();await activeRecordingLogout;
check(durableAudio.size===1&&state.uploads.length===0&&recoveryRemovals.length===0,'logout keeps the completed recording in private IDB without upload or deletion');
check(state.calls.some(call=>call.payload?.action==='pause')&&!state.calls.some(call=>['answer','end'].includes(call.payload?.action)),'recording logout pauses after durable preservation without submission');

reset();state.adapter=pauseResponse;state.values[17]={blob:new Blob(['not-durable']),index:0,durationMs:1500,recoveryKey:'missing',complete:true};
await assert.rejects(registerLogout(),/녹음의 기기 저장/);
check(!state.calls.some(call=>call.payload?.action==='pause'),'missing recording readback blocks logout while the original remains in memory');

reset();state.adapter=pauseResponse;state.values[10]=true;const latePermission=deferred();state.deviceGate=latePermission.promise;tree=render();
const openingMicrophone=nodes(tree).find(node=>node.type==='button'&&text(node.props.children).trim()==='답변 녹음').props.onClick();await settle();
await registerLogout()();latePermission.resolve();await openingMicrophone;await settle();
check(state.capture===null&&state.uploads.length===0&&state.tracksStopped===1&&state.values[0].session.state==='paused','logout cancels recording preparation and a late permission cannot start capture or upload');

reset({...info,session:{...info.session,items:[item,{...item,id:'m2',question_id:'q2'}]}});const submittedAnswer=deferred();
const afterAnswer={...info,session:{...info.session,state:'ready',current_index:1,items:[item,{...item,id:'m2',question_id:'q2'}],metadata:{drafts:{1:{response:'다음 질문에 미리 적은 초안'}}}},responses:[{id:'saved-text',item_index:0,response:'내 역할은 채취 조건 설계였습니다.',data:{}}]};
state.adapter=async(url,payload)=>{if(payload.action==='answer'){await submittedAnswer.promise;return {...afterAnswer,response:afterAnswer.responses[0]};}return {...afterAnswer,session:{...afterAnswer.session,state:'paused'}};};
tree=render();const submittingText=saveButton(tree).props.onClick();await settle();const leavingAfterAnswer=registerLogout()();await settle();
submittedAnswer.resolve();await submittingText;await leavingAfterAnswer;
const nextDraft=state.calls.find(call=>call.payload?.action==='draft');
check(nextDraft?.payload.itemIndex===1&&nextDraft.payload.response==='다음 질문에 미리 적은 초안','a text answer completed during logout never becomes the next question’s draft before React effects run');
console.log(`Quiz logout draft/media checks passed: ${checks} total; no DB, provider or real microphone calls.`);
