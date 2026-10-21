import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import {registerDraftSaver,flushPendingDrafts} from '../apps/web/src/lib/client/draft-save.ts';
import {InterviewerAvatarSignal} from '../apps/web/src/lib/client/interviewer-avatar.ts';

const fixture=()=>({session:{id:'live-session',student_id:'student',state:'active',kind:'video',supportTarget:{id:'target',university:'고려대학교',department:'경영학과'},practiceLabel:'일반 경험 면접',data:{practiceScope:'personal_record',practiceNotice:'학교별 실제 전형을 재현하지 않는 내 경험 연습이에요.',context:{contentVersion:'7',questions:[],activities:[],sources:[]},generation:0,index:0,paused:true,panelists:[{id:'A',name:'면접관 A',gender:'female'},{id:'B',name:'면접관 B',gender:'male'}]}},
  question:{id:'question',turnId:'turn',prompt:'맡은 역할은 무엇인가요?',speakerId:'A'},turns:[] as any[],report:null as any});

function harness(file='live-interview-session.tsx',initialInfo:any=fixture(),recovery:any=null,onTrainingUpdate?:Function){
  const values:any[]=[],deps:any[]=[],effects:Function[]=[],cleanups:Function[]=[];
  const calls:any[]=[],listeners=new Map<string,Function>(),controllers:any[]=[],destinations:string[]=[],frames:Function[]=[],storage=new Map<string,string>();
  const faults={suspend:undefined as Promise<void>|undefined,allowDevice:false,recovery,apiInfo:initialInfo,uploadReceipt:{media:{id:'new-server-media'}} as any,recoveryKey:'reserved-writer-attempt',assertActiveError:undefined as Error|undefined,assertFreshError:undefined as Error|undefined,mobile:false,reducedMotion:false,scrollPadding:80,textInput:null as any,appData:{user:{id:'student'},preferences:{} as any},preferenceError:undefined as Error|undefined,preferencePending:undefined as Promise<void>|undefined,reflectPreferenceInBootstrap:true,serverPreferences:null as any,refreshPending:undefined as Promise<void>|undefined,refreshUpdatesPreferences:false};
  const draftFaults={preservedRecording:undefined as any,preservePending:undefined as Promise<void>|undefined,preserveError:undefined as Error|undefined,recoveryReadError:undefined as Error|undefined,draftError:undefined as Error|undefined,helpPauseError:undefined as Error|undefined,suspendError:undefined as Error|undefined,storageError:undefined as Error|undefined,storageMismatch:false};
  const rtcFaults={enabled:false,playError:undefined as Error|undefined,closeResult:true,closePending:undefined as Promise<void>|undefined,capture:false,captureOptions:null as any};
  let index=0;
  const events=(prefix:string)=>({addEventListener:(name:string,fn:Function)=>listeners.set(prefix+name,fn),removeEventListener:(name:string)=>listeners.delete(prefix+name)});
  const document={...events('document:'),visibilityState:'visible',scrollingElement:{},getElementById:()=>faults.textInput,querySelector:()=>({getBoundingClientRect:()=>({bottom:64})})};
  const location={href:'http://fixture.test/interview/live-session',origin:'http://fixture.test',pathname:'/interview/live-session',search:'',assign:(url:string)=>destinations.push(url)};
  class Controller {
    state:any;services:any;changed:Function;
    constructor(info:any,services:any,changed:Function){this.state={phase:info.session.state==='completed'?'complete':'idle',info,error:''};this.services=services;this.changed=changed;controllers.push(this);}
    emit(patch:any){this.state={...this.state,...patch};this.changed(this.state);}
    async start(){calls.push({controller:'start'});this.emit({phase:'preparing'});}
    async rerecord(){calls.push({controller:'rerecord'});this.emit({phase:'preparing'});}
    async preserveAnswer(){calls.push({controller:'preserveAnswer'});this.pause();await draftFaults.preservePending;if(draftFaults.preserveError)throw draftFaults.preserveError;return draftFaults.preservedRecording??this.state.recording;}
    async resetDevices(){calls.push({controller:'resetDevices'});this.pause();this.services.release();}
    async acceptTypedAnswer(info:any){calls.push({controller:'acceptTypedAnswer'});this.emit({info,phase:'paused'});}
    restoreRecording(recording:any,question:any,generation:number){calls.push({controller:'restoreRecording',recording,question,generation});this.emit({recording});return true;}
    pause(){calls.push({controller:'pause'});this.emit({phase:'paused'});}
    finishAnswer(){calls.push({controller:'finishAnswer'});}
    async finish(options?:any){calls.push({controller:'finish',options});}
    dispose(){calls.push({controller:'dispose'});}
  }
  const react={useState(initial:any){const slot=index++;if(!(slot in values))values[slot]=typeof initial==='function'?initial():initial;return [values[slot],(value:any)=>values[slot]=typeof value==='function'?value(values[slot]):value];},useRef(initial:any){const slot=index++;return values[slot]??(values[slot]={current:initial});},useEffect(fn:Function,next:any[]){const slot=index++;if(!deps[slot]||next?.some((value,i)=>value!==deps[slot][i])){deps[slot]=next;effects.push(()=>{cleanups[slot]?.();cleanups[slot]=fn();});}}};
  const mod={exports:{} as any};
  vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/components/'+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
    module:mod,exports:mod.exports,Date,crypto:{randomUUID},URL:class extends URL{static createObjectURL(){return 'blob:synthetic-recording';}static revokeObjectURL(){}},Blob,DOMException,AbortController,FormData,
    localStorage:{setItem(key:string,value:string){calls.push({storage:'set',key,value});if(draftFaults.storageError)throw draftFaults.storageError;storage.set(key,value);},getItem(key:string){calls.push({storage:'get',key});if(draftFaults.storageError)throw draftFaults.storageError;return draftFaults.storageMismatch?'wrong value':storage.get(key)??null;},removeItem(key:string){storage.delete(key);}},
    document,location,window:{...events('window:'),navigation:events('navigation:'),confirm:()=>true,matchMedia:(query:string)=>({matches:query.includes('reduced-motion')?faults.reducedMotion:faults.mobile}),getComputedStyle:()=>({scrollPaddingTop:faults.scrollPadding+'px'})},
    requestAnimationFrame:(callback:Function)=>{frames.push(callback);return frames.length;},
    navigator:{mediaDevices:{getUserMedia:async(constraints:any)=>{if(!faults.allowDevice)throw Error('Unexpected microphone access in render regression');calls.push({mockDevice:true,constraints});return {getTracks:()=>[],getAudioTracks:()=>[]};}}},
    Audio:class {src='';onended:Function|null=null;onerror:Function|null=null;async play(){calls.push({audio:'unlock'});if(this.src.startsWith('blob:'))this.onended?.();}pause(){}},
    setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},
    fetch:async(_url:string,init:any)=>{calls.push({keepalive:!!init.keepalive,body:JSON.parse(init.body)});return {ok:true,blob:async()=>new Blob(['synthetic interviewer output'],{type:'audio/mpeg'})};},
    require(name:string){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};
      if(name==='react')return react;
      if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props}),Fragment:'Fragment'};
      if(name==='next/link')return {__esModule:true,default:'Link'};
      if(name==='next/navigation')return {useRouter:()=>({push:(href:string)=>destinations.push(href)})};
      if(name==='./app-shell')return {useApp:()=>({data:faults.appData,refresh:async()=>{calls.push({refresh:true});await faults.refreshPending;if(faults.refreshUpdatesPreferences&&faults.serverPreferences)faults.appData.preferences=structuredClone(faults.serverPreferences);}})};
      if(name==='./shared')return {action:async(action:string,payload:any)=>{calls.push({action,payload});await faults.preferencePending;if(faults.preferenceError)throw faults.preferenceError;faults.serverPreferences={...(faults.serverPreferences||faults.appData.preferences),...payload};if(faults.reflectPreferenceInBootstrap)faults.appData.preferences=structuredClone(faults.serverPreferences);return {preferences:structuredClone(faults.serverPreferences)};},api:async(url:string)=>{calls.push({api:url});return url==='/api/interviews/realtime'?{enabled:rtcFaults.enabled}:structuredClone(faults.apiInfo);},post:async(url:string,body:any)=>{calls.push({url,body});if(body.action==='draft'&&draftFaults.draftError)throw draftFaults.draftError;if(body.action==='pause'&&draftFaults.helpPauseError)throw draftFaults.helpPauseError;if(body.action==='suspend'){await faults.suspend;if(draftFaults.suspendError)throw draftFaults.suspendError;}return {};},Breadcrumb:'Breadcrumb',InfoTip:'InfoTip',Modal:'Modal',Alert:'Alert',targetName:(target:any)=>target?.university||'지원처 미등록'};
      if(name==='@/lib/client/draft-save')return {registerDraftSaver:(userId:string,save:()=>Promise<void>)=>{calls.push({draftSaver:'registered',userId});const remove=registerDraftSaver(userId,save);return()=>{calls.push({draftSaver:'removed',userId});remove();};}};
      if(name==='@/lib/client/live-interview-controller')return {LiveInterviewController:Controller};
      if(name==='@/lib/client/interviewer-avatar')return {InterviewerAvatarSignal};
      if(name==='@/lib/client/interviewer-audio-output')return {InterviewerAudioOutput:class{constructor(public element:any,private signal:InterviewerAvatarSignal){}async unlock(){}syncState(state:any,id:string){this.signal.state(state,id);}select(id:string){this.signal.state('thinking',id);}stop(){this.element.pause();this.signal.silence();}clear(){this.stop();}dispose(){this.stop();}}};
      if(name==='@/lib/client/realtime-interview')return {connectRealtimeInterview:(stream:any,scope:any,question:any,output:any,update:Function)=>{if(!rtcFaults.enabled)throw Error('Unexpected RTC access while the flag is off');calls.push({rtc:'connect',stream,scope,question,output});return {async playQuestion(){calls.push({rtc:'playQuestion'});if(rtcFaults.playError)throw rtcFaults.playError;},startInput(){calls.push({rtc:'startInput'});update({phase:'listening',preview:'자막 미리보기 원문'});},finishInput(){calls.push({rtc:'finishInput'});},async close(){calls.push({rtc:'close'});await rtcFaults.closePending;return rtcFaults.closeResult;}};}};
      if(name==='@/lib/client/live-interview-recorder')return {createLiveAnswerCapture:(_stream:any,options:any)=>{calls.push({recorder:true});if(!rtcFaults.capture)throw Error('Unexpected recorder access');rtcFaults.captureOptions=options;return {stop(){}};}};
      if(name==='@/lib/client/recording-recovery')return {
        readRecordingRecovery:async(scope:any)=>{calls.push({recovery:'read',scope});if(draftFaults.recoveryReadError)throw draftFaults.recoveryReadError;return faults.recovery;},
        recordingRecoveryKey:()=> 'legacy-scope-key',
        removeRecordingRecovery:async(key:string)=>calls.push({recovery:'removed',key}),
        beginRecordingRecovery:async(scope:any)=>{const key=faults.recoveryKey;calls.push({recovery:'begin',scope,key});return {key,append:async()=>{},appendAnalysis:async()=>{},finish:async()=>{calls.push({recovery:'finish',key});},flush:async()=>{calls.push({recovery:'flush',key});},assertActive:async()=>{calls.push({recovery:'assertActive',key});if(faults.assertActiveError)throw faults.assertActiveError;},assertFresh:()=>{calls.push({recovery:'assertFresh',key});if(faults.assertFreshError)throw faults.assertFreshError;},cancel:async()=>{calls.push({recovery:'cancelled',key});}};},
      };
      if(name==='@/lib/recording-upload-client')return {uploadRecording:async(url:string,form:FormData)=>{calls.push({upload:true,url,form});return faults.uploadReceipt;}};
      if(name==='./live-interviewer-stage')return {LiveInterviewerStage:'LiveInterviewerStage'};
      if(name==='./live-interview-session')return {LiveInterviewSession:'LiveInterviewSession'};
      if(name.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
      return new Proxy({},{get:(_,key)=>String(key)});
    },
  });
  function render(){index=0;const tree=file==='interview.tsx'?mod.exports.InterviewSession({id:'live-session',kind:initialInfo.routeKind||'chat'}):mod.exports.LiveInterviewSession({id:'live-session',initialInfo,onTrainingUpdate});while(effects.length)effects.shift()!();return tree;}
  return {render,values,calls,listeners,document,destinations,controllers,faults,draftFaults,rtcFaults,storage,frames,flushFrames:()=>{while(frames.length)frames.shift()!();},flush:()=>new Promise(resolve=>setImmediate(resolve)),cleanup:()=>cleanups.forEach(fn=>fn?.())};
}
function nodes(tree:any):any[]{return Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];}
function text(tree:any):string{return Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):tree==null?'':String(tree);}
function button(tree:any,label:string){const value=nodes(tree).find(node=>node.type==='button'&&text(node)===label);assert.ok(value,'button: '+label);return value;}
function consent(tree:any){const label=nodes(tree).find(node=>node.type==='label'&&text(node).includes('저장과 답변 전사'));assert.ok(label);return nodes(label).find(node=>node.type==='input');}
function emit(h:ReturnType<typeof harness>,patch:any){h.controllers[0].emit(patch);return h.render();}

