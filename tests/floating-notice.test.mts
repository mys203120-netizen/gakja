import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

test('a receipt floats in the body, fades, dismisses and cancels timers on replacement/unmount',()=>{
 const code=ts.transpileModule(readFileSync('apps/web/src/components/floating-notice.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const mod={exports:{} as any},state:any[]=[],effects:any[]=[],timers=new Map<number,{fn:Function,delay:number}>();let cursor=0,sequence=0,dismissed=0;
 const body={tag:'body'};
 vm.runInNewContext(code,{module:mod,exports:mod.exports,document:{body},setTimeout(fn:Function,delay:number){timers.set(++sequence,{fn,delay});return sequence;},clearTimeout(id:number){timers.delete(id);},require(name:string){
  if(name==='react')return {useState(initial:any){const index=cursor++;if(!(index in state))state[index]=initial;return [state[index],(value:any)=>{state[index]=value;}];},useEffect(fn:Function,deps:any[]){const index=cursor++,previous=effects[index];if(!previous||deps.some((value,i)=>!Object.is(value,previous.deps[i]))){previous?.cleanup?.();effects[index]={deps,cleanup:fn()};}}};
  if(name==='react-dom')return {createPortal:(element:any,target:any)=>({element,target})};
  if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
  if(name==='lucide-react')return {Check:'Check'};if(name.endsWith('.css'))return {default:{notice:'notice'}};throw Error(name);
 }});
 const render=(message='저장했어요')=>{cursor=0;return mod.exports.FloatingNotice({children:message,onDismiss:()=>dismissed++});};
 render();let result=render();assert.equal(result.target,body);assert.equal(result.element.props.role,'status');assert.equal(result.element.props['data-visible'],true);
 const fade=[...timers.values()].find(value=>value.delay===3600)!;fade.fn();result=render();assert.equal(result.element.props['data-visible'],false);
 const remove=[...timers.values()].find(value=>value.delay===3960)!;remove.fn();assert.equal(render(),null);assert.equal(dismissed,1);
 render('다시 저장했어요');assert.equal(timers.size,2);assert.ok(render('다시 저장했어요'));
 for(const effect of effects)effect?.cleanup?.();assert.equal(timers.size,0);
});
