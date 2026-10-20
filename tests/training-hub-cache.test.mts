import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createClientRequestCache} from '../apps/web/src/lib/client/request-cache';
import {learningScopeIdentity} from '../apps/web/src/lib/learning-target-scope';

// The real hook runs against the real tab cache; only React scheduling, time and
// DOM listeners are simulated. No provider, database or browser calls are made.
const code=ts.transpileModule(readFileSync('apps/web/src/components/training-hub.tsx','utf8')+'\nexport {useTrainingData as testTrainingData};',{
 compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022},
}).outputText;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
function fixture(){
 let time=Date.parse('2026-10-21T03:00:00Z'),path='/my',handler;
 const context={data:{user:{id:'student-one'},package:{id:'pack',active_version:1}},target:{id:'school',university:'시험대학교',department:'환경공학과',admission_year:2027},learningRevision:0};
 const calls=[],listeners=new Map();
 const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
 const payload=()=>({owner:context.data.user.id,department:context.target.department,version:context.data.package.active_version,today:{date:day(),tasks:[]},marker:calls.length});
 const json=value=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
 const cache=createClientRequestCache({enabled:()=>true,origin:()=> 'http://localhost:3100',now:()=>time,fetcher:async(url,init)=>{calls.push({url,init});return handler?await handler(url,init):json(payload());}});
 cache.seedIdentity(context.data.user.id);
 class ClockDate extends Date {constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}}
 const eventSurface={addEventListener(name,callback){const entries=listeners.get(name)||new Set();entries.add(callback);listeners.set(name,entries);},removeEventListener(name,callback){listeners.get(name)?.delete(callback);}};
 function mount(){
  const slots=[],effects=[],queue=[];let cursor=0,dayRefresh,disposedWrites=0,disposed=false;
  const hooks={useState(initial){const index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return [slots[index],next=>{if(disposed)disposedWrites++;slots[index]=typeof next==='function'?next(slots[index]):next;}];},useCallback(callback,dependencies){const index=cursor++,old=slots[index];if(!old||dependencies.some((value,key)=>!Object.is(value,old.dependencies[key])))slots[index]={callback,dependencies};return slots[index].callback;},useEffect(effect,dependencies){const index=cursor++,old=effects[index];if(!old||dependencies.some((value,key)=>!Object.is(value,old.dependencies[key])))queue.push(()=>{old?.cleanup?.();effects[index]={effect,dependencies,cleanup:effect()};});}};
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,Date:ClockDate,Intl,URLSearchParams,AbortController,console,window:eventSurface,document:{...eventSurface,visibilityState:'visible'},require(name){
   if(name==='react')return hooks;
   if(name==='./app-shell')return {useApp:()=>context};
   if(name==='next/navigation')return {usePathname:()=>path};
   if(name==='./shared')return {api:cache.request,peekApi:cache.peek};
   if(name==='@/lib/learning-target-scope')return {learningScopeIdentity};
   if(name==='@/lib/training-day-refresh')return {scheduleTrainingDayRefresh:callback=>{dayRefresh=callback;return ()=>{dayRefresh=undefined;};}};
   return new Proxy({},{get:(_,key)=>key==='default'?{}:String(key)});
  }});
  return {render(){cursor=0;queue.length=0;const value=module.exports.testTrainingData();while(queue.length)queue.shift()();return value;},strictReplay(){effects.forEach(effect=>effect?.cleanup?.());effects.forEach(effect=>{if(effect)effect.cleanup=effect.effect();});},midnight(){dayRefresh?.();},dispose(){effects.forEach(effect=>effect?.cleanup?.());disposed=true;},get disposedWrites(){return disposedWrites;}};
 }
 return {context,cache,calls,mount,day,payload,json,setTime(value){time=Date.parse(value);},advance(value){time+=value;},setPath(value){path=value;},setHandler(value){handler=value;},emit(name){for(const callback of listeners.get(name)||[])callback();}};
}

test('today and preparation reuse the same fresh actor-owned training snapshot without bootstrap or rerender loops',async()=>{
 const h=fixture(),today=h.mount();assert.equal(today.render().value,null);await flush();
 const first=today.render().value;assert.equal(first.owner,'student-one');assert.equal(h.calls.length,1);today.dispose();
 h.setPath('/preparation');const preparation=h.mount(),initial=preparation.render();
 assert.equal(initial.value.marker,first.marker,'preparation has data during its first render rather than a loading-only shell');
 preparation.strictReplay();await flush();
 assert.equal(preparation.render().value.marker,first.marker);assert.equal(h.calls.length,1,'StrictMode replay and route remount share the cached read');
 for(let index=0;index<10;index++)preparation.render();await flush();
 assert.equal(h.calls.length,1,'stable URL and scope dependencies do not start an effect loop');
 assert.ok(h.calls.every(call=>call.url.startsWith('/api/training?')),'the hook never triggers a duplicate bootstrap');preparation.dispose();
});

