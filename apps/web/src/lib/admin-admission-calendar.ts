import 'server-only';
import {randomUUID} from 'node:crypto';
import type {Profile} from './auth';
import {ApiError,query,transaction} from './db';
import {readAdmissionCalendar} from './admission-calendar-store';
import {buildCalendarAdminRows,validateCalendarAdminData,type CalendarAdminRow} from './admin-admission-calendar-model';
import {schoolDirectory,schoolDirectoryForTarget} from './school-directory';
import {normalizeSchedule,personalDate,validateKSTDateTime} from './schedule';
import {presentCalendarSource,visibleCalendarSourceUrl,visibleCalendarSourceText,retainCalendarSourceFields} from './calendar-source-presentation';

const assertAdmin=(user:Profile)=>{if(user.role!=='admin')throw new ApiError(403,'관리자만 면접 일정을 관리할 수 있어요.');};
const object=(value:unknown)=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError(400,'요청 형식을 확인해 주세요.');return value as Record<string,any>;};
const revision=(value:unknown)=>{if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>1_000_000)throw new ApiError(400,'일정 버전을 확인해 주세요.');return Number(value);};
const identifier=(value:unknown)=>{if(typeof value!=='string'||!value.trim()||value.length>180)throw new ApiError(400,'일정 ID를 확인해 주세요.');return value;};
function validated<T>(fn:()=>T):T{try{return fn();}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,error instanceof Error?error.message:'일정을 확인해 주세요.');}}
const same=(a:unknown,b:unknown):boolean=>{if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>same(v,b[i]));const x=a as Record<string,unknown>,y=b as Record<string,unknown>,keys=Object.keys(x).sort();return same(keys,Object.keys(y).sort())&&keys.every(k=>same(x[k],y[k]));};
function decorated(row:any):CalendarAdminRow{return {...row.data,id:row.id,revision:row.revision,deleted:row.deleted,modified:true,checkedAt:new Date(row.updated_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString()} as CalendarAdminRow;}
function visiblePersonalSchedule(schedule:any){return schedule?{...schedule,source_url:visibleCalendarSourceUrl(schedule.source_url),review_note:visibleCalendarSourceText(schedule.review_note)}:schedule;}
function registration(row:any){
  const target=row.data||{},school=schoolDirectoryForTarget(target),date=personalDate(target);
  const legacy=date?{personal_date:date.slice(0,10),personal_at:date.includes('T')?validated(()=>validateKSTDateTime(date)):null,location:target.location||'',status:'awaiting'}:null;
  return {targetId:row.id,schoolReferenceId:school?.id||null,university:String(target.university||target.university_name||''),department:String(target.department||target.major||''),campus:String(target.campus||''),track:String(target.admission_type||target.track||''),admissionYear:Number(target.admission_year||target.year)||null,
    student:{id:row.student_id,name:row.student_name,email:row.student_email,active:row.student_active},registeredAt:row.created_at,
    personalSchedule:visiblePersonalSchedule(target.schedule||legacy),personalRevision:Number(target.schedule?.revision)||0};
}

export async function getAdminAdmissionCalendar(user:Profile){
  assertAdmin(user);
  const [snapshot,edits,targets]=await Promise.all([
    readAdmissionCalendar(false),
    query('select e.*,p.name as editor_name,p.email as editor_email from admission_calendar_admin_edits e join profiles p on p.id=e.updated_by where e.admission_year=2027 order by e.updated_at desc'),
    query("select t.*,p.name as student_name,p.email as student_email,p.active as student_active from support_targets t join profiles p on p.id=t.student_id where p.role='student' and nullif(t.data->>'archived_at','') is null order by p.name,t.created_at,t.id")
  ]);
  const base=buildCalendarAdminRows(snapshot.catalogue,snapshot.official),saved=new Map(edits.map(row=>[row.id,row]));
  const rows=[...base.filter(row=>!saved.has(row.id)),...edits.map(row=>({...decorated(row),updatedBy:{id:row.updated_by,name:row.editor_name,email:row.editor_email}}))];
  const registrations=targets.map(registration);
  const schools=schoolDirectory.map(school=>({id:school.id,university:school.university,registrationCount:registrations.filter(row=>row.schoolReferenceId===school.id).length}));
  return {admissionYear:2027,schools,rows:rows.map(presentCalendarSource),registrations,counts:{rows:rows.filter(row=>!row.deleted).length,registrations:registrations.length,deleted:rows.filter(row=>row.deleted).length}};
}

export async function editAdminAdmissionCalendar(user:Profile,value:unknown){
  assertAdmin(user);const input=object(value),expected=revision(input.expectedRevision),action=input.action;
  if(['personal_update','personal_delete'].includes(action))return editPersonal(user,input,expected);
  if(!['create','update','delete','restore'].includes(action))throw new ApiError(400,'지원하지 않는 일정 작업이에요.');
  const snapshot=await readAdmissionCalendar(false),base=buildCalendarAdminRows(snapshot.catalogue,snapshot.official);
  const id=action==='create'?`admin_${randomUUID()}`:identifier(input.id);
  return transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',[`admission-calendar:${id}`]);
    const stored=(await db.query('select * from admission_calendar_admin_edits where id=$1 for update',[id])).rows[0];
    const previous=stored?decorated(stored):base.find(row=>row.id===id);
    if(action!=='create'&&!previous)throw new ApiError(404,'면접 일정을 찾을 수 없어요.');
    if(expected!==(previous?.revision||0))throw new ApiError(409,'다른 관리자가 일정을 변경했어요. 새로 불러온 뒤 다시 수정해 주세요.');
    if(action==='update'&&previous?.deleted)throw new ApiError(409,'삭제한 일정은 먼저 복원해 주세요.');
    if(action==='restore'&&!stored)throw new ApiError(400,'삭제한 일정만 복원할 수 있어요.');
    const changes=['create','update'].includes(action)?validated(()=>validateCalendarAdminData(retainCalendarSourceFields(object(input.data),previous||{}))):null;
    const deleted=action==='delete'?true:action==='restore'?false:previous?.deleted||false;
    if(changes&&previous&&changes.schoolReferenceId!==previous.schoolReferenceId)throw new ApiError(400,'학교를 바꾸려면 새 일정을 등록해 주세요.');
    const editable=previous&&validated(()=>validateCalendarAdminData(previous));
    if(previous&&(action==='update'&&same(editable,changes)||action==='delete'&&previous.deleted||action==='restore'&&!previous.deleted))return {ok:true,row:presentCalendarSource(previous)};
    const now=new Date().toISOString();
    const row={...previous,...changes,id,revision:expected+1,origin:previous?.origin||'admin',modified:true,deleted,checkedAt:now,sourceLabel:'관리자',rawDate:changes?.dates.join(', ')||previous?.rawDate||'',updatedAt:now} as CalendarAdminRow;
    // Changed qualifications cannot inherit aliases describing the original scope.
    if(changes&&previous&&(changes.trackLabel!==previous.trackLabel||!same(changes.departments,previous.departments)||changes.campus!==previous.campus)){
      delete row.trackAliases;delete row.departmentAliases;
    }
    await db.query('insert into admission_calendar_admin_edits(id,admission_year,school_reference_id,data,revision,deleted,created_by,updated_by) values($1,$2,$3,$4,$5,$6,$7,$7) on conflict(id) do update set data=excluded.data,revision=excluded.revision,deleted=excluded.deleted,updated_by=excluded.updated_by,updated_at=now()',
      [id,row.admissionYear,row.schoolReferenceId,JSON.stringify(row),row.revision,deleted,user.id]);
    await db.query('insert into admission_calendar_admin_events(row_id,revision,action,actor_id,data) values($1,$2,$3,$4,$5)',[id,row.revision,action,user.id,JSON.stringify({before:previous||null,after:row})]);
    await db.query('insert into audit_logs(actor_id,action,data) values($1,$2,$3)',[user.id,`admission_calendar.${action}`,JSON.stringify({id,schoolReferenceId:row.schoolReferenceId,revision:row.revision})]);
    return {ok:true,row:presentCalendarSource(row)};
  });
}

