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
import {learningTargetIdentityMatches} from '../packages/content-contracts/src/workflows';

const code=ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/quick-start.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const common={id:'common-item',question_id:'common_motivation',prompt:'지원 동기를 내 경험과 연결해 말해보세요.',source_kind:'common',common_revision:1};
const text=(node:any):string=>node==null||typeof node==='boolean'?'':typeof node==='string'?node:Array.isArray(node)?node.map(text).join(''):text(node.props?.children);
const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.props?.children)]:[];
function harness(options:{storage?:Map<string,string>;foreignSession?:boolean;failAnswer?:boolean;lostAnswerResponse?:boolean}={}){
  const storage=options.storage||new Map<string,string>(),hooks:any[]=[],effects:any[]=[],pending:Array<()=>void>=[],timers=new Map<number,()=>void>(),requests:any[]=[];
  let cursor=0,dirty=true,tree:any,timerId=0,refreshes=0;
  const app:any={data:{user:{id:'student'},targets:[]},target:undefined,refresh:async()=>{refreshes++;}};
  let responses:any[]=[],session:any={id:'session-1',student_id:'student',mode:'answer',state:'ready',current_index:0,total:1,items:[common],metadata:{targetId:null,targetSnapshot:null}};
  const react={...React,
    useState(initial:any){const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return [hooks[i],(value:any)=>{const next=typeof value==='function'?value(hooks[i]):value;if(!Object.is(hooks[i],next)){hooks[i]=next;dirty=true;}}];},
    useRef(initial:any){const i=cursor++;return hooks[i]??={current:initial};},
    useEffect(effect:()=>void,deps:any[]){const i=cursor++,previous=effects[i];if(!previous||deps.some((value,index)=>!Object.is(value,previous.deps[index]))){effects[i]={deps,cleanup:previous?.cleanup};pending.push(()=>{effects[i].cleanup?.();effects[i].cleanup=effect();});}},
  };
  const api=async(url:string)=>{
    requests.push({url});
    if(url==='/api/quiz?sourceType=common&general=1')return {library:{answer:[{id:'personal',source_kind:'personal'},common]}};
    if(url==='/api/quiz?sessionId=session-1')return {session:{...session,student_id:options.foreignSession?'other':session.student_id},responses};
    throw Error('Unexpected read '+url);
  };
  const post=async(url:string,input:any)=>{
    requests.push({url,input:structuredClone(input)});assert.equal(url,'/api/quiz');
    if(input.action==='create')return {session:structuredClone(session)};
    assert.equal(input.sessionId,'session-1');
    if(input.action==='draft'){session.metadata.drafts={'0':{response:input.response,updatedAt:new Date().toISOString()}};return {session:structuredClone(session)};}
    if(input.action==='start'){session.state='active';return {session:structuredClone(session)};}
    if(input.action==='answer'){
      if(options.failAnswer)throw Error('저장 응답을 확인하지 못했어요.');
      assert.equal(session.state,'active');assert.equal(input.itemIndex,0);assert.equal(input.recallStatus,'unchecked');
      session.state='completed';session.current_index=1;session.metadata.drafts={};responses=[{item_index:0,response:input.response}];if(options.lostAnswerResponse)throw Error('response lost after commit');return {session:structuredClone(session),response:responses[0]};
    }
    throw Error('Unexpected action '+input.action);
  };
  const module={exports:{} as any};
  vm.runInNewContext(code,{module,exports:module.exports,console,URLSearchParams,AbortController,Date,crypto:{randomUUID},setTimeout:(callback:()=>void)=>{timers.set(++timerId,callback);return timerId;},clearTimeout:(id:number)=>timers.delete(id),localStorage:{getItem:(key:string)=>storage.get(key)||null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)},require(name:string){
    if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;if(name==='lucide-react')return icons;
    if(name==='next/link')return {__esModule:true,default:'Link'};
    if(name==='next/navigation')return {useSearchParams:()=>new URLSearchParams()};
    if(name==='./app-shell')return {useApp:()=>app};
    if(name==='./shared')return {api,post,ActionButton:'ActionButton',Alert:'Alert'};
    if(name==='@/lib/learning-target-scope')return {learningScopeIdentity};
    if(name==='@gakja/content-contracts/workflows')return {learningTargetIdentityMatches};
    if(name.endsWith('.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};
    throw Error(name);
  }});
  async function flush(){for(let i=0;i<20;i++){if(dirty){dirty=false;cursor=0;tree=module.exports.QuickStart();while(pending.length)pending.shift()!();}await new Promise(resolve=>setImmediate(resolve));if(!dirty)return;}throw Error('Render loop');}
  const button=(label:string)=>{const matching=nodes(tree).filter(node=>['button','ActionButton'].includes(node.type)&&text(node).includes(label));assert.equal(matching.length,1,label);return matching[0];};
  return {flush,button,storage,requests,app,get tree(){return tree;},get refreshes(){return refreshes;},async timers(){const callbacks=[...timers.values()];timers.clear();callbacks.forEach(callback=>callback());await flush();},async write(value:string){nodes(tree).find(node=>node.type==='textarea').props.onChange({target:{value}});await flush();},get session(){return session;},change(){dirty=true;},dispose(){effects.forEach(effect=>effect?.cleanup?.());}};
}

test('first common question accepts optional three keywords, skip and one server-saved sentence without school or personal input',async()=>{
  const h=harness();await h.flush();assert.match(text(h.tree),/공통 연습 질문/);assert.match(text(h.tree),/개인 학생부에서 만든 질문이 아니에요/);
  for(const label of ['협업','문제 해결','탐구']){h.button(label).props.onClick();await h.flush();}
  assert.equal(h.button('실패와 배움').props.disabled,true);
  await h.button('키워드 건너뛰고 시작').props.onClick();await h.flush();
  const create=h.requests.find(request=>request.input?.action==='create').input;
  assert.equal(create.targetId,null);assert.equal(create.sourceType,'common');assert.deepEqual(create.itemIds,['common-item']);
  assert.ok(!text(h.tree).includes('떠올릴 키워드:'));
  await h.write('저는 팀 자료의 기준을 정리했어요.');await h.timers();
  assert.equal(h.session.metadata.drafts['0'].response,'저는 팀 자료의 기준을 정리했어요.');
  assert.ok(h.storage.get('gakja-quiz:student:session-1:0')?.includes('팀 자료'));
  await h.button('한 문장 저장하고 완료').props.onClick();await h.flush();
  assert.equal(h.session.state,'completed');assert.match(text(h.tree),/첫 답을 저장했어요/);assert.equal(h.refreshes,1);
  assert.equal(h.storage.has('gakja-quiz:student:session-1:0'),false);
  assert.ok(nodes(h.tree).some(node=>node.props?.href==='/schools/new?onboarding=1'));
  h.dispose();
});
test('failed first answer keeps its local draft and does not claim completion',async()=>{
  const h=harness({failAnswer:true});await h.flush();await h.button('질문 한 개 답해보기').props.onClick();await h.flush();await h.write('저는 측정 순서를 정했어요.');
  await h.button('한 문장 저장하고 완료').props.onClick();await h.flush();
  assert.ok(!text(h.tree).includes('첫 답을 저장했어요'));assert.match(text(h.tree),/저장 응답을 확인하지 못했어요/);
  assert.ok(h.storage.get('gakja-quiz:student:session-1:0')?.includes('측정 순서'));assert.equal(h.refreshes,0);h.dispose();
});
test('local first-question pointers cannot restore a different student session',async()=>{
  const scope=JSON.stringify(['student',null,null]),storage=new Map([['gakja-first-question:student:common',JSON.stringify({scope,sessionId:'session-1',answer:'다른 계정의 글'})]]);
  const h=harness({storage,foreignSession:true});await h.flush();assert.ok(!nodes(h.tree).some(node=>node.type==='textarea'));assert.ok(!text(h.tree).includes('다른 계정의 글'));h.dispose();
});
test('a lost first-answer response is confirmed from the exact owned receipt, including surrounding whitespace',async()=>{
  const h=harness({lostAnswerResponse:true});await h.flush();await h.button('질문 한 개 답해보기').props.onClick();await h.flush();await h.write('  저는 직접 수집 순서를 정했어요.  ');
  await h.button('한 문장 저장하고 완료').props.onClick();await h.flush();
  assert.match(text(h.tree),/첫 답을 저장했어요/);assert.equal(h.session.current_index,1);
  assert.equal(h.requests.filter(request=>request.input?.action==='answer').length,1);
  assert.equal(h.requests.find(request=>request.input?.action==='answer').input.response,'저는 직접 수집 순서를 정했어요.');
  assert.equal(h.storage.has('gakja-quiz:student:session-1:0'),false);h.dispose();
});
