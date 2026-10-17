import bible from '../data/school-bible.json';
import {campusForTarget,type AdmissionCalendarCatalogue,type AdmissionCalendarEntry,type AdmissionCalendarTarget} from './admission-calendar-model';
import {safeSourceURL,validateDateOnly} from './schedule';

export type OfficialCalendarSource={url:string;title:string};
export type OfficialCalendarEntry={
  trackLabel:string;departments:string[];startDate:string;endDate:string;dates:string[];
  rawDate:string;note:string|null;sourceUrl:string;
  trackAliases?:string[];departmentAliases?:string[];format?:'video_submission';
};
export type OfficialCalendarDecision={
  trackLabel:string;departments:string[];
  status:'no_interview'|'date_pending'|'unpublished'|'unverified';
  reason:string;sourceUrl:string;
  trackAliases?:string[];departmentAliases?:string[];
  campus?:string|null;sourceLabel?:string;checkedAt?:string;sourceKind?:'admin';
};
export type OfficialCalendarSchool={
  schoolReferenceId:string;university:string;sources:OfficialCalendarSource[];
  entries:OfficialCalendarEntry[];decisions:OfficialCalendarDecision[];scopeNote:string;
};
export type OfficialCalendarSupplement={
  schemaVersion:1;admissionYear:2027;checkedAt:string;schools:OfficialCalendarSchool[];
};

export const OFFICIAL_SUPPLEMENT_SCHOOLS=[
  '감리교신학대학교','서울기독대학교','장로회신학대학교','추계예술대학교',
  '한국체육대학교','국립부경대학교','경인교육대학교','공주교육대학교',
] as const;

const normalized=(value:unknown)=>String(value??'').normalize('NFKC').replace(/[\s·・—–]/g,'').toLowerCase();
const object=(value:unknown):Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('공식 면접 일정의 자료 형식을 확인해 주세요.');
  return value as Record<string,unknown>;
};
const text=(value:unknown,name:string,limit=10000)=>{
  if(typeof value!=='string'||!value.trim()||value.length>limit)throw new Error(`${name}을 확인해 주세요.`);
  return value;
};
const array=(value:unknown,name:string):unknown[]=>{
  if(!Array.isArray(value)||value.length>1000)throw new Error(`${name} 목록을 확인해 주세요.`);
  return value;
};
function validateScope(row:Record<string,unknown>){
  text(row.trackLabel,'전형 명칭',500);
  const departments=array(row.departments,'모집단위');
  for(const department of departments)if(text(department,'모집단위 명칭',500)==='*')throw new Error('모집단위는 실제 명칭으로 입력해 주세요.');
  if(new Set(departments.map(normalized)).size!==departments.length)throw new Error('중복된 모집단위 명칭을 확인해 주세요.');
  for(const key of ['trackAliases','departmentAliases'])if(row[key]!==undefined)for(const name of array(row[key],key))text(name,'공식 대조 명칭',500);
}
function sourceInSchool(value:unknown,urls:Set<string>){
  const url=text(value,'공식 출처 URL',3000);
  const base=new URL(url);base.hash='';
  if(!urls.has(url)&&!urls.has(base.toString()))throw new Error('면접 일정의 출처가 학교의 확인된 출처 목록에 없어요.');
}

