import {koreaToday} from './planner-model';
import {reconcileTrainingReviews,reviewQuestionKey,type ReviewQuestion,type ReviewQuestionStatus,type ReviewState} from './training-review';

type Question=ReviewQuestion&{title?:string};
export type TrainingDayReview={date:string;targetId:string|null;answers:number;quizAnswers:number;assignmentAnswers:number;assistedAnswers:number;remainingReview:number;questions:Array<{key:string;id:string;targetId:string;title:string;assisted:boolean;needsReview:boolean;sourceType:'personal'|'common';sourceVersion:number}>};

/** Fold the complete receipt history once; screens receive only today's bounded question list. */
export function buildTrainingDayReview(input:{questions:Question[];reviewQuestions:ReviewQuestionStatus[];date:string;targetId?:string}):TrainingDayReview{
 const status=new Map(input.reviewQuestions.map(question=>[question.questionKey,question]));
 const answered=new Map<string,{key:string;question:Question;assisted:boolean;at:string}>(),receipts=new Map<string,{kind?:string;assisted:boolean}>();
 for(const question of input.questions){
  if(input.targetId&&question.targetId!==input.targetId)continue;
  const key=reviewQuestionKey(question);
  for(const attempt of question.attempts){
   if(attempt.valid===false||!Number.isFinite(Date.parse(attempt.at))||koreaToday(new Date(attempt.at))!==input.date||!['interview_answer','quiz_response','assignment_submission'].includes(attempt.kind||''))continue;
   const previous=receipts.get(attempt.id);receipts.set(attempt.id,{kind:attempt.kind,assisted:previous?.assisted===true||attempt.assisted===true});
   const saved=answered.get(key);if(!saved)answered.set(key,{key,question,assisted:attempt.assisted===true,at:attempt.at});else{saved.assisted||=attempt.assisted===true;if(attempt.at>saved.at)saved.at=attempt.at;}
  }
 }
 return {date:input.date,targetId:input.targetId||null,answers:[...receipts.values()].filter(row=>row.kind==='interview_answer').length,quizAnswers:[...receipts.values()].filter(row=>row.kind==='quiz_response').length,assignmentAnswers:[...receipts.values()].filter(row=>row.kind==='assignment_submission').length,assistedAnswers:[...receipts.values()].filter(row=>row.assisted).length,
  remainingReview:input.reviewQuestions.filter(question=>(!input.targetId||question.targetId===input.targetId)&&question.needsReview).length,
  questions:[...answered.values()].sort((a,b)=>b.at.localeCompare(a.at)||a.key.localeCompare(b.key)).slice(0,30).map(row=>({key:row.key,id:row.question.id,targetId:row.question.targetId,title:row.question.title||'면접 질문',assisted:row.assisted,needsReview:status.get(row.key)?.needsReview===true,sourceType:row.question.sourceType,sourceVersion:row.question.sourceVersion}))};
}

/** A daily selection creates a finite request without clearing another diagnosis or counting a new answer. */
export function applyTrainingDayReflection(input:{state?:unknown;questions:Question[];planId:string;targetId?:string;date:string;questionKeys:string[];now:string}):ReviewState{
 const reconciled=reconcileTrainingReviews({state:input.state,questions:input.questions,diagnostics:{},now:input.now});
 const day=buildTrainingDayReview({questions:input.questions,reviewQuestions:reconciled.questions,date:input.date,targetId:input.targetId});
 const allowed=new Set(day.questions.map(question=>question.key)),selected=[...new Set(input.questionKeys)];
 if(selected.some(key=>!allowed.has(key)))throw new Error('오늘 실제 답한 현재 자료의 질문을 선택해 주세요.');
 const state:ReviewState={...reconciled.state,requests:[...reconciled.state.requests]};
 const existing=new Set(state.requests.map(request=>request.id));
 for(const key of selected){
  const question=input.questions.find(question=>reviewQuestionKey(question)===key)!;
  const id=JSON.stringify(['day-review',input.planId,key]);if(existing.has(id))continue;
  const {attempts,category:_,title:__,...scope}=question;
  state.requests.push({id,origin:'student',diagnosticKey:'daily:'+input.planId,selectionKey:'question:'+question.id,questionKeys:[key],scopes:[{...scope,activityIds:[...scope.activityIds]}],requestedAt:input.now,
   baselineEvidenceIds:[...new Set(attempts.filter(attempt=>attempt.valid!==false).map(attempt=>attempt.id))],status:'active',resolvedEvidenceIds:[],resolvedAt:null,reason:'오늘 정리에서 내일 다시 답할 질문으로 골랐어요.'});existing.add(id);
 }
 return reconcileTrainingReviews({state,questions:input.questions,diagnostics:{},now:input.now}).state;
}
