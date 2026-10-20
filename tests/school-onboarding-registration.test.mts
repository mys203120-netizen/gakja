import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync,mkdtempSync,writeFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {schoolDirectory} from '../apps/web/src/lib/school-directory.ts';
import {overlayOfficialCalendar} from '../apps/web/src/lib/official-admission-calendar.ts';
const base=JSON.parse(readFileSync('apps/web/src/data/school-interview-calendar.json','utf8'));
const official=JSON.parse(readFileSync('apps/web/src/data/school-interview-official.json','utf8'));
const school=schoolDirectory.find(item=>item.canonicalName==='서울시립대학교')!,department=school.departments.find(item=>item.name==='환경공학부')!;
const state={snapshot:{catalogue:overlayOfficialCalendar(base,official),official,officialSchools:8,stale:false,lastRefreshFailed:false,refreshDue:false},targets:[] as any[],preferences:new Map(),audits:[] as any[],queries:[] as any[],user:{id:'fixture-student',role:'student'},writeCount:0};
(globalThis as any).__onboardingTest=state;
const modules:Record<string,string>={
  'server-only':'module.exports={};',
  '@/lib/db':`exports.ApiError=class ApiError extends Error{constructor(status,message){super(message);this.status=status;}};
    async function run(sql,args){const s=globalThis.__onboardingTest;s.queries.push({sql,args});
      if(sql.includes('school_reference_catalog'))return ${JSON.stringify(schoolDirectory.map(row=>({id:row.id,university:row.university,revision:1,status:'historical_reference',data:{},source:{}})))}.filter(row=>row.id===args[0]);
      if(sql.startsWith('select')&&sql.includes('support_targets'))return s.targets.filter(row=>row.student_id===args[0]&&(!args[1]||String(row.data.admission_year)===args[1]));
      if(sql.startsWith('insert into support_targets')){s.writeCount++;const row={id:args[0],student_id:args[1],data:JSON.parse(args[2])};s.targets.push(row);return [{id:row.id,data:structuredClone(row.data)}];}
      if(sql.startsWith('update support_targets')){s.writeCount++;const row=s.targets.find(row=>row.id===args[1]&&row.student_id===args[2]);if(!row)return [];row.data=sql.includes('data=data ||')?{...row.data,...JSON.parse(args[0])}:JSON.parse(args[0]);return [{id:row.id,data:structuredClone(row.data)}];}
      if(sql.includes('insert into student_preferences')){s.preferences.set(args[0],JSON.parse(args[1]));return [];}
      if(sql.includes('insert into audit_logs')){s.audits.push({sql,args});return [];}
      return [];
    }
    exports.query=run;exports.transaction=async fn=>{const s=globalThis.__onboardingTest,backup=structuredClone(s.targets);try{return await fn({query:async(sql,args)=>({rows:await run(sql,args)})});}catch(error){s.targets=backup;throw error;}};`,
  '@/lib/auth':`exports.checkOrigin=request=>{if(request.headers.get('origin')!=='http://fixture.test')throw new Error('unauthorized');};exports.requireUser=async()=>{const user=globalThis.__onboardingTest.user;if(!user)throw new Error('unauthenticated');return user;};`,
  '@/lib/ai':`exports.requireStudent=user=>{if(user.role!=='student'){const e=new Error('Student only');e.status=403;throw e;}};exports.featureError=e=>({status:e.status||(/unauth/.test(e.message)?401:e.name==='ZodError'?400:500),error:e.message,code:'TEST'});`,
  'next/server':`exports.after=fn=>{};`,
  'calendar-store-stub':`exports.readAdmissionCalendar=async()=>globalThis.__onboardingTest.snapshot;exports.refreshAdmissionCalendar=async()=>({refreshed:false});`,
};
const folder=mkdtempSync(join(tmpdir(),'school-onboarding-')),keys=Object.keys(modules),files=keys.map((key,index)=>{const path=join(folder,index+'.cjs');writeFileSync(path,modules[key]);return path;});
registerHooks({resolve(specifier,context,next){
  const key=specifier.includes('admission-calendar-store')?'calendar-store-stub':specifier;
  if(modules[key])return {url:pathToFileURL(files[keys.indexOf(key)]).href,shortCircuit:true};
  if(specifier.startsWith('@/'))return {url:pathToFileURL(resolve('apps/web/src',specifier.slice(2)+'.ts')).href,shortCircuit:true};return next(specifier,context);
}});
after(()=>{files.forEach(unlinkSync);rmdirSync(folder);delete (globalThis as any).__onboardingTest;});
const {registerStudentSchool}=await import('../apps/web/src/lib/school-learning.ts');
const {previewSchoolAdmissionCalendar}=await import('../apps/web/src/lib/school-onboarding-calendar.ts');
const {POST:previewRoute}=await import('../apps/web/src/app/api/schools/onboarding-calendar/route.ts');
const input={referenceId:school.id,departmentId:department.id,admissionYear:2027,track:'학생부종합전형Ⅰ(면접형)',onboarding:true};
const target={university:school.university,school_reference_id:school.id,campus:'본교',department:department.name,admission_type:input.track,admission_year:2027};
const reviewed=async()=>({...input,calendarReview:{fingerprint:(await previewSchoolAdmissionCalendar(target)).fingerprint,acknowledged:true}});
function reset(){state.targets=[];state.preferences.clear();state.audits=[];state.queries=[];state.writeCount=0;state.user={id:'fixture-student',role:'student'};}
test('the public preview route rejects absent users and administrators',async()=>{
  for(const user of [null,{id:'fixture-admin',role:'admin'}]){(state as any).user=user;const result=await previewRoute(new Request('http://fixture.test/api/schools/onboarding-calendar',{method:'POST',headers:{origin:'http://fixture.test'},body:JSON.stringify(input)}));assert.equal(result.status,user?403:401);}reset();
});
test('the preview route resolves an owned university department without accepting supplied student IDs',async()=>{
  reset();const result=await previewRoute(new Request('http://fixture.test/api/schools/onboarding-calendar',{method:'POST',headers:{origin:'http://fixture.test'},body:JSON.stringify({...input,studentId:'foreign-student',personal_at:'2026-11-29T10:00'})}));
  assert.equal(result.status,200);assert.match(result.headers.get('cache-control')!,/no-store/);const {calendar}=await result.json();assert.equal(calendar.matched[0].startDate,'2026-11-29');assert.equal(state.writeCount,0);assert.equal(calendar.personal_at,undefined);assert.equal(calendar.sourceUrl,'');assert.equal(calendar.matched[0].sourceUrl,'');assert.equal(calendar.matched[0].sourceLabel,'');assert.doesNotMatch(JSON.stringify(calendar),/아컨|acon\.io\.kr/i);
});
test('UNIST POSTECH Seoul Education and SeoulTech register known interviews as unconfirmed department references',async()=>{
 for(const name of ['울산과학기술원','포항공과대학교','서울교육대학교','서울과학기술대학교']){
  reset();const selected=schoolDirectory.find(row=>row.canonicalName===name)!,major=selected.departments.find(row=>/새내기학부\(경영계열\)|단일계열|초등교육학과|MSDE학과/.test(row.name))||selected.departments[0];
  const target={university:selected.university,school_reference_id:selected.id,admission_year:2027,campus:selected.campusLabel||major.campus,department:major.name,admission_type:'미정'};
  const initial=await previewSchoolAdmissionCalendar(target);assert.ok(initial.tracks.length,`${name} has a usable known interview`);
  const track=initial.tracks[0],calendar=await previewSchoolAdmissionCalendar({...target,admission_type:track});
  assert.equal(calendar.canReview,true);assert.equal(calendar.status,'school_reference');assert.equal(calendar.registrationScope,'school_reference');assert.equal(calendar.matched.length,0);
  const result=await registerStudentSchool(state.user.id,{referenceId:selected.id,departmentId:major.id,admissionYear:2027,track,onboarding:true,calendarReview:{fingerprint:calendar.fingerprint,acknowledged:true}});
  assert.equal(result.university,selected.university);assert.equal(result.department,major.name);assert.equal(result.information_status,'needs_confirmation');
  assert.equal(result.admission_calendar_registration.status,'school_reference');assert.equal(result.admission_calendar_registration.department_scope_confirmed,false);assert.deepEqual(result.admission_calendar_registration.matched_entry_ids,[]);
  assert.equal(result.interview_date,undefined);assert.equal(result.school_interview_date,undefined);assert.equal(state.targets.length,1);
 }reset();
});
test('first registration cannot skip the calendar review using a missing onboarding flag',async()=>{
  reset();await assert.rejects(registerStudentSchool(state.user.id,{...input,onboarding:undefined}),(error:any)=>error.status===400);assert.equal(state.writeCount,0);assert.equal(state.preferences.size,0);
});
test('an additional registration cannot bypass known-track validation by omitting onboarding and review',async()=>{
  reset();state.targets.push({id:'existing',student_id:state.user.id,data:{...target}});
  await assert.rejects(registerStudentSchool(state.user.id,{...input,onboarding:undefined,track:'임의로 입력한 전형'}),(error:any)=>error.status===409);
  assert.equal(state.targets.length,1);assert.equal(state.writeCount,0);
});
test('changed identity or changed published dates invalidates final confirmation before writes',async()=>{
  reset();const approved=await reviewed();await assert.rejects(registerStudentSchool(state.user.id,{...approved,track:'다른 전형'}),(error:any)=>error.status===409);assert.equal(state.writeCount,0);
  const entry=state.snapshot.catalogue.schools.find((row:any)=>row.schoolReferenceId===school.id)!.entries.find((row:any)=>row.departments.includes(department.name)&&row.trackLabel.includes('면접형'))!;
  const old=entry.segments;entry.segments=[{startDate:'2026-11-30',endDate:'2026-11-30'}];await assert.rejects(registerStudentSchool(state.user.id,approved),(error:any)=>error.status===409);entry.segments=old;assert.equal(state.writeCount,0);
});
test('final confirmation commits target, public dates and preferences without fabricated appointment',async()=>{
  reset();const result=await registerStudentSchool(state.user.id,await reviewed());assert.equal(state.targets.length,1);assert.equal(result.admission_calendar_registration.status,'registered');assert.equal(result.admission_calendar_registration.calendar_year,2026);assert.equal(result.admission_calendar_registration.personal_appointment_confirmed,false);assert.equal(result.interview_date,undefined);assert.equal(result.school_interview_date,'2026-11-29');assert.equal(state.preferences.get(state.user.id).schoolCalendarOnboardingCompleted,true);assert.deepEqual(result.admission_calendar_registration.source_urls,[]);
});
test('repeated confirmation reuses the same target and does not double its registration audit',async()=>{
  reset();const approved=await reviewed(),first=await registerStudentSchool(state.user.id,approved),count=state.audits.length,second=await registerStudentSchool(state.user.id,approved);assert.equal(first.id,second.id);assert.equal(state.targets.length,1);assert.equal(state.audits.length,count);
});
test('a canonically equal imported target is retained without modifying its history or old personal schedule',async()=>{
  reset();state.targets.push({id:'fixture-imported',student_id:state.user.id,data:{...target,major:target.department,registration_source:'approved_import',admission_type:'학생부종합전형I (면접형)',interview_date:'2026-11-29T14:20:00+09:00',historyKey:'keep-me'}});
  const result=await registerStudentSchool(state.user.id,await reviewed());assert.equal(result.id,'fixture-imported');assert.equal(state.targets.length,1);assert.equal(result.historyKey,'keep-me');assert.equal(result.interview_date,'2026-11-29T14:20:00+09:00');
});
test('a foreign student identical target is never adopted',async()=>{
  reset();state.targets.push({id:'foreign-target',student_id:'foreign-student',data:{...target,major:target.department}});const result=await registerStudentSchool(state.user.id,await reviewed());assert.notEqual(result.id,'foreign-target');assert.equal(state.targets.length,2);assert.ok(state.queries.filter(row=>row.sql.startsWith('update support_targets')).every(row=>row.args[2]===state.user.id));
});
