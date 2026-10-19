import 'server-only';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, query, transaction } from './db';

export type QuizHelpKind = 'evidence' | 'ai' | 'hint' | 'video' | 'writing';
export type QuizHelpReceipt = { sessionId: string; itemIndex: number; helpKind: QuizHelpKind; requestId?: string; threadId?: string; status?: 'partial' | 'completed' | 'interrupted' };

function ownedItem(session: any, itemIndex: number) {
  const item = session?.items?.[itemIndex];
  if (!item || !Number.isInteger(itemIndex) || itemIndex < 0) throw new ApiError(404, '연결된 퀴즈 문항을 찾을 수 없어요.');
  return item;
}

/** The saved, owned attempt sets the school and content version for help. */
export async function getQuizHelpContext(studentId: string, sessionId: string, itemIndex: number) {
  const [session] = await query('select * from quiz_sessions where id=$1 and student_id=$2', [sessionId, studentId]);
  if (!session) throw new ApiError(404, '퀴즈 기록을 찾을 수 없어요.');
  const item = ownedItem(session, itemIndex);
  if (['completed', 'ended'].includes(session.state) || session.current_index !== itemIndex) throw new ApiError(409, '도움을 받을 현재 문항을 다시 확인해 주세요.');
  const common = item.source_kind === 'common';
  return {
    questionId: item.question_id || undefined,
    activityId: item.activity_ids?.[0] || undefined,
    targetId: item.target_id || session.metadata?.targetId || undefined,
    targetSnapshot: item.target_snapshot || session.metadata?.targetSnapshot || null,
    sourceType: common ? 'common' as const : 'personal' as const,
    sourceVersion: common ? item.common_revision : session.content_version || undefined,
    sessionId: session.id,
    itemIndex,
  };
}

/** Completion and receipt can share the chat transaction; late help is retained without relabelling a submitted answer. */
export async function recordQuizHelp(studentId: string, input: QuizHelpReceipt, client?: PoolClient) {
  const write = async (db: PoolClient) => {
    const [session] = (await db.query('select * from quiz_sessions where id=$1 and student_id=$2 for update', [input.sessionId, studentId])).rows;
    if (!session) throw new ApiError(404, '퀴즈 기록을 찾을 수 없어요.');
    ownedItem(session, input.itemIndex);
    const events = Array.isArray(session.metadata?.helpEvents) ? session.metadata.helpEvents : [];
    const receiptId = input.requestId || randomUUID();
    const duplicate = events.find((event: any) => event.receiptId === receiptId && event.itemIndex === input.itemIndex && event.kind === input.helpKind);
    if (duplicate) {
      const receipt = {...duplicate, ...(input.status && duplicate.status !== 'completed' ? {status: input.status} : {})};
      if (receipt.status !== duplicate.status) await db.query('update quiz_sessions set metadata=$3,updated_at=now() where id=$1 and student_id=$2', [session.id, studentId, JSON.stringify({...session.metadata, helpEvents:events.map((event:any)=>event===duplicate?receipt:event)})]);
      return { recorded: duplicate.phase === 'before_answer', duplicate: true, receipt };
    }
    const [answered] = (await db.query('select id from quiz_responses where session_id=$1 and student_id=$2 and item_index=$3', [session.id, studentId, input.itemIndex])).rows;
    const beforeAnswer = !answered && session.current_index === input.itemIndex && !['completed', 'ended'].includes(session.state);
    const receipt = { kind: input.helpKind, itemIndex: input.itemIndex, at: new Date().toISOString(), receiptId, phase: beforeAnswer ? 'before_answer' : 'after_answer', status:input.status || 'completed', ...(input.threadId ? { threadId: input.threadId } : {}) };
    const metadata = { ...session.metadata, helpEvents: [...events, receipt].slice(-500), ...(beforeAnswer ? {
      assistedIndices: [...new Set([...(session.metadata?.assistedIndices || []), input.itemIndex])],
      ...(input.helpKind === 'hint' ? { hintIndices: [...new Set([...(session.metadata?.hintIndices || []), input.itemIndex])] } : {}),
    } : {}) };
    await db.query('update quiz_sessions set metadata=$3,updated_at=now() where id=$1 and student_id=$2', [session.id, studentId, JSON.stringify(metadata)]);
    return { recorded: beforeAnswer, duplicate: false, receipt };
  };
  return client ? write(client) : transaction(write);
}

export function quizHelpFacts(session: any, itemIndex: number) {
  const events = (Array.isArray(session.metadata?.helpEvents) ? session.metadata.helpEvents : []).filter((event: any) => event.itemIndex === itemIndex && event.phase !== 'after_answer');
  const hintUsed = (session.metadata?.hintIndices || []).includes(itemIndex);
  const assisted = hintUsed || (session.metadata?.assistedIndices || []).includes(itemIndex) || events.length > 0;
  return { assistance_recorded: session.metadata?.assistance_recorded === true || assisted, assisted, hint_used: hintUsed,
    helpKinds: [...new Set([...(hintUsed ? ['hint'] : []), ...events.map((event: any) => event.kind)])], helpEvents: events };
}