async function editPersonal(user:Profile,input:Record<string,any>,expected:number){
  const id=identifier(input.targetId),deleting=input.action==='personal_delete';
  return transaction(async db=>{
    await db.query('select pg_advisory_xact_lock(hashtext($1))',[`support_target:${id}`]);
    const row=(await db.query("select t.*,p.name as student_name,p.email as student_email,p.active as student_active from support_targets t join profiles p on p.id=t.student_id where t.id=$1 and p.role='student' and nullif(t.data->>'archived_at','') is null for update of t",[id])).rows[0];
    if(!row)throw new ApiError(404,'학교 등록 정보를 찾을 수 없어요.');
    const before=row.data||{},old=before.schedule||{},oldRevision=Number(old.revision)||0;
    if(expected!==oldRevision)throw new ApiError(409,'개인 일정이 변경됐어요. 새로 불러온 뒤 다시 수정해 주세요.');
    const schedule=validated(()=>normalizeSchedule(deleting?{period_start:null,period_end:null,personal_date:null,personal_at:null,location:'',required_materials:[],source_url:'',checked_at:null,status:'awaiting',review_note:''}:retainCalendarSourceFields(object(input.schedule),old,['source_url','review_note'])));
    const schoolYear=Number(before.admission_year||before.year);
    if(Number.isInteger(schoolYear)&&schoolYear>=2020&&schoolYear<=2100)for(const day of [schedule.personal_date,schedule.period_start,schedule.period_end].filter(Boolean)){
      if(![schoolYear-1,schoolYear].includes(Number(day!.slice(0,4))))throw new ApiError(400,'지원 학년도에 맞는 면접 날짜를 입력해 주세요.');
    }
    const {revision:_revision,reviewed_by:_reviewed,updated_at:_updated,...oldFields}=old;
    const previous=before.schedule?oldFields:registration(row).personalSchedule;
    if(same(previous,schedule))return {ok:true,registration:registration(row)};
    const next={...before,schedule:{...schedule,revision:oldRevision+1,reviewed_by:user.id,updated_at:new Date().toISOString()},interview_date:schedule.personal_at||schedule.personal_date,interview_at:null};
    await db.query('update support_targets set data=$1 where id=$2',[JSON.stringify(next),id]);
    await db.query('insert into audit_logs(actor_id,student_id,action,data) values($1,$2,$3,$4)',[user.id,row.student_id,deleting?'admission_calendar.personal_delete':'admission_calendar.personal_update',JSON.stringify({targetId:id,before:previous,after:next.schedule})]);
    return {ok:true,registration:registration({...row,data:next})};
  });
}