test('the Live room is silent before consent and has no editable answer composer',async()=>{
  const h=harness();let tree=h.render();assert.equal(button(tree,'면접 시작').props.disabled,true);assert.equal(h.calls.some(call=>call.controller==='start'||call.audio),false);
  assert.equal(nodes(tree).some(node=>node.type==='textarea'||node.type==='ChatComposer'||node.props?.contentEditable),false);
  assert.ok(nodes(tree).filter(node=>node.type==='input').every(node=>node.props.type==='checkbox'));
  consent(tree).props.onChange({target:{checked:true}});await h.flush();tree=h.render();assert.equal(button(tree,'면접 시작').props.disabled,false);button(tree,'면접 시작').props.onClick();
  assert.equal(h.calls.filter(call=>call.controller==='start').length,1);assert.ok(h.calls.some(call=>call.audio==='unlock'));h.cleanup();
});

test('a first diagnostic opens its question and typed answer without a device or simulated panel',async()=>{
 const info=fixture();info.session.data.trainingPurpose='diagnostic';info.session.data.trainingPlanId='diagnostic-plan';
 const h=harness('live-interview-session.tsx',info);h.render();await h.flush();const tree=h.render();
 assert.ok(nodes(tree).some(node=>node.type==='ChatComposer'));assert.equal(nodes(tree).find(node=>node.type==='LiveInterviewerStage').props.diagnostic,true);
 assert.equal(h.calls.some(call=>call.mockDevice||call.audio||call.controller==='start'),false);assert.match(text(tree),/첫 진단/);assert.ok(button(tree,'음성으로 답하기'));h.cleanup();
});
test('saved account consent and camera choice reopen collapsed without device access until the student starts',async()=>{
  const h=harness();h.faults.appData.preferences={liveRecordingConsent:true,liveCameraEnabled:false};h.render();await h.flush();let tree=h.render();
  assert.equal(consent(tree).props.checked,true);assert.equal(button(tree,'면접 시작').props.disabled,false);
  assert.equal(nodes(tree).find(node=>node.props?.className==='recordingSettings').props.open,false);
  assert.equal(h.calls.some(call=>call.mockDevice||call.audio||call.action==='preference'),false);
  h.faults.allowDevice=true;await h.controllers[0].services.prepare();
  const camera=nodes(tree).find(node=>node.type==='label'&&text(node).includes('카메라 함께 사용'));
  assert.equal(nodes(camera).find(node=>node.type==='input').props.checked,false);
  assert.equal(h.calls.filter(call=>call.mockDevice).length,1);assert.equal(h.calls.find(call=>call.mockDevice).constraints.video,false);h.cleanup();
});
test('a failed or pending consent save cannot enable recording and revocation persists for another room',async()=>{
  const h=harness();let release!:()=>void;h.faults.preferencePending=new Promise<void>(resolve=>release=resolve);let tree=h.render();
  consent(tree).props.onChange({target:{checked:true}});tree=h.render();
  assert.equal(button(tree,'면접 시작').props.disabled,true);button(tree,'면접 시작').props.onClick();assert.equal(h.calls.some(call=>call.controller==='start'),false);
  h.faults.preferenceError=Error('설정 저장 연결 오류');release();await h.flush();tree=h.render();assert.equal(consent(tree).props.checked,false);assert.match(text(tree),/설정 저장 연결 오류/);
  h.faults.preferenceError=undefined;h.faults.preferencePending=undefined;consent(tree).props.onChange({target:{checked:true}});await h.flush();tree=h.render();
  assert.equal(h.faults.appData.preferences.liveRecordingConsent,true);assert.equal(button(tree,'면접 시작').props.disabled,false);
  consent(tree).props.onChange({target:{checked:false}});await h.flush();tree=h.render();assert.equal(h.faults.appData.preferences.liveRecordingConsent,false);assert.equal(button(tree,'면접 시작').props.disabled,true);
  const next=harness();next.faults.appData.preferences=structuredClone(h.faults.appData.preferences);assert.equal(consent(next.render()).props.checked,false);h.cleanup();next.cleanup();
});
test('a delayed same-student bootstrap refresh updates a newly opened room and never rolls back an acknowledged consent',async()=>{
  const h=harness();let release!:()=>void;h.faults.reflectPreferenceInBootstrap=false;h.faults.refreshUpdatesPreferences=true;h.faults.refreshPending=new Promise<void>(resolve=>release=resolve);
  let tree=h.render();consent(tree).props.onChange({target:{checked:true}});await h.flush();tree=h.render();
  assert.equal(consent(tree).props.checked,true);assert.equal(h.faults.appData.preferences.liveRecordingConsent,undefined);assert.equal(button(tree,'면접 시작').props.disabled,true,'voice waits until the refresh after the save settles');
  // A different preference revision can arrive with a stale consent while this save is refreshing.
  h.faults.appData.preferences={liveRecordingConsent:false,liveCameraEnabled:false};h.render();assert.equal(consent(h.render()).props.checked,true,'the actual server save receipt wins over older bootstrap values');
  const next=harness();next.faults.appData.preferences=structuredClone(h.faults.appData.preferences);next.render();assert.equal(consent(next.render()).props.checked,false);
  release();await h.flush();h.render();next.faults.appData.preferences=structuredClone(h.faults.appData.preferences);next.render();tree=next.render();
  assert.equal(consent(tree).props.checked,true);assert.equal(nodes(tree).find(node=>node.props?.className==='recordingSettings').props.open,false,'same-user bootstrap changes restore the remembered collapsed setup');h.cleanup();next.cleanup();
});
test('camera-without-video recovery starts only after a successful save using the newly acknowledged camera choice',async()=>{
  const h=harness();h.faults.appData.preferences={liveRecordingConsent:true,liveCameraEnabled:true};h.render();await h.flush();let tree=emit(h,{phase:'error',error:'카메라 권한을 확인해 주세요.'});
  h.faults.preferenceError=Error('카메라 설정 저장 오류');button(tree,'카메라 없이 계속').props.onClick();await h.flush();tree=h.render();assert.equal(h.calls.some(call=>call.controller==='start'||call.audio),false);assert.match(text(tree),/카메라 설정 저장 오류/);
  h.faults.preferenceError=undefined;button(tree,'카메라 없이 계속').props.onClick();await h.flush();assert.equal(h.calls.filter(call=>call.controller==='start').length,1);
  h.faults.allowDevice=true;await h.controllers[0].services.prepare();assert.equal(h.calls.find(call=>call.mockDevice).constraints.video,false);assert.equal(h.faults.serverPreferences.liveCameraEnabled,false);h.cleanup();
});
test('voice mode stays handsfree with explicit thinking and same-question text alternatives',()=>{
  const h=harness();h.render();const tree=emit(h,{phase:'listening',progress:{durationMs:3200,measurementAvailable:true,endingSoon:false}});
  assert.deepEqual(nodes(tree).filter(node=>node.type==='button').map(text).sort(),['답변 마침','면접 종료','일시정지','잠깐 생각할게요','이번 질문은 글로 답하기'].sort());
  button(tree,'답변 마침').props.onClick();assert.ok(h.calls.some(call=>call.controller==='finishAnswer'));
  button(tree,'일시정지').props.onClick();assert.equal(h.controllers[0].state.phase,'paused');
  const paused=h.render();assert.ok(button(paused,'계속하기'));assert.ok(!nodes(paused).some(node=>node.type==='button'&&text(node)==='답변 마침'));h.cleanup();
});
test('text alternative opens only on explicit selection and preserves the active question without a microphone',async()=>{
  const h=harness();let tree=h.render();assert.equal(nodes(tree).some(node=>node.type==='ChatComposer'),false);
  button(tree,'이번 질문은 글로 답하기').props.onClick();await h.flush();tree=h.render();
  const composer=nodes(tree).find(node=>node.type==='ChatComposer');assert.ok(composer);
  assert.equal(nodes(tree).find(node=>node.type==='LiveInterviewerStage').props.question,'맡은 역할은 무엇인가요?');assert.ok(text(tree).includes('고려대학교'));
  composer.props.onChange('팀원의 자료 형식을 하나로 정리했습니다.');tree=h.render();
  assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.value,'팀원의 자료 형식을 하나로 정리했습니다.');
  assert.equal(h.calls.some(call=>call.mockDevice||call.audio),false);assert.ok(h.calls.some(call=>call.controller==='preserveAnswer'));h.cleanup();
});

