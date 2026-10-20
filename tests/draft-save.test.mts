import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {flushPendingDrafts,registerDraftSaver} from '../apps/web/src/lib/client/draft-save';

function deferred(){let resolve!:()=>void,reject!:(error:Error)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

test('logout waits for all registered draft writers and coalesces concurrent clicks per account',async()=>{
  const user=randomUUID(),first=deferred(),second=deferred();let calls=0,finished=false;
  const disposeA=registerDraftSaver(user,()=>{calls++;return first.promise;}),disposeB=registerDraftSaver(user,()=>{calls++;return second.promise;});
  const flight=flushPendingDrafts(user);assert.equal(flushPendingDrafts(user),flight);void flight.then(()=>{finished=true;});await Promise.resolve();assert.equal(calls,2);
  first.resolve();await Promise.resolve();await Promise.resolve();assert.equal(finished,false);
  second.resolve();await flight;assert.equal(finished,true);disposeA();disposeB();
});

test('a failed writer waits for the others, blocks logout and can retry without losing registration',async()=>{
  const user=randomUUID(),slow=deferred();let fail=true,attempts=0,finished=false;
  const disposeA=registerDraftSaver(user,async()=>{attempts++;if(fail)throw Error('disk unavailable');}),disposeB=registerDraftSaver(user,()=>slow.promise);
  const flight=flushPendingDrafts(user);void flight.catch(()=>{finished=true;});await Promise.resolve();await Promise.resolve();assert.equal(finished,false,'one failure cannot abandon another in-flight draft');
  slow.resolve();await assert.rejects(flight,/초안을 보관하지 못했어요/);assert.equal(attempts,1);fail=false;await flushPendingDrafts(user);assert.equal(attempts,2);disposeA();disposeB();
});

test('writers belong to one account and unmounted workspaces unregister idempotently',async()=>{
  const user=randomUUID(),other=randomUUID();let own=0,foreign=0;
  const disposeA=registerDraftSaver(user,()=>{own++;}),disposeB=registerDraftSaver(other,()=>{foreign++;});
  await flushPendingDrafts(user);assert.equal(own,1);assert.equal(foreign,0);disposeA();disposeA();await flushPendingDrafts(user);assert.equal(own,1);await flushPendingDrafts(other);assert.equal(foreign,1);disposeB();
});
