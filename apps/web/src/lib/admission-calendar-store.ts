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

// Verify tiny revision metadata on every read. Large source JSON and validation
// are reused only while both published sources and every admin edit are unchanged.
type ManagedCalendar={catalogue:AdmissionCalendarCatalogue;official:OfficialCalendarSupplement;officialSchools:number};
const calendarCache=new Map<string,Promise<ManagedCalendar>>();
export async function readAdmissionCalendar(includeAdmin=true){
  const [states,editRevisions]=await Promise.all([
    query('select source_key,latest_version_id,checked_at,retry_after,last_error from admission_calendar_sync_state where source_key=any($1::text[])',[[ADMISSION_CALENDAR_SOURCE_KEY,'official-susi-supplement']]),
    includeAdmin?query('select count(*)::int as count,coalesce(sum(revision),0)::text as revision,max(updated_at)::text as updated_at from admission_calendar_admin_edits where admission_year=$1',[2027]):Promise.resolve([]),
  ]);
  const row=states.find(state=>state.source_key===ADMISSION_CALENDAR_SOURCE_KEY),officialState=states.find(state=>state.source_key==='official-susi-supplement');
  const key=JSON.stringify([includeAdmin,states.map(state=>[state.source_key,state.latest_version_id,state.checked_at]).sort(),editRevisions]);
  let pending=calendarCache.get(key);
  if(!pending){
    pending=(async()=>{
      const ids=states.map(state=>state.latest_version_id).filter(Boolean);
      const versions=ids.length?await query('select id,data from admission_calendar_versions where id=any($1::uuid[])',[ids]):[];
      const catalogue=validateCalendarSnapshot((versions.find(version=>version.id===row?.latest_version_id)?.data||bundled) as AdmissionCalendarCatalogue);
      const officialData=validateOfficialCalendarSupplement((versions.find(version=>version.id===officialState?.latest_version_id)?.data||officialBundled) as OfficialCalendarSupplement);
      const official={...officialData,checkedAt:officialState?.checked_at?new Date(officialState.checked_at).toISOString():officialData.checkedAt};
      const checkedAt=row?.checked_at?new Date(row.checked_at).toISOString():catalogue.source.checkedAt;
      const base=overlayOfficialCalendar({...catalogue,source:{...catalogue.source,checkedAt}},official);
      const edits=includeAdmin?await query('select id,data,revision,deleted,updated_at as "updatedAt" from admission_calendar_admin_edits where admission_year=$1',[base.source.admissionYear]):[];
      const managed=includeAdmin?applyCalendarAdminEdits(base,official,edits.map(edit=>({...edit,updatedAt:new Date(edit.updatedAt).toISOString()}))):{catalogue:base,official};
      return {...managed,officialSchools:official.schools.length};
    })();
    calendarCache.set(key,pending);if(calendarCache.size>4)calendarCache.delete(calendarCache.keys().next().value!);
    pending.catch(()=>{if(calendarCache.get(key)===pending)calendarCache.delete(key);});
  }
  const managed=await pending;
  const stale=Date.now()-Date.parse(managed.catalogue.source.checkedAt)>=ADMISSION_CALENDAR_REFRESH_MS;
  return {...managed,stale,refreshDue:stale&&(!row?.retry_after||new Date(row.retry_after).getTime()<=Date.now()),lastRefreshFailed:Boolean(row?.last_error)};
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
