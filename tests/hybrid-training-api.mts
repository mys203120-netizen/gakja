import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import {registerReviewedSchool} from './school-registration-fixture.mts';

loadProjectEnv();
const base=process.env.HYBRID_TRAINING_TEST_URL||'http://localhost:3100';
if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(new URL(base).hostname)||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw new Error('Run only against the local QA server and local database.');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
const ids=[randomUUID(),randomUUID()],tokens=ids.map(()=>randomBytes(32).toString('hex')),hashes=tokens.map(token=>createHash('sha256').update(token).digest('hex'));
const emails=ids.map(id=>`hybrid-training-${id}@gakja.test`),createdIds:string[]=[],labels:string[]=[];
const check=(value:unknown,label:string)=>{assert.ok(value,label);labels.push(label);};
type Value=Record<string,any>;
async function request(path:string,body?:unknown,actor:number|null=0,status=200,origin=base,method=body===undefined?'GET':'POST'){
 const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Origin:origin,...(actor===null?{}:{Cookie:'gakja_session='+tokens[actor]})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const value=await response.json();assert.equal(response.status,status,`${path.split('?')[0]} returned ${response.status}; expected ${status}${value.code?' ('+value.code+')':''}`);labels.push(`${response.status} ${path.split('?')[0]}`);return value as Value;
}
async function addSchool(canonicalName:string,departmentName:string,track:string){
 const catalogue=await request('/api/schools/catalog',undefined,null),school=catalogue.schools.find((item:Value)=>item.canonicalName===canonicalName);
 assert.ok(school,'Expected actual school exists in the registration catalog.');
 const detail=await request('/api/schools/catalog?schoolId='+encodeURIComponent(school.id),undefined,null),department=detail.school.departments.find((item:Value)=>item.name===departmentName);
 assert.ok(department,'Expected actual department exists in the registration catalog.');
 const registered=await registerReviewedSchool((path,body)=>request(path,body).then(body=>({status:200,body})),{referenceId:school.id,departmentId:department.id,admissionYear:2027,track});
 return registered.body.target as Value;
}
const availability={weekdayMinutes:120,weekendMinutes:120,csatDate:null,beforeCsatWeekdayMinutes:20,beforeCsatWeekendMinutes:60,blockedDates:[] as string[],overrides:{} as Record<string,number>};
let failure:unknown;
await db.connect();
try{
 for(let index=0;index<ids.length;index++){
  await db.query("insert into profiles(id,email,name,role) values($1,$2,'혼합 훈련 합성 검증','student')",[ids[index],emails[index]]);createdIds.push(ids[index]);
  await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '30 minutes')",[hashes[index],ids[index]]);
 }
 await request('/api/training',undefined,null,401);
 await request('/api/training/preferences',undefined,null,401);
 const empty=await request('/api/training/preferences');check(empty.availability===null&&typeof empty.registeredAt==='string','GET has the joining timestamp and does not save default availability');
 await db.query("insert into student_preferences(student_id,data) values($1,'{\"theme\":\"fixture-theme\",\"notificationsEnabled\":false}') on conflict(student_id) do update set data=student_preferences.data||excluded.data",[ids[0]]);
 await request('/api/training/preferences',{expectedRevision:0,availability},0,403,'http://foreign.invalid');
 await request('/api/training/preferences',{expectedRevision:0,availability:{...availability,startDate:'2000-01-01'}},0,400);
 const saved=await request('/api/training/preferences',{expectedRevision:0,availability});
 check(saved.availability.revision===1&&saved.availability.startDate===empty.startDate,'Availability binds to the authenticated server joining date');
 await request('/api/training/preferences',{expectedRevision:0,availability:{...availability,weekdayMinutes:180}},0,409);
 const pref=(await db.query('select data from student_preferences where student_id=$1',[ids[0]])).rows[0].data;
 check(pref.theme==='fixture-theme'&&pref.notificationsEnabled===false,'Saving preserves unrelated preferences');
 const other=await request('/api/training/preferences',undefined,1);check(other.availability===null,'Another student does not see the saved time');

 const target=await addSchool('서울시립대학교','환경공학부','학생부종합전형Ⅰ(면접형)');
 let training=await request('/api/training?targetId='+encodeURIComponent(target.id));
 const deadline=training.deadlines.find((item:Value)=>item.targetId===target.id);
 check(deadline?.date==='2026-11-29'&&deadline.source==='public_day'&&target.interview_date===undefined,'The exact environmental department public day drives training without inventing a personal appointment');
 const expectedDays=Math.round((Date.parse('2026-11-29T00:00:00Z')-Date.parse(training.today.date+'T00:00:00Z'))/86400000);
 check(deadline.daysLeft===expectedDays&&(training.today.date!=='2026-10-20'||deadline.daysLeft===40),'Days remaining follows the actual calendar (D-40 on October 20)');
 check(training.today.capacityMinutes===120&&training.today.plannedMinutes<=120&&training.today.tasks.reduce((sum:number,item:Value)=>sum+item.minutes,0)===training.today.plannedMinutes,'The whole daily routine stays inside the 120-minute budget');
 await request('/api/training?targetId='+encodeURIComponent(target.id),undefined,1,404);
 const task=training.today.tasks.find((item:Value)=>item.kind==='diagnostic'&&item.targetId===target.id);check(Boolean(task),'A first diagnostic is part of the daily plan');
 await request('/api/training',{action:'task_start',planId:task.id},1,404);
 await request('/api/training',{action:'task_start',planId:task.id},0,403,'http://foreign.invalid');
 const startedTask=(await request('/api/training',{action:'task_start',planId:task.id})).task;
 const diagnostic=training.diagnosticInput;assert.ok(diagnostic?.questionIds?.length,'A deterministic diagnostic question list is returned.');
 const cardId=randomUUID();const card=await request('/api/armory',{id:cardId,revision:0,data:{title:'합성 수질 탐구',category:'탐구',situation:'측정 결과가 달랐다',action:'같은 시간에 조건을 기록해 재측정을 제안했다',result:'결과의 차이를 비교했다',confirmed:true,pinned:false,sourceNote:'격리된 자동 검증용 합성 경험'}});
 const startInput={action:'start',kind:'video',...diagnostic,trainingPlanId:task.id,trainingPurpose:'diagnostic',experienceCardId:cardId,experienceRevision:card.card.revision,followups:false,feedbackTiming:'end',requestId:startedTask.requestId||randomUUID()};
 await request('/api/interviews',{...startInput,sourceVersion:Number(diagnostic.sourceVersion)+999,requestId:randomUUID()},0,409);
 await request('/api/interviews',{...startInput,requestId:randomUUID()},1,409);
 // Ending a room is allowed before the frozen diagnostic list is exhausted;
 // its real first answer is evidence, but cannot complete the lesson or diagnosis.
 check(diagnostic.questionIds.length>1,'The partial-diagnostic fixture contains more than one frozen root question');
 const partial=await request('/api/interviews',{...startInput,experienceCardId:undefined,experienceRevision:undefined,requestId:randomUUID()});
 check(partial.aiAvailable===false,'The interrupted diagnostic also runs without external AI');
 const partialId=partial.session.id;
 await request('/api/training',{action:'link_session',planId:task.id,sessionId:partialId,diagnostic:true});
 await request('/api/interviews',{action:'resume',sessionId:partialId});
 const partialAnswer=await request('/api/interviews',{action:'answer',sessionId:partialId,turnId:partial.question.turnId,answer:'저는 측정 조건을 기록하고 같은 시간에 다시 측정하자고 제안했습니다.',requestId:randomUUID()});
 check(Boolean(partialAnswer.nextQuestion),'An unanswered frozen diagnostic root remains after the first real answer');
 const partialFinish=await request('/api/interviews',{action:'finish',sessionId:partialId});
 check(partialFinish.session.state==='completed'&&partialFinish.session.data.trainingProgress.allRootsAnswered===false&&partialFinish.session.data.trainingProgress.answeredRootCount===1,'Ending an interrupted room preserves its one-answer progress without claiming every root was answered');
 await request('/api/training',{action:'link_session',planId:task.id,sessionId:partialId,diagnostic:true});
 const immediatePartial=(await db.query("select data->'trainingDiagnostics'->$2 as diagnostic from student_preferences where student_id=$1",[ids[0],target.id])).rows[0].diagnostic;
 check(immediatePartial.sessionId===partialId&&immediatePartial.state==='partial'&&immediatePartial.completedAt===null,'Relinking an interrupted diagnostic immediately stores partial status before a correcting GET can run');
 const partialTraining=await request('/api/training?targetId='+encodeURIComponent(target.id));
 check(partialTraining.diagnostics.state==='partial'&&partialTraining.today.tasks.find((item:Value)=>item.id===task.id)?.status!=='completed','Today and persisted diagnosis both keep a one-answer interrupted lesson incomplete');
 const partialHistory=await request('/api/interviews?id='+partialId);
 check(partialHistory.turns.filter((turn:Value)=>turn.answer).length===1,'The interrupted lesson retains its submitted answer in history');
 const retryTask=(await request('/api/training',{action:'task_start',planId:task.id})).task;
 check(retryTask.sessionId===null&&retryTask.requestId!==startedTask.requestId,'Restarting a partial lesson clears only its ended-session pointer and creates a fresh interview request identity');
 const repeatedRetry=(await request('/api/training',{action:'task_start',planId:task.id})).task;
 check(repeatedRetry.requestId===retryTask.requestId&&repeatedRetry.sessionId===null,'Retrying task start before the replacement interview is linked reuses the fresh request rather than creating duplicate sessions');

 const session=await request('/api/interviews',{...startInput,requestId:retryTask.requestId});check(session.aiAvailable===false,'The QA server disables external AI before any answer or report is generated');
 const sessionId=session.session.id;
 await request('/api/training',{action:'link_session',planId:task.id,sessionId,diagnostic:true});
 await request('/api/training',{action:'link_session',planId:task.id,sessionId,diagnostic:true},1,404);
 const activeTask=(await request('/api/training',{action:'task_start',planId:task.id})).task;
 check(activeTask.sessionId===sessionId&&activeTask.requestId===retryTask.requestId,'An active lesson keeps its current session and request identity for ordinary resume');
 await request('/api/interviews',{action:'resume',sessionId});
 let question=session.question;const turns:Value[]=[];
 while(question){
  const response=await request('/api/interviews',{action:'answer',sessionId,turnId:question.turnId,answer:'저는 측정 조건을 표에 기록했습니다. 결과가 달라 같은 시간에 다시 측정하자고 제안했습니다. 반복한 결과를 비교하고 남은 오차도 확인했습니다.',requestId:randomUUID()});
  turns.push(response.turn);question=response.nextQuestion;
 }
 check(turns.length===diagnostic.questionIds.length,'Every fixed diagnostic question stores a real submitted text answer');
 const unfinished=await request('/api/training?targetId='+encodeURIComponent(target.id));
 check(unfinished.today.tasks.find((item:Value)=>item.id===task.id)?.status!=='completed','An unfinished interview cannot complete its daily task');
 const fullFinish=await request('/api/interviews',{action:'finish',sessionId});
 check(fullFinish.session.data.trainingProgress.allRootsAnswered===true&&fullFinish.session.data.trainingProgress.expectedRootCount===diagnostic.questionIds.length&&fullFinish.session.data.trainingProgress.answeredRootCount===diagnostic.questionIds.length,'Only answering every frozen root produces complete diagnostic progress');
 const noteId=randomUUID(),note={action:'activity_note',turnId:turns[0].id,activityId:'experience:'+cardId,body:'재측정을 제안한 본인 역할을 다시 확인했습니다.',requestId:noteId};
 await request('/api/training',note,1,404);await request('/api/training',{...note,activityId:'unrelated-activity'},0,409);await request('/api/training',note);await request('/api/training',note);
 training=await request('/api/training?targetId='+encodeURIComponent(target.id));
 check(training.diagnostics?.state==='completed','Finishing the owned diagnostic updates its durable status');
 check(training.today.tasks.find((item:Value)=>item.id===task.id)?.status==='completed','Completed session evidence marks only its actual daily task as performed');
 await request('/api/training',{action:'task_start',planId:task.id},0,409);
 const evidence=training.readiness.items.find((item:Value)=>item.id==='experience:'+cardId);
 check(evidence?.mainAnswers===turns.length&&evidence.textAttempts===turns.length&&evidence.audioAttempts===0,'Live-screen text replies update the same activity as text evidence, without inventing audio attempts');
 check(evidence.notes.length===1&&training.activityNotes.filter((item:Value)=>item.id===noteId).length===1,'Confirmed activity notes are linked and retry-idempotent');
 // Corrected source evidence is authoritative even if the old finish receipt
 // and report still contain an all-roots-complete progress snapshot.
 await db.query("update interview_turns set data=data||'{\"invalidated\":true}'::jsonb where id=$1 and session_id=$2 and student_id=$3",[turns[0].id,sessionId,ids[0]]);
 await request('/api/training',{action:'link_session',planId:task.id,sessionId,diagnostic:true});
 const invalidatedImmediate=(await db.query("select data->'trainingDiagnostics'->$2 as diagnostic from student_preferences where student_id=$1",[ids[0],target.id])).rows[0].diagnostic;
 check(invalidatedImmediate.state==='partial'&&invalidatedImmediate.completedAt===null,'Relinking recomputes an existing completed diagnosis immediately when one source answer becomes invalid');
 const invalidatedTraining=await request('/api/training?targetId='+encodeURIComponent(target.id));
 check(invalidatedTraining.diagnostics.state==='partial'&&invalidatedTraining.today.tasks.find((item:Value)=>item.id===task.id)?.status!=='completed','Invalidating one root reopens both diagnosis and lesson despite the cached complete finish receipt');
 await db.query("update interview_turns set data=data||'{\"invalidated\":true}'::jsonb where session_id=$1 and student_id=$2",[sessionId,ids[0]]);
 await request('/api/training',{action:'link_session',planId:task.id,sessionId,diagnostic:true});
 const allInvalidated=(await db.query("select data->'trainingDiagnostics'->$2 as diagnostic from student_preferences where student_id=$1",[ids[0],target.id])).rows[0].diagnostic;
 check(allInvalidated.state==='partial'&&allInvalidated.answers===0,'The already-linked diagnosis remains partial even when all of its original answers become invalid');
 const noValidTraining=await request('/api/training?targetId='+encodeURIComponent(target.id));
 check(noValidTraining.diagnostics.state==='partial'&&noValidTraining.diagnostics.answers===0&&noValidTraining.today.tasks.find((item:Value)=>item.id===task.id)?.status!=='completed','Today cannot revive a completed lesson from a finish receipt after every original answer is invalidated');
 await db.query("update interview_turns set data=data-'invalidated' where session_id=$1 and student_id=$2",[sessionId,ids[0]]);
 await request('/api/training',{action:'link_session',planId:task.id,sessionId,diagnostic:true});
 const restoredTraining=await request('/api/training?targetId='+encodeURIComponent(target.id));
 check(restoredTraining.diagnostics.state==='completed'&&restoredTraining.today.tasks.find((item:Value)=>item.id===task.id)?.status==='completed','Restoring every valid root resolves both diagnosis and lesson again without resubmitting or duplicating history');
 await request('/api/training',{action:'diagnostic_reflection',sessionId,needsReviewQuestionIds:[diagnostic.questionIds[0]],focusCategories:['major']});
 await request('/api/training',{action:'diagnostic_reflection',sessionId,needsReviewQuestionIds:['unanswered-question'],focusCategories:[]},0,409);
 const reflected=await request('/api/training?targetId='+encodeURIComponent(target.id));check(reflected.diagnostics.needsReviewQuestionIds.includes(diagnostic.questionIds[0]),'Student reflection is recorded for subsequent adaptive planning');
 await request('/api/training',{action:'link_session',planId:task.id,sessionId,diagnostic:true});
 const relinked=await request('/api/training?targetId='+encodeURIComponent(target.id));
 check(relinked.diagnostics.needsReviewQuestionIds.includes(diagnostic.questionIds[0])&&relinked.diagnostics.focusCategories.includes('major'),'Retrying the same diagnostic link preserves the student reflection');
 const emptyDiagnostic=await request('/api/interviews',{action:'start',kind:'video',...diagnostic,trainingPurpose:'diagnostic',followups:false,feedbackTiming:'end',requestId:randomUUID()});
 check(emptyDiagnostic.aiAvailable===false,'The empty-diagnostic regression also runs without external AI');
 await request('/api/interviews',{action:'finish',sessionId:emptyDiagnostic.session.id});
 await request('/api/training',{action:'link_session',sessionId:emptyDiagnostic.session.id,diagnostic:true},0,409);
 const afterEmpty=await request('/api/training?targetId='+encodeURIComponent(target.id));
 check(afterEmpty.diagnostics.sessionId===sessionId&&afterEmpty.diagnostics.needsReviewQuestionIds.includes(diagnostic.questionIds[0]),'A finished session with no submitted answers cannot replace a completed diagnosis');

 const focus=afterEmpty.today.tasks.find((item:Value)=>item.kind==='focus'&&item.targetId===target.id&&item.status!=='completed');
 check(Boolean(focus),'A focused activity task remains available after the diagnostic');
 const focusTask=(await request('/api/training',{action:'task_start',planId:focus.id})).task;
 const focusInput={action:'start',kind:'video',targetId:focusTask.targetId,sourceType:focusTask.sourceType,sourceVersion:focusTask.sourceVersion,questionId:focusTask.questionId,questionCount:1,trainingPlanId:focus.id,trainingPurpose:'focus',experienceCardId:cardId,experienceRevision:card.card.revision,followups:false,feedbackTiming:'end'};
 const firstFocus=await request('/api/interviews',{...focusInput,requestId:focusTask.requestId||randomUUID()});
 check(firstFocus.aiAvailable===false,'The focused retry regression runs without external AI');
 await request('/api/training',{action:'link_session',planId:focus.id,sessionId:firstFocus.session.id,diagnostic:false});
 await request('/api/interviews',{action:'resume',sessionId:firstFocus.session.id});
 const firstFocusText='저는 측정 조건을 기록하고 재측정을 제안했습니다.';
 await request('/api/interviews',{action:'answer',sessionId:firstFocus.session.id,turnId:firstFocus.question.turnId,answer:firstFocusText,requestId:randomUUID()});
 await request('/api/interviews',{action:'finish',sessionId:firstFocus.session.id});
 const focusFinished=await request('/api/training?targetId='+encodeURIComponent(target.id));check(focusFinished.today.tasks.find((item:Value)=>item.id===focus.id)?.status==='completed','The initial focus attempt completes the actual plan through session evidence');
 const improvement='같은 시간에 다시 측정하자고 제안한 이유를 먼저 설명하기';
 const secondFocus=await request('/api/interviews',{...focusInput,trainingImprovement:improvement,requestId:randomUUID()});
 check(secondFocus.session.id!==firstFocus.session.id&&secondFocus.session.data.trainingImprovement===improvement,'A retry creates a new session and stores the one chosen improvement');
 await request('/api/training',{action:'link_session',planId:focus.id,sessionId:secondFocus.session.id,diagnostic:false});
 await request('/api/interviews',{action:'resume',sessionId:secondFocus.session.id});
 const secondFocusText='시간에 따른 조건 차이를 줄이기 위해 같은 시간에 재측정하자고 제가 제안했습니다. 조건과 결과를 함께 기록해 차이를 비교했습니다.';
 await request('/api/interviews',{action:'answer',sessionId:secondFocus.session.id,turnId:secondFocus.question.turnId,answer:secondFocusText,requestId:randomUUID()});
 await request('/api/interviews',{action:'finish',sessionId:secondFocus.session.id});
 const firstHistory=await request('/api/interviews?id='+firstFocus.session.id),secondHistory=await request('/api/interviews?id='+secondFocus.session.id);
 check(firstHistory.turns[0].answer===firstFocusText&&secondHistory.turns[0].answer===secondFocusText&&secondHistory.session.data.trainingImprovement===improvement,'The first answer and the revised answer remain separate, durable attempts for the same question');

 const second=await addSchool('건국대학교','사회환경공학부','KU자기추천전형');
 const shared=await request('/api/training?targetId='+encodeURIComponent(second.id));
 check(shared.deadlines.some((item:Value)=>item.targetId===target.id)&&shared.deadlines.some((item:Value)=>item.targetId===second.id),'Different actual university targets share one student training routine');
 check(shared.today.capacityMinutes===120&&shared.today.plannedMinutes<=120&&shared.days.every((day:Value)=>day.plannedMinutes<=day.capacityMinutes),'Adding another university does not multiply the student time budget');
 const tomorrow=shared.days[1].date;const latestPreferences=await request('/api/training/preferences');
 await request('/api/training/preferences',{expectedRevision:latestPreferences.availability.revision,availability:{...availability,blockedDates:[tomorrow]}});
 const replanned=await request('/api/training?targetId='+encodeURIComponent(target.id)),restDay=replanned.days.find((day:Value)=>day.date===tomorrow);
 check(restDay?.capacityMinutes===0&&restDay.tasks.length===0,'A newly blocked date removes untouched future tasks and stays at zero minutes');
 check(replanned.today.tasks.some((item:Value)=>item.id===task.id&&item.status==='completed'),'Replanning preserves the completed diagnostic');
 const ownerPrefs=(await request('/api/training/preferences')).availability;await request('/api/training/preferences',{expectedRevision:0,availability:{...availability,weekdayMinutes:30}},1);
 check((await request('/api/training/preferences')).availability.revision===ownerPrefs.revision,'A second student saves only their own availability');
 const sourceDetail=await request('/api/schools/catalog?schoolId='+encodeURIComponent(target.school_reference_id),undefined,null),changedDepartment=sourceDetail.school.departments.find((item:Value)=>item.name==='경제학부');
 check(Boolean(changedDepartment),'The changed-target regression uses an actual department from the same catalog');
 const changedInput={referenceId:target.school_reference_id,departmentId:changedDepartment.id,admissionYear:2027,track:'학생부종합전형Ⅰ(면접형)'},changedPreview=await request('/api/schools/onboarding-calendar',changedInput);
 check(changedPreview.calendar.canReview===true,'The changed target has its own reviewed public calendar');
 await request('/api/schools',{...changedInput,targetId:target.id,calendarReview:{fingerprint:changedPreview.calendar.fingerprint,acknowledged:true}},0,200,base,'PATCH');
 const changedTraining=await request('/api/training?targetId='+encodeURIComponent(target.id));
 check(changedTraining.diagnostics===null,'Changing the department hides the previous target-scoped diagnosis');
 await request('/api/training',{action:'link_session',sessionId,diagnostic:true},0,409);
 await request('/api/training',{action:'task_start',planId:task.id},0,409);
 check((await request('/api/training?targetId='+encodeURIComponent(target.id))).diagnostics===null,'An old diagnostic cannot be resumed or relinked into the changed department');
 const aiCount=(await db.query('select count(*)::int count from ai_usage_logs where student_id=any($1::uuid[])',[ids])).rows[0].count;check(aiCount===0,'No external AI usage is recorded');
}catch(error){failure=error;}
finally{
 try{
  if(createdIds.length){
   const owned=(await db.query('select id,email from profiles where id=any($1::uuid[])',[createdIds])).rows;
   assert.ok(owned.every(row=>emails.includes(row.email)),'Cleanup is restricted to exact synthetic profiles created by this run.');
   await db.query('begin');
   await db.query('delete from answer_revisions where answer_id in (select id from user_answers where student_id=any($1::uuid[]))',[createdIds]);
   for(const table of ['answer_comments','user_answers','interview_reports','media_assets','interview_turns','interview_sessions','study_session_events','study_session_tabs','study_sessions','experience_card_drafts','experience_cards','student_plans','ai_usage_logs','notifications','student_preferences','school_profiles','support_targets'])await db.query(`delete from ${table} where student_id=any($1::uuid[])`,[createdIds]);
   await db.query('delete from audit_logs where actor_id=any($1::uuid[]) or student_id=any($1::uuid[])',[createdIds]);
   await db.query('delete from sessions where user_id=any($1::uuid[])',[createdIds]);
   await db.query('delete from profiles where id=any($1::uuid[]) and email=any($2::text[])',[createdIds,emails]);
   await db.query('commit');
   check((await db.query('select count(*)::int count from profiles where id=any($1::uuid[])',[createdIds])).rows[0].count===0,'All temporary profiles and their owned rows were cleaned up');
  }
 }catch(error){await db.query('rollback');failure??=error;}
 await db.end();
}
if(failure){console.error(redactEnvironmentSecrets(failure instanceof Error?failure.message:'Hybrid training API verification failed'));process.exitCode=1;}
else console.log(JSON.stringify({checks:labels.length,labels,paidAiCalls:0,cleanup:'Only exact synthetic UUID profiles created by this run'}));
