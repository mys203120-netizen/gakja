import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';

const code=ts.transpileModule(readFileSync('apps/web/src/components/login-intro-sheet.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const nodes=(node:any):any[]=>React.isValidElement(node)?[node,...React.Children.toArray((node.props as any).children).flatMap(nodes)]:[];

test('login introduction reveals again after leaving and reentering the viewport and respects reduced motion changes',()=>{
  const effects:Function[]=[],blocks=[{dataset:{} as any},{dataset:{} as any}],section={dataset:{} as any,querySelectorAll:()=>blocks};
  const changes=new Set<Function>(),media={matches:false,addEventListener:(_event:string,listener:Function)=>changes.add(listener),removeEventListener:(_event:string,listener:Function)=>changes.delete(listener)};
  let callback:Function=()=>{},disconnected=0;
  class Observer{constructor(fn:Function){callback=fn;}observe(){}disconnect(){disconnected++;}}
  const module={exports:{} as any};
  vm.runInNewContext(code,{module,exports:module.exports,IntersectionObserver:Observer,window:{matchMedia:()=>media},require(name:string){if(name==='@/lib/analytics')return {trackEvent:()=>{}};if(name==='./public-faq')return {PublicFaq:()=>null};if(name==='./public-links')return {PublicLinks:()=>null};if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};
    if(name==='react')return {...React,useEffect:(fn:Function)=>effects.push(fn),useRef:(value:any)=>({current:value}),useState:()=>[false,()=>{}]};
    if(name==='react/jsx-runtime')return jsx;
    if(name==='lucide-react')return new Proxy({},{get:()=>()=>null});
    if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
    throw Error(name);
  }});
  const tree=module.exports.LoginIntroSheet({});
  const node=nodes(tree).find(node=>node.props.id==='login-overview');node.props.ref.current=section;
  const cleanup=effects[0]();
  assert.equal(section.dataset.motion,'ready');assert.equal(blocks[0].dataset.visible,'false');
  callback([{target:blocks[0],isIntersecting:true}]);assert.equal(blocks[0].dataset.visible,'true');
  callback([{target:blocks[0],isIntersecting:false}]);assert.equal(blocks[0].dataset.visible,'false');
  callback([{target:blocks[0],isIntersecting:true}]);assert.equal(blocks[0].dataset.visible,'true','repeated scrolling shows the content each time');
  media.matches=true;for(const listener of changes)listener();assert.equal(section.dataset.motion,undefined,'content remains visible with reduced motion');
  cleanup();assert.ok(disconnected>=2);assert.equal(changes.size,0);
});

test('mobile start appears only past the login form, hides for input and keyboard, then returns focus to login',()=>{
  let visible=false,callback:Function=()=>{},observed:any,focused=false,scrolled=false;
  const effects:Function[]=[],events=new Map<string,Function>(),mediaEvents=new Map<string,Function>(),viewportEvents=new Map<string,Function>(),tracked:any[]=[];
  const form={},heading={scrollIntoView(){scrolled=true;},focus(){focused=true;}},control={focus(){focused=true;}};
  class Element{isContentEditable=false;constructor(public editing=false){}matches(){return this.editing;}}
  const document={activeElement:new Element(),getElementById:(id:string)=>id==='auth-form'?form:heading,querySelector:()=>control,addEventListener:(name:string,fn:Function)=>events.set(name,fn),removeEventListener:(name:string)=>events.delete(name)};
  const mobile={matches:true,addEventListener:(name:string,fn:Function)=>mediaEvents.set(name,fn),removeEventListener:(name:string)=>mediaEvents.delete(name)},viewport={height:800,addEventListener:(name:string,fn:Function)=>viewportEvents.set(name,fn),removeEventListener:(name:string)=>viewportEvents.delete(name)};
  class Observer{constructor(fn:Function){callback=fn;}observe(node:any){observed=node;}disconnect(){}}
  const module={exports:{} as any};
  vm.runInNewContext(code,{module,exports:module.exports,document,HTMLElement:Element,IntersectionObserver:Observer,window:{innerHeight:800,visualViewport:viewport,matchMedia:(query:string)=>query.includes('max-width')?mobile:{matches:true}},require(name:string){
    if(name==='./owned-class-name')return {ownedClassName:(value:string)=>value};
    if(name==='react')return {...React,useEffect:(fn:Function)=>effects.push(fn),useRef:(current:any)=>({current}),useState:()=>[visible,(value:boolean)=>{visible=value;}]};
    if(name==='react/jsx-runtime')return jsx;
    if(name==='lucide-react')return new Proxy({},{get:()=>()=>null});
    if(name==='@/lib/analytics')return {trackEvent:(event:string,data:any)=>tracked.push({event,...data})};
    if(name==='./public-faq')return {PublicFaq:()=>null};
    if(name==='./public-links')return {PublicLinks:()=>null};
    if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
    throw Error(name);
  }});
  const render=(disabled=false)=>module.exports.LoginIntroSheet({disabled});
  const sticky=(tree:any)=>nodes(tree).find(node=>node.props.className==='mobileStart');
  assert.equal(sticky(render()),undefined);
  const cleanup=effects[1]();assert.equal(observed,form);
  callback([{isIntersecting:true,boundingClientRect:{bottom:100}}]);assert.equal(sticky(render()),undefined);
  callback([{isIntersecting:false,boundingClientRect:{bottom:900}}]);assert.equal(sticky(render()),undefined,'not visible before the form');
  callback([{isIntersecting:false,boundingClientRect:{bottom:-1}}]);assert.ok(sticky(render()));
  document.activeElement=new Element(true);events.get('focusin')!();assert.equal(sticky(render()),undefined);
  document.activeElement=new Element();events.get('focusout')!();assert.ok(sticky(render()));
  viewport.height=550;viewportEvents.get('resize')!();assert.equal(sticky(render()),undefined);
  viewport.height=800;viewportEvents.get('resize')!();assert.ok(sticky(render()));
  mobile.matches=false;mediaEvents.get('change')!();assert.equal(sticky(render()),undefined);
  mobile.matches=true;mediaEvents.get('change')!();assert.ok(sticky(render()));
  const button=nodes(sticky(render())).find(node=>node.type==='button');button.props.onClick();
  assert.equal(scrolled,true);assert.equal(focused,true);assert.deepEqual(tracked,[{event:'cta_start_click',placement:'mobile'}]);
  assert.equal(sticky(render(true)),undefined,'busy authentication hides the fixed start immediately');
  cleanup();assert.equal(events.size,0);assert.equal(viewportEvents.size,0);assert.equal(mediaEvents.size,0);
});
