import assert from 'node:assert/strict';
import {test} from 'node:test';
import {interviewReviewSource,memoryReviewSource,quizReviewSource,reviewAssistance,reviewQuestionAttempts,type ReviewEvidenceSource} from '../apps/web/src/lib/training-review-evidence';

const target={id:'school-1',university:'서울시립대학교',admission_year:2027,campus:'본교',department:'환경공학부',admission_type:'학생부종합Ⅰ',interview_stage:'2단계'};
const question={id:'q-1',sourceType:'personal' as const,sourceVersion:2};
const row=(extra:Record<string,any>={})=>({id:'turn-1',question_id:question.id,created_at:'2026-10-21T01:00:00Z',session_state:'completed',target_id:target.id,session_data:{context:{targetId:target.id,target,contentVersion:2,sourceKind:'personal',questions:[{id:question.id,activity_ids:['a-1']}]}},data:{answer:'직접 측정한 결과를 비교했습니다.',answeredAt:'2026-10-21T01:05:00Z',rootQuestionId:question.id,assistance_recorded:true,assisted:false,submissionSource:'text'},...extra});
const event=(source:ReviewEvidenceSource,extra={})=>({id:'event-1',kind:source.kind,source_id:source.sourceId,data:{outcome:true,assisted:false},created_at:'2026-10-21T01:05:00Z',...extra});
const attempts=(source:ReviewEvidenceSource,events=[event(source)])=>reviewQuestionAttempts(question,target,events,[source]);

test('current owned source facts supersede a stale event and expose known independent text/voice submissions',()=>{
 const source=interviewReviewSource(row());
 assert.deepEqual(attempts(source),[{id:'interview_answer:turn-1',at:'2026-10-21T01:05:00.000Z',kind:'interview_answer',assistanceKnown:true,assisted:false,timedOut:false,valid:true,inputMode:'text'}]);
 const voice=interviewReviewSource(row({data:{...row().data,submissionSource:'recording'}}));
 assert.equal(attempts(voice)[0].inputMode,'voice');
 const corrected=interviewReviewSource(row({data:{...row().data,assisted:true,helpKinds:['ai']}}));
 assert.equal(attempts(corrected)[0].assisted,true);
 const helpRemoved=interviewReviewSource(row());
 assert.equal(attempts(helpRemoved,[event(helpRemoved,{data:{assisted:true,hintUsed:true}})])[0].assisted,false);
});

test('same submission retries, duplicate event IDs and transcript corrections remain one stable attempt',()=>{
 const source=interviewReviewSource(row()),events=[event(source),event(source,{id:'retry-event'})];
 assert.equal(reviewQuestionAttempts(question,target,events,[source,{...source}]).length,1);
 const corrected=interviewReviewSource(row({data:{...row().data,answer:'전사를 정정한 같은 답변',answerRevisions:[{revision:1},{revision:2}],transcriptRevisions:[{revision:1}]}}));
 assert.equal(attempts(corrected)[0].id,attempts(source)[0].id);
 assert.equal(attempts(corrected)[0].at,attempts(source)[0].at);
});

test('missing, invalidated, draft and discarded sources cannot be resurrected by success-looking events',()=>{
 const source=interviewReviewSource(row());
 assert.deepEqual(reviewQuestionAttempts(question,target,[event(source)],[]),[]);
 for(const change of [{data:{...row().data,invalidated:true}},{data:{...row().data,answer:' ',draft:'초안'}},{session_state:'cancelled'},{session_state:'deleted'}])assert.equal(attempts(interviewReviewSource(row(change)))[0].valid,false);
 assert.deepEqual(attempts(source,[]),[]);
});

test('unknown legacy assistance and actual partial help cannot certify independent completion',()=>{
 const legacy=interviewReviewSource(row({data:{answer:'과거 답변',assisted:false}}));
 assert.equal(attempts(legacy)[0].assistanceKnown,false);
 assert.deepEqual(reviewAssistance({assistance_recorded:true,assisted:false,helpEvents:[{phase:'before_answer',status:'partial'}]}),{assistanceKnown:true,assisted:true});
 assert.deepEqual(reviewAssistance({assistance_recorded:true,helpEvents:[{phase:'after_answer',status:'completed'}]}),{assistanceKnown:true,assisted:false});
 for(const help of [{hint_used:true},{ai_assisted:true},{helpKinds:['evidence']}])assert.equal(reviewAssistance(help).assisted,true);
});