test('Live text answers respect the current account Enter-to-send preference',async(t)=>{
  const h=harness();t.after(()=>h.cleanup());let tree=h.render();button(tree,'이번 질문은 글로 답하기').props.onClick();await h.flush();tree=h.render();assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.enterToSend,true);
  h.faults.appData.preferences={enterToSend:false};tree=h.render();assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.enterToSend,false);h.faults.appData.preferences={enterToSend:true};tree=h.render();assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.enterToSend,true);
});

test('mobile text mode places input after the question and focuses only on explicit transitions or a new submitted question',async()=>{
  const h=harness(),scrolled:any[]=[],focused:any[]=[],questionArea={style:{} as any,scrollIntoView:(options:any)=>scrolled.push(options)};
  h.faults.mobile=true;h.faults.textInput={disabled:false,focus:(options:any)=>focused.push(options),closest:()=>({parentElement:{querySelector:()=>questionArea}})};
  let tree=h.render();assert.equal(h.frames.length,0,'initial load does not move or focus the page');
  button(tree,'이번 질문은 글로 답하기').props.onClick();await h.flush();tree=h.render();
  const workspace=nodes(tree).find(node=>node.props?.className==='workspace'),children=nodes(workspace);
  const composer=children.find(node=>node.type==='ChatComposer'),camera=children.find(node=>node.props?.className==='cameraPanel');
  assert.ok(children.indexOf(composer)>children.findIndex(node=>node.type==='LiveInterviewerStage')&&children.indexOf(composer)<children.indexOf(camera),'the same-question input precedes camera and voice-return controls');
  assert.equal(tree.props['data-answer-mode'],'text');assert.ok(consent(tree),'voice consent remains available');
  h.flushFrames();assert.equal(focused.length,1);assert.equal(focused[0].preventScroll,true);assert.equal(scrolled[0].behavior,'smooth');assert.equal(questionArea.style.scrollMarginTop,'0px','document header padding is not counted twice');
  h.render();h.render();assert.equal(h.frames.length,0,'ordinary refreshes and rerenders never trigger scrolling');
  composer.props.onChange('직접 조건을 비교했습니다.');tree=h.render();
  const next=fixture();next.question={...next.question,turnId:'next-turn',prompt:'어떤 조건을 비교했나요?'};h.faults.apiInfo=next;
  nodes(tree).find(node=>node.type==='ChatComposer').props.onSend();await h.flush();h.render();tree=h.render();
  h.faults.reducedMotion=true;h.faults.scrollPadding=0;h.flushFrames();assert.equal(focused.length,2);assert.equal(scrolled[1].behavior,'auto');assert.equal(questionArea.style.scrollMarginTop,'80px');
  assert.equal(nodes(tree).find(node=>node.type==='LiveInterviewerStage').props.question,next.question.prompt);assert.ok(button(tree,'음성 면접으로 돌아가기'));h.cleanup();
});
test('after the first typed answer the paused room exposes consent before returning to voice without an existing microphone',async()=>{
  const h=harness();let tree=h.render();
  button(tree,'이번 질문은 글로 답하기').props.onClick();await h.flush();tree=h.render();
  let composer=nodes(tree).find(node=>node.type==='ChatComposer');assert.ok(composer);
  composer.props.onChange('측정 조건을 맞추기 위해 같은 시간에 다시 측정하자고 제안했습니다.');tree=h.render();
  assert.equal(button(tree,'음성 면접으로 돌아가기').props.disabled,true,'a typed draft and missing consent keep the voice transition disabled');
  const next=fixture();next.question={...next.question,id:'followup',turnId:'followup-turn',prompt:'같은 시간을 선택한 이유는 무엇인가요?'};
  next.turns=[{id:'turn',question:'맡은 역할은 무엇인가요?',answer:'측정 조건을 맞추기 위해 같은 시간에 다시 측정하자고 제안했습니다.',submissionSource:'text'}];
  h.faults.apiInfo=next;
  composer=nodes(tree).find(node=>node.type==='ChatComposer');composer.props.onSend();await h.flush();h.render();tree=h.render();
  assert.equal(h.controllers[0].state.phase,'paused');
  assert.ok(h.calls.some(call=>call.body?.action==='answer'&&call.body.turnId==='turn'));
  assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.value,'','the next question receives its own empty draft');
  assert.equal(nodes(tree).find(node=>node.type==='LiveInterviewerStage').props.question,next.question.prompt);
  assert.equal(consent(tree).props.checked,false,'paused without a microphone still presents the recording consent control');
  assert.equal(button(tree,'음성 면접으로 돌아가기').props.disabled,true);
  assert.match(text(tree),/음성으로 바꾸려면 위에서 저장·전사 동의를 선택/);
  button(tree,'음성 면접으로 돌아가기').props.onClick();assert.equal(h.calls.some(call=>call.controller==='start'||call.mockDevice||call.audio),false,'a direct click cannot bypass consent');
  consent(tree).props.onChange({target:{checked:true}});await h.flush();tree=h.render();
  assert.equal(button(tree,'음성 면접으로 돌아가기').props.disabled,false);
  assert.ok(!text(tree).includes('음성으로 바꾸려면 위에서 저장·전사 동의를 선택'));
  button(tree,'음성 면접으로 돌아가기').props.onClick();tree=h.render();
  assert.equal(h.calls.filter(call=>call.controller==='start').length,1);
  assert.equal(nodes(tree).some(node=>node.type==='ChatComposer'),false,'the same next question returns to voice mode after consent');
  h.cleanup();
});

