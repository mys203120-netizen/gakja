import {recordMatchesCurrentTarget} from './learning-target-scope';
import type {ReviewQuestionStatus} from './training-review';

type Value=Record<string,any>;
export type TrainingActivityRow={id:string;kind:'activity'|'experience'|'question';title:string;sourceHref:string;editHref:string;questionCount:number;mainAnswers:number;followupAnswers:number;textAttempts:number;audioAttempts:number;assistedAttempts:number;needsReview:string[];reviewStatus:'active'|'resolved'|'clear';reviewQuestionKeys:string[];reviewReasons:string[];lastPracticedAt:string|null;unconfirmed:boolean;notes:Value[]};

/** Counts submitted evidence in its original scope. A draft, AI rewrite or elapsed day is not an attempt. */
export function foldTrainingEvidence(input:{learning:Value;cards:Value[];turns:Value[];events:Value[];target?:Value;contentVersion:number|null;notes?:Value[];reviewQuestions?:ReviewQuestionStatus[]}){
 const rows=new Map<string,TrainingActivityRow>();
 const questions:Value[]=(input.learning.questions||[]).filter((q:Value)=>!q.support_target_ids?.length||q.support_target_ids.includes(input.target?.id));
 const linkedRows=new Map<string,Set<string>>();
 const link=(questionId:string,ids:Iterable<string>)=>{const linked=linkedRows.get(questionId)||new Set<string>();for(const id of ids)linked.add(id);linkedRows.set(questionId,linked);};
 const base=(id:string,kind:TrainingActivityRow['kind'],title:string,href:string,unconfirmed=false):TrainingActivityRow=>({id,kind,title,sourceHref:href,editHref:href,questionCount:0,mainAnswers:0,followupAnswers:0,textAttempts:0,audioAttempts:0,assistedAttempts:0,needsReview:[],reviewStatus:'clear',reviewQuestionKeys:[],reviewReasons:[],lastPracticedAt:null,unconfirmed,notes:(input.notes||[]).filter(note=>note.activityId===id)});
 for(const activity of input.learning.activities||[]){
  const linked=questions.filter(q=>q.activity_ids?.includes(activity.id));
  if(!linked.length&&input.target&&activity.support_target_ids?.length&&!activity.support_target_ids.includes(input.target.id))continue;
  const row=base(activity.id,'activity',activity.title,'/materials/activities/'+encodeURIComponent(activity.id),!['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student'].includes(activity.fact_confirmation));row.questionCount=linked.length;rows.set(row.id,row);
 }
 for(const card of input.cards){const row=base('experience:'+card.id,'experience',card.data.title,'/armory?card='+encodeURIComponent(card.id),!card.data.confirmed);rows.set(row.id,row);}
 const seen=new Set<string>();
 function add(row:TrainingActivityRow,value:Value,at:string,followup:boolean,audio:boolean){
  row.mainAnswers+=Number(!followup);row.followupAnswers+=Number(followup);row.audioAttempts+=Number(audio);row.textAttempts+=Number(!audio);row.assistedAttempts+=Number(value.assisted===true||value.hintUsed===true||value.hint_used===true);
  if(!row.lastPracticedAt||at>row.lastPracticedAt)row.lastPracticedAt=at;
 }
 for(const turn of input.turns){
  const data=turn.data||{},context=turn.session_data?.context||{};
  if(!data.answer?.trim()||data.invalidated||seen.has('turn:'+turn.id))continue;
  if(input.target&&!recordMatchesCurrentTarget({targetId:turn.target_id,targetSnapshot:context.target},[input.target]))continue;
  const rootId=data.rootQuestionId||turn.question_id,root=(context.questions||[]).find((q:Value)=>q.id===rootId);
  const commonRevision=data.commonRevision??root?.common_revision;
  const common=context.sourceKind==='common'||Number(commonRevision)>0;
  if(common&&!questions.some(q=>q.id===rootId&&Number(q.common_revision)===Number(commonRevision)))continue;
  if(!common&&Number(context.contentVersion)!==Number(input.contentVersion))continue;
  const ids=new Set<string>(root?.activity_ids||[]);if(context.activityId)ids.add(context.activityId);
  const experience=turn.session_data?.experienceCard;
  if(experience){const current=input.cards.find(card=>card.id===experience.id);if(current?.revision===experience.revision)ids.add('experience:'+experience.id);}
  if(!ids.size){const key='question:'+rootId;if(!rows.has(key)){const row=base(key,'question',root?.prompt||data.question,'/records/comparisons/'+encodeURIComponent(rootId));row.questionCount=1;rows.set(key,row);}ids.add(key);}
  const audio=data.submissionSource==='recording'||data.submissionSource!=='text'&&Boolean(data.speechSource?.rawText&&data.speechSource?.studentEdited!==true);
  link(rootId,ids);
  for(const id of ids){const row=rows.get(id);if(row)add(row,data,String(data.answeredAt||turn.created_at),data.questionKind==='generated'||Number(data.followupDepth)>0,audio);}
  seen.add('turn:'+turn.id);
 }
 for(const event of input.events){
  const value=event.data||{},receipt='event:'+event.kind+':'+(event.source_id||event.id);if(event.kind==='interview_answer'||!['quiz_response','assignment_submission','memory_review'].includes(event.kind)||seen.has(receipt))continue;
  if(input.target&&!recordMatchesCurrentTarget(value,[input.target]))continue;
  const question=questions.find(q=>q.id===value.questionId);if(!question)continue;
  const commonRevision=value.commonRevision??value.common_revision;
  if(Number(commonRevision)>0?Number(question.common_revision)!==Number(commonRevision):Number(value.contentVersion||value.content_version)!==Number(input.contentVersion))continue;
  const text=value.answer||value.response;if(typeof text!=='string'||!text.trim())continue;
  const ids=new Set<string>(question.activity_ids||[]);
  if(!ids.size){const key='question:'+question.id;if(!rows.has(key)){const row=base(key,'question',question.prompt,'/records/comparisons/'+encodeURIComponent(question.id));row.questionCount=1;rows.set(key,row);}ids.add(key);}
  link(question.id,ids);
  for(const id of ids){const row=rows.get(id);if(row)add(row,value,String(event.created_at),false,value.inputMode==='voice'||Boolean(value.recordingId||value.audioId));}
  seen.add(receipt);
 }
 for(const row of rows.values()){
  if(row.unconfirmed)row.needsReview.push('활동 사실 확인');
  if(!row.mainAnswers&&!row.followupAnswers)row.needsReview.push('아직 답변하지 않음');
  else {if(!row.audioAttempts)row.needsReview.push('말하기 미확인');if(!row.followupAnswers)row.needsReview.push('꼬리질문 미확인');}
 }
 // Current review state is supplied by the same reconciliation used for today's plan.
 // Historical assistance counts above remain history, even after a recheck is resolved.
 for(const review of input.reviewQuestions||[]){
  if(input.target&&review.targetId!==input.target.id)continue;
  const question=questions.find(q=>q.id===review.questionId);
  const ids=new Set([...review.activityIds,...(question?.activity_ids||[]),...(linkedRows.get(review.questionId)||[])]);
  const questionKey='question:'+review.questionId;
  if(rows.has(questionKey))ids.add(questionKey);
  if(![...ids].some(id=>rows.has(id))&&review.status!=='clear'){
   const row=base(questionKey,'question',question?.prompt||'재확인할 질문','/records/comparisons/'+encodeURIComponent(review.questionId));row.questionCount=1;rows.set(questionKey,row);ids.add(questionKey);
  }
  for(const id of ids){
   const row=rows.get(id);if(!row)continue;
   row.reviewQuestionKeys.push(review.questionKey);
   if(review.status==='active'){
    row.reviewStatus='active';
    if(review.reason&&!row.reviewReasons.includes(review.reason))row.reviewReasons.push(review.reason);
   }else if(review.status==='resolved'&&row.reviewStatus!=='active')row.reviewStatus='resolved';
  }
 }
 for(const row of rows.values())row.reviewQuestionKeys=[...new Set(row.reviewQuestionKeys)];
 const items=[...rows.values()];return {items,summary:{total:items.length,practiced:items.filter(row=>row.mainAnswers+row.followupAnswers>0).length,unconfirmed:items.filter(row=>row.unconfirmed).length},observationOnly:true};
}
