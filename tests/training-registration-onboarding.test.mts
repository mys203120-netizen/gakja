import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync,mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {schoolDirectory} from '../apps/web/src/lib/school-directory.ts';
import {overlayOfficialCalendar} from '../apps/web/src/lib/official-admission-calendar.ts';
import {studentOnboardingDestination} from '../apps/web/src/lib/student-onboarding.ts';

// Use real registration/calendar logic against synthetic in-memory rows, never a database connection.
const catalogue=JSON.parse(readFileSync('apps/web/src/data/school-interview-calendar.json','utf8'));
const official=JSON.parse(readFileSync('apps/web/src/data/school-interview-official.json','utf8'));
const school=schoolDirectory.find(item=>item.canonicalName==='서울시립대학교')!,department=school.departments.find(item=>item.name==='환경공학부')!;
const state={snapshot:{catalogue:overlayOfficialCalendar(catalogue,official),official,officialSchools:8,stale:false,lastRefreshFailed:false,refreshDue:false},targets:[] as any[],preferences:new Map<string,any>(),audits:[] as any[],user:{id:'training-registration-owner',role:'student'} as any,failAudit:false};
(globalThis as any).__trainingRegistration=state;
const modules:Record<string,string>={
  'server-only':'module.exports={};',
  '@/lib/auth':`exports.requireUser=async()=>globalThis.__trainingRegistration.user;exports.checkOrigin=request=>{if(request.headers.get('origin')!=='http://fixture.test'){const error=new Error('Origin rejected');error.status=403;throw error;}};`,
  '@/lib/ai':`exports.requireStudent=user=>{if(user?.role!=='student'){const error=new Error('Student only');error.status=user?403:401;throw error;}};exports.featureError=error=>({status:error.status||(error.name==='ZodError'?400:500),error:error.message,code:'FIXTURE'});`,
  '@/lib/db':`exports.ApiError=class ApiError extends Error{constructor(status,message){super(message);this.status=status;}};exports.errorResponse=error=>Response.json({error:error.message},{status:error.status||500});
    async function run(sql,args=[]){const s=globalThis.__trainingRegistration;
      if(sql.includes('school_reference_catalog'))return [{id:'${school.id}',university:'${school.university}',revision:1,status:'historical_reference',data:{},source:{}}];
      if(sql.startsWith('select created_at from profiles'))return [{created_at:new Date('2026-10-19T16:00:00.000Z')}];
      if(sql.startsWith('select')&&sql.includes('support_targets'))return structuredClone(s.targets.filter(row=>row.student_id===args[0]&&(!args[1]||String(row.data.admission_year)===args[1])));
      if(sql.startsWith('insert into support_targets')){const row={id:args[0],student_id:args[1],data:JSON.parse(args[2])};s.targets.push(row);return structuredClone([row]);}
      if(sql.startsWith('update support_targets')){const row=s.targets.find(row=>row.id===args[1]&&row.student_id===args[2]);if(!row)return [];row.data=JSON.parse(args[0]);return structuredClone([row]);}
      if(sql.startsWith('select data from student_preferences'))return s.preferences.has(args[0])?[{data:structuredClone(s.preferences.get(args[0]))}]:[];
      if(sql.startsWith('insert into student_preferences')){if(args[1])s.preferences.set(args[0],{...s.preferences.get(args[0]),...JSON.parse(args[1])});else if(!s.preferences.has(args[0]))s.preferences.set(args[0],{});return [];}
      if(sql.startsWith('update student_preferences')){const previous=s.preferences.get(args[0])||{};if(args[1])s.preferences.set(args[0],{...previous,trainingAvailability:JSON.parse(args[1]),trainingAvailabilityRequired:false});else s.preferences.set(args[0],{...previous,trainingAvailabilityRequired:true});return [];}
      if(sql.startsWith('insert into audit_logs')){if(s.failAudit)throw new Error('Synthetic failure after preference update');s.audits.push({sql,args});return [];}
      if(sql.includes('pg_advisory_xact_lock'))return [];
      throw new Error('Unhandled test SQL '+sql);
    }
    exports.query=run;exports.transaction=async fn=>{const s=globalThis.__trainingRegistration,backup=structuredClone({targets:s.targets,preferences:s.preferences,audits:s.audits});try{return await fn({query:async(sql,args)=>({rows:await run(sql,args)})});}catch(error){Object.assign(s,backup);throw error;}};`,
  'calendar-store-stub':`exports.readAdmissionCalendar=async()=>globalThis.__trainingRegistration.snapshot;exports.refreshAdmissionCalendar=async()=>({refreshed:false});`,
  'next/server':'exports.after=()=>{};',
};
const folder=mkdtempSync(join(tmpdir(),'training-registration-')),keys=Object.keys(modules),files=keys.map((key,index)=>{const path=join(folder,index+'.cjs');writeFileSync(path,modules[key]);return path;});
const hooks=registerHooks({resolve(specifier,context,next){
  const key=specifier.includes('admission-calendar-store')?'calendar-store-stub':specifier;
  if(modules[key])return {url:pathToFileURL(files[keys.indexOf(key)]).href,shortCircuit:true};
  if(specifier.startsWith('@/'))return {url:pathToFileURL(resolve('apps/web/src',specifier.slice(2)+'.ts')).href,shortCircuit:true};
  return next(specifier,context);
}});
after(()=>{hooks.deregister();files.forEach(unlinkSync);rmdirSync(folder);delete (globalThis as any).__trainingRegistration;});
const schoolRoute=await import('../apps/web/src/app/api/schools/route.ts'),availabilityRoute=await import('../apps/web/src/app/api/training/preferences/route.ts');
const {previewSchoolAdmissionCalendar}=await import('../apps/web/src/lib/school-onboarding-calendar.ts');
const input={referenceId:school.id,departmentId:department.id,admissionYear:2027,track:'학생부종합전형Ⅰ(면접형)',onboarding:true};
const rawTarget={university:school.university,school_reference_id:school.id,campus:'본교',department:department.name,admission_type:input.track,admission_year:2027};
const settings={weekdayMinutes:120,weekendMinutes:180,csatDate:'2026-11-19',beforeCsatWeekdayMinutes:20,beforeCsatWeekendMinutes:60,blockedDates:[],overrides:{}};
const request=(path:string,value:unknown)=>new Request('http://fixture.test'+path,{method:'POST',headers:{origin:'http://fixture.test','content-type':'application/json'},body:JSON.stringify(value)});
function reset(){state.targets=[];state.preferences=new Map([['training-registration-owner',{theme:'keep'}],['foreign-owner',{theme:'foreign'}]]);state.audits=[];state.failAudit=false;state.user={id:'training-registration-owner',role:'student'};}
async function reviewed(onboarding=true){return {...input,onboarding,calendarReview:{fingerprint:(await previewSchoolAdmissionCalendar(rawTarget)).fingerprint,acknowledged:true}};}

