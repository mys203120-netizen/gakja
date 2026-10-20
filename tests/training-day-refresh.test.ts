import test from 'node:test';
import assert from 'node:assert/strict';
import {millisecondsUntilNextKoreaDay,scheduleTrainingDayRefresh} from '../apps/web/src/lib/training-day-refresh';

test('next refresh follows Korea midnight regardless of UTC day',()=>{
  assert.equal(millisecondsUntilNextKoreaDay(Date.parse('2026-10-20T14:59:59.950Z')),50);
  assert.equal(millisecondsUntilNextKoreaDay(Date.parse('2026-10-20T15:00:00.000Z')),86_400_000);
  assert.equal(millisecondsUntilNextKoreaDay(Date.parse('2026-10-20T00:00:00.000Z')),54_000_000);
  assert.equal(millisecondsUntilNextKoreaDay(Number.NaN),60_000);
});
test('one refresh at midnight schedules the next day and cleanup stops a pending callback',()=>{
  let now=Date.parse('2026-10-20T14:59:59.950Z'),sequence=0,refreshes=0;
  const pending=new Map<number,{callback:()=>void;delay:number}>();
  const clock={now:()=>now,setTimeout(callback:()=>void,delay:number){const id=++sequence;pending.set(id,{callback,delay});return id;},clearTimeout(id:number){pending.delete(id);}};
  const dispose=scheduleTrainingDayRefresh(()=>{refreshes++;},clock as any);
  assert.equal(pending.size,1);assert.equal(pending.get(1)?.delay,50);assert.equal(refreshes,0);
  const first=pending.get(1)!;pending.delete(1);now+=first.delay;first.callback();
  assert.equal(refreshes,1);assert.equal(pending.size,1);assert.equal(pending.get(2)?.delay,86_400_000);
  const stale=pending.get(2)!;dispose();assert.equal(pending.size,0);
  stale.callback();assert.equal(refreshes,1);assert.equal(pending.size,0);
});
test('default timers preserve the browser host receiver when scheduling and clearing',()=>{
  const originalSetTimeout=globalThis.setTimeout,originalClearTimeout=globalThis.clearTimeout;
  let scheduled=0,cleared=0;
  try {
    globalThis.setTimeout=function(this:unknown,callback:()=>void,delay:number){assert.equal(this,globalThis,'browser setTimeout requires the window receiver');assert.equal(typeof callback,'function');assert.ok(delay>0&&delay<=86_400_000);scheduled++;return 7 as any;} as any;
    globalThis.clearTimeout=function(this:unknown,timer:unknown){assert.equal(this,globalThis,'browser clearTimeout requires the window receiver');assert.equal(timer,7);cleared++;};
    const dispose=scheduleTrainingDayRefresh(()=>{});assert.equal(scheduled,1);dispose();assert.equal(cleared,1);
  }finally {globalThis.setTimeout=originalSetTimeout;globalThis.clearTimeout=originalClearTimeout;}
});
