import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';

function compile(file:string){return ts.transpileModule(readFileSync(new URL('../apps/web/src/components/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;}
function nodes(tree:any,match:(node:any)=>boolean):any[]{return React.isValidElement(tree)?[...(match(tree)?[tree]:[]),...React.Children.toArray((tree.props as any).children).flatMap(child=>nodes(child,match))]:[];}
function harness(initialEnabled=true){
  let helpEnabled=initialEnabled;
  const hooks:any[]=[],effects:(()=>void)[]=[],timers=new Map<number,()=>void>();let cursor=0,dirty=true,tree:any,timerId=0;
  const listeners={document:new Map<string,Set<(event:any)=>void>>(),window:new Map<string,Set<(event:any)=>void>>()};
  const events=(name:'document'|'window')=>({addEventListener(key:string,fn:(event:any)=>void){const set=listeners[name].get(key)||new Set();set.add(fn);listeners[name].set(key,set);},removeEventListener(key:string,fn:(event:any)=>void){listeners[name].get(key)?.delete(fn);}});
  const anchor:any={getBoundingClientRect:()=>({left:340,top:720,bottom:764,width:44,height:44}),contains:(node:any)=>node===anchor,closest:()=>null};
  const surface:any={getBoundingClientRect:()=>({width:320,height:160}),contains:(node:any)=>node===surface};
  const document:any={...events('document'),body:{},activeElement:null},window={...events('window'),innerWidth:390,innerHeight:844};
  const changed=(previous:any,deps:any[])=>!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]));
  const react={...React,useId(){return 'help-panel';},useRef(initial:any){return hooks[cursor++]??={current:initial};},useState(initial:any){const index=cursor++;if(!(index in hooks))hooks[index]=initial;return [hooks[index],(value:any)=>{const next=typeof value==='function'?value(hooks[index]):value;if(!Object.is(next,hooks[index])){hooks[index]=next;dirty=true;}}];},useCallback(fn:any,deps:any[]){const index=cursor++,previous=hooks[index];if(changed(previous,deps))hooks[index]={deps,value:fn};return hooks[index].value;},useEffect(effect:any,deps:any[]){const index=cursor++,previous=hooks[index];if(changed(previous,deps)){hooks[index]={deps,cleanup:previous?.cleanup};effects.push(()=>{hooks[index].cleanup?.();hooks[index].cleanup=effect();});}}};
  const module={exports:{}} as any;
  vm.runInNewContext(compile('info-tip.tsx'),{module,exports:module.exports,document,window,setTimeout:(fn:()=>void)=>{timers.set(++timerId,fn);return timerId;},clearTimeout:(id:number)=>timers.delete(id),require(name:string){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;if(name==='react-dom')return {createPortal:(child:any)=>child};if(name==='lucide-react')return {Info:()=>null};if(name==='./help-preferences')return {useHelpEnabled:()=>helpEnabled};if(name.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};throw Error(name);}});
  function flush(){for(let n=0;n<12;n++){if(dirty){dirty=false;cursor=0;tree=module.exports.InfoTip({label:'도움 안내',children:'필요할 때 확인하는 보조 설명'});for(const node of nodes(tree,node=>node.props.ref)){(node.props.ref as any).current=node.type==='button'?anchor:surface;}while(effects.length)effects.shift()!();}if(!dirty)return;}throw Error('Tooltip did not settle');}
  return {flush,setEnabled(value:boolean){helpEnabled=value;dirty=true;},get button(){return nodes(tree,node=>node.type==='button')[0];},get panel(){return nodes(tree,node=>node.props.role==='tooltip')[0];},document,anchor,surface,emit(key:string,event:any){for(const fn of [...listeners.document.get(key)||[]])fn(event);},runTimers(){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn());},unmount(){for(const hook of hooks)hook?.cleanup?.();},listeners};
}

test('optional help opens on hover and focus, and stays available while moving into its panel',()=>{
  const h=harness();h.flush();assert.equal(h.panel,undefined);assert.equal(h.button.props['aria-expanded'],false);
  h.button.props.onPointerEnter({pointerType:'mouse'});h.flush();assert.equal(h.panel.props.role,'tooltip');assert.equal(h.button.props['aria-describedby'],h.panel.props.id);
  assert.equal(h.panel.props.style.left,54,'panel stays within a 390px viewport');assert.equal(h.panel.props.style.top,552,'panel fits above a low trigger');
  h.button.props.onPointerLeave();h.panel.props.onPointerEnter();h.runTimers();h.flush();assert.ok(h.panel);
  h.panel.props.onPointerLeave();h.runTimers();h.flush();assert.equal(h.panel,undefined);
  h.document.activeElement=h.anchor;h.button.props.onFocus();h.flush();h.button.props.onPointerLeave();h.runTimers();h.flush();assert.ok(h.panel,'keyboard focus keeps the explanation visible');
  h.button.props.onBlur({relatedTarget:{}});h.flush();assert.equal(h.panel,undefined);h.unmount();
});

