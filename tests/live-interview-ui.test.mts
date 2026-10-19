import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const fixture=()=>({session:{id:'live-session',state:'active',kind:'video',supportTarget:{id:'target',university:'고려대학교',department:'경영학과'},practiceLabel:'일반 경험 면접',data:{practiceScope:'personal_record',practiceNotice:'학교별 실제 전형을 재현하지 않는 내 경험 연습이에요.',context:{contentVersion:'7',questions:[],activities:[],sources:[]},generation:0,index:0,paused:true,panelists:[{id:'A',name:'면접관 A',gender:'female'},{id:'B',name:'면접관 B',gender:'male'}]}},
  question:{id:'question',turnId:'turn',prompt:'맡은 역할은 무엇인가요?',speakerId:'A'},turns:[] as any[],report:null as any});

function harness(file='live-interview-session.tsx',initialInfo:any=fixture(),recovery:any=null){
  const values:any[]=[],deps:any[]=[],effects:Function[]=[],cleanups:Function[]=[];
  const calls:any[]=[],listeners=new Map<string,Function>(),controllers:any[]=[],destinations:string[]=[];
  const faults={suspend:undefined as Promise<void>|undefined,allowDevice:false,recovery,uploadReceipt:{media:{id:'new-server-media'}} as any,recoveryKey:'reserved-writer-attempt',assertActiveError:undefined as Error|undefined,assertFreshError:undefined as Error|undefined};
  let index=0;
  const events=(prefix:string)=>({addEventListener:(name:string,fn:Function)=>listeners.set(prefix+name,fn),removeEventListener:(name:string)=>listeners.delete(prefix+name)});
  const document={...events('document:'),visibilityState:'visible'};
  const location={href:'http://fixture.test/interview/live-session',origin:'http://fixture.test',pathname:'/interview/live-session',search:'',assign:(url:string)=>destinations.push(url)};
  class Controller {
    state:any;services:any;changed:Function;
    constructor(info:any,services:any,changed:Function){this.state={phase:info.session.state==='completed'?'complete':'idle',info,error:''};this.services=services;this.changed=changed;controllers.push(this);}
    emit(patch:any){this.state={...this.state,...patch};this.changed(this.state);}
    async start(){calls.push({controller:'start'});this.emit({phase:'preparing'});}
    async rerecord(){calls.push({controller:'rerecord'});this.emit({phase:'preparing'});}
    async preserveAnswer(){calls.push({controller:'preserveAnswer'});this.pause();}
    async acceptTypedAnswer(info:any){calls.push({controller:'acceptTypedAnswer'});this.emit({info,phase:'paused'});}
    restoreRecording(recording:any,question:any,generation:number){calls.push({controller:'restoreRecording',recording,question,generation});this.emit({recording});return true;}
    pause(){calls.push({controller:'pause'});this.emit({phase:'paused'});}
    finishAnswer(){calls.push({controller:'finishAnswer'});}
    async finish(){calls.push({controller:'finish'});}
    dispose(){calls.push({controller:'dispose'});}
  }
  const react={useState(initial:any){const slot=index++;if(!(slot in values))values[slot]=typeof initial==='function'?initial():initial;return [values[slot],(value:any)=>values[slot]=typeof value==='function'?value(values[slot]):value];},useRef(initial:any){const slot=index++;return values[slot]??(values[slot]={current:initial});},useEffect(fn:Function,next:any[]){const slot=index++;if(!deps[slot]||next?.some((value,i)=>value!==deps[slot][i])){deps[slot]=next;effects.push(()=>{cleanups[slot]?.();cleanups[slot]=fn();});}}};
  const mod={exports:{} as any};
  vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/components/'+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
    module:mod,exports:mod.exports,Date,URL:class extends URL{static createObjectURL(){return 'blob:synthetic-recording';}static revokeObjectURL(){}},Blob,DOMException,AbortController,FormData,
    document,location,window:{...events('window:'),navigation:events('navigation:'),confirm:()=>true},
    navigator:{mediaDevices:{getUserMedia:async()=>{if(!faults.allowDevice)throw Error('Unexpected microphone access in render regression');calls.push({mockDevice:true});return {getTracks:()=>[],getAudioTracks:()=>[]};}}},
    Audio:class {src='';async play(){calls.push({audio:'unlock'});}pause(){}},
    setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},
    fetch:async(_url:string,init:any)=>{calls.push({keepalive:!!init.keepalive,body:JSON.parse(init.body)});return {ok:true};},
    require(name:string){
      if(name==='react')return react;
      if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props}),Fragment:'Fragment'};
      if(name==='next/link')return {__esModule:true,default:'Link'};
      if(name==='next/navigation')return {useRouter:()=>({push:(href:string)=>destinations.push(href)})};
      if(name==='./app-shell')return {useApp:()=>({refresh:async()=>calls.push({refresh:true})})};
      if(name==='./shared')return {api:async()=>structuredClone(initialInfo),post:async(url:string,body:any)=>{calls.push({url,body});if(body.action==='suspend')await faults.suspend;return {};},Breadcrumb:'Breadcrumb',Modal:'Modal',Alert:'Alert',targetName:(target:any)=>target?.university||'지원처 미등록'};
      if(name==='@/lib/client/live-interview-controller')return {LiveInterviewController:Controller};
      if(name==='@/lib/client/live-interview-recorder')return {createLiveAnswerCapture:()=>{calls.push({recorder:true});throw Error('Unexpected recorder access');}};
      if(name==='@/lib/client/recording-recovery')return {
        readRecordingRecovery:async(scope:any)=>{calls.push({recovery:'read',scope});return faults.recovery;},
        recordingRecoveryKey:()=> 'legacy-scope-key',
        removeRecordingRecovery:async(key:string)=>calls.push({recovery:'removed',key}),
        beginRecordingRecovery:async(scope:any)=>{const key=faults.recoveryKey;calls.push({recovery:'begin',scope,key});return {key,append:async()=>{},appendAnalysis:async()=>{},finish:async()=>{},assertActive:async()=>{calls.push({recovery:'assertActive',key});if(faults.assertActiveError)throw faults.assertActiveError;},assertFresh:()=>{calls.push({recovery:'assertFresh',key});if(faults.assertFreshError)throw faults.assertFreshError;},cancel:async()=>{calls.push({recovery:'cancelled',key});}};},
      };
      if(name==='@/lib/recording-upload-client')return {uploadRecording:async(url:string,form:FormData)=>{calls.push({upload:true,url,form});return faults.uploadReceipt;}};
      if(name==='./live-interviewer-stage')return {LiveInterviewerStage:'LiveInterviewerStage'};
      if(name==='./live-interview-session')return {LiveInterviewSession:'LiveInterviewSession'};
      if(name.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
      return new Proxy({},{get:(_,key)=>String(key)});
    },
  });
  function render(){index=0;const tree=file==='interview.tsx'?mod.exports.InterviewSession({id:'live-session',kind:initialInfo.routeKind||'chat'}):mod.exports.LiveInterviewSession({id:'live-session',initialInfo});while(effects.length)effects.shift()!();return tree;}
  return {render,values,calls,listeners,document,destinations,controllers,faults,flush:()=>new Promise(resolve=>setImmediate(resolve)),cleanup:()=>cleanups.forEach(fn=>fn?.())};
}
function nodes(tree:any):any[]{return Array.isArray(tree)?tree.flatMap(nodes):tree&&typeof tree==='object'?[tree,...nodes(tree.props?.children)]:[];}
function text(tree:any):string{return Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):tree==null?'':String(tree);}
function button(tree:any,label:string){const value=nodes(tree).find(node=>node.type==='button'&&text(node)===label);assert.ok(value,'button: '+label);return value;}
function consent(tree:any){const label=nodes(tree).find(node=>node.type==='label'&&text(node).includes('저장과 답변 전사'));assert.ok(label);return nodes(label).find(node=>node.type==='input');}
function emit(h:ReturnType<typeof harness>,patch:any){h.controllers[0].emit(patch);return h.render();}