test('registration persists pending setup; a fresh page resumes it, then a saved preference completes onboarding',async()=>{
  reset();const response=await schoolRoute.POST(request('/api/schools',await reviewed()));assert.equal(response.status,200);
  const preferences=state.preferences.get(state.user.id),target=(await response.json()).target;
  assert.equal(preferences.trainingAvailabilityRequired,true);assert.equal(preferences.theme,'keep');assert.equal(target.school_interview_date,'2026-11-29');
  assert.equal(studentOnboardingDestination({user:state.user,targets:[target],preferences},'/my'),'/availability?onboarding=1');
  assert.equal(studentOnboardingDestination({user:state.user,targets:[target],preferences},'/schools/new'),null);
  assert.equal((await availabilityRoute.POST(request('/api/training/preferences',{expectedRevision:0,availability:settings}))).status,200);
  const saved=state.preferences.get(state.user.id);assert.equal(saved.trainingAvailabilityRequired,false);assert.equal(saved.trainingAvailability.startDate,'2026-10-20');assert.equal(saved.theme,'keep');
  assert.equal(studentOnboardingDestination({user:state.user,targets:[target],preferences:saved},'/my'),null);assert.deepEqual(state.preferences.get('foreign-owner'),{theme:'foreign'});
});
test('ordinary additional registration leaves legacy users unmarked and configured users keep their saved time',async()=>{
  reset();assert.equal((await schoolRoute.POST(request('/api/schools',await reviewed(false)))).status,200);assert.equal(state.preferences.get(state.user.id).trainingAvailabilityRequired,undefined);
  await availabilityRoute.POST(request('/api/training/preferences',{expectedRevision:0,availability:settings}));const before=structuredClone(state.preferences.get(state.user.id));
  assert.equal((await schoolRoute.POST(request('/api/schools',await reviewed(true)))).status,200);assert.deepEqual(state.preferences.get(state.user.id),before);
});
test('a registration failure rolls back the target and pending availability marker together',async()=>{
  reset();const before=structuredClone(state.preferences);state.failAudit=true;
  const response=await schoolRoute.POST(request('/api/schools',await reviewed()));assert.equal(response.status,500);assert.equal(state.targets.length,0);assert.deepEqual(state.preferences,before);
});