test('touch tap pins help; Escape, another tap, and outside interaction dismiss it without submitting',()=>{
  const h=harness();h.flush();assert.equal(h.button.props.type,'button');
  h.button.props.onPointerEnter({pointerType:'touch'});h.flush();assert.equal(h.panel,undefined);
  h.button.props.onFocus();h.button.props.onClick();h.flush();assert.ok(h.panel,'a touch focus followed by click does not immediately close');
  h.button.props.onPointerLeave();h.runTimers();h.flush();assert.ok(h.panel);
  let prevented=false,stopped=false;h.emit('keydown',{key:'Escape',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});h.flush();assert.equal(h.panel,undefined);assert.ok(prevented&&stopped);
  h.button.props.onClick();h.flush();assert.ok(h.panel);h.button.props.onClick();h.flush();assert.equal(h.panel,undefined);
  h.button.props.onClick();h.flush();h.emit('pointerdown',{target:h.surface});h.flush();assert.ok(h.panel,'inside clicks retain the explanation');
  h.emit('pointerdown',{target:{}});h.flush();assert.equal(h.panel,undefined);
  h.button.props.onClick();h.flush();h.emit('focusin',{target:{}});h.flush();assert.equal(h.panel,undefined,'Tab to another control dismisses pinned help');
  h.button.props.onClick();h.flush();h.unmount();assert.equal([...h.listeners.document.values()].reduce((total,set)=>total+set.size,0),0,'global listeners are removed');
});

test('only repeated tab titles are visually hidden; questions, form titles, and header actions remain',()=>{
  const module={exports:{}} as any;
  vm.runInNewContext(compile('shared.tsx'),{module,exports:module.exports,Set,require(name:string){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};if(name==='react/jsx-runtime')return jsx;if(name==='react')return React;if(name==='react-dom')return {createPortal:(child:any)=>child};if(name==='lucide-react')return {};if(name==='next/link')return {default:'a'};if(name==='./info-tip')return {InfoTip:'Help'};if(name==='./floating-notice')return {FloatingNotice:'Notice'};if(name==='@/lib/client/request-cache')return {requestJson(){throw Error('No network');}};if(name.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};throw Error(name);}});
  const PageTitle=module.exports.PageTitle,heading=(tree:any)=>nodes(tree,node=>node.type==='h1')[0];
  const plain=PageTitle({title:'AI 비서'});assert.equal(plain.props['data-title-only'],true);assert.equal(heading(plain).props.children,'AI 비서');assert.equal(heading(plain).props.className,'hiddenTitle');
  const action=React.createElement('button',null,'내 기록 내보내기'),withAction=PageTitle({title:'내 리포트',aside:action});assert.equal(nodes(withAction,node=>node.type==='button')[0].props.children,action.props.children);assert.notEqual(withAction.props['data-title-only'],true);
  const explained=PageTitle({title:'나의 무기고',children:'내 경험을 질문에 연결해요.'});assert.equal(nodes(explained,node=>node.type==='Help').length,0,'generic tab copy is removed instead of creating another tooltip');
  const necessary=PageTitle({title:'나의 무기고',help:'내가 확인한 사실만 활동에 반영돼요.'});assert.equal(nodes(necessary,node=>node.type==='Help')[0].props.children,'내가 확인한 사실만 활동에 반영돼요.');
  for(const props of [{title:'답변 초안'},{title:'이 질문 말하기'},{title:'퀴즈',questionId:'question-1'},{title:'지원 학교',titleMode:'visible'}])assert.equal(heading(PageTitle(props)).props.className,undefined);
  const form=PageTitle({title:'답변 초안',children:'필수 입력과 저장 안내'});assert.equal(nodes(form,node=>node.props.className==='subtitle')[0].props.children,'필수 입력과 저장 안내');
});


test('per-account help preference hides triggers on initial render and dismisses an already-open portal',()=>{
  const disabled=harness(false);disabled.flush();assert.equal(disabled.button,undefined);assert.equal(disabled.panel,undefined);disabled.unmount();
  const h=harness();h.flush();h.button.props.onClick();h.flush();assert.ok(h.panel);
  h.setEnabled(false);h.flush();assert.equal(h.button,undefined);assert.equal(h.panel,undefined);
  assert.equal([...h.listeners.document.values()].reduce((total,set)=>total+set.size,0),0,'hidden help removes its global listeners');
  h.setEnabled(true);h.flush();assert.ok(h.button);assert.equal(h.panel,undefined,'enabling help does not reopen a stale tooltip');h.unmount();
});
