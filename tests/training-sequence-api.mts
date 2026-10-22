// Student flow against the local QA server. Only this run's synthetic UUID owner is written or cleaned up.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import {registerReviewedSchool} from './school-registration-fixture.mts';
import {nextTrainingStep,trainingSequence,trainingTaskDone} from '../apps/web/src/lib/training-flow';

loadProjectEnv();
const base=process.env.HYBRID_TRAINING_TEST_URL||'http://127.0.0.1:3188';
if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(new URL(base).hostname)||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Only a local QA server and database may run the synthetic flow.');
const db=new pg.Client({connectionString:process.env.DATABASE_URL}),student=randomUUID(),email=`training-sequence-${student}@gakja.test`,token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
type Value=Record<string,any>;
const labels:string[]=[],steps:Value[]=[],completed=new Set<string>();let created=false,failure:unknown,lateAssignment=false,quizSessionId='',quizPlanId='';
const check=(value:unknown,label:string)=>{assert.ok(value,label);labels.push(label);};
async function request(path:string,body?:unknown,status=200){
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:base,Cookie:'gakja_session='+token},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(90_000)});
 const data=await response.json();assert.equal(response.status,status,`${path.split('?')[0]} ${response.status} ${data.error||data.code||''}`);return data as Value;
}
async function state(targetId:string){return request('/api/training?targetId='+targetId);}
async function calendarAgreement(day:Value){
 const calendar=await request('/api/planner?month='+day.date.slice(0,7));
 for(const task of day.tasks){
  const plan=calendar.plans.find((plan:Value)=>plan.id===task.id);assert.ok(plan,'Every current training task has its actual calendar row');
  assert.equal(Boolean(plan.completed||plan.performedAt),trainingTaskDone(task),`${task.kind} completion agrees with the calendar`);
 }
}
async function finishInterview(task:Value,page:Value){
 const diagnostic=task.kind==='diagnostic',input={action:'start',kind:'video',mode:'basic',targetId:task.targetId,sourceType:task.sourceType,sourceVersion:task.sourceVersion,trainingPlanId:task.id,trainingPurpose:task.kind,requestId:task.requestId||randomUUID(),
  ...(diagnostic?{questionIds:page.diagnosticInput.questionIds,questionCount:page.diagnosticInput.questionIds.length}:{questionId:task.questionId,questionCount:task.kind==='mixed'?4:1}),followups:['focus','mixed'].includes(task.kind),feedbackTiming:diagnostic?'end':'turn'};
 const start=await request('/api/interviews',input);assert.equal(start.aiAvailable,false,'External AI must be disabled before any answer submission');
 if(task.kind==='mixed')check(start.session.data.followups===true&&start.session.data.maxFollowups===2,'Connected interview preserves the capped follow-up configuration');
 const sessionId=start.session.id;await request('/api/training',{action:'link_session',planId:task.id,sessionId,diagnostic});await request('/api/interviews',{action:'resume',sessionId});
 let current=start.question,answered=0;
 while(current){
  const result=await request('/api/interviews',{action:'answer',sessionId,turnId:current.turnId,answer:'먼저 제가 맡은 관찰 조건과 측정 시간을 기록했습니다. 결과가 달라 같은 조건에서 다시 비교했습니다. 제가 직접 한 행동을 근거와 연결하고 아직 확인하지 못한 한계도 설명했습니다.',requestId:randomUUID()});
  answered++;current=result.nextQuestion;if(answered>16)throw Error('Unexpected unbounded interview queue');
 }
 const finish=await request('/api/interviews',{action:'finish',sessionId});check(finish.session.data.trainingProgress.allRootsAnswered===true,`${task.kind} finishes only after every frozen root is answered`);
 if(diagnostic)await request('/api/training',{action:'link_session',planId:task.id,sessionId,diagnostic:true});
}
await db.connect();
try{
 await db.query("insert into profiles(id,email,name,role) values($1,$2,'순서형 훈련 합성 검증','student')",[student,email]);created=true;
 await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '60 minutes')",[hash,student]);
 const catalog=await request('/api/schools/catalog'),school=catalog.schools.find((school:Value)=>school.canonicalName==='서울시립대학교');assert.ok(school);
 const details=await request('/api/schools/catalog?schoolId='+school.id),department=details.school.departments.find((department:Value)=>department.name==='환경공학부');assert.ok(department);
 const registration=await registerReviewedSchool(async(path,body)=>({status:200,body:await request(path,body)}),{referenceId:school.id,departmentId:department.id,admissionYear:2027,track:'학생부종합전형Ⅰ(면접형)'}),target=registration.body.target;
 await request('/api/training/preferences',{expectedRevision:0,availability:{weekdayMinutes:120,weekendMinutes:120,csatDate:null,beforeCsatWeekdayMinutes:120,beforeCsatWeekendMinutes:120,blockedDates:[],overrides:{}}});
 let training=await state(target.id);assert.ok(training.diagnosticInput?.questionIds?.length);
 await request('/api/learning',{action:'assignment_create',requestId:randomUUID(),targetId:target.id,questionIds:training.diagnosticInput.questionIds.slice(0,1),title:'오늘 받을 첫 과제'});
 training=await state(target.id);check(training.today.tasks.some((task:Value)=>task.kind==='assignment')&&training.today.tasks.some((task:Value)=>task.kind==='quiz'),'A real quiz and received assignment share the first day budget');
 let reflectionKey='';
 for(let round=0;round<20;round++){
  const day=training.today,task=nextTrainingStep<Value>(day.tasks);if(!task)break;
  assert.equal(day.plannedMinutes,120,'Replanning keeps one complete daily budget');
  assert.equal(day.remainingMinutes,day.tasks.filter((row:Value)=>!trainingTaskDone(row)).reduce((sum:number,row:Value)=>sum+row.minutes,0));
  for(const id of completed)assert.ok(day.tasks.some((row:Value)=>row.id===id&&trainingTaskDone(row)),'The next lesson cannot erase completed source-backed work');
  steps.push({kind:task.kind,minutes:task.minutes,questionId:task.questionId});
  const page=await request('/api/training?planId='+task.id);
  if(task.kind==='review'){
   check(day.tasks.filter((row:Value)=>row.kind!=='review').every(trainingTaskDone),'Daily reflection follows all actual learning tasks');
   const late=await request('/api/learning',{action:'assignment_create',requestId:randomUUID(),targetId:target.id,questionIds:page.diagnosticInput.questionIds.slice(0,1),title:'학습을 마친 뒤 도착한 내일 과제'}),withLate=await state(target.id);
   check(withLate.today.plannedMinutes===120&&withLate.today.tasks.filter((row:Value)=>!trainingTaskDone(row)&&row.kind!=='review').length===0,'Work arriving after all learning is submitted cannot expand or reopen today learning time');
   check(withLate.days.slice(1).some((day:Value)=>day.tasks.some((row:Value)=>row.practice?.assignmentId===late.assignment.id)),'A last-minute received assignment moves into a later available day');
   check(page.dayReview.answers>0&&page.dayReview.quizAnswers>0&&page.dayReview.assignmentAnswers>0,'Reflection includes real interview, quiz and assignment receipts');
   reflectionKey=page.dayReview.questions[0].key;
   await request('/api/training',{action:'day_reflection',planId:task.id,requestId:randomUUID(),improvement:'제가 직접 한 행동부터 답하는 순서로 바꿨다.',revisitQuestionKeys:[reflectionKey]});
  }else{
   const started=(await request('/api/training',{action:'task_start',planId:task.id})).task;
   if(task.kind==='focus'&&!lateAssignment){
    const assigned=await request('/api/learning',{action:'assignment_create',requestId:randomUUID(),targetId:target.id,questionIds:page.diagnosticInput.questionIds.slice(0,1),title:'집중 연습 중 도착한 과제'});lateAssignment=true;
    const replanned=await state(target.id);check(replanned.today.tasks.some((row:Value)=>row.id===task.id&&row.status==='in_progress'),'Receiving work preserves the currently open lesson');
    check(replanned.days.some((day:Value)=>day.tasks.some((row:Value)=>row.practice?.assignmentId===assigned.assignment.id)),'A newly received assignment is scheduled in the remaining shared capacity');
    const sameFocus=replanned.today.tasks.filter((row:Value)=>row.kind==='focus'&&row.questionId===task.questionId&&row.targetId===task.targetId&&row.sourceType===task.sourceType&&row.sourceVersion===task.sourceVersion);
    assert.equal(sameFocus.length,1,'Replanning does not duplicate the open focus question when other questions are eligible');
   }
   if(task.kind==='quiz'){
    const quiz=await request('/api/quiz',{action:'create',trainingPlanId:task.id,targetId:started.targetId,sourceType:started.sourceType,sourceVersion:started.sourceVersion,mode:started.practice.mode,itemIds:started.practice.itemIds});
    quizSessionId=quiz.session.id;quizPlanId=task.id;
    for(let index=0;index<quiz.session.items.length;index++){
     await request('/api/quiz',{action:'start',sessionId:quiz.session.id});
     await request('/api/quiz',{action:'answer',sessionId:quiz.session.id,itemIndex:index,response:'제가 직접 기록한 조건과 결과를 근거로 차이와 한계를 설명하겠습니다.',responseMode:'text',rating:'good',recallStatus:'remembered',requestId:randomUUID()});
    }
   }else if(task.kind==='assignment'){
    const assignmentId=started.practice.assignmentId;await request('/api/learning',{action:'assignment_start',assignmentId,requestId:randomUUID()});
    const workflow=await request('/api/learning'),assignment=workflow.assignments.find((row:Value)=>row.id===assignmentId);assert.equal(assignment.state,'in_progress');
    await request('/api/learning',{action:'assignment_submit',assignmentId,requestId:randomUUID(),responses:assignment.items.map((item:Value)=>({memoryItemId:item.id||item.memory_item_id,response:'관찰 조건을 먼저 확인하고 제가 직접 한 일과 그 결과를 구분해 답하겠습니다.',rating:'good'}))});
   }else await finishInterview(started,page);
  }
  completed.add(task.id);training=await state(target.id);
  check(training.today.tasks.some((row:Value)=>row.id===task.id&&trainingTaskDone(row)),`${task.kind} is complete through its actual persisted source`);
  await calendarAgreement(training.today);
 }
 check(nextTrainingStep(training.today.tasks)===null&&training.today.remainingMinutes===0,'The complete sequence terminates at zero remaining time without regenerating more unfinished work');
 check(['diagnostic','quiz','assignment','focus','mixed','review'].every(kind=>steps.some(step=>step.kind===kind)),'The real sequence visited every planned tool and reflection');
 const stable=trainingSequence<Value>(training.today.tasks).map(task=>[task.id,task.status,task.minutes]),reread=await state(target.id);
 assert.deepEqual(trainingSequence<Value>(reread.today.tasks).map(task=>[task.id,task.status,task.minutes]),stable,'Repeated completed-day reads do not reorder, resize or replace lessons');
 check(reread.review.questions.some((row:Value)=>row.questionKey===reflectionKey&&row.status==='active')&&reread.readiness.items.some((row:Value)=>row.reviewQuestionKeys.includes(reflectionKey)&&row.reviewStatus==='active'),'The explicit daily recheck appears in both Today and readiness');
 check(reread.days.slice(1).some((day:Value)=>day.tasks.some((task:Value)=>task.questionId===JSON.parse(reflectionKey)[4]&&['focus','recall'].includes(task.kind))),'Next-day planning retains the exact selected question for another attempt');
 const originalResponses=(await db.query('select id,data from quiz_responses where student_id=$1 and session_id=$2',[student,quizSessionId])).rows;
 assert.ok(originalResponses.length);await db.query("update quiz_responses set data=data||'{\"invalidated\":true}'::jsonb where student_id=$1 and session_id=$2",[student,quizSessionId]);
 const reopened=await state(target.id);check(nextTrainingStep<Value>(reopened.today.tasks)?.id===quizPlanId,'An invalidated completed quiz becomes the next actual lesson even after daily reflection was saved');
 await calendarAgreement(reopened.today);
 check(reopened.dayReview.quizAnswers===reread.dayReview.quizAnswers-originalResponses.length,'Daily summary removes the invalidated original quiz submissions');
 for(const response of originalResponses)await db.query('update quiz_responses set data=$3::jsonb where student_id=$1 and id=$2',[student,response.id,JSON.stringify(response.data)]);
 const restored=await state(target.id);check(nextTrainingStep(restored.today.tasks)===null&&restored.today.remainingMinutes===0,'Restoring the same original quiz receipts completes the same lesson without adding another session');
 await calendarAgreement(restored.today);
 check((await db.query('select count(*)::int count from ai_usage_logs where student_id=$1',[student])).rows[0].count===0,'The full lifecycle issued no paid AI calls');
}catch(error){failure=error;}
finally{
 try{if(created){
  assert.equal((await db.query('select email from profiles where id=$1',[student])).rows[0]?.email,email);await db.query('begin');
  await db.query('delete from answer_revisions where answer_id in(select id from user_answers where student_id=$1)',[student]);
  for(const table of ['answer_comments','user_answers','memory_attempts','quiz_responses','quiz_recordings','quiz_sessions','quiz_submissions','quiz_assignment_events','quiz_assignments','learning_requests','interview_reports','media_assets','interview_turns','interview_sessions','study_session_events','study_session_tabs','study_sessions','experience_card_drafts','experience_cards','student_plans','ai_usage_logs','notifications','student_preferences','school_profiles','support_targets'])await db.query(`delete from ${table} where student_id=$1`,[student]);
  await db.query('delete from audit_logs where actor_id=$1 or student_id=$1',[student]);await db.query('delete from sessions where user_id=$1',[student]);await db.query('delete from profiles where id=$1 and email=$2',[student,email]);await db.query('commit');
 }}catch(error){await db.query('rollback');failure??=error;}await db.end();
}
if(failure){console.error(redactEnvironmentSecrets(failure instanceof Error?failure.stack||failure.message:'Training sequence verification failed'));console.error(JSON.stringify({steps,checks:labels}));process.exitCode=1;}
else console.log(JSON.stringify({checks:labels.length,labels,steps,paidAiCalls:0,cleanup:'Exact synthetic student only'}));
