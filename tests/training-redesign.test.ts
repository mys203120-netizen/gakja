import test from 'node:test';
import assert from 'node:assert/strict';
import {groundedChoiceItems} from '../apps/web/src/lib/grounded-choice-quiz';
import {eligibleQuizItems} from '../apps/web/src/lib/quiz-rules';
import {questionDomain} from '../apps/web/src/lib/training-domain';
import {hybridTrainingDays,type HybridQuestion,type HybridDeadline} from '../apps/web/src/lib/hybrid-training';
import {trainingOrderError} from '../apps/web/src/lib/training-order';
import {draftProposalError} from '../apps/web/src/lib/draft-proposal';
import {interviewReviewSource,quizReviewSource} from '../apps/web/src/lib/training-review-evidence';
import {reconcileTrainingReviews} from '../apps/web/src/lib/training-review';
import {DEFAULT_CURRICULUM_POLICY,curriculumPolicySnapshot,curriculumPolicySchema} from '../apps/web/src/lib/curriculum-policy';

const record=()=>({activities:Array.from({length:4},(_,i)=>({id:'a'+i,title:['수질 분석','도서 토론','화학 실험','자율 탐구'][i],area:i%2?'자율활동':'과학 세부능력 및 특기사항',fact_confirmation:'confirmed_from_record',source_ref_ids:['s'+i],activity_summary:'검증된 활동 요약',interview_priority:i===0?'S':'A'})),source_refs:Array.from({length:4},(_,i)=>({id:'s'+i,quote:`${['물의 산도와 탁도를 측정하며 표본을 비교했다','도서 속 인물의 관점을 비교하며 토론을 진행했다','용액의 농도를 바꾸고 반응 결과를 기록했다','자율 주제를 선택하고 조사 결과를 발표했다'][i]}.`,page:i+1})),questions:Array.from({length:4},(_,i)=>({id:'q'+i,prompt:'활동 설명',verification_status:'confirmed_from_record',activity_ids:['a'+i],answer_elements:[],source_ref_ids:['s'+i]})),memory_items:[],answer_scripts:[],answer_designs:[]}) as any;
test('record choices are deterministic, use four real titles and an exactly quoted source',()=>{
 const learning=record(),items=groundedChoiceItems(learning);assert.equal(items.length,4);assert.deepEqual(groundedChoiceItems(learning),items);
 for(const item of items){assert.equal(item.options?.length,4);assert.equal(new Set(item.options?.map(option=>option.text)).size,4);const activity=learning.activities.find((row:any)=>row.id===item.activity_ids[0]);assert.equal(item.options?.find(option=>option.id===item.correct_option_id)?.text,activity.title);assert.ok(item.prompt.includes(learning.source_refs.find((row:any)=>row.id===item.source_ref_ids[0]).quote));assert.equal(item.default_time_limit_seconds,10);}
 assert.equal(eligibleQuizItems(learning,'choice').length,4);assert.equal(eligibleQuizItems(learning,'answer').length,0);
});
test('ambiguous sources, too few activities and duplicate titles never become fabricated quiz keys',()=>{
 const tooFew=record();tooFew.activities.pop();assert.deepEqual(groundedChoiceItems(tooFew),[]);
 const duplicate=record();duplicate.activities[1].title=duplicate.activities[0].title;assert.deepEqual(groundedChoiceItems(duplicate),[]);
 const ambiguous=record();ambiguous.activities[1].source_ref_ids.push('s0');assert.ok(!groundedChoiceItems(ambiguous).some(item=>item.activity_ids[0]==='a0'));
 const disputed=record();disputed.activities[0].fact_confirmation='cannot_confirm';assert.deepEqual(groundedChoiceItems(disputed),[]);
 const long=record();long.source_refs[0].quote+=' 학생은 측정 조건을 함께 확인했다.'.repeat(15);const item=groundedChoiceItems(long).find(item=>item.activity_ids[0]==='a0')!;assert.match(item.prompt,/일부 발췌/);assert.ok(item.prompt.includes(long.source_refs[0].quote.slice(0,110).trim()));
});
test('analysis-only source mapping can supply a record quiz without confirming a student claim',()=>{
 const learning=record();learning.activities.forEach((activity:any)=>{activity.source_type='student_document_analysis';activity.fact_confirmation='needs_confirmation';});learning.source_refs.forEach((source:any)=>{source.type='student_document';source.verification_status='extracted_from_record';});learning.questions.forEach((question:any)=>{question.verification_status='ai_generated_grounded';});
 const before=JSON.stringify(learning);assert.equal(groundedChoiceItems(learning).length,4);assert.equal(JSON.stringify(learning),before);
 learning.source_refs[0].verification_status='needs_confirmation';assert.equal(groundedChoiceItems(learning).length,0);
});
test('student-reviewed OCR only supplies an explicitly labeled transcription-to-activity link, preserving its separate revision',()=>{
 const learning=record();learning.activities.forEach((a:any)=>{a.source_type='student_document_analysis';a.fact_confirmation='needs_confirmation';});learning.questions.forEach((q:any)=>{q.verification_status='ai_generated_grounded';});learning.source_refs.forEach((s:any)=>Object.assign(s,{type:'student_document',verification_status:'student_reviewed_transcription',quote_basis:'student_reviewed_transcription',text_revision:2,student_reviewed:true,extraction_method:'local_ocr'}));
 const before=JSON.stringify(learning),items=groundedChoiceItems(learning),eligible=eligibleQuizItems(learning,'choice');assert.equal(items.length,4);assert.equal(eligible.length,4);assert.equal(JSON.stringify(learning),before);
 assert.ok(items.every(item=>item.verification_status==='student_reviewed_transcription'&&item.prompt.includes('학생이 확인한 인식문')&&item.back?.includes('인식문과 활동 제목의 연결')));assert.ok(eligible.every(item=>item.sourceQuotes?.[0].quoteBasis==='student_reviewed_transcription'&&item.sourceQuotes[0].textRevision===2));assert.equal(eligibleQuizItems(learning,'answer').length,0);
 for(const field of ['quote_basis','text_revision','student_reviewed','extraction_method']){const invalid=structuredClone(learning);delete invalid.source_refs[0][field];assert.equal(groundedChoiceItems(invalid).length,0);}
 const revised=structuredClone(learning);revised.source_refs[0].text_revision=3;assert.notEqual(groundedChoiceItems(revised)[0].id,items[0].id);
 const source=quizReviewSource({id:'r',mode:'choice',selected_option_id:eligible[0].correct_option_id,outcome:true,item:eligible[0],data:{assistance_recorded:true},metadata:{},content_version:1});assert.equal(source.outcome,true);
 const untrusted=record();untrusted.memory_items=[{...items[0],id:'unverified-import'}];assert.ok(!eligibleQuizItems(untrusted,'choice').some(item=>item.id==='unverified-import'));
});
const today='2026-10-23',availability={version:2,startDate:today,revision:1,savedAt:'2026-10-23T00:00:00Z',weekdayMinutes:60,weekendMinutes:60,blockedDates:[],overrides:{}};
const deadline:HybridDeadline={targetId:'school',date:'2026-11-20',university:'대학',department:'학과',source:'goal',label:'준비 목표',periodStart:null,periodEnd:null,status:'ready',reason:'목표',daysLeft:28,availableMinutes:1200};
const question=(id:string,area:string):HybridQuestion=>({id,title:'활동 설명',targetId:'school',sourceType:'personal',sourceVersion:1,activityIds:['a'+id.slice(1)],category:'personal',attempts:[],area,activityTitles:['실제 활동'],quiz:{kind:'quiz',mode:'choice',itemIds:['m'+id]}});
test('one real record domain per day contains reading, choice quiz and video within capacity',()=>{
 const days=hybridTrainingDays({today,availability,deadlines:[deadline],questions:[question('q0','세특'),question('q1','자율활동')]});
 for(const day of days){assert.equal(new Set(day.tasks.map(task=>task.area)).size,1);assert.ok(day.tasks.some(task=>task.kind==='reading'));assert.ok(day.tasks.some(task=>task.kind==='quiz'));assert.ok(day.tasks.some(task=>['focus','mixed'].includes(task.kind)));assert.equal(day.tasks.at(-1)?.kind,'review');assert.equal(day.plannedMinutes,60);}
 assert.notEqual(days[0].area,days[1].area);
 const short=hybridTrainingDays({today,availability:{...availability,weekdayMinutes:5},deadlines:[deadline],questions:[question('q0','세특')],windowDays:1})[0];assert.equal(short.tasks[0].kind,'focus');assert.equal(short.plannedMinutes,5);
});
test('published numeric curriculum rules change allocations and rehearsal timing; prose is not executed',()=>{
 const rule={...DEFAULT_CURRICULUM_POLICY,readingShare:.3,quizShare:.1,reflectionMinutes:3,videoMinimumMinutes:10,rehearsalDays:14};
 const snapshot=curriculumPolicySnapshot({id:'guideline-3',version:3,rules:rule});assert.equal(snapshot.basis,'published_rules');assert.equal(snapshot.guidelineVersion,3);
 const q={...question('q0','세특'),attempts:[{at:'2026-10-22T01:00:00Z'}]},near={...deadline,date:'2026-11-02'};
 const day=hybridTrainingDays({today,availability,deadlines:[near],questions:[q],policy:snapshot.rules,windowDays:1})[0];
 assert.equal(day.tasks.find(task=>task.kind==='reading')?.minutes,18);assert.equal(day.tasks.find(task=>task.kind==='quiz')?.minutes,6);assert.equal(day.tasks.find(task=>task.kind==='review')?.minutes,3);assert.ok(day.tasks.some(task=>task.kind==='mixed'));assert.equal(day.plannedMinutes,60);
 assert.equal(hybridTrainingDays({today,availability,deadlines:[near],questions:[q],windowDays:1})[0].tasks.some(task=>task.kind==='mixed'),false);
 assert.equal(curriculumPolicySnapshot({version:4,rules:'화상 면접만 한다'}).basis,'default_policy');assert.deepEqual(curriculumPolicySnapshot().rules,DEFAULT_CURRICULUM_POLICY);
 assert.equal(curriculumPolicySchema.safeParse({...rule,readingShare:.35,quizShare:.35}).success,false);assert.equal(curriculumPolicySchema.safeParse({...rule,videoMinimumMinutes:0}).success,false);
});
test('record domain uses the highest priority source activity, never an invented generic label',()=>{
 const learning=record();assert.equal(questionDomain({...question('q0',''),activityIds:['a0','a1']},learning).area,'세특');
 learning.activities[0].area='';assert.equal(questionDomain(question('q0',''),learning).area,'영역 확인 필요');
});
test('explicit repeat off and spacing affect future automatic tasks while fixed work survives',()=>{
 const q={...question('q0','세특'),attempts:[{at:'2026-10-22T01:00:00Z',assisted:true}],repetition:{enabled:false,intervalDays:1}};
 const none=hybridTrainingDays({today,availability,deadlines:[deadline],questions:[q]});assert.ok(none.every(day=>day.tasks.length===0));assert.match(none[0].warnings!.join(''),/반복 간격/);
 const spaced=hybridTrainingDays({today,availability,deadlines:[deadline],questions:[{...q,repetition:{enabled:true,intervalDays:3}}]});assert.equal(spaced[0].tasks.length,0);assert.equal(spaced[1].tasks.length,0);assert.ok(spaced[2].tasks.length);assert.equal(spaced[3].tasks.length,0);
 const original=hybridTrainingDays({today,availability,deadlines:[deadline],questions:[question('q0','세특')],windowDays:1})[0].tasks[0];const fixed={...original,completed:true,status:'completed' as const};assert.ok(hybridTrainingDays({today,availability,deadlines:[deadline],questions:[q],fixedTasks:[fixed]})[0].tasks.some(task=>task===fixed));
});
test('order edits preserve the started position and final reflection',()=>{
 const tasks=[{id:'a',kind:'reading',startedAt:'now'},{id:'b',kind:'quiz'},{id:'c',kind:'focus'},{id:'d',kind:'review'}];assert.equal(trainingOrderError(tasks,['a','c','b','d']),null);assert.match(trainingOrderError(tasks,['b','a','c','d'])!,/시작/);assert.match(trainingOrderError(tasks,['a','b','d','c'])!,/마지막/);assert.ok(trainingOrderError(tasks,['a','b','b','d']));
});
test('draft replacement requires explicit fact confirmation and preserves changed drafts',()=>{
 const input={baseline:'원래 답변',current:'원래 답변',proposal:'확인한 제안',confirmed:true,maxLength:20};assert.equal(draftProposalError(input),null);assert.match(draftProposalError({...input,current:'학생이 새로 쓴 답변'})!,/바뀌/);assert.match(draftProposalError({...input,confirmed:false})!,/사실/);assert.ok(draftProposalError({...input,maxLength:2}));
});
test('only structured AI feedback with an exact answer excerpt becomes a repeat signal',()=>{
 const row={id:'t',question_id:'q0',data:{answer:'제가 직접 측정했습니다.',assistanceRecorded:true,answeredAt:'2026-10-22T01:00:00Z',evaluation:{needsReview:true,reason:'측정 방법을 설명해요.',evidence:['직접 측정']}},session_data:{},session_state:'completed'};
 assert.equal(interviewReviewSource(row).needsReview,true);assert.equal(interviewReviewSource({...row,data:{...row.data,evaluation:{...row.data.evaluation,evidence:['답변에 없는 말']}}}).needsReview,undefined);
 const base={id:'q0',targetId:'school',targetKey:'scope',sourceType:'personal' as const,sourceVersion:1,activityIds:['a0'],category:'personal' as const};
 const state=reconcileTrainingReviews({questions:[{...base,attempts:[{id:'t',at:'2026-10-22T01:00:00Z',kind:'interview_answer',assistanceKnown:true,assisted:false,needsReview:true,evaluationReason:'측정 방법을 설명해요.'}]}],diagnostics:{},now:'2026-10-23T01:00:00Z'});
 assert.equal(state.state.requests.filter(request=>request.status==='active').length,1);assert.match(state.state.requests[0].reason,/AI 피드백/);
});
test('a server-confirmed timed-out choice still counts as a submitted review attempt',()=>{
 const item=eligibleQuizItems(record(),'choice')[0];const source=quizReviewSource({id:'r',mode:'choice',timed_out:true,outcome:false,item,data:{assistance_recorded:true},metadata:{},content_version:1});assert.equal(source.submitted,true);assert.equal(source.outcome,false);
});