test('actual server target and question fields remain visible in read-only history',()=>{
  const info=fixture();info.turns=[{id:'answered',question:'갈등을 해결한 과정을 말해 주세요.',answer:'팀원 의견을 정리하고 역할을 나눴습니다.'},{id:'invalid',question:'폐기 질문',answer:'폐기 답변',invalidated:true}];
  const h=harness(undefined,info),tree=h.render();assert.ok(text(tree).includes('고려대학교'));assert.ok(text(tree).includes('경영학과'));assert.ok(text(tree).includes(info.session.practiceLabel));assert.ok(text(tree).includes(info.session.data.practiceNotice));assert.ok(text(tree).includes('갈등을 해결한 과정을 말해 주세요.'));assert.ok(!text(tree).includes('폐기 답변'));
  const history=nodes(tree).find(node=>node.type==='details'&&node.props.className==='history');assert.ok(history);assert.equal(history.props.open,undefined);assert.ok(!nodes(history).some(node=>['textarea','input','button','ChatComposer'].includes(node.type)));assert.ok(text(history).includes('팀원 의견을 정리하고 역할을 나눴습니다.'));h.cleanup();
});

test('finishing a typed Live interview removes its composer even when the last question is retained',async()=>{
  const h=harness();let tree=h.render();
  button(tree,'이번 질문은 글로 답하기').props.onClick();await h.flush();tree=h.render();
  assert.ok(nodes(tree).some(node=>node.type==='ChatComposer'));
  button(tree,'면접 종료').props.onClick();tree=h.render();
  const final=fixture();final.session.state='completed';final.report={id:'saved-report'};h.faults.apiInfo=final;
  button(tree,'저장 후 종료').props.onClick();await h.flush();tree=h.render();
  assert.match(text(tree),/여기까지 저장했어요/);
  assert.ok(!nodes(tree).some(node=>node.type==='ChatComposer'));
  assert.ok(!nodes(tree).some(node=>node.type==='button'&&text(node)==='면접 종료'));
  h.cleanup();
});
test('permission recovery still requires consent if the student withdraws it',async()=>{
  const h=harness();let tree=h.render();consent(tree).props.onChange({target:{checked:true}});await h.flush();tree=emit(h,{phase:'error',error:'마이크 권한을 확인해 주세요.'});
  consent(tree).props.onChange({target:{checked:false}});await h.flush();tree=h.render();assert.equal(button(tree,'계속하기').props.disabled,true);button(tree,'계속하기').props.onClick();assert.equal(h.calls.some(call=>call.controller==='start'),false);h.cleanup();
});
test('recording recovery offers a distinct same-question rerecord action gated by consent',async()=>{
  const h=harness();let tree=h.render();consent(tree).props.onChange({target:{checked:true}});await h.flush();
  tree=emit(h,{phase:'error',error:'음성 전사를 다시 시도해 주세요.',recording:{blob:new Blob(['synthetic audio'],{type:'audio/webm'}),measurementAvailable:true,speechStarted:true,durationMs:2000}});
  assert.ok(button(tree,'보관한 답변 저장하고 계속'));assert.equal(button(tree,'같은 질문 다시 녹음').props.disabled,false);
  button(tree,'같은 질문 다시 녹음').props.onClick();await h.flush();assert.equal(h.calls.filter(call=>call.controller==='rerecord').length,1);assert.equal(h.calls.some(call=>call.controller==='start'),false);
  tree=emit(h,{phase:'error'});consent(tree).props.onChange({target:{checked:false}});await h.flush();tree=h.render();assert.equal(button(tree,'같은 질문 다시 녹음').props.disabled,true);button(tree,'같은 질문 다시 녹음').props.onClick();assert.equal(h.calls.filter(call=>call.controller==='rerecord').length,1);h.cleanup();
});
test('the completed room links to its report and cannot restart recording',()=>{
  const info=fixture();info.session.state='completed';info.report={id:'saved-report'};info.turns=[{id:'answered',question:'역할은?',answer:'자료를 정리했습니다.'}];
  const h=harness(undefined,info),tree=h.render();assert.ok(nodes(tree).some(node=>node.type==='Link'&&node.props.href==='/records/reports/saved-report'));assert.equal(nodes(tree).some(node=>node.type==='button'||node.type==='input'),false);assert.ok(!nodes(tree).some(node=>node.type==='LiveInterviewerStage'));h.cleanup();
});