test('the Live room is silent before consent and has no editable answer composer',()=>{
  const h=harness();let tree=h.render();assert.equal(button(tree,'면접 시작').props.disabled,true);assert.equal(h.calls.some(call=>call.controller==='start'||call.audio),false);
  assert.equal(nodes(tree).some(node=>node.type==='textarea'||node.type==='ChatComposer'||node.props?.contentEditable),false);
  assert.ok(nodes(tree).filter(node=>node.type==='input').every(node=>node.props.type==='checkbox'));
  consent(tree).props.onChange({target:{checked:true}});tree=h.render();assert.equal(button(tree,'면접 시작').props.disabled,false);button(tree,'면접 시작').props.onClick();
  assert.equal(h.calls.filter(call=>call.controller==='start').length,1);assert.ok(h.calls.some(call=>call.audio==='unlock'));h.cleanup();
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
test('actual server target and question fields remain visible in read-only history',()=>{
  const info=fixture();info.turns=[{id:'answered',question:'갈등을 해결한 과정을 말해 주세요.',answer:'팀원 의견을 정리하고 역할을 나눴습니다.'},{id:'invalid',question:'폐기 질문',answer:'폐기 답변',invalidated:true}];
  const h=harness(undefined,info),tree=h.render();assert.ok(text(tree).includes('고려대학교'));assert.ok(text(tree).includes('경영학과'));assert.ok(text(tree).includes(info.session.practiceLabel));assert.ok(text(tree).includes(info.session.data.practiceNotice));assert.ok(text(tree).includes('갈등을 해결한 과정을 말해 주세요.'));assert.ok(!text(tree).includes('폐기 답변'));
  const history=nodes(tree).find(node=>node.type==='details');assert.ok(history);assert.equal(history.props.open,undefined);assert.ok(!nodes(history).some(node=>['textarea','input','button','ChatComposer'].includes(node.type)));assert.ok(text(history).includes('팀원 의견을 정리하고 역할을 나눴습니다.'));h.cleanup();
});
test('permission recovery still requires consent if the student withdraws it',()=>{
  const h=harness();let tree=h.render();consent(tree).props.onChange({target:{checked:true}});tree=emit(h,{phase:'error',error:'마이크 권한을 확인해 주세요.'});
  consent(tree).props.onChange({target:{checked:false}});tree=h.render();assert.equal(button(tree,'계속하기').props.disabled,true);button(tree,'계속하기').props.onClick();assert.equal(h.calls.some(call=>call.controller==='start'),false);h.cleanup();
});
test('recording recovery offers a distinct same-question rerecord action gated by consent',async()=>{
  const h=harness();let tree=h.render();consent(tree).props.onChange({target:{checked:true}});
  tree=emit(h,{phase:'error',error:'음성 전사를 다시 시도해 주세요.',recording:{blob:new Blob(['synthetic audio'],{type:'audio/webm'}),measurementAvailable:true,speechStarted:true,durationMs:2000}});
  assert.ok(button(tree,'보관한 답변 저장하고 계속'));assert.equal(button(tree,'같은 질문 다시 녹음').props.disabled,false);
  button(tree,'같은 질문 다시 녹음').props.onClick();await h.flush();assert.equal(h.calls.filter(call=>call.controller==='rerecord').length,1);assert.equal(h.calls.some(call=>call.controller==='start'),false);
  tree=emit(h,{phase:'error'});consent(tree).props.onChange({target:{checked:false}});tree=h.render();assert.equal(button(tree,'같은 질문 다시 녹음').props.disabled,true);button(tree,'같은 질문 다시 녹음').props.onClick();assert.equal(h.calls.filter(call=>call.controller==='rerecord').length,1);h.cleanup();
});
test('the completed room links to its report and cannot restart recording',()=>{
  const info=fixture();info.session.state='completed';info.report={id:'saved-report'};info.turns=[{id:'answered',question:'역할은?',answer:'자료를 정리했습니다.'}];
  const h=harness(undefined,info),tree=h.render();assert.ok(nodes(tree).some(node=>node.type==='Link'&&node.props.href==='/records/reports/saved-report'));assert.equal(nodes(tree).some(node=>node.type==='button'||node.type==='input'),false);assert.ok(!nodes(tree).some(node=>node.type==='LiveInterviewerStage'));h.cleanup();
});
test('exit confirmation pauses first and finishing remains an explicit action',()=>{
  const h=harness();h.render();let tree=emit(h,{phase:'listening'});button(tree,'면접 종료').props.onClick();tree=h.render();assert.ok(nodes(tree).some(node=>node.type==='Modal'));assert.equal(h.controllers[0].state.phase,'paused');assert.ok(!h.calls.some(call=>call.controller==='finish'));
  button(tree,'여기까지 저장하고 종료').props.onClick();assert.equal(h.calls.filter(call=>call.controller==='finish').length,1);h.cleanup();
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
