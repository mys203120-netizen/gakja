import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { answerComparison, evaluateQuizResponse, FACT_CONFIRMATION_STATUSES, hashLearningData, learningTargetIdentityMatches, publicQuizItem, quizSnapshotItem, schoolProfileIdentityMatches, SCHOOL_PROFILE_STATUSES, validateSchoolProfile, type LearningData, type QuizResponse, type QuizSnapshotItem } from '@gakja/content-contracts';
import type { Profile } from './auth';
import { getLearning } from './data';
import { ApiError, query, transaction } from './db';
import { recordStudyEvent } from './study-sessions';
import { answerAssistance, quizAnswerContext } from './learning-record-rules';
import { commonInterviewQuestions } from './school-learning';
import { quizSchoolMetadata, schoolQuizItems, schoolQuizTargetIdentity } from './school-quiz';
import {readStudentModel} from './student-read-model';
import {recordMatchesCurrentTarget} from './learning-target-scope';
import {getLearningHistoryPage,type LearningHistoryOptions} from './learning-history';
export {getLearningHistoryPage} from './learning-history';

const uuid = z.string().uuid();
const identifier = z.string().trim().min(1).max(160);
const note = z.string().trim().max(10_000);
const requestId = z.string().trim().min(8).max(160);
const dateTime = z.string().datetime({ offset: true });
const confirmationStatus = z.enum(FACT_CONFIRMATION_STATUSES);
const requestSchema = z.object({ action: identifier, requestId: requestId.optional() }).passthrough();
const range = z.object({ min: z.number().nonnegative(), max: z.number().nonnegative() }).nullable();
const schoolSchema = z.object({
  admission_year: z.number().int().min(2000).max(2100), university: identifier, campus: identifier, department: identifier,
  admission_type: identifier, interview_stage: identifier,
  format: z.enum(['document_individual','presentation','mmi','group','other','unknown']), interview_conducted: z.boolean().nullable(),
  interviewer_count: range, applicant_count: range, preparation_minutes: range, interview_minutes: range,
  admission_interview_weight: z.number().min(0).max(100).nullable(),
  evaluation_weights: z.array(z.object({ element: identifier, weight: z.number().min(0).max(100) })).max(20),
  question_distribution: z.object({ basis: z.enum(['official','sample','training']), unit: z.enum(['root_question_count','time']),
    buckets: z.array(z.object({ id: identifier, label: identifier, weight: z.number().nonnegative() })).min(1).max(20),
    includes_followups: z.boolean(), sample_size: z.number().int().positive().optional(),
  }).nullable(), blind_rules: note.optional(), training_panelist_count: z.number().int().min(1).max(5).optional(),
});
const provenanceSchema = z.object({ source_url: z.string().max(2_000).nullable(), page: z.string().max(100).nullable(),
  document_title: z.string().max(500).nullable(), applicable_year: z.number().int().min(2000).max(2100),
  published_at: z.string().max(50).nullable(), checked_at: z.string().max(50).nullable(), review_note: note,
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, '입력 항목과 형식을 확인해 주세요.');
  return result.data;
}
async function assertStudentScope(user: Profile, studentId: string, staffOnly = false, db?: PoolClient) {
  const read = async (sql: string, params: unknown[]) => db ? (await db.query(sql,params)).rows : query(sql,params);
  if (staffOnly && user.role === 'student') throw new ApiError(403, '담당자 검수가 필요한 작업이에요.');
  if (user.role === 'student') {
    if (user.id !== studentId) throw new ApiError(403, '내 자료만 확인할 수 있어요.');
    return;
  }
  if (user.role === 'staff') {
    const [assignment] = await read("select student_id from staff_assignments where staff_id=$1 and student_id=$2 and permissions @> '[\"review\"]'::jsonb", [user.id,studentId]);
    if (!assignment) throw new ApiError(403, '배정된 학생의 검수 업무만 처리할 수 있어요.');
  }
  const [student] = await read("select id from profiles where id=$1 and role='student' and active=true", [studentId]);
  if (!student) throw new ApiError(404, '학생을 찾을 수 없어요.');
}
const learningAsData = (learning: unknown) => learning as LearningData;
const currentConfirmationStatus = (row: any) => row.confirmation_status ?? row.data?.confirmation_status
  ?? (({ confirmed:'confirmed_by_student', different:'student_says_different', unknown:'needs_confirmation', cannot_confirm:'cannot_confirm' } as Record<string,string>)[row.state] ?? 'needs_confirmation');
export function safeAssignment(row: any, attempts: any[] = [], events: any[] = [], learning?:LearningData) {
  return { ...row, items: (row.items as any[]).map(saved => {const item=learning&&!saved.question_snapshot&&row.source_kind!=='common'?personalTaskItem(saved,learning,row.content_version):saved;return {...publicQuizItem(item),...quizSchoolMetadata(item),sourceQuotes:item.sourceQuotes||[],question_snapshot:item.question_snapshot||null,followup_questions:item.followup_questions||[],activity_snapshots:item.activity_snapshots||[],activity_snapshot:item.activity_snapshot||null,activity_content_version:item.activity_content_version||null};}), attempts: attempts.filter(a => a.assignment_id === row.id),
    history:events.filter(e => e.assignment_id === row.id),reviewHistory:events.filter(e => e.assignment_id === row.id && e.state === 'reviewed') };
}
function schoolMatchesTarget(profile: any, target: any) {
  if (!target || profile.student_id !== target.student_id) return false;
  return schoolProfileIdentityMatches(profile.data ?? {},target.data ?? {});
}
function profileView(profile: any, targets: any[]) {
  const stale = !schoolMatchesTarget(profile,targets.find(t => t.id === profile.target_id));
  return {...profile,stale,declared_status:profile.status,status:stale?'needs_confirmation':profile.status};
}
function latestProfileViews(profiles: any[], targets: any[]) {
  const seen = new Set<string>();
  return profiles.filter(p => { const key=`${p.student_id}:${p.target_id}`;if(seen.has(key))return false;seen.add(key);return true; })
    .map(p => ({...profileView(p,targets),history:profiles.filter(v => v.student_id===p.student_id && v.target_id===p.target_id).map(v => profileView(v,targets))}));
}

export async function getSchoolProfile(studentId: string, targetId: string) {
  const [row] = await query("select p.*,t.data as target_data from school_profiles p join support_targets t on t.id=p.target_id and t.student_id=p.student_id where p.student_id=$1 and p.target_id=$2 and nullif(t.data->>'archived_at','') is null order by p.revision desc limit 1", [studentId,targetId]);
  if (!row || !schoolMatchesTarget(row,{student_id:studentId,data:row.target_data})) return null;
  const {target_data:unused,...profile}=row; void unused;
  return {...profile,stale:false};
}

