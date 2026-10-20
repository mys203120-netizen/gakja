import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as library from '../apps/web/src/lib/minute-wheel.ts';

const source=ts.transpileModule(readFileSync('apps/web/src/components/minute-wheel.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
function nodes(value:any):any[]{return Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children)]:[];}
function harness(initial=120){
  const values:any[]=[],dependencies:any[]=[],effects:Function[]=[],cleanups:Function[]=[],timers=new Map<number,Function>(),changes:number[]=[],positions:any[]=[];
  let index=0,timerIndex=0,value=initial,disabled=false,reducedMotion=false;
  const scrollNode={scrollTop:0,scrollTo(options:any){positions.push(options);this.scrollTop=options.top;}};
  const react={useRef(initial:any){const slot=index++;return values[slot]??(values[slot]={current:initial});},useEffect(fn:Function,next:any[]){const slot=index++;if(!dependencies[slot]||next.some((value,i)=>value!==dependencies[slot][i])){dependencies[slot]=next;effects.push(()=>{cleanups[slot]?.();cleanups[slot]=fn();});}}};
  const module={exports:{} as any};
  vm.runInNewContext(source,{module,exports:module.exports,window:{matchMedia:()=>({matches:reducedMotion})},setTimeout:(fn:Function)=>{const id=++timerIndex;timers.set(id,fn);return id;},clearTimeout:(id:number)=>timers.delete(id),require(name:string){if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value:string|undefined)=>value};if(name==='react')return react;if(name==='react/jsx-runtime')return {jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};if(name==='@/lib/minute-wheel')return library;if(name.endsWith('.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};throw Error(name);}});
  const render=()=>{index=0;const tree=module.exports.MinuteWheel({label:'수능 전 평일',value,disabled,onChange:(next:number)=>{changes.push(next);value=next;}});nodes(tree).find(node=>node.props?.role==='spinbutton').props.ref.current=scrollNode;while(effects.length)effects.shift()!();return tree;};
  const control=(tree=render())=>nodes(tree).find(node=>node.props?.role==='spinbutton');
  return {render,control,changes,positions,scrollNode,timers,get value(){return value;},external(next:number){value=next;},disable(){disabled=true;},reduceMotion(){reducedMotion=true;},flush(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}},cleanup(){cleanups.forEach(fn=>fn?.());}};
}

test('five-minute wheel options retain exact saved values and bound native offsets',()=>{
  const options=library.minuteWheelOptions([37,37,63,-1,481,12.5]);
  assert.equal(options[0],0);assert.equal(options.at(-1),480);assert.equal(options.length,99);assert.ok(options.includes(37)&&options.includes(63));
  assert.equal(library.minuteWheelIndex(-500,options.length),0);assert.equal(library.minuteWheelIndex(500000,options.length),options.length-1);assert.equal(library.minuteWheelIndex(NaN,options.length),0);
  assert.equal(library.minuteWheelIndex(65,options.length),1);assert.equal(library.minuteWheelIndex(67,options.length),2);
});
test('mounting and prop restoration never round an arbitrary saved time or emit a form change',()=>{
  const h=harness(37);let tree=h.render(),control=h.control(tree);assert.equal(control.props['aria-valuenow'],37);assert.equal(control.props['aria-valuetext'],'37분');assert.deepEqual(h.changes,[]);
  const options=library.minuteWheelOptions([37]);assert.equal(h.scrollNode.scrollTop,options.indexOf(37)*44);
  control.props.onScroll();assert.deepEqual(h.changes,[],'the programmatic initial position is not an edit');
  h.external(63);tree=h.render();control=h.control(tree);assert.equal(control.props['aria-valuenow'],63);assert.deepEqual(h.changes,[]);assert.equal(h.scrollNode.scrollTop,library.minuteWheelOptions([37,63]).indexOf(63)*44);h.cleanup();
});
test('native vertical scrolling updates the proposed minutes and settles to the nearest row without extra emissions',()=>{
  const h=harness(120);let control=h.control();control.props.onPointerDown();h.scrollNode.scrollTop=library.minuteWheelOptions([120]).indexOf(180)*44+18;control.props.onScroll();
  assert.equal(h.value,180,'the form has the visible candidate even before a save click during momentum');control=h.control();assert.equal(control.props['aria-valuenow'],180);
  h.flush();assert.equal(h.scrollNode.scrollTop,36*44);assert.deepEqual(h.changes,[180]);control.props.onScroll();assert.deepEqual(h.changes,[180]);h.cleanup();
});
test('Escape cancels the current wheel interaction and unmount cancels its pending settle',()=>{
  const h=harness(37);let control=h.control();control.props.onPointerDown();h.scrollNode.scrollTop=library.minuteWheelOptions([37]).indexOf(60)*44;control.props.onScroll();control=h.control();
  let prevented=false;control.props.onKeyDown({key:'Escape',preventDefault(){prevented=true;}});assert.equal(prevented,true);assert.equal(h.value,37);assert.equal(h.timers.size,0);assert.deepEqual(h.changes,[60,37]);
  control=h.control();control.props.onPointerDown();h.scrollNode.scrollTop=library.minuteWheelOptions([37]).indexOf(90)*44;control.props.onScroll();const before=h.changes.length;h.cleanup();h.flush();assert.equal(h.changes.length,before);assert.equal(h.timers.size,0);
});
test('keyboard plus/minus, arrows and limits stay within the supported interval',()=>{
  const h=harness(37);const press=(key:string)=>{let prevented=false;h.control().props.onKeyDown({key,preventDefault(){prevented=true;}});return prevented;};
  assert.equal(press('+'),true);assert.equal(h.value,40);press('-');assert.equal(h.value,37);press('ArrowDown');assert.equal(h.value,35);press('Home');press('-');assert.equal(h.value,0);press('End');press('ArrowUp');assert.equal(h.value,480);
  assert.equal(press('Enter'),false);assert.ok(h.changes.every(value=>value>=0&&value<=480));h.cleanup();
});
test('disabling a field cancels momentum and reduced motion removes the settle animation',()=>{
  const h=harness(120);let control=h.control();control.props.onWheel();h.scrollNode.scrollTop=33*44+15;control.props.onScroll();h.disable();control=h.control();const before=h.changes.length;h.flush();assert.equal(h.changes.length,before);assert.equal(control.props['aria-disabled'],true);assert.equal(control.props.tabIndex,-1);h.cleanup();
  const reduced=harness(120);reduced.reduceMotion();control=reduced.control();control.props.onPointerDown();reduced.scrollNode.scrollTop=30*44+15;control.props.onScroll();reduced.render();reduced.flush();assert.equal(reduced.positions.at(-1).behavior,'auto');reduced.cleanup();
});
