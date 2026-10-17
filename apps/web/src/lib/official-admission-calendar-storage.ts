import {createHash} from 'node:crypto';
import type {PoolClient,Client} from 'pg';
import {validateOfficialCalendarSupplement,type OfficialCalendarSupplement} from './official-admission-calendar';

export const OFFICIAL_ADMISSION_CALENDAR_SOURCE_KEY='official-susi-supplement';
type Database=Pick<PoolClient|Client,'query'>;

/** Called in a transaction; official evidence is versioned separately from the Acon feed. */
export async function saveOfficialCalendarSupplement(db:Database,input:OfficialCalendarSupplement){
  const supplement=validateOfficialCalendarSupplement(input);
  const contentHash=createHash('sha256').update(JSON.stringify({...supplement,checkedAt:null})).digest('hex');
  const inserted=await db.query('insert into admission_calendar_versions(source_key,admission_year,content_hash,data,fetched_at) values($1,$2,$3,$4,$5) on conflict(source_key,admission_year,content_hash) do nothing returning id',[OFFICIAL_ADMISSION_CALENDAR_SOURCE_KEY,supplement.admissionYear,contentHash,JSON.stringify(supplement),supplement.checkedAt]);
  const id=inserted.rows[0]?.id||(await db.query('select id from admission_calendar_versions where source_key=$1 and admission_year=$2 and content_hash=$3',[OFFICIAL_ADMISSION_CALENDAR_SOURCE_KEY,supplement.admissionYear,contentHash])).rows[0]?.id;
  if(!id)throw new Error('공식 면접 일정 버전을 저장하지 못했어요.');
  await db.query('insert into admission_calendar_sync_state(source_key,latest_version_id,checked_at,attempted_at,retry_after,last_error) values($1,$2,$3,now(),null,null) on conflict(source_key) do update set latest_version_id=excluded.latest_version_id,checked_at=excluded.checked_at,attempted_at=now(),retry_after=null,last_error=null,updated_at=now()',[OFFICIAL_ADMISSION_CALENDAR_SOURCE_KEY,id,supplement.checkedAt]);
  return {id,inserted:Boolean(inserted.rows.length),admissionYear:supplement.admissionYear,schools:supplement.schools.length,
    entries:supplement.schools.reduce((count,school)=>count+school.entries.length,0),decisions:supplement.schools.reduce((count,school)=>count+school.decisions.length,0)};
}
