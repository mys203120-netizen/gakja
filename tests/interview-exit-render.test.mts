import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {registerDraftSaver,flushPendingDrafts} from '../apps/web/src/lib/client/draft-save';
import * as timer from '../apps/web/src/lib/interview-timer';

function harness(){
  const values:any[]=[],deps:any[]=[],cleanups:any[]=[],effects:any[]=[],storage=new Map<string,string>();
  const listeners=new Map<string,Function>(),posts:any[]=[],destinations:string[]=[];
  const source:any={session:{id:'session',state:'active',kind:'chat',data:{elapsedMs:0,activeSince:Date.now()-5000,timerLeaseUntil:Date.now()+25000,context:{},panelists:[]}},turns:[],question:{turnId:'turn',id:'question',prompt:'테스트 질문',draft:''}};
  let index=0;const faults={finish:false,pause:false,storage:false,enterToSend:undefined as boolean|undefined};
  const events=(prefix:string)=>({addEventListener:(name:string,fn:Function)=>listeners.set(prefix+name,fn),removeEventListener:(name:string)=>listeners.delete(prefix+name)});
  const document={...events('document:'),visibilityState:'visible',activeElement:null};
  const location={href:'http://localhost/interview/chat/session',origin:'http://localhost',pathname:'/interview/chat/session',search:'',assign:(url:string)=>destinations.push(url)};
  const mod={exports:{} as any};
  const react={useState:(initial:any)=>{const i=index++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return [values[i],(value:any)=>{values[i]=typeof value==='function'?value(values[i]):value;}];},useRef:(initial:any)=>{const i=index++;return values[i]??(values[i]={current:initial});},useEffect:(fn:Function,next:any[])=>{const i=index++;if(!deps[i]||next?.some((v,j)=>v!==deps[i][j])){deps[i]=next;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
  vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/components/interview.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
    module:mod,exports:mod.exports,Date,URL,crypto:{randomUUID},document,location,window:{...events('window:'),navigation:events('navigation:')},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{if(faults.storage)throw Error('storage blocked');storage.set(key,value);},removeItem:(key:string)=>storage.delete(key)},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},
    fetch:async(_url:string,init:any)=>{posts.push(JSON.parse(init.body));return {ok:true};},
    require(name:string){if(name==='@/lib/privacy-policy')return {PRIVACY_POLICY_VERSION:'2026-10-22'};if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};
      if(name==='react')return react;
      if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props}),Fragment:'Fragment'};
      if(name==='next/navigation')return {useRouter:()=>({push:(url:string)=>destinations.push(url)})};
      if(name==='./app-shell')return {useApp:()=>({data:{user:{id:'fixture'},preferences:{enterToSend:faults.enterToSend}},refresh:async()=>{},toast(){},openResource(){}})};
      if(name==='./shared')return {api:async()=>structuredClone(source),post:async(_url:string,body:any)=>{posts.push(body);if(body.action==='pause'&&faults.pause)throw new Error('pause offline');if(body.action==='pause')source.session.data={...source.session.data,...timer.stoppedInterviewTimer(source.session.data),paused:true};if(body.action==='resume')source.session.data={...source.session.data,paused:false,activeSince:Date.now(),timerLeaseUntil:Date.now()+25000};if(body.action==='answer'){const turn={id:body.turnId,answer:body.answer,requestId:body.requestId};source.turns.push(turn);source.question=null;return {session:structuredClone(source.session),turn,nextQuestion:null};}if(body.action==='finish'&&faults.finish)throw new Error('저장 실패 테스트');return {report:{id:'saved-report'},session:structuredClone(source.session)};},Modal:'Modal',Breadcrumb:'Breadcrumb',Alert:'Alert',targetName:()=>''};
      if(name==='@/lib/client/draft-save')return {registerDraftSaver};
      if(name==='@/lib/interview-timer')return timer;
      if(name==='./playful-flow')return {animateStudyReceipt(){}};
      return new Proxy({},{get:(_,key)=>String(key)});
    }
  });
  const render=()=>{index=0;const tree=mod.exports.ChatInterviewSession({id:'session',kind:'chat'});while(effects.length)effects.shift()();return tree;};
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  return {render,flush,faults,values,listeners,posts,destinations,document,storage,source,cleanup:()=>cleanups.forEach(fn=>fn?.())};
}
function nodes(tree:any):any[]{return !tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(nodes):[tree,...nodes(tree.props?.children)];}
function text(tree:any):string{return Array.isArray(tree)?tree.map(text).join(''):tree&&typeof tree==='object'?text(tree.props?.children):tree==null?'':String(tree);}
function click(h:ReturnType<typeof harness>,href:string){let prevented=false;h.listeners.get('document:click')!({target:{closest:()=>({href,target:'',hasAttribute:()=>false})},button:0,preventDefault(){prevented=true;},stopPropagation(){}});return prevented;}
test('menu exit opens confirmation; continue keeps the session and save navigates only after finish',async()=>{
  const h=harness();h.render();await h.flush();h.render();
  assert.equal(click(h,'http://localhost/my'),true);
  let tree=h.render();assert.ok(nodes(tree).some(n=>n.type==='Modal'&&n.props.title==='면접을 종료하고 저장할까요?'));
  nodes(tree).find(n=>n.type==='button'&&n.props.children==='면접 계속하기').props.onClick();
  assert.equal(nodes(h.render()).some(n=>n.type==='Modal'),false);assert.equal(h.posts.length,0);
  h.values[1]='미제출 테스트 초안';h.render();click(h,'http://localhost/my');tree=h.render();nodes(tree).find(n=>n.type==='button'&&n.props.children==='종료하고 저장').props.onClick();await h.flush();
  assert.deepEqual(h.posts.map(p=>p.action),['draft','finish']);assert.equal(h.posts[0].draft,'미제출 테스트 초안');
  assert.equal(h.posts.find(p=>p.action==='finish')?.sessionId,'session');assert.deepEqual(h.destinations,['/my']);
  h.cleanup();assert.equal(h.posts.filter(p=>p.action==='suspend').length,0);
});
test('same-page anchor stays available; hiding and unmounting suspend without finishing',async()=>{
  const h=harness();h.render();await h.flush();h.render();
  assert.equal(click(h,'http://localhost/interview/chat/session#interview-current-question'),false);
  h.document.visibilityState='hidden';h.listeners.get('document:visibilitychange')!();h.render();
  assert.equal(h.posts[0].action,'suspend');assert.equal(h.values[0].session.data.paused,true);assert.equal(h.values[0].session.data.activeSince,null);
  h.cleanup();assert.equal(h.posts.some(p=>p.action==='finish'),false);
});
test('browser back is intercepted when cancellable; refresh uses native confirmation and suspends',async()=>{
  const h=harness();h.render();await h.flush();h.render();let prevented=false;
  h.listeners.get('navigation:navigate')!({navigationType:'traverse',cancelable:true,destination:{url:'http://localhost/interview'},preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.ok(nodes(h.render()).some(n=>n.type==='Modal'));
  prevented=false;h.listeners.get('window:beforeunload')!({preventDefault(){prevented=true;},returnValue:null});
  assert.equal(prevented,true);assert.equal(h.posts[0].action,'suspend');h.cleanup();
});

test('failed save keeps confirmation and recording blocks destructive navigation',async()=>{
  const h=harness();h.render();await h.flush();h.render();h.faults.finish=true;
  click(h,'http://localhost/my');let tree=h.render();nodes(tree).find(n=>n.type==='button'&&n.props.children==='종료하고 저장').props.onClick();await h.flush();
  tree=h.render();assert.equal(h.destinations.length,0);assert.ok(nodes(tree).some(n=>n.type==='Modal'));assert.ok(nodes(tree).some(n=>n.type==='Alert'&&n.props.children==='저장 실패 테스트'));
  h.values[6]=true;tree=h.render();assert.equal(nodes(tree).find(n=>n.type==='button'&&n.props.children==='종료하고 저장').props.disabled,true);h.cleanup();
});


test('logout preserves and pauses an unsent chat draft before debounce without submitting or finishing',async()=>{
  const h=harness();h.render();await h.flush();h.render();h.values[1]='아직 보내지 않은 내 답변';h.render();
  await flushPendingDrafts('fixture');assert.deepEqual(h.posts.map(post=>post.action),['pause']);assert.equal(h.posts[0].draft,'아직 보내지 않은 내 답변');assert.equal(h.storage.get('gakja-interview:fixture:session:turn'),'아직 보내지 않은 내 답변');
  assert.equal(h.destinations.length,0);assert.equal(h.values[0].session.state,'active','draft preservation does not complete the interview');h.cleanup();
});

test('chat logout permits a verified persistent device draft during an outage and blocks if both copies fail',async()=>{
  const h=harness();h.render();await h.flush();h.render();h.values[1]='기기 보관 초안';h.render();h.faults.pause=true;await flushPendingDrafts('fixture');assert.equal(h.storage.get('gakja-interview:fixture:session:turn'),'기기 보관 초안');h.cleanup();
  const blocked=harness();blocked.render();await blocked.flush();blocked.render();blocked.values[1]='보존해야 하는 초안';blocked.faults.pause=true;blocked.faults.storage=true;blocked.render();await assert.rejects(flushPendingDrafts('fixture'),/초안을 보관하지 못했어요/);assert.equal(blocked.posts.some(post=>['answer','finish','cancel'].includes(post.action)),false);blocked.cleanup();
});


test('a failed logout after chat pause shows resume and keeps navigation guards and explicit submission working',async()=>{
  const h=harness();h.render();await h.flush();h.render();h.values[1]='로그아웃 실패 뒤 이어 쓸 채팅 답변';h.render();
  await assert.rejects(async()=>{await flushPendingDrafts('fixture');throw Error('auth logout 503');},/auth logout 503/);let tree=h.render();
  assert.equal(h.values[0].session.data.paused,true);assert.equal(h.posts.some(post=>['answer','finish','cancel'].includes(post.action)),false);
  await nodes(tree).find(node=>node.type==='button'&&node.props.children==='면접 재개').props.onClick();await h.flush();tree=h.render();
  assert.equal(h.values[0].session.data.paused,false);assert.equal(click(h,'http://localhost/my'),true,'resuming restores ordinary navigation protection after logout failed');
  tree=h.render();nodes(tree).find(node=>node.type==='button'&&node.props.children==='면접 계속하기').props.onClick();tree=h.render();
  const composer=nodes(tree).find(node=>node.type==='ChatComposer');assert.equal(composer.props.value,'로그아웃 실패 뒤 이어 쓸 채팅 답변');assert.equal(composer.props.disabled,false);
  await composer.props.onSend();await h.flush();assert.deepEqual(h.posts.map(post=>post.action),['pause','resume','answer']);assert.equal(h.posts.filter(post=>post.action==='answer').length,1);h.cleanup();
});

test('the actual interview answer composer follows the account Enter setting without changing or sending its draft',async()=>{
 const h=harness();h.render();await h.flush();h.values[1]='설정 변경 중에도 보관할 답변';let tree=h.render();const composer=()=>nodes(tree).find(node=>node.type==='ChatComposer').props;
 assert.equal(composer().enterToSend,true);h.faults.enterToSend=false;tree=h.render();assert.equal(composer().enterToSend,false);assert.equal(composer().value,'설정 변경 중에도 보관할 답변');h.faults.enterToSend=true;tree=h.render();assert.equal(composer().enterToSend,true);assert.equal(h.posts.some(post=>post.action==='answer'),false);h.cleanup();
});


test('Chat AI help saves and pauses the exact question, refreshes observed help, then resumes the same local draft',async(t)=>{
  const h=harness();t.after(()=>h.cleanup());h.render();await h.flush();let tree=h.render();nodes(tree).find(node=>node.type==='ChatComposer').props.onChange('도움 뒤에 계속 쓸 학생의 초안');tree=h.render();
  let helper=nodes(tree).find(node=>node.type==='LearningHelp');assert.equal(await helper.props.beforeOpen(),true);tree=h.render();assert.equal(h.posts.at(-1).action,'pause');assert.equal(h.posts.at(-1).turnId,'turn');assert.equal(h.posts.at(-1).draft,'도움 뒤에 계속 쓸 학생의 초안');assert.equal(h.destinations.length,0);
  h.source.turns=[{id:'turn',assisted:true,answer:null,helpKinds:['ai']}];helper=nodes(tree).find(node=>node.type==='LearningHelp');await helper.props.onAssisted();tree=h.render();assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.value,'도움 뒤에 계속 쓸 학생의 초안');
  helper=nodes(tree).find(node=>node.type==='LearningHelp');await helper.props.onClose();tree=h.render();assert.equal(h.source.session.data.paused,false);assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.value,'도움 뒤에 계속 쓸 학생의 초안');assert.equal(h.posts.some(post=>post.action==='answer'||post.action==='finish'),false);
});