test('completed unified training delegates its answer history to the wrapper while active and standalone rooms keep history',()=>{
  const info=fixture();info.turns=[{id:'answer',question:'질문 원문',answer:'저장한 답변 원문',submissionSource:'text'}];
  const updates:any[]=[],training=harness(undefined,info,null,(value:any)=>updates.push(value));
  assert.ok(nodes(training.render()).some(node=>node.type==='details'&&node.props.className==='history'),'the ongoing room retains saved-answer access');
  const completed={...info,session:{...info.session,state:'completed'}};
  const completeTraining=emit(training,{phase:'complete',info:completed});
  assert.ok(!nodes(completeTraining).some(node=>node.type==='details'&&node.props.className==='history'),'the wrapper supplies the single completed answer and feedback disclosure');
  assert.equal(updates.at(-1).turns[0].answer,'저장한 답변 원문','the callback retains the actual answer for the wrapper');
  const standalone=harness(undefined,completed);assert.ok(nodes(standalone.render()).some(node=>node.type==='details'&&node.props.className==='history'));assert.equal(completed.turns.length,1);
  training.cleanup();standalone.cleanup();
});
test('exit confirmation pauses first and finishing remains an explicit action',()=>{
  const h=harness();h.render();let tree=emit(h,{phase:'listening'});button(tree,'면접 종료').props.onClick();tree=h.render();assert.ok(nodes(tree).some(node=>node.type==='Modal'));assert.equal(h.controllers[0].state.phase,'paused');assert.ok(!h.calls.some(call=>call.controller==='finish'));
  button(tree,'저장 후 종료').props.onClick();assert.equal(h.calls.filter(call=>call.controller==='finish').length,1);h.cleanup();
});
test('explicit error exit preserves the recording and explains why unfinished transcription is not a submitted answer',()=>{
  const h=harness();h.render();let tree=emit(h,{phase:'error',error:'음성을 확인하지 못했어요.'});button(tree,'면접 종료').props.onClick();tree=h.render();
  assert.match(text(tree),/녹음 원본은 보관하고 제출한 답변까지 저장/);assert.match(text(tree),/답변 수에 포함하지 않아요/);
  button(tree,'저장 후 종료').props.onClick();const finished=h.calls.find(call=>call.controller==='finish');assert.equal(finished?.options?.preserveOnly,true);h.cleanup();
});
test('saved server session kind controls routing even when the route query says otherwise',async()=>{
  const video=harness('interview.tsx',{...fixture(),routeKind:'chat'});video.render();await video.flush();assert.equal(video.render().type,'LiveInterviewSession');video.cleanup();
  const info=fixture();info.session.kind='chat';const chat=harness('interview.tsx',{...info,routeKind:'video'});chat.render();await chat.flush();const tree=chat.render();assert.equal(tree.type.name,'ChatInterviewSession');assert.equal(tree.props.kind,'chat');chat.cleanup();
});
test('device preparation waits for the initial suspension and recording submission sends only server media identity',async()=>{
  const h=harness();let release!:()=>void;h.faults.suspend=new Promise<void>(resolve=>release=resolve);h.faults.allowDevice=true;h.render();
  const services=h.controllers[0].services,pending=services.prepare();await Promise.resolve();assert.ok(!h.calls.some(call=>call.mockDevice));release();await pending;assert.equal(h.calls.filter(call=>call.mockDevice).length,1);
  await services.answer('saved-media',{id:'question',turnId:'turn'},4);const answer=h.calls.find(call=>call.body?.action==='answer_recording').body;
  assert.deepEqual(JSON.parse(JSON.stringify(answer)),{action:'answer_recording',sessionId:'live-session',turnId:'turn',mediaId:'saved-media',generation:4,requestId:'saved-media'});assert.equal('answer' in answer,false);h.cleanup();
});

function recoverableInfo(){const info:any=fixture();info.session.student_id='student';info.media=[{id:'older-server-media',metadata:{kind:'answer_recording',turnId:'turn',generation:0,recoveryKey:'older-local-attempt'}}];return info;}
function localAttempt(fields:any={}){return {key:'same-question:local-attempt-B',attemptId:'attempt-B',inUse:false,blob:new Blob(['local attempt B only'],{type:'audio/webm'}),durationMs:2100,complete:true,...fields};}

test('an older current-turn server media receipt cannot delete a different recoverable local attempt',async()=>{
  const info=recoverableInfo(),saved=localAttempt(),h=harness(undefined,info,saved);h.render();await h.flush();h.render();
  const restored=h.calls.find(call=>call.controller==='restoreRecording');assert.ok(restored,'a distinct local attempt remains recoverable');
  assert.equal(restored.recording.recoveryKey,saved.key);assert.equal(restored.recording.blob,saved.blob);assert.equal(await restored.recording.blob.text(),'local attempt B only');assert.equal(restored.question.turnId,'turn');assert.equal(restored.generation,0);
  assert.equal(h.calls.some(call=>call.recovery==='removed'||call.recovery==='cancelled'),false);assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(call=>call.recovery==='read').scope)),{studentId:'student',sessionId:'live-session:turn:0',itemIndex:0,kind:'interview'});h.cleanup();
});

test('a successful recovered upload acknowledges only the exact restored attempt key',async()=>{
  const saved=localAttempt({key:'student:interview:turn:attempt-B'}),h=harness(undefined,recoverableInfo(),saved);h.render();await h.flush();h.render();
  const restored=h.calls.find(call=>call.controller==='restoreRecording');assert.ok(restored);
  assert.equal(await h.controllers[0].services.upload(restored.recording,restored.question,restored.generation),'new-server-media');
  const removals=h.calls.filter(call=>call.recovery==='removed');assert.deepEqual(removals.map(call=>call.key),[saved.key]);assert.ok(h.calls.findIndex(call=>call.upload)<h.calls.findIndex(call=>call.recovery==='removed'));
  const upload=h.calls.find(call=>call.upload);assert.equal(upload.url,'/api/media');assert.equal(upload.form.get('turnId'),'turn');assert.equal(upload.form.get('generation'),'0');assert.equal(await upload.form.get('recording').text(),'local attempt B only');assert.equal(removals.some(call=>call.key==='legacy-scope-key'||call.key==='older-local-attempt'),false);h.cleanup();
});
test('an explicit preservation upload defers transcription and acknowledges only its durable server receipt',async()=>{
  const saved=localAttempt(),h=harness(undefined,recoverableInfo(),saved);h.render();await h.flush();h.render();const restored=h.calls.find(call=>call.controller==='restoreRecording');assert.ok(restored);
  await h.controllers[0].services.upload(restored.recording,restored.question,restored.generation,{deferTranscription:true});
  assert.equal(h.calls.find(call=>call.upload).form.get('deferTranscription'),'true');assert.deepEqual(h.calls.filter(call=>call.recovery==='removed').map(call=>call.key),[saved.key]);
  assert.match(text(h.render()),/미제출 녹음 원본을 보관/);h.cleanup();
});

test('missing upload receipt preserves the restored recording and its exact recovery key',async()=>{
  const saved=localAttempt(),h=harness(undefined,recoverableInfo(),saved);h.faults.uploadReceipt={};h.render();await h.flush();h.render();
  const restored=h.calls.find(call=>call.controller==='restoreRecording');assert.ok(restored);
  await assert.rejects(()=>h.controllers[0].services.upload(restored.recording,restored.question,restored.generation),/녹음 저장을 확인하지 못했어요/);
  assert.equal(h.calls.some(call=>call.recovery==='removed'||call.recovery==='cancelled'),false);assert.equal(restored.recording.recoveryKey,saved.key);assert.equal(await restored.recording.blob.text(),'local attempt B only');h.cleanup();
});

test('a checkpoint still in use by another tab is neither restored nor deleted',async()=>{
  const saved=localAttempt({inUse:true,complete:false}),h=harness(undefined,recoverableInfo(),saved);h.render();await h.flush();const tree=h.render();
  assert.match(text(tree),/다른 탭에서 이 질문을 녹음 중/);assert.equal(h.calls.some(call=>call.controller==='restoreRecording'||call.recovery==='removed'||call.recovery==='cancelled'),false);assert.equal(h.calls.some(call=>call.mockDevice||call.upload),false);h.cleanup();
});

