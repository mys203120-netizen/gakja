import 'server-only';
import {transaction} from './db';
import {buildPlanContext,compactPlanContext} from './planner-context';
import {loadReviewQuestionFacts} from './training-review-evidence-store';
import {synchronizeTrainingReviews,reviewDiagnostics} from './training-review-store';
import {reviewQuestionKey,reviewDiagnosticKey} from './training-review';
import {foldTrainingEvidence} from './training-evidence';
import {readStudentModel,studentModelRevision} from './student-read-model';
import {koreaToday} from './planner-model';
import {allInterviewRootsAnsweredSql} from './interview-completion';

/** Full evidence is folded when its source revision changes; screen changes read this compact projection. */
export async function getTrainingReadModel(studentId:string,today=koreaToday()){
 return transaction(async db=>{
  await db.query('select pg_advisory_xact_lock(hashtext($1))',['automatic-practice:'+studentId]);
  return readStudentModel(studentId,'training',`v1:${today}`,async()=>{
   const context=await buildPlanContext(studentId);
   await db.query("select id from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null for share",[studentId]);
   const preference=(await db.query('select data from student_preferences where student_id=$1 for update',[studentId])).rows[0]?.data||{};
   const source=await loadReviewQuestionFacts(studentId,context,db);
   const reconciled=await synchronizeTrainingReviews(db,studentId,preference,source.questions);
   // Full request/receipt history stays in the durable review state, not in every screen response.
   const reviewQuestions=reconciled.questions.map(row=>({...row,requestCount:row.requestIds.length,requestIds:row.requestIds.slice(-30),resolvedEvidenceCount:row.resolvedEvidenceIds.length,resolvedEvidenceIds:row.resolvedEvidenceIds.slice(-30)}));
   const byKey=new Map(reviewQuestions.map(row=>[row.questionKey,row]));
   const diagnosticKeys=new Set(Object.entries(reviewDiagnostics(preference.trainingDiagnostics)).map(([id,diagnostic])=>reviewDiagnosticKey(id,diagnostic)));
   const started=(await db.query("select target from student_plans where student_id=$1 and planned_date=$2 and nullif(target->'automaticPractice'->>'startedAt','') is not null",[studentId,today])).rows;
   const [cards,turns]=await Promise.all([
    db.query('select id,data,revision from experience_cards where student_id=$1',[studentId]),
    db.query("select t.id,t.question_id,t.data,t.created_at,s.data as session_data,s.target_id from interview_turns t join interview_sessions s on s.id=t.session_id and s.student_id=t.student_id where t.student_id=$1 and s.state not in ('cancelled','deleted') and nullif(btrim(t.data->>'answer'),'') is not null",[studentId]),
   ]);
   const validInterviewIds=new Set(turns.rows.filter(turn=>turn.data?.invalidated!==true).map(turn=>turn.id));
   const packed=compactPlanContext({...context,events:context.events.filter(event=>event.kind!=='interview_answer'||validInterviewIds.has(event.source_id))},started.map(row=>row.target));
   const readiness=Object.fromEntries(context.schoolTargets.map(target=>{
    const common=context.sources.filter(row=>row.sourceType==='common'&&row.targetId===target.id).map(row=>row.entity);
    return [target.id,foldTrainingEvidence({learning:{...context.learning,questions:[...(context.learning.questions||[]),...common]},cards:cards.rows,turns:turns.rows,events:context.events,target:{...target.data,id:target.id},contentVersion:context.contentVersion,notes:preference.trainingActivityNotes||[],reviewQuestions:reconciled.questions})];
   }));
   const sessions=[...new Set(packed.context.events.map(event=>event.data?.sessionId).filter(Boolean))];
   const completed=sessions.length?(await db.query(`select s.id from interview_sessions s where s.student_id=$1 and s.id=any($2::uuid[]) and s.state='completed' and ${allInterviewRootsAnsweredSql('s')}`,[studentId,sessions])).rows.map(row=>row.id):[];
   return {packed,readiness,completedSessionIds:completed,targets:[...source.targets],questions:source.questions.map(question=>({...question,attempts:question.attempts.filter(attempt=>attempt.valid!==false).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,1),review:byKey.get(reviewQuestionKey(question))})),review:{version:1,questions:reviewQuestions},activeRequests:reconciled.state.requests.filter(request=>request.origin==='student'&&request.status==='active'&&diagnosticKeys.has(request.diagnosticKey||'')).map(request=>({diagnosticKey:request.diagnosticKey,selectionKey:request.selectionKey})),sourceRevision:await studentModelRevision(db,studentId)};
  },db);
 });
}

export function trainingReadContext(snapshot:Awaited<ReturnType<typeof getTrainingReadModel>>){
 return {...snapshot.packed.context,sources:snapshot.packed.context.sources.map(source=>({...source,learning:snapshot.packed.archives[String(source.sourceVersion)]}))};
}