test('failed Chat AI pause keeps its question and draft and does not navigate',async(t)=>{
  const h=harness();t.after(()=>h.cleanup());h.render();await h.flush();let tree=h.render();nodes(tree).find(node=>node.type==='ChatComposer').props.onChange('저장 실패해도 보존할 초안');tree=h.render();h.faults.pause=true;
  await assert.rejects(nodes(tree).find(node=>node.type==='LearningHelp').props.beforeOpen,/pause offline/);tree=h.render();assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.value,'저장 실패해도 보존할 초안');assert.equal(h.destinations.length,0);assert.equal(h.posts.some(post=>post.action==='answer'||post.action==='finish'),false);
});


test('Chat AI help acknowledges the pause draft immediately instead of leaving the cancelled debounce saving forever',async(t)=>{
 const h=harness();t.after(()=>h.cleanup());h.render();await h.flush();let tree=h.render();nodes(tree).find(node=>node.type==='ChatComposer').props.onChange('도움 전에 저장한 동일 질문 초안');tree=h.render();assert.match(text(tree),/초안 저장 중/);
 const helper=nodes(tree).find(node=>node.type==='LearningHelp');assert.equal(await helper.props.beforeOpen(),true);tree=h.render();assert.match(text(tree),/초안 저장됨/);assert.equal(text(tree).includes('초안 저장 중'),false);assert.equal(h.posts.at(-1).draft,'도움 전에 저장한 동일 질문 초안');assert.equal(nodes(tree).find(node=>node.type==='ChatComposer').props.value,'도움 전에 저장한 동일 질문 초안');assert.equal(h.posts.some(post=>post.action==='answer'||post.action==='finish'),false);
});


