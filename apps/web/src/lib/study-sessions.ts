import 'server-only';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Profile } from './auth';
import { ApiError, transaction } from './db';
import { answerAssistance, memoryReviewOutcome, quizAnswerContext } from './learning-record-rules';
import type { LearningData } from '@gakja/content-contracts';
import { nextUnappliedQuestion } from './next-learning-question';
import { growthContextResolver, type GrowthVersion } from './learning-growth';

export type StudyEvent = { kind: 'quiz_response' | 'interview_answer' | 'memory_review' | 'assignment_submission' | 'knowledge_progress'; sourceId: string; data: Record<string, unknown> };
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('heartbeat'), tabId: z.string().uuid() }),
  z.object({ action: z.literal('leave'), tabId: z.string().uuid() }),
  z.object({ action: z.literal('finish'), reason: z.enum(['manual','logout']), sessionId: z.string().uuid() }),
]);
const string = (value: unknown) => typeof value === 'string' ? value : '';
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
const revision = (value: unknown) => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return undefined;
  const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : undefined;
};
const summaryIdentity = (event: any) => string(event.data?.memoryItemId) || string(event.data?.questionId) || string(event.source_id);
function summaryContext(event: any): GrowthVersion {
  const value = event.data || {}, target = value.targetSnapshot || value.target_snapshot || {};
  return {id:string(event.id),question_id:summaryIdentity(event),script:'',created_at:String(event.created_at || ''),
    practice_kind:value.practiceKind || value.practice_kind,
    target_id:value.targetId || value.target_id || undefined,
    target_snapshot:{...target,department:target.department || target.major,admission_year:target.admission_year || target.year,admission_type:target.admission_type || target.track,interview_stage:target.interview_stage || target.stage},
    content_version:revision(value.contentVersion ?? value.content_version),common_revision:revision(value.commonRevision ?? value.common_revision),
    source_type:value.sourceType || value.source_type || ((value.sourceKind || value.source_kind)==='common'?'common':undefined)};
}
function assertStudent(user: Profile) { if (user.role !== 'student') throw new ApiError(403,'학생의 학습 기록에서 이용할 수 있어요.'); }
async function lock(db: PoolClient, studentId: string) {
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`study-session:${studentId}`]);
}

