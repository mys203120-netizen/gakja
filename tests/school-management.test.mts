import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync,mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {schoolDirectory} from '../apps/web/src/lib/school-directory.ts';
import {overlayOfficialCalendar} from '../apps/web/src/lib/official-admission-calendar.ts';

// The route and service run against an in-memory SQL boundary. No credentials,
// network calls or live student rows participate in these mutation tests.
const base=JSON.parse(readFileSync('apps/web/src/data/school-interview-calendar.json','utf8'));
const official=JSON.parse(readFileSync('apps/web/src/data/school-interview-official.json','utf8'));
const school=schoolDirectory.find(item=>item.canonicalName==='서울시립대학교')!;
const environment=school.departments.find(item=>item.name==='환경공학부')!;
const economics=school.departments.find(item=>item.name==='경제학부')!;
const studentId='fixture-school-owner';
const state={snapshot:{catalogue:overlayOfficialCalendar(base,official),official,officialSchools:8,stale:false,lastRefreshFailed:false,refreshDue:false},targets:[] as any[],preferences:new Map<string,any>(),audits:[] as any[],queries:[] as any[],user:{id:studentId,role:'student'} as any,writeCount:0,history:[{target_id:'kept-target',answer:'학생의 기존 답변',snapshot:{university:'이전 학교'}}]};
(globalThis as any).__schoolManagementTest=state;
const modules:Record<string,string>={
  'server-only':'module.exports={};',
  '@/lib/db':`exports.ApiError=class ApiError extends Error{constructor(status,message){super(message);this.status=status;}};
    async function run(sql,args=[]){const s=globalThis.__schoolManagementTest;s.queries.push({sql,args});
      if(sql.startsWith('select')&&sql.includes('school_reference_catalog'))return ${JSON.stringify(schoolDirectory.map(item=>({id:item.id,university:item.university,revision:1,status:'historical_reference',data:{},source:{}})))}.filter(row=>!sql.includes('where id=')||row.id===args[0]);
      if(sql.startsWith('select')&&sql.includes('support_targets')){
        let rows=s.targets.filter(row=>row.student_id===(sql.includes('student_id=$2')?args[1]:args[0]));
        if(sql.includes('where id=$1'))rows=rows.filter(row=>row.id===args[0]);
        if(sql.includes("nullif(data->>'archived_at','') is null"))rows=rows.filter(row=>!row.data.archived_at);
        if(sql.includes("coalesce(data->>'admission_year',data->>'year')=$2"))rows=rows.filter(row=>String(row.data.admission_year||row.data.year)===args[1]);
        if(sql.includes('is not null)'))rows.sort((a,b)=>Number(Boolean(a.data.archived_at))-Number(Boolean(b.data.archived_at)));
        return structuredClone(sql.includes('limit 1')?rows.slice(0,1):rows);
      }
      if(sql.startsWith('insert into support_targets')){s.writeCount++;const row={id:args[0],student_id:args[1],data:JSON.parse(args[2])};s.targets.push(row);return structuredClone([row]);}
      if(sql.startsWith('update support_targets')){const row=s.targets.find(row=>row.id===args[1]&&row.student_id===args[2]);if(!row)return [];s.writeCount++;row.data=JSON.parse(args[0]);return structuredClone([row]);}
      if(sql.startsWith('select')&&sql.includes('student_preferences'))return s.preferences.has(args[0])?[{data:structuredClone(s.preferences.get(args[0]))}]:[];
      if(sql.startsWith('insert into student_preferences')){s.preferences.set(args[0],{...s.preferences.get(args[0]),...JSON.parse(args[1])});return [];}
      if(sql.startsWith('insert into audit_logs')){s.audits.push({sql,args});return [];}
      return [];
    }
    exports.query=run;exports.transaction=async fn=>{const s=globalThis.__schoolManagementTest,backup=structuredClone({targets:s.targets,preferences:s.preferences,audits:s.audits,writeCount:s.writeCount});try{return await fn({query:async(sql,args)=>({rows:await run(sql,args)})});}catch(error){Object.assign(s,backup);throw error;}};`,
  '@/lib/auth':`exports.checkOrigin=request=>{if(request.headers.get('origin')!=='http://fixture.test'){const e=new Error('Forbidden origin');e.status=403;throw e;}};exports.requireUser=async()=>{const user=globalThis.__schoolManagementTest.user;if(!user){const e=new Error('Unauthenticated');e.status=401;throw e;}return user;};`,
  '@/lib/ai':`exports.requireStudent=user=>{if(user.role!=='student'){const e=new Error('Student only');e.status=403;throw e;}};exports.featureError=e=>({status:e.status||(e.name==='ZodError'?400:500),error:e.message,code:'FIXTURE'});`,
  'next/server':`exports.after=fn=>{};`,
  'calendar-store-stub':`exports.readAdmissionCalendar=async()=>globalThis.__schoolManagementTest.snapshot;exports.refreshAdmissionCalendar=async()=>({refreshed:false});`,
};
const folder=mkdtempSync(join(tmpdir(),'school-management-')),keys=Object.keys(modules),files=keys.map((key,index)=>{const path=join(folder,index+'.cjs');writeFileSync(path,modules[key]);return path;});
registerHooks({resolve(specifier,context,next){
  const key=specifier.includes('admission-calendar-store')?'calendar-store-stub':specifier;
  if(modules[key])return {url:pathToFileURL(files[keys.indexOf(key)]).href,shortCircuit:true};
  if(specifier.startsWith('@/'))return {url:pathToFileURL(resolve('apps/web/src',specifier.slice(2)+'.ts')).href,shortCircuit:true};return next(specifier,context);
}});
after(()=>{files.forEach(unlinkSync);rmdirSync(folder);delete (globalThis as any).__schoolManagementTest;});
const service=await import('../apps/web/src/lib/school-learning.ts');
const routes=await import('../apps/web/src/app/api/schools/route.ts');
const {previewSchoolAdmissionCalendar}=await import('../apps/web/src/lib/school-onboarding-calendar.ts');
const input={referenceId:school.id,departmentId:environment.id,admissionYear:2027,track:'학생부종합전형Ⅰ(면접형)',onboarding:true};
const rawTarget=(major=environment.name)=>({university:school.university,school_reference_id:school.id,campus:'본교',department:major,major,admission_type:input.track,admission_year:2027});
async function reviewed(major=environment){return {...input,departmentId:major.id,calendarReview:{fingerprint:(await previewSchoolAdmissionCalendar(rawTarget(major.name))).fingerprint,acknowledged:true}};}
function reset(){state.targets=[];state.preferences.clear();state.audits=[];state.queries=[];state.writeCount=0;state.user={id:studentId,role:'student'};}
async function route(method:'POST'|'PATCH'|'DELETE',body:unknown,origin='http://fixture.test'){
  return routes[method](new Request('http://fixture.test/api/schools',{method,headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}));
}

