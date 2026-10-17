import {registerReviewedSchool} from './school-registration-fixture.mts';
// Reproducible local HTTP / PostgreSQL integration QA; browser QA is performed separately through CUA.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';
import {loadProjectEnv,projectRoot} from '../scripts/load-env.mjs';
import {selectSchoolMajorSamples,matrixSeed} from '../.local/school-major-selection.mjs';
import {schoolMajorFixtureLearning} from '../.local/school-major-fixture-data.mjs';
loadProjectEnv();
const base=process.env.SMOKE_BASE_URL||JSON.parse(readFileSync(join(projectRoot,'.local/server.json'),'utf8')).url;
if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(new URL(base).hostname)||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Local synthetic fixtures only');
const db=new pg.Client({connectionString:process.env.DATABASE_URL}),fixture=randomUUID(),samples=selectSchoolMajorSamples(matrixSeed);
const students=samples.map(()=>randomUUID()),tokens=samples.map(()=>randomUUID()),evidence:any[]=[];
let checks=0,failed:string|null=null;
function check(value:unknown,label:string){assert.ok(value,label);checks++;}
async function request(actor:number,path:string,body?:unknown){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,Cookie:'gakja_session='+tokens[actor],...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();let data:any;try{data=JSON.parse(text);}catch{throw Error(`${path} returned ${response.status}: ${text.slice(0,500)}`);}
  return {status:response.status,body:data,headers:response.headers};
}
function ownSnapshot(snapshot:any,target:any,label:string){
  check(snapshot?.school_reference_id===target.school_reference_id&&snapshot?.department_catalog_id===target.department_catalog_id&&snapshot?.department===target.department&&snapshot?.campus===target.campus&&Number(snapshot?.admission_year)===2027,label);
}
async function practice(actor:number,target:any,question:any,phase='initial'){
  const read=await request(actor,`/api/quiz?targetId=${target.id}&questionId=${question.id}&mode=answer&sourceType=common&sourceVersion=${question.common_revision}`);
  check(read.status===200&&read.body.requested?.available,`${phase}: exact sourced question opens Q&A`);
  const item=read.body.requested.item;
  check(item.question_id===question.id&&item.common_revision===question.common_revision&&item.source_kind==='common',`${phase}: quiz keeps exact question / source revision`);
  ownSnapshot(item.target_snapshot,target,`${phase}: quiz keeps target scope`);
  const wrongRevision=await request(actor,`/api/quiz?targetId=${target.id}&questionId=${question.id}&mode=answer&sourceType=common&sourceVersion=999`);
  check(wrongRevision.status===200&&wrongRevision.body.requested?.available!==true&&wrongRevision.body.library.answer.every((row:any)=>row.source_kind!=='common'),`${phase}: missing common source version is not silently upgraded to latest`);
  check((await request(actor,'/api/quiz',{action:'create',mode:'answer',targetId:target.id,itemIds:[item.id],sourceType:'common',sourceVersion:999})).status===400,`${phase}: quiz creation cannot swap a pinned source version`);
  const create=await request(actor,'/api/quiz',{action:'create',mode:'answer',targetId:target.id,itemIds:[item.id],sourceType:'common',sourceVersion:question.common_revision});
  check(create.status===200,`${phase}: quiz session creates without paid AI`);
  const quiz=create.body.session;
  ownSnapshot(quiz.metadata.targetSnapshot,target,`${phase}: quiz session freezes scope`);
  check((await request(actor,'/api/quiz',{action:'start',sessionId:quiz.id})).status===200,`${phase}: quiz starts`);
  const quizText=`[합성 학습 QA ${phase}] 이 가치가 의미 있다고 생각합니다. 아직 설명할 근거를 충분히 정리하지 못했습니다.`;
  const answer=await request(actor,'/api/quiz',{action:'answer',sessionId:quiz.id,itemIndex:0,response:quizText,rating:'again',recallStatus:'uncertain'});
  check(answer.status===200&&answer.body.response.outcome===null,`${phase}: personal value self-rating is not objective correctness`);
  check(answer.body.response.data.question_id===question.id&&answer.body.response.data.common_revision===question.common_revision,`${phase}: response freezes exact source revision`);
  ownSnapshot(answer.body.response.data.target_snapshot,target,`${phase}: response scope retained`);
  const interview=await request(actor,'/api/interviews',{action:'start',kind:'chat',mode:'university',targetId:target.id,questionId:question.id,sourceType:'common',sourceVersion:question.common_revision,questionCount:1,followups:false,feedbackTiming:'end',interviewerReactions:false});
  check(interview.status===200&&interview.body.question.id===question.id,`${phase}: quiz question enters the same interview`);
  ownSnapshot(interview.body.session.supportTarget,target,`${phase}: interview freezes real selected department`);
  check(interview.body.turn.commonRevision===question.common_revision&&interview.body.turn.sourceSnapshot.url===question.source_snapshot.url,`${phase}: interviewer receives the same official provenance`);
  const interviewText=`[합성 학습 QA ${phase}] 아직 직접 수행한 활동은 없습니다. 앞으로 자료 3개의 출처와 비교 조건을 먼저 확인하겠습니다. 근거가 부족한 부분은 한계로 밝히고 타인의 의견을 듣겠습니다.`;
  const saved=await request(actor,'/api/interviews',{action:'answer',sessionId:interview.body.session.id,turnId:interview.body.question.turnId,answer:interviewText});
  check(saved.status===200&&saved.body.turn.answer===interviewText,`${phase}: future-plan answer is saved without invented experiences`);
  const growth=await request(actor,'/api/reports');
  check(growth.status===200,`${phase}: report observations are available before interview finish AI`);
  const comparison=growth.body.content.comparisons.find((row:any)=>row.questionId===question.id&&row.before.script===quizText&&row.after.script===interviewText);
  if(!comparison){
    const history=await request(actor,'/api/learning');
    writeFileSync(join(projectRoot,'.local/school-major-flow-comparison-debug.json'),JSON.stringify({phase,questionId:question.id,target,quizResponse:answer.body.response,interviewTurn:saved.body.turn,history:history.body.answerRevisions?.filter((row:any)=>row.question_id===question.id),growth:growth.body.content},null,2));
  }
  check(Boolean(comparison),`${phase}: same Q&A and interview answer compare across modules`);
  ownSnapshot(comparison.before.target_snapshot,target,`${phase}: before comparison keeps scope`);
  ownSnapshot(comparison.after.target_snapshot,target,`${phase}: after comparison keeps scope`);
  check(comparison.before.common_revision===question.common_revision&&comparison.after.common_revision===question.common_revision,`${phase}: report comparison retains common revisions`);
  check(!('score' in comparison)&&!('correct' in comparison),`${phase}: expression observations do not claim admission score`);
  return {quizId:quiz.id,itemId:item.id,interviewId:interview.body.session.id,questionId:question.id,commonRevision:question.common_revision,sourceUrl:question.source_snapshot.url,quizText,interviewText};
}
await db.connect();
try{
  for(let index=0;index<students.length;index++){
    await db.query("insert into profiles(id,email,name,role) values($1,$2,$3,'student')",[students[index],`axis-flow-${students[index]}@gakja.test`,`합성 학습 ${samples[index].stratum} QA`]);
    await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '1 hour')",[createHash('sha256').update(tokens[index]).digest('hex'),students[index]]);
  }
  const catalog=await request(0,'/api/schools');
  check(catalog.status===200&&catalog.body.catalog.length===88,'all registered school definitions are available');
  check(catalog.body.catalog.every((school:any)=>school.talent.status==='official_source'),'all 88 schools have verified institution-wide definitions');
  for(let actor=0;actor<samples.length;actor++){
    const {school,department,stratum}=samples[actor];
    const detail=await request(actor,'/api/schools/catalog?schoolId='+school.id);
    check(detail.status===200&&detail.body.school.departments.some((row:any)=>row.id===department.id&&row.name===department.name),`${stratum}: reproducible department exists in real catalogue`);
    check(detail.body.departmentSource.year===2026,`${stratum}: actual public unit year is preserved`);
    const registered=await registerReviewedSchool((path,body)=>request(actor,path,body),{referenceId:school.id,departmentId:department.id,admissionYear:2027,track:'합성 학습 흐름 검증',major:'클라이언트 위조 학과',campus:'클라이언트 위조 캠퍼스'});
    check(registered.status===200,`${stratum}: real department registration succeeds`);
    const target=registered.body.target;
    check(target.department===department.name&&target.department_catalog_id===department.id&&target.campus===(school.campusLabel||department.campus),`${stratum}: server resolves canonical catalogue scope`);
    check(target.talentProfile.status==='official_source'&&target.talentProfile.points.length>0,`${stratum}: verified school talent / educational definition is linked`);
    check(target.talentProfile.departmentStatus==='university_shared'||target.talentProfile.departmentStatus==='official_source',`${stratum}: institution-wide values are not labelled invented department values`);
    const overview=await request(actor,'/api/schools?targetId='+target.id);
    const selected=overview.body.commonQuestions.find((question:any)=>question.talent_profile?.scope==='university');
    check(overview.status===200&&selected&&selected.source_snapshot.url.startsWith('https://'),`${stratum}: selectable sourced institution question exists`);
    check(selected.talent_context.departmentCatalogId===department.id&&selected.talent_context.department===department.name,`${stratum}: institution question receives actual selected department lens`);
    const started=await practice(actor,target,selected,stratum);
    const knowledge=await request(actor,`/api/knowledge-bites?targetId=${target.id}&questionId=${selected.id}`);
    check(knowledge.status===200,`${stratum}: same school question continues to knowledge without a personal package`);
    check(knowledge.body.targetId===target.id,`${stratum}: knowledge response keeps the active target`);
    const reading=knowledge.body.videos.find((item:any)=>item.kind==='reading'&&item.relatedQuestions?.some((question:any)=>question.id===selected.id));
    check(Boolean(reading)&&reading.sourceSnapshot?.url?.startsWith('https://'),`${stratum}: genuine official reading connects the same question`);
    ownSnapshot(reading.targetSnapshot,target,`${stratum}: reading scope retains real catalogue identity`);
    check((reading.activities||[]).length===0,`${stratum}: school / department context is not fabricated as a personal activity`);
    const explanationInput={action:'explanation',videoId:reading.id,targetId:target.id,questionId:selected.id,value:`[합성 QA] ${department.name}의 공부에서 학교의 가치를 실천하려면 근거를 확인하고 다른 관점을 비교해야 한다고 정리했습니다.`,expectedRevision:0,commonRevision:selected.common_revision,sourceSnapshot:{url:'https://forged.example'},targetSnapshot:{department:'forged department'}};
    check((await request(actor,'/api/knowledge-bites',{...explanationInput,commonRevision:999})).status===409,`${stratum}: stale / forged common revision cannot replace current official source`);
    const explained=await request(actor,'/api/knowledge-bites',explanationInput);
    check(explained.status===200&&explained.body.progress.revision===1,`${stratum}: own explanation from official reading is stored`);
    check(!JSON.stringify(explained.body.progress).includes('forged.example')&&!JSON.stringify(explained.body.progress).includes('forged department'),`${stratum}: client cannot forge immutable school sources or department scope`);
    const [knowledgeEvent]=(await db.query("select data from study_session_events where student_id=$1 and kind='knowledge_progress' order by created_at desc limit 1",[students[actor]])).rows;
    check(knowledgeEvent?.data.questionId===selected.id&&knowledgeEvent.data.target_id===target.id&&knowledgeEvent.data.common_revision===selected.common_revision,`${stratum}: knowledge event bridges the same question target and revision`);
    ownSnapshot(knowledgeEvent.data.target_snapshot,target,`${stratum}: knowledge history keeps immutable scope`);
    const returned=await request(actor,`/api/quiz?targetId=${target.id}&questionId=${knowledgeEvent.data.questionId}&mode=answer`);
    check(returned.status===200&&returned.body.requested.available&&returned.body.requested.item.id===started.itemId,`${stratum}: knowledge returns to the same recall identity`);
    const [attempt]=(await db.query('select data from memory_attempts where student_id=$1 and memory_item_id=$2 order by created_at desc limit 1',[students[actor],started.itemId])).rows;
    check(attempt?.data.question_id===selected.id&&attempt.data.common_revision===selected.common_revision&&attempt.data.correct===null,`${stratum}: spaced recall stores question / revision without invented correctness`);
    const taskKey=randomUUID(),taskBody={action:'assignment_create',requestId:taskKey,targetId:target.id,questionIds:[selected.id]};
    const task=await request(actor,'/api/learning',taskBody);
    check(task.status===200&&task.body.assignment.source_kind==='common'&&task.body.assignment.package_id===null,`${stratum}: school-based task exists before a private package is uploaded`);
    const assignment=task.body.assignment,taskItem=assignment.items[0];
    ownSnapshot(assignment.target_snapshot,target,`${stratum}: assigned task freezes real school / department scope`);
    check(taskItem.question_id===selected.id&&taskItem.memory_item_id===started.itemId,`${stratum}: task and quiz share exact question / recall identity`);
    check((await request(actor,'/api/learning',taskBody)).body.assignment.id===assignment.id,`${stratum}: task creation retry is idempotent`);
    check((await request(actor,'/api/learning',{action:'assignment_start',assignmentId:assignment.id,requestId:randomUUID()})).status===200,`${stratum}: target-specific task starts`);
    const taskText=`[합성 과제 QA ${stratum}] 학교의 가치와 ${department.name}에서 공부할 계획을 연결하겠습니다. 자료 3개의 조건을 비교하고 근거의 한계를 먼저 확인하겠습니다.`;
    const submitted=await request(actor,'/api/learning',{action:'assignment_submit',assignmentId:assignment.id,requestId:randomUUID(),responses:[{memoryItemId:taskItem.memory_item_id,response:taskText,rating:'good',selfCheckedMeanings:taskItem.required_meaning_elements}]});
    check(submitted.status===200&&submitted.body.results[0].correct===null&&submitted.body.results[0].evaluation_method==='self_check',`${stratum}: value task response remains self-checked, not admissions scored`);
    const taskVersion=submitted.body.data.answerRevisions.find((row:any)=>row.revision_kind==='assignment_answer'&&row.assignment_id===assignment.id);
    check(taskVersion?.question_id===selected.id&&taskVersion.common_revision===selected.common_revision&&taskVersion.target_id===target.id,`${stratum}: task response joins the same source/version answer history`);
    ownSnapshot(taskVersion.target_snapshot,target,`${stratum}: assignment answer keeps immutable comparison scope`);
    const taskGrowth=(await request(actor,'/api/reports')).body.content.comparisons.find((row:any)=>row.questionId===selected.id&&row.after.script===taskText);
    check(taskGrowth?.before.script===started.quizText,`${stratum}: task joins quiz / interview cumulative report comparisons`);
    const study=await request(actor,'/api/study-sessions');
    const studyId=study.body.current.id;
    const finished=await request(actor,'/api/study-sessions',{action:'finish',reason:'manual',sessionId:studyId});
    check(finished.status===200&&finished.body.session.report.eventCount===4,`${stratum}: quiz interview knowledge and task form one factual study session`);
    const frozen=finished.body.session.report;
    check(frozen.events.every((row:any)=>row.data.questionId===selected.id),`${stratum}: every linked event retains exact question identity`);
    const foreign=(actor+1)%students.length;
    check((await request(foreign,'/api/schools?targetId='+target.id)).status===404,`${stratum}: foreign target read denied`);
    check((await request(foreign,`/api/quiz?targetId=${target.id}&mode=answer`)).status===404,`${stratum}: foreign recall target denied`);
    check((await request(foreign,'/api/interviews?id='+started.interviewId)).status===404,`${stratum}: foreign interview history denied`);
    check((await request(foreign,`/api/knowledge-bites?targetId=${target.id}&questionId=${selected.id}`)).status===404,`${stratum}: foreign knowledge target denied`);
    check((await request(foreign,'/api/knowledge-bites',{action:'explanation',videoId:reading.id,targetId:target.id,questionId:selected.id,value:'외부 계정 위조 저장',expectedRevision:0})).status===404,`${stratum}: foreign knowledge mutation denied`);
    check((await request(foreign,'/api/reports?sessionId='+started.interviewId)).status===404,`${stratum}: foreign report scope denied`);
    check([403,404].includes((await request(foreign,'/api/learning',{action:'assignment_start',assignmentId:assignment.id,requestId:randomUUID()})).status),`${stratum}: foreign task mutation denied`);
    evidence.push({stratum,university:school.university,schoolReferenceId:school.id,department:department.name,departmentId:department.id,campus:target.campus,target,question:selected,flow:started,assignmentId:assignment.id,officialReadingId:reading.id,officialReadingSource:reading.sourceSnapshot.url,studyId,frozenReportHash:createHash('sha256').update(JSON.stringify(frozen)).digest('hex'),verifiedDefinitionKind:target.talentProfile.definitionKind||'talent',departmentScope:target.talentProfile.departmentStatus});
  }
  // One owner has two targets with the same institution question; changing a target cannot merge historic answers.
  const first=evidence[0],school=samples[0].school;
  const alternate=school.departments.find((dept:any)=>dept.id!==samples[0].department.id)!;
  const extra=(await registerReviewedSchool((path,body)=>request(0,path,body),{referenceId:school.id,departmentId:alternate.id,admissionYear:2027,track:'합성 학습 흐름 검증'})).body.target;
  const secondFlow=await practice(0,extra,first.question,'same-school-second-department');
  check(secondFlow.itemId!==first.flow.itemId,'same institutional question has a separate recall identity for each department target');
  await db.query('update support_targets set data=data || $3::jsonb where id=$1 and student_id=$2',[first.target.id,students[0],JSON.stringify({major:alternate.name,department:alternate.name,department_catalog_id:alternate.id,department_public_code:alternate.departmentCode,department_source:{year:alternate.year,url:alternate.sourceUrl,status:'public_catalog'}})]);
  const changed=(await request(0,'/api/schools?targetId='+first.target.id)).body.targets.find((target:any)=>target.id===first.target.id);
  const thirdFlow=await practice(0,changed,first.question,'same-id-changed-department');
  check(thirdFlow.itemId!==first.flow.itemId&&thirdFlow.itemId!==secondFlow.itemId,'same ID target edit creates a new context without rewriting recall identity');
  const oldQuiz=await request(0,'/api/quiz?sessionId='+first.flow.quizId),oldInterview=await request(0,'/api/interviews?id='+first.flow.interviewId);
  ownSnapshot(oldQuiz.body.session.items[0].target_snapshot,first.target,'old quiz keeps original selected department after target edit');
  ownSnapshot(oldInterview.body.session.supportTarget,first.target,'old interview keeps original selected department after target edit');
  const growth=(await request(0,'/api/reports')).body;
  const related=growth.content.comparisons.filter((row:any)=>row.questionId===first.question.id);
  check(related.length===3,'three practice contexts remain three comparisons after target change');
  check(related.every((row:any)=>row.before.target_id===row.after.target_id&&row.before.target_snapshot.department_catalog_id===row.after.target_snapshot.department_catalog_id),'comparisons cannot cross targets or old / changed department scopes');
  const frozen=(await request(0,'/api/study-sessions?id='+first.studyId)).body.session.report;
  check(createHash('sha256').update(JSON.stringify(frozen)).digest('hex')===first.frozenReportHash,'finished study snapshot is unchanged by later practice and target edits');
  // Approved personal activity is additional evidence; it does not replace or forge the institutional definition.
  const approvedLearning=schoolMajorFixtureLearning(students[1],evidence[1].target),packageId=`axis-flow-${fixture}-approved`,jobId=`axis-flow-${fixture}-job`;
  await db.query('insert into production_links(id,student_id,data) values($1,$2,$3)',[jobId,students[1],JSON.stringify({synthetic:true,fixture:'school-major-flow'})]);
  await db.query('insert into content_packages(id,student_id,active_version) values($1,$2,1)',[packageId,students[1]]);
  await db.query("insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref) values($1,1,$2,$3,'published',$4)",[packageId,JSON.stringify(approvedLearning),'synthetic-axis-flow',jobId]);
  const withActivity=await request(1,`/api/quiz?targetId=${evidence[1].target.id}&questionId=${evidence[1].question.id}&activityId=${approvedLearning.activities[0].id}&mode=answer`);
  check(withActivity.status===200&&withActivity.body.requested.item.activity_ids.includes(approvedLearning.activities[0].id),'approved personal activity may ground a sourced school practice');
  check(withActivity.body.requested.item.source_snapshot.url===evidence[1].question.source_snapshot.url,'personal grounding preserves the institutional source');
  const preview=await request(1,`/api/interviews?preview=1&targetId=${evidence[1].target.id}&questionId=${evidence[1].question.id}&activityId=${approvedLearning.activities[0].id}&sourceType=common&sourceVersion=${evidence[1].question.common_revision}`);
  check(preview.status===200&&preview.body.activities.some((activity:any)=>activity.id===approvedLearning.activities[0].id),'same sourced interview carries only the requested owned approved activity');
  check((await request(1,`/api/quiz?targetId=${evidence[1].target.id}&activityId=not-an-owned-activity&mode=answer`)).status===404,'unapproved / unowned evidence is not invented from the school definition');
  const broader=await request(1,`/api/knowledge-bites?targetId=${evidence[1].target.id}`);
  check(broader.status===200&&broader.body.videos.some((row:any)=>row.kind==='reading')&&broader.body.videos.some((row:any)=>row.kind==='video'),'student record and target official sources coexist in knowledge, not book-only recommendations');
  const paid=Number((await db.query('select count(*)::int as n from ai_usage_logs where student_id=any($1::uuid[])',[students])).rows[0].n);
  check(paid===0,'all integration paths issue zero paid AI calls');
  console.log(JSON.stringify({checks,seed:matrixSeed,syntheticStudents:students.length,schoolDepartmentSamples:evidence.map(({stratum,university,department,campus,departmentScope})=>({stratum,university,department,campus,departmentScope})),paidAiCalls:paid,originalStudentsChanged:0}));
}catch(error){failed=String(error);throw error;}
finally{
  await db.query('begin');
  try{
    for(const table of ['learning_requests','quiz_assignment_events','quiz_submissions','quiz_assignments','knowledge_bite_revisions','knowledge_bite_progress','study_sessions','interview_reports','media_assets','interview_sessions','quiz_sessions','memory_attempts','ai_usage_logs','student_preferences','school_profiles'])await db.query(`delete from ${table} where student_id=any($1::uuid[])`,[students]);
    await db.query('delete from content_versions where package_id in(select id from content_packages where student_id=any($1::uuid[]))',[students]);
    for(const table of ['content_packages','production_links','support_targets'])await db.query(`delete from ${table} where student_id=any($1::uuid[])`,[students]);
    await db.query('delete from sessions where user_id=any($1::uuid[])',[students]);
    await db.query('delete from audit_logs where actor_id=any($1::uuid[]) or student_id=any($1::uuid[])',[students]);
    await db.query('delete from profiles where id=any($1::uuid[])',[students]);await db.query('commit');
    const remaining=Number((await db.query('select count(*)::int as n from profiles where id=any($1::uuid[])',[students])).rows[0].n);assert.equal(remaining,0);
    writeFileSync(join(projectRoot,'.local/school-major-flow-api-check.json'),JSON.stringify({status:failed?'failed':'passed',failure:failed,checks,seed:matrixSeed,schools:88,publicDepartmentTuples:3934,syntheticStudents:students.length,paidAiCalls:0,originalStudentsChanged:0,cleanup:'completed; generated student IDs only',samples:evidence},null,2));
  }catch(error){await db.query('rollback');throw error;}finally{await db.end();}
}
