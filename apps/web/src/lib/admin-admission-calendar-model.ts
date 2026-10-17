import {createHash} from 'node:crypto';
import bible from '../data/school-bible.json';
import type {AdmissionCalendarCatalogue,AdmissionCalendarEntry} from './admission-calendar-model';
import {officialDateSegments,type OfficialCalendarSupplement,type OfficialCalendarDecision,type OfficialCalendarSchool} from './official-admission-calendar';
import {safeSourceURL,validateDateOnly} from './schedule';

export type CalendarAdminStatus='dated'|'no_interview'|'date_pending'|'unpublished'|'unverified';
export type CalendarAdminData={
  schoolReferenceId:string;university:string;admissionYear:2027;trackLabel:string;departments:string[];
  campus:string|null;status:CalendarAdminStatus;dates:string[];format:'in_person'|'video_submission';
  sourceUrl:string;note:string|null;
};
export type AdminCalendarData=CalendarAdminData;
export type CalendarAdminRow=CalendarAdminData&{
  id:string;sourceLabel:string;rawDate:string;checkedAt:string;revision:number;
  origin:'acon'|'official'|'admin';modified:boolean;deleted:boolean;
  sourceEntryId?:string;sourceEntryIds?:string[];sourceUniversity?:string;
  trackAliases?:string[];departmentAliases?:string[];departmentCount?:number|null;
};
export type CalendarAdminEdit={id:string;data:CalendarAdminRow;deleted:boolean;revision:number;updatedAt:string};

const normalized=(value:unknown)=>String(value??'').normalize('NFKC').replace(/[\s·・—–]/g,'').toLowerCase();
const object=(value:unknown):Record<string,unknown>=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('면접 일정 정보를 확인해 주세요.');
  return value as Record<string,unknown>;
};
const field=(value:unknown,name:string,limit:number,required=false)=>{
  if(value!==undefined&&value!==null&&typeof value!=='string')throw new Error(`${name} 형식을 확인해 주세요.`);
  const result=String(value??'').trim();
  if(result.length>limit||(required&&!result))throw new Error(`${name}을 확인해 주세요.`);
  return result;
};

/** Only editable values are accepted; attribution and revision are server-owned. */
export function validateCalendarAdminData(input:unknown):CalendarAdminData{
  const data=object(input),schoolReferenceId=field(data.schoolReferenceId,'학교',100,true);
  const school=bible.schools.find(row=>row.id===schoolReferenceId);
  if(!school)throw new Error('등록된 88개 학교 중에서 선택해 주세요.');
  if(data.admissionYear!==2027)throw new Error('2027학년도 면접 일정만 등록할 수 있어요.');
  const trackLabel=field(data.trackLabel,'전형',500,true),campus=field(data.campus,'캠퍼스',200)||null;
  if(!Array.isArray(data.departments)||data.departments.length>100)throw new Error('모집단위는 100개 이내로 입력해 주세요.');
  const departments=data.departments.map(value=>field(value,'모집단위',120,true));
  if(departments.some(name=>name==='*')||new Set(departments.map(normalized)).size!==departments.length)throw new Error('모집단위 명칭과 중복 여부를 확인해 주세요.');
  const status=data.status;
  if(!['dated','no_interview','date_pending','unpublished','unverified'].includes(String(status)))throw new Error('면접 일정 상태를 선택해 주세요.');
  const format=data.format??'in_person';
  if(format!=='in_person'&&format!=='video_submission')throw new Error('면접 응시 방식을 선택해 주세요.');
  const inputDates=data.dates??[];
  if(!Array.isArray(inputDates)||inputDates.length>100)throw new Error('면접 날짜는 100개 이내로 입력해 주세요.');
  const dates=inputDates.map(value=>{
    const day=validateDateOnly(value,'면접일');
    if(!day||!day.startsWith('2026-'))throw new Error('2027학년도 수시의 면접일은 2026년 날짜로 입력해 주세요.');
    return day;
  }).sort();
  if(new Set(dates).size!==dates.length)throw new Error('면접 날짜가 중복되었어요.');
  if(status==='dated'&&!dates.length)throw new Error('면접 날짜를 한 개 이상 입력해 주세요.');
  if(status!=='dated'&&dates.length)throw new Error('면접 미실시·미정 상태에는 날짜를 입력할 수 없어요.');
  const source=field(data.sourceUrl,'출처 URL',2000),sourceUrl=source?safeSourceURL(source):'';
  if(source&&!sourceUrl)throw new Error('출처 URL은 올바른 http 또는 https 주소로 입력해 주세요.');
  return {schoolReferenceId,university:school.university,admissionYear:2027,trackLabel,departments,campus,
    status:status as CalendarAdminStatus,dates,format,sourceUrl:sourceUrl||'',note:field(data.note,'메모',4000)||null};
}