async function buildLearningOverview(user: Profile, requestedStudentId?: string) {
  if (user.role !== 'student' && !requestedStudentId) {
    const students = await query("select id,name,email from profiles where role='student' and active=true and ($1::text='admin' or id in(select student_id from staff_assignments where staff_id=$2 and permissions @> '[\"review\"]'::jsonb)) order by name", [user.role,user.id]);
    const ids = students.map(s => s.id);
    const [targets, assignments, submissions, schoolProfiles, confirmations, events] = await Promise.all([
      query('select * from support_targets where student_id=any($1::uuid[]) order by id', [ids]),
      query('select * from quiz_assignments where student_id=any($1::uuid[]) order by created_at desc', [ids]),
      query('select * from quiz_submissions where student_id=any($1::uuid[]) order by submitted_at desc', [ids]),
      query('select s.*,p.name as reviewer_name from school_profiles s join profiles p on p.id=s.reviewed_by where s.student_id=any($1::uuid[]) order by s.student_id,s.target_id,s.revision desc', [ids]),
      query('select * from student_confirmations where student_id=any($1::uuid[]) order by updated_at desc', [ids]),
      query('select e.*,p.name as actor_name from quiz_assignment_events e join profiles p on p.id=e.actor_id where e.student_id=any($1::uuid[]) order by e.created_at desc', [ids]),
    ]);
    return { students, targets:targets.map(t => ({...t.data,id:t.id,student_id:t.student_id})), assignments:assignments.map(a => safeAssignment(a,submissions,events)), schoolProfiles:latestProfileViews(schoolProfiles,targets),
      confirmations:confirmations.map(c => ({...c,confirmation_status:currentConfirmationStatus(c),data:{...c.data,confirmation_status:currentConfirmationStatus(c)}})), versions:[], answerRevisions:[], memoryItems:[], sources:[], readiness:[] };
  }
  const studentId = requestedStudentId ? parse(uuid,requestedStudentId) : user.id;
  await assertStudentScope(user,studentId);
  const content=await getLearning(studentId);
  const entityIds=[...new Set(['activities','questions','source_refs','memory_items'].flatMap(key=>((content.learning as any)[key]||[]).map((entity:any)=>entity.id)))];
  const [targets, assignments, attempts, confirmations, confirmationHistory, schoolProfiles, preparation, events, archivedContent, practice] = await Promise.all([
    query("select * from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null order by id",[studentId]),
    query('select * from quiz_assignments where student_id=$1 order by created_at desc limit 30',[studentId]),
    query('select * from (select r.*,row_number() over(partition by assignment_id,memory_item_id order by submitted_at desc,id desc) as rn from quiz_submissions r where student_id=$1 and assignment_id in(select id from quiz_assignments where student_id=$1 order by created_at desc limit 30)) r where rn=1',[studentId]),
    query('select distinct on(entity_id) * from student_confirmations where student_id=$1 and entity_id=any($2::text[]) order by entity_id,updated_at desc',[studentId,entityIds]),
    query('select * from (select e.*,row_number() over(partition by confirmation_id order by created_at desc,id desc) as rn from fact_confirmation_events e where student_id=$1 and confirmation_id in(select distinct on(entity_id) id from student_confirmations where student_id=$1 and entity_id=any($2::text[]) order by entity_id,updated_at desc)) e where rn<=20',[studentId,entityIds]),
    query("select distinct on(s.target_id) s.*,p.name as reviewer_name from school_profiles s join profiles p on p.id=s.reviewed_by join support_targets t on t.id=s.target_id and t.student_id=s.student_id where s.student_id=$1 and nullif(t.data->>'archived_at','') is null order by s.target_id,s.revision desc",[studentId]),
    query('select * from preparation_states where student_id=$1 and entity_id=any($2::text[])',[studentId,entityIds]),
    query('select * from (select e.*,p.name as actor_name,row_number() over(partition by assignment_id order by e.created_at desc,e.id desc) as rn from quiz_assignment_events e join profiles p on p.id=e.actor_id where e.student_id=$1 and assignment_id in(select id from quiz_assignments where student_id=$1 order by created_at desc limit 30)) e where rn<=10',[studentId]),
    query("select v.version,v.data from content_versions v join content_packages p on p.id=v.package_id where p.student_id=$1 and v.status='published' and (v.version=p.active_version or v.version in(select content_version from quiz_assignments where student_id=$1 order by created_at desc limit 30))",[studentId]),
    query(`with facts as (
      select s.target_id,t.question_id,s.data->'context'->'target' as snapshot,t.created_at
      from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id
      where t.student_id=$1 and s.state not in ('cancelled','deleted') and coalesce(t.data->>'invalidated','false')<>'true' and nullif(btrim(t.data->>'answer'),'') is not null and s.content_version=(select active_version from content_packages where student_id=$1)
      union all
      select coalesce(r.data->>'targetId',r.data->>'target_id'),a.question_id,coalesce(r.data->'targetSnapshot',r.data->'target_snapshot'),r.created_at
      from answer_revisions r join user_answers a on a.id=r.answer_id where a.student_id=$1 and nullif(btrim(r.script),'') is not null and coalesce(r.data->>'contentVersion',r.data->>'content_version')=(select active_version::text from content_packages where student_id=$1)
    ), scoped as(select target_id,question_id,created_at,jsonb_build_object('university',snapshot->>'university','admission_year',coalesce(snapshot->'admission_year',snapshot->'year'),'campus',snapshot->>'campus','department',coalesce(snapshot->>'department',snapshot->>'major'),'admission_type',coalesce(snapshot->>'admission_type',snapshot->>'track'),'interview_stage',coalesce(snapshot->>'interview_stage',snapshot->>'stage'),'interest_department',snapshot->>'interest_department') as target_snapshot from facts)
    select target_id,question_id,target_snapshot,max(created_at) as created_at from scoped group by target_id,question_id,target_snapshot`,[studentId]),
  ]);
  const learning = learningAsData(content.learning);
  const typedConfirmations=confirmations.map(c=>({...c,confirmation_status:currentConfirmationStatus(c),data:{...c.data,confirmation_status:currentConfirmationStatus(c)},history:confirmationHistory.filter(e=>e.confirmation_id===c.id)}));
  const sourceAt=(version:number|undefined)=>archivedContent.find(row=>row.version===version)?.data as LearningData|undefined;
  const readiness = targets.map(target => {
    const activities = learning.activities.filter(a => a.priority_assignments.some(p => p.support_target_id === target.id && ['S','A'].includes(p.priority)));
    const questions = learning.questions.filter(q => q.support_target_ids.includes(target.id));
    const targetTurns=practice.filter(row=>recordMatchesCurrentTarget(row,[{...target.data,id:target.id}])).sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime());
    const answeredIds=new Set(targetTurns.map(row=>row.question_id));
    const depths = [...new Set(targetTurns.map(t => learning.questions.find(q => q.id === t.question_id)?.depth).filter(Boolean))];
    const needs = typedConfirmations.filter(c => ['needs_confirmation','student_says_different','cannot_confirm'].includes(c.confirmation_status));
    return {target_id:target.id,priority_activity_ids:activities.map(a => a.id),unexplained_activity_ids:activities.filter(a => !questions.some(q => q.activity_ids.includes(a.id) && answeredIds.has(q.id))).map(a => a.id),
      unanswered_question_ids:questions.filter(q => !answeredIds.has(q.id)).map(q => q.id),needs_confirmation_ids:needs.filter(c => activities.some(a => a.id === c.entity_id || a.source_ref_ids.includes(c.entity_id)) || questions.some(q => q.id === c.entity_id)).map(c => c.id),practiced_depths:depths,
      last_practiced_at:targetTurns[0]?.created_at ?? null,self_checked_activity_ids:preparation.filter(p => p.completed && p.stage === 'speech' && activities.some(a => a.id === p.entity_id)).map(p => p.entity_id)};
  });
  return { students:[],targets:targets.map(t => ({...t.data,id:t.id,student_id:t.student_id})),assignments:assignments.map(a => {const target=targets.find(t=>t.id===a.target_id);return {...safeAssignment(a,attempts,events,sourceAt(a.content_version)),target_unchanged:!a.target_snapshot||!!target&&learningTargetIdentityMatches(schoolQuizTargetIdentity(a.target_snapshot)!,schoolQuizTargetIdentity({...target.data,id:target.id})!)};}), confirmations:typedConfirmations,
    versions:[] as any[],answerRevisions:[] as any[],schoolProfiles:latestProfileViews(schoolProfiles,targets),readiness,memoryItems:learning.memory_items.map(m => publicQuizItem(quizSnapshotItem(m,learning))),sources:learning.source_refs,
  };
}

