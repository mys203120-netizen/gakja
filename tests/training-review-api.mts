// Local HTTP/PostgreSQL lifecycle QA. Every mutation is restricted to this run's exact synthetic UUID owner.
// HYBRID_TRAINING_TEST_URL=http://127.0.0.1:3117 node --import tsx tests/training-review-api.mts
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import {registerReviewedSchool} from './school-registration-fixture.mts';

loadProjectEnv();
const base=process.env.HYBRID_TRAINING_TEST_URL||'http://127.0.0.1:3117',server=new URL(base),database=new URL(process.env.DATABASE_URL!);
if(process.env.AUTH_MODE!=='local'||server.protocol!=='http:'||!['localhost','127.0.0.1'].includes(server.hostname)||!['localhost','127.0.0.1'].includes(database.hostname))throw new Error('Local synthetic fixture server and local PostgreSQL only.');
const db=new pg.Client({connectionString:process.env.DATABASE_URL}),student=randomUUID(),email=`training-review-${student}@gakja.test`,token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
type Value=Record<string,any>;
const labels:string[]=[];
let created=false,failure:unknown;
function check(value:unknown,label:string){assert.ok(value,label);labels.push(label);}
async function request(path:string,body?:unknown){
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:base,Cookie:'gakja_session='+token},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(60_000)});
 const value=await response.json();assert.equal(response.status,200,`${path.split('?')[0]}: ${response.status}: ${value.error||value.code||''}`);return value as Value;
}
async function addSchool(name:string,departmentName:string,track:string){
 const catalog=await request('/api/schools/catalog'),school=catalog.schools.find((item:Value)=>item.canonicalName===name);assert.ok(school,'actual school catalog entry exists');
 const detail=await request('/api/schools/catalog?schoolId='+encodeURIComponent(school.id)),department=detail.school.departments.find((item:Value)=>item.name===departmentName);assert.ok(department,'actual department exists');
 return (await registerReviewedSchool(async(path,body)=>({status:200,body:await request(path,body)}),{referenceId:school.id,departmentId:department.id,admissionYear:2027,track})).body.target as Value;
}
async function preferences(){return (await db.query('select data from student_preferences where student_id=$1',[student])).rows[0]?.data||{};}
async function savedRequest(id:string){const state=(await preferences()).trainingReview;return state?.requests.find((item:Value)=>item.id===id) as Value;}
async function training(targetId:string){return request('/api/training?targetId='+encodeURIComponent(targetId));}
function assertDiagnosticSelections(snapshot:Value,questions:string[],categories:string[],label:string){
 assert.deepEqual([...(snapshot.diagnostics.activeNeedsReviewQuestionIds||[])].sort(),[...questions].sort(),'question selections belong to the current active manual diagnosis');
 assert.deepEqual([...(snapshot.diagnostics.activeFocusCategories||[])].sort(),[...categories].sort(),'category selections belong to the current active manual diagnosis');
 labels.push(label);
}
function assertShared(snapshot:Value,targetId:string,label:string){
 assert.equal(snapshot.review?.version,1,'canonical review API is present');
 const byKey=new Map<string,Value>(snapshot.review.questions.map((item:Value)=>[item.questionKey,item]));
 const relevant=snapshot.review.questions.filter((item:Value)=>item.targetId===targetId&&item.status!=='clear');
 for(const item of snapshot.readiness.items){
  assert.ok(Array.isArray(item.reviewQuestionKeys),'readiness exposes canonical scope keys');
  const linked=item.reviewQuestionKeys.map((key:string)=>byKey.get(key));assert.ok(linked.every(Boolean),'readiness uses only actual canonical review scopes');
  const expected=linked.some((state:Value)=>state.status==='active')?'active':linked.some((state:Value)=>state.status==='resolved')?'resolved':'clear';
  assert.equal(item.reviewStatus,expected,'readiness aggregates the exact same active/resolved scope states');
 }
 for(const state of relevant)assert.ok(snapshot.readiness.items.some((item:Value)=>item.reviewQuestionKeys.includes(state.questionKey)),`canonical ${state.status} scope has a readiness row`);
 const active=snapshot.review.questions.filter((item:Value)=>item.needsReview);
 if(active.length){
  const rechecks=snapshot.today.tasks.filter((task:Value)=>['focus','recall'].includes(task.kind)&&task.status!=='completed');
  assert.ok(rechecks.some((task:Value)=>active.some((state:Value)=>state.targetId===task.targetId&&state.questionId===task.questionId&&task.reason.includes(state.reason))),'daily recall/focus priorities use canonical active review reasons: '+JSON.stringify({rechecks:rechecks.map((task:Value)=>({questionId:task.questionId,targetId:task.targetId,reason:task.reason})),active:active.map((state:Value)=>({questionId:state.questionId,targetId:state.targetId,reason:state.reason})),deadlines:snapshot.deadlines.map((item:Value)=>({status:item.status,date:item.date}))}));
 }
 if(!active.length)assert.notEqual(snapshot.today.allocation.mode,'repair','historical requests alone do not keep repair allocation');
 check(snapshot.today.capacityMinutes===120&&snapshot.today.plannedMinutes<=120&&snapshot.days.every((day:Value)=>day.plannedMinutes<=day.capacityMinutes),label+'; one shared time budget');
 labels.push(label+'; today/readiness use identical canonical review states');
}
async function completeSession(input:Value,duplicateLast=false){
 const started=await request('/api/interviews',{action:'start',kind:'video',...input,followups:false,feedbackTiming:'end',requestId:randomUUID()});
 // Never submit an answer or generate a report unless the QA server disabled external AI.
 assert.equal(started.aiAvailable,false,'external AI is disabled before the first answer');
 const sessionId=started.session.id,turns:Value[]=[];
 await request('/api/interviews',{action:'resume',sessionId});
 let question=started.question;
 while(question){
  const payload={action:'answer',sessionId,turnId:question.turnId,answer:'저는 측정 조건을 기록하고 같은 시간에 다시 측정했습니다. 결과의 차이를 비교하고 제가 맡은 역할과 남은 한계를 설명했습니다.',requestId:randomUUID()};
  const result=await request('/api/interviews',payload);turns.push(result.turn);
  if(duplicateLast&&!result.nextQuestion){
   const before=(await db.query("select (select count(*)::int from interview_turns where student_id=$1 and session_id=$2 and coalesce(data->>'answer','')<>'') answers,(select count(*)::int from study_session_events where student_id=$1 and kind='interview_answer' and source_id=$3) events",[student,sessionId,result.turn.id])).rows[0];
   const duplicate=await request('/api/interviews',payload);
   const after=(await db.query("select (select count(*)::int from interview_turns where student_id=$1 and session_id=$2 and coalesce(data->>'answer','')<>'') answers,(select count(*)::int from study_session_events where student_id=$1 and kind='interview_answer' and source_id=$3) events",[student,sessionId,result.turn.id])).rows[0];
   assert.equal(duplicate.turn.id,result.turn.id);assert.deepEqual(after,before);assert.equal(after.events,1);
   check(true,'Repeated answer request returns the same persisted submission and one source event');
  }
  question=result.nextQuestion;
 }
 await request('/api/interviews',{action:'finish',sessionId});
 return {sessionId,turns};
}
async function sourceSnapshot(turnId:string){return (await db.query('select data,question_id from interview_turns where id=$1 and student_id=$2',[turnId,student])).rows[0] as Value;}
async function setTurn(turnId:string,data:Value,questionId?:string){
 const result=await db.query('update interview_turns set data=$3::jsonb,question_id=coalesce($4,question_id) where id=$1 and student_id=$2 returning id',[turnId,student,JSON.stringify(data),questionId??null]);assert.equal(result.rowCount,1,'source correction only changes the exact synthetic owner turn');
}
async function seedLegacy(targetId:string,diagnostic:Value,questionIds:string[],categories:string[]){
 const legacy:Value={...diagnostic,state:'completed',needsReviewQuestionIds:questionIds,focusCategories:categories,selfReported:true};
 delete legacy.reviewSchemaVersion;delete legacy.reviewRequestedAt;delete legacy.reflectedAt;
 const result=await db.query("update student_preferences set data=jsonb_set(data-'trainingReview',ARRAY['trainingDiagnostics',$2],$3::jsonb) where student_id=$1 returning student_id",[student,targetId,JSON.stringify(legacy)]);assert.equal(result.rowCount,1);
}