/** Validate evidence and scope before a supplement can replace a saved version. */
export function validateOfficialCalendarSupplement(input:unknown):OfficialCalendarSupplement{
  const supplement=object(input);
  if(supplement.schemaVersion!==1||supplement.admissionYear!==2027)throw new Error('공식 면접 일정의 학년도를 확인해 주세요.');
  if(typeof supplement.checkedAt!=='string'||!supplement.checkedAt.includes('T')||!Number.isFinite(Date.parse(supplement.checkedAt)))throw new Error('공식 면접 일정의 확인 시각을 확인해 주세요.');
  const schools=array(supplement.schools,'학교');
  if(schools.length!==OFFICIAL_SUPPLEMENT_SCHOOLS.length)throw new Error('공식 보완 대상 8개 학교를 모두 확인해 주세요.');
  const seen=new Set<string>();
  for(const value of schools){
    const school=object(value),id=text(school.schoolReferenceId,'학교 ID',100),name=text(school.university,'학교 이름',200);
    if(seen.has(id))throw new Error('공식 보완 학교가 중복되었어요.');
    seen.add(id);
    const registered=bible.schools.find(row=>row.id===id);
    if(!registered||registered.university!==name||!(OFFICIAL_SUPPLEMENT_SCHOOLS as readonly string[]).includes(name))throw new Error('공식 보완 학교가 등록된 학교와 일치하지 않아요.');
    text(school.scopeNote,'확인 범위',10000);
    const sources=array(school.sources,'공식 출처'),urls=new Set<string>();
    if(!sources.length)throw new Error('학교별 공식 출처가 필요해요.');
    for(const value of sources){
      const source=object(value),url=text(source.url,'공식 출처 URL',3000);
      if(!safeSourceURL(url))throw new Error('공식 출처 URL의 형식을 확인해 주세요.');
      text(source.title,'공식 출처 제목',1000);
      if(urls.has(url))throw new Error('학교별 공식 출처가 중복되었어요.');
      urls.add(url);
    }
    const entries=array(school.entries,'면접 일정'),decisions=array(school.decisions,'면접 확인 상태');
    if(!entries.length&&!decisions.length)throw new Error('학교의 면접 일정 또는 확인 상태가 필요해요.');
    for(const value of entries){
      const entry=object(value);validateScope(entry);sourceInSchool(entry.sourceUrl,urls);
      text(entry.rawDate,'원문 날짜',2000);
      if(entry.note!==null)text(entry.note,'일정 메모',10000);
      if(entry.format!==undefined&&entry.format!=='video_submission')throw new Error('면접 응시 방식을 확인해 주세요.');
      const dates=array(entry.dates,'면접 날짜');
      if(!dates.length||dates.length>370)throw new Error('날짜가 미정인 일정은 달력에 추가할 수 없어요.');
      for(const day of dates)if(!validateDateOnly(day)||!String(day).startsWith('2026-'))throw new Error('2027학년도 수시 면접의 실제 연도를 확인해 주세요.');
      const sorted=[...dates].sort() as string[];
      if(new Set(dates).size!==dates.length||dates.some((day,index)=>day!==sorted[index]))throw new Error('면접 날짜는 중복 없이 날짜순으로 입력해 주세요.');
      if(entry.startDate!==sorted[0]||entry.endDate!==sorted[sorted.length-1])throw new Error('면접 기간과 개별 날짜가 일치하지 않아요.');
    }
    for(const value of decisions){
      const decision=object(value);validateScope(decision);sourceInSchool(decision.sourceUrl,urls);
      if(!['no_interview','date_pending','unpublished','unverified'].includes(String(decision.status)))throw new Error('면접 확인 상태를 확인해 주세요.');
      text(decision.reason,'면접 확인 근거',10000);
      if('dates'in decision||'startDate'in decision||'endDate'in decision)throw new Error('날짜 미정 또는 면접 미실시 상태에는 날짜를 지정할 수 없어요.');
    }
  }
  return input as OfficialCalendarSupplement;
}

/** Turn explicitly enumerated dates into continuous segments without filling gaps. */
export function officialDateSegments(dates:readonly string[]){
  const sorted=[...new Set(dates)].sort();
  const segments:Array<{startDate:string;endDate:string}>=[];
  for(const date of sorted){
    if(!validateDateOnly(date))throw new Error('면접 날짜가 필요해요.');
    const previous=segments[segments.length-1];
    if(previous){
      const next=new Date(`${previous.endDate}T00:00:00Z`);next.setUTCDate(next.getUTCDate()+1);
      if(next.toISOString().slice(0,10)===date){previous.endDate=date;continue;}
    }
    segments.push({startDate:date,endDate:date});
  }
  return segments;
}

