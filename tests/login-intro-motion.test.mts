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
  vm.runInNewContext(code,{module,exports:module.exports,IntersectionObserver:Observer,window:{matchMedia:()=>media},require(name:string){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};
    if(name==='react')return {...React,useEffect:(fn:Function)=>effects.push(fn),useRef:(value:any)=>({current:value})};
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