test('aborting the Live preparation countdown cancels only its reserved writer attempt',async()=>{
  const info=recoverableInfo(),h=harness(undefined,info);h.render();await h.flush();h.render();const abort=new AbortController();h.faults.recoveryKey='new-preparation-attempt-C';
  const preparing=h.controllers[0].services.beforeCapture(info.question,0,abort.signal);await h.flush();const tree=h.render();assert.match(text(tree),/3초 뒤 답변 녹음을 시작/);abort.abort();await assert.rejects(preparing,{name:'AbortError'});h.render();
  assert.deepEqual(h.calls.filter(call=>call.recovery==='begin').map(call=>call.key),['new-preparation-attempt-C']);const cancelled=h.calls.filter(call=>call.recovery==='cancelled');assert.ok(cancelled.length>0);assert.deepEqual([...new Set(cancelled.map(call=>call.key))],['new-preparation-attempt-C']);assert.equal(h.calls.some(call=>call.recovery==='removed'||call.upload||call.controller==='restoreRecording'),false);h.cleanup();
});

test('a signal already aborted after reserving a writer releases that exact reservation without scope deletion',async()=>{
  const info=recoverableInfo(),h=harness(undefined,info);h.render();await h.flush();h.faults.recoveryKey='pre-aborted-attempt-D';const abort=new AbortController();abort.abort();
  await assert.rejects(()=>h.controllers[0].services.beforeCapture(info.question,0,abort.signal),{name:'AbortError'});assert.deepEqual(h.calls.filter(call=>call.recovery==='cancelled').map(call=>call.key),['pre-aborted-attempt-D']);assert.equal(h.calls.some(call=>call.recovery==='removed'||call.mockDevice||call.upload),false);h.cleanup();
});

test('aborting after the preparation countdown and before recorder capture still releases only that reservation',async()=>{
  const info=recoverableInfo(),h=harness(undefined,info);h.render();await h.flush();h.render();h.faults.recoveryKey='between-countdown-and-capture-attempt-E';const abort=new AbortController();
  const preparing=h.controllers[0].services.beforeCapture(info.question,0,abort.signal);await h.flush();button(h.render(),'준비 시간 건너뛰기').props.onClick();await preparing;assert.equal(h.calls.some(call=>call.recovery==='cancelled'),false);abort.abort();await h.flush();
  assert.deepEqual(h.calls.filter(call=>call.recovery==='cancelled').map(call=>call.key),['between-countdown-and-capture-attempt-E']);assert.equal(h.calls.some(call=>call.recovery==='removed'||call.mockDevice||call.upload),false);h.cleanup();
});

test('a reservation that loses its lease during preparation is cancelled before the recorder opens',async()=>{
  const info=recoverableInfo(),h=harness(undefined,info);h.render();await h.flush();h.render();h.faults.recoveryKey='expired-during-preparation-attempt-F';h.faults.assertActiveError=Error('녹음 예약이 만료됐어요.');
  const preparing=h.controllers[0].services.beforeCapture(info.question,0,new AbortController().signal);await h.flush();button(h.render(),'준비 시간 건너뛰기').props.onClick();await assert.rejects(preparing,/예약이 만료/);
  assert.deepEqual(h.calls.filter(call=>call.recovery==='assertActive').map(call=>call.key),['expired-during-preparation-attempt-F']);assert.deepEqual(h.calls.filter(call=>call.recovery==='cancelled').map(call=>call.key),['expired-during-preparation-attempt-F']);assert.equal(h.calls.some(call=>call.recorder||call.recovery==='removed'),false);h.cleanup();
});

test('a lease that expires after preparation is checked synchronously before opening the recorder',async()=>{
  const info=recoverableInfo(),h=harness(undefined,info);h.faults.allowDevice=true;h.render();await h.flush();h.render();const services=h.controllers[0].services;await services.prepare();h.faults.recoveryKey='expired-before-capture-attempt-G';
  const preparing=services.beforeCapture(info.question,0,new AbortController().signal);await h.flush();button(h.render(),'준비 시간 건너뛰기').props.onClick();await preparing;h.faults.assertFreshError=Error('녹음 예약이 만료됐어요.');assert.throws(()=>services.capture(()=>{}),/예약이 만료/);
  assert.deepEqual(h.calls.filter(call=>call.recovery==='assertFresh').map(call=>call.key),['expired-before-capture-attempt-G']);assert.equal(h.calls.some(call=>call.recorder||call.recovery==='removed'),false);services.release();await h.flush();assert.deepEqual(h.calls.filter(call=>call.recovery==='cancelled').map(call=>call.key),['expired-before-capture-attempt-G']);h.cleanup();
});

