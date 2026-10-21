import assert from 'node:assert/strict';
import test from 'node:test';
import {applyTrainingDayReflection,buildTrainingDayReview} from '../apps/web/src/lib/training-day-review';
import {applyReviewReflection,reconcileTrainingReviews,reviewQuestionKey,type ReviewQuestion} from '../apps/web/src/lib/training-review';

const date='2026-10-21',at='2026-10-21T01:00:00.000Z',now='2026-10-21T02:00:00.000Z';
const question=(overrides:Partial<ReviewQuestion>={}):ReviewQuestion&{title:string}=>({id:'q-a',title:'내가 한 활동',targetId:'school-a',targetKey:'school-a/current',sourceType:'personal',sourceVersion:2,activityIds:['activity-a'],category:'personal',attempts:[{id:'interview_answer:first',at,kind:'interview_answer',assistanceKnown:true,assisted:false}],...overrides});
const statuses=(questions:ReviewQuestion[])=>reconcileTrainingReviews({questions,diagnostics:{},now}).questions;

test('daily summary counts unique owned current receipts, quiz and help without replaying historical work',()=>{
 const a=question({attempts:[{id:'interview_answer:first',at,kind:'interview_answer',assisted:true},{id:'interview_answer:first',at,kind:'interview_answer',assisted:true},{id:'quiz_response:quiz',at,kind:'quiz_response',assisted:false},{id:'interview_answer:invalid',at,kind:'interview_answer',valid:false},{id:'interview_answer:yesterday',at:'2026-10-20T14:59:59Z',kind:'interview_answer'}]});
 const b=question({targetId:'school-b',targetKey:'school-b/current',attempts:[{id:'interview_answer:other',at,kind:'interview_answer',assisted:false}]});
 const questions=[a,b],own=buildTrainingDayReview({questions,reviewQuestions:statuses(questions),date,targetId:'school-a'});
 assert.equal(own.answers,1);assert.equal(own.quizAnswers,1);assert.equal(own.assistedAnswers,1);assert.equal(own.questions.length,1);assert.equal(own.questions[0].assisted,true);
 const all=buildTrainingDayReview({questions,reviewQuestions:statuses(questions),date});assert.equal(all.answers,2);assert.equal(all.questions.length,2);assert.equal(all.targetId,null);
});

test('reflection is idempotent, preserves diagnostic requests, and never resolves from its baseline answer',()=>{
 const q=question(),questions=[q],key=reviewQuestionKey(q);
 const state=applyTrainingDayReflection({questions,planId:'plan-a',date,questionKeys:[key,key],now});
 assert.equal(state.requests.length,1);assert.equal(state.requests[0].status,'active');assert.deepEqual(state.requests[0].baselineEvidenceIds,['interview_answer:first']);
 const repeated=applyTrainingDayReflection({state,questions,planId:'plan-a',date,questionKeys:[key],now:'2026-10-21T03:00:00Z'});assert.deepEqual(repeated,state);
 const later=applyTrainingDayReflection({state,questions,planId:'plan-b',date,questionKeys:[key],now:'2026-10-21T04:00:00Z'});assert.equal(later.requests.length,2);assert.ok(later.requests.every(request=>request.status==='active'));
 const diagnosis=applyReviewReflection({questions,targetId:q.targetId,diagnostic:{sessionId:'diagnostic-a',targetKey:q.targetKey,sourceType:q.sourceType,sourceVersion:q.sourceVersion,questionIds:[q.id],reviewSchemaVersion:1},needsReviewQuestionIds:[q.id],focusCategories:[],now});
 const combined=applyTrainingDayReflection({state:diagnosis,questions,planId:'plan-a',date,questionKeys:[key],now});assert.equal(combined.requests.length,2);assert.ok(combined.requests.every(request=>request.status==='active'));
});

test('only a later unassisted record in the exact school, question, activity and content scope resolves; corrections reopen',()=>{
 const q=question(),key=reviewQuestionKey(q),questions=[q];
 const state=applyTrainingDayReflection({questions,planId:'plan-a',date,questionKeys:[key],now});
 const independent={id:'interview_answer:independent',at:'2026-10-22T01:00:00Z',kind:'interview_answer' as const,assistanceKnown:true,assisted:false};
 const other=question({targetId:'school-b',targetKey:'school-b/current',attempts:[independent]});
 const otherVersion=question({sourceVersion:3,attempts:[independent]});
 assert.equal(reconcileTrainingReviews({state,questions:[q,other,otherVersion],diagnostics:{},now}).state.requests[0].status,'active');
 const resolved=question({attempts:[...q.attempts,independent]});
 const result=reconcileTrainingReviews({state,questions:[resolved],diagnostics:{},now});assert.equal(result.state.requests[0].status,'resolved');assert.deepEqual(result.state.requests[0].resolvedEvidenceIds,[independent.id]);
 for(const correction of [{valid:false},{assisted:true}]){
  const changed=question({attempts:[...q.attempts,{...independent,...correction}]});
  assert.equal(reconcileTrainingReviews({state:result.state,questions:[changed],diagnostics:{},now}).state.requests[0].status,'active');
 }
 const changedActivity=question({activityIds:['activity-b'],attempts:[...q.attempts,independent]});
 assert.equal(reconcileTrainingReviews({state,questions:[changedActivity],diagnostics:{},now}).state.requests[0].status,'out_of_scope');
});

test('yesterday, invalidated, foreign and former-version keys cannot be selected through daily reflection',()=>{
 const q=question(),key=reviewQuestionKey(q);
 for(const questions of [[question({attempts:[]})],[question({attempts:q.attempts.map(attempt=>({...attempt,valid:false}))})],[question({targetId:'school-b',targetKey:'b'})],[question({sourceVersion:3})]])assert.throws(()=>applyTrainingDayReflection({questions,planId:'plan-a',date,questionKeys:[key],now}),/오늘 실제 답한 현재 자료/);
});

test('daily choice payload remains bounded as records grow while totals remain complete',()=>{
 const questions=Array.from({length:80},(_,index)=>question({id:'q-'+index,attempts:[{id:'interview_answer:'+index,at,kind:'interview_answer',assisted:false}]}));
 const summary=buildTrainingDayReview({questions,reviewQuestions:statuses(questions),date});assert.equal(summary.answers,80);assert.equal(summary.questions.length,30);
});

test('quiz and assignment receipts appear once in the daily summary while their memory side effects do not',()=>{
 const q=question({attempts:[{id:'quiz_response:q1',at,kind:'quiz_response',assisted:false,outcome:true},{id:'assignment_submission:a1',at,kind:'assignment_submission',assisted:true},{id:'assignment_submission:a1',at,kind:'assignment_submission',assisted:true},{id:'memory_review:m1',at,kind:'memory_review',assisted:true,outcome:false}]});
 const day=buildTrainingDayReview({questions:[q],reviewQuestions:statuses([q]),date});
 assert.equal(day.answers,0);assert.equal(day.quizAnswers,1);assert.equal(day.assignmentAnswers,1);assert.equal(day.assistedAnswers,1);assert.equal(day.questions.length,1);
});
