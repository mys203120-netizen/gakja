/** Public admissions dates are school schedules, never an applicant's allocated appointment. */
export type AdmissionCalendarEntry = {
  id:string;kind:'interview';schoolReferenceId:string;sourceUniversity:string;sourceCampus:string|null;
  startDate:string;endDate:string;dates:string[];segments:Array<{startDate:string;endDate:string}>;
  trackLabel:string;departmentLabel:string|null;departments:string[];departmentCount:number|null;
  rawDate:string;note:string|null;sourceUrl:string;
  sourceKind?:'official_admissions'|'admin';sourceLabel?:string;checkedAt?:string;
  trackAliases?:string[];departmentAliases?:string[];format?:'video_submission';
};
export type AdmissionCalendarUnresolved = {
  id:string;sourceUniversity:string;kind:'interview'|'unclassified';trackLabel:string;rawDate:string;
  reason:string;departmentCount:number|null;sourceUrl:string;
};
export type AdmissionCalendarSchool = {
  schoolReferenceId:string;university:string;canonicalName:string;sourceUniversities:string[];
  status:'available'|'needs_review'|'not_listed'|'no_interview';
  entries:AdmissionCalendarEntry[];unresolved:AdmissionCalendarUnresolved[];
};
export type AdmissionCalendarCatalogue = {
  schemaVersion:1;
  source:{url:string;title:string;admissionYear:number;calendarYear:number;checkedAt:string;sha256:string;kind:'third_party_calendar';season:'susi'};
  schools:AdmissionCalendarSchool[];
  audit:{registeredSchools:number;sourceUniversities:number;matchedSourceUniversities:number;excludedSourceUniversities:number;
    sourceRows:number;sourceInterviewRows:number;importedInterviewRows:number;importedDateOccurrences:number;
    availableSchools:number;needsReviewSchools:number;notListedSchools:number;noInterviewSchools:number;
    unresolvedInterviewRows:number;unclassifiedUnresolvedRows:number;excludedNonInterviewRows:number;
    missingSchools:string[];noInterviewSchoolNames:string[];excludedUniversityNames:string[]};
};
export type AdmissionCalendarTarget = Record<string,any>;
export type TargetCalendarEntry = AdmissionCalendarEntry & {scopeMatch:'target'|'school';qualificationNote:string|null};

const normalized=(value:unknown)=>String(value??'').normalize('NFKC').replace(/[\s·・—–]/g,'').toLowerCase();
const normalizedCampus=(value:unknown)=>normalized(String(value??'').replace(/캠퍼스|교정/g,''));
const entryHasTrack=(entry:AdmissionCalendarEntry,track:string)=>entry.sourceKind==='admin'&&entry.trackLabel==='*'||[entry.trackLabel,...entry.trackAliases||[]].some(label=>normalized(label)===normalized(track));
export function matchCalendarSchoolTarget(school:AdmissionCalendarSchool,target:AdmissionCalendarTarget) {
  const separateCampus=String(target.campus||'');
  if(/WISE|ERICA|글로컬|GLOCAL|미래/i.test(separateCampus))return false;
  if(school.canonicalName==='고려대학교'&&/세종/.test(separateCampus))return false;
  if(target.school_reference_id)return target.school_reference_id===school.schoolReferenceId;
  // A reference ID is preferred; the fallback is exact, never fuzzy or prefix-based.
  return [school.university,school.canonicalName].some(name=>normalized(name)===normalized(target.university));
}

