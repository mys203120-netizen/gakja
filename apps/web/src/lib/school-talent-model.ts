import data from '../data/school-talent-profiles.json';
import { schoolDirectory, schoolDirectoryForTarget, type SchoolDirectoryEntry } from './school-directory';

export type SchoolTalentPoint = { id:string; label:string; description:string; question?:string };
export type SchoolTalentProfile = {
  id:string; revision:number; university:string; schoolReferenceId?:string; campus?:string; department?:string;
  scope:'university'|'department'; status:'official_source'; title:string; points:SchoolTalentPoint[];
  definitionKind?:'talent'|'education_goal'|'core_competencies';
  source:{url:string;title:string;checkedAt:string;publishedAt:string|null;applicableYear:number|null;section?:string;scope?:string;note:string};
};
export const schoolTalentProfiles = data.profiles as SchoolTalentProfile[];
const latest = (profiles:SchoolTalentProfile[]) => profiles.filter(profile => !profiles.some(other => other.id===profile.id && other.revision>profile.revision));
function campusMatches(profile:SchoolTalentProfile,target:Record<string,any>){
  if(profile.source.applicableYear!==null && Number(target.admission_year || target.year)!==profile.source.applicableYear)return false;
  if(profile.campus)return profile.campus===target.campus;
  // The directory calls the Seoul main campus '본교'; a manual WISE/글로컬
  // campus must not inherit the Seoul university's separately sourced values.
  if(profile.source.scope==='서울')return ['본교','서울','서울캠퍼스'].includes(String(target.campus || ''));
  return true;
}
/** An admissions evaluation score is never interpreted as the university's talent definition. */
export function schoolTalentForTarget(target:Record<string,any>) {
  const school=schoolDirectoryForTarget(target);
  const university=school?.canonicalName || target.university;
  const profiles=latest(schoolTalentProfiles.filter(profile=>profile.university===university && (!profile.schoolReferenceId || profile.schoolReferenceId===(school?.id || target.school_reference_id))));
  const department=target.department || target.major;
  // The university's values remain part of the selected department's preparation.
  // A department definition adds to those values; it must not replace them.
  const matched=profiles.filter(profile=>campusMatches(profile,target) && (profile.scope==='university' || profile.department===department))
    .sort((a,b)=>Number(a.scope==='department')-Number(b.scope==='department') || Number(b.source.applicableYear!==null)-Number(a.source.applicableYear!==null) || a.id.localeCompare(b.id));
  const primary=matched.find(profile=>profile.scope==='department') || matched[0];
  const enriched=matched.map(profile=>({...profile,source:{...profile.source},points:profile.points.map(point=>({...point,
    key:`${profile.id}:${point.id}`,profileId:profile.id,profileRevision:profile.revision,scope:profile.scope,
    definitionKind:profile.definitionKind || 'talent',source:{...profile.source},
    practiceQuestionId:school?`${school.id}_talent_${profile.id}_${point.id}`:null,
  }))}));
  return primary ? {...primary,schoolReferenceId:school?.id || primary.schoolReferenceId,points:enriched.flatMap(profile=>profile.points),
    profiles:enriched,sources:enriched.map(profile=>({profileId:profile.id,profileRevision:profile.revision,scope:profile.scope,definitionKind:profile.definitionKind || 'talent',...profile.source})),
    source:{...primary.source},departmentStatus:enriched.some(profile=>profile.scope==='department')?'official_source' as const:'university_shared' as const,
    questionBasis:'training' as const}
    : {status:'needs_confirmation' as const,university,scope:'university' as const,points:[],profiles:[],sources:[],source:null,
      departmentStatus:'needs_confirmation' as const,questionBasis:'general_practice' as const};
}
export function schoolTalentSummary(school:SchoolDirectoryEntry) {
  const profiles=latest(schoolTalentProfiles.filter(profile=>profile.university===school.canonicalName && (!profile.schoolReferenceId || profile.schoolReferenceId===school.id) && (!profile.campus || profile.campus===school.campusLabel || profile.campus==='본교' && !school.campusLabel)));
  const university=profiles.find(profile=>profile.scope==='university');
  return {status:university?'official_source':'needs_confirmation',universityProfile:university || null,departmentProfileCount:profiles.filter(profile=>profile.scope==='department').length,checkedAt:profiles.length?data.checkedAt:null};
}
export function schoolTalentCoverage() {
  const rows=schoolDirectory.map(school=>({id:school.id,university:school.university,...schoolTalentSummary(school)}));
  return {checkedAt:data.checkedAt,registeredSchools:rows.length,officialSourceSchools:rows.filter(row=>row.status==='official_source').length,needsConfirmationSchools:rows.filter(row=>row.status==='needs_confirmation').length,profiles:latest(schoolTalentProfiles).length,rows};
}
/** Immutable rows share the existing common-question revision / owned-session pipeline. */
export function schoolTalentQuestionRows(includeHistorical=false) {
  return (includeHistorical?schoolTalentProfiles:latest(schoolTalentProfiles)).flatMap(profile=>{
    const schools=schoolDirectory.filter(school=>school.canonicalName===profile.university && (!profile.schoolReferenceId || profile.schoolReferenceId===school.id) && (!profile.campus || profile.campus===school.campusLabel || profile.campus==='본교' && !school.campusLabel));
    return schools.flatMap(school=>profile.points.map(point=>({
      id:`${school.id}_talent_${profile.id}_${point.id}`,revision:profile.revision,school_reference_id:school.id,
      prompt:`${profile.department || profile.university}의 ‘${point.label}’와 연결해 답해 주세요. ${point.question || '이 가치가 본인의 학습과 생활에서 어떤 의미인지 설명해 주세요. 실제 경험이 있다면 연결하고, 아직 경험이 없다면 앞으로 실천할 방법을 말해 주세요.'}`,
      data:{question_types:['university','talent','community'],grounding_types:['school_talent'],activity_ids:[],source_ref_ids:[`talent_source_${profile.id}_v${profile.revision}`],answer_elements:['가치에 대한 나의 해석','실제 경험 또는 실천 계획','선택의 이유와 배운 점'],allocation_bucket:'talent',applicability:'general_practice',requires_personal_fact:false,talent_profile:{id:profile.id,revision:profile.revision,scope:profile.scope,university:profile.university,campus:profile.campus || null,department:profile.department || null,title:profile.title,...(profile.definitionKind?{definitionKind:profile.definitionKind}:{}),point:{id:point.id,label:point.label,description:point.description}}},
      source:{...profile.source,kind:profile.definitionKind==='education_goal'?'official_education_goal_summary':profile.definitionKind==='core_competencies'?'official_core_competencies_summary':'official_talent_summary',profileId:profile.id,profileRevision:profile.revision,scope:profile.scope,...(profile.definitionKind?{definitionKind:profile.definitionKind}:{}),point:point.label,summary:point.description,informationStatus:profile.status,questionBasis:'training',officialPastQuestion:false},
    })));
  });
}
export function talentQuestionMatchesTarget(question:Record<string,any>,target:Record<string,any>) {
  const talent=question.talent_profile;
  if(!talent)return true;
  const school=schoolDirectoryForTarget(target);
  if(talent.university!==(school?.canonicalName || target.university))return false;
  const profile=schoolTalentProfiles.find(item=>item.id===talent.id && item.revision===talent.revision);
  if(!profile || profile.schoolReferenceId && profile.schoolReferenceId!==(school?.id || target.school_reference_id) || !campusMatches(profile,target))return false;
  return (!talent.campus || talent.campus===target.campus) && (!talent.department || talent.department===(target.department || target.major));
}
