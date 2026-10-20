import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {swipeDestination} from '../apps/web/src/lib/mobile-tab-swipe';

const source=ts.transpileModule(readFileSync('apps/web/src/components/mobile-tab-swipe.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;

class ElementFixture {
  parentElement:ElementFixture|null=null;
  scrollWidth=320;clientWidth=320;overflowX='visible';
  dataset:Record<string,string>={};
  readonly values=new Map<string,string>();
  readonly style={setProperty:(key:string,value:string)=>{this.values.set(key,value);},removeProperty:(key:string)=>this.values.delete(key)};
  constructor(public tag='div',public attributes:Record<string,string>={},parent:ElementFixture|null=null){this.parentElement=parent;}
  closest(selector:string):ElementFixture|null {
    for(let node:ElementFixture|null=this;node;node=node.parentElement){
      if(selector.split(',').some(part=>{
        const value=part.trim();
        if(value==='[contenteditable]')return Object.hasOwn(node!.attributes,'contenteditable');
        if(value==='[data-no-tab-swipe]')return Object.hasOwn(node!.attributes,'data-no-tab-swipe');
        if(value==='[role="tablist"]')return node!.attributes.role==='tablist';
        return value===node!.tag;
      }))return node;
    }
    return null;
  }
}

type PointerOverrides={pointerType?:string;isPrimary?:boolean;pointerId?:number;clientX?:number;clientY?:number;target?:unknown};
function harness({initialPath='/my',enabled=true,reduced=false,width=390}={}){
  let path=initialPath,allowed=enabled,time=0,cursor=0,dialog=false,selection=false,timerId=0;
  const refs:any[]=[],effects:any[]=[],pending:Function[]=[],listeners=new Map<string,Set<(event:any)=>void>>(),options:any[]=[],timers=new Map<number,()=>void>(),pushes:string[]=[];
  const main=new ElementFixture(),surface=new ElementFixture('div',{},main);
  const add=(name:string,handler:(event:any)=>void,option:any)=>{const set=listeners.get(name)||new Set();set.add(handler);listeners.set(name,set);options.push({name,...option});};
  const remove=(name:string,handler:(event:any)=>void)=>listeners.get(name)?.delete(handler);
  Object.assign(main,{addEventListener:add,removeEventListener:remove});
  const media={matches:reduced},router={push:(href:string)=>pushes.push(href)};
  const win={innerWidth:width,matchMedia:()=>media,setTimeout:(fn:()=>void)=>{timers.set(++timerId,fn);return timerId;}};
  const doc={getElementById:(id:string)=>id==='main-content'?main:null,querySelector:(selector:string)=>selector==='dialog[open]'&&dialog?{}:null,getSelection:()=>({isCollapsed:!selection})};
  const module={exports:{} as any};
  vm.runInNewContext(source,{module,exports:module.exports,Element:ElementFixture,window:win,document:doc,performance:{now:()=>time},getComputedStyle:(node:ElementFixture)=>({overflowX:node.overflowX}),clearTimeout:(id:number)=>timers.delete(id),require(name:string){
    if(name==='react')return {useRef:(value:any)=>refs[cursor++]??={current:value},useEffect:(fn:Function,deps:any[])=>{
      const index=cursor++,old=effects[index];
      if(!old||deps.some((value,i)=>!Object.is(value,old.deps[i]))){effects[index]={deps};pending.push(()=>{old?.cleanup?.();effects[index].cleanup=fn();});}
    }};
    if(name==='next/navigation')return {usePathname:()=>path,useRouter:()=>router};
    if(name==='@/lib/mobile-tab-swipe')return {swipeDestination};
    throw Error(name);
  }});
  function render(nextPath=path,nextEnabled=allowed){path=nextPath;allowed=nextEnabled;cursor=0;module.exports.MobileTabSwipe({enabled:allowed});while(pending.length)pending.shift()!();}
  function emit(type:string,overrides:PointerOverrides={}){
    const event={pointerType:'touch',isPrimary:true,pointerId:7,clientX:220,clientY:300,target:surface,preventDefault(){throw Error('Gesture listener must not prevent native scrolling.');},...overrides};
    for(const listener of [...listeners.get(type)||[]])listener(event);
  }
  function swipe(dx=-120,dy=5,elapsed=160,start:PointerOverrides={}){
    const x=start.clientX??220,y=start.clientY??300;
    emit('pointerdown',{...start,clientX:x,clientY:y});time+=elapsed/2;
    emit('pointermove',{...start,clientX:x+dx/2,clientY:y+dy/2});time+=elapsed/2;
    emit('pointerup',{...start,clientX:x+dx,clientY:y+dy});
  }
  render();
  return {main,surface,media,win,pushes,listeners,timers,options,render,emit,swipe,touchMove(points:{clientX:number;clientY:number}[],cancelable=true){let prevented=false;for(const listener of [...listeners.get('touchmove')||[]])listener({touches:points,cancelable,preventDefault(){prevented=true;}});return prevented;},advance:(ms:number)=>{time+=ms;},setDialog:(value:boolean)=>{dialog=value;},setSelection:(value:boolean)=>{selection=value;},unmount(){for(const effect of effects)effect?.cleanup?.();},runTimers(){const current=[...timers.values()];timers.clear();current.forEach(fn=>fn());}};
}

// These invoke the real component's registered DOM handlers and actual routing
// helper. They do not claim to simulate an operating system's native panning.
test('actual touch gesture handlers route through the three overview screens in both directions',()=>{
  const h=harness();assert.equal(h.main.dataset.tabSwipe,'true');
  h.swipe();assert.deepEqual(h.pushes,['/preparation']);assert.equal(h.main.dataset.tabDragging,undefined);assert.equal(h.main.values.has('--tab-drag'),false);
  h.render('/preparation');assert.equal(h.main.dataset.tabTransition,'left');
  h.swipe(120);assert.deepEqual(h.pushes,['/preparation','/my']);h.render('/my');assert.equal(h.main.dataset.tabTransition,'right');
  h.render('/preparation');h.swipe();assert.equal(h.pushes.at(-1),'/records');
  h.render('/records');h.swipe();assert.equal(h.pushes.length,3,'last tab has no next destination');
  h.swipe(120);assert.equal(h.pushes.at(-1),'/preparation');assert.ok(h.options.filter(option=>option.name!=='touchmove').every(option=>option.passive===true));assert.ok(h.options.filter(option=>option.name==='touchmove').every(option=>option.passive===false));h.unmount();
});

test('mouse, pen, secondary pointers and desktop-width touches do not navigate',()=>{
  const h=harness();for(const pointerType of ['mouse','pen'])h.swipe(-120,0,150,{pointerType});h.swipe(-120,0,150,{isPrimary:false});
  h.win.innerWidth=701;h.swipe();assert.deepEqual(h.pushes,[]);assert.equal(h.main.values.has('--tab-drag'),false);h.unmount();
});

test('controls, nested icons, tab strips, selectable text and browser-edge gestures are ignored',()=>{
  const h=harness();
  for(const tag of ['a','button','input','textarea','select','summary','audio','video']){
    const control=new ElementFixture(tag,{},h.main),nested=new ElementFixture('span',{},control);h.swipe(-120,0,150,{target:nested});
  }
  for(const attributes of [{contenteditable:'true'},{role:'tablist'},{'data-no-tab-swipe':''}])h.swipe(-120,0,150,{target:new ElementFixture('div',attributes,h.main)});
  h.swipe(-120,0,150,{clientX:20});h.swipe(120,0,150,{clientX:375});
  h.setSelection(true);h.swipe();h.setSelection(false);h.setDialog(true);h.swipe();
  assert.deepEqual(h.pushes,[]);h.unmount();
});

test('horizontally scrollable ancestors retain their own gestures',()=>{
  const h=harness();
  for(const overflow of ['auto','scroll']){
    const strip=new ElementFixture('div',{},h.main);strip.scrollWidth=800;strip.clientWidth=300;strip.overflowX=overflow;
    h.swipe(-120,0,150,{target:new ElementFixture('span',{},strip)});
  }
  assert.deepEqual(h.pushes,[]);assert.equal(h.main.dataset.tabDragging,undefined);
  const vertical=new ElementFixture('div',{},h.main);vertical.overflowX='auto';h.swipe(-120,0,150,{target:vertical});
  assert.deepEqual(h.pushes,['/preparation'],'a container without horizontal overflow does not suppress tab gestures');h.unmount();
});

test('vertical intent, diagonal or short movement and a long hold never become tab navigation',()=>{
  const h=harness();h.emit('pointerdown');h.emit('pointermove',{clientX:230,clientY:340});h.emit('pointerup',{clientX:100,clientY:300});
  h.swipe(-80,60);h.swipe(-50,0);h.swipe(-120,0,851);
  assert.deepEqual(h.pushes,[]);assert.equal(h.main.dataset.tabDragging,undefined);h.unmount();
});

test('pointer identity and cancellation clear visual feedback without routing',()=>{
  const h=harness();h.emit('pointerdown');h.emit('pointermove',{clientX:100,pointerId:8});assert.equal(h.main.dataset.tabDragging,undefined);
  h.emit('pointermove',{clientX:120});assert.equal(h.main.dataset.tabDragging,'true');assert.equal(h.main.values.get('--tab-drag'),'-12px');
  h.emit('pointerup',{clientX:100,pointerId:8});assert.deepEqual(h.pushes,[]);h.emit('pointercancel');
  assert.equal(h.main.dataset.tabDragging,undefined);assert.equal(h.main.values.has('--tab-drag'),false);h.emit('pointerup',{clientX:80});assert.deepEqual(h.pushes,[]);h.unmount();
});

test('answer workspaces and onboarding never install gestures; route cleanup removes timers, listeners and styles',()=>{
  const h=harness();h.swipe();h.render('/preparation');assert.equal(h.timers.size,1);
  h.emit('pointerdown');h.emit('pointermove',{clientX:120});assert.equal(h.main.dataset.tabDragging,'true');
  h.render('/my/train/plan-a');assert.equal(h.main.dataset.tabSwipe,undefined);assert.equal(h.main.dataset.tabDragging,undefined);assert.equal(h.main.dataset.tabTransition,undefined);assert.equal(h.main.values.size,0);assert.equal(h.timers.size,0);
  assert.equal([...h.listeners.values()].reduce((count,set)=>count+set.size,0),0);
  for(const path of ['/interview/session-a','/my/diagnosis','/on','/availability','/schools/new','/records/session-a']){h.render(path);h.swipe();assert.equal(h.pushes.length,1);}
  h.render('/my',false);assert.equal(h.main.dataset.tabSwipe,undefined);h.render('/my',true);assert.equal(h.main.dataset.tabSwipe,'true');h.unmount();assert.equal([...h.listeners.values()].reduce((count,set)=>count+set.size,0),0);
});

test('reduced-motion preference retains navigation without drag or entry animation',()=>{
  const h=harness({reduced:true});h.emit('pointerdown');h.emit('pointermove',{clientX:100});assert.equal(h.main.dataset.tabDragging,undefined);
  h.advance(150);h.emit('pointerup',{clientX:80});assert.deepEqual(h.pushes,['/preparation']);h.render('/preparation');assert.equal(h.main.dataset.tabTransition,undefined);assert.equal(h.timers.size,0);h.unmount();
});


test('only a recognized single-finger horizontal tab touchmove prevents native panning',()=>{
  const h=harness();h.emit('pointerdown');assert.equal(h.touchMove([{clientX:214,clientY:302}]),false,'tiny movements stay native');
  assert.equal(h.touchMove([{clientX:120,clientY:305}]),true);assert.equal(h.main.dataset.tabDragging,'true');assert.equal(h.main.values.get('--tab-drag'),'-12px');
  h.advance(180);h.emit('pointerup',{clientX:100,clientY:305});assert.deepEqual(h.pushes,['/preparation']);h.unmount();
});

test('native vertical and horizontal-strip touchmove remain available, including controls and browser edges',()=>{
  const h=harness();h.emit('pointerdown');assert.equal(h.touchMove([{clientX:224,clientY:350}]),false);assert.equal(h.main.dataset.tabDragging,undefined);
  h.emit('pointerup',{clientX:100,clientY:305});assert.deepEqual(h.pushes,[],'vertical intent clears the tab gesture');
  const strip=new ElementFixture('div',{},h.main);strip.clientWidth=300;strip.scrollWidth=800;strip.overflowX='auto';
  for(const start of [{target:new ElementFixture('span',{},strip)},{target:new ElementFixture('textarea',{},h.main)},{clientX:15}]){
    h.emit('pointerdown',start);assert.equal(h.touchMove([{clientX:100,clientY:305}]),false);h.emit('pointerup',{clientX:100,clientY:305});
  }
  assert.deepEqual(h.pushes,[]);h.unmount();
});

test('pinch, mid-gesture text selection, cancellation and non-cancelable samples never block native interaction',()=>{
  const h=harness();h.emit('pointerdown');assert.equal(h.touchMove([{clientX:100,clientY:300},{clientX:250,clientY:300}]),false);
  h.emit('pointerup',{clientX:100});assert.deepEqual(h.pushes,[],'pinching clears a partially tracked tab swipe');
  h.emit('pointerdown');h.setSelection(true);assert.equal(h.touchMove([{clientX:100,clientY:300}]),false);h.setSelection(false);h.emit('pointerup',{clientX:100});assert.deepEqual(h.pushes,[]);
  h.emit('pointerdown');assert.equal(h.touchMove([{clientX:100,clientY:300}],false),false);h.emit('pointercancel');
  assert.equal(h.main.dataset.tabDragging,undefined);assert.equal(h.touchMove([{clientX:80,clientY:300}]),false);h.unmount();
});

test('reduced-motion touch gestures still suppress only accepted horizontal native pan and clean the touch listener on disable',()=>{
  const h=harness({reduced:true});h.emit('pointerdown');assert.equal(h.touchMove([{clientX:100,clientY:300}]),true);assert.equal(h.main.dataset.tabDragging,undefined);
  h.advance(150);h.emit('pointerup',{clientX:100,clientY:300});assert.deepEqual(h.pushes,['/preparation']);h.render('/preparation',false);
  assert.equal(h.listeners.get('touchmove')?.size,0);assert.equal(h.touchMove([{clientX:80,clientY:300}]),false);h.unmount();
});
