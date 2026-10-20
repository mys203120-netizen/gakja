import test from 'node:test';
import assert from 'node:assert/strict';
import {installScrollNavigation} from '../apps/web/src/lib/client/scroll-navigation.ts';
function setup(){
 const listeners=new Map<string,Function>(),timers=new Map<number,Function>();let index=0;
 const nav={dataset:{} as Record<string,string>};
 const doc={visibilityState:'visible',scrollingElement:{scrollTop:0},defaultView:{innerWidth:390,scrollY:0,setTimeout(fn:Function){timers.set(++index,fn);return index;},clearTimeout(id:number){timers.delete(id);}},addEventListener(n:string,fn:Function){listeners.set(n,fn);},removeEventListener(n:string){listeners.delete(n);}};
 const stop=installScrollNavigation(nav as any,doc as any);
 return {doc,nav,listeners,timers,stop,emit(n:string,value:any={}){listeners.get(n)?.(value);},scroll(y:number){doc.scrollingElement.scrollTop=y;listeners.get('scroll')?.({target:doc});},idle(){for(const [id,fn] of [...timers]){timers.delete(id);fn();}}};
}
test('only downward movement shows navigation and inactivity hides it',()=>{
 const h=setup();assert.equal(h.nav.dataset.scrollActive,'false');assert.equal(h.timers.size,0);
 h.scroll(20);assert.equal(h.nav.dataset.scrollActive,'true');assert.equal(h.timers.size,1);
 const old=[...h.timers.keys()][0];h.scroll(40);assert.equal(h.timers.size,1);assert.equal(h.timers.has(old),false);
 h.scroll(20);assert.equal(h.nav.dataset.scrollActive,'false');assert.equal(h.timers.size,0);
 h.scroll(30);assert.equal(h.nav.dataset.scrollActive,'true');
 h.idle();assert.equal(h.nav.dataset.scrollActive,'false');h.stop();
});
test('keyboard traversal remains available, desktop is unaffected and backgrounding hides it',()=>{
 const h=setup();h.emit('keydown',{key:'Tab'});assert.equal(h.nav.dataset.scrollActive,'true');
 h.doc.visibilityState='hidden';h.emit('visibilitychange');assert.equal(h.nav.dataset.scrollActive,'false');assert.equal(h.timers.size,0);
 h.doc.defaultView.innerWidth=1024;h.scroll(20);assert.equal(h.nav.dataset.scrollActive,'false');h.stop();
});
test('unmount and route replacement remove listeners and outstanding timers',()=>{
 const h=setup();h.scroll(20);h.stop();assert.equal(h.timers.size,0);assert.equal(h.listeners.size,0);assert.equal(h.nav.dataset.scrollActive,undefined);
});

test('horizontal movement, tiny bounce and upward nested scroll do not reveal navigation',()=>{
 const h=setup();h.scroll(1);h.scroll(0);assert.equal(h.nav.dataset.scrollActive,'false');
 const list={scrollTop:80,parentElement:null};h.emit('touchstart',{target:list});list.scrollTop=50;h.emit('scroll',{target:list});assert.equal(h.nav.dataset.scrollActive,'false');
 list.scrollTop=90;h.emit('scroll',{target:list});assert.equal(h.nav.dataset.scrollActive,'true');
 h.idle();h.emit('scroll',{target:list});assert.equal(h.nav.dataset.scrollActive,'false');h.stop();
});
