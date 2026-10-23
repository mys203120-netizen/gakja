import test from 'node:test';
import assert from 'node:assert/strict';
import {installScrollNavigation} from '../apps/web/src/lib/client/scroll-navigation.ts';
const reserved='calc(92px + env(safe-area-inset-bottom, 0px))';
function setup(){
 const listeners=new Map<string,Function>(),windowListeners=new Map<string,Function>(),timers=new Map<number,Function>();let index=0;
 const nav={dataset:{} as Record<string,string>},spaces=new Map<string,string>();
 const doc={activeElement:null as null|{matches:(selector:string)=>boolean},documentElement:{style:{setProperty(name:string,value:string){spaces.set(name,value);}}},visibilityState:'visible',scrollingElement:{scrollTop:0},defaultView:{innerWidth:390,scrollY:0,setTimeout(fn:Function){timers.set(++index,fn);return index;},clearTimeout(id:number){timers.delete(id);},addEventListener(n:string,fn:Function){windowListeners.set(n,fn);},removeEventListener(n:string){windowListeners.delete(n);}},addEventListener(n:string,fn:Function){listeners.set(n,fn);},removeEventListener(n:string){listeners.delete(n);}};
 const stop=installScrollNavigation(nav as any,doc as any);
 return {doc,nav,listeners,windowListeners,timers,spaces,stop,emit(n:string,value:any={}){listeners.get(n)?.(value);},resize(width:number){doc.defaultView.innerWidth=width;windowListeners.get('resize')?.();},scroll(y:number){doc.scrollingElement.scrollTop=y;listeners.get('scroll')?.({target:doc});},idle(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}}};
}

test('mobile navigation and composer space remain present before, during and after scrolling',()=>{
 const h=setup();assert.equal(h.nav.dataset.scrollActive,'true');assert.equal(h.spaces.get('--mobile-navigation-space'),reserved);
 for(const y of [20,40,20,0]){h.scroll(y);h.idle();assert.equal(h.nav.dataset.scrollActive,'true');assert.equal(h.spaces.get('--mobile-navigation-space'),reserved);}
 assert.equal(h.timers.size,0,'persistent navigation creates no inactivity timer');assert.equal(h.listeners.has('scroll'),false,'scroll direction no longer controls primary navigation');h.stop();
});

test('text input focus hides the dock and releases its space until focus leaves editing',()=>{
 const h=setup();h.doc.activeElement={matches:()=>true};h.emit('focusin');assert.equal(h.nav.dataset.inputActive,'true');assert.equal(h.nav.dataset.scrollActive,'false');assert.equal(h.spaces.get('--mobile-navigation-space'),'0px');
 h.scroll(80);h.emit('keydown',{key:'Tab'});assert.equal(h.nav.dataset.scrollActive,'false');
 h.doc.activeElement={matches:()=>false};h.emit('focusin');assert.equal(h.nav.dataset.inputActive,'false');assert.equal(h.nav.dataset.scrollActive,'true');assert.equal(h.spaces.get('--mobile-navigation-space'),reserved);h.stop();
});

test('blurring an input onto the page body restores navigation after the browser focus transfer',()=>{
 const h=setup();h.doc.activeElement={matches:()=>true};h.emit('focusin');h.emit('focusout');
 assert.equal(h.nav.dataset.inputActive,'true');h.doc.activeElement=null;h.idle();
 assert.equal(h.nav.dataset.inputActive,'false');assert.equal(h.nav.dataset.scrollActive,'true');assert.equal(h.spaces.get('--mobile-navigation-space'),reserved);h.stop();
});

test('keyboard navigation stays available and resizing or backgrounding releases only unavailable space',()=>{
 const h=setup();h.emit('keydown',{key:'Tab'});assert.equal(h.nav.dataset.scrollActive,'true');
 h.resize(1024);assert.equal(h.spaces.get('--mobile-navigation-space'),'0px');h.emit('keydown',{key:'Tab'});assert.equal(h.nav.dataset.scrollActive,'false');
 h.resize(390);assert.equal(h.spaces.get('--mobile-navigation-space'),reserved);
 h.doc.visibilityState='hidden';h.emit('visibilitychange');assert.equal(h.spaces.get('--mobile-navigation-space'),'0px');
 h.doc.visibilityState='visible';h.emit('visibilitychange');assert.equal(h.nav.dataset.scrollActive,'true');assert.equal(h.spaces.get('--mobile-navigation-space'),reserved);h.stop();
});

test('unmount and route replacement remove listeners, pending focus updates and reserved space',()=>{
 const h=setup();h.emit('focusout');assert.equal(h.timers.size,1);h.stop();
 assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);assert.equal(h.windowListeners.size,0);assert.equal(h.nav.dataset.scrollActive,undefined);assert.equal(h.nav.dataset.inputActive,undefined);assert.equal(h.spaces.get('--mobile-navigation-space'),'0px');
});
