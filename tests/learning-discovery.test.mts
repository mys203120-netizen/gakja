// @ts-nocheck
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';

const source=ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/learning-discovery.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const nodes=node=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.props?.children)]:[];
function harness(){
 let active,id=0;
 const intervals=new Map(),timeouts=new Map(),listeners=new Map(),motionListeners=new Set(),observers=new Set();
 const media={matches:false,addEventListener(_event,fn){motionListeners.add(fn);},removeEventListener(_event,fn){motionListeners.delete(fn);}};
 const document={hidden:false,addEventListener(event,fn){const list=listeners.get(event)||new Set();list.add(fn);listeners.set(event,list);},removeEventListener(event,fn){listeners.get(event)?.delete(fn);}};
 const context={data:{user:{id:'student-a'},package:{active_version:1}},learningRevision:0};
 const calls=[];
 let respond=async url=>url.startsWith('/api/knowledge-bites')?{videos:[]}:{articles:[]};
 const hooks={...React,
  useState(initial){const owner=active,slot=owner.cursor++;const record=owner.hooks[slot]??={value:typeof initial==='function'?initial():initial};return[record.value,value=>{record.value=typeof value==='function'?value(record.value):value;owner.dirty=true;}];},
  useRef(initial){return active.hooks[active.cursor++]??={current:initial};},
  useEffect(effect,deps){const owner=active,slot=owner.cursor++,previous=owner.hooks[slot];if(!previous||deps.some((value,index)=>value!==previous.deps[index])){owner.hooks[slot]={deps,cleanup:previous?.cleanup};owner.effects.push(()=>{previous?.cleanup?.();owner.hooks[slot].cleanup=effect();});}},
 };
 function component(fn,props){return{fn,props,hooks:[],cursor:0,effects:[],dirty:true,tree:null,
  render(){this.cursor=0;this.dirty=false;active=this;try{this.tree=this.fn(this.props);for(const node of nodes(this.tree))if(node.props?.ref&&typeof node.props.ref==='object')node.props.ref.current={};return this.tree;}finally{active=null;}},
  flush(){for(let guard=0;guard<20&&(this.dirty||this.effects.length);guard++){if(this.dirty)this.render();for(const effect of this.effects.splice(0))effect();}return this.tree;},
  dispose(){for(const hook of this.hooks)hook?.cleanup?.();},
 };}
 const module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,AbortController,URLSearchParams,window:{matchMedia:()=>media},document,
  IntersectionObserver:class{constructor(callback){this.callback=callback;observers.add(this);}observe(){this.callback([{isIntersecting:true}]);}disconnect(){observers.delete(this);}},
  setInterval(callback,delay){const key=++id;intervals.set(key,{callback,delay});return key;},clearInterval(key){intervals.delete(key);},
  setTimeout(callback,delay){const key=++id;timeouts.set(key,{callback,delay});return key;},clearTimeout(key){timeouts.delete(key);},
  require(name){if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsx;if(name==='lucide-react')return icons;if(name==='next/link')return{__esModule:true,default:'a'};if(name==='./app-shell')return{useApp:()=>context};if(name==='./shared')return{api:async(url,options)=>{calls.push({url,signal:options.signal});return respond(url,options);}};if(name==='./owned-class-name')return{ownedClassName:value=>value};if(name.endsWith('.css'))return{__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};throw Error(name);}
 });
 const root=component(module.exports.LearningDiscovery,{targetId:'school-a'});
 const previews=()=>nodes(root.tree).filter(node=>typeof node.type==='function');
 return{root,context,calls,intervals,timeouts,document,media,previews,
  respond(fn){respond=fn;},
  async settle(){await new Promise(setImmediate);root.flush();},
  card(index=0,overrides={}){root.flush();const node=previews()[index];const card=component(node.type,{...node.props,...overrides});card.flush();return card;},
  tick(ms=3600){for(const timer of [...intervals.values()])for(let i=0;i<Math.floor(ms/timer.delay);i++)timer.callback();},
  hide(value){document.hidden=value;for(const listener of listeners.get('visibilitychange')||[])listener();},
  viewport(value){for(const observer of observers)observer.callback([{isIntersecting:value}]);},
  reduce(value){media.matches=value;for(const listener of motionListeners)listener();},
 };
}
const title=card=>nodes(card.tree).find(node=>node.props?.className?.split(' ').includes('current'))?.props.children[0].props.children;
const items=()=>[0,1,2].map(index=>({id:'material-'+index,title:'실제 자료 '+index,source:'발행 기관',href:'/knowledge/material-'+index}));
function activeCard(h,index=0){
 return h.card(index,{items:items()});
}

