import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const fixture=()=>({session:{id:'live-session',state:'active',kind:'video',supportTarget:{id:'target',university:'고려대학교',department:'경영학과'},practiceLabel:'일반 경험 면접',data:{practiceScope:'personal_record',practiceNotice:'학교별 실제 전형을 재현하지 않는 내 경험 연습이에요.',context:{contentVersion:'7',questions:[],activities:[],sources:[]},generation:0,index:0,paused:true,panelists:[{id:'A',name:'면접관 A',gender:'female'},{id:'B',name:'면접관 B',gender:'male'}]}},
  question:{id:'question',turnId:'turn',prompt:'맡은 역할은 무엇인가요?',speakerId:'A'},turns:[] as any[],report:null as any});

function harness(file='live-interview-session.tsx',initialInfo:any=fixture()){
  const values:any[]=[],deps:any[]=[],effects:Function[]=[],cleanups:Function[]=[];
  const calls:any[]=[],listeners=new Map<string,Function>(),controllers:any[]=[],destinations:string[]=[];
  const faults={suspend:undefined as Promise<void>|undefined,allowDevice:false};
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
    pause(){calls.push({controller:'pause'});this.emit({phase:'paused'});}
    finishAnswer(){calls.push({controller:'finishAnswer'});}
    async finish(){calls.push({controller:'finish'});}
    dispose(){calls.push({controller:'dispose'});}
  }
  const react={useState(initial:any){const slot=index++;if(!(slot in values))values[slot]=typeof initial==='function'?initial():initial;return [values[slot],(value:any)=>values[slot]=typeof value==='function'?value(values[slot]):value];},useRef(initial:any){const slot=index++;return values[slot]??(values[slot]={current:initial});},useEffect(fn:Function,next:any[]){const slot=index++;if(!deps[slot]||next?.some((value,i)=>value!==deps[slot][i])){deps[slot]=next;effects.push(()=>{cleanups[slot]?.();cleanups[slot]=fn();});}}};
  const mod={exports:{} as any};
  vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/components/'+file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
    module:mod,exports:mod.exports,Date,URL:class extends URL{static createObjectURL(){return 'blob:synthetic-recording';}static revokeObjectURL(){}},Blob,DOMException,AbortController,FormData,
    document,location,window:{...events('window:'),navigation:events('navigation:')},
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
      if(name==='@/lib/client/live-interview-recorder')return {createLiveAnswerCapture:()=>{throw Error('Unexpected recorder access');}};
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
test('active Live controls are limited to pausing, ending and ending the current answer',()=>{
  const h=harness();h.render();const tree=emit(h,{phase:'listening',progress:{durationMs:3200,measurementAvailable:true,endingSoon:false}});
  assert.deepEqual(nodes(tree).filter(node=>node.type==='button').map(text).sort(),['답변 마침','면접 종료','일시정지'].sort());
  button(tree,'답변 마침').props.onClick();assert.ok(h.calls.some(call=>call.controller==='finishAnswer'));
  button(tree,'일시정지').props.onClick();assert.equal(h.controllers[0].state.phase,'paused');
  const paused=h.render();assert.ok(button(paused,'계속하기'));assert.ok(!nodes(paused).some(node=>node.type==='button'&&text(node)==='답변 마침'));h.cleanup();
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
test('recording recovery offers a distinct same-question rerecord action gated by consent',()=>{
  const h=harness();let tree=h.render();consent(tree).props.onChange({target:{checked:true}});
  tree=emit(h,{phase:'error',error:'음성 전사를 다시 시도해 주세요.',recording:{blob:new Blob(['synthetic audio'],{type:'audio/webm'}),measurementAvailable:true,speechStarted:true,durationMs:2000}});
  assert.ok(button(tree,'보관한 답변 저장하고 계속'));assert.equal(button(tree,'같은 질문 다시 녹음').props.disabled,false);
  button(tree,'같은 질문 다시 녹음').props.onClick();assert.equal(h.calls.filter(call=>call.controller==='rerecord').length,1);assert.equal(h.calls.some(call=>call.controller==='start'),false);
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
