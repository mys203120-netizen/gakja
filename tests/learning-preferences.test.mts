import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const code=ts.transpileModule(readFileSync('apps/web/src/components/learning-preferences.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
const nodes=(node:any):any[]=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.props?.children)]:[];
test('Enter setting waits for the account receipt, preserves a failed setting and renders another account independently',async()=>{
 const slots:any[]=[],calls:any[]=[],toasts:string[]=[],app={data:{user:{id:'one'},preferences:{} as any},async refresh(){app.data.preferences={...preferences};},toast:(value:string)=>toasts.push(value)};
 let index=0,preferences:any={},wait:Promise<void>|undefined,fail=false;
 const module={exports:{} as any};
 vm.runInNewContext(code,{module,exports:module.exports,require(name:string){
  if(name==='react')return {useState(initial:any){const slot=index++;if(!(slot in slots))slots[slot]=initial;return [slots[slot],(value:any)=>{slots[slot]=value;}];},useRef(initial:any){return slots[index++]??={current:initial};}};
  if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
  if(name==='./app-shell')return {useApp:()=>app};
  if(name==='./shared')return {Alert:'Alert',action:async(action:string,value:any)=>{calls.push({owner:app.data.user.id,action,value});await wait;if(fail)throw Error('설정 저장 실패');preferences={...preferences,...value};return {preferences};}};
  if(name==='next/link')return {default:'Link'};
  if(name==='lucide-react')return {ArrowUpRight:'ArrowUpRight'};
  throw Error(name);
 }});
 const render=()=>{index=0;return module.exports.LearningPreferences();};
 const toggle=(tree:any)=>nodes(tree).find(node=>node.type==='input'&&node.props['aria-label']==='Enter로 전송').props;
 let tree=render();assert.equal(toggle(tree).checked,true);let release!:()=>void;wait=new Promise(resolve=>{release=resolve;});toggle(tree).onChange({target:{checked:false}});tree=render();assert.equal(toggle(tree).checked,true);assert.equal(toggle(tree).disabled,true);assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{owner:'one',action:'preference',value:{enterToSend:false}});
 release();await new Promise(resolve=>setImmediate(resolve));tree=render();assert.equal(toggle(tree).checked,false);assert.equal(toggle(tree).disabled,false);assert.equal(toasts.at(-1),'Enter로 줄을 바꿔요.');
 wait=undefined;fail=true;toggle(tree).onChange({target:{checked:true}});await new Promise(resolve=>setImmediate(resolve));tree=render();assert.equal(toggle(tree).checked,false);assert.equal(toggle(tree).disabled,false);assert.equal(nodes(tree).find(node=>node.type==='Alert').props.children,'설정 저장 실패');
 app.data={user:{id:'two'},preferences:{enterToSend:true}};tree=render();assert.equal(toggle(tree).checked,true);assert.equal(calls.length,2,'merely opening another account cannot write or reuse the previous preference');
});