/** Lists and bodies are independently paged; the overview contains full-history aggregate observations. */
export async function getLearningWorkflows(user:Profile,requestedStudentId?:string,options:LearningHistoryOptions={}){
  if(user.role!=='student'&&!requestedStudentId)return buildLearningOverview(user);
  const studentId=requestedStudentId?parse(uuid,requestedStudentId):user.id;
  await assertStudentScope(user,studentId);
  const [overview,history]=await Promise.all([
    readStudentModel(studentId,'learning-overview','v2',()=>buildLearningOverview(user,requestedStudentId)),
    getLearningHistoryPage(user,requestedStudentId,options),
  ]);
  return {...overview,versions:history.versions,answerRevisions:history.versions,versionsPage:history.versionsPage};
}

async function audit(db: PoolClient, actor: string, studentId: string, action: string, data: unknown) {
  await db.query('insert into audit_logs(actor_id,student_id,action,data) values($1,$2,$3,$4)', [actor,studentId,action,JSON.stringify(data)]);
}
async function taskEvent(db: PoolClient, row: any, actorId: string, state: string, data: unknown = {}) {
  await db.query('insert into quiz_assignment_events(assignment_id,student_id,actor_id,state,data) values($1,$2,$3,$4,$5)', [row.id,row.student_id,actorId,state,JSON.stringify(data)]);
}
async function assignmentFor(user: Profile, db: PoolClient, id: string, staffOnly = false) {
  const row = (await db.query('select * from quiz_assignments where id=$1 for update', [id])).rows[0];
  if (!row) throw new ApiError(404,'과제를 찾을 수 없어요.');
  await assertStudentScope(user,row.student_id,staffOnly,db);
  return row;
}
async function requireSnapshot(db: PoolClient, assignment: any) {
  if (assignment.source_kind === 'common') {
    const target = (await db.query('select id from support_targets where id=$1 and student_id=$2',[assignment.target_id,assignment.student_id])).rows[0];
    if (!target || assignment.package_id !== null || assignment.content_version !== 0 || !Array.isArray(assignment.items) || !assignment.items.length) throw new ApiError(409,'과제의 지원 학교와 근거를 확인해 주세요.');
    for (const item of assignment.items) {
      const source = (await db.query('select prompt,source_type,source from common_interview_questions where id=$1 and revision=$2',[item.question_id,item.common_revision])).rows[0];
      if (!source || item.source_kind !== 'common' || item.target_id !== assignment.target_id || hashLearningData(item.target_snapshot) !== hashLearningData(assignment.target_snapshot)
        || item.prompt !== source.prompt || item.source_type !== source.source_type || hashLearningData(item.source_snapshot) !== hashLearningData(source.source)
        || item.evaluation_method !== 'self_check' || item.category !== 'experiential') throw new ApiError(409,'저장된 학교 질문의 근거를 확인해 주세요.');
    }
    return;
  }
  const [row] = (await db.query("select v.version from content_versions v join content_packages p on p.id=v.package_id where v.package_id=$1 and v.version=$2 and v.status='published' and p.student_id=$3 and p.active_version is not null",[assignment.package_id,assignment.content_version,assignment.student_id])).rows;
  if (!row) throw new ApiError(409,'과제의 승인 자료를 더 이상 사용할 수 없어요. 담당자에게 확인해 주세요.');
}

/** Help is an observation about this attempt, never an achievement event. */
export async function recordAssignmentHelp(db: PoolClient, user: Profile, input: {assignmentId:string;itemId:string;helpKind:'evidence'|'ai'|'hint';receiptId?:string;status?:'partial'|'completed'|'interrupted'}) {
  const row=await assignmentFor(user,db,input.assignmentId);
  if(row.student_id!==user.id)throw new ApiError(403,'학생 본인의 과제에서 도움을 확인해 주세요.');
  if(!row.items.some((item:any)=>item.id===input.itemId))throw new ApiError(400,'과제에 있는 항목에서 도움을 확인해 주세요.');
  const status=input.status||'completed';
  if(input.receiptId){
    if(input.helpKind!=='ai'||!uuid.safeParse(input.receiptId).success)throw new ApiError(400,'AI 도움 응답 식별자를 확인해 주세요.');
    const receipt=(await db.query("select id,data from quiz_assignment_events where assignment_id=$1 and student_id=$2 and actor_id=$2 and data->>'kind'='help' and data->>'memory_item_id'=$3 and data->>'help_kind'='ai' and data->>'receipt_id'=$4 for update",[row.id,user.id,input.itemId,input.receiptId])).rows[0];
    if(receipt){
      // An observed response can settle after submission. Never rewrite the saved answer.
      if(receipt.data.status==='partial'&&status!=='partial')await db.query("update quiz_assignment_events set data=data||$2::jsonb where id=$1",[receipt.id,JSON.stringify({status,settled_at:new Date().toISOString()})]);
      return {ok:true,studentId:row.student_id,assignmentId:row.id,itemId:input.itemId,receiptId:input.receiptId,assisted:true};
    }
    if(status==='interrupted')throw new ApiError(409,'실제로 받은 AI 응답의 도움 기록을 확인해 주세요.');
  }
  await requireSnapshot(db,row);
  if(!['assigned','in_progress'].includes(row.state))throw new ApiError(409,'제출한 과제의 도움 기록은 바꾸지 않습니다. 새 과제로 다시 시도해 주세요.');
  if(row.state==='assigned'){await db.query("update quiz_assignments set state='in_progress',updated_at=now() where id=$1",[row.id]);row.state='in_progress';}
  await taskEvent(db,row,user.id,'in_progress',{kind:'help',memory_item_id:input.itemId,help_kind:input.helpKind,...(input.receiptId?{receipt_id:input.receiptId,status}: {})});
  return {ok:true,studentId:row.student_id,assignmentId:row.id,itemId:input.itemId,assisted:true};
}