test('StrictMode cleanup preserves a shared pending request and ignores abandoned completions',async()=>{
 const h=fixture(),gate=deferred();h.setHandler(()=>gate.promise);
 const page=h.mount();page.render();page.strictReplay();
 assert.equal(h.calls.length,1,'aborting the first subscriber leaves its shared request available to the replay');
 gate.resolve(h.json(h.payload()));await flush();assert.equal(page.render().value.owner,'student-one');assert.equal(page.disposedWrites,0);
 const late=deferred();h.cache.invalidate();h.setHandler(()=>late.promise);page.render().reload();page.render();page.dispose();
 late.resolve(h.json(h.payload()));await flush();assert.equal(page.disposedWrites,0,'unmounted hook ignores even a successful late response');
});

test('same support ID cannot reuse an old department, publication version or different actor snapshot',async()=>{
 const h=fixture(),initial=h.mount();initial.render();await flush();initial.render();initial.dispose();
 for(const change of [()=>{h.context.target.department='화학공학과';},()=>{h.context.data.package.active_version=2;},()=>{h.context.data.user.id='student-two';h.cache.seedIdentity('student-two');}]){
  change();const page=h.mount();assert.equal(page.render().value,null,'a changed scope cannot claim the old URL cache as its initial value');await flush();
  const actual=page.render().value;assert.equal(actual.department,h.context.target.department);assert.equal(actual.version,h.context.data.package.active_version);assert.equal(actual.owner,h.context.data.user.id);page.dispose();
 }
 assert.equal(h.calls.length,4);const views=h.calls.map(call=>new URL(call.url,'http://localhost:3100').searchParams.get('viewScope'));
 assert.notEqual(views[0],views[1]);assert.notEqual(views[1],views[2]);
});

test('Korea midnight invalidates mounted and remounted views even inside the three-second TTL',async()=>{
 const h=fixture();h.setTime('2026-10-21T14:59:59.500Z');const page=h.mount();page.render();await flush();assert.equal(page.render().value.today.date,'2026-10-21');
 h.advance(1_000);page.midnight();
 assert.equal(page.render().value,null,'yesterday tasks are hidden while the new Korea-day request is pending');await flush();
 assert.equal(page.render().value.today.date,'2026-10-22');assert.equal(h.calls.length,2,'the old three-second payload is never reinjected after midnight');page.dispose();
 const next=h.mount();assert.equal(next.render().value,null,'the timer-triggered no-store refresh is deliberately not retained for a later mount');await flush();
 assert.equal(next.render().value.today.date,'2026-10-22');assert.equal(h.calls.length,3);next.dispose();
});

test('a stale same-ID scope response cannot overwrite the replacement page or revive another actor',async()=>{
 const h=fixture(),old=deferred();h.setHandler(()=>old.promise);const page=h.mount();page.render();
 h.context.target.department='새 학과';h.setHandler(undefined);
 assert.equal(page.render().value,null);await flush();assert.equal(page.render().value.department,'새 학과');
 old.resolve(h.json({owner:'student-one',department:'이전 학과',today:{date:h.day()}}));await flush();
 assert.equal(page.render().value.department,'새 학과','the disposed prior-scope subscription never replaces current data');
 const gate=deferred();h.cache.invalidate();h.setHandler(()=>gate.promise);page.render().reload();page.render();
 h.context.data.user.id='student-two';h.cache.seedIdentity('student-two');h.setHandler(undefined);
 assert.equal(page.render().value,null,'a changed actor hides even the previous loaded React value immediately');await flush();
 gate.resolve(h.json({owner:'student-one',today:{date:h.day()}}));await flush();
 assert.equal(page.render().value.owner,'student-two');assert.equal(page.render().error,'');page.dispose();
});

test('refresh, writes, expiry and browser restoration cannot leave a stale training view permanently cached',async()=>{
 const h=fixture(),page=h.mount();page.render();await flush();page.render();
 page.render().reload();page.render();await flush();assert.equal(h.calls.length,2);assert.equal(h.calls[1].init.cache,'no-store');
 h.cache.invalidate();h.context.learningRevision++;page.render();await flush();assert.equal(h.calls.length,3,'a saved answer revision reloads the current plan');page.dispose();
 h.advance(3_000);const expired=h.mount();assert.equal(expired.render().value,null,'expired cache is absent on first render');await flush();assert.equal(h.calls.length,4);
 h.emit('focus');expired.render();await flush();assert.equal(h.calls.length,5,'browser restoration requests a fresh plan even before its new TTL expires');
 expired.dispose();h.emit('pageshow');assert.equal(h.calls.length,5,'disposed restoration listeners do not issue requests');
});
