import type {LearningData} from '@gakja/content-contracts';
import {recordMatchesCurrentTarget} from './learning-target-scope';
import {memoryReviewOutcome,quizAnswerContext} from './learning-record-rules';
import {quizOutcome,type QuizMode,type SessionItem} from './quiz-rules';

type Value=Record<string,any>;
export type ReviewAttempt={id:string;at:string;kind?:'interview_answer'|'quiz_response'|'memory_review';assistanceKnown:boolean;assisted:boolean;timedOut?:boolean;outcome?:boolean;valid?:boolean;inputMode?:string};
export type ReviewEvidenceSource={kind:'interview_answer'|'quiz_response'|'memory_review';sourceId:string;questionId:string;record:Value;at:unknown;submitted:boolean;invalidated?:boolean;followup?:boolean;assistanceKnown:boolean;assisted:boolean;timedOut?:boolean;outcome?:boolean;inputMode?:string};
type QuestionScope={id:string;sourceType:'personal'|'common';sourceVersion:number};
const text=(value:unknown)=>typeof value==='string'?value:'';
const reviewed=new Set(['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student']);

/** Missing legacy help logs do not certify independent work. Current source facts supersede event snapshots. */
export function reviewAssistance(data:Value={},hintUsed:unknown=false){
 const receipts=(Array.isArray(data.helpEvents)?data.helpEvents:[]).filter((event:Value)=>event.phase!=='after_answer');
 const kinds=Array.isArray(data.helpKinds)?data.helpKinds:[];
 const assisted=hintUsed===true||data.hint_used===true||data.hintUsed===true||data.assisted===true||data.ai_assisted===true||data.aiAssisted===true||kinds.length>0||receipts.length>0;
 return {assistanceKnown:data.assistance_recorded===true||data.assistanceRecorded===true||assisted,assisted};
}

/** Root answers are submissions; their transcript/answer revisions and generated follow-ups are not extra root attempts. */
export function interviewReviewSource(row:Value):ReviewEvidenceSource{
 const data=row.data||{},session=row.session_data||{},context=session.context||{},root=(context.questions||[]).find((question:Value)=>question.id===(data.rootQuestionId||row.question_id));
 return {kind:'interview_answer',sourceId:String(row.id),questionId:String(row.question_id||''),
  record:{targetId:row.target_id||context.targetId,targetSnapshot:context.target,sourceType:data.sourceType||root?.source_type||context.sourceKind,contentVersion:data.contentVersion??context.contentVersion,commonRevision:data.commonRevision??root?.common_revision},
  at:data.answeredAt||row.created_at,submitted:Boolean(text(data.answer).trim()),invalidated:data.invalidated===true||['cancelled','deleted'].includes(row.session_state),
  followup:data.questionKind==='generated'||Number(data.followupDepth)>0||Boolean(data.rootQuestionId&&data.rootQuestionId!==row.question_id),
  ...reviewAssistance(data),timedOut:data.timedOut===true||data.timed_out===true,
  inputMode:data.submissionSource==='recording'?'voice':data.submissionSource==='text'?'text':undefined};
}

/** Correctness is rechecked against the owned frozen item, never a self rating or stale event outcome. */
export function quizReviewSource(row:Value,learning?:LearningData):ReviewEvidenceSource{
 const data=row.data||{},item=row.item||{},metadata=row.metadata||{},identity=quizAnswerContext(item,data,learning);
 const mode:QuizMode=data.submitted_mode==='answer'?'answer':row.mode==='choice'?'choice':row.mode==='oral'?'oral':'answer';
 const timedOut=row.timed_out===true||data.timed_out===true;
 let outcome:boolean|undefined;
 if(reviewed.has(item.verification_status)){
  const evaluated=quizOutcome(item as SessionItem,mode,text(row.response),typeof row.selected_option_id==='string'?row.selected_option_id:null,timedOut);
  if(evaluated===false||row.outcome===false)outcome=false;
  else if(evaluated===true&&row.outcome===true)outcome=true;
 }
 return {kind:'quiz_response',sourceId:String(row.id),questionId:identity.question_id,
  record:{targetId:data.target_id||data.targetId||item.target_id||metadata.targetId,targetSnapshot:data.target_snapshot||data.targetSnapshot||item.target_snapshot||metadata.targetSnapshot,sourceType:data.source_type||data.sourceType||item.source_kind,contentVersion:row.content_version,commonRevision:data.common_revision??data.commonRevision??item.common_revision},
  at:row.created_at,submitted:mode==='choice'?Boolean(row.selected_option_id):Boolean(text(row.response).trim()||data.recording_id),invalidated:data.invalidated===true,
  ...reviewAssistance(data,row.hint_used),timedOut,...(outcome===undefined?{}:{outcome}),inputMode:data.response_mode==='voice'?'voice':mode==='choice'?'choice':'text'};
}

export function memoryReviewSource(row:Value,learning?:LearningData):ReviewEvidenceSource{
 const data=row.data||{},item=learning?.memory_items.find(item=>item.id===row.memory_item_id),identity=item?quizAnswerContext(item,data,learning):null;
 let outcome:boolean|undefined;
 if(learning&&item){try{const result=memoryReviewOutcome(learning,row.memory_item_id,data.answer);if(typeof result==='boolean')outcome=result;}catch{}}
 return {kind:'memory_review',sourceId:String(row.id),questionId:identity?.question_id||'',
  record:{targetId:data.target_id||data.targetId,targetSnapshot:data.target_snapshot||data.targetSnapshot,sourceType:data.source_type||data.sourceType,contentVersion:data.content_version,commonRevision:data.common_revision??data.commonRevision},
  at:row.created_at,submitted:Boolean(text(data.answer).trim()),invalidated:data.invalidated===true,
  ...reviewAssistance(data),timedOut:data.timed_out===true||data.timedOut===true,...(outcome===undefined?{}:{outcome}),inputMode:data.response_mode==='voice'?'voice':'text'};
}

/** Events discover a real owned source; they cannot resurrect a deleted/invalidated source or supply success/help facts. */
export function reviewQuestionAttempts(question:QuestionScope,target:Value,events:Value[],sources:ReviewEvidenceSource[]):ReviewAttempt[]{
 const discovered=new Set(events.map(event=>`${event.kind}:${event.source_id}`)),seen=new Set<string>(),attempts:ReviewAttempt[]=[];
 for(const source of sources){
  const id=`${source.kind}:${source.sourceId}`,record=source.record,common=record.commonRevision??record.common_revision;
  if(!discovered.has(id)||seen.has(id)||source.followup||source.questionId!==question.id||!recordMatchesCurrentTarget(record,[target]))continue;
  if(question.sourceType==='common'?Number(common)!==question.sourceVersion:Boolean(common)||Number(record.contentVersion??record.content_version)!==question.sourceVersion)continue;
  if(question.sourceType==='personal'&&(record.sourceType==='common'||record.source_type==='common'))continue;
  if(question.sourceType==='common'&&(record.sourceType==='personal'||record.source_type==='personal'))continue;
  const at=source.at instanceof Date?source.at:new Date(String(source.at));if(!Number.isFinite(at.getTime()))continue;
  seen.add(id);attempts.push({id,at:at.toISOString(),kind:source.kind,assistanceKnown:source.assistanceKnown,assisted:source.assisted,timedOut:source.timedOut===true,...(typeof source.outcome==='boolean'?{outcome:source.outcome}:{}),valid:source.submitted&&!source.invalidated,inputMode:source.inputMode});
 }
 return attempts.sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id));
}
