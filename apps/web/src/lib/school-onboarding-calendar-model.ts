import {campusForTarget,departmentInEntry,type AdmissionCalendarTarget} from './admission-calendar-model';
import {projectAdmissionCalendar,type AdmissionCalendarSnapshot} from './admission-calendar-projection';
import {validateDateOnly} from './schedule';
import {visibleCalendarSourceUrl} from './calendar-source-presentation';
import {interviewSupportForTarget} from './school-interview-scope';
import {officialDecisionForTarget} from './official-admission-calendar';

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
  const school=snapshot.catalogue.schools.find(row=>row.schoolReferenceId===target.school_reference_id);
  const official=snapshot.official.schools.find(row=>row.schoolReferenceId===target.school_reference_id);
  const campus=campusForTarget(target);
  const selectedMajor=String(target.department||target.major||'');
  const supportsMajor=(departments:string[],aliases:string[]=[])=>meaningful(selectedMajor)&&(!departments.length||[...departments,...aliases].some(name=>normalize(name)===normalize(selectedMajor)));
  type TrackOption={label:string;scope:'target'|'school_reference'};
  const options:TrackOption[]=[],explicitlyExcluded=new Set<string>();
  for(const entry of school?.entries||[]){
    if(entry.format==='video_submission'||entry.sourceCampus&&campus&&normalize(entry.sourceCampus.replace(/캠퍼스|교정/g,''))!==normalize(campus))continue;
    const departmentMatch=departmentInEntry(entry,selectedMajor);
    if(departmentMatch===false){explicitlyExcluded.add(normalize(entry.trackLabel));continue;}
    options.push({label:entry.trackLabel,scope:departmentMatch===true&&(!entry.sourceCampus||Boolean(campus))?'target':'school_reference'});
  }
  // A known interview with incomplete unit metadata remains usable as a school
  // reference. An explicit complete exclusion is never undone by a broad hint.
  for(const entry of school?.unresolved||[])if(entry.kind==='interview'&&(!explicitlyExcluded.has(normalize(entry.trackLabel))||options.some(option=>normalize(option.label)===normalize(entry.trackLabel))))options.push({label:entry.trackLabel,scope:'school_reference'});
  for(const decision of official?.decisions||[])if(['date_pending','unpublished'].includes(decision.status)&&(!decision.campus||Boolean(campus&&normalize(campus)===normalize(decision.campus.replace(/캠퍼스|교정/g,''))))&&supportsMajor(decision.departments,decision.departmentAliases))options.push({label:decision.trackLabel,scope:'target'});
  const trackMap=new Map<string,TrackOption>();
  for(const option of year!==snapshot.catalogue.source.admissionYear?[]:options){
    const label=option.label,candidate={...target,admission_type:label};
    const decision=official&&officialDecisionForTarget(official,candidate);
    if(!label||label==='*'||!interviewSupportForTarget(candidate).supported||['no_interview','unverified'].includes(decision?.status||''))continue;
    const previous=trackMap.get(normalize(label));if(!previous||option.scope==='target')trackMap.set(normalize(label),option);
  }
  const trackOptions=[...trackMap.values()].sort((a,b)=>a.label.localeCompare(b.label,'ko')),tracks=trackOptions.map(option=>option.label);
  const selectedOption=trackMap.get(normalize(target.admission_type||target.track));
  const schoolReference=selectedOption?.scope==='school_reference';
  const matched=schoolReference?[]:schedules.filter(item=>item.applicability==='track_match');
  const references=schoolReference?schedules.map(item=>({...item,applicability:'school_reference' as const})):schedules.filter(item=>item.applicability==='school_reference');
  const interviewSupport=interviewSupportForTarget(target);
  const invalidYearDates=projected.interviewSchedules.length!==schedules.length;
  const status=invalidYearDates?'unverified':schoolReference?'school_reference':matched.length?'registered':references.length?'school_reference':coverage.status;
  const knownTrack=tracks.some(label=>normalize(label)===normalize(target.admission_type||target.track));
  const note=invalidYearDates?'지원 학년도의 실제 면접 연도와 맞지 않는 날짜는 등록하지 않았어요.':schoolReference?'이 전형의 면접은 학교 자료에 있으나 선택한 학과·캠퍼스의 응시 범위는 확인 전이에요. 학과별 면접 여부와 배정일은 입학처에서 확인해 주세요.':matched.length?'학교에서 공개한 전형 일정이에요. 개인 응시 시간은 입학처 발표 후 확인해 주세요.':references.length?'전형·학과와 대조되지 않은 날짜는 학교 참고 일정으로만 표시해요.':coverage.note||'선택한 전형의 면접 여부와 날짜를 입학처에서 확인해 주세요.';
  const preview={
    admissionYear:year,calendarYear,sourceAdmissionYear:snapshot.catalogue.source.admissionYear,
    university:String(target.university||''),campus:String(target.campus||''),department:String(target.department||target.major||''),track:String(target.admission_type||target.track||''),
    status,statusLabel:interviewSupport.supported?schoolCalendarStatusLabels[status]||'일정 확인 필요':'학생부형 준비 범위 밖',note:interviewSupport.supported?note:interviewSupport.reason,tracks,trackOptions,registrationScope:selectedOption?.scope||null,interviewSupport,
    matched:matched.map(({targetId,schoolHref,...item})=>item),references:references.map(({targetId,schoolHref,...item})=>item),
    unresolved:coverage.unresolved||[],decisionSourceUrl:coverage.decisionSourceUrl||null,decisionSourceLabel:coverage.decisionSourceLabel||null,
    checkedAt:coverage.decisionCheckedAt||snapshot.catalogue.source.checkedAt,stale:snapshot.stale,
    officialSources:coverage.officialSources,sourceUrl:visibleCalendarSourceUrl(snapshot.catalogue.source.url),
    canReview:interviewSupport.supported&&knownTrack&&status!=='no_interview'&&meaningful(target.admission_type||target.track)&&meaningful(target.department||target.major),
  };
  return preview;
}
export type SchoolCalendarPreview=ReturnType<typeof buildSchoolCalendarPreview> & {fingerprint:string};
/** The acknowledged result is a public-calendar link, not a fabricated individual appointment. */
export function schoolCalendarRegistration(preview:SchoolCalendarPreview,registeredAt:string){
  return {schema_version:1,admission_year:preview.admissionYear,calendar_year:preview.calendarYear,status:preview.status,
    registration_scope:preview.registrationScope,department_scope_confirmed:preview.registrationScope==='target',
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
