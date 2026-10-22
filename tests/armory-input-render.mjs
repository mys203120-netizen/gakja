import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import {tsImport} from 'tsx/esm/api';
const model=await tsImport('../apps/web/src/lib/armory-model.ts',import.meta.url),recommendations=await tsImport('../apps/web/src/lib/armory-recommendations.ts',import.meta.url);
const nodes=(tree,match)=>React.isValidElement(tree)?[...(match(tree)?[tree]:[]),...React.Children.toArray(tree.props.children).flatMap(child=>nodes(child,match))]:[];
const text=tree=>typeof tree==='string'?tree:React.isValidElement(tree)?React.Children.toArray(tree.props.children).map(text).join(''):'';
export function inputHarness(file,exportName,initialProps,{cards=[]}={}){
 let cursor=0,dirty=true,tree,props=initialProps;const hooks=[],effects=[],requests=[];
 const react={...React,useId(){const index=cursor++;return hooks[index]??='input-'+index;},useRef(initial){const index=cursor++;return hooks[index]??={current:initial};},useState(initial){const index=cursor++;if(!(index in hooks))hooks[index]=typeof initial==='function'?initial():initial;return [hooks[index],next=>{const value=typeof next==='function'?next(hooks[index]):next;if(!Object.is(value,hooks[index])){hooks[index]=value;dirty=true;}}];},useEffect(effect,deps){const index=cursor++,previous=hooks[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]))){hooks[index]={deps,cleanup:previous?.cleanup};effects.push(()=>{hooks[index].cleanup?.();hooks[index].cleanup=effect();});}}};
 const source=ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,module={exports:{}};
 vm.runInNewContext(source,{module,exports:module.exports,require(id){if(id==='./owned-class-name'||id==='@/components/owned-class-name')return {ownedClassName:(value)=>value};if(id==='react')return react;if(id==='react/jsx-runtime')return jsx;if(id==='lucide-react')return icons;if(id==='@/lib/armory-model')return model;if(id==='@/lib/armory-recommendations')return recommendations;if(id==='next/link')return {__esModule:true,default:'a'};if(id==='./shared')return {Alert:'Alert',api:async url=>{requests.push(url);return {cards};}};if(id.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>String(key)})};throw Error('Unexpected import '+id);}});
 return {async flush(){for(let i=0;i<15;i++){if(dirty){dirty=false;cursor=0;tree=module.exports[exportName](props);while(effects.length)effects.shift()();}await new Promise(done=>setImmediate(done));if(!dirty)return;}throw Error('Input render did not settle');},setProps(next){props=next;dirty=true;},get tree(){return tree;},nodes:match=>nodes(tree,match),button(label){const buttons=nodes(tree,node=>node.type==='button'&&text(node)===label);assert.equal(buttons.length,1,'one button '+label);return buttons[0];},requests};
}