test('pressure practice is an explicit operator rule and old policies default to normal',()=>{
 const {practiceQuestionMode,...legacy}=DEFAULT_CURRICULUM_POLICY;assert.equal(curriculumPolicySchema.parse(legacy).practiceQuestionMode,'normal');
 const normal=hybridTrainingDays({today,availability,deadlines:[deadline],questions:[question('q0','세특')],windowDays:1})[0];assert.ok(normal.tasks.filter(task=>task.kind==='focus').every(task=>task.pressure===false));
 const pressure=hybridTrainingDays({today,availability,deadlines:[deadline],questions:[question('q0','세특')],policy:{...DEFAULT_CURRICULUM_POLICY,practiceQuestionMode:'pressure'},windowDays:1})[0];assert.ok(pressure.tasks.some(task=>task.kind==='focus'&&task.pressure===true));assert.ok(pressure.tasks.filter(task=>task.kind!=='focus').every(task=>task.pressure===false));
});


test('AI repeat signals use the same original speech as evaluation, even after a student edits the display answer',()=>{
 const base={id:'voice',question_id:'q0',data:{answer:'제가 전체 연구를 기획했습니다.',originalAnswer:'제가 설문을 했습니다.',speechSource:{rawText:'음 저는 설문을, 설문을 했어요.',studentEdited:true},evaluation:{needsReview:true,reason:'설문의 역할을 구체적으로 말해요.',evidence:['저는 설문을, 설문을 했어요.']}},session_data:{},session_state:'completed'};
 assert.equal(interviewReviewSource(base).needsReview,true);
 assert.equal(interviewReviewSource({...base,data:{...base.data,evaluation:{...base.data.evaluation,evidence:['전체 연구를 기획']}}}).needsReview,undefined,'a polished claim absent from the recorded speech cannot become evaluation evidence');
 const written={...base,data:{answer:'전부 제가 했습니다.',originalAnswer:'설문에 참여했습니다.',evaluation:{needsReview:true,reason:'역할을 확인해요.',evidence:['설문에 참여']}}};assert.equal(interviewReviewSource(written).needsReview,true);
});