test('support target, complete saved identity and content revision must match independently of stale event data',()=>{
 for(const change of [{target_id:'other-school'},{session_data:{context:{...row().session_data.context,target:{...target,department:'기계공학과'}}}},{session_data:{context:{...row().session_data.context,target:undefined}}},{session_data:{context:{...row().session_data.context,contentVersion:3}}}])assert.deepEqual(attempts(interviewReviewSource(row(change))),[]);
 const common=interviewReviewSource(row({data:{...row().data,sourceType:'common',commonRevision:5}}));
 assert.deepEqual(attempts(common),[]);
 assert.equal(reviewQuestionAttempts({...question,sourceType:'common',sourceVersion:5},target,[event(common)],[common]).length,1);
 assert.equal(reviewQuestionAttempts({...question,sourceType:'common',sourceVersion:6},target,[event(common)],[common]).length,0);
});

test('follow-ups do not multiply completed root recheck tasks',()=>{
 const root=interviewReviewSource(row()),followup=interviewReviewSource(row({id:'followup-1',question_id:'generated-1',data:{...row().data,rootQuestionId:question.id,questionKind:'generated',followupDepth:1}}));
 assert.equal(reviewQuestionAttempts(question,target,[event(root),event(followup)],[root,followup]).length,1);
 // Even malformed generated data borrowing a root question ID cannot count as a root submission.
 assert.deepEqual(attempts(interviewReviewSource(row({data:{...row().data,questionKind:'generated'}}))),[]);
});

const choice={id:'memory-1',question_id:question.id,practice_question_id:question.id,practice_kind:'concept',prompt:'검수한 개념',kind:'choice',verification_status:'confirmed_from_record',evaluation_method:'reviewed_correct_answer',category:'concept',activity_ids:[],source_ref_ids:[],memory_keywords:[],options:['a','b','c','d'].map(id=>({id,text:id})),correct_option_id:'b'};
const quizRow=()=>({id:'quiz-1',item:choice,mode:'choice',content_version:2,metadata:{targetId:target.id,targetSnapshot:target},data:{assistance_recorded:true},response:'',selected_option_id:'b',outcome:true,timed_out:false,hint_used:false,created_at:'2026-10-21T02:00:00Z'});
test('quiz outcome must agree with owned evaluator evidence and preserves concept identity',()=>{
 const valid=quizReviewSource(quizRow());assert.equal(attempts(valid)[0].outcome,true);
 assert.equal(attempts(quizReviewSource({...quizRow(),selected_option_id:'a'}))[0].outcome,false);
 assert.equal(attempts(quizReviewSource({...quizRow(),outcome:false}))[0].outcome,false);
 assert.equal(attempts(quizReviewSource({...quizRow(),timed_out:true}))[0].timedOut,true);
 assert.equal(attempts(quizReviewSource({...quizRow(),item:{...choice,verification_status:'needs_confirmation'}}))[0].outcome,undefined);
 const borrowed=quizReviewSource({...quizRow(),item:{...choice,practice_question_id:undefined,practice_kind:undefined}});
 assert.deepEqual(attempts(borrowed),[]);
});

test('oral/personal Q&A cannot inherit correctness and edited source help invalidates independence',()=>{
 const oral=quizReviewSource({...quizRow(),mode:'oral',response:'설명',selected_option_id:null,data:{assistance_recorded:true,response_mode:'voice',recording_id:'audio'}});
 assert.equal(attempts(oral)[0].outcome,undefined);assert.equal(attempts(oral)[0].inputMode,'voice');
 const personal=quizReviewSource({...quizRow(),mode:'answer',item:{...choice,kind:'short_speech',practice_kind:undefined},response:'경험 설명'});
 assert.equal(attempts(personal)[0].outcome,undefined);
 assert.equal(attempts(quizReviewSource({...quizRow(),hint_used:true}))[0].assisted,true);
});

test('memory self checks and missing archives remain unverified; reviewed source recomputes correctness',()=>{
 const learning:any={memory_items:[choice],questions:[{id:question.id,category:'concept',verification_status:'approved'}],answer_scripts:[],answer_designs:[],source_refs:[]};
 const memory={id:'memory-attempt',memory_item_id:choice.id,data:{answer:'b',content_version:2,target_id:target.id,target_snapshot:target,assistance_recorded:true,correct:false},created_at:'2026-10-21T03:00:00Z'};
 assert.equal(attempts(memoryReviewSource(memory,learning))[0].outcome,true);
 assert.deepEqual(attempts(memoryReviewSource(memory)),[]);
 const self=memoryReviewSource({...memory,data:{...memory.data,answer:'스스로 잘했다고 평가'}},learning);
 assert.equal(attempts(self)[0].outcome,undefined);
});
