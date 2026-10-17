import 'server-only';
import bundled from '../data/school-interview-calendar.json';
import officialBundled from '../data/school-interview-official.json';
import {ApiError,query,transaction} from './db';
import {type AdmissionCalendarCatalogue} from './admission-calendar-model';
import {fetchAconInterviewCalendar} from './acon-calendar-source';
import {ADMISSION_CALENDAR_SOURCE_KEY,ADMISSION_CALENDAR_REFRESH_MS,saveCalendarSnapshot,validateCalendarSnapshot} from './admission-calendar-storage';
import {overlayOfficialCalendar,validateOfficialCalendarSupplement,type OfficialCalendarSupplement} from './official-admission-calendar';
import {applyCalendarAdminEdits} from './admin-admission-calendar-model';
import {projectAdmissionCalendar} from './admission-calendar-projection';

export async function readAdmissionCalendar(includeAdmin=true){
  const [baseRows,officialRows]=await Promise.all([
    query('select v.data,s.checked_at,s.retry_after,s.last_error from admission_calendar_sync_state s left join admission_calendar_versions v on v.id=s.latest_version_id where s.source_key=$1',[ADMISSION_CALENDAR_SOURCE_KEY]),
    query('select v.data,s.checked_at from admission_calendar_sync_state s join admission_calendar_versions v on v.id=s.latest_version_id where s.source_key=$1',['official-susi-supplement'])
  ]);
  const row=baseRows[0],catalogue=validateCalendarSnapshot((row?.data||bundled) as AdmissionCalendarCatalogue);
  const officialData=validateOfficialCalendarSupplement((officialRows[0]?.data||officialBundled) as OfficialCalendarSupplement);
  const official={...officialData,checkedAt:officialRows[0]?.checked_at?new Date(officialRows[0].checked_at).toISOString():officialData.checkedAt};
  const checkedAt=row?.checked_at?new Date(row.checked_at).toISOString():catalogue.source.checkedAt;
  const stale=Date.now()-Date.parse(checkedAt)>=ADMISSION_CALENDAR_REFRESH_MS;
  const base=overlayOfficialCalendar({...catalogue,source:{...catalogue.source,checkedAt}},official);
  const edits=includeAdmin?await query('select id,data,revision,deleted,updated_at as "updatedAt" from admission_calendar_admin_edits where admission_year=$1',[base.source.admissionYear]):[];
  const managed=includeAdmin?applyCalendarAdminEdits(base,official,edits.map(edit=>({...edit,updatedAt:new Date(edit.updatedAt).toISOString()}))):{catalogue:base,official};
  return {...managed,officialSchools:official.schools.length,stale,refreshDue:stale&&(!row?.retry_after||new Date(row.retry_after).getTime()<=Date.now()),lastRefreshFailed:Boolean(row?.last_error)};
}

/** The request reads the last successful snapshot; Next's after() owns this refresh. */
export async function refreshAdmissionCalendar(){
  await query('insert into admission_calendar_sync_state(source_key) values($1) on conflict do nothing',[ADMISSION_CALENDAR_SOURCE_KEY]);
  const claims=await query("update admission_calendar_sync_state set attempted_at=now(),retry_after=now()+interval '30 minutes',updated_at=now() where source_key=$1 and (checked_at is null or checked_at<=now()-interval '24 hours') and (retry_after is null or retry_after<=now()) returning source_key",[ADMISSION_CALENDAR_SOURCE_KEY]);
  if(!claims.length)return {refreshed:false};
  try{
    const catalogue=await fetchAconInterviewCalendar({signal:AbortSignal.timeout(20_000)});
    const result=await transaction(client=>saveCalendarSnapshot(client,catalogue));
    return {refreshed:true,...result};
  }catch{
    await query("update admission_calendar_sync_state set last_error='source_refresh_failed',retry_after=now()+interval '1 hour',updated_at=now() where source_key=$1",[ADMISSION_CALENDAR_SOURCE_KEY]);
    return {refreshed:false,previousSnapshotKept:true};
  }
}

export async function studentAdmissionCalendar(studentId:string,targetId?:string|null){
  if(targetId&&targetId.length>200)throw new ApiError(400,'지원 학교를 확인해 주세요.');
  const [snapshot,rows]=await Promise.all([readAdmissionCalendar(),query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null order by id",[studentId])]);
  if(targetId&&!rows.some(row=>row.id===targetId))throw new ApiError(404,'등록한 지원 학교를 선택해 주세요.');
  const targets=rows.filter(row=>!targetId||row.id===targetId).map(row=>({...row.data,id:row.id}));
  return projectAdmissionCalendar(snapshot,targets);
}
