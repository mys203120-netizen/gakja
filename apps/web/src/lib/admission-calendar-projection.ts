import {calendarForTargets,type AdmissionCalendarCatalogue,type AdmissionCalendarTarget} from './admission-calendar-model';
import {officialDecisionForTarget,type OfficialCalendarSupplement} from './official-admission-calendar';
import {visibleCalendarSourceUrl,visibleCalendarSourceLabel,visibleCalendarSourceText} from './calendar-source-presentation';

export type AdmissionCalendarSnapshot = {catalogue:AdmissionCalendarCatalogue;official:OfficialCalendarSupplement;officialSchools:number;stale:boolean;lastRefreshFailed:boolean;refreshDue:boolean};
/** Shared by onboarding and the student's calendar: public school dates are never personal appointments. */
export function projectAdmissionCalendar(snapshot:AdmissionCalendarSnapshot,targets:AdmissionCalendarTarget[]){
  const projected=calendarForTargets(snapshot.catalogue,targets);
  const reviewed=projected.schools.map(row=>{
    const officialSchool=row.school?snapshot.official.schools.find(school=>school.schoolReferenceId===row.school!.schoolReferenceId):undefined;
    let decision=row.yearMatches&&officialSchool?officialDecisionForTarget(officialSchool,row.target):null;
    const latestManagedDate=Math.max(0,...row.entries.filter(entry=>entry.sourceKind==='admin'&&entry.scopeMatch==='target').map(entry=>Date.parse(entry.checkedAt||'')||0));
    if(decision&&latestManagedDate&&(decision.sourceKind!=='admin'||latestManagedDate>=(Date.parse(decision.checkedAt||'')||0)))decision=null;
    const officialTargetUnverified=Boolean(officialSchool&&!decision&&!row.entries.some(entry=>entry.scopeMatch==='target'));
    // A known non-dated track must never borrow another track's calendar dates.
    return {...row,officialSchool,decision,officialTargetUnverified,entries:decision?[]:row.entries};
  });
  const interviewSchedules=reviewed.flatMap(row=>row.entries.flatMap(entry=>entry.segments.map((segment,index)=>({
    id:`${entry.id}:${index}:${row.targetId}`,schoolReferenceId:entry.schoolReferenceId,university:row.school!.university,targetId:row.targetId,
    admissionYear:projected.source.admissionYear,campus:entry.sourceCampus||String(row.target.campus||''),
    trackLabel:entry.trackLabel,departmentLabel:entry.departmentLabel,departmentCount:entry.departmentCount,
    ...(entry.format?{format:entry.format}:{}),
    ...(entry.scopeMatch==='target'?{matchedDepartment:String(row.target.department||row.target.major||'')}:{}),
    startDate:segment.startDate,endDate:segment.endDate,
    rawDate:visibleCalendarSourceText(entry.rawDate),note:visibleCalendarSourceText([entry.sourceKind?entry.note:null,entry.qualificationNote?.includes('명칭을 대조')?entry.qualificationNote:null].filter(Boolean).join(' '))||undefined,
    sourceUrl:visibleCalendarSourceUrl(entry.sourceUrl),sourceLabel:visibleCalendarSourceLabel(entry.sourceLabel||'',entry.sourceUrl),checkedAt:entry.checkedAt||projected.source.checkedAt,
    applicability:entry.scopeMatch==='target'?'track_match' as const:'school_reference' as const,schoolHref:`/schools/${encodeURIComponent(row.targetId)}`,
  }))));
  const interviewScheduleCoverage={
    source:{...projected.source,url:visibleCalendarSourceUrl(projected.source.url),title:'면접 일정'},registeredSchools:projected.audit.registeredSchools,
    matchedSchools:projected.audit.availableSchools+projected.audit.needsReviewSchools+projected.audit.noInterviewSchools,
    availableSchools:projected.audit.availableSchools,totalInterviewEntries:projected.audit.importedInterviewRows,
    officialSchools:snapshot.officialSchools,officialCheckedAt:snapshot.official.checkedAt,
    stale:snapshot.stale,lastRefreshFailed:snapshot.lastRefreshFailed,
    targets:reviewed.map(row=>({
      targetId:row.targetId,university:row.school?.university||String(row.target.university||''),
      status:!row.yearMatches?'year_mismatch':row.decision?.status|| (row.officialTargetUnverified?'unverified':row.trackDatesMissing?'needs_review':row.school?.status==='available'&&!row.entries.length?'campus_mismatch':!row.school&&snapshot.catalogue.schools.some(school=>school.schoolReferenceId===row.target.school_reference_id)?'campus_mismatch':row.school?.status==='no_interview'?'source_missing':row.school?.status||'not_listed'),
      entryCount:interviewSchedules.filter(entry=>entry.targetId===row.targetId).length,unresolvedCount:row.unresolved.filter(entry=>entry.kind==='interview').length,
      unresolved:row.unresolved.filter(entry=>entry.kind==='interview').map(entry=>({trackLabel:entry.trackLabel,rawDate:visibleCalendarSourceText(entry.rawDate),reason:visibleCalendarSourceText(entry.reason)})),
      officialSources:(row.officialSchool?.sources||[]).filter(source=>visibleCalendarSourceUrl(source.url)).map(source=>({...source,title:visibleCalendarSourceText(source.title)})),officialDecisions:row.yearMatches?(row.officialSchool?.decisions||[]).map(decision=>({...decision,sourceUrl:visibleCalendarSourceUrl(decision.sourceUrl),sourceLabel:visibleCalendarSourceLabel(decision.sourceLabel||'입학처',decision.sourceUrl),reason:visibleCalendarSourceText(decision.reason)})):[],
      managed:row.entries.some(entry=>entry.sourceKind==='admin')||Boolean(row.officialSchool?.decisions.some(decision=>decision.sourceKind==='admin')),
      ...(row.decision?{decisionTrack:row.decision.trackLabel,decisionSourceUrl:visibleCalendarSourceUrl(row.decision.sourceUrl),decisionSourceLabel:visibleCalendarSourceLabel(row.decision.sourceLabel||'입학처',row.decision.sourceUrl),decisionCheckedAt:row.decision.checkedAt||snapshot.official.checkedAt}:{}),
      ...(!row.yearMatches?{note:`${projected.source.admissionYear}학년도 공개 일정입니다. 지원 학년도의 일정은 별도로 확인해 주세요.`}:row.decision?{note:visibleCalendarSourceText(row.decision.reason)}:row.officialTargetUnverified?{note:'선택한 전형·모집단위를 공식 자료와 대조하지 못했어요. 표시된 날짜가 있다면 학교 참고 일정입니다.'}:row.trackDatesMissing?{note:'선택한 전형의 날짜를 확정할 수 없어 달력에 배치하지 않았어요.'}:row.school?.status==='available'&&!row.entries.length?{note:'선택한 캠퍼스·모집단위의 면접일은 원문에서 확인해 주세요.'}:row.officialSchool?{note:visibleCalendarSourceText(row.officialSchool.scopeNote)}:{})
    })),
  };
  return {interviewSchedules,interviewScheduleCoverage,refreshDue:snapshot.refreshDue};
}