test('logout saves the latest typed draft through the registered saver without submitting or finishing the room',async(t)=>{
  const h=harness();t.after(()=>h.cleanup());let tree=h.render();await h.flush();tree=h.render();
  button(tree,'이번 질문은 글로 답하기').props.onClick();await h.flush();tree=h.render();
  nodes(tree).find(node=>node.type==='ChatComposer').props.onChange('로그아웃 직전에 입력한 최신 글입니다.');
  const start=h.calls.length;await flushPendingDrafts('student');const saved=h.calls.slice(start);
  assert.equal(h.storage.get('gakja-live-text:student:live-session:turn'),'로그아웃 직전에 입력한 최신 글입니다.');
  const actions=saved.filter(call=>call.body).map(call=>call.body);assert.deepEqual(actions.map(body=>body.action),['draft','suspend']);assert.equal(actions[0].draft,'로그아웃 직전에 입력한 최신 글입니다.');assert.equal(actions[0].turnId,'turn');
  assert.equal(saved.some(call=>call.controller==='start'||call.controller==='finish'||call.upload||call.mockDevice),false);assert.equal(h.controllers[0].state.phase,'paused');
  assert.ok(saved.findIndex(call=>call.controller==='preserveAnswer')<saved.findIndex(call=>call.storage==='set'));
});
test('logout waits for final capture preservation and verifies the exact completed device copy before drafting',async(t)=>{
  const h=harness();t.after(()=>h.cleanup());h.render();await h.flush();h.render();let release!:()=>void;
  const blob=new Blob(['actual final speech chunks'],{type:'audio/webm'});h.draftFaults.preservedRecording={blob,recoveryKey:'attempt-final'};h.draftFaults.preservePending=new Promise<void>(resolve=>release=resolve);h.faults.recovery={key:'attempt-final',complete:true,blob};
  const start=h.calls.length,pending=flushPendingDrafts('student');await h.flush();assert.equal(h.calls.slice(start).some(call=>call.recovery==='read'||call.body?.action==='draft'),false);
  // A different generation observed while the final chunk is flushing cannot rebind the saved recording scope.
  h.controllers[0].state.info.session.data.generation=9;release();await pending;const saved=h.calls.slice(start),read=saved.find(call=>call.recovery==='read');
  assert.deepEqual(JSON.parse(JSON.stringify(read.scope)),{studentId:'student',sessionId:'live-session:turn:0',itemIndex:0,kind:'interview'});
  assert.ok(saved.findIndex(call=>call.recovery==='read')<saved.findIndex(call=>call.body?.action==='draft'));assert.equal(saved.some(call=>call.body?.action==='answer'||call.body?.action==='answer_recording'||call.body?.action==='finish'),false);
});
test('missing, incomplete, mismatched-attempt or truncated recording durability blocks logout',async()=>{
  for(const variant of [null,{key:'attempt',complete:false,blob:new Blob(['abc'])},{key:'other-attempt',complete:true,blob:new Blob(['abc'])},{key:'attempt',complete:true,blob:new Blob(['ab'])}]){
    const h=harness();try{h.render();await h.flush();h.render();h.draftFaults.preservedRecording={blob:new Blob(['abc']),recoveryKey:'attempt'};h.faults.recovery=variant;const start=h.calls.length;
      await assert.rejects(flushPendingDrafts('student'),/초안을 보관하지 못했어요/);assert.equal(h.calls.slice(start).some(call=>call.body?.action==='draft'||call.body?.action==='finish'||call.upload),false);
    }finally{h.cleanup();}
  }
});
test('an acknowledged upload allows logout after its exact local copy was removed while a different recording remains blocked',async(t)=>{
  const h=harness();t.after(()=>h.cleanup());h.render();await h.flush();h.render();const recording={blob:new Blob(['uploaded speech'],{type:'audio/webm'}),recoveryKey:'uploaded-attempt',durationMs:2000};
  await h.controllers[0].services.upload(recording,{id:'question',turnId:'turn'},0);h.faults.recovery=null;h.draftFaults.preservedRecording=recording;
  await flushPendingDrafts('student');assert.ok(h.calls.some(call=>call.body?.action==='draft'));
  h.draftFaults.preservedRecording={...recording,blob:new Blob(['uploaded speech'],{type:'audio/webm'})};const start=h.calls.length;
  await assert.rejects(flushPendingDrafts('student'),/초안을 보관하지 못했어요/);assert.equal(h.calls.slice(start).some(call=>call.body?.action==='draft'),false,'a same-size object has no receipt for the new attempt');
});
test('local draft verification or server suspension failure rejects logout and retains the current room',async()=>{
  for(const kind of ['storage','mismatch','suspend'] as const){
    const h=harness();try{h.render();await h.flush();h.render();if(kind==='storage')h.draftFaults.storageError=Error('storage denied');if(kind==='mismatch')h.draftFaults.storageMismatch=true;if(kind==='suspend')h.draftFaults.suspendError=Error('suspend response lost');const start=h.calls.length;
      await assert.rejects(flushPendingDrafts('student'),/초안을 보관하지 못했어요/);const saved=h.calls.slice(start);assert.equal(saved.some(call=>call.controller==='finish'||call.body?.action==='finish'||call.body?.action==='answer'),false);assert.equal(h.destinations.length,0);assert.equal(h.controllers[0].state.phase,'paused');
    }finally{h.draftFaults.suspendError=undefined;h.cleanup();}
  }
});
test('a failed draft post is accepted only when the exact current turn has an actual non-invalidated answer receipt',async()=>{
  for(const kind of ['same','other','invalidated'] as const){
    const h=harness();try{h.render();await h.flush();h.render();h.draftFaults.draftError=Error('current turn already advanced');h.faults.apiInfo={...fixture(),turns:[{id:kind==='other'?'other-turn':'turn',answer:'이미 제출된 실제 답변',invalidated:kind==='invalidated'}]};const start=h.calls.length;
      if(kind==='same')await flushPendingDrafts('student');else await assert.rejects(flushPendingDrafts('student'),/초안을 보관하지 못했어요/);
      const saved=h.calls.slice(start);assert.equal(saved.some(call=>call.body?.action==='suspend'),kind==='same');assert.equal(saved.some(call=>call.body?.action==='answer'||call.body?.action==='answer_recording'||call.body?.action==='finish'),false);
    }finally{h.cleanup();}
  }
});
test('unmount unregisters the Live draft saver and completed rooms do no draft work',async()=>{
  const h=harness();h.render();await h.flush();h.cleanup();const start=h.calls.length;await flushPendingDrafts('student');assert.equal(h.calls.length,start);assert.equal(h.calls.filter(call=>call.draftSaver==='removed').length,1);
  const info=fixture();info.session.state='completed';const completed=harness(undefined,info);try{completed.render();const offset=completed.calls.length;await flushPendingDrafts('student');assert.equal(completed.calls.length,offset);}finally{completed.cleanup();}
});
test('a processing room without a visible question still pauses and suspends, and cannot discard an unverified recording',async(t)=>{
  const h=harness();t.after(()=>h.cleanup());h.render();await h.flush();const processing={...fixture(),question:null};emit(h,{phase:'saving',info:processing});const start=h.calls.length;
  await flushPendingDrafts('student');const saved=h.calls.slice(start);assert.ok(saved.some(call=>call.controller==='preserveAnswer'));assert.deepEqual(saved.filter(call=>call.body).map(call=>call.body.action),['suspend']);assert.equal(h.controllers[0].state.phase,'paused');
  h.draftFaults.preservedRecording={blob:new Blob(['not yet verified']),recoveryKey:'unknown-attempt'};
  await assert.rejects(flushPendingDrafts('student'),/초안을 보관하지 못했어요/);
});
test('resuming Live after a later logout failure re-arms its recording navigation guard',async(t)=>{
  const h=harness();t.after(()=>h.cleanup());h.faults.appData.preferences={liveRecordingConsent:true};h.render();await h.flush();h.render();
  await flushPendingDrafts('student');assert.equal(h.controllers[0].state.phase,'paused');
  let prevented=false;const unload=()=>h.listeners.get('window:beforeunload')!({preventDefault(){prevented=true;},returnValue:null});
  unload();assert.equal(prevented,false,'the verified logout handoff is allowed to leave');
  // AppShell can fail while finishing the study session or revoking credentials, leaving this paused room mounted.
  button(h.render(),'계속하기').props.onClick();assert.equal(h.controllers[0].state.phase,'preparing');
  unload();assert.equal(prevented,true,'an explicit new voice start restores the warning before another recording');
  assert.ok(h.calls.some(call=>call.keepalive&&call.body?.action==='suspend'));
  assert.equal(h.calls.some(call=>call.body?.action==='finish'||call.body?.action==='answer'||call.body?.action==='answer_recording'),false);
});

test('enabled RTC voices the approved question, sends input only at durable capture and leaves existing answer storage authoritative',async(t)=>{
  const info=fixture(),h=harness(undefined,info);t.after(()=>h.cleanup());h.rtcFaults.enabled=true;h.rtcFaults.capture=true;h.faults.allowDevice=true;h.faults.appData.preferences={liveRecordingConsent:true,liveCameraEnabled:false};h.render();await h.flush();let tree=h.render();button(tree,'면접 시작').props.onClick();const services=h.controllers[0].services;await services.prepare();await services.speak(info.question,0,new AbortController().signal);
  const connected=h.calls.find(call=>call.rtc==='connect');assert.equal(connected.scope.turnId,'turn');assert.equal(connected.scope.generation,0);assert.equal(connected.question.prompt,info.question.prompt);assert.equal(h.calls.some(call=>call.rtc==='startInput'||call.upload||call.body?.action==='speech'),false);
  const preparing=services.beforeCapture(info.question,0,new AbortController().signal);await h.flush();button(h.render(),'준비 시간 건너뛰기').props.onClick();await preparing;services.capture(()=>{});assert.ok(h.calls.findIndex(call=>call.rtc==='startInput')<h.calls.findIndex(call=>call.recorder));tree=h.render();assert.match(text(tree),/자막 미리보기 원문/);assert.equal(h.calls.some(call=>call.upload||call.body?.action==='answer_recording'),false,'a preview never becomes an answer');
  const recording={blob:new Blob(['real durable chunks']),durationMs:2000};await h.rtcFaults.captureOptions.onComplete(recording);assert.ok(h.calls.some(call=>call.rtc==='finishInput'));assert.ok(h.calls.some(call=>call.recovery==='finish'));assert.equal((recording as any).recoveryKey,h.faults.recoveryKey);
  const mediaId=await services.upload(recording,info.question,0);await services.answer(mediaId,info.question,0);const answer=h.calls.find(call=>call.body?.action==='answer_recording');assert.equal(answer.body.mediaId,'new-server-media');assert.equal(answer.body.turnId,'turn');assert.equal(answer.body.generation,0);assert.equal(answer.body.answer,undefined);
});