export function campusForTarget(target:AdmissionCalendarTarget):string|null {
  const raw=String(target.campus||'').trim();if(!raw||raw==='미정')return null;
  const name=String(target.university||'');
  const maps:Array<[RegExp,Record<string,string>]>=[
    [/단국/,{'본교':'죽전','제2캠퍼스':'천안'}],
    [/홍익/,{'본교':'서울','제2캠퍼스':'세종'}],
    [/상명/,{'본교':'서울','제2캠퍼스':'천안'}],
  ];
  for(const [pattern,mapping] of maps)if(pattern.test(name)&&mapping[raw])return mapping[raw];
  // Generic public-directory campus numbers have no defensible universal meaning.
  return /^(본교|제\d+캠퍼스)$/.test(raw)?null:raw.replace(/캠퍼스|교정/g,'');
}
function departmentInEntry(entry:AdmissionCalendarEntry,major:string) {
  if(entry.sourceKind==='admin'&&!entry.departments.length&&!entry.departmentCount&&major&&major!=='미정')return true;
  if(!major||major==='미정'||!entry.departmentLabel)return null;
  const m=normalized(major);
  const found=[...entry.departments,...entry.departmentAliases||[]].some(department=>{
    const d=normalized(department);
    // Parenthetical subunits can be exact matches; substrings such as 환경공학과 in 건설환경공학과 cannot.
    return d===m || [...department.matchAll(/\(([^()]*)\)/g)].some(match=>match[1].split(/[,·・/]/).some(name=>normalized(name)===m));
  });
  // An incomplete list remains a school candidate, even when the selected major is absent.
  return found?true:entry.departmentCount===entry.departments.length?false:null;
}
/** Return only the selected admission year; unmatched qualifications stay visibly school-level. */
export function calendarForTargets(catalogue:AdmissionCalendarCatalogue,targets:AdmissionCalendarTarget[]) {
  const schools=targets.map(target=>{
    const school=catalogue.schools.find(school=>matchCalendarSchoolTarget(school,target))||null;
    const year=Number(target.admission_year||target.admissionYear||target.year);
    const campus=campusForTarget(target),major=String(target.department||target.major||''),track=String(target.admission_type||target.track||'');
    const campusEntries=school?.entries.filter(entry=>!campus||!entry.sourceCampus||normalizedCampus(campus)===normalizedCampus(entry.sourceCampus))||[];
    const hasDatedTrack=!!track&&track!=='미정'&&campusEntries.some(entry=>entryHasTrack(entry,track));
    const hasUnresolvedTrack=!!track&&track!=='미정'&&!!school?.unresolved.some(entry=>entry.kind==='interview'&&normalized(track)===normalized(entry.trackLabel));
    const hasExactTrack=hasDatedTrack||hasUnresolvedTrack;
    const scopedEntries=campusEntries.filter(entry=>!hasExactTrack||entryHasTrack(entry,track));
    const hasKnownDepartment=scopedEntries.some(entry=>departmentInEntry(entry,major)===true);
    const entries:TargetCalendarEntry[]=!school||year!==catalogue.source.admissionYear?[]:scopedEntries.flatMap(entry=>{
      const departmentMatch=departmentInEntry(entry,major);
      // An explicit complete departmental split is a qualification, not another date for everyone.
      if(departmentMatch===false&&hasKnownDepartment)return [];
      const trackMatch=track&&track!=='미정'&&entryHasTrack(entry,track);
      const campusKnown=!entry.sourceCampus||!!campus&&normalizedCampus(campus)===normalizedCampus(entry.sourceCampus);
      return [{...entry,scopeMatch:trackMatch&&departmentMatch===true&&campusKnown?'target':'school',
        qualificationNote:trackMatch&&departmentMatch===true&&campusKnown?'개인별 응시일은 입학처 공고에서 확인해 주세요.':departmentMatch===false?'모집단위 명칭을 대조하지 못했어요. 학교 참고 일정이며 본인 전형·학과의 응시일은 원문에서 확인해 주세요.':'전형·모집단위별 학교 일정입니다. 본인 응시 대상과 배정일을 확인해 주세요.'}];
    });
    return {targetId:String(target.id||''),target,school,entries,unresolved:year===catalogue.source.admissionYear?school?.unresolved||[]:[],yearMatches:year===catalogue.source.admissionYear,trackDatesMissing:hasUnresolvedTrack&&!hasDatedTrack};
  });
  return {source:catalogue.source,audit:catalogue.audit,schools};
}