test('school mutations reject missing users, non-students and foreign origins before writes',async()=>{
  for(const method of ['POST','PATCH','DELETE'] as const){
    for(const user of [null,{id:'fixture-admin',role:'admin'}]){reset();state.user=user;assert.equal((await route(method,{targetId:'foreign',...input})).status,user?403:401);assert.equal(state.writeCount,0);}
    reset();assert.equal((await route(method,input,'https://foreign.test')).status,403);assert.equal(state.writeCount,0);
  }
});
test('edit and archive cannot mutate another student target or accept a supplied owner ID',async()=>{
  for(const method of ['PATCH','DELETE'] as const){reset();state.targets.push({id:'foreign',student_id:'other-student',data:rawTarget()});const before=structuredClone(state.targets);const result=await route(method,{targetId:'foreign',studentId:'other-student',...await reviewed()});assert.equal(result.status,404);assert.deepEqual(state.targets,before);assert.equal(state.writeCount,0);}
});
test('editing requires a newly acknowledged calendar and rejects stale fingerprints without writes',async()=>{
  reset();state.targets.push({id:'kept-target',student_id:studentId,data:rawTarget()});
  assert.equal((await route('PATCH',{targetId:'kept-target',...input})).status,400);
  assert.equal((await route('PATCH',{targetId:'kept-target',...await reviewed(),calendarReview:{fingerprint:'f'.repeat(64),acknowledged:true}})).status,409);
  assert.equal(state.writeCount,0);
});
test('changing identity preserves the target ID and history, clears previous appointments and resolves the new calendar',async()=>{
  reset();const history=structuredClone(state.history);state.targets.push({id:'kept-target',student_id:studentId,data:{...rawTarget(),historyKey:'retain',interview_date:'2026-11-29T14:20:00+09:00',interview_at:'2026-11-29T14:20',schedule:{personal_at:'2026-11-29T14:20',location:'old room'},school_interview_date:'2026-11-29',interview_stage:'old stage',profile:{university:'old school'}}});
  const response=await route('PATCH',{targetId:'kept-target',...await reviewed(economics)});assert.equal(response.status,200);const {target}=await response.json();
  assert.equal(target.id,'kept-target');assert.equal(target.department,economics.name);assert.equal(target.historyKey,'retain');assert.equal(target.interview_date,undefined);assert.equal(target.interview_at,undefined);assert.equal(target.schedule,undefined);assert.equal(target.school_interview_date,undefined);assert.equal(target.interview_stage,undefined);assert.equal(target.admission_calendar_registration.calendar_year,2026);assert.equal(target.admission_calendar_registration.personal_appointment_confirmed,false);assert.deepEqual(state.history,history);assert.equal(state.targets.length,1);
});
test('reviewing an unchanged identity preserves the actual personal schedule',async()=>{
  reset();state.targets.push({id:'kept-target',student_id:studentId,data:{...rawTarget(),interview_date:'2026-11-29T14:20:00+09:00',schedule:{personal_at:'2026-11-29T14:20:00+09:00',location:'room'}}});
  const target=await service.updateStudentSchool(studentId,{targetId:'kept-target',...await reviewed()});assert.equal(target.interview_date,'2026-11-29T14:20:00+09:00');assert.equal(target.schedule.location,'room');
});
test('editing into another active identity is rejected and both registrations remain intact',async()=>{
  reset();state.targets.push({id:'kept-target',student_id:studentId,data:rawTarget()},{id:'other-target',student_id:studentId,data:rawTarget(economics.name)});const before=structuredClone(state.targets);
  assert.equal((await route('PATCH',{targetId:'kept-target',...await reviewed(economics)})).status,409);assert.deepEqual(state.targets,before);
});
test('archive hides the target from GET without deleting history and keeps a remaining selected school',async()=>{
  reset();const history=structuredClone(state.history);state.targets.push({id:'kept-target',student_id:studentId,data:rawTarget()},{id:'other-target',student_id:studentId,data:rawTarget(economics.name)});state.preferences.set(studentId,{selectedTargetId:'other-target',displayName:'remain'});
  const response=await route('DELETE',{targetId:'kept-target'});assert.equal(response.status,200);assert.equal((await response.json()).selectedTargetId,'other-target');assert.ok(state.targets[0].data.archived_at);assert.equal(state.targets.length,2);assert.deepEqual(state.history,history);assert.equal(state.preferences.get(studentId).displayName,'remain');
  const context=await routes.GET(new Request('http://fixture.test/api/schools'));assert.equal(context.status,200);assert.deepEqual((await context.json()).targets.map((target:any)=>target.id),['other-target']);
});
test('removing the selected or last school chooses a valid fallback and leaves onboarding completed',async()=>{
  reset();state.targets.push({id:'kept-target',student_id:studentId,data:rawTarget()},{id:'other-target',student_id:studentId,data:rawTarget(economics.name)});state.preferences.set(studentId,{selectedTargetId:'kept-target'});
  assert.equal((await service.archiveStudentSchool(studentId,{targetId:'kept-target'})).selectedTargetId,'other-target');
  assert.equal((await service.archiveStudentSchool(studentId,{targetId:'other-target'})).selectedTargetId,null);assert.deepEqual(state.preferences.get(studentId),{selectedTargetId:null,schoolOnboardingCompleted:true,schoolCalendarOnboardingCompleted:true});
  const count=state.audits.length;await service.archiveStudentSchool(studentId,{targetId:'other-target'});assert.equal(state.audits.length,count);
});
test('re-adding an archived identity restores its original ID and history and repeated registration remains idempotent',async()=>{
  reset();const history=structuredClone(state.history);state.targets.push({id:'kept-target',student_id:studentId,data:{...rawTarget(),archived_at:'2026-10-16T01:00:00Z',historyKey:'keep',interview_date:'2026-11-29T14:20:00+09:00'}});
  const approved=await reviewed(),first=await service.registerStudentSchool(studentId,approved),second=await service.registerStudentSchool(studentId,approved);
  assert.equal(first.id,'kept-target');assert.equal(second.id,first.id);assert.equal(first.archived_at,undefined);assert.equal(first.historyKey,'keep');assert.equal(first.interview_date,'2026-11-29T14:20:00+09:00');assert.equal(state.targets.length,1);assert.deepEqual(state.history,history);assert.equal(state.preferences.get(studentId).selectedTargetId,first.id);
});