export function studySummary(events: any[]) {
  const quiz = events.filter(event => event.kind === 'quiz_response');
  const interview = events.filter(event => event.kind === 'interview_answer');
  const memory = events.filter(event => event.kind === 'memory_review');
  const assignments = events.filter(event => event.kind === 'assignment_submission');
  const knowledge = events.filter(event => event.kind === 'knowledge_progress');
  const modes = (mode: string) => quiz.filter(event => event.data.mode === mode).length;
  const wrong = quiz.filter(event => event.data.outcome === false);
  const timedOut = quiz.filter(event => event.data.timedOut === true);
  const weaknesses = new Map<string,any>();
  const verified = new Map<string,any>();
  const practiceEvents = events.filter(event => ['quiz_response','memory_review','assignment_submission'].includes(event.kind));
  const contexts = new Map(practiceEvents.map(event => [event,summaryContext(event)]));
  // Match report comparisons and next-step selection: a shared legacy question/card ID
  // cannot let success for another school or source publication clear this weakness.
  const resolveContext = growthContextResolver([...contexts.values()]);
  for (const event of [...events].sort((a,b)=>new Date(a.created_at||0).getTime()-new Date(b.created_at||0).getTime()||string(a.id).localeCompare(string(b.id)))) {
    if (!['quiz_response','memory_review','assignment_submission'].includes(event.kind)) continue;
    const value = event.data || {};
    const context = contexts.get(event)!;
    const key = JSON.stringify([summaryIdentity(event),context.practice_kind==='concept'?'concept':'answer',resolveContext(context)]);
    const row = weaknesses.get(key) || { questionId:string(value.questionId),memoryItemId:string(value.memoryItemId),prompt:string(value.practicePrompt)||string(value.prompt),practiceKind:value.practiceKind,contentVersion:value.contentVersion,targetId:value.targetId||value.target_id||null,targetSnapshot:value.targetSnapshot||value.target_snapshot||null,sourceType:value.sourceType||value.source_type||null,commonRevision:value.commonRevision||value.common_revision||null,wrong:0,timedOut:0,sourceIds:new Set<string>(),resolved:false,lastAttemptAt:event.created_at };
    row.lastAttemptAt = event.created_at;
    const failed = value.outcome === false || value.timedOut === true || value.cannotRecall === true || value.rating === 'again' || ['uncertain','needs_confirmation','unchecked'].includes(value.recall_state || value.recallStatus || '');
    if (failed && !row.sourceIds.has(event.source_id)) {
      row.wrong += value.outcome === false || value.cannotRecall === true ? 1 : 0;
      row.timedOut += value.timedOut === true ? 1 : 0;
      row.sourceIds.add(event.source_id);
      row.resolved = false;
      verified.delete(key);
    }
    const independent = value.outcome === true && (value.assistance_recorded===true || value.assistanceRecorded===true) && value.timedOut !== true && value.hintUsed !== true && value.assisted !== true
      && (value.verified === true || value.evaluationMethod === 'reviewed_correct_answer' || (event.kind === 'quiz_response' && value.mode === 'choice'));
    if (independent) {
      row.resolved = true; row.resolvedAt = event.created_at;
      verified.set(key,{questionId:row.questionId,memoryItemId:row.memoryItemId,prompt:row.prompt,verifiedAt:event.created_at,sourceId:event.source_id});
    }
    if (row.sourceIds.size) weaknesses.set(key,row);
  }
  const points = [...weaknesses.values()].map(({sourceIds,...row})=>row);
  const imported = events.filter(event=>event.historical===true);
  return {
    eventCount: events.length,
    quiz: { answered:quiz.length, choice:modes('choice'),written:modes('answer'),oral:modes('oral'),correct:quiz.filter(event=>event.data.outcome===true).length,wrong:wrong.length,ungraded:quiz.filter(event=>event.data.outcome!==true&&event.data.outcome!==false).length,timedOut:timedOut.length,elapsedMs:quiz.reduce((sum,event)=>sum+positive(event.data.elapsedMs),0) },
    interviews: { answered:interview.length,sessions:new Set(interview.map(event=>string(event.data.sessionId)).filter(Boolean)).size,chat:interview.filter(event=>event.data.kind!=='video'&&event.data.kind!=='live').length,live:interview.filter(event=>event.data.kind==='video'||event.data.kind==='live').length,assisted:interview.filter(event=>event.data.assisted===true).length },
    memory:{reviewed:memory.length,verifiedCorrect:memory.filter(e=>e.data.outcome===true&&e.data.verified===true).length,selfChecked:memory.filter(e=>e.data.verified!==true).length},
    assignments:{submitted:assignments.length,verifiedCorrect:assignments.filter(e=>e.data.outcome===true&&e.data.verified===true).length,ungraded:assignments.filter(e=>e.data.outcome!==true&&e.data.outcome!==false).length},
    knowledge:{updates:knowledge.length,completed:new Set(knowledge.filter(e=>e.data.completed===true).map(e=>e.data.videoId)).size,reflections:new Set(knowledge.filter(e=>string(e.data.reflection).trim()).map(e=>e.data.videoId)).size},
    independentlyVerified:{count:verified.size,questions:[...verified.values()]},
    weakPoints:points.filter(row=>!row.resolved).sort((a,b)=>(b.wrong+b.timedOut)-(a.wrong+a.timedOut)),
    resolvedPoints:points.filter(row=>row.resolved),
    historical:{eventCount:imported.length,firstAt:imported[0]?.created_at||null,lastAt:imported.at(-1)?.created_at||null},
  };
}
async function eventsFor(db: PoolClient, sessionId: string, studentId: string) {
  const events=(await db.query('select id,kind,source_id,data,created_at from study_session_events where session_id=$1 and student_id=$2 order by created_at,id',[sessionId,studentId])).rows;
  return normaliseSourceFacts(db,studentId,events);
}
/** Correct the read model from owned immutable sources; never rewrite a finalized report or original event. */
async function normaliseSourceFacts(db:PoolClient,studentId:string,events:any[]) {
  if(!events.some(event=>['quiz_response','memory_review','assignment_submission'].includes(event.kind)))return events;
  const archives=(await db.query("select v.version,v.data from content_versions v join content_packages p on p.id=v.package_id where p.student_id=$1 and v.status='published'",[studentId])).rows;
  const sources=(await db.query(`select 'quiz_response' as kind,r.id::text as source_id,r.data,r.hint_used,s.content_version,s.mode,s.items->r.item_index as item,r.outcome,r.response as answer,r.memory_item_id from quiz_responses r join quiz_sessions s on s.id=r.session_id and s.student_id=r.student_id where r.student_id=$1
    union all select 'assignment_submission',r.id::text,r.response,false,a.content_version,'assignment',i.value,(r.result->>'correct')::boolean,r.response->>'response',r.memory_item_id from quiz_submissions r join quiz_assignments a on a.id=r.assignment_id and a.student_id=r.student_id left join lateral(select x.value from jsonb_array_elements(a.items) x(value) where x.value->>'id'=r.memory_item_id limit 1)i on true where r.student_id=$1
    union all select 'memory_review',m.id::text,m.data,false,case when coalesce(m.data->>'content_version','')~'^[0-9]+$' then (m.data->>'content_version')::int else null end,'memory',null::jsonb,null::boolean,null::text,m.memory_item_id from memory_attempts m where m.student_id=$1`,[studentId])).rows;
  const bySource=new Map(sources.map(row=>[row.kind+':'+row.source_id,row]));
  return events.map(event=>{
    const row=bySource.get(event.kind+':'+event.source_id);if(!row)return event;
    const source=archives.find(archive=>archive.version===row.content_version)?.data as LearningData|undefined;
    const item=row.item||source?.memory_items.find(item=>item.id===row.memory_item_id);
    if(!item)return event.kind==='memory_review'?{...event,data:{...event.data,outcome:null,verified:false,evaluationMethod:'self_check'}}:event;
    const identity=quizAnswerContext(item,row.data,source),assistance=answerAssistance({hint_used:row.hint_used||event.data.hintUsed,data:{...row.data,assisted:row.data?.assisted===true||event.data.assisted===true}});
    const data={...event.data,questionId:identity.question_id,linkedQuestionId:identity.linked_question_id,practiceKind:identity.practice_kind,practicePrompt:identity.question,contentVersion:row.content_version,hintUsed:assistance.hintUsed,assisted:assistance.assisted,assistance_recorded:assistance.assistanceRecorded};
    if(event.kind==='memory_review'&&source){
      let outcome=null;try{outcome=memoryReviewOutcome(source,row.memory_item_id,row.data?.answer);}catch{}
      data.outcome=outcome;data.verified=outcome!==null;data.evaluationMethod=outcome===null?'self_check':'reviewed_correct_answer';
    }
    if(row.mode==='oral'){data.outcome=null;data.verified=false;}
    return {...event,data};
  });
}
async function finalize(db: PoolClient, session: any, reason: string) {
  if (session.state === 'finalized') return session;
  const events = await eventsFor(db,session.id,session.student_id);
  // Frozen factual snapshots do not infer admissions readiness from activity counts.
  const report = {...studySummary(events),events};
  return (await db.query("update study_sessions set state='finalized',ended_at=last_seen_at,finish_reason=$2,closing_at=null,report=$3 where id=$1 and state='active' returning *",[session.id,reason,JSON.stringify(report)])).rows[0] || session;
}
async function reconcile(db: PoolClient, studentId: string) {
  const [session] = (await db.query("select * from study_sessions where student_id=$1 and state='active' for update",[studentId])).rows;
  if (!session) return null;
  const alive = (await db.query("select 1 from study_session_tabs where session_id=$1 and closed_at is null and last_seen_at>now()-interval '3 minutes' limit 1",[session.id])).rowCount;
  const expired = (await db.query("select ($1::timestamptz is not null and $1::timestamptz<=now()) as closing,($2::timestamptz<now()-interval '3 minutes') as idle",[session.closing_at,session.last_seen_at])).rows[0];
  if (!alive && (expired.closing || expired.idle)) { await finalize(db,session,expired.closing?'app_exit':'idle_recovery'); return null; }
  return session;
}
async function currentOrNew(db: PoolClient, studentId: string) {
  const current = await reconcile(db,studentId);
  if (current) return current;
  return (await db.query('insert into study_sessions(student_id) values($1) returning *',[studentId])).rows[0];
}

