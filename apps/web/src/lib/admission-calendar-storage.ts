import {createHash} from 'node:crypto';
import type {PoolClient,Client} from 'pg';
import {validateDateOnly} from './schedule';
import type {AdmissionCalendarCatalogue} from './admission-calendar-model';

export const ADMISSION_CALENDAR_SOURCE_KEY='acon-susi';
export const ADMISSION_CALENDAR_SOURCE_URL='https://www.acon.io.kr/susi/calendar';
export const ADMISSION_CALENDAR_REFRESH_MS=24*60*60*1000;
type Database=Pick<PoolClient|Client,'query'>;

/** Reject an incomplete fetch before replacing a previously usable catalogue. */
export function validateCalendarSnapshot(value:AdmissionCalendarCatalogue) {
  if(value.source.url!==ADMISSION_CALENDAR_SOURCE_URL||!Number.isInteger(value.source.admissionYear)||!Number.isFinite(Date.parse(value.source.checkedAt)))throw new Error('면접 일정 출처 형식이 변경되었어요.');
  if(value.schools.length!==88||new Set(value.schools.map(school=>school.schoolReferenceId)).size!==88)throw new Error('등록 학교의 면접 일정 목록을 확인하지 못했어요.');
  let total=0;
  for(const school of value.schools){
    for(const entry of school.entries){
      if(entry.kind!=='interview'||!entry.id||!validateDateOnly(entry.startDate)||!validateDateOnly(entry.endDate)||entry.endDate<entry.startDate||!entry.segments?.length||!entry.dates?.length)throw new Error('확정할 수 없는 날짜는 달력에 적용할 수 없어요.');
      const actualDays=new Set<string>();
      for(const segment of entry.segments){
        if(!validateDateOnly(segment.startDate)||!validateDateOnly(segment.endDate)||segment.startDate>segment.endDate)throw new Error('면접 날짜의 개별 구간을 확인해 주세요.');
        let day=segment.startDate;
        while(day<=segment.endDate){actualDays.add(day);if(actualDays.size>370)throw new Error('면접 기간이 너무 길어요.');const next=new Date(`${day}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);day=next.toISOString().slice(0,10);}
      }
      if(actualDays.size!==new Set(entry.dates).size||entry.dates.some(day=>!actualDays.has(day)))throw new Error('분리된 면접 날짜가 맞지 않아요.');
      total++;
    }
  }
  if(total===0)throw new Error('공개된 면접 일정을 읽지 못했어요. 이전 자료를 유지합니다.');
  return value;
}

/** Called inside a transaction. Unchanged snapshots are reused; old dates remain auditable. */
export async function saveCalendarSnapshot(db:Database,input:AdmissionCalendarCatalogue){
  const catalogue=validateCalendarSnapshot(input);
  const contentHash=createHash('sha256').update(JSON.stringify({...catalogue,source:{...catalogue.source,checkedAt:null}})).digest('hex');
  const inserted=await db.query('insert into admission_calendar_versions(source_key,admission_year,content_hash,data,fetched_at) values($1,$2,$3,$4,$5) on conflict(source_key,admission_year,content_hash) do nothing returning id',[ADMISSION_CALENDAR_SOURCE_KEY,catalogue.source.admissionYear,contentHash,JSON.stringify(catalogue),catalogue.source.checkedAt]);
  const id=inserted.rows[0]?.id||(await db.query('select id from admission_calendar_versions where source_key=$1 and admission_year=$2 and content_hash=$3',[ADMISSION_CALENDAR_SOURCE_KEY,catalogue.source.admissionYear,contentHash])).rows[0].id;
  await db.query('insert into admission_calendar_sync_state(source_key,latest_version_id,checked_at,attempted_at,retry_after,last_error) values($1,$2,$3,now(),null,null) on conflict(source_key) do update set latest_version_id=excluded.latest_version_id,checked_at=excluded.checked_at,attempted_at=now(),retry_after=null,last_error=null,updated_at=now()',[ADMISSION_CALENDAR_SOURCE_KEY,id,catalogue.source.checkedAt]);
  return {id,inserted:Boolean(inserted.rows.length),admissionYear:catalogue.source.admissionYear,schools:catalogue.schools.length,entries:catalogue.schools.reduce((n,school)=>n+school.entries.length,0)};
}