/** Exact scoped evidence wins over a school-wide fallback; an unknown track stays unknown. */
export function officialDecisionForTarget(school:OfficialCalendarSchool|null|undefined,target:AdmissionCalendarTarget):OfficialCalendarDecision|null{
  if(!school)return null;
  if(target.school_reference_id&&target.school_reference_id!==school.schoolReferenceId)return null;
  if(!target.school_reference_id&&normalized(target.university)!==normalized(school.university))return null;
  const track=normalized(target.admission_type||target.track||''),department=normalized(target.department||target.major||'');
  const knownTrack=!!track&&track!=='미정',knownDepartment=!!department&&department!=='미정';
  const candidates=school.decisions.flatMap((decision,index)=>{
    const campus=campusForTarget(target);
    if(decision.campus&&(!campus||normalized(campus)!==normalized(decision.campus.replace(/캠퍼스|교정/g,''))))return [];
    const exactTrack=knownTrack&&[decision.trackLabel,...decision.trackAliases||[]].some(name=>normalized(name)===track);
    if(decision.trackLabel!=='*'&&!exactTrack)return [];
    const exactDepartment=knownDepartment&&[...decision.departments,...decision.departmentAliases||[]].some(name=>normalized(name)===department);
    if(decision.departments.length&&!exactDepartment)return [];
    return [{decision,score:(decision.sourceKind==='admin'?4:0)+(exactTrack?2:0)+(exactDepartment?1:0),index}];
  }).sort((a,b)=>b.score-a.score||(Date.parse(b.decision.checkedAt||'')||0)-(Date.parse(a.decision.checkedAt||'')||0)||a.index-b.index);
  return candidates[0]?.decision||null;
}

/** Acon remains immutable; separately verified official entries are added at read time. */
export function overlayOfficialCalendar(base:AdmissionCalendarCatalogue,input:OfficialCalendarSupplement):AdmissionCalendarCatalogue{
  const supplement=validateOfficialCalendarSupplement(input);
  if(base.source.admissionYear!==supplement.admissionYear)throw new Error('서로 다른 학년도의 면접 일정은 합칠 수 없어요.');
  const schools=base.schools.map(school=>{
    const official=supplement.schools.find(row=>row.schoolReferenceId===school.schoolReferenceId);
    if(!official)return {...school,entries:[...school.entries],unresolved:[...school.unresolved]};
    const entries:AdmissionCalendarEntry[]=official.entries.map((entry,index)=>({
      ...entry,id:`official:${school.schoolReferenceId}:${index}`,kind:'interview',schoolReferenceId:school.schoolReferenceId,
      sourceUniversity:school.university,sourceCampus:null,segments:officialDateSegments(entry.dates),
      departmentLabel:entry.departments.length?entry.departments.join(', '):null,
      departmentCount:entry.departments.length||null,sourceKind:'official_admissions',sourceLabel:'입학처',checkedAt:supplement.checkedAt,
    }));
    const combined=[...school.entries.filter(row=>row.sourceKind!=='official_admissions'),...entries];
    const whollyNoInterview=official.decisions.some(row=>row.trackLabel==='*'&&!row.departments.length&&row.status==='no_interview');
    return {...school,entries:combined,unresolved:[...school.unresolved],status:combined.length?'available' as const:whollyNoInterview?'no_interview' as const:'needs_review' as const};
  });
  const entries=schools.flatMap(school=>school.entries);
  return {...base,schools,audit:{...base.audit,
    importedInterviewRows:entries.length,importedDateOccurrences:entries.reduce((count,entry)=>count+entry.dates.length,0),
    availableSchools:schools.filter(school=>school.status==='available').length,
    needsReviewSchools:schools.filter(school=>school.status==='needs_review').length,
    notListedSchools:schools.filter(school=>school.status==='not_listed').length,
    noInterviewSchools:schools.filter(school=>school.status==='no_interview').length,
    missingSchools:schools.filter(school=>school.status==='not_listed').map(school=>school.university),
    noInterviewSchoolNames:schools.filter(school=>school.status==='no_interview').map(school=>school.university),
  }};
}