/** Call only after a real owned answer is persisted, within its transaction. */
export async function recordStudyEvent(db: PoolClient, studentId: string, event: StudyEvent) {
  await lock(db,studentId);
  const sourceId = event.sourceId.trim();
  if (!sourceId || sourceId.length>200 || JSON.stringify(event.data).length>80_000) throw new ApiError(400,'학습 기록 형식을 확인해 주세요.');
  const [existing] = (await db.query('select session_id from study_session_events where student_id=$1 and kind=$2 and source_id=$3 union all select null::uuid as session_id from study_imported_events where student_id=$1 and kind=$2 and source_id=$3 limit 1',[studentId,event.kind,sourceId])).rows;
  if (existing) return {sessionId:existing.session_id,duplicate:true};
  const session = await currentOrNew(db,studentId);
  await db.query('insert into study_session_events(session_id,student_id,kind,source_id,data) values($1,$2,$3,$4,$5)',[session.id,studentId,event.kind,sourceId,JSON.stringify(event.data)]);
  await db.query('update study_sessions set last_activity_at=now(),last_seen_at=now(),closing_at=null where id=$1',[session.id]);
  return {sessionId:session.id,duplicate:false};
}

async function view(db: PoolClient, session: any) {
  if (!session) return null;
  if(session.state==='finalized') return session;
  const events=await eventsFor(db,session.id,session.student_id);
  return {...session,report:{...studySummary(events),events}};
}
export async function getStudySessions(user: Profile, id?: string | null) {
  assertStudent(user);
  return transaction(async db=>{
    await lock(db,user.id);
    const current = await reconcile(db,user.id);
    if (id) {
      if (!z.string().uuid().safeParse(id).success) throw new ApiError(400,'리포트 주소를 확인해 주세요.');
      const [session] = (await db.query('select * from study_sessions where id=$1 and student_id=$2',[id,user.id])).rows;
      if (!session) throw new ApiError(404,'리포트를 찾을 수 없어요.');
      const displayed=await view(db,session);
      return {session:displayed,sourceFacts:await normaliseSourceFacts(db,user.id,displayed.report?.events||[])};
    }
    // Lists stay compact; full saved answers are fetched only through an owned detail ID.
    const sessions = (await db.query("select id,student_id,state,started_at,last_seen_at,last_activity_at,closing_at,ended_at,finish_reason,report-'events' as report from study_sessions where student_id=$1 and state='finalized' and coalesce((report->>'eventCount')::int,0)>0 order by started_at desc,id desc",[user.id])).rows;
    const allEvents = await normaliseSourceFacts(db,user.id,(await db.query('select id,kind,source_id,data,created_at,false as historical from study_session_events where student_id=$1 union all select id,kind,source_id,data,occurred_at as created_at,true as historical from study_imported_events where student_id=$1 order by created_at,id',[user.id])).rows);
    const totals = studySummary(allEvents);
    const recent = nextUnappliedQuestion(allEvents);
    const nextQuestion = recent?{questionId:recent.data.questionId,memoryItemId:recent.data.memoryItemId,practiceKind:recent.data.practiceKind,prompt:recent.data.practicePrompt||recent.data.prompt||recent.data.question,activityIds:recent.data.activityIds||[],targetId:recent.data.targetId||recent.data.target_id||null,targetSnapshot:recent.data.targetSnapshot||recent.data.target_snapshot||null,sourceType:recent.data.sourceType||recent.data.source_type||null,commonRevision:recent.data.commonRevision||recent.data.common_revision||null,assisted:recent.data.assisted===true||recent.data.hintUsed===true}:null;
    return {current:await view(db,current),latest:sessions[0]||null,sessions,totals,history:allEvents,nextQuestion};
  });
}
export async function studySessionAction(user: Profile, value: unknown) {
  assertStudent(user);
  const result = requestSchema.safeParse(value);
  if (!result.success) throw new ApiError(400,'학습 기록 요청을 확인해 주세요.');
  const input = result.data;
  return transaction(async db=>{
    await lock(db,user.id);
    if (input.action==='finish') {
      const [session] = (await db.query('select * from study_sessions where id=$1 and student_id=$2 for update',[input.sessionId,user.id])).rows;
      if (!session) throw new ApiError(404,'학습 기록을 찾을 수 없어요.');
      if (session.state==='active') {
        session.last_seen_at = new Date(); session.closing_at = null;
        await db.query('update study_sessions set last_seen_at=now(),closing_at=null where id=$1',[session.id]);
      }
      return {session:await finalize(db,session,input.reason)};
    }
    if (input.action==='heartbeat') {
      const session = await currentOrNew(db,user.id);
      await db.query('insert into study_session_tabs(session_id,student_id,tab_id) values($1,$2,$3) on conflict(session_id,tab_id) do update set last_seen_at=now(),closed_at=null',[session.id,user.id,input.tabId]);
      const [updated] = (await db.query('update study_sessions set last_seen_at=now(),closing_at=null where id=$1 returning *',[session.id])).rows;
      return {sessionId:updated.id,state:updated.state};
    }
    const session = await reconcile(db,user.id);
    if (!session) return {ok:true};
    const left=await db.query('update study_session_tabs set closed_at=now() where session_id=$1 and student_id=$2 and tab_id=$3',[session.id,user.id,input.tabId]);
    if(!left.rowCount) return {ok:true,sessionId:session.id,pendingFinish:false};
    const alive = (await db.query("select 1 from study_session_tabs where session_id=$1 and closed_at is null and last_seen_at>now()-interval '3 minutes' limit 1",[session.id])).rowCount;
    if (!alive) await db.query("update study_sessions set closing_at=coalesce(closing_at,now()+interval '30 seconds'),last_seen_at=now() where id=$1",[session.id]);
    return {ok:true,sessionId:session.id,pendingFinish:!alive};
  });
}