await db.connect();
try{
 await db.query("insert into profiles(id,email,name,role) values($1,$2,'보완 상태 격리 검증','student')",[student,email]);created=true;
 await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '30 minutes')",[hash,student]);
 await request('/api/training/preferences',{expectedRevision:0,availability:{weekdayMinutes:120,weekendMinutes:120,blockedDates:[],overrides:{}}});
 const first=await addSchool('서울시립대학교','환경공학부','학생부종합전형Ⅰ(면접형)');
 const initial=await training(first.id),diagnosticInput=initial.diagnosticInput;assert.ok(diagnosticInput?.questionIds.length,'actual initial diagnostic questions are available');
 const diagnostic=await completeSession({...diagnosticInput,trainingPurpose:'diagnostic'});
 await request('/api/training',{action:'link_session',sessionId:diagnostic.sessionId,diagnostic:true});
 const firstRoot=diagnostic.turns[0].question_id,scope={targetId:first.id,sourceType:diagnosticInput.sourceType,sourceVersion:diagnosticInput.sourceVersion,questionIds:[firstRoot],questionCount:1};
 const legacyDiagnostic={...(await preferences()).trainingDiagnostics[first.id],sourceType:scope.sourceType,sourceVersion:scope.sourceVersion,questionIds:diagnostic.turns.map(turn=>turn.question_id)};
 await seedLegacy(first.id,legacyDiagnostic,[firstRoot],[]);
 let current=await training(first.id);
 const migrated=(await preferences()).trainingReview,manual=migrated.requests.find((item:Value)=>item.origin==='student'&&item.selectionKey==='question:'+firstRoot);assert.ok(manual,'legacy question selection is retained as a finite request');
 check(manual.requestedAt===null&&typeof manual.migratedAt==='string'&&manual.status==='active'&&manual.resolvedEvidenceIds.length===0,'Undated legacy request keeps unknown time and does not resolve from old independent success');
 check(manual.baselineEvidenceIds.includes('interview_answer:'+diagnostic.turns[0].id),'Migration records historical source IDs as the baseline');
 assertDiagnosticSelections(current,[firstRoot],[],'Current diagnosis restores only its migrated active manual question selection');
 assertShared(current,first.id,'Initial legacy migration');
 const stable=JSON.stringify(migrated);await training(first.id);check(JSON.stringify((await preferences()).trainingReview)===stable,'Repeated GET migration is idempotent');

 const second=await addSchool('건국대학교','사회환경공학부','KU자기추천전형'),secondTraining=await training(second.id);
 const foreign=await completeSession({...secondTraining.diagnosticInput,questionIds:[secondTraining.diagnosticInput.questionIds[0]],questionCount:1});
 const foreignTurn=foreign.turns[0],foreignSource=await sourceSnapshot(foreignTurn.id);
 // Simulate a shared legacy question ID while retaining the actual second school's immutable context.
 await setTurn(foreignTurn.id,{...foreignSource.data,rootQuestionId:firstRoot,...(scope.sourceType==='common'?{commonRevision:scope.sourceVersion}:{contentVersion:scope.sourceVersion})},firstRoot);
 await db.query("update study_session_events set data=data||$3::jsonb where student_id=$1 and source_id=$2 and kind='interview_answer'",[student,foreignTurn.id,JSON.stringify({questionId:firstRoot,targetId:first.id,targetSnapshot:first,outcome:true,assisted:false})]);
 current=await training(first.id);check((await savedRequest(manual.id)).status==='active','A same-ID answer from another school cannot resolve the first school request even with a misleading event snapshot');
 assertShared(current,first.id,'Second-school evidence isolation');

 const otherVersion=await completeSession(scope),otherTurn=otherVersion.turns[0],otherSource=await sourceSnapshot(otherTurn.id);
 await setTurn(otherTurn.id,{...otherSource.data,...(scope.sourceType==='common'?{commonRevision:scope.sourceVersion+100}:{contentVersion:scope.sourceVersion+100})});
 current=await training(first.id);check((await savedRequest(manual.id)).status==='active','A changed content revision cannot resolve the original question request');

 const resolvedSession=await completeSession(scope,true),resolvingTurn=resolvedSession.turns[0],original=await sourceSnapshot(resolvingTurn.id);
 current=await training(first.id);let state=await savedRequest(manual.id);
 check(state.status==='resolved'&&state.resolvedEvidenceIds.length===1&&state.resolvedEvidenceIds[0]==='interview_answer:'+resolvingTurn.id,'A new known unaided submission resolves the same scoped recheck request exactly once');
 assertDiagnosticSelections(current,[],[],'Resolving a request clears its active reflection checkbox without deleting its history');
 const resolvedIds=JSON.stringify(state.resolvedEvidenceIds);await training(first.id);check(JSON.stringify((await savedRequest(manual.id)).resolvedEvidenceIds)===resolvedIds,'Repeated reconciliation does not grow resolution provenance');
 assertShared(current,first.id,'Resolved independent recheck');

 await setTurn(resolvingTurn.id,{...original.data,assisted:true,helpKinds:['ai']});
 const stale=(await db.query("select data from study_session_events where student_id=$1 and source_id=$2 and kind='interview_answer'",[student,resolvingTurn.id])).rows[0].data;
 check(stale.assisted===false&&stale.assistance_recorded===true,'Original event still contains the earlier independent snapshot');
 current=await training(first.id);check((await savedRequest(manual.id)).status==='active','Correcting original help evidence reactivates the resolved request despite a stale independent event');
 assertDiagnosticSelections(current,[firstRoot],[],'Help correction restores the reopened manual checkbox in the same diagnosis');
 assertShared(current,first.id,'Help correction reactivation');
 await setTurn(resolvingTurn.id,original.data);current=await training(first.id);check((await savedRequest(manual.id)).status==='resolved','Restoring valid independent source facts resolves again without a fabricated attempt');
 await setTurn(resolvingTurn.id,{...original.data,invalidated:true});current=await training(first.id);check((await savedRequest(manual.id)).status==='active','Invalidating the actual resolving answer reactivates the request');
 assertDiagnosticSelections(current,[firstRoot],[],'Answer invalidation restores the reopened manual checkbox in the same diagnosis');
 assertShared(current,first.id,'Source invalidation reactivation');
 await setTurn(resolvingTurn.id,original.data);await training(first.id);

 const additional=await completeSession(scope),additionalTurn=additional.turns[0],additionalSource=await sourceSnapshot(additionalTurn.id);
 await setTurn(resolvingTurn.id,{...original.data,invalidated:true});current=await training(first.id);state=await savedRequest(manual.id);
 check(state.status==='resolved'&&state.resolvedEvidenceIds.includes('interview_answer:'+additionalTurn.id),'A second independent source preserves resolution when one resolving source is removed');
 await setTurn(additionalTurn.id,{...additionalSource.data,invalidated:true});current=await training(first.id);check((await savedRequest(manual.id)).status==='active','Removing every independent resolving source reactivates the request');
 await setTurn(additionalTurn.id,additionalSource.data);current=await training(first.id);assertShared(current,first.id,'Independent evidence replacement');

 // The original major choice must migrate once and stop applying its old unconditional weight after its finite exercises finish.
 await seedLegacy(first.id,legacyDiagnostic,[],['major']);
 current=await training(first.id);const category=(await preferences()).trainingReview.requests.find((item:Value)=>item.origin==='student'&&item.selectionKey==='category:major');
 check(category?.requestedAt===null&&category.status==='active'&&category.scopes.length>0&&category.scopes.length<=2,'Legacy major focus becomes a bounded scoped recheck exercise with unknown original time');
 assertDiagnosticSelections(current,[],['major'],'Category exercise restores only the explicitly selected category without inventing question checkboxes');
 for(let index=0;index<category.scopes.length;index++){
  const part=category.scopes[index];await completeSession({targetId:part.targetId,sourceType:part.sourceType,sourceVersion:part.sourceVersion,questionIds:[part.id],questionCount:1});current=await training(first.id);
  if(index<category.scopes.length-1)check((await savedRequest(category.id)).status==='active','One answered question does not prematurely complete a multi-question category exercise');
 }
 check((await savedRequest(category.id)).status==='resolved','Completing all finite major rechecks resolves the migrated category request');
 check(current.diagnostics.focusCategories.includes('major')&&current.diagnostics.activeFocusCategories.length===0,'Preserved legacy major selection no longer adds a separate unconditional planning weight');
 assertDiagnosticSelections(current,[],[],'Resolved category leaves no active manual reflection selections');
 assertShared(current,first.id,'Resolved category selection with legacy value retained');
 const otherView=await training(second.id);check(otherView.today.capacityMinutes===current.today.capacityMinutes&&otherView.today.plannedMinutes===current.today.plannedMinutes,'Switching the selected school keeps the same whole-student daily allocation');
 assertShared(otherView,second.id,'Second school display shares the same daily budget');

 await request('/api/training',{action:'diagnostic_reflection',sessionId:diagnostic.sessionId,needsReviewQuestionIds:[firstRoot],focusCategories:[]});
 current=await training(first.id);
 const priorManual=(await preferences()).trainingReview.requests.find((item:Value)=>item.origin==='student'&&item.selectionKey==='question:'+firstRoot&&item.status==='active');assert.ok(priorManual,'explicit reflection creates a fresh finite request');
 const helped=await completeSession({...scope,assisted:true});current=await training(first.id);
 const automatic=(await preferences()).trainingReview.requests.find((item:Value)=>item.origin==='automatic'&&item.triggerEvidenceId==='interview_answer:'+helped.turns[0].id);assert.ok(automatic?.status==='active','actual helped submission creates its automatic recheck');
 const differentRoot=diagnosticInput.questionIds.find((id:string)=>id!==firstRoot);assert.ok(differentRoot,'new diagnostic can inspect a different actual question');
 const newlyStarted=await request('/api/interviews',{action:'start',kind:'video',...diagnosticInput,questionIds:[differentRoot],questionCount:1,trainingPurpose:'diagnostic',followups:false,feedbackTiming:'end',requestId:randomUUID()});assert.equal(newlyStarted.aiAvailable,false,'new diagnostic also disables external AI');
 await request('/api/training',{action:'link_session',sessionId:newlyStarted.session.id,diagnostic:true});
 current=await training(first.id);
 check((await savedRequest(priorManual.id)).status==='active','Merely linking a new diagnostic preserves the prior manual request');
 assertDiagnosticSelections(current,[],[],'New diagnosis does not restore hidden question checkboxes from an older diagnosis');
 check(current.diagnostics.sourceType===scope.sourceType&&current.diagnostics.sourceVersion===scope.sourceVersion,'Diagnostic linkage stores the actual common/personal question revision, including common-only students without a personal publication');
 await request('/api/interviews',{action:'resume',sessionId:newlyStarted.session.id});
 await request('/api/interviews',{action:'answer',sessionId:newlyStarted.session.id,turnId:newlyStarted.question.turnId,answer:'새 진단에서는 다른 질문에 제 경험과 이유를 직접 설명했습니다.',requestId:randomUUID()});
 await request('/api/interviews',{action:'finish',sessionId:newlyStarted.session.id});
 await request('/api/training',{action:'diagnostic_reflection',sessionId:newlyStarted.session.id,needsReviewQuestionIds:[],focusCategories:[]});
 current=await training(first.id);
 check((await savedRequest(priorManual.id)).status==='dismissed','Explicit empty reflection in a new diagnostic dismisses superseded manual requests');
 check((await savedRequest(automatic.id)).status==='active','Changing student reflection retains independent automatic help-based recheck requests');
 assertDiagnosticSelections(current,[],[],'Automatic help rechecks never recreate manually cleared reflection checkboxes');
 assertShared(current,first.id,'New diagnostic reflection preserves actual evidence requests');
 check((await db.query('select count(*)::int count from ai_usage_logs where student_id=$1',[student])).rows[0].count===0,'Lifecycle verification issued zero external AI calls');
}catch(error){failure=error;}
finally{
 try{
  if(created){
   const owner=(await db.query('select id,email from profiles where id=$1',[student])).rows[0];assert.equal(owner?.email,email,'cleanup owner is exactly this run synthetic profile');
   await db.query('begin');
   await db.query('delete from answer_revisions where answer_id in (select id from user_answers where student_id=$1)',[student]);
   for(const table of ['answer_comments','user_answers','interview_reports','media_assets','interview_turns','interview_sessions','study_session_events','study_session_tabs','study_sessions','experience_card_drafts','experience_cards','student_plans','ai_usage_logs','notifications','student_preferences','school_profiles','support_targets'])await db.query(`delete from ${table} where student_id=$1`,[student]);
   await db.query('delete from audit_logs where actor_id=$1 or student_id=$1',[student]);await db.query('delete from sessions where user_id=$1',[student]);
   await db.query('delete from profiles where id=$1 and email=$2',[student,email]);await db.query('commit');
   check((await db.query('select count(*)::int count from profiles where id=$1',[student])).rows[0].count===0,'Only this run synthetic owner and all owned test rows were removed');
  }
 }catch(error){await db.query('rollback');failure??=error;}
 await db.end();
}
if(failure){console.error(redactEnvironmentSecrets(failure instanceof Error?failure.stack||failure.message:'Training review lifecycle verification failed'));process.exitCode=1;}
else console.log(JSON.stringify({checks:labels.length,labels,paidAiCalls:0,cleanup:'Exact randomly generated synthetic owner only'}));