/** Validate an assistant's paid request before model input is built. */
export async function getAssignmentHelpContext(user: Profile, assignmentId: string, itemId: string) {
  return transaction(async db=>{
    const row=await assignmentFor(user,db,assignmentId);
    if(row.student_id!==user.id)throw new ApiError(403,'학생 본인의 과제에서 도움을 확인해 주세요.');
    await requireSnapshot(db,row);
    if(!['assigned','in_progress'].includes(row.state))throw new ApiError(409,'제출한 과제는 새 과제로 다시 시도해 주세요.');
    const item=row.items.find((item:any)=>item.id===itemId);
    if(!item)throw new ApiError(400,'과제에 있는 항목을 선택해 주세요.');
    return {questionId:item.question_id,targetId:row.target_id||null,targetSnapshot:row.target_snapshot||null,contentVersion:row.content_version,
      packageId:row.package_id||null,sourceType:row.source_kind==='common'?'common' as const:'personal' as const,
      sourceVersion:row.source_kind==='common'?item.common_revision:row.content_version};
  });
}
async function learningFromDb(db: PoolClient, studentId: string) {
  const [row] = (await db.query("select p.id,p.active_version,v.data from content_packages p join content_versions v on v.package_id=p.id and v.version=p.active_version and v.status='published' where p.student_id=$1",[studentId])).rows;
  if (!row) throw new ApiError(409,'발행된 자료가 있어야 학습 작업을 진행할 수 있어요.');
  return {learning:learningAsData(row.data),package:{id:row.id,active_version:row.active_version}};
}

function personalTaskItem(item: QuizSnapshotItem, learning: LearningData, version: number) {
  const question = learning.questions.find(q => q.id === item.question_id);
  const activityIds=item.activity_ids||[];
  const sourceIds=[...new Set([...(item.source_ref_ids||[]),...(question?.source_ref_ids||[]),...learning.activities.filter(a=>activityIds.includes(a.id)).flatMap(a=>a.source_ref_ids||[])])];
  return {...item,question_snapshot:question ? structuredClone(question) : null,
    followup_questions:(question?.followup_question_ids||[]).flatMap(id=>{const q=learning.questions.find(q=>q.id===id);return q?[structuredClone(q)]:[];}),
    activity_snapshots:activityIds.flatMap(id=>{const activity=learning.activities.find(a=>a.id===id);return activity?[structuredClone(activity)]:[];}),
    activity_content_version:version,sourceQuotes:sourceIds.flatMap(id=>{const source=learning.source_refs.find(s=>s.id===id);return source?.quote?[{id,text:source.quote,area:source.area,page:source.page}]:[];})};
}

/** Derive a remedial task exclusively from the report's owned, immutable interview context. */
async function reportTask(db: PoolClient, studentId: string, reportId: string, selection: {questionId?:string;memoryItemIds?:string[];targetId?:string}) {
  const saved=(await db.query('select r.id,r.data as report_data,s.id as session_id,s.target_id,s.content_version,s.data as session_data from interview_reports r join interview_sessions s on s.id=r.session_id and s.student_id=r.student_id where r.id=$1 and r.student_id=$2 for share of r,s',[reportId,studentId])).rows[0];
  if(!saved)throw new ApiError(404,'내 면접 리포트만 연결할 수 있어요.');
  if(selection.targetId&&selection.targetId!==saved.target_id)throw new ApiError(409,'리포트에서 연습한 지원처로 다시 말해 주세요.');
  const context=saved.session_data?.context||{},targetSnapshot=context.target ? structuredClone(context.target) : null;
  if(saved.target_id && !(await db.query('select id from support_targets where id=$1 and student_id=$2',[saved.target_id,studentId])).rows.length)throw new ApiError(409,'리포트의 지원처 소유 정보를 확인해 주세요.');
  const version=(await db.query("select v.data,p.id from content_versions v join content_packages p on p.id=v.package_id where p.student_id=$1 and v.version=$2 and v.status='published' and ($3::text is null or p.id=$3)",[studentId,saved.content_version,context.packageId&&context.packageId!=='common-bank'?context.packageId:null])).rows[0];
  const learning=version?.data as LearningData|undefined;
  const requested=selection.questionId ? [selection.questionId] : selection.memoryItemIds?.map(id=>learning?.memory_items.find(m=>m.id===id)?.question_id);
  if(!requested?.length||requested.some(id=>!id))throw new ApiError(409,'당시 리포트의 질문을 선택해 주세요.');
  const ids=[...new Set(requested as string[])];
  const turns=(await db.query('select id,question_id,data from interview_turns where session_id=$1 and student_id=$2 order by created_at,id',[saved.session_id,studentId])).rows;
  const selected=ids.map(questionId=>{
    const turn=turns.find(t=>t.question_id===questionId&&typeof t.data?.answer==='string'&&t.data.answer.trim()&&!t.data.invalidated&&(saved.report_data.sections||[]).some((s:any)=>s.questionId===questionId&&(s.turnId?t.id===s.turnId:(s.answer||s.response)===t.data.answer&&s.question===t.data.question)));
    if(!turn)throw new ApiError(409,'이 리포트에서 실제 답한 질문을 선택해 주세요.');
    return turn;
  });
  const common=selected.every(t=>t.data?.commonRevision&&t.data.sourceType&&t.data.sourceType!=='personal');
  if(selected.some(t=>Boolean(t.data?.commonRevision&&t.data.sourceType&&t.data.sourceType!=='personal'))&&!common)throw new ApiError(400,'학교 질문과 학생부 질문은 각각 다시 말하기 과제로 담아 주세요.');
  if(common){
    if(!saved.target_id||!targetSnapshot)throw new ApiError(409,'당시 학교 질문의 지원처를 확인해 주세요.');
    const questions=selected.map(turn=>{
      const q=context.questions?.find((q:any)=>q.id===turn.question_id);
      if(!q||q.prompt!==turn.data.question)throw new ApiError(409,'당시 검수된 학교 질문을 확인해 주세요.');
      return {...structuredClone(q),common_revision:turn.data.commonRevision,source_type:turn.data.sourceType,source_snapshot:structuredClone(turn.data.sourceSnapshot||q.source_snapshot||{})};
    });
    const items=questions.flatMap(q=>{
      const activity=context.activities?.find((a:any)=>q.activity_ids?.includes(a.id))||null;
      return schoolQuizItems([q],targetSnapshot,{activity,sourceRefs:context.sources||[]}).map(item=>({...item,target_id:saved.target_id,target_snapshot:targetSnapshot,question_snapshot:q,followup_questions:[],activity_snapshot:item.activity_ids.length?structuredClone(activity):null,activity_content_version:item.activity_ids.length?saved.content_version:null}));
    });
    const sourceSnapshot={report_id:reportId,session_id:saved.session_id,turn_ids:selected.map(t=>t.id),questions:items.map(item=>({questionId:item.question_id,...quizSchoolMetadata(item)}))};
    return {items,packageId:null,contentVersion:0,sourceKind:'common',targetId:saved.target_id,targetSnapshot,sourceSnapshot};
  }
  if(!learning||!version)throw new ApiError(409,'리포트의 당시 발행 자료를 확인할 수 없어요. 현재 자료로 바꾸어 배정하지 않습니다.');
  const items=selected.flatMap(turn=>{
    const question=learning.questions.find(q=>q.id===turn.question_id);
    if(!question||question.prompt!==turn.data.question)throw new ApiError(409,'당시 검수된 질문을 확인할 수 없어요. 생성된 꼬리질문은 면접 기록에서 다시 확인해 주세요.');
    const approved=['approved','verified','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student'];
    if(!approved.includes(question.verification_status))throw new ApiError(409,'검수된 당시 질문으로 다시 말하기 과제를 만들 수 있어요.');
    const authored=learning.memory_items.filter(m=>m.question_id===question.id&&approved.includes(m.verification_status)&&m.evaluation_method==='self_check'&&!['choice','order'].includes(m.kind)&&(!selection.memoryItemIds||selection.memoryItemIds.includes(m.id)));
    const source=authored.length?authored:[{id:`report_recall_${turn.id}`,question_id:question.id,kind:'short_speech' as const,answer_script_id:null,activity_ids:question.activity_ids,prompt:question.prompt,memory_keywords:question.answer_elements,default_time_limit_seconds:60,evaluation_method:'self_check' as const,source_ref_ids:question.source_ref_ids,verification_status:question.verification_status}];
    return source.map(item=>personalTaskItem(quizSnapshotItem(item,learning),learning,saved.content_version));
  });
  return {items,packageId:version.id,contentVersion:saved.content_version,sourceKind:'personal',targetId:saved.target_id||null,targetSnapshot,
    sourceSnapshot:{report_id:reportId,session_id:saved.session_id,turn_ids:selected.map(t=>t.id),package_id:version.id,content_version:saved.content_version,question_ids:ids}};
}

