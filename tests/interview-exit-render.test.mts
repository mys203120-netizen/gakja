import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as timer from '../apps/web/src/lib/interview-timer';

function harness(){
  const values:any[]=[],deps:any[]=[],cleanups:any[]=[],effects:any[]=[];
  const listeners=new Map<string,Function>(),posts:any[]=[],destinations:string[]=[];
  const source={session:{state:'active',kind:'chat',data:{elapsedMs:0,activeSince:Date.now()-5000,timerLeaseUntil:Date.now()+25000,context:{},panelists:[]}},turns:[],question:{turnId:'turn',id:'question',prompt:'테스트 질문',draft:''}};
  let index=0;const faults={finish:false};
  const events=(prefix:string)=>({addEventListener:(name:string,fn:Function)=>listeners.set(prefix+name,fn),removeEventListener:(name:string)=>listeners.delete(prefix+name)});
  const document={...events('document:'),visibilityState:'visible',activeElement:null};
  const location={href:'http://localhost/interview/chat/session',origin:'http://localhost',pathname:'/interview/chat/session',search:'',assign:(url:string)=>destinations.push(url)};
  const mod={exports:{} as any};
  const react={useState:(initial:any)=>{const i=index++;if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return [values[i],(value:any)=>{values[i]=typeof value==='function'?value(values[i]):value;}];},useRef:(initial:any)=>{const i=index++;return values[i]??(values[i]={current:initial});},useEffect:(fn:Function,next:any[])=>{const i=index++;if(!deps[i]||next?.some((v,j)=>v!==deps[i][j])){deps[i]=next;effects.push(()=>{cleanups[i]?.();cleanups[i]=fn();});}}};
  vm.runInNewContext(ts.transpileModule(readFileSync('apps/web/src/components/interview.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
    module:mod,exports:mod.exports,Date,URL,document,location,window:{...events('window:'),navigation:events('navigation:')},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){},
    fetch:async(_url:string,init:any)=>{posts.push(JSON.parse(init.body));return {ok:true};},
    require(name:string){
      if(name==='react')return react;
      if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props}),Fragment:'Fragment'};
      if(name==='next/navigation')return {useRouter:()=>({push:(url:string)=>destinations.push(url)})};
      if(name==='./app-shell')return {useApp:()=>({data:{user:{id:'fixture'}},refresh:async()=>{},toast(){},openResource(){}})};
      if(name==='./shared')return {api:async()=>structuredClone(source),post:async(_url:string,body:any)=>{posts.push(body);if(body.action==='finish'&&faults.finish)throw new Error('저장 실패 테스트');return {report:{id:'saved-report'},session:source.session};},Modal:'Modal',Breadcrumb:'Breadcrumb',Alert:'Alert',targetName:()=>''};
      if(name==='@/lib/interview-timer')return timer;
      if(name==='./playful-flow')return {animateStudyReceipt(){}};
      return new Proxy({},{get:(_,key)=>String(key)});
    }
  });
  const render=()=>{index=0;const tree=mod.exports.ChatInterviewSession({id:'session',kind:'chat'});while(effects.length)effects.shift()();return tree;};
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  return {render,flush,faults,values,listeners,posts,destinations,document,cleanup:()=>cleanups.forEach(fn=>fn?.())};
}
function nodes(tree:any):any[]{return !tree||typeof tree!=='object'?[]:Array.isArray(tree)?tree.flatMap(nodes):[tree,...nodes(tree.props?.children)];}
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
