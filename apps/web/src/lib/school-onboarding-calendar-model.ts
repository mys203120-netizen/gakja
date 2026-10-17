import {campusForTarget,type AdmissionCalendarTarget} from './admission-calendar-model';
import {projectAdmissionCalendar,type AdmissionCalendarSnapshot} from './admission-calendar-projection';
import {validateDateOnly} from './schedule';
import {visibleCalendarSourceUrl} from './calendar-source-presentation';

export const schoolCalendarStatusLabels:Record<string,string>={
  registered:'전형 일정 확인',school_reference:'학교 참고 일정',no_interview:'면접 미실시',date_pending:'날짜 미정',
  unpublished:'일정 미공개',unverified:'전형·학과 확인 필요',needs_review:'날짜 확인 필요',
  year_mismatch:'지원 학년도 확인 필요',campus_mismatch:'캠퍼스·학과 확인 필요',source_missing:'면접 여부 확인 필요',not_listed:'일정 확인 필요',
};
const normalize=(value:unknown)=>String(value??'').normalize('NFKC').replace(/[\s·・—–]/g,'').toLowerCase();
const meaningful=(value:unknown)=>Boolean(value&&value!=='미정');
export function buildSchoolCalendarPreview(snapshot:AdmissionCalendarSnapshot,target:AdmissionCalendarTarget){
  const projected=projectAdmissionCalendar(snapshot,[{...target,id:'preview'}]);
  const coverage=projected.interviewScheduleCoverage.targets[0];
  const year=Number(target.admission_year||target.year),calendarYear=year-1;
  // A misdated external snapshot may be shown as unresolved, never registered in the wrong calendar year.
  const schedules=projected.interviewSchedules.filter(item=>validateDateOnly(item.startDate)&&validateDateOnly(item.endDate)&&item.startDate.startsWith(`${calendarYear}-`)&&item.endDate.startsWith(`${calendarYear}-`));
  const matched=schedules.filter(item=>item.applicability==='track_match'),references=schedules.filter(item=>item.applicability==='school_reference');
  const school=snapshot.catalogue.schools.find(row=>row.schoolReferenceId===target.school_reference_id);
  const official=snapshot.official.schools.find(row=>row.schoolReferenceId===target.school_reference_id);
  const campus=campusForTarget(target);
  const selectedMajor=String(target.department||target.major||'');
  const supportsMajor=(departments:string[],aliases:string[]=[] ,complete=false)=>!meaningful(selectedMajor)||!complete||[...departments,...aliases].some(name=>normalize(name)===normalize(selectedMajor));
  const labels=year!==snapshot.catalogue.source.admissionYear?[]:[
    ...(school?.entries||[]).filter(entry=>!entry.sourceCampus||!campus||normalize(entry.sourceCampus.replace(/캠퍼스|교정/g,''))===normalize(campus)).filter(entry=>supportsMajor(entry.departments,entry.departmentAliases,entry.departmentCount===entry.departments.length)).map(entry=>entry.trackLabel),
    ...(school?.unresolved||[]).filter(entry=>entry.kind==='interview').map(entry=>entry.trackLabel),
    ...(official?.decisions||[]).filter(decision=>!decision.campus||Boolean(campus&&normalize(campus)===normalize(decision.campus.replace(/캠퍼스|교정/g,'')))).filter(decision=>supportsMajor(decision.departments,decision.departmentAliases,decision.departments.length>0)).map(decision=>decision.trackLabel),
  ];
  const tracks=[...new Map(labels.filter(label=>label&&label!=='*').map(label=>[normalize(label),label])).values()].sort((a,b)=>a.localeCompare(b,'ko'));
  const invalidYearDates=projected.interviewSchedules.length!==schedules.length;
  const status=invalidYearDates?'unverified':matched.length?'registered':references.length?'school_reference':coverage.status;
  const note=invalidYearDates?'지원 학년도의 실제 면접 연도와 맞지 않는 날짜는 등록하지 않았어요.':matched.length?'학교에서 공개한 전형 일정이에요. 개인 응시 시간은 입학처 발표 후 확인해 주세요.':references.length?'전형·학과와 대조되지 않은 날짜는 학교 참고 일정으로만 표시해요.':coverage.note||'선택한 전형의 면접 여부와 날짜를 입학처에서 확인해 주세요.';
  const preview={
    admissionYear:year,calendarYear,sourceAdmissionYear:snapshot.catalogue.source.admissionYear,
    university:String(target.university||''),campus:String(target.campus||''),department:String(target.department||target.major||''),track:String(target.admission_type||target.track||''),
    status,statusLabel:schoolCalendarStatusLabels[status]||'일정 확인 필요',note,tracks,
    matched:matched.map(({targetId,schoolHref,...item})=>item),references:references.map(({targetId,schoolHref,...item})=>item),
    unresolved:coverage.unresolved||[],decisionSourceUrl:coverage.decisionSourceUrl||null,decisionSourceLabel:coverage.decisionSourceLabel||null,
    checkedAt:coverage.decisionCheckedAt||snapshot.catalogue.source.checkedAt,stale:snapshot.stale,
    officialSources:coverage.officialSources,sourceUrl:visibleCalendarSourceUrl(snapshot.catalogue.source.url),
    canReview:meaningful(target.admission_type||target.track)&&meaningful(target.department||target.major),
  };
  return preview;
}
export type SchoolCalendarPreview=ReturnType<typeof buildSchoolCalendarPreview> & {fingerprint:string};
/** The acknowledged result is a public-calendar link, not a fabricated individual appointment. */
export function schoolCalendarRegistration(preview:SchoolCalendarPreview,registeredAt:string){
  return {schema_version:1,admission_year:preview.admissionYear,calendar_year:preview.calendarYear,status:preview.status,
    fingerprint:preview.fingerprint,registered_at:registeredAt,checked_at:preview.checkedAt,
    matched_entry_ids:preview.matched.map(item=>item.id.replace(/:preview$/,'')),
    reference_entry_ids:preview.references.map(item=>item.id.replace(/:preview$/,'')),
    source_urls:[...new Set([...preview.matched,...preview.references].map(item=>visibleCalendarSourceUrl(item.sourceUrl)).concat(preview.decisionSourceUrl?[visibleCalendarSourceUrl(preview.decisionSourceUrl)]:[]).filter(Boolean))],
    personal_appointment_confirmed:false,};
}

/** Unicode Roman numerals and source whitespace do not create duplicate support targets. */
export function sameSchoolRegistrationTarget(left:AdmissionCalendarTarget,right:AdmissionCalendarTarget){
  const sameSchool=left.school_reference_id&&right.school_reference_id?left.school_reference_id===right.school_reference_id:normalize(left.university)===normalize(right.university);
  const stageLeft=left.interview_stage||left.stage,stageRight=right.interview_stage||right.stage;
  return Boolean(sameSchool&&Number(left.admission_year||left.year)===Number(right.admission_year||right.year)
    &&normalize(left.campus)===normalize(right.campus)&&normalize(left.department||left.major)===normalize(right.department||right.major)
    &&normalize(left.admission_type||left.track)===normalize(right.admission_type||right.track)
    &&(!stageLeft||!stageRight||normalize(stageLeft)===normalize(stageRight)));
}