function sourceId(row:Pick<CalendarAdminRow,'schoolReferenceId'|'origin'|'campus'|'sourceUniversity'|'university'|'trackLabel'|'departments'|'format'>){
  const identity=[row.schoolReferenceId,row.origin,normalized(row.campus),normalized(row.sourceUniversity||row.university),normalized(row.trackLabel),row.departments.map(normalized).sort(),row.format];
  return `source_${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,32)}`;
}

/** Stable logical records survive date-only source refreshes, ordering changes, and tombstones. */
export function buildCalendarAdminRows(catalogue:AdmissionCalendarCatalogue,supplement:OfficialCalendarSupplement):CalendarAdminRow[]{
  const rows:CalendarAdminRow[]=[];
  for(const school of catalogue.schools){
    for(const entry of school.entries){
      const origin=entry.sourceKind==='official_admissions'?'official':entry.sourceKind==='admin'?'admin':'acon';
      const row:CalendarAdminRow={id:'',schoolReferenceId:school.schoolReferenceId,university:school.university,
        admissionYear:2027,trackLabel:entry.trackLabel,departments:[...entry.departments],campus:entry.sourceCampus,
        status:'dated',dates:[...entry.dates],format:entry.format==='video_submission'?'video_submission':'in_person',
        sourceUrl:entry.sourceUrl,sourceLabel:entry.sourceLabel||(origin==='official'?'입학처':origin==='admin'?'관리자':'아컨'),
        rawDate:entry.rawDate,note:entry.note,checkedAt:entry.checkedAt||catalogue.source.checkedAt,
        revision:0,origin,modified:false,deleted:false,sourceEntryId:entry.id,sourceEntryIds:[entry.id],
        sourceUniversity:entry.sourceUniversity,departmentCount:entry.departmentCount,
        ...(entry.trackAliases?{trackAliases:[...entry.trackAliases]}:{}),...(entry.departmentAliases?{departmentAliases:[...entry.departmentAliases]}:{})};
      row.id=sourceId(row);rows.push(row);
    }
    for(const unresolved of school.unresolved.filter(row=>row.kind==='interview')){
      const row:CalendarAdminRow={id:'',schoolReferenceId:school.schoolReferenceId,university:school.university,
        admissionYear:2027,trackLabel:unresolved.trackLabel,departments:[],campus:null,status:'unverified',dates:[],format:'in_person',
        sourceUrl:unresolved.sourceUrl,sourceLabel:'아컨',rawDate:unresolved.rawDate,note:unresolved.reason,
        checkedAt:catalogue.source.checkedAt,revision:0,origin:'acon',modified:false,deleted:false,
        sourceEntryId:unresolved.id,sourceEntryIds:[unresolved.id],sourceUniversity:unresolved.sourceUniversity,
        departmentCount:unresolved.departmentCount};
      row.id=sourceId(row);rows.push(row);
    }
  }
  for(const school of supplement.schools)for(const decision of school.decisions){
    const row:CalendarAdminRow={id:'',schoolReferenceId:school.schoolReferenceId,university:school.university,
      admissionYear:2027,trackLabel:decision.trackLabel,departments:[...decision.departments],campus:decision.campus||null,
      status:decision.status,dates:[],format:'in_person',sourceUrl:decision.sourceUrl,sourceLabel:decision.sourceLabel||'입학처',
      rawDate:'',note:decision.reason,checkedAt:decision.checkedAt||supplement.checkedAt,revision:0,
      origin:decision.sourceKind==='admin'?'admin':'official',modified:false,deleted:false,sourceUniversity:school.university,
      ...(decision.trackAliases?{trackAliases:[...decision.trackAliases]}:{}),...(decision.departmentAliases?{departmentAliases:[...decision.departmentAliases]}:{})};
    row.id=sourceId(row);rows.push(row);
  }
  const grouped=new Map<string,CalendarAdminRow>();
  for(const row of rows){
    const existing=grouped.get(row.id);
    if(!existing){grouped.set(row.id,row);continue;}
    if(existing.status!==row.status)throw new Error('동일 전형·모집단위의 면접 상태가 충돌해요. 원본 자료를 확인해 주세요.');
    // Source rows can split the same qualification across separate days. Keep one logical record, not a date-based identity.
    existing.dates=[...new Set([...existing.dates,...row.dates])].sort();
    existing.sourceEntryIds=[...new Set([...(existing.sourceEntryIds||[]),...(row.sourceEntryIds||[])])];
    existing.rawDate=[...new Set([existing.rawDate,row.rawDate].filter(Boolean))].join(' / ');
    existing.note=[...new Set([existing.note,row.note].filter(Boolean))].join('\n')||null;
    existing.trackAliases=[...new Set([...(existing.trackAliases||[]),...(row.trackAliases||[])])];
    existing.departmentAliases=[...new Set([...(existing.departmentAliases||[]),...(row.departmentAliases||[])])];
  }
  return [...grouped.values()];
}

