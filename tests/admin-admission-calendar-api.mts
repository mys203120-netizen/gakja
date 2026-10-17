// Local HTTP / PostgreSQL integration. Uses isolated accounts and admin-created QA rows only.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';
import {loadProjectEnv,projectRoot,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import {schoolDirectory} from '../apps/web/src/lib/school-directory';
import {buildCalendarAdminRows} from '../apps/web/src/lib/admin-admission-calendar-model';
import {overlayOfficialCalendar} from '../apps/web/src/lib/official-admission-calendar';
import {isReferenceCalendarUrl} from '../apps/web/src/lib/calendar-source-presentation';

loadProjectEnv();
const base=process.env.TEST_BASE_URL||process.env.SMOKE_BASE_URL||JSON.parse(readFileSync(join(projectRoot,'.local/server.json'),'utf8')).url;
let local=false;
try{const server=new URL(base),database=new URL(process.env.DATABASE_URL!);local=server.protocol==='http:'&&!server.username&&!server.password&&['localhost','127.0.0.1'].includes(server.hostname)&&['postgres:','postgresql:'].includes(database.protocol)&&['localhost','127.0.0.1'].includes(database.hostname);}catch{}
if(process.env.AUTH_MODE!=='local'||!local)throw Error('Admin calendar checks use local authentication, HTTP and PostgreSQL fixtures only.');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
const runId=randomUUID(),owners:Record<string,string>={},tokens:Record<string,string>={},fixtureIds:string[]=[],targetIds:string[]=[],rowIds:string[]=[];
const endpoint='/api/admin/admission-calendar';
const bundled=JSON.parse(readFileSync(join(projectRoot,'apps/web/src/data/school-interview-calendar.json'),'utf8'));
const official=JSON.parse(readFileSync(join(projectRoot,'apps/web/src/data/school-interview-official.json'),'utf8'));
const expectedSourceRows=buildCalendarAdminRows(overlayOfficialCalendar(bundled,official),official);
const school=schoolDirectory.find(school=>school.canonicalName==='감리교신학대학교')!;
assert.ok(school&&school.departments.length,'Actual registered university and public department fixture');
const department=school.departments[0],track=`격리 검증 면접 ${runId}`;
const observations:any[]=[];
let checks=0,failed:string|null=null,cleaned=false,publicSnapshotsBefore:any[]=[],studentTargetsBefore:any[]=[],sourceRowCount=0;
function check(value:unknown,label:string):asserts value{assert.ok(value,label);checks++;}
async function request(actor:string,path=endpoint,body?:unknown,origin=base){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(tokens[actor]?{Cookie:'gakja_session='+tokens[actor]}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120_000)});
  let data:any;try{data=await response.json();}catch{throw Error(`Non-JSON calendar response (${response.status})`);}
  return {status:response.status,body:data,headers:response.headers};
}
const get=(actor='admin')=>request(actor);
const action=(actor:string,name:string,id?:string,expectedRevision?:number,data?:unknown,extra:Record<string,unknown>={})=>request(actor,endpoint,{action:name,...(id?{id}:{}),...(expectedRevision!==undefined?{expectedRevision}:name==='create'?{expectedRevision:0}:{}),...(data!==undefined?{data}:{}),...extra});
const personalAction=(actor:string,name:string,targetId:string,expectedRevision?:number,schedule?:unknown,extra:Record<string,unknown>={})=>request(actor,endpoint,{action:name,targetId,...(expectedRevision!==undefined?{expectedRevision}:{}),...(schedule!==undefined?{schedule}:{}),...extra});
const planner=(actor='student',targetId=targetIds[0])=>request(actor,'/api/planner?targetId='+encodeURIComponent(targetId));
const ok=(response:any)=>response.status===200||response.status===201;
function rowFrom(response:any,label:string){check(ok(response)&&response.body.row&&typeof response.body.row.id==='string',label);return response.body.row;}
const qaData=(override:Record<string,unknown>={})=>({schoolReferenceId:school.id,admissionYear:2027,trackLabel:track,departments:[department.name],campus:null,status:'dated',dates:['2026-11-14','2026-11-16'],format:'in_person',sourceUrl:'',note:'관리자 면접 일정 격리 검증',...override});
const calendarRowPrefix=(id:string)=>`admin:${id}:`;
function noSecrets(value:unknown,label:string){const text=JSON.stringify(value);check(!/"(?:password_hash|password|token|session_id|access_token|refresh_token|authorization)"\s*:/i.test(text),label);}
function registrationFrom(body:any,id:string){const registration=body.registrations?.find((row:any)=>row.id===id||row.targetId===id);check(!!registration,'admin sees owned fixture registration');return registration;}
function registrationRevision(registration:any){return Number(registration.personalRevision??0);}