test('RTC question failure closes its connection and replays the same server turn through existing TTS',async(t)=>{
  const info=fixture(),h=harness(undefined,info);t.after(()=>h.cleanup());h.rtcFaults.enabled=true;h.rtcFaults.playError=Error('RTC output mismatch');h.faults.allowDevice=true;h.faults.appData.preferences={liveRecordingConsent:true};h.render();await h.flush();button(h.render(),'면접 시작').props.onClick();const services=h.controllers[0].services;await services.prepare();await services.speak(info.question,0,new AbortController().signal);
  assert.ok(h.calls.some(call=>call.rtc==='close'));const speech=h.calls.find(call=>call.body?.action==='speech');assert.equal(speech.body.turnId,'turn');assert.equal(speech.body.generation,0);assert.equal(speech.body.questionId,'question');assert.match(text(h.render()),/같은 질문을 다시 들려드릴게요/);assert.equal(h.calls.some(call=>call.rtc==='startInput'||call.body?.action==='answer_recording'),false);
  await services.speak(info.question,0,new AbortController().signal);assert.equal(h.calls.filter(call=>call.rtc==='connect').length,1,'the failing RTC path remains disabled in this room');
});

test('Live logout waits for owned RTC hangup receipt and keeps a failed close retryable without finishing or submitting',async(t)=>{
  const info=fixture(),h=harness(undefined,info);t.after(()=>h.cleanup());h.rtcFaults.enabled=true;h.faults.allowDevice=true;h.faults.appData.preferences={liveRecordingConsent:true};h.render();await h.flush();button(h.render(),'면접 시작').props.onClick();const services=h.controllers[0].services;await services.prepare();await services.speak(info.question,0,new AbortController().signal);
  let release!:()=>void;h.rtcFaults.closePending=new Promise<void>(resolve=>release=resolve);h.rtcFaults.closeResult=false;const saving=flushPendingDrafts('student');let settled=false;void saving.then(()=>settled=true,()=>settled=true);await h.flush();assert.equal(settled,false);release();await assert.rejects(()=>saving,/초안을 보관하지 못했어요/);
  h.rtcFaults.closePending=undefined;h.rtcFaults.closeResult=true;await flushPendingDrafts('student');assert.ok(h.calls.filter(call=>call.rtc==='close').length>=2);assert.equal(h.calls.some(call=>call.body?.action==='finish'||call.body?.action==='answer'||call.body?.action==='answer_recording'),false);
});

test('pausing before logout retains pending and failed RTC shutdown receipts until an acknowledged retry',async(t)=>{
  const info=fixture(),h=harness(undefined,info);t.after(()=>h.cleanup());h.rtcFaults.enabled=true;h.faults.allowDevice=true;h.faults.appData.preferences={liveRecordingConsent:true};h.render();await h.flush();button(h.render(),'면접 시작').props.onClick();const services=h.controllers[0].services;await services.prepare();await services.speak(info.question,0,new AbortController().signal);
  let release!:()=>void;h.rtcFaults.closePending=new Promise<void>(resolve=>release=resolve);h.rtcFaults.closeResult=false;services.mute(true);const saving=flushPendingDrafts('student');let settled=false;void saving.then(()=>settled=true,()=>settled=true);await h.flush();assert.equal(settled,false,'a prior pause cannot discard the outstanding close');release();await assert.rejects(()=>saving,/초안을 보관하지 못했어요/);
  h.rtcFaults.closePending=undefined;h.rtcFaults.closeResult=true;await flushPendingDrafts('student');assert.ok(h.calls.filter(call=>call.rtc==='close').length>=3);assert.equal(h.calls.some(call=>call.body?.action==='finish'||call.body?.action==='answer_recording'),false);
});


test('Live AI help pauses the current recorder without finishing, uploading or discarding it and returns to the same question',async(t)=>{
  const h=harness();t.after(()=>h.cleanup());h.render();await h.flush();const recording={blob:new Blob(['unfinished durable audio']),recoveryKey:'current-attempt'};
  let tree=emit(h,{phase:'listening',recording}),helper=nodes(tree).find(node=>node.type==='LearningHelp');assert.ok(helper);
  const offset=h.calls.length;assert.equal(await helper.props.beforeOpen(),true);tree=h.render();const actions=h.calls.slice(offset);
  assert.equal(h.controllers[0].state.phase,'paused');assert.equal(h.controllers[0].state.recording,recording);assert.equal(h.controllers[0].state.info.question.turnId,'turn');
  assert.equal(actions.some(call=>call.controller==='preserveAnswer'||call.controller==='finish'||call.upload||call.recovery==='removed'||call.recovery==='cancelled'),false);
  assert.equal(actions.find(call=>call.body?.action==='pause').body.turnId,'turn');assert.equal(actions.some(call=>call.body?.action==='answer'||call.body?.action==='finish'),false);
  helper=nodes(tree).find(node=>node.type==='LearningHelp');helper.props.onClose();assert.equal(h.destinations.length,0);assert.ok(button(h.render(),'보관한 답변 저장하고 계속'));
});

test('Live typed help preserves the latest answer draft and refreshes its assisted receipt without submitting an answer',async(t)=>{
  const info=fixture();info.session.data.trainingPurpose='diagnostic';const h=harness(undefined,info);t.after(()=>h.cleanup());h.render();await h.flush();let tree=h.render();
  nodes(tree).find(node=>node.type==='ChatComposer').props.onChange('이 도움창을 닫고 이어서 쓸 초안');tree=h.render();let helper=nodes(tree).find(node=>node.type==='LearningHelp');assert.equal(await helper.props.beforeOpen(),true);
  assert.equal(h.storage.get('gakja-live-text:student:live-session:turn'),'이 도움창을 닫고 이어서 쓸 초안');
  const paused=h.calls.filter(call=>call.body?.action==='pause').at(-1).body;assert.equal(paused.draft,'이 도움창을 닫고 이어서 쓸 초안');
  h.faults.apiInfo={...info,turns:[{id:'turn',answer:null,assisted:true,helpKinds:['ai']}]};await helper.props.onAssisted();tree=h.render();
  assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.value,'이 도움창을 닫고 이어서 쓸 초안');assert.equal(h.calls.some(call=>call.body?.action==='answer'||call.body?.action==='finish'),false);
  helper=nodes(tree).find(node=>node.type==='LearningHelp');assert.equal(helper.props.interviewSessionId,'live-session');assert.equal(helper.props.interviewTurnId,'turn');
});

test('Live helper refuses processing turns and fails closed when the server cannot pause the same turn',async(t)=>{
  const h=harness();t.after(()=>h.cleanup());h.render();await h.flush();let tree=emit(h,{phase:'saving'});let helper=nodes(tree).find(node=>node.type==='LearningHelp');assert.equal(helper.props.disabled,true);assert.equal(await helper.props.beforeOpen(),false);
  tree=emit(h,{phase:'paused'});helper=nodes(tree).find(node=>node.type==='LearningHelp');h.draftFaults.helpPauseError=Error('서버 연결을 확인해 주세요.');await assert.rejects(helper.props.beforeOpen,/서버 연결/);
  assert.equal(h.destinations.length,0);assert.equal(h.controllers[0].state.info.question.turnId,'turn');assert.equal(h.calls.some(call=>call.body?.action==='answer'||call.body?.action==='finish'),false);
});

test('opening the AI tab during Live opens its current sheet and a later question does not inherit that request',async(t)=>{
  const h=harness();t.after(()=>h.cleanup());h.render();await h.flush();let prevented=false;h.listeners.get('window:gakja:open-on')!({preventDefault(){prevented=true;}});
  let tree=h.render();assert.equal(prevented,true);assert.equal(nodes(tree).find(node=>node.type==='LearningHelp').props.openRequest,1);assert.equal(h.destinations.length,0);
  tree=emit(h,{info:{...fixture(),question:{...fixture().question,turnId:'next-turn'}}});assert.equal(nodes(tree).find(node=>node.type==='LearningHelp').props.openRequest,0);
});
