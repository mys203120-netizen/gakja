import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Exercise the HTTP handlers against an in-memory SQL boundary. No student data or credentials are used.
const state={user:{id:'availability-owner',role:'student'} as any,profiles:new Map<string,any>(),preferences:new Map<string,any>(),writes:0};
(globalThis as any).__trainingAvailabilityTest=state;
const modules:Record<string,string>={
  '@/lib/auth':`exports.requireUser=async()=>{const user=globalThis.__trainingAvailabilityTest.user;if(!user){const e=new Error('로그인이 필요해요.');e.status=401;throw e;}return user;};exports.checkOrigin=request=>{if(request.headers.get('origin')!=='http://fixture.test'){const e=new Error('허용되지 않은 요청');e.status=403;throw e;}};`,
  '@/lib/db':`exports.ApiError=class ApiError extends Error{constructor(status,message){super(message);this.status=status;}};
    exports.errorResponse=error=>Response.json({error:error.message},{status:error.status||500});
    async function run(sql,args=[]){const s=globalThis.__trainingAvailabilityTest;
      if(sql.startsWith('select p.created_at,'))return s.profiles.has(args[0])?[{created_at:s.profiles.get(args[0]),availability:structuredClone(s.preferences.get(args[0])?.trainingAvailability)}]:[];
      if(sql.startsWith('select created_at from profiles'))return s.profiles.has(args[0])?[{created_at:s.profiles.get(args[0])}]:[];
      if(sql.startsWith('select data from student_preferences'))return s.preferences.has(args[0])?[{data:structuredClone(s.preferences.get(args[0]))}]:[];
      if(sql.startsWith('insert into student_preferences')){if(!s.preferences.has(args[0])){s.preferences.set(args[0],{});s.writes++;}return [];}
      if(sql.startsWith('update student_preferences')){s.preferences.set(args[0],{...s.preferences.get(args[0]),trainingAvailability:JSON.parse(args[1]),trainingAvailabilityRequired:false});s.writes++;return [];}
      throw new Error('Unhandled test SQL: '+sql);
    }
    exports.query=run;exports.transaction=async fn=>{const s=globalThis.__trainingAvailabilityTest,backup=structuredClone({preferences:s.preferences,writes:s.writes});try{return await fn({query:async(sql,args)=>({rows:await run(sql,args)})});}catch(error){Object.assign(s,backup);throw error;}};`,
};
const folder=mkdtempSync(join(tmpdir(),'training-availability-')),keys=Object.keys(modules),files=keys.map((key,index)=>{const path=join(folder,index+'.cjs');writeFileSync(path,modules[key]);return path;});
const hooks=registerHooks({resolve(specifier,context,next){
  if(modules[specifier])return {url:pathToFileURL(files[keys.indexOf(specifier)]).href,shortCircuit:true};
  if(specifier.startsWith('@/'))return {url:pathToFileURL(resolve('apps/web/src',specifier.slice(2)+'.ts')).href,shortCircuit:true};
  return next(specifier,context);
}});
after(()=>{hooks.deregister();files.forEach(unlinkSync);rmdirSync(folder);delete (globalThis as any).__trainingAvailabilityTest;});
const routes=await import('../apps/web/src/app/api/training/preferences/route.ts');
const input={weekdayMinutes:120,weekendMinutes:180,blockedDates:['2026-10-24'],overrides:{'2026-10-25':45}};
function reset(){state.user={id:'availability-owner',role:'student'};state.profiles=new Map([['availability-owner',new Date('2026-10-19T16:00:00.000Z')],['availability-other',new Date('2026-10-01T00:00:00.000Z')]]);state.preferences=new Map([['availability-owner',{theme:'preserve',selectedTargetId:'school-a'}],['availability-other',{theme:'other'}]]);state.writes=0;}
const post=(value:unknown,origin='http://fixture.test')=>routes.POST(new Request('http://fixture.test/api/training/preferences',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(value)}));

