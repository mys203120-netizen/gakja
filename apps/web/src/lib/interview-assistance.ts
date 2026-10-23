import 'server-only';
import type { PoolClient } from 'pg';
import { query } from './db';
import { assertPublishedAccess, FeatureError, type LearningContext } from './ai';
import { addHelpReceipt, interviewHelpContextMatches, type HelpReceipt, type InterviewHelpScope } from './assistance-records';

function scopeFor(session: Record<string, any> | undefined, turn: Record<string, any> | undefined, requirePaused: boolean): InterviewHelpScope {
  if (!session || !turn) throw new FeatureError(404, '면접 질문을 찾을 수 없어요.', 'TURN_NOT_FOUND');
  if (session.data.sessionMode==='real') throw new FeatureError(403,'실전 면접에서는 도움을 사용할 수 없어요.','REAL_INTERVIEW_POLICY');
  if (session.state !== 'active' || turn.data.answer || turn.data.invalidated) throw new FeatureError(409, '현재 질문에서 도움을 확인해 주세요.', 'STALE_TURN');
  if (session.data.processing) throw new FeatureError(409, '답변 저장이 끝난 뒤 확인해 주세요.', 'INTERVIEW_PENDING');
  if (requirePaused && !session.data.paused) throw new FeatureError(409, '면접을 잠시 멈춘 뒤 확인해 주세요.', 'SESSION_NOT_PAUSED');
  const context = session.data.context;
  return { sessionId: session.id, turnId: turn.id, questionId: turn.data.rootQuestionId || turn.question_id, targetId: context.targetId || null, contentVersion: String(context.contentVersion), activityId: context.activityId || null, briefingId: context.briefingId || null };
}

/** Owned fixed turn scope is checked before creating any chat or paid provider request. */
export async function ownedInterviewHelpScope(studentId: string, sessionId: string, turnId: string, requirePaused = true) {
  const [session] = await query('select * from interview_sessions where id=$1 and student_id=$2', [sessionId, studentId]);
  const [turn] = await query('select * from interview_turns where id=$1 and session_id=$2 and student_id=$3', [turnId, sessionId, studentId]);
  const scope = scopeFor(session, turn, requirePaused);
  await assertPublishedAccess(studentId, session!.data.context);
  return scope;
}

export function assertInterviewHelpContext(scope: InterviewHelpScope, context: Record<string, any>) {
  if (!interviewHelpContextMatches(scope, context)) throw new FeatureError(409, '멈춘 면접의 질문과 자료에서 확인해 주세요.', 'HELP_CONTEXT_MISMATCH');
}

/** Resume help from the interview's reviewed snapshot, even after a newer book is published. */
export async function ownedInterviewChatContext(studentId:string,scope:InterviewHelpScope):Promise<LearningContext>{
  const [session]=await query('select * from interview_sessions where id=$1 and student_id=$2',[scope.sessionId,studentId]);
  if(!session)throw new FeatureError(404,'면접 기록을 찾을 수 없어요.','SESSION_NOT_FOUND');
  await assertPublishedAccess(studentId,session.data.context);
  const context={...session.data.context,questionId:scope.briefingId?null:scope.questionId};
  assertInterviewHelpContext(scope,context);
  return context;
}

/** Reserving a pending chat under this lock closes the pause/resume race before a paid call. */
export async function lockInterviewHelpScope(client:PoolClient,studentId:string,scope:InterviewHelpScope,requirePaused=true){
  const selected = await client.query('select * from interview_sessions where id=$1 and student_id=$2 for update', [scope.sessionId, studentId]);
  const turns = await client.query('select * from interview_turns where id=$1 and session_id=$2 and student_id=$3 for update', [scope.turnId, scope.sessionId, studentId]);
  const current = scopeFor(selected.rows[0], turns.rows[0], requirePaused);
  if (JSON.stringify(current) !== JSON.stringify(scope)) throw new FeatureError(409, '현재 면접의 질문을 다시 확인해 주세요.', 'HELP_CONTEXT_MISMATCH');
  return turns.rows[0];
}

/** Transactionally attached to the same owned, unanswered turn, including after a tab change. */
export async function recordInterviewHelp(client: PoolClient, studentId: string, scope: InterviewHelpScope, receipt: HelpReceipt, requirePaused = true) {
  const turn=await lockInterviewHelpScope(client,studentId,scope,requirePaused);
  const updated = await client.query('update interview_turns set data=$4::jsonb where id=$1 and session_id=$2 and student_id=$3 returning *', [scope.turnId, scope.sessionId, studentId, JSON.stringify(addHelpReceipt(turn.data, receipt))]);
  return updated.rows[0];
}

/** Status may settle after a stop/resume, but only an already recorded receipt can be updated. */
export async function settleInterviewHelp(client: PoolClient, studentId: string, scope: InterviewHelpScope, receipt: HelpReceipt) {
  const selected = await client.query('select * from interview_turns where id=$1 and session_id=$2 and student_id=$3 for update',[scope.turnId,scope.sessionId,studentId]);
  const turn=selected.rows[0];
  if(!turn || !(turn.data.helpEvents||[]).some((event:HelpReceipt)=>event.receiptId===receipt.receiptId))return;
  await client.query('update interview_turns set data=$4::jsonb where id=$1 and session_id=$2 and student_id=$3 returning *',[scope.turnId,scope.sessionId,studentId,JSON.stringify(addHelpReceipt(turn.data,receipt))]);
}