const sameNames=(a:readonly string[],b:readonly string[])=>JSON.stringify(a.map(normalized).sort())===JSON.stringify(b.map(normalized).sort());

/** Apply server-stored overrides without modifying either imported evidence snapshot. */
export function applyCalendarAdminEdits(catalogue:AdmissionCalendarCatalogue,supplement:OfficialCalendarSupplement,edits:CalendarAdminEdit[]):{catalogue:AdmissionCalendarCatalogue;official:OfficialCalendarSupplement}{
  const originals=buildCalendarAdminRows(catalogue,supplement),originalById=new Map(originals.map(row=>[row.id,row]));
  const changes=new Map<string,CalendarAdminEdit>();
  for(const edit of edits){
    if(changes.has(edit.id))throw new Error('동일한 면접 일정의 관리자 수정이 중복되었어요.');
    changes.set(edit.id,edit);
  }
  const removedEntryIds=new Set(originals.filter(row=>changes.has(row.id)).flatMap(row=>row.sourceEntryIds||[]));
  const schools=catalogue.schools.map(school=>({...school,
    entries:school.entries.filter(entry=>!removedEntryIds.has(entry.id)).map(entry=>({...entry,dates:[...entry.dates],departments:[...entry.departments],segments:entry.segments.map(segment=>({...segment}))})),
    unresolved:school.unresolved.filter(entry=>!removedEntryIds.has(entry.id)).map(entry=>({...entry}))}));
  const officialSchools:OfficialCalendarSchool[]=supplement.schools.map(school=>({...school,sources:school.sources.map(source=>({...source})),
    entries:school.entries.filter(entry=>!changes.has(sourceId({schoolReferenceId:school.schoolReferenceId,university:school.university,sourceUniversity:school.university,origin:'official',campus:null,trackLabel:entry.trackLabel,departments:entry.departments,format:entry.format||'in_person'}))).map(entry=>({...entry,dates:[...entry.dates],departments:[...entry.departments]})),
    decisions:school.decisions.filter(decision=>!changes.has(sourceId({schoolReferenceId:school.schoolReferenceId,university:school.university,sourceUniversity:school.university,origin:decision.sourceKind==='admin'?'admin':'official',campus:decision.campus||null,trackLabel:decision.trackLabel,departments:decision.departments,format:'in_person'}))).map(decision=>({...decision,departments:[...decision.departments]}))}));
  for(const edit of edits){
    if(edit.deleted)continue;
    const row=edit.data,school=schools.find(school=>school.schoolReferenceId===row.schoolReferenceId);
    if(!school)throw new Error('관리자 면접 일정의 학교가 등록된 학교와 일치하지 않아요.');
    const original=originalById.get(edit.id);
    const trackAliases=original&&normalized(original.trackLabel)===normalized(row.trackLabel)?original.trackAliases:undefined;
    const departmentAliases=original&&sameNames(original.departments,row.departments)?original.departmentAliases:undefined;
    if(row.status==='dated'){
      const dates=[...row.dates].sort(),segments=officialDateSegments(dates);
      if(!dates.length)throw new Error('면접 날짜가 없는 관리자 일정은 달력에 추가할 수 없어요.');
      const entry:AdmissionCalendarEntry={id:`admin:${edit.id}`,kind:'interview',schoolReferenceId:row.schoolReferenceId,
        sourceUniversity:row.university,sourceCampus:row.campus,startDate:dates[0],endDate:dates[dates.length-1],dates,segments,
        trackLabel:row.trackLabel,departments:[...row.departments],departmentLabel:row.departments.length?row.departments.join(', '):null,
        departmentCount:original&&sameNames(original.departments,row.departments)?original.departmentCount??null:row.departments.length||null,rawDate:dates.join(', '),note:row.note,sourceUrl:row.sourceUrl,
        sourceKind:'admin',sourceLabel:'관리자',checkedAt:edit.updatedAt,
        ...(trackAliases?{trackAliases:[...trackAliases]}:{}),...(departmentAliases?{departmentAliases:[...departmentAliases]}:{}),
        ...(row.format==='video_submission'?{format:'video_submission' as const}:{})};
      school.entries.push(entry);
    }else{
      let officialSchool=officialSchools.find(school=>school.schoolReferenceId===row.schoolReferenceId);
      if(!officialSchool){officialSchool={schoolReferenceId:row.schoolReferenceId,university:row.university,sources:[],entries:[],decisions:[],scopeNote:'관리자가 설정한 면접 일정입니다.'};officialSchools.push(officialSchool);}
      const decision:OfficialCalendarDecision={trackLabel:row.trackLabel,departments:[...row.departments],status:row.status,
        reason:row.note||({no_interview:'관리자가 면접 미실시로 설정했어요.',date_pending:'면접 날짜가 아직 정해지지 않았어요.',unpublished:'면접 일정이 아직 공개되지 않았어요.',unverified:'면접 일정 확인이 필요해요.'}[row.status]),
        sourceUrl:row.sourceUrl,sourceLabel:'관리자',sourceKind:'admin',checkedAt:edit.updatedAt,campus:row.campus,
        ...(trackAliases?{trackAliases:[...trackAliases]}:{}),...(departmentAliases?{departmentAliases:[...departmentAliases]}:{})};
      // The administrator's explicit scoped status has priority over a retained general source fallback.
      officialSchool.decisions.unshift(decision);
      if(row.sourceUrl&&!officialSchool.sources.some(source=>source.url===row.sourceUrl))officialSchool.sources.push({url:row.sourceUrl,title:'관리자 등록 출처'});
    }
  }
  for(const school of schools){
    const decisions=officialSchools.find(row=>row.schoolReferenceId===school.schoolReferenceId)?.decisions||[];
    school.status=school.entries.length?'available':decisions.some(row=>row.trackLabel==='*'&&!row.departments.length&&row.status==='no_interview')?'no_interview':school.unresolved.some(row=>row.kind==='interview')||decisions.length||school.status==='available'?'needs_review':school.status;
  }
  const entries=schools.flatMap(school=>school.entries);
  return {catalogue:{...catalogue,schools,audit:{...catalogue.audit,importedInterviewRows:entries.length,
    importedDateOccurrences:entries.reduce((count,entry)=>count+entry.dates.length,0),
    availableSchools:schools.filter(school=>school.status==='available').length,needsReviewSchools:schools.filter(school=>school.status==='needs_review').length,
    notListedSchools:schools.filter(school=>school.status==='not_listed').length,noInterviewSchools:schools.filter(school=>school.status==='no_interview').length,
    missingSchools:schools.filter(school=>school.status==='not_listed').map(school=>school.university),noInterviewSchoolNames:schools.filter(school=>school.status==='no_interview').map(school=>school.university),
    unresolvedInterviewRows:schools.reduce((count,school)=>count+school.unresolved.filter(row=>row.kind==='interview').length,0)}},
    official:{...supplement,schools:officialSchools}};
}
