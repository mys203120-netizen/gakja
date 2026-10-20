import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { learningTargetIdentityMatches, schoolProfileIdentityMatches } from '@gakja/content-contracts';
import { ApiError, query, transaction } from '@/lib/db';
import { schoolDirectory,schoolDirectoryEntry,schoolDirectoryForTarget,schoolDirectorySummary,enrichSchoolTarget,normalizeSchoolSelection,SchoolSelectionError } from '@/lib/school-directory';
import { officialProfileForTarget } from '@/lib/official-school-profiles';
import { schoolTalentForTarget,schoolTalentSummary,talentQuestionMatchesTarget } from '@/lib/school-talent-model';
import {schoolQuizTargetIdentity} from '@/lib/school-quiz';
import {previewSchoolAdmissionCalendar} from '@/lib/school-onboarding-calendar';
import {schoolCalendarRegistration,sameSchoolRegistrationTarget} from '@/lib/school-onboarding-calendar-model';
import {schoolHasDocumentInterview,interviewSupportForTarget,isStudentRecordQuestion} from './school-interview-scope';
import {departmentPracticeQuestions,departmentQuestionMatchesTarget} from './department-learning';
import {normalizeTrainingAvailability} from './training-availability';
export const schoolLearningIdentityMatches=learningTargetIdentityMatches;

/** Public department metadata is a learning lens, not a confirmed admissions rule. */
function schoolMajorContext(target:Record<string,any>) {
  const school=schoolDirectoryForTarget(target);
  const major=target.department || target.major;
  const department=school?.departments.find(item=>item.id===target.department_catalog_id && item.name===major)
    || school?.departments.find(item=>item.name===major && item.campus===target.campus);
  return {schoolReferenceId:school?.id || null,university:school?.canonicalName || target.university,
    department:major || null,departmentCatalogId:department?.id || null,departmentField:department?.field || null,
    departmentCategory:department?.category || null,campus:target.campus || null,
    admissionYear:target.admission_year || target.year || null,track:target.admission_type || target.track || null};
}