export async function learningAction(user: Profile, raw: unknown) {
  const input = parse(requestSchema,raw);
  const aliases: Record<string,string> = {quiz_assign:'assignment_create',quiz_review:'assignment_review'};
  const action = aliases[input.action] ?? input.action;
  const key = input.requestId ?? (['assignment_start','confirmation_respond'].includes(action) ? randomUUID() : undefined);
  if (!key) throw new ApiError(400,'요청 식별자가 필요해요.');
  const fingerprint = hashLearningData({...input,action});
  return transaction(async db => {
    await db.query('select pg_advisory_xact_lock(hashtext($1))',[`learning:${user.id}:${action}:${key}`]);
    const [cached] = (await db.query('select fingerprint,result from learning_requests where actor_id=$1 and action=$2 and request_id=$3',[user.id,action,key])).rows;
    if (cached) { if (cached.fingerprint !== fingerprint) throw new ApiError(409,'같은 요청 식별자로 다른 내용을 제출할 수 없어요.'); await assertStudentScope(user,cached.result.studentId,false,db); return cached.result; }
    const result = await mutate(user,db,action,input);
    await db.query('insert into learning_requests(actor_id,student_id,action,request_id,fingerprint,result) values($1,$2,$3,$4,$5,$6)',[user.id,result.studentId,action,key,fingerprint,JSON.stringify(result)]);
    return result;
  });
}

