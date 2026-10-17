import 'server-only';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApiError } from './db';

/** Browser flags cannot label an answer as AI generated: use an owned, completed response from the exact current question. */
export async function chatCandidateProvenance(db:PoolClient,studentId:string,input:{chatThreadId?:unknown;chatMessageId?:unknown;questionId:string;packageId?:string;contentVersion?:number}) {
  if(input.chatThreadId===undefined&&input.chatMessageId===undefined)return {};
  const threadId=z.string().uuid().safeParse(input.chatThreadId),messageId=z.string().uuid().safeParse(input.chatMessageId);
  if(!threadId.success||!messageId.success)throw new ApiError(400,'답변 후보의 대화와 응답을 함께 확인해 주세요.');
  const [source]=(await db.query("select m.id,m.content,m.status,m.role,m.data,m.created_at,t.id as thread_id,t.content_version,t.context from chat_messages m join chat_threads t on t.id=m.thread_id and t.student_id=m.student_id where m.id=$1 and t.id=$2 and m.student_id=$3 and t.student_id=$3 for share of m,t",[messageId.data,threadId.data,studentId])).rows;
  if(!source)throw new ApiError(404,'내 대화의 답변 후보를 찾을 수 없어요.');
  if(source.role!=='assistant'||source.status!=='completed'||!source.content?.trim())throw new ApiError(409,'완료된 AI 응답만 답변 후보로 저장할 수 있어요.');
  const context=source.context||{};
  if(context.questionId!==input.questionId)throw new ApiError(409,'이 질문에서 받은 답변 후보를 선택해 주세요.');
  const [publication]=(await db.query("select p.id,p.active_version from content_packages p join content_versions v on v.package_id=p.id and v.version=p.active_version and v.status='published' where p.student_id=$1 for share of p,v",[studentId])).rows;
  if(!publication||publication.id!==input.packageId||publication.active_version!==input.contentVersion||source.content_version!==publication.active_version||String(context.contentVersion)!==String(publication.active_version)||context.packageId!==publication.id)throw new ApiError(409,'자료가 변경됐어요. 현재 질문으로 새 대화를 시작해 주세요.');
  return {assisted:true,ai_assisted:true,chatThreadId:source.thread_id,chatMessageId:source.id,aiAssistance:{kind:'chat_candidate',threadId:source.thread_id,messageId:source.id,createdAt:source.created_at,model:source.data?.model||null,promptVersion:source.data?.promptVersion||null}};
}