test('discovery reads each authenticated scope independently and excludes historical knowledge from previews',async()=>{
 const h=harness();h.respond(async url=>url.includes('knowledge-bites')?{videos:[{id:'current',current:true,label:'학과의 실제 자료',channel:'기관'},{id:'old',current:false,label:'이전 학교 자료',channel:'이전 기관'}]}:{articles:[{id:'news',title:'실제 기사 제목',publisher:'신문'}]});
 h.root.render();assert.equal(h.calls.length,0,'render itself performs no requests');h.root.flush();await h.settle();
 assert.deepEqual(h.calls.map(item=>item.url),['/api/knowledge-bites?targetId=school-a','/api/news?targetId=school-a']);
 assert.equal(h.previews()[0].props.items.length,1);assert.equal(h.previews()[0].props.items[0].title,'학과의 실제 자료');
 assert.equal(h.previews()[0].props.items[0].href,'/knowledge/current?targetId=school-a');
 assert.equal(h.previews()[1].props.items[0].source,'신문');
 h.root.props={targetId:'school-b'};h.root.render();assert.equal(h.previews()[0].props.items.length,0,'a target switch hides the preceding target before its effect runs');
 h.root.flush();assert.equal(h.calls[0].signal.aborted,true);await h.settle();
 h.root.dispose();
});

test('a visible preview advances at 3.6 seconds and loops indefinitely',()=>{
 const h=harness(),card=activeCard(h);
 assert.equal(title(card),'실제 자료 0');assert.equal(h.intervals.size,1);
 h.tick();card.flush();assert.equal(title(card),'실제 자료 1');
 h.tick();card.flush();assert.equal(title(card),'실제 자료 2');
 h.tick();card.flush();assert.equal(title(card),'실제 자료 0');
 card.dispose();assert.equal(h.intervals.size,0);
});

test('focus, hover, manual pause and a background tab stop automatic changes',()=>{
 const h=harness(),card=activeCard(h);
 card.tree.props.onMouseEnter();card.flush();assert.equal(h.intervals.size,0);
 card.tree.props.onMouseLeave();card.flush();assert.equal(h.intervals.size,1);
 card.tree.props.onFocusCapture();card.flush();assert.equal(h.intervals.size,0);
 card.tree.props.onBlurCapture({currentTarget:{contains:()=>false},relatedTarget:null});card.flush();assert.equal(h.intervals.size,1);
 const pause=nodes(card.tree).find(node=>node.type==='button');pause.props.onClick();card.flush();assert.equal(h.intervals.size,0);
 assert.equal(nodes(card.tree).find(node=>node.type==='button').props['aria-pressed'],true);
 nodes(card.tree).find(node=>node.type==='button').props.onClick();card.flush();assert.equal(h.intervals.size,1);
 h.hide(true);card.flush();assert.equal(h.intervals.size,0);
 h.hide(false);card.flush();assert.equal(h.intervals.size,1);
 h.viewport(false);card.flush();assert.equal(h.intervals.size,0);
 h.viewport(true);card.flush();assert.equal(h.intervals.size,1);
 card.dispose();
});

test('reduced-motion preferences disable rotation and remove redundant motion controls',()=>{
 const h=harness(),card=activeCard(h,1);
 assert.equal(h.intervals.size,1);h.reduce(true);card.flush();assert.equal(h.intervals.size,0);
 assert.equal(nodes(card.tree).filter(node=>node.type==='button').length,0);
 h.tick(7200);card.flush();assert.equal(title(card),'실제 자료 0');
 h.reduce(false);card.flush();assert.equal(h.intervals.size,1);card.dispose();
});