export const schoolRegistrationSchema = z.object({
  referenceId: z.string().max(160).nullish(), university: z.string().trim().max(100).optional(),
  departmentId:z.string().trim().max(160).nullish(),
  admissionYear: z.number().int().min(2024).max(2040), campus: z.string().trim().max(100).default('미정'),
  track: z.string().trim().max(120).default('미정'), major: z.string().trim().max(120).default('미정'),
  interestDepartment:z.string().trim().max(160).optional(),
  onboarding:z.boolean().optional(),calendarReview:z.object({fingerprint:z.string().regex(/^[a-f0-9]{64}$/),acknowledged:z.literal(true)}).optional(),
});
export async function schoolCatalog(referenceIds?:readonly string[]) {
  const selected=referenceIds?new Set(referenceIds):null;
  if(selected?.size===0)return [];
  const rows = await query('select distinct on(id) * from school_reference_catalog'+(selected?' where id=any($1::text[])':'')+' order by id,revision desc',selected?[[...selected]]:[]);
  const references=rows.map(row => ({ ...row.data,...(schoolDirectoryEntry(row.id)?schoolDirectorySummary(schoolDirectoryEntry(row.id)!):{}), id: row.id, university: row.university, version: row.revision, status: row.status, source: row.source }));
  for(const school of schoolDirectory)if((!selected||selected.has(school.id))&&!references.some(row=>row.id===school.id))references.push({...schoolDirectorySummary(school),status:'needs_confirmation',version:1,overview:[],source:{}});
  return references.filter(reference=>schoolHasDocumentInterview(reference.university)).map(reference=>({...reference,talent:schoolDirectoryEntry(reference.id)?schoolTalentSummary(schoolDirectoryEntry(reference.id)!):null})).sort((a,b) => a.university.localeCompare(b.university,'ko'));
}
/** Full catalog is needed only in school management, not while answering. */
export async function studentSchoolContext(studentId:string,{compact=false}:{compact?:boolean}={}) {
  const catalogPending=compact?null:schoolCatalog();
  const [targets,reviewed,allCatalog] = await Promise.all([query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null order by created_at,id",[studentId]),query('select distinct on(target_id) * from school_profiles where student_id=$1 order by target_id,revision desc',[studentId]),catalogPending]);
  const catalog=allCatalog||await schoolCatalog(targets.map(row=>row.data.school_reference_id).filter((id):id is string=>typeof id==='string'&&Boolean(id)));
  const enriched=targets.map(row => {
    const review=reviewed.find(profile=>profile.target_id===row.id);
    const official=officialProfileForTarget(row.data);
    return enrichSchoolTarget({ ...row.data, id: row.id,interviewSupport:interviewSupportForTarget(row.data),majorContext:schoolMajorContext(row.data),talentProfile:schoolTalentForTarget(row.data), profile:review ? reviewedSchoolView(review,row.data) : official?{...official.data,id:official.id,status:official.status,source:official.provenance,reviewed:true}:catalog.find(profile => profile.id === row.data.school_reference_id) || null });
  });
  return {catalog,targets:enriched};
}
export async function studentSchoolTargets(studentId: string) {
  return (await studentSchoolContext(studentId,{compact:true})).targets;
}
export function reviewedSchoolView(review:Record<string,any>,target:Record<string,any>) {
  const stale=!schoolProfileIdentityMatches(review.data || {},target);
  return {...review.data,id:review.id,version:review.revision,status:stale?'needs_confirmation':review.status,declared_status:review.status,stale,source:review.provenance,reviewed:true};
}
export async function referenceSchoolProfile(studentId: string, targetId: string | null) {
  if (!targetId) return null;
  const [target] = await query("select id,data from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null",[targetId,studentId]);
  if (!target) throw new ApiError(404,'지원 학교를 찾을 수 없어요.');
  const official=officialProfileForTarget(target.data);
  if(official)return {...official,target_id:targetId};
  if (!target.data.school_reference_id) return null;
  const [row] = await query('select * from school_reference_catalog where id=$1 order by revision desc limit 1',[target.data.school_reference_id]);
  return row ? { id: row.id, target_id: targetId, revision: row.revision, status: row.status, data: { ...row.data, format:'reference', evaluation_weights:null, question_distribution:null, matching_status:'school_reference_not_track_confirmed' }, provenance:row.source } : null;
}
/** Registration and editing resolve the same school identity and reviewed public calendar. */
async function prepareSchoolRegistration(input:z.infer<typeof schoolRegistrationSchema>,requireReview:boolean) {
  const [reference] = input.referenceId ? await query('select * from school_reference_catalog where id=$1 order by revision desc limit 1',[input.referenceId]) : [];
  if (input.referenceId && !reference) throw new ApiError(404,'학교 목록에서 다시 선택해 주세요.');
  let selection:ReturnType<typeof normalizeSchoolSelection>;
  try{selection=normalizeSchoolSelection(input);}catch(error){if(error instanceof SchoolSelectionError)throw new ApiError(400,error.message);throw error;}
  const university = reference?.university || selection.university;
  if (!university) throw new ApiError(400,'지원 학교를 선택해 주세요.');
  if(input.interestDepartment&&!selection.department?.programs?.includes(input.interestDepartment))throw new ApiError(400,'선택한 모집단위에 속한 관심 전공을 다시 선택해 주세요.');
  const data = enrichSchoolTarget({ university, admission_year:input.admissionYear, campus:selection.campus, admission_type:input.track || '미정', major:selection.major, department:selection.major,
    school_reference_id:reference?.id || null, school_reference_revision:reference?.revision || null, registration_source:'student', information_status:'needs_confirmation',
    school_public_code:selection.department?.schoolCode||selection.school?.publicSchoolCode||null,department_catalog_id:selection.department?.id||null,department_public_code:selection.department?.departmentCode||null,
    department_source:selection.department?{year:selection.department.year,url:selection.department.sourceUrl,status:'public_catalog'}:{status:'student_entered'},interest_department:input.interestDepartment||null,onboarding_completed:true });
  const support=interviewSupportForTarget(data);
  if(!support.supported)throw new ApiError(400,support.reason);
  if((input.onboarding||requireReview)&&!input.calendarReview)throw new ApiError(400,'면접 일정 안내를 확인한 뒤 등록해 주세요.');
  // Validate every registration, including clients that omit onboarding/review flags.
  const calendar=await previewSchoolAdmissionCalendar(data);
  if(!calendar.canReview)throw new ApiError(409,'이 학교·학과에서 확인된 학생부형 전형을 선택해 주세요. 기존 지원 정보와 학습 기록은 그대로 유지돼요.');
  if(input.calendarReview&&calendar.fingerprint!==input.calendarReview.fingerprint)throw new ApiError(409,'지원 정보나 면접 일정이 달라졌어요. 일정을 다시 확인해 주세요.');
  const calendarRegistration=input.calendarReview?schoolCalendarRegistration(calendar,new Date().toISOString()):null;
  if(calendarRegistration)data.admission_calendar_registration=calendarRegistration;
  const official=officialProfileForTarget(data);
  if(official){data.information_status='official_confirmed';data.school_interview_date=official.data.interview_date.slice(0,10);data.interview_stage=official.data.interview_stage;}
  return {input,data,reference,official,calendarRegistration};
}
type PreparedSchoolRegistration=Awaited<ReturnType<typeof prepareSchoolRegistration>>;
function registrationView(result:{id:string;data:Record<string,any>},prepared:PreparedSchoolRegistration) {
  const {official,reference}=prepared;
  return enrichSchoolTarget({...result.data,id:result.id,majorContext:schoolMajorContext(result.data),talentProfile:schoolTalentForTarget(result.data),profile:official?{...official.data,id:official.id,status:official.status,source:official.provenance,reviewed:true}:reference?{...reference.data,id:reference.id,status:reference.status,source:reference.source}:null});
}
async function saveSchoolSelection(client:Pick<PoolClient,'query'>,studentId:string,selectedTargetId:string|null,calendarReviewed=true,requireAvailability=false) {
  await client.query("insert into student_preferences(student_id,data) values($1,$2) on conflict(student_id) do update set data=student_preferences.data || excluded.data,updated_at=now()",[studentId,JSON.stringify({selectedTargetId,schoolOnboardingCompleted:true,...(calendarReviewed?{schoolCalendarOnboardingCompleted:true}:{})})]);
  if(requireAvailability){
    // The upsert above owns this row lock, including concurrent first preference saves.
    const [preferences]=(await client.query('select data from student_preferences where student_id=$1 for update',[studentId])).rows;
    if(!normalizeTrainingAvailability(preferences?.data?.trainingAvailability))await client.query("update student_preferences set data=jsonb_set(data,'{trainingAvailabilityRequired}','true'::jsonb,true),updated_at=now() where student_id=$1",[studentId]);
  }
}
export async function registerStudentSchool(studentId: string, raw: unknown) {
  const input=schoolRegistrationSchema.parse(raw);
  const firstRegistration=!input.calendarReview&&(await query("select id from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null limit 1",[studentId])).length===0;
  const prepared=await prepareSchoolRegistration(input,firstRegistration),{data,reference,calendarRegistration}=prepared;
  return transaction(async client => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))',[`school-register:${studentId}`]);
    const ownedTargets = await client.query("select id,data from support_targets where student_id=$1 and coalesce(data->>'admission_year',data->>'year')=$2 order by (nullif(data->>'archived_at','') is not null),created_at,id for update",[studentId,String(input.admissionYear)]);
    const existing={rows:ownedTargets.rows.filter(row=>sameSchoolRegistrationTarget(row.data,data)).slice(0,1)};
    let result = existing.rows[0] || (await client.query('insert into support_targets(id,student_id,data) values($1,$2,$3) returning id,data',[`target_${randomUUID()}`,studentId,JSON.stringify(data)])).rows[0];
    const restoring=Boolean(existing.rows[0]?.data?.archived_at);
    if(existing.rows.length&&(calendarRegistration||restoring)){
      const next={...result.data,interest_department:data.interest_department,...(calendarRegistration?{admission_calendar_registration:calendarRegistration}:{}),onboarding_completed:true};
      delete next.archived_at;
      result=(await client.query('update support_targets set data=$1::jsonb where id=$2 and student_id=$3 returning id,data',[JSON.stringify(next),result.id,studentId])).rows[0];
    }
    await saveSchoolSelection(client,studentId,result.id,Boolean(calendarRegistration),input.onboarding===true);
    if (!existing.rows.length) await client.query("insert into audit_logs(actor_id,student_id,action,data) values($1,$1,'school.self_register',$2)",[studentId,JSON.stringify({targetId:result.id,referenceId:reference?.id || null,admissionYear:input.admissionYear})]);
    if(restoring)await client.query("insert into audit_logs(actor_id,student_id,action,data) values($1,$1,'school.self_restore',$2)",[studentId,JSON.stringify({targetId:result.id})]);
    if(calendarRegistration&&existing.rows[0]?.data?.admission_calendar_registration?.fingerprint!==calendarRegistration.fingerprint)await client.query("insert into audit_logs(actor_id,student_id,action,data) values($1,$1,'school.calendar_register',$2)",[studentId,JSON.stringify({targetId:result.id,status:calendarRegistration.status,fingerprint:calendarRegistration.fingerprint,admissionYear:input.admissionYear})]);
    return registrationView(result,prepared);
  });
}
const schoolTargetIdSchema=z.object({targetId:z.string().trim().min(1).max(200)});
export async function updateStudentSchool(studentId:string,raw:unknown) {
  const {targetId}=schoolTargetIdSchema.parse(raw),input=schoolRegistrationSchema.parse(raw);
  // Resolve ownership before looking up another school's profile or calendar.
  if(!(await query("select id from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null",[targetId,studentId])).length)throw new ApiError(404,'지원 학교를 찾을 수 없어요.');
  const prepared=await prepareSchoolRegistration(input,true),{data}=prepared;
  return transaction(async client=>{
    await client.query('select pg_advisory_xact_lock(hashtext($1))',[`school-register:${studentId}`]);
    const owned=(await client.query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null order by created_at,id for update",[studentId])).rows;
    const current=owned.find(row=>row.id===targetId);
    if(!current)throw new ApiError(404,'지원 학교를 찾을 수 없어요.');
    if(owned.some(row=>row.id!==targetId&&sameSchoolRegistrationTarget(row.data,data)))throw new ApiError(409,'이미 등록한 지원 학교·학과·전형이에요. 기존 등록을 확인해 주세요.');
    const identityChanged=!sameSchoolRegistrationTarget(current.data,data),next={...current.data};
    if(identityChanged){
      // Historical sessions keep their own target snapshots. An old appointment or
      // embedded school profile must not become an appointment for a new identity.
      for(const key of ['schedule','interview_date','interview_at','school_interview_date','admission_calendar_registration','interview_stage','stage','year','track','profile','talentProfile','majorContext','school_logo_url','school_admission_url','school_directory_url','school_website_url'])delete next[key];
    }
    Object.assign(next,data,{updated_at:new Date().toISOString()});
    const result=(await client.query('update support_targets set data=$1::jsonb where id=$2 and student_id=$3 returning id,data',[JSON.stringify(next),targetId,studentId])).rows[0];
    await saveSchoolSelection(client,studentId,targetId);
    await client.query("insert into audit_logs(actor_id,student_id,action,data) values($1,$1,'school.self_update',$2)",[studentId,JSON.stringify({targetId,identityChanged,before:current.data,after:next})]);
    return registrationView(result,prepared);
  });
}
export async function archiveStudentSchool(studentId:string,raw:unknown) {
  const {targetId}=schoolTargetIdSchema.parse(raw);
  return transaction(async client=>{
    await client.query('select pg_advisory_xact_lock(hashtext($1))',[`school-register:${studentId}`]);
    const current=(await client.query('select id,data from support_targets where id=$1 and student_id=$2 for update',[targetId,studentId])).rows[0];
    if(!current)throw new ApiError(404,'지원 학교를 찾을 수 없어요.');
    if(!current.data.archived_at){
      const archivedAt=new Date().toISOString();
      await client.query('update support_targets set data=$1::jsonb where id=$2 and student_id=$3 returning id,data',[JSON.stringify({...current.data,archived_at:archivedAt}),targetId,studentId]);
      await client.query("insert into audit_logs(actor_id,student_id,action,data) values($1,$1,'school.self_archive',$2)",[studentId,JSON.stringify({targetId,archivedAt,university:current.data.university})]);
    }
    const remaining=(await client.query("select id from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null order by created_at,id",[studentId])).rows;
    const preferences=(await client.query('select data from student_preferences where student_id=$1',[studentId])).rows[0]?.data||{};
    const selectedTargetId=remaining.find(row=>row.id===preferences.selectedTargetId)?.id||remaining[0]?.id||null;
    // Empty selections are valid after onboarding. Removing the last school is
    // reversible and must not lock a student inside the first-registration gate.
    await saveSchoolSelection(client,studentId,selectedTargetId);
    return {targetId,selectedTargetId};
  });
}
/** Reading a published bank revision is independent of an active registration.
 * Callers must separately prove ownership before using it for school history. */
async function publishedCommonQuestionRows(referenceId:string|null,revision?:number){
  return query("select * from (select distinct on(id) * from common_interview_questions where ($2::int is null or revision=$2) order by id,revision desc) q where status='published' and (school_reference_id is null or school_reference_id=$1) order by (school_reference_id is null),id",[referenceId,revision ?? null]);
}
export async function commonInterviewQuestions(studentId: string, targetId: string | null = null, revision?:number) {
  let referenceId: string | null = null;
  let selectedTarget:Record<string,any>|null=null;
  if (targetId) {
    const [target] = await query("select data from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null",[targetId,studentId]);
    if (!target) throw new ApiError(404,'지원 학교를 찾을 수 없어요.');
    referenceId = target.data.school_reference_id || null;
    selectedTarget=target.data;
  }
  if(selectedTarget&&revision===undefined&&!interviewSupportForTarget(selectedTarget).supported)return [];
  if(selectedTarget&&(revision===undefined||revision===1)){
    const departmentQuestions=departmentPracticeQuestions(selectedTarget);
    if(departmentQuestions.length)await query("insert into common_interview_questions(id,revision,prompt,source_type,status,school_reference_id,data,source) select item->>'id',1,item->>'prompt','general_practice','published',item->>'school_reference_id',item,item->'source_snapshot' from jsonb_array_elements($1::jsonb) item on conflict(id,revision) do nothing",[JSON.stringify(departmentQuestions)]);
  }
  const rows = await publishedCommonQuestionRows(referenceId,revision);
  return rows.filter(row=>(revision!==undefined||isStudentRecordQuestion({...row.data,prompt:row.prompt}))&&(!row.data?.department_context||selectedTarget&&departmentQuestionMatchesTarget(row.data,selectedTarget))&&(!row.data?.talent_profile || selectedTarget && talentQuestionMatchesTarget(row.data,selectedTarget))).map(row => ({ ...row.data,id:row.id,prompt:row.prompt,source_type:row.source_type,common_revision:row.revision,verification_status:'published',
    support_target_ids:row.school_reference_id && targetId ? [targetId] : [], source_snapshot:row.source, school_reference_id:row.school_reference_id,
    ...(row.data?.talent_profile && selectedTarget?{talent_context:{...schoolMajorContext(selectedTarget),
      talentProfileId:row.data.talent_profile.id,talentProfileRevision:row.data.talent_profile.revision,
      talentPointId:row.data.talent_profile.point.id,talentScope:row.data.talent_profile.scope,
      personalEvidence:'approved_activity_only',withoutExperience:'future_plan',questionBasis:'training'}}:{}),
    practice_label:row.data?.department_context?'학과 개념 연결 연습':row.data?.talent_profile ? (row.data.talent_profile.definitionKind==='education_goal'?'공식 교육목표 기반 연습':row.data.talent_profile.definitionKind==='core_competencies'?'공식 핵심역량 기반 연습':'공식 인재상 기반 연습') : row.source_type === 'book_reference' ? '자료 기반 일반 연습' : row.source_type === 'verified_past' ? '검수한 공통 기출' : '일반 연습' }));
}
export async function assertCommonAccess(studentId: string, context: { ownerStudentId?: string; targetId?: string|null; questions: { id:string; common_revision?:unknown }[] }) {
  if (context.ownerStudentId !== studentId) throw new ApiError(404,'자료를 찾을 수 없어요.');
  if (context.targetId && !(await query('select id from support_targets where id=$1 and student_id=$2',[context.targetId,studentId])).length) throw new ApiError(404,'자료를 찾을 수 없어요.');
  // Versions are fixed at start; catalog updates do not rewrite a student's old session.
  const common = context.questions.filter(q => q.common_revision !== undefined);
  const rows = await query('select id,revision from common_interview_questions where id=any($1::text[])',[common.map(q => q.id)]);
  if (common.some(q => !rows.some(row => row.id === q.id && Number(row.revision) === Number(q.common_revision)))) throw new ApiError(404,'자료를 찾을 수 없어요.');
}
export async function interviewLearningHistory(studentId: string,targetId?:string|null) {
  if(targetId){
    const [target]=await query('select id,data from support_targets where id=$1 and student_id=$2',[targetId,studentId]);
    if(!target)throw new ApiError(404,'지원 학교를 찾을 수 없어요.');
    const [turns,attempts,common]=await Promise.all([
      query("select t.question_id,t.data,coalesce((t.data->>'answeredAt')::timestamptz,t.created_at) as last_at,s.data->'context'->'target' as target_snapshot from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id where t.student_id=$1 and s.target_id=$2 and coalesce(t.data->>'answer','')<>'' and coalesce(t.data->>'invalidated','false')!='true'",[studentId,targetId]),
      query('select memory_item_id,rating,due_at,created_at,data from memory_attempts where student_id=$1 order by created_at,id',[studentId]),
      publishedCommonQuestionRows(target.data.school_reference_id || null).then(rows=>rows.filter(row=>!row.data?.talent_profile || talentQuestionMatchesTarget(row.data,target.data))),
    ]);
    const revisions=new Map(common.map(question=>[question.id,Number(question.revision)]));
    const revisionMatches=(questionId:string,revision:unknown)=>revision===null || revision===undefined || revisions.get(questionId)===Number(revision);
    const currentIdentity=schoolQuizTargetIdentity({...target.data,id:target.id})!;
    const snapshotMatches=(snapshot:Record<string,any>)=>schoolLearningIdentityMatches(schoolQuizTargetIdentity({...snapshot,id:target.id})!,currentIdentity);
    const grouped=new Map<string,{question_id:string;last_at:string|Date;count:number}>();
    for(const turn of turns){
      if(!turn.target_snapshot || !snapshotMatches(turn.target_snapshot) || !revisionMatches(turn.question_id,turn.data.commonRevision))continue;
      const old=grouped.get(turn.question_id);
      grouped.set(turn.question_id,{question_id:turn.question_id,last_at:old && new Date(old.last_at)>new Date(turn.last_at)?old.last_at:turn.last_at,count:(old?.count || 0)+1});
    }
    const latestAttempts=new Map<string,Record<string,any>>();
    for(const attempt of attempts){
      const snapshot=attempt.data?.target_snapshot,questionId=attempt.data?.question_id || attempt.data?.practice_question_id || '';
      if(attempt.data?.target_id!==targetId || !snapshot || !snapshotMatches(snapshot) || !revisionMatches(questionId,attempt.data?.common_revision))continue;
      latestAttempts.set(attempt.memory_item_id,{...attempt,question_id:questionId});
    }
    return {answers:[...grouped.values()],attempts:[...latestAttempts.values()]};
  }
  const [rows,attempts] = await Promise.all([
    query("select question_id,max(coalesce((data->>'answeredAt')::timestamptz,created_at)) as last_at,count(*)::int as count from interview_turns where student_id=$1 and coalesce(data->>'answer','')<>'' and coalesce(data->>'invalidated','false')!='true' group by question_id",[studentId]),
    query('select distinct on(memory_item_id) memory_item_id,rating,due_at,created_at,data from memory_attempts where student_id=$1 order by memory_item_id,created_at desc,id desc',[studentId]),
  ]);
  return { answers:rows, attempts };
}