async function mutate(user: Profile, db: PoolClient, action: string, input: Record<string,unknown>): Promise<any> {
  if(action==='answer_meaning_check'){
    if(user.role!=='student')throw new ApiError(403,'답변의 자기 점검은 학생 본인이 남겨 주세요.');
    const p=parse(z.object({versionId:identifier,checkedMeanings:z.array(z.string().trim().min(1).max(1_000)).max(30)}),input);
    const versions=(await getLearningWorkflows(user)).versions||[];
    const saved=versions.find((version:any)=>version.id===p.versionId);
    if(!saved)throw new ApiError(404,'내가 저장한 답변을 선택해 주세요.');
    if(saved.source_status!=='saved')throw new ApiError(409,'당시 질문의 기준을 확인할 수 없어요.');
    const meanings=(saved.comparison?.required_meanings||[]).map((m:any)=>m.text);
    const checkedMeanings=[...new Set(p.checkedMeanings)];
    if(checkedMeanings.some(text=>!meanings.includes(text)))throw new ApiError(400,'당시 질문의 자기 점검 요소만 선택해 주세요.');
    await db.query('insert into student_preferences(student_id) values($1) on conflict(student_id) do nothing',[user.id]);
    const preferences=(await db.query('select data from student_preferences where student_id=$1 for update',[user.id])).rows[0];
    const checks={...preferences.data?.answer_meaning_checks,[p.versionId]:{checkedMeanings,checkedAt:new Date().toISOString(),questionId:saved.question_id,targetId:saved.target_id||null,contentVersion:saved.content_version||null,basis:'student_self_check'}};
    const retained=Object.fromEntries(Object.entries(checks).sort((a:any,b:any)=>String(b[1].checkedAt||'').localeCompare(String(a[1].checkedAt||''))).slice(0,500));
    await db.query("update student_preferences set data=jsonb_set(data,'{answer_meaning_checks}',$2::jsonb,true),updated_at=now() where student_id=$1",[user.id,JSON.stringify(retained)]);
    return {ok:true,studentId:user.id,versionId:p.versionId,selfCheck:checks[p.versionId],selfCheckOnly:true};
  }
  if(action==='assignment_help'){
    const p=parse(z.object({assignmentId:uuid,itemId:identifier,helpKind:z.enum(['evidence','ai','hint'])}),input);
    // Only a successful owned assistant response may register AI help (chat endpoint).
    if(p.helpKind==='ai')throw new ApiError(400,'AI 응답이 완료되면 도움 기록을 연결합니다.');
    return recordAssignmentHelp(db,user,p);
  }
  if (action === 'assignment_create') {
    const p = parse(z.object({studentId:uuid.optional(),memoryItemIds:z.array(identifier).min(1).max(30).optional(),questionIds:z.array(identifier).min(1).max(30).optional(),questionId:identifier.optional(),targetId:identifier.optional(),activityId:identifier.optional(),title:z.string().trim().min(1).max(200).optional(),dueAt:dateTime.nullable().optional(),parentAssignmentId:uuid.optional(),reportId:uuid.optional()}).refine(p=>p.reportId ? !p.questionIds&&!p.activityId&&Boolean(p.memoryItemIds)!==Boolean(p.questionId) : !p.questionId&&Boolean(p.memoryItemIds)!==Boolean(p.questionIds)&&(!p.questionIds||Boolean(p.targetId))&&(!p.activityId||Boolean(p.questionIds))),input);
    const studentId = p.studentId ?? user.id; await assertStudentScope(user,studentId,false,db);
    const requestedIds = p.questionIds || p.memoryItemIds || [p.questionId!];
    if (new Set(requestedIds).size !== requestedIds.length) throw new ApiError(400,'중복 항목은 한 번만 배정해 주세요.');
    let parent:any=null;
    if (p.parentAssignmentId) { parent = await assignmentFor(user,db,p.parentAssignmentId); if (parent.student_id !== studentId) throw new ApiError(400,'다른 학생의 재훈련 과제를 연결할 수 없어요.'); await requireSnapshot(db,parent); if(p.reportId&&p.reportId!==parent.report_id||p.targetId&&p.targetId!==parent.target_id)throw new ApiError(409,'부모 과제의 리포트와 지원처를 유지해 주세요.'); }
    let target:any=null;
    if (p.targetId) {
      const targetRow=(await db.query("select id,data from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null for share",[p.targetId,studentId])).rows[0];
      if (!targetRow) throw new ApiError(404,'내 지원 학교를 선택해 주세요.');
      target={...targetRow.data,id:targetRow.id};
    }
    let items:QuizSnapshotItem[],packageId:string|null=null,contentVersion=0;
    let sourceKind=p.questionIds?'common':'personal',targetSnapshot=schoolQuizTargetIdentity(target),targetId=target?.id||null,sourceSnapshot:Record<string,any>={};
    if(parent){
      items=parent.items.filter((item:any)=>requestedIds.includes(p.questionIds||p.questionId?item.question_id:item.id));
      if(!items.length||requestedIds.some(id=>!items.some(item=>id===(p.questionIds||p.questionId?item.question_id:item.id))))throw new ApiError(400,'부모 과제에 있는 항목만 다시 배정해 주세요.');
      packageId=parent.package_id;contentVersion=parent.content_version;sourceKind=parent.source_kind||'personal';targetId=parent.target_id||null;targetSnapshot=parent.target_snapshot||null;sourceSnapshot=structuredClone(parent.source_snapshot||{});
    } else if(p.reportId){
      const original=await reportTask(db,studentId,p.reportId,p);
      ({items,packageId,contentVersion,sourceKind,targetId,targetSnapshot,sourceSnapshot}=original);
    } else if (p.questionIds) {
      const common=await commonInterviewQuestions(studentId,p.targetId!);
      const selected=p.questionIds.map(id=>{const question=common.find(question=>question.id===id);if(!question)throw new ApiError(404,'선택한 학교의 공개 질문을 찾을 수 없어요.');return question;});
      let activity:any=null,sourceRefs:any[]=[],activityContentVersion:number|null=null;
      if (p.activityId) {
        const {learning,package:pack}=await learningFromDb(db,studentId);
        activity=learning.activities.find(item=>item.id===p.activityId && ['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student'].includes(item.fact_confirmation));
        if(!activity)throw new ApiError(404,'확인된 내 활동을 선택해 주세요.');
        sourceRefs=learning.source_refs;
        activityContentVersion=pack.active_version;
      }
      items=schoolQuizItems(selected,target,{activity,sourceRefs}).map(item=>({...item,activity_snapshot:item.activity_ids.length?structuredClone(activity):null,activity_content_version:item.activity_ids.length?activityContentVersion:null}));
    } else {
      const {learning,package:pack}=await learningFromDb(db,studentId);
      packageId=pack.id;contentVersion=pack.active_version;
      items=p.memoryItemIds!.map(id=>{const item=learning.memory_items.find(m=>m.id===id);if(!item)throw new ApiError(404,'승인된 암기 항목을 찾을 수 없어요.');return personalTaskItem(quizSnapshotItem(item,learning),learning,contentVersion);});
    }
    // Historical tasks keep their frozen sources, but a removed school cannot
    // silently become the scope of a newly assigned practice task.
    if(targetId&&!(await db.query("select id from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null for share",[targetId,studentId])).rows.length)throw new ApiError(409,'삭제한 지원 학교에는 새 과제를 만들 수 없어요. 지원 학교를 다시 등록해 주세요.');
    if(sourceKind==='common'&&!sourceSnapshot.questions)sourceSnapshot={...sourceSnapshot,questions:items.map(item=>({questionId:item.question_id,...quizSchoolMetadata(item as any)}))};
    const row = (await db.query('insert into quiz_assignments(student_id,assigned_by,title,package_id,content_version,items,due_at,parent_assignment_id,report_id,source_kind,target_id,target_snapshot,source_snapshot) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *',[studentId,user.id,p.title ?? (p.reportId ? '면접 후 다시 떠올리기' : sourceKind==='common'?'학교 질문 다시 말하기':'학생부 퀴즈'),packageId,contentVersion,JSON.stringify(items),p.dueAt ?? null,p.parentAssignmentId ?? null,p.reportId ?? parent?.report_id ?? null,sourceKind,targetId,JSON.stringify(targetSnapshot),JSON.stringify(sourceSnapshot)])).rows[0];
    await requireSnapshot(db,row);
    await taskEvent(db,row,user.id,'assigned',{source_kind:sourceKind,target_id:targetId}); await audit(db,user.id,studentId,'assignment.create',{id:row.id,item_ids:items.map(item=>item.id),question_ids:p.questionIds||p.questionId&&[p.questionId]||null,content_version:contentVersion,source_kind:sourceKind,target_id:targetId});
    if (user.id !== studentId) await db.query("insert into notifications(student_id,title,body,href) values($1,'새 과제가 도착했어요.',$2,$3)",[studentId,row.title,`/quiz/assignments/${row.id}`]);
    return {ok:true,studentId,assignment:safeAssignment(row)};
  }
  if (action === 'assignment_start') {
    const p = parse(z.object({assignmentId:uuid}),input), row = await assignmentFor(user,db,p.assignmentId);
    if (user.id !== row.student_id) throw new ApiError(403,'학생 본인이 과제를 시작해 주세요.');
    await requireSnapshot(db,row);
    if (row.state === 'assigned') { await db.query("update quiz_assignments set state='in_progress',updated_at=now() where id=$1",[row.id]); await taskEvent(db,row,user.id,'in_progress'); row.state='in_progress'; }
    return {ok:true,studentId:row.student_id,assignment:safeAssignment(row)};
  }
  if (action === 'assignment_submit') {
    const responseSchema = z.object({memoryItemId:identifier,response:z.union([note,z.array(identifier).max(30)]),rating:z.enum(['again','hard','good','easy']),selectedOptionId:identifier.optional(),order:z.array(identifier).max(30).optional(),cannotRecall:z.boolean().optional(),selfCheckedMeanings:z.array(z.string().max(1_000)).max(30).optional(),assisted:z.boolean().optional(),hintUsed:z.boolean().optional(),helpKinds:z.array(z.enum(['evidence','ai','hint'])).max(3).optional()});
    const p = parse(z.object({assignmentId:uuid,responses:z.array(responseSchema).min(1).max(30)}),input), row = await assignmentFor(user,db,p.assignmentId);
    if (user.id !== row.student_id) throw new ApiError(403,'학생 본인이 답변을 제출해 주세요.');
    await requireSnapshot(db,row);
    if (!['assigned','in_progress'].includes(row.state)) throw new ApiError(409,'이미 제출한 과제예요. 재훈련 과제를 만들어 다시 시도해 주세요.');
    const items = row.items as QuizSnapshotItem[];
    const snapshotLearning=row.package_id?(await db.query('select data from content_versions where package_id=$1 and version=$2',[row.package_id,row.content_version])).rows[0]?.data as LearningData|undefined:undefined;
    if (p.responses.length !== items.length || new Set(p.responses.map(r => r.memoryItemId)).size !== items.length) throw new ApiError(400,'과제의 모든 항목을 한 번씩 제출해 주세요.');
    const results: any[] = [];
    for (const answer of p.responses) {
      const item = items.find(m => m.id === answer.memoryItemId); if (!item) throw new ApiError(400,'과제에 없는 항목이에요.');
      if (!answer.cannotRecall && !answer.selectedOptionId && !answer.order && !(Array.isArray(answer.response) ? answer.response.length : answer.response.trim())) throw new ApiError(400,'답변을 입력하거나 기억 안 남을 선택해 주세요.');
      let result; try { result = evaluateQuizResponse(item,answer as QuizResponse); } catch(error) { throw new ApiError(400,error instanceof Error ? error.message : '응답을 확인해 주세요.'); }
      const helps=(await db.query("select data from quiz_assignment_events where assignment_id=$1 and student_id=$2 and data->>'kind'='help' and data->>'memory_item_id'=$3",[row.id,row.student_id,item.id])).rows;
      const helpKinds=[...new Set<string>([...helps.map(h=>h.data.help_kind),...(answer.helpKinds||[]),...(answer.hintUsed?['hint']:[])])];
      const assistance={assistance_recorded:true,assisted:answer.assisted===true||helpKinds.length>0,hintUsed:helpKinds.includes('hint'),aiAssisted:helps.some(h=>h.data.help_kind==='ai'),helpKinds};
      const metadata={source_kind:row.source_kind||'personal',target_id:row.target_id||null,target_snapshot:row.target_snapshot||null,...quizSchoolMetadata(item as any),...assistance};
      if(row.source_kind==='common'&&answer.cannotRecall)result={...result,feedback:'학교 질문을 다시 준비할 과제로 남겼어요.'};
      const submission = (await db.query('insert into quiz_submissions(assignment_id,student_id,memory_item_id,response,rating,result) values($1,$2,$3,$4,$5,$6) returning *',[row.id,row.student_id,item.id,JSON.stringify({...answer,...metadata,question_id:item.question_id}),answer.rating,JSON.stringify(result)])).rows[0]; results.push(submission);
      const identity=quizAnswerContext(item,{},snapshotLearning);
      await recordStudyEvent(db,row.student_id,{kind:'assignment_submission',sourceId:submission.id,data:{assignmentId:row.id,title:row.title,memoryItemId:item.id,questionId:identity.question_id,linkedQuestionId:identity.linked_question_id,practiceKind:identity.practice_kind,practicePrompt:identity.question,prompt:item.prompt,response:answer.response,outcome:result.correct,cannotRecall:answer.cannotRecall===true,evaluationMethod:result.evaluation_method,verified:result.evaluation_method==='reviewed_correct_answer',contentVersion:row.content_version,sourceRefIds:item.source_ref_ids,correctAnswer:result.reviewed_answer||null,requiredMeanings:identity.practice_kind==='concept'&&!snapshotLearning?.questions.some(q=>q.id===identity.question_id)?[]:result.required_meanings,checkedMeanings:result.checked_meanings,...metadata}});
      const delay = result.retry_due ? 2*24*60*60_000 : 7*24*60*60_000;
      await db.query('insert into memory_attempts(student_id,memory_item_id,rating,data,due_at) values($1,$2,$3,$4,$5)',[row.student_id,item.id,answer.cannotRecall || result.correct === false ?'again':answer.rating,JSON.stringify({assignment_id:row.id,answer:answer.response,correct:result.correct,evaluation_method:result.evaluation_method,content_version:row.content_version,question_id:item.question_id,required_meanings:result.required_meanings,checked_meanings:result.checked_meanings,...metadata}),new Date(Date.now()+delay)]);
      if (answer.cannotRecall && row.source_kind!=='common') {
        const confirmation = (await db.query("insert into student_confirmations(student_id,entity_id,question,state,confirmation_status,data) values($1,$2,$3,'pending','needs_confirmation',$4) returning id",[row.student_id,item.activity_ids[0] ?? item.question_id,item.prompt,JSON.stringify({reason:'cannot_recall',assignment_id:row.id,memory_item_id:item.id,source_ref_ids:item.source_ref_ids,content_version:row.content_version})])).rows[0];
        await db.query("insert into fact_confirmation_events(confirmation_id,student_id,actor_id,confirmation_status,data) values($1,$2,$3,'needs_confirmation',$4)",[confirmation.id,row.student_id,user.id,JSON.stringify({reason:'cannot_recall',assignment_id:row.id})]);
      }
    }
    await taskEvent(db,row,user.id,'submitted');
    const retry = results.some(s => s.result.retry_due), auto = results.every(s => s.result.evaluation_method === 'reviewed_correct_answer');
    const state = retry ? 'retry_due' : auto ? 'completed' : 'submitted';
    if (auto) await taskEvent(db,row,user.id,'reviewed',{review_kind:'automatic'});
    if (state !== 'submitted') await taskEvent(db,row,user.id,state,{review_kind:auto?'automatic':'self_check'});
    await db.query('update quiz_assignments set state=$1,submitted_at=now(),updated_at=now() where id=$2',[state,row.id]); row.state=state;
    await audit(db,user.id,row.student_id,'assignment.submit',{id:row.id,state});
    return {ok:true,studentId:row.student_id,assignment:safeAssignment(row,results),results:results.map(s => ({memory_item_id:s.memory_item_id,...s.result}))};
  }
  if (action === 'assignment_review') {
    const p = parse(z.object({assignmentId:uuid,completed:z.boolean(),note}),input), row = await assignmentFor(user,db,p.assignmentId,true);
    if (!['submitted','reviewed','retry_due','completed'].includes(row.state)) throw new ApiError(409,'제출된 과제부터 검토해 주세요.');
    const review = {review_kind:'staff',reviewer_id:user.id,note:p.note,completed:p.completed,reviewed_at:new Date().toISOString()};
    const state = p.completed?'completed':'retry_due';
    await taskEvent(db,row,user.id,'reviewed',review); await taskEvent(db,row,user.id,state,review);
    await db.query('update quiz_assignments set state=$1,review=$2,reviewed_at=now(),updated_at=now() where id=$3',[state,JSON.stringify(review),row.id]);
    await audit(db,user.id,row.student_id,'assignment.review',{id:row.id,state});
    return {ok:true,studentId:row.student_id,assignment:{...safeAssignment(row),state,review}};
  }
  if (action === 'assignment_retry') {
    const p = parse(z.object({assignmentId:uuid}),input), parent = await assignmentFor(user,db,p.assignmentId); await requireSnapshot(db,parent);
    if (!['submitted','reviewed','retry_due','completed'].includes(parent.state)) throw new ApiError(409,'첫 답변을 제출한 뒤 재훈련할 수 있어요.');
    const existing = (await db.query("select * from quiz_assignments where parent_assignment_id=$1 and state in ('assigned','in_progress') order by created_at desc limit 1",[parent.id])).rows[0];
    if (existing) return {ok:true,studentId:parent.student_id,assignment:safeAssignment(existing)};
    const results = (await db.query('select memory_item_id,result from quiz_submissions where assignment_id=$1',[parent.id])).rows;
    const weakIds = results.filter(r => r.result.retry_due).map(r => r.memory_item_id);
    const items = (parent.items as QuizSnapshotItem[]).filter(i => !weakIds.length || weakIds.includes(i.id));
    const sourceSnapshot=parent.source_kind==='common'?{questions:items.map(item=>({questionId:item.question_id,...quizSchoolMetadata(item as any)}))}:parent.source_snapshot||{};
    const row = (await db.query('insert into quiz_assignments(student_id,assigned_by,title,package_id,content_version,items,due_at,parent_assignment_id,report_id,source_kind,target_id,target_snapshot,source_snapshot) values($1,$2,$3,$4,$5,$6,now(),$7,$8,$9,$10,$11,$12) returning *',[parent.student_id,user.id,'다시 떠올리기',parent.package_id,parent.content_version,JSON.stringify(items),parent.id,parent.report_id,parent.source_kind||'personal',parent.target_id||null,JSON.stringify(parent.target_snapshot||null),JSON.stringify(sourceSnapshot)])).rows[0];
    await taskEvent(db,row,user.id,'assigned',{parent_assignment_id:parent.id}); await audit(db,user.id,row.student_id,'assignment.retry',{id:row.id,parent_id:parent.id});
    return {ok:true,studentId:row.student_id,assignment:safeAssignment(row)};
  }
  if (action === 'confirmation_save') {
    const p = parse(z.object({entityId:identifier,question:z.string().trim().min(1).max(2_000),response:note.optional(),reason:z.enum(['cannot_recall','record_differs','role_check'])}),input);
    if (user.role !== 'student') throw new ApiError(403,'학생이 사실 확인을 요청해 주세요.');
    const {learning,package:pack} = await learningFromDb(db,user.id);
    const entity = [...learning.activities,...learning.questions,...learning.source_refs,...learning.memory_items].find((e:any) => e.id === p.entityId);
    if (!entity) throw new ApiError(404,'승인 자료의 원문·활동·질문을 선택해 주세요.');
    const status = p.reason==='record_differs'?'student_says_different':'needs_confirmation';
    const sources = 'source_ref_ids' in entity ? entity.source_ref_ids : [entity.id];
    const data = {reason:p.reason,source:'student',source_ref_ids:sources,content_version:pack?.active_version,confirmation_status:status};
    const row = (await db.query("insert into student_confirmations(student_id,entity_id,question,response,state,confirmation_status,data) values($1,$2,$3,$4,'pending',$5,$6) returning *",[user.id,p.entityId,p.question,p.response ?? null,status,JSON.stringify(data)])).rows[0];
    await db.query('insert into fact_confirmation_events(confirmation_id,student_id,actor_id,confirmation_status,response,data) values($1,$2,$3,$4,$5,$6)',[row.id,user.id,user.id,status,p.response ?? null,JSON.stringify({reason:p.reason})]);
    await audit(db,user.id,user.id,'confirmation.request',{id:row.id,reason:p.reason}); return {ok:true,studentId:user.id,confirmation:row};
  }
  if (action === 'confirmation_respond' || action === 'confirmation_review') {
    const p = parse(z.object({confirmationId:uuid,response:note,status:confirmationStatus,note:note.optional()}),input);
    const row = (await db.query('select * from student_confirmations where id=$1 for update',[p.confirmationId])).rows[0];
    if (!row) throw new ApiError(404,'확인 요청을 찾을 수 없어요.');
    await assertStudentScope(user,row.student_id,action === 'confirmation_review',db);
    if (action === 'confirmation_respond' && user.id !== row.student_id) throw new ApiError(403,'학생이 경험을 직접 회신해 주세요.');
    if (action === 'confirmation_respond' && p.status === 'confirmed_from_record') throw new ApiError(403,'학생 확인을 원문 확정으로 바꿀 수 없어요.');
    if (p.status === 'confirmed_by_student' && !p.response.trim()) throw new ApiError(400,'확인한 경험을 입력해 주세요.');
    if (p.status === 'confirmed_from_record' && !row.data?.source_ref_ids?.length) throw new ApiError(400,'연결된 원문 근거가 필요해요.');
    const prior = (await db.query('select id from fact_confirmation_events where confirmation_id=$1 limit 1',[row.id])).rows[0];
    if (!prior) await db.query('insert into fact_confirmation_events(confirmation_id,student_id,actor_id,confirmation_status,response,data) values($1,$2,$3,$4,$5,$6)',[row.id,row.student_id,user.id,currentConfirmationStatus(row),row.response,JSON.stringify({operation:'legacy_response_snapshot',state:row.state,original_updated_at:row.updated_at})]);
    const state = action === 'confirmation_review'?'reviewed':p.status === 'confirmed_by_student'?'confirmed':p.status === 'student_says_different'?'different':p.status === 'cannot_confirm'?'cannot_confirm':'responded';
    const data = {...row.data,confirmation_status:p.status,review_note:p.note ?? null};
    await db.query('update student_confirmations set response=$1,state=$2,confirmation_status=$3,data=$4,reviewed_by=$5,updated_at=now() where id=$6',[p.response,state,p.status,JSON.stringify(data),action === 'confirmation_review'?user.id:null,row.id]);
    await db.query('insert into fact_confirmation_events(confirmation_id,student_id,actor_id,confirmation_status,response,data) values($1,$2,$3,$4,$5,$6)',[row.id,row.student_id,user.id,p.status,p.response,JSON.stringify({review_note:p.note ?? null,operation:action})]);
    await audit(db,user.id,row.student_id,action,{id:row.id,status:p.status}); return {ok:true,studentId:row.student_id,confirmation:{...row,response:p.response,state,confirmation_status:p.status,data}};
  }
  if (action === 'school_profile') {
    const p = parse(z.object({studentId:uuid,targetId:identifier,status:z.enum(SCHOOL_PROFILE_STATUSES),data:schoolSchema,provenance:provenanceSchema,expectedRevision:z.number().int().min(0)}),input);
    await assertStudentScope(user,p.studentId,true,db);
    const target = (await db.query("select * from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null",[p.targetId,p.studentId])).rows[0];
    if (!target) throw new ApiError(404,'학생의 지원처를 찾을 수 없어요.');
    for (const key of ['admission_year','university','campus','department','admission_type'] as const) if (target.data[key] !== p.data[key]) throw new ApiError(400,'지원처의 입학연도·학교·캠퍼스·학과·전형과 일치해야 해요.');
    const stage = target.data.interview_stage ?? target.data.stage;
    if (stage && stage !== p.data.interview_stage) throw new ApiError(400,'지원처의 면접 단계와 일치해야 해요.');
    try { validateSchoolProfile(p.data,p.provenance,p.status); } catch(error) { throw new ApiError(400,error instanceof Error?error.message:'학교 출처를 확인해 주세요.'); }
    await db.query('select pg_advisory_xact_lock(hashtext($1))',[`school:${p.studentId}:${p.targetId}`]);
    const latest = (await db.query('select revision from school_profiles where student_id=$1 and target_id=$2 order by revision desc limit 1',[p.studentId,p.targetId])).rows[0];
    if ((latest?.revision ?? 0) !== p.expectedRevision) throw new ApiError(409,'학교 정보가 변경되었어요. 최신 검수본을 불러와 주세요.');
    const row = (await db.query('insert into school_profiles(student_id,target_id,revision,status,data,provenance,reviewed_by,checked_at) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[p.studentId,p.targetId,p.expectedRevision+1,p.status,JSON.stringify(p.data),JSON.stringify(p.provenance),user.id,p.provenance.checked_at])).rows[0];
    await audit(db,user.id,p.studentId,'school_profile.review',{id:row.id,target_id:p.targetId,revision:row.revision,status:p.status});
    return {ok:true,studentId:p.studentId,schoolProfile:row};
  }
  throw new ApiError(400,'지원하지 않는 학습 작업이에요.');
}

