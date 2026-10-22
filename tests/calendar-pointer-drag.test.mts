import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {validPlanDay} from '../apps/web/src/lib/planner-model.ts';

const module={exports:{} as any};
const source=ts.transpileModule(readFileSync('apps/web/src/components/calendar-editor.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
vm.runInNewContext(source,{module,exports:module.exports,setTimeout,clearTimeout,Math,require(name:string){
 if(name==='@/lib/planner-model')return {validPlanDay};
 return {};
}});
const create=module.exports.createCalendarPointerDrag;
function fixture(){
 const listeners=new Map<string,Set<Function>>(),windowListeners=new Map<string,Set<Function>>();
 const element=(day:string,inside=true):any=>({inside,getAttribute:(attribute:string)=>attribute==='data-calendar-day'?day:null,closest:(selector:string)=>selector==='[data-calendar-day]'?element(day,inside):null});
 const root={contains:(target:any)=>target.inside};
 const sourceElement:any={closest:(selector:string)=>selector==='#dashboard-planner'?root:null};
 let hit:any=element('2026-10-25'),allowed=true;
 const doc:any={addEventListener:(name:string,listener:Function)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name)!.add(listener);},removeEventListener:(name:string,listener:Function)=>listeners.get(name)?.delete(listener),elementFromPoint:()=>hit,defaultView:{addEventListener:(name:string,listener:Function)=>{if(!windowListeners.has(name))windowListeners.set(name,new Set());windowListeners.get(name)!.add(listener);},removeEventListener:(name:string,listener:Function)=>windowListeners.get(name)?.delete(listener)}};
 const previews:any[]=[],visuals:any[]=[];
 const controller=create({document:doc,enabled:()=>allowed,onPreview:(source:any,day:string)=>previews.push({source,day}),onVisual:(source:any,day:string)=>visuals.push({source,day})});
 const dragSource={kind:'day',value:'2026-10-23',day:'2026-10-23'};
 function event(patch:any={}){let prevented=false,stopped=false;return {pointerType:'mouse',button:0,isPrimary:true,pointerId:1,clientX:10,clientY:10,currentTarget:sourceElement,target:sourceElement,cancelable:true,preventDefault:()=>{prevented=true;},stopImmediatePropagation:()=>{stopped=true;},get prevented(){return prevented;},get stopped(){return stopped;},...patch};}
 function dispatch(name:string,value:any){for(const listener of [...listeners.get(name)||[]])listener(value);}
 return {controller,doc,previews,visuals,source:dragSource,event,dispatch,start:(patch:any={},source=dragSource)=>controller.start(event(patch),source),hit:(day:string,inside=true)=>{hit=day?element(day,inside):null;},allow:(value:boolean)=>{allowed=value;},blur:()=>{for(const listener of [...windowListeners.get('blur')||[]])listener();},count:()=>[...listeners.values(),...windowListeners.values()].reduce((count,listeners)=>count+listeners.size,0),active:(name:string)=>listeners.get(name)?.size||0};
}
test('a mouse movement above the threshold previews the day under the release point exactly once',()=>{
 const f=fixture();f.start();assert.equal(f.controller.nativeStart(),false);
 const move=f.event({clientX:40,clientY:30});f.dispatch('pointermove',move);assert.equal(move.prevented,true);assert.equal(f.visuals.at(-1).day,'2026-10-25');
 const up=f.event({clientX:40,clientY:30});f.dispatch('pointerup',up);assert.equal(up.prevented,true);assert.equal(f.previews.length,1);assert.equal(f.previews[0].source.value,'2026-10-23');assert.equal(f.previews[0].day,'2026-10-25');
 assert.equal(f.controller.claimNativeDrop(),false);f.dispatch('pointerup',up);assert.equal(f.previews.length,1);f.controller.dispose();assert.equal(f.count(),0);
});
test('ordinary clicks, non-mouse input, secondary buttons and another pointer never become a drag',()=>{
 for(const patch of [{pointerType:'touch'},{pointerType:'pen'},{button:2},{isPrimary:false}]){const f=fixture();f.start(patch);assert.equal(f.count(),0);f.dispatch('pointermove',f.event({clientX:40}));f.dispatch('pointerup',f.event({clientX:40}));assert.equal(f.previews.length,0);f.controller.dispose();}
 const click=fixture();click.start();const movement=click.event({clientX:13,clientY:13});click.dispatch('pointermove',movement);click.dispatch('pointerup',movement);assert.equal(movement.prevented,false);assert.equal(click.previews.length,0);assert.equal(click.active('click'),0);click.controller.dispose();
 const pointer=fixture();pointer.start();pointer.dispatch('pointermove',pointer.event({pointerId:2,clientX:50}));pointer.dispatch('pointerup',pointer.event({pointerId:2,clientX:50}));assert.equal(pointer.previews.length,0);pointer.controller.dispose();
});
test('same-day, outside-calendar and empty release targets never request an update',()=>{
 for(const [day,inside] of [['2026-10-23',true],['2026-10-25',false],['',true],['not-a-date',true]] as const){const f=fixture();f.start();f.hit(day,inside);f.dispatch('pointermove',f.event({clientX:40}));f.dispatch('pointerup',f.event({clientX:40}));assert.equal(f.previews.length,0);f.controller.dispose();}
});
test('busy/modal/permission guards are checked both at start and at release',()=>{
 const initial=fixture();initial.allow(false);initial.start();assert.equal(initial.count(),0);initial.controller.dispose();
 const later=fixture();later.start();later.dispatch('pointermove',later.event({clientX:40}));later.allow(false);later.dispatch('pointerup',later.event({clientX:40}));assert.equal(later.previews.length,0);later.controller.dispose();
 const moving=fixture();moving.start();moving.allow(false);moving.dispatch('pointermove',moving.event({clientX:40}));assert.equal(moving.count(),0);moving.controller.dispose();
});
test('pointer cancellation, window blur and unmount remove every gesture listener',()=>{
 for(const finish of ['pointercancel','blur','dispose']){const f=fixture();f.start();f.dispatch('pointermove',f.event({clientX:40}));if(finish==='blur')f.blur();else if(finish==='dispose')f.controller.dispose();else f.dispatch('pointercancel',f.event());assert.equal(f.count(),0);f.dispatch('pointerup',f.event({clientX:40}));assert.equal(f.previews.length,0);f.controller.dispose();}
});
test('cancelled HTML5 dragend does not abort the tracked mouse; native drops use one claim per gesture',()=>{
 const f=fixture();f.start();assert.equal(f.controller.nativeStart(),false);f.controller.end();f.dispatch('pointermove',f.event({clientX:40}));f.dispatch('pointerup',f.event({clientX:40}));assert.equal(f.previews.length,1);assert.equal(f.controller.claimNativeDrop(),false);
 assert.equal(f.controller.nativeStart(),true);assert.equal(f.controller.claimNativeDrop(),true);assert.equal(f.controller.claimNativeDrop(),false);f.controller.dispose();assert.equal(f.controller.nativeStart(),false);
});
test('an individual plan carries its id while nested action buttons retain their normal click behavior',()=>{
 const f=fixture();f.start({}, {kind:'plan',value:'plan-id',day:'2026-10-23'});f.dispatch('pointermove',f.event({clientX:40}));f.dispatch('pointerup',f.event({clientX:40}));assert.equal(f.previews[0].source.kind,'plan');assert.equal(f.previews[0].source.value,'plan-id');f.controller.dispose();
 const button=fixture();button.start({target:{closest:()=>({})}});assert.equal(button.count(),0);button.controller.dispose();
});
test('the synthetic click following drag is suppressed; a later deliberate click is never swallowed',async()=>{
 const f=fixture();f.start();f.dispatch('pointermove',f.event({clientX:40}));f.dispatch('pointerup',f.event({clientX:40}));const generated=f.event();f.dispatch('click',generated);assert.equal(generated.prevented,true);assert.equal(generated.stopped,true);
 const deliberate=f.event();f.dispatch('click',deliberate);assert.equal(deliberate.prevented,false);
 f.start();f.dispatch('pointermove',f.event({clientX:40}));f.dispatch('pointerup',f.event({clientX:40}));await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.active('click'),0);f.controller.dispose();
});