test('a verified Chat logout draft allows login navigation without a revoked-cookie suspend or unload prompt',async(t)=>{
 const h=harness();t.after(()=>h.cleanup());h.render();await h.flush();let tree=h.render();nodes(tree).find(node=>node.type==='ChatComposer').props.onChange('로그아웃 전 반드시 보존할 최신 초안');h.render();await flushPendingDrafts('fixture');
 h.listeners.get('window:gakja:logout-ready')!({detail:{userId:'fixture'}});
 const before=h.posts.length;let prevented=false;h.listeners.get('window:beforeunload')!({preventDefault(){prevented=true;},returnValue:undefined});
 assert.equal(prevented,false,'after verified saving, auth logout may replace the page without the interview cancelling it');assert.equal(h.posts.slice(before).some(post=>post.action==='suspend'),false,'no protected API is called after credentials were revoked');assert.equal(h.storage.get('gakja-interview:fixture:session:turn'),'로그아웃 전 반드시 보존할 최신 초안');assert.equal(h.posts.some(post=>post.action==='answer'||post.action==='finish'),false);
});

test('failed Chat draft preservation keeps the unload guard armed and cannot authorize logout navigation',async(t)=>{
 const h=harness();t.after(()=>h.cleanup());h.render();await h.flush();h.values[1]='보관이 확인되지 않은 초안';h.render();h.faults.pause=true;h.faults.storage=true;
 await assert.rejects(flushPendingDrafts('fixture'),/초안을 보관하지 못했어요/);let prevented=false;h.listeners.get('window:beforeunload')!({preventDefault(){prevented=true;},returnValue:undefined});assert.equal(prevented,true);assert.equal(h.posts.some(post=>post.action==='answer'||post.action==='finish'),false);
});


for(const stage of ['other-writer','study-session','auth'])test(`a failed ${stage} after device-only Chat draft saving keeps active navigation guards armed`,async(t)=>{
 const h=harness();t.after(()=>h.cleanup());h.render();await h.flush();h.values[1]='서버 pause 실패 때도 기기에서 검증한 초안';h.render();h.faults.pause=true;
 let unregister:undefined|(()=>void);if(stage==='other-writer'){unregister=registerDraftSaver('fixture',async()=>{throw Error('other writer failed');});t.after(()=>unregister?.());await assert.rejects(flushPendingDrafts('fixture'),/초안을 보관하지 못했어요/);}else await assert.rejects(async()=>{await flushPendingDrafts('fixture');throw Error(stage+' failed');},/failed/);
 assert.equal(Boolean(h.source.session.data.paused),false,'the failed pause leaves this room active without a resume control');let prevented=false;h.listeners.get('window:beforeunload')!({preventDefault(){prevented=true;},returnValue:undefined});assert.equal(prevented,true,'saving a device draft alone cannot grant an auth navigation handoff');assert.equal(h.storage.get('gakja-interview:fixture:session:turn'),'서버 pause 실패 때도 기기에서 검증한 초안');
});