await db.connect();
try{
  check(Boolean((await db.query("select to_regclass('admission_calendar_admin_edits') as edits,to_regclass('admission_calendar_admin_events') as events")).rows[0]?.edits),'admin calendar migration applied');
  publicSnapshotsBefore=(await db.query('select id,source_key,content_hash,data from admission_calendar_versions order by id')).rows;
  studentTargetsBefore=(await db.query('select id,student_id,data from support_targets order by id')).rows;
  for(const [actor,role] of [['student','student'],['other','student'],['staff','staff'],['admin','admin']]){
    const id=randomUUID(),token=randomUUID();owners[actor]=id;tokens[actor]=token;
    await db.query('insert into profiles(id,email,name,role) values($1,$2,$3,$4)',[id,`admin-calendar-${actor}-${runId}@gakja.test`,`면접 일정 검증 ${actor}`,role]);fixtureIds.push(id);
    await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '1 hour')",[createHash('sha256').update(token).digest('hex'),id]);
  }
  for(const actor of ['student','other']){
    const id='admin-calendar-'+randomUUID();targetIds.push(id);
    const data={id,school_reference_id:school.id,university:school.university,admission_year:2027,campus:'본교',department:department.name,major:department.name,department_catalog_id:department.id,admission_type:track,preparation_note:'일정 외 정보 보존 검증',custom_context:{untouched:true},schedule:{personal_date:'2026-11-14',personal_at:'2026-11-14T10:00:00+09:00',location:'원래 개인 면접실',status:'awaiting',revision:0}};
    await db.query('insert into support_targets(id,student_id,data) values($1,$2,$3)',[id,owners[actor],JSON.stringify(data)]);
  }
  check((await get('anonymous')).status===401,'anonymous admin read denied');
  check((await action('anonymous','create',undefined,undefined,qaData())).status===401,'anonymous admin mutation denied');
  for(const actor of ['student','other','staff']){
    check((await get(actor)).status===403,`${actor} admin read denied`);
    check((await action(actor,'create',undefined,undefined,qaData(),{studentId:owners.admin})).status===403,`${actor} cannot forge admin identity to create public schedule`);
  }
  const before=await get();
  check(before.status===200&&Array.isArray(before.body.rows)&&Array.isArray(before.body.registrations)&&Array.isArray(before.body.schools),'admin catalogue includes shared dates, actual applicant registrations and school summary');
  check(before.headers.get('cache-control')?.includes('private')&&before.headers.get('cache-control')?.includes('no-store'),'admin applicant data has private, non-cacheable response');
  check(before.body.schools.length===88&&new Set(before.body.schools.map((row:any)=>row.id||row.schoolReferenceId)).size===88,'all 88 registered schools appear in admin selection / overview');
  sourceRowCount=before.body.rows.filter((row:any)=>row.origin!=='admin').length;
  check(sourceRowCount===expectedSourceRows.length&&expectedSourceRows.every(source=>before.body.rows.some((row:any)=>row.id===source.id)),'all imported logical date records, official non-dated decisions and unresolved interview rows appear');
  check(before.body.rows.every((row:any)=>row.schoolReferenceId&&row.admissionYear===2027),'published source rows retain their registered school and actual admission year');
  check(before.body.rows.every((row:any)=>!isReferenceCalendarUrl(row.sourceUrl)&&!/아컨|acon\.io\.kr/i.test(String(row.sourceLabel||'')+' '+String(row.note||'')+' '+String(row.rawDate||''))),'admin schedule response has no reference publisher attribution, notes or outbound links');
  const registered=registrationFrom(before.body,targetIds[0]),otherRegistration=registrationFrom(before.body,targetIds[1]);
  check(JSON.stringify(registered).includes(owners.student)&&JSON.stringify(registered).includes(`admin-calendar-student-${runId}@gakja.test`)&&JSON.stringify(registered).includes('면접 일정 검증 student'),'admin sees account ID, display name and email for school registration');
  check(JSON.stringify(registered).includes(school.id)&&JSON.stringify(registered).includes(department.name)&&JSON.stringify(registered).includes(track),'registration has school, actual major and selected admission track');
  check(JSON.stringify(otherRegistration).includes(owners.other),'separate account registering same school is independently visible');
  const dbRegistrationCount=Number((await db.query("select count(*)::int n from support_targets t join profiles p on p.id=t.student_id where p.role='student'")).rows[0].n);
  check(before.body.registrations.length===dbRegistrationCount,'admin account list includes every existing student school registration');
  check(before.body.schools.every((school:any)=>school.registrationCount===before.body.registrations.filter((registration:any)=>registration.schoolReferenceId===school.id).length),'each school count matches actual registered accounts');
  noSecrets(before.body,'admin DTO does not disclose passwords, tokens or session identifiers');

  check((await request('admin',endpoint,{action:'create',data:qaData()},'https://other-origin.test')).status===403,'cross-origin mutation rejected');
  for(const dates of [['2026-02-29'],['2026-11-31'],['2026-13-01'],['2026-11-14T09:00:00Z'],['2016-11-14'],['2027-11-14']])check((await action('admin','create',undefined,undefined,qaData({dates}))).status===400,`invalid or out-of-season dates ${dates[0]} rejected`);
  for(const override of [{schoolReferenceId:'non-catalogue-school'},{admissionYear:2028},{trackLabel:'  '},{status:'unknown'},{status:'no_interview'},{dates:[]},{sourceUrl:'javascript:alert(1)'},{sourceUrl:'https://user:secret@example.test/source'},{format:'remote_guessed'}])check((await action('admin','create',undefined,undefined,qaData(override))).status===400,'invalid school, year, label, status/date agreement, source URL or format rejected');
  const created=rowFrom(await action('admin','create',undefined,undefined,qaData(),{studentId:owners.other}),'admin creates school interview schedule');
  rowIds.push(created.id);
  check(created.id.startsWith('admin_')&&created.revision===1&&!created.deleted,'new manual shared schedule starts at revision one');
  const stored=(await db.query('select data,revision,created_by,updated_by,deleted from admission_calendar_admin_edits where id=$1',[created.id])).rows[0];
  check(stored.created_by===owners.admin&&stored.updated_by===owners.admin&&stored.revision===1&&!stored.deleted,'calendar edit actor comes from authenticated admin, ignoring forged studentId');
  check(stored.data.trackLabel===track&&stored.data.dates.join(',')==='2026-11-14,2026-11-16','manual scoped dates persist in PostgreSQL');
  noSecrets(created,'created shared schedule DTO is safe');
  const firstPlanner=await planner();
  check(firstPlanner.status===200&&firstPlanner.body.interviewSchedules.filter((row:any)=>row.id.startsWith(calendarRowPrefix(created.id))).length===2,'two separated admin dates immediately appear in the applicant calendar');
  check(firstPlanner.body.interviewSchedules.every((row:any)=>row.startDate!=='2026-11-15'&&row.endDate!=='2026-11-15'),'a gap day between separate admin dates is never fabricated');
  check(firstPlanner.body.interviewSchedules.filter((row:any)=>row.id.startsWith(calendarRowPrefix(created.id))).every((row:any)=>row.targetId===targetIds[0]&&row.applicability==='track_match'),'admin dates retain exact own-target scope');
  check((await planner('student',targetIds[1])).status===404,'student cannot use another applicant target ID');
  const spoofed=await request('student','/api/planner?studentId='+owners.other);
  check(spoofed.status===200&&spoofed.body.interviewSchedules.every((row:any)=>row.targetId===targetIds[0]),'studentId query cannot change student calendar ownership');
  check((await action('student','update',created.id,created.revision,qaData({dates:['2026-11-18']}))).status===403,'student cannot modify an admin-created shared row');
  check((await action('staff','delete',created.id,created.revision)).status===403,'staff cannot delete an admin-created shared row');
  check((await action('admin','update',created.id,0,qaData())).status===409,'stale source revision cannot overwrite manual row');
  check((await action('admin','update',created.id,undefined,qaData())).status===400,'update requires expected revision');
  check((await action('admin','update','admin_'+randomUUID(),0,qaData())).status===404,'unknown row is not silently recreated');
  check((await action('admin','update',created.id,created.revision,qaData({dates:['2026-11-31']}))).status===400,'invalid update cannot corrupt existing schedule');
  let current=rowFrom(await action('admin','update',created.id,created.revision,qaData({dates:['2026-11-18'],note:'수정한 면접 일정'})),'admin edits existing manual row');
  check(current.revision===2&&current.dates.join(',')==='2026-11-18'&&current.note==='수정한 면접 일정','edit increments revision and replaces date / note');
  check((await action('admin','update',created.id,1,qaData({dates:['2026-11-19']}))).status===409,'stale concurrent editor receives conflict');
  const updatedPlanner=await planner();
  check(updatedPlanner.body.interviewSchedules.some((row:any)=>row.id.startsWith(calendarRowPrefix(created.id))&&row.startDate==='2026-11-18')&&!updatedPlanner.body.interviewSchedules.some((row:any)=>row.id.startsWith(calendarRowPrefix(created.id))&&['2026-11-14','2026-11-16'].includes(row.startDate)),'calendar reflects updated shared row and removes old dates');
  const idempotent=rowFrom(await action('admin','update',current.id,current.revision,qaData({dates:['2026-11-18'],note:'수정한 면접 일정'})),'same current values can be saved again');
  check(idempotent.revision===current.revision,'idempotent update does not create misleading extra revision');
  current=idempotent;
  for(const status of ['no_interview','date_pending','unpublished']){
    current=rowFrom(await action('admin','update',current.id,current.revision,qaData({status,dates:[],note:status+' 격리 검증'})),`admin sets distinct ${status} decision`);
    const response=await planner();
    check(response.body.interviewSchedules.length===0&&response.body.interviewScheduleCoverage.targets[0].status===status,`${status} target cannot borrow another track's source dates`);
    check(current.status===status&&current.dates.length===0,'distinct non-dated decision persists without fabricated date');
    observations.push({case:'scoped non-dated status',status,calendarDates:response.body.interviewSchedules.length});
  }
  current=rowFrom(await action('admin','update',current.id,current.revision,qaData({dates:['2026-11-18']})),'admin restores a dated interview after pending status');
  const deleteResult=rowFrom(await action('admin','delete',current.id,current.revision),'admin soft-deletes shared interview schedule');
  check(deleteResult.deleted&&deleteResult.revision===current.revision+1,'deletion marks row deleted at new revision');
  check((await get()).body.rows.some((row:any)=>row.id===current.id&&row.deleted),'deleted shared row remains in administrator history / recovery list');
  const deletedPlanner=await planner();
  check(!deletedPlanner.body.interviewSchedules.some((row:any)=>row.id.startsWith(calendarRowPrefix(current.id))),'deleted date disappears from student calendar');
  check((await db.query('select deleted from admission_calendar_admin_edits where id=$1',[current.id])).rows[0].deleted,'soft delete persists separately from immutable source snapshot');
  check((await action('admin','restore',current.id,current.revision)).status===409,'stale restore does not silently overwrite deletion');
  const repeatedDelete=rowFrom(await action('admin','delete',current.id,deleteResult.revision),'deleting current already-deleted row is safe');
  check(repeatedDelete.revision===deleteResult.revision&&repeatedDelete.deleted,'repeated deletion with current revision is idempotent');
  current=rowFrom(await action('admin','restore',current.id,repeatedDelete.revision),'admin restores soft-deleted interview schedule');
  check(!current.deleted&&current.revision===repeatedDelete.revision+1,'restore reactivates row at next revision');
  check((await planner()).body.interviewSchedules.some((row:any)=>row.id.startsWith(calendarRowPrefix(current.id))&&row.startDate==='2026-11-18'),'restored date reappears in target calendar');
  const repeatedRestore=rowFrom(await action('admin','restore',current.id,current.revision),'restoring active row is safe');
  check(repeatedRestore.revision===current.revision,'repeated restore is idempotent');
  current=repeatedRestore;
  const racing=await Promise.all([action('admin','update',current.id,current.revision,qaData({dates:['2026-11-20'],note:'동시 수정 A'})),action('admin','update',current.id,current.revision,qaData({dates:['2026-11-21'],note:'동시 수정 B'}))]);
  check(racing.map(result=>result.status).sort().join(',')==='200,409','only one writer wins simultaneous edit with same expected revision');
  current=racing.find(response=>response.status===200)!.body.row;

  const targetBefore=(await db.query('select data from support_targets where id=$1',[targetIds[0]])).rows[0].data;
  const registrationBefore=registrationFrom((await get()).body,targetIds[0]),revision=registrationRevision(registrationBefore);
  check((await personalAction('student','personal_update',targetIds[1],revision,{personal_date:'2026-11-22'})).status===403,'student cannot use administrator personal schedule editor');
  check((await personalAction('staff','personal_delete',targetIds[0],revision)).status===403,'staff cannot remove personal schedule through administrator endpoint');
  check((await personalAction('admin','personal_update',targetIds[0],undefined,{personal_date:'2026-11-22'})).status===400,'personal update requires revision');
  check((await personalAction('admin','personal_update',targetIds[0],revision,{personal_date:'2026-11-31'})).status===400,'nonexistent personal date is rejected');
  check((await personalAction('admin','personal_update',targetIds[0],revision,{personal_date:'2026-11-22',personal_at:'2026-11-23T10:00:00+09:00'})).status===400,'personal date and time must be same actual day');
  check((await personalAction('admin','personal_update',targetIds[0],revision,{personal_date:'2016-11-22'})).status===400,'personal date must match supported admission season');
  const personal=await personalAction('admin','personal_update',targetIds[0],revision,{personal_date:'2026-11-22',personal_at:'2026-11-22T14:40:00+09:00',location:'관리자 지정 면접실',status:'awaiting',university:'위조 대학',department:'위조 학과'},{studentId:owners.other});
  check(personal.status===200&&personal.body.registration,'admin edits applicant allocated interview appointment');
  const targetAfter=(await db.query('select data,student_id from support_targets where id=$1',[targetIds[0]])).rows[0];
  check(targetAfter.student_id===owners.student&&targetAfter.data.university===targetBefore.university&&targetAfter.data.department===targetBefore.department&&JSON.stringify(targetAfter.data.custom_context)===JSON.stringify(targetBefore.custom_context)&&targetAfter.data.preparation_note===targetBefore.preparation_note,'personal edit preserves account ownership, university, department and unrelated preparation data');
  check(targetAfter.data.schedule.personal_date==='2026-11-22'&&targetAfter.data.schedule.personal_at.startsWith('2026-11-22T14:40:00')&&targetAfter.data.schedule.location==='관리자 지정 면접실','allocated personal date, KST time and location persist');
  check(registrationRevision(personal.body.registration)===revision+1,'personal edit uses independently versioned appointment');
  check((await personalAction('admin','personal_update',targetIds[0],revision,{personal_date:'2026-11-23'})).status===409,'stale personal editor receives conflict');
  const unaffected=(await db.query('select data from support_targets where id=$1',[targetIds[1]])).rows[0].data;
  check(unaffected.schedule.personal_date==='2026-11-14'&&unaffected.schedule.location==='원래 개인 면접실','editing one applicant never edits another account at the same school');
  const personalDelete=await personalAction('admin','personal_delete',targetIds[0],registrationRevision(personal.body.registration));
  check(personalDelete.status===200&&personalDelete.body.registration,'admin removes allocated appointment');
  const kept=(await db.query('select data from support_targets where id=$1',[targetIds[0]])).rows[0]?.data;
  check(!!kept&&kept.university===targetBefore.university&&kept.department===targetBefore.department&&kept.custom_context.untouched,'deleting personal appointment preserves applicant school registration and other data');
  check(!kept.schedule.personal_date&&!kept.schedule.personal_at&&!kept.schedule.location,'personal deletion clears appointment date / time / location');
  check(registrationFrom((await get()).body,targetIds[0]).studentId===owners.student||JSON.stringify(registrationFrom((await get()).body,targetIds[0])).includes(owners.student),'registered account remains visible after personal appointment deletion');
  noSecrets(personalDelete.body,'personal editor response never includes authentication secrets');

  // The imported no-interview wildcard must not override a newer explicit admin decision.
  const noInterviewSchool=schoolDirectory.find(school=>school.canonicalName==='공주교육대학교')!,noInterviewDepartment=noInterviewSchool.departments.find(department=>department.name==='초등교육과')!;
  const priorityTargetId='admin-calendar-'+randomUUID(),priorityTrack=`관리자 우선순위 검증 ${runId}`;
  targetIds.push(priorityTargetId);
  await db.query('insert into support_targets(id,student_id,data) values($1,$2,$3)',[priorityTargetId,owners.student,JSON.stringify({id:priorityTargetId,school_reference_id:noInterviewSchool.id,university:noInterviewSchool.university,admission_year:2027,campus:'본교',department:noInterviewDepartment.name,major:noInterviewDepartment.name,department_catalog_id:noInterviewDepartment.id,admission_type:priorityTrack})]);
  const noInterviewBaseline=await planner('student',priorityTargetId);
  check(noInterviewBaseline.body.interviewSchedules.length===0&&noInterviewBaseline.body.interviewScheduleCoverage.targets[0].status==='no_interview','fixture school begins with official broad no-interview evidence');
  const priorityData=qaData({schoolReferenceId:noInterviewSchool.id,departments:[noInterviewDepartment.name],trackLabel:priorityTrack,dates:['2026-11-22'],note:'공식 일반 상태보다 최신 관리자 전형 설정 우선 검증'});
  let priorityDate=rowFrom(await action('admin','create',undefined,undefined,priorityData),'administrator can register exact dated override at school with broad imported no-interview status');
  rowIds.push(priorityDate.id);
  check((await planner('student',priorityTargetId)).body.interviewSchedules.some((row:any)=>row.id.startsWith(calendarRowPrefix(priorityDate.id))&&row.startDate==='2026-11-22'),'exact admin dated setting takes precedence over older official broad no-interview decision');
  const priorityPending=rowFrom(await action('admin','create',undefined,undefined,{...priorityData,status:'date_pending',dates:[],note:'최신 관리자 일정 미정 설정'}),'administrator sets a newer explicit non-dated status');
  rowIds.push(priorityPending.id);
  const latestPending=await planner('student',priorityTargetId);
  check(latestPending.body.interviewSchedules.length===0&&latestPending.body.interviewScheduleCoverage.targets[0].status==='date_pending','newer admin pending decision suppresses older matching admin dated schedule');
  priorityDate=rowFrom(await action('admin','update',priorityDate.id,priorityDate.revision,{...priorityData,dates:['2026-11-23'],note:'재확정한 관리자 일정'}),'administrator reconfirms a date after pending status');
  const latestDated=await planner('student',priorityTargetId);
  check(latestDated.body.interviewSchedules.some((row:any)=>row.id.startsWith(calendarRowPrefix(priorityDate.id))&&row.startDate==='2026-11-23')&&latestDated.body.interviewScheduleCoverage.targets[0].status==='available','newest exact admin dated setting replaces earlier matching pending decision');
  observations.push({case:'latest scoped admin authority over older source / admin states',officialWildcardNoInterview:true,newDatedWins:true,laterPendingWins:true,reconfirmedDatedWins:true});

  const final=await get();
  check(final.body.rows.filter((row:any)=>row.origin!=='admin').length===sourceRowCount,'admin-created edits do not duplicate or remove unrelated source catalogue rows');
  const events=(await db.query('select row_id,revision,action,actor_id,data from admission_calendar_admin_events where actor_id=any($1::uuid[]) order by created_at,id',[fixtureIds])).rows;
  check(events.length>0&&events.every(event=>event.actor_id===owners.admin),'mutations have admin-only audit events');
  check(events.some(event=>event.action==='create')&&events.some(event=>event.action==='delete')&&events.some(event=>event.action==='restore'),'public schedule creation, deletion and restoration are auditable');
  check((await db.query('select count(*)::int n from usage_records where student_id=any($1::uuid[])',[fixtureIds])).rows[0].n===0,'administrator schedule management uses no paid AI calls');
  for(const original of publicSnapshotsBefore){const saved=(await db.query('select content_hash,data from admission_calendar_versions where id=$1',[original.id])).rows[0];check(saved?.content_hash===original.content_hash&&JSON.stringify(saved.data)===JSON.stringify(original.data),'immutable public source version remains intact');}
  const originalAfter=(await db.query('select id,student_id,data from support_targets where id=any($1::text[]) order by id',[studentTargetsBefore.map(row=>row.id)])).rows;
  check(JSON.stringify(originalAfter)===JSON.stringify(studentTargetsBefore),'all pre-existing student targets and personal appointments remain unchanged');
  observations.push({case:'manual shared schedule CRUD',sourceRows:sourceRowCount,separatedDates:true,deletedVisibleToAdmin:true,studentCalendarUpdated:true,auditEvents:events.length});
}catch(error){failed=redactEnvironmentSecrets(error instanceof Error?error.message:String(error));process.exitCode=1;}
finally{
  try{
    await db.query('begin');
    await db.query('delete from admission_calendar_admin_events where actor_id=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from admission_calendar_admin_edits where created_by=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from audit_logs where actor_id=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from support_targets where student_id=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from sessions where user_id=any($1::uuid[])',[fixtureIds]);
    await db.query('delete from profiles where id=any($1::uuid[])',[fixtureIds]);
    await db.query('commit');
    cleaned=(await db.query('select count(*)::int n from profiles where id=any($1::uuid[])',[fixtureIds])).rows[0].n===0;
    check(cleaned,'all owned synthetic profiles, registrations, sessions, overrides and audit events cleaned');
  }catch(error){await db.query('rollback');failed=[failed,'Fixture cleanup: '+redactEnvironmentSecrets(error instanceof Error?error.message:String(error))].filter(Boolean).join('; ');process.exitCode=1;}
  await db.end();
  const evidence={status:failed?'failed':'passed',checkedAt:new Date().toISOString(),checks,sourceRowCount,fixturesCreated:fixtureIds.length,fixturesCleaned:cleaned,ownedAdminRowsCreated:rowIds.length,originalStudentRecordsChanged:0,publicSnapshotsChanged:false,paidAiCalls:0,observations,error:failed};
  writeFileSync(join(projectRoot,'.local/admin-admission-calendar-api-check.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(failed?`Admin admission calendar integration failed: ${failed}`:`Admin admission calendar API checks passed: ${checks}; ${fixtureIds.length} synthetic fixtures cleaned; no paid AI calls.`);
}
