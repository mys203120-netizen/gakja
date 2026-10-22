import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {ApiError,query,transaction} from './db';
import {assertPublishedAccess,getLearningContext,type LearningContext} from './ai';
import {generateQuickStartDraft,validateQuickStartDraft,QUICK_START_DRAFT_VERSION} from './quick-start-ai';
import {getQuizHelpContext,recordQuizHelp} from './quiz-assistance';
import {ownedInterviewHelpScope,ownedInterviewChatContext,assertInterviewHelpContext,recordInterviewHelp} from './interview-assistance';
import {thoughtWritingSchema,writingFieldQuestions,type ThoughtWritingInput,type WritingReceipt,type WritingContext} from './thought-writing-model';

const preferencesKey='thoughtWritingReceipts';
async function accessibleScope(studentId:string,input:ThoughtWritingInput){
 if(input.kind==='experience'){
  const [blocked]=await query("select 1 from account_data_tombstones where student_id=$1 and row_id=$2 and table_name in ('experience_cards','experience_card_drafts') union all select 1 from account_data_trash where student_id=$1 and root_id=$2 limit 1",[studentId,input.scopeId]);
  if(blocked)throw new ApiError(409,'정리된 경험은 복원한 뒤 이어서 작성해 주세요.');
  const [target]=input.context.targetId?await query("select id,data from support_targets where student_id=$1 and id=$2 and nullif(data->>'archived_at','') is null",[studentId,input.context.targetId]):[];
  if(input.context.targetId&&!target)throw new ApiError(404,'지원 학교를 다시 선택해 주세요.');
  const identity=target?JSON.stringify(['school_reference_id','department_catalog_id','university','department','major','admission_year','admission_type','campus'].map(key=>target.data?.[key]||null)):'';
  return {question:writingFieldQuestions[input.field!],context:input.context,identity};
 }
 const selected=input.context,quiz=selected.quizSessionId?await getQuizHelpContext(studentId,selected.quizSessionId,selected.quizItemIndex!):undefined;
 const interview=selected.interviewSessionId?await ownedInterviewHelpScope(studentId,selected.interviewSessionId,selected.interviewTurnId!):undefined;
 let context:LearningContext;
 if(selected.threadId){const [thread]=await query('select * from chat_threads where id=$1 and student_id=$2 and deleted_at is null',[selected.threadId,studentId]);if(!thread||thread.archived_at)throw new ApiError(404,'대화를 다시 열어 주세요.');context=thread.context;await assertPublishedAccess(studentId,context);}
 else context=interview?await ownedInterviewChatContext(studentId,interview):await getLearningContext(studentId,{...selected,allowCommon:true});
 const question=context.questions.find(item=>item.id===context.questionId);
 const sourceType:'common'|'personal'=question?.common_revision?'common':'personal',sourceVersion=Number(question?.common_revision||context.contentVersion);
 if(selected.sourceType&&selected.sourceType!==sourceType||selected.sourceVersion&&selected.sourceVersion!==sourceVersion)throw new ApiError(409,'현재 대화의 발행본에서 다시 정리해 주세요.');
 for(const key of ['targetId','questionId','activityId','briefingId'] as const)if(selected[key]&&selected[key]!==context[key])throw new ApiError(409,'현재 대화의 질문과 자료에서 다시 정리해 주세요.');
 if(quiz&&(context.questionId!==quiz.questionId||(context.targetId||undefined)!==quiz.targetId||String(quiz.sourceVersion)!==String(quiz.sourceType==='common'?question?.common_revision:context.contentVersion)))throw new ApiError(409,'현재 퀴즈의 질문에서 다시 정리해 주세요.');
 if(interview)assertInterviewHelpContext(interview,context);
 return {question:question?.prompt||'학생이 지금 입력한 생각을 자연스럽게 말할 수 있는 문단으로 정리해 주세요.',context:{...selected,targetId:context.targetId,questionId:context.questionId,activityId:context.activityId,briefingId:context.briefingId,sourceType,sourceVersion},quiz,interview};
}
async function lockedReceipts(db:PoolClient,studentId:string,create=false){
 if(create)await db.query("insert into student_preferences(student_id,data) values($1,'{}') on conflict(student_id) do nothing",[studentId]);
 const [row]=(await db.query('select data from student_preferences where student_id=$1 for update',[studentId])).rows;
 return (Array.isArray(row?.data?.[preferencesKey])?row.data[preferencesKey]:[]) as WritingReceipt[];
}
async function saveReceipts(db:PoolClient,studentId:string,receipts:WritingReceipt[]){
 await db.query("update student_preferences set data=jsonb_set(data,'{thoughtWritingReceipts}',$2::jsonb,true),updated_at=now() where student_id=$1",[studentId,JSON.stringify(receipts.slice(-12))]);
}
/** The proposal is assistance only; no answer, completion, or practice record is created. */
export async function generateThoughtWriting(studentId:string,raw:unknown,signal?:AbortSignal){
 const input=thoughtWritingSchema.parse(raw),scope=await accessibleScope(studentId,input);
 const digest=createHash('sha256').update(JSON.stringify([QUICK_START_DRAFT_VERSION,input.kind,input.scopeId,input.field,input.source,input.original,input.history,scope.context,scope.identity])).digest('hex'),attempt=randomUUID();
 const reserved=await transaction(async db=>{
  const receipts=await lockedReceipts(db,studentId,true),known=receipts.find(item=>item.requestId===input.requestId);
  if(known?.digest&&known.digest!==digest)throw new ApiError(409,'입력한 내용이 바뀌었어요. 새로 정리해 주세요.');
  if(known?.status==='completed'&&known.proposal)return known.proposal;
  if(receipts.some(item=>item.status==='pending'&&Date.now()-Date.parse(item.startedAt)<90_000))throw new ApiError(409,'문장을 정리하고 있어요. 잠시 후 다시 시도해 주세요.');
  const next:WritingReceipt={requestId:input.requestId,digest,attempt,status:'pending',startedAt:new Date().toISOString(),kind:input.kind,scopeId:input.scopeId,field:input.field,context:scope.context};
  await saveReceipts(db,studentId,[...receipts.filter(item=>item.requestId!==input.requestId&&Date.now()-Date.parse(item.startedAt)<86_400_000),next]);return null;
 });
 if(reserved)return {proposal:reserved,requestId:input.requestId,assisted:true,duplicate:true};
 try{
  const history=[...(input.original?[{question:'학생이 제공한 참고 원문',answer:input.original}]:[]),...input.history];
  const proposal=await generateQuickStartDraft(studentId,{sessionId:input.requestId,question:`${scope.question}\n입력한 사실만 사용해 ${input.kind==='experience'?'해당 경험 영역의':'학생이 편집하고 사용할'} 말하기 문단을 ${input.kind==='experience'?2000:6000}자 이내로 정리해 주세요.`,thoughts:input.source,history},{signal});
  validateQuickStartDraft(proposal,input.source,history);
  if(proposal.draft.length>(input.kind==='experience'?2000:6000))throw new ApiError(502,'정리된 문장이 너무 길어요. 입력을 나누어 다시 정리해 주세요.');
  if(signal?.aborted)throw new ApiError(499,'문장 정리를 멈췄어요. 입력한 내용은 그대로 있어요.');
  const current=await accessibleScope(studentId,input);
  if(JSON.stringify(current.context)!==JSON.stringify(scope.context)||current.identity!==scope.identity)throw new ApiError(409,'질문이나 지원 정보가 바뀌었어요. 현재 화면에서 다시 정리해 주세요.');
  await transaction(async db=>{
   const receipts=await lockedReceipts(db,studentId),pending=receipts.find(item=>item.requestId===input.requestId&&item.attempt===attempt&&item.status==='pending');
   if(!pending)throw new ApiError(409,'현재 문장 정리 요청을 다시 확인해 주세요.');
   if(scope.quiz)await recordQuizHelp(studentId,{sessionId:scope.quiz.sessionId,itemIndex:scope.quiz.itemIndex,helpKind:'writing',requestId:input.requestId,status:'completed'},db);
   if(scope.interview)await recordInterviewHelp(db,studentId,scope.interview,{kind:'ai',receiptId:input.requestId,at:new Date().toISOString(),status:'completed'});
   await db.query("insert into audit_logs(actor_id,student_id,action,data) select $1,$1,'writing.proposal',$2::jsonb where not exists(select 1 from audit_logs where student_id=$1 and action='writing.proposal' and data->>'requestId'=$3)",[studentId,JSON.stringify({requestId:input.requestId,kind:input.kind,scopeId:input.scopeId,context:scope.context,at:new Date().toISOString()}),input.requestId]);
   await saveReceipts(db,studentId,receipts.map(item=>item===pending?{...item,status:'completed',proposal}:item));
  });
  return {proposal,requestId:input.requestId,assisted:true,duplicate:false};
 }catch(error){
  await transaction(async db=>{const receipts=await lockedReceipts(db,studentId);if(receipts.some(item=>item.requestId===input.requestId&&item.attempt===attempt&&item.status==='pending'))await saveReceipts(db,studentId,receipts.map(item=>item.requestId===input.requestId&&item.attempt===attempt?{...item,status:'failed'}:item));}).catch(()=>{});
  throw error;
 }
}
export async function ownedWritingReceipt(studentId:string,requestId:string,context:Pick<WritingContext,'targetId'|'questionId'|'activityId'|'briefingId'>&{contentVersion?:string;questions?:Record<string,any>[]}){
 const [row]=await query("select data->'thoughtWritingReceipts' as receipts from student_preferences where student_id=$1",[studentId]);
 let receipt=(Array.isArray(row?.receipts)?row.receipts:[]).find((item:WritingReceipt)=>item.requestId===requestId&&item.kind==='chat'&&item.status==='completed') as WritingReceipt|undefined;
 if(!receipt){const [audit]=await query("select data from audit_logs where student_id=$1 and action='writing.proposal' and data->>'requestId'=$2 and data->>'kind'='chat' order by created_at desc limit 1",[studentId,requestId]);if(audit)receipt={...audit.data,startedAt:audit.data.at};}
 if(!receipt||['targetId','questionId','activityId','briefingId'].some(key=>(receipt.context[key as keyof WritingContext]||null)!==(context[key as keyof typeof context]||null)))throw new ApiError(409,'문장 정리를 사용한 대화의 질문에서 다시 보내 주세요.');
 const question=context.questions?.find(item=>item.id===context.questionId),version=Number(question?.common_revision||context.contentVersion);if(Number.isFinite(version)&&receipt.context.sourceVersion!==version)throw new ApiError(409,'문장 정리를 사용한 발행본에서 다시 보내 주세요.');
 return {requestId:receipt.requestId,kind:'writing' as const,assisted:true,at:receipt.startedAt};
}