test('first GET exposes the server joining date without saving proposed defaults',async()=>{
  reset();const response=await routes.GET(),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.availability,null);assert.equal(body.startDate,'2026-10-20');assert.equal(body.registeredAt,'2026-10-19T16:00:00.000Z');assert.equal(state.writes,0);assert.match(response.headers.get('cache-control')||'',/no-store/);
});
test('saving binds start date to the authenticated profile, preserves preferences and other students',async()=>{
  reset();state.preferences.get('availability-owner').trainingAvailabilityRequired=true;const beforeOther=structuredClone(state.preferences.get('availability-other'));
  const response=await post({expectedRevision:0,availability:input}),body=await response.json();
  assert.equal(response.status,200);assert.equal(body.availability.startDate,'2026-10-20');assert.equal(body.availability.revision,1);assert.equal(state.preferences.get('availability-owner').trainingAvailabilityRequired,false);assert.equal(state.preferences.get('availability-owner').theme,'preserve');assert.equal(state.preferences.get('availability-owner').selectedTargetId,'school-a');assert.deepEqual(state.preferences.get('availability-other'),beforeOther);
  const loaded=await (await routes.GET()).json();assert.deepEqual(loaded.availability,body.availability);
});
test('a stale save is rejected and later updates retain original joining date',async()=>{
  reset();await post({expectedRevision:0,availability:input});const saved=structuredClone(state.preferences.get('availability-owner'));
  assert.equal((await post({expectedRevision:0,availability:{...input,weekdayMinutes:300}})).status,409);assert.deepEqual(state.preferences.get('availability-owner'),saved);
  const updated=await (await post({expectedRevision:1,availability:{...input,weekdayMinutes:90}})).json();assert.equal(updated.availability.revision,2);assert.equal(updated.availability.startDate,'2026-10-20');assert.equal(updated.availability.weekdayMinutes,90);
});
test('foreign origin, missing session and staff are rejected before changes',async()=>{
  reset();assert.equal((await post({expectedRevision:0,availability:input},'http://foreign.test')).status,403);
  state.user=null;assert.equal((await routes.GET()).status,401);assert.equal((await post({expectedRevision:0,availability:input})).status,401);
  state.user={id:'availability-owner',role:'staff'};assert.equal((await routes.GET()).status,403);assert.equal((await post({expectedRevision:0,availability:input})).status,403);assert.equal(state.writes,0);
});
test('a client cannot move the joining date, select another owner or submit invalid minutes and dates',async()=>{
  reset();for(const value of [{expectedRevision:0,availability:{...input,startDate:'2000-01-01'}},{expectedRevision:0,studentId:'availability-other',availability:input},{expectedRevision:0,availability:{...input,weekdayMinutes:481}},{expectedRevision:0,availability:{...input,csatDate:'2026-02-30'}},{expectedRevision:-1,availability:input}])assert.equal((await post(value)).status,400);
  assert.equal(state.writes,0);
});


test('legacy reads do not rewrite records; an explicit save stores only the single-period v2 contract',async()=>{
 reset();const legacy={...input,version:1,startDate:'2026-10-20',revision:4,savedAt:'2026-10-20T00:00:00.000Z',csatDate:'2099-11-19',beforeCsatWeekdayMinutes:25,beforeCsatWeekendMinutes:55};
 state.preferences.get('availability-owner').trainingAvailability=legacy;const before=structuredClone(state.preferences);
 const read=await (await routes.GET()).json();assert.equal(read.availability.weekdayMinutes,25);assert.equal(read.availability.weekendMinutes,55);assert.equal(read.availability.version,2);assert.equal(state.writes,0);assert.deepEqual(state.preferences,before);
 const {version,startDate,revision,savedAt,...editable}=read.availability;
 const response=await post({expectedRevision:4,availability:editable}),saved=await response.json();
 assert.equal(response.status,200);assert.equal(saved.availability.version,2);assert.equal(saved.availability.revision,5);assert.equal(saved.availability.weekdayMinutes,25);assert.ok(!('csatDate' in saved.availability));assert.deepEqual(state.preferences.get('availability-other'),before.get('availability-other'));
});
