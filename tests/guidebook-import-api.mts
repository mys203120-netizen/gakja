// Local-only HTTP/PostgreSQL regression. Every write belongs to a freshly created fixture.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';
import {loadProjectEnv,projectRoot,redactEnvironmentSecrets} from '../scripts/load-env.mjs';
import {createDemoPack,hashLearningData,renderLearningHtml,type LearningPack} from '../packages/content-contracts/src/index';

loadProjectEnv();
let serverURL:string|undefined;
try{serverURL=JSON.parse(readFileSync(join(projectRoot,'.local/server.json'),'utf8')).url;}catch{}
const base=process.env.TEST_BASE_URL||process.env.SMOKE_BASE_URL||serverURL||'http://localhost:3100';
if(process.env.AUTH_MODE!=='local'||new URL(base).protocol!=='http:'||!['localhost','127.0.0.1'].includes(new URL(base).hostname)||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Local synthetic fixtures only');
const db=new pg.Client({connectionString:process.env.DATABASE_URL});
const runId=randomUUID(),profiles:string[]=[],owners:Record<string,string>={},tokens:Record<string,string>={};
const observations:any[]=[];
let checks=0,failed:string|null=null,cleaned=false;
function check(value:unknown,label:string):asserts value{assert.ok(value,label);checks++;}
function stable(value:any):string{return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);}
async function request(actor:string,path:string,body?:unknown){
  const multipart=body instanceof FormData;
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,...(tokens[actor]?{Cookie:'gakja_session='+tokens[actor]}:{}),...(body!==undefined&&!multipart?{'Content-Type':'application/json'}:{})},body:multipart?body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(120_000)});
  let parsed:any;try{parsed=await response.json();}catch{throw Error(`${path}: non-JSON response ${response.status}`);}
  return {status:response.status,body:parsed,headers:response.headers};
}
const action=(actor:string,name:string,payload:unknown)=>request(actor,'/api/actions',{action:name,payload});
function fixtureHtml(pack:LearningPack){
  try{return renderLearningHtml(pack);}catch{
    // Deliberately malformed negative fixtures must reach server validation, not fail in the renderer.
    return `<!doctype html><html><body><main data-document-kind="${pack.document.kind}"></main><script type="application/json" id="gakja-learning-pack">${JSON.stringify(pack).replace(/</g,'\\u003c')}</script></body></html>`;
  }
}
function form(pack:LearningPack,studentId=owners.student,html=fixtureHtml(pack),job=pack.production_job_ref){const input=new FormData();input.set('studentId',studentId);input.set('productionJobRef',job);input.append('files',new File([html],'final-guidebook.html',{type:'text/html'}));return input;}
const upload=(pack:LearningPack,actor='admin',studentId=owners.student,html?:string)=>request(actor,'/api/imports',form(pack,studentId,html));
const preview=(versionId:string,actor='admin')=>request(actor,`/api/imports/${versionId}/preview`);
const rehash=(pack:LearningPack)=>{pack.learning_data_hash=hashLearningData(pack.learning_data);return pack;};
function nextVersion(pack:LearningPack,version:number){const next=structuredClone(pack);next.content_version=version;next.document.document_revision=version;next.provenance.review_ref=`${owners.student}-approved-${version}`;return rehash(next);}
async function confirmAndPublish(versionId:string,beforePublication?:()=>Promise<void>){
  const shown=await preview(versionId);
  check(shown.status===200&&shown.body.versionId===versionId&&/^[a-f0-9]{64}$/.test(shown.body.digest),'staff preview returns the exact immutable version and digest');
  check(shown.headers.get('cache-control')?.includes('private')&&shown.headers.get('cache-control')?.includes('no-store'),'private guidebook preview cannot enter shared caches');
  check(Array.isArray(shown.body.documents)&&shown.body.documents.length===1&&shown.body.documents[0].kind==='guidebook','final preview has one guidebook and no fabricated handbook');
  check(!!shown.body.externalApproval&&!!shown.body.learningLinks,'preview exposes external approval and authored learning link checks');
  const confirmation=await action('admin','preview_confirm',{versionId,digest:shown.body.digest});
  check(confirmation.status===200,'exact staff preview digest can be confirmed');
  if(beforePublication)await beforePublication();
  check((await action('admin','publish',{versionId})).status===200,'confirmed one-book content publishes');
  return shown;
}
async function savedRecords(studentId:string){
  const tables=['user_answers','memory_attempts','quiz_sessions','quiz_responses','interview_sessions','interview_turns','interview_reports','study_sessions','study_session_events'];
  const result:Record<string,unknown>={};for(const table of tables)result[table]=(await db.query(`select * from ${table} where student_id=$1 order by id`,[studentId])).rows;
  result.answer_revisions=(await db.query('select r.* from answer_revisions r join user_answers a on a.id=r.answer_id where a.student_id=$1 order by r.id',[studentId])).rows;
  return result;
}
function priorRecordsUnchanged(current:Record<string,unknown>,previous:Record<string,unknown>){return Object.entries(previous).every(([table,rows])=>(rows as any[]).every(old=>(current[table] as any[]).some(row=>row.id===old.id&&stable(row)===stable(old))));}

await db.connect();
try{
  for(const [actor,role] of [['student','student'],['other','student'],['admin','admin'],['staff','staff'],['unassigned','staff']]){
    const id=randomUUID(),token=randomUUID();
    await db.query('insert into profiles(id,email,name,role) values($1,$2,$3,$4)',[id,`final-guidebook-${actor}-${runId}@gakja.test`,'최종 가이드북 격리 검증',role]);
    profiles.push(id);owners[actor]=id;tokens[actor]=token;
    await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '1 hour')",[createHash('sha256').update(token).digest('hex'),id]);
  }
  await db.query('insert into staff_assignments(staff_id,student_id,permissions) values($1,$2,$3)',[owners.staff,owners.student,JSON.stringify(['import','review','publish'])]);
  const pack=createDemoPack(owners.student,'최종 가이드북 격리 검증','environment')[0];
  for(const target of pack.learning_data.support_targets)await db.query('insert into support_targets(id,student_id,data) values($1,$2,$3)',[target.id,owners.student,JSON.stringify({...target,schedule:{personal_date:'2026-11-29',personal_at:'2026-11-29T10:00:00+09:00',status:'reviewed',revision:1}})]);
  await db.query('insert into production_links(id,student_id,data) values($1,$2,$3)',[pack.production_job_ref,owners.student,JSON.stringify({synthetic:true,runId})]);
  const target=pack.learning_data.support_targets[0],item=pack.learning_data.memory_items.find(item=>item.kind==='choice')!,question=pack.learning_data.questions.find(q=>q.id===item.question_id)!,activityId=item.activity_ids[0];
  Object.assign(pack.learning_data.activities.find(activity=>activity.id===activityId)!.priority_assignments[0],{talent_tags:['탐구','책임'],major_relevance:'수질 측정의 비교 조건과 환경공학 연결',representative_candidate:true,representative_reason:'원문 근거와 본인 역할을 설명할 수 있음'});rehash(pack);
  const targetBefore=(await db.query('select id,data from support_targets where student_id=$1 order by id',[owners.student])).rows;

  check((await upload(pack,'anonymous')).status===401,'anonymous cannot import a student final guidebook');
  check((await upload(pack,'student')).status===403,'student cannot import self-authored content');
  check((await upload(pack,'unassigned')).status===403,'unassigned staff cannot import another account');
  check((await upload(pack,'admin',owners.other)).status===400,'foreign student and production job pairing rejected');
  const wrongStudent=structuredClone(pack);wrongStudent.learning_data.student_context.student_id=owners.other;rehash(wrongStudent);
  check((await upload(wrongStudent)).status===400,'embedded student identity must match selected account');
  const draft=structuredClone(pack);draft.package_status='draft';check((await upload(draft)).status===400,'unreviewed final guidebook rejected');
  const noApproval=structuredClone(pack);noApproval.provenance.review_ref='';check((await upload(noApproval)).status===400,'missing external final approval evidence rejected');
  const invalidHash=structuredClone(pack);invalidHash.learning_data.activities[0].title+=' altered';check((await upload(invalidHash)).status===400,'modified learning data with stale hash rejected');
  check((await upload(pack,'admin',owners.student,'<!doctype html><main>원고만 있는 HTML</main>')).status===400,'plain HTML without embedded authored learning data rejected');
  const foreignTarget=structuredClone(pack);foreignTarget.learning_data.support_targets[0].id=`foreign-target-${runId}`;rehash(foreignTarget);check((await upload(foreignTarget)).status===400,'foreign or unregistered support target rejected');
  for(const [field,value] of [['university','다른 합성 대학'],['campus','다른 합성 캠퍼스'],['department','다른 합성 학과'],['admission_type','다른 합성 전형'],['admission_year',2028]] as const){const changed=structuredClone(pack);(changed.learning_data.support_targets[0] as any)[field]=value;rehash(changed);check((await upload(changed)).status===409,`registered target ${field} must match imported approved identity`);}
  const missingEvaluation=structuredClone(pack);missingEvaluation.learning_data.activities[0].priority_assignments.pop();rehash(missingEvaluation);check((await upload(missingEvaluation)).status===400,'each activity needs approved evaluation for every included support target');
  const handbook=createDemoPack(owners.student,'최종 가이드북 격리 검증','environment')[1];check((await upload(handbook)).status===400,'handbook alone cannot stand in for final guidebook');
  const paired=form(pack);paired.append('files',new File([renderLearningHtml(handbook)],'handbook.html',{type:'text/html'}));check((await request('admin','/api/imports',paired)).status===400,'new import accepts exactly the one requested final guidebook');

  const staged=await upload(pack,'staff');check(staged.status===200&&staged.body.status==='staged'&&!staged.body.duplicate,'assigned staff can stage a single externally reviewed final guidebook');
  const version1=staged.body.id;
  const stored=(await db.query('select review,data,status from content_versions where id=$1',[version1])).rows[0];
  check(stored.review.upload_mode==='guidebook'&&stored.review.import_contract==='final-guidebook-v1','stored import contract explicitly identifies single final guidebook');
  check(stable(stored.data)===stable(pack.learning_data),'authored activity evaluations, questions and quiz data are retained without regeneration');
  check((await request('student','/api/bootstrap')).body.package===null,'staged guidebook does not appear in student bootstrap');
  check((await request('student','/api/documents?kind=guidebook&contentVersion=1')).status===404,'staged original HTML remains inaccessible through document endpoint');
  check((await request('student','/api/quiz',{action:'create',mode:'choice',targetId:target.id,itemIds:[item.id]})).status===400,'student cannot create a quiz from staged guidebook items');
  check((await request('student','/api/interviews',{action:'start',targetId:target.id,questionId:question.id,sourceType:'personal',sourceVersion:1,questionCount:2,followups:false,feedbackTiming:'end'})).status===404,'student cannot start an interview from a staged source version');
  check((await preview(version1,'student')).status===403,'student cannot read staff staged preview');
  check((await preview(version1,'other')).status===403,'another student cannot read staged preview');
  check((await preview(version1,'unassigned')).status===403,'unassigned staff cannot read student preview');
  check((await action('admin','publish',{versionId:version1})).status===409,'publication is blocked until the exact preview is confirmed');
  check([400,409].includes((await action('admin','preview_confirm',{versionId:version1,digest:'0'.repeat(64)})).status),'forged or stale preview digest cannot approve publication');
  check((await action('student','preview_confirm',{versionId:version1,digest:'0'.repeat(64)})).status===403,'student cannot confirm staff preview');
  const storedDocument=(await db.query('select id,html from documents where package_id=$1 and content_version=1',[pack.package_id])).rows[0];
  await db.query('update documents set html=$1 where id=$2',[storedDocument.html+'<!-- synthetic corrupted file -->',storedDocument.id]);
  check((await preview(version1)).status===409,'stored file corruption invalidates staff preview');
  check((await action('admin','publish',{versionId:version1})).status===409,'corrupted uploaded original cannot publish');
  await db.query('update documents set html=$1 where id=$2',[storedDocument.html,storedDocument.id]);
  const duplicate=await upload(pack);check(duplicate.status===200&&duplicate.body.duplicate===true&&duplicate.body.id===version1,'identical single HTML is idempotent');
  const changedDocument=structuredClone(pack);changedDocument.document.blocks.find(block=>block.type==='text')!.text+=' 새 문장';
  check((await upload(changedDocument)).status===409,'same version and learning hash with different visible document requires new content version');
  await confirmAndPublish(version1,async()=>{
    await db.query("update support_targets set data=jsonb_set(data,'{department}',to_jsonb($1::text)) where id=$2 and student_id=$3",['검수 후 변경된 합성 학과',target.id,owners.student]);
    check((await action('admin','publish',{versionId:version1})).status===409,'target change after staging and preview blocks publication instead of overwriting registration');
    check((await db.query('select data from support_targets where id=$1',[target.id])).rows[0].data.department==='검수 후 변경된 합성 학과','failed publication preserves latest registered department');
    await db.query('update support_targets set data=$1 where id=$2 and student_id=$3',[JSON.stringify(targetBefore.find(row=>row.id===target.id)!.data),target.id,owners.student]);
  });
  const boot=await request('student','/api/bootstrap');check(boot.status===200&&boot.body.package.active_version===1&&boot.body.documents.length===1&&boot.body.documents[0].kind==='guidebook','student receives only the published final guidebook');
  check(stable(boot.body.learning)===stable(pack.learning_data),'published student content matches approved imported learning data');
  const original=await request('student','/api/documents?kind=guidebook&contentVersion=1');check(original.status===200&&original.body.document.html===renderLearningHtml(pack)&&original.body.document.file_hash===createHash('sha256').update(renderLearningHtml(pack)).digest('hex'),'private student document returns exact uploaded original HTML and file hash');
  check(original.headers.get('cache-control')?.includes('private')&&original.headers.get('cache-control')?.includes('no-store'),'original student HTML is private and not cacheable');
  check((await request('student','/api/documents?kind=handbook&contentVersion=1')).status===404,'single-book publication does not invent a handbook');
  check((await request('other','/api/documents?kind=guidebook&contentVersion=1')).status===404,'other account cannot retrieve original uploaded HTML');
  check((await request('admin','/api/documents?kind=guidebook&contentVersion=1')).status===403,'staff use assigned private preview rather than student document endpoint');
  check((await action('admin','review',{studentId:owners.student,versionId:version1,reject:true,note:'발행 후 반려 시도'})).status===409,'published source cannot be rejected underneath historical student sessions');
  const evaluation=boot.body.learning.activities.find((a:any)=>a.id===activityId).priority_assignments[0];check(evaluation.representative_candidate===true&&evaluation.talent_tags.includes('책임')&&evaluation.major_relevance.includes('환경공학'),'target-specific activity evaluation reaches student content');
  check(stable((await db.query('select id,data from support_targets where student_id=$1 order by id',[owners.student])).rows)===stable(targetBefore),'publication preserves student personal interview schedule alongside authored support information');
  const library=await request('student',`/api/quiz?targetId=${encodeURIComponent(target.id)}&activityId=${encodeURIComponent(activityId)}`);
  check(library.status===200&&library.body.library.choice.some((row:any)=>row.id===item.id&&row.question_id===question.id&&row.activity_ids.includes(activityId)),'guidebook activity and question resolve to authored quiz');
  const createdQuiz=await request('student','/api/quiz',{action:'create',mode:'choice',targetId:target.id,activityId,itemIds:[item.id],timed:false,focus:'free'});
  check(createdQuiz.status===200&&createdQuiz.body.session.content_version===1,'quiz freezes the guidebook version');
  const quizId=createdQuiz.body.session.id;
  check((await request('student','/api/quiz',{action:'start',sessionId:quizId})).status===200,'imported quiz starts');
  const answered=await request('student','/api/quiz',{action:'answer',sessionId:quizId,itemIndex:0,selectedOptionId:item.correct_option_id,rating:'good'});
  check(answered.status===200&&answered.body.session.state==='completed'&&answered.body.response.outcome===true,'reviewed quiz answers save with objective outcome');
  const savedAnswer=await action('student','save_answer',{questionId:question.id,structure:'개념 → 조건 → 활동 근거',script:'승인 교재의 개념을 실제 활동의 비교 조건과 연결했습니다.',expectedRevision:0});
  check(savedAnswer.status===200&&savedAnswer.body.answer.revision===1,'student answer and revision persist against published question');
  const createdInterview=await request('student','/api/interviews',{action:'start',targetId:target.id,activityId,questionId:question.id,sourceType:'personal',sourceVersion:1,questionCount:2,followups:false,feedbackTiming:'end'});
  check(createdInterview.status===200&&createdInterview.body.question.id===question.id&&createdInterview.body.session.content_version===1,'quiz question opens an interview on the same activity and exact source version');
  const interviewId=createdInterview.body.session.id,resources=createdInterview.body.session.data.context;
  check(resources.activities.some((a:any)=>a.id===activityId)&&resources.questions.some((q:any)=>q.id===question.id),'interview resources contain the original guidebook activity and question');
  // A report is an explicit persisted test fixture: avoid the AI-backed finish endpoint.
  await db.query("update interview_turns set data=data||$1::jsonb where id=$2 and student_id=$3",[JSON.stringify({answer:'비교 조건을 같게 유지하고 측정 한계를 함께 설명했습니다.',fixture:true}),createdInterview.body.turn.id,owners.student]);
  await db.query("update interview_sessions set state='completed',completed_at=now() where id=$1 and student_id=$2",[interviewId,owners.student]);
  const fixtureReport={contentVersion:1,fixture:true,sections:[{question_id:question.id,question:question.prompt,answer:'비교 조건을 같게 유지하고 측정 한계를 함께 설명했습니다.'}],sourceSnapshot:{question,activity:pack.learning_data.activities.find(a=>a.id===activityId)}};
  await db.query('insert into interview_reports(student_id,session_id,data) values($1,$2,$3)',[owners.student,interviewId,JSON.stringify(fixtureReport)]);
  const finalizedStudy={fixture:true,contentVersion:1,questionId:question.id,quizSessionId:quizId};
  await db.query("insert into study_sessions(student_id,state,ended_at,finish_reason,report) values($1,'finalized',now(),'manual',$2)",[owners.student,JSON.stringify(finalizedStudy)]);
  const beforeRecords=await savedRecords(owners.student);
  const oldAnswerRevisions=(beforeRecords.answer_revisions as any[]);check(oldAnswerRevisions.length===1&&oldAnswerRevisions[0].data.contentVersion===1,'answer history keeps original source version snapshot');
  const oldInterview=await request('student',`/api/interviews?id=${interviewId}`);check(oldInterview.status===200&&oldInterview.body.report.fixture===true,'saved interview report can be read before revision');

  const v2=nextVersion(pack,2);
  const deletedScripts=new Set(v2.learning_data.answer_scripts.filter(script=>script.question_id===question.id).map(script=>script.id));
  const deletedItems=new Set(v2.learning_data.memory_items.filter(entry=>entry.question_id===question.id).map(entry=>entry.id));
  v2.learning_data.questions=v2.learning_data.questions.filter(entry=>entry.id!==question.id).map(entry=>({...entry,followup_question_ids:entry.followup_question_ids.filter(id=>id!==question.id)}));
  v2.learning_data.answer_designs=v2.learning_data.answer_designs.filter(entry=>entry.question_id!==question.id);
  v2.learning_data.answer_scripts=v2.learning_data.answer_scripts.filter(entry=>!deletedScripts.has(entry.id));
  v2.learning_data.memory_keywords=v2.learning_data.memory_keywords.filter(entry=>!deletedScripts.has(entry.answer_script_id));
  v2.learning_data.memory_items=v2.learning_data.memory_items.filter(entry=>!deletedItems.has(entry.id));
  v2.document.blocks=v2.document.blocks.filter(block=>block.question_id!==question.id&&!deletedScripts.has(block.answer_script_id||'')&&!deletedItems.has(block.memory_item_id||''));
  const nextEvaluation=v2.learning_data.activities.find(entry=>entry.id===activityId)!.priority_assignments[0];nextEvaluation.priority='B';nextEvaluation.reason='개정 승인에서 준비 우선도를 조정함';rehash(v2);
  const staged2=await upload(v2);check(staged2.status===200&&staged2.body.version===2&&staged2.body.status==='staged','revised evaluation and question removal stage as a new immutable version');
  check((await request('student','/api/bootstrap')).body.package.active_version===1,'staging revision leaves existing approved book active');
  check((await request('student',`/api/interviews?preview=1&questionId=${encodeURIComponent(question.id)}&sourceVersion=2&sourceType=personal&targetId=${encodeURIComponent(target.id)}`)).status===404,'unpublished new version cannot be requested by sourceVersion');
  check((await request('student',`/api/quiz?targetId=${encodeURIComponent(target.id)}&sourceType=personal&sourceVersion=2`)).status===404,'quiz catalogue rejects an explicitly staged personal source version');
  check((await request('student','/api/quiz',{action:'create',mode:'choice',targetId:target.id,itemIds:[item.id],sourceType:'personal',sourceVersion:2})).status===404,'quiz creation rejects an explicitly staged personal source version');
  await confirmAndPublish(staged2.body.id);
  const newBoot=await request('student','/api/bootstrap');check(newBoot.body.package.active_version===2&&!newBoot.body.learning.questions.some((entry:any)=>entry.id===question.id),'new guidebook replaces current questions only');
  check(newBoot.body.learning.activities.find((entry:any)=>entry.id===activityId).priority_assignments[0].priority==='B','new approved evaluation reaches current activity data');
  check(stable(await savedRecords(owners.student))===stable(beforeRecords),'publication preserves all prior answers, revisions, quiz attempts/sessions, interview/report and finalized study report snapshots');
  const historicalCatalogue=await request('student',`/api/quiz?targetId=${encodeURIComponent(target.id)}&activityId=${encodeURIComponent(activityId)}&sourceType=personal&sourceVersion=1`);
  check(historicalCatalogue.status===200&&historicalCatalogue.body.contentVersion===1&&historicalCatalogue.body.library.choice.some((entry:any)=>entry.id===item.id&&entry.question_id===question.id&&entry.prompt===item.prompt),'explicit historical quiz catalogue retains removed original prompt and question link after v2 publication');
  const historicalQuiz=await request('student','/api/quiz',{action:'create',mode:'answer',targetId:target.id,activityId,itemIds:[item.id],sourceType:'personal',sourceVersion:1,focus:'free'});
  check(historicalQuiz.status===200&&historicalQuiz.body.session.content_version===1&&historicalQuiz.body.session.items[0].question_id===question.id&&historicalQuiz.body.session.items[0].activity_ids.includes(activityId),'new practice from archived guidebook keeps original activity, question and version');
  check(stable(historicalQuiz.body.learning)===stable(pack.learning_data),'historical quiz session returns its saved original approved learning data');
  const historicalHint=await request('student','/api/quiz',{action:'hint',sessionId:historicalQuiz.body.session.id});
  const modelScript=pack.learning_data.answer_scripts.find(script=>script.id===item.answer_script_id);
  const expectedHint=(modelScript?.text||item.options?.find(option=>option.id===item.correct_option_id)?.text||'').trim().match(/^[\s\S]*?(?:[.!?。！？](?=\s|$)|\n|$)/)?.[0].trim();
  check(historicalHint.status===200&&historicalHint.body.hint.first===expectedHint,'archived quiz hint uses approved original answer instead of current removed content');
  check((await request('other','/api/quiz',{action:'create',mode:'choice',itemIds:[item.id],sourceType:'personal',sourceVersion:1})).status===404,'another student cannot create historical practice from someone else’s version');
  const oldQuiz=await request('student',`/api/quiz?sessionId=${quizId}`);check(oldQuiz.status===200&&oldQuiz.body.session.content_version===1&&oldQuiz.body.session.items[0].question_id===question.id&&oldQuiz.body.responses[0].data.source_quotes.length>0,'removed quiz item still displays saved question and original source quotes');
  const oldReport=await request('student',`/api/interviews?id=${interviewId}`);check(oldReport.status===200&&stable(oldReport.body.report.data)===stable(fixtureReport)&&oldReport.body.session.data.context.contentVersion==='1','old interview and report read their saved approved context');
  check((await request('student',`/api/interviews?preview=1&questionId=${encodeURIComponent(question.id)}&activityId=${encodeURIComponent(activityId)}&sourceVersion=1&sourceType=personal&targetId=${encodeURIComponent(target.id)}`)).status===200,'explicit old published version remains available for original question practice');
  check((await action('student','save_answer',{questionId:question.id,script:'현재 교재에서 제거된 질문',expectedRevision:1})).status===404,'removed old question cannot overwrite an answer through current-content path');
  check((await request('other',`/api/quiz?sessionId=${quizId}`)).status===404&&(await request('other',`/api/interviews?id=${interviewId}`)).status===404,'saved quiz and interview snapshots remain private to their owner');
  check((await action('admin','rollback',{versionId:version1})).status===200&&(await request('student','/api/bootstrap')).body.package.active_version===1,'one-book published rollback restores the previous guidebook');
  check(priorRecordsUnchanged(await savedRecords(owners.student),beforeRecords),'rollback leaves all pre-existing learning history unchanged');
  check((await action('admin','rollback',{versionId:staged2.body.id})).status===200,'published revised one-book version remains a rollback candidate');
  const intentChanged=nextVersion(v2,3);intentChanged.learning_data.questions[0].question_intent+=' 완전히 다른 질문 의도';rehash(intentChanged);check((await upload(intentChanged)).status===409,'same question ID with changed intent is rejected rather than merging historical answers');

  const legacy=nextVersion(pack,3),legacyHandbook=structuredClone(handbook);legacyHandbook.content_version=3;legacyHandbook.document.document_revision=3;legacyHandbook.learning_data=structuredClone(legacy.learning_data);legacyHandbook.learning_data_hash=legacy.learning_data_hash;
  const legacyVersion=(await db.query("insert into content_versions(package_id,version,data,learning_hash,production_job_ref,created_by,status,published_by,published_at,review) values($1,3,$2,$3,$4,$5,'published',$5,now(),$6) returning id",[pack.package_id,JSON.stringify(legacy.learning_data),legacy.learning_data_hash,legacy.production_job_ref,owners.admin,JSON.stringify({checks:['hash_pair'],legacyFixture:true})])).rows[0].id;
  for(const doc of [legacy,legacyHandbook]){const html=renderLearningHtml(doc);await db.query('insert into documents(student_id,package_id,content_version,kind,data,html,file_hash) values($1,$2,3,$3,$4,$5,$6)',[owners.student,pack.package_id,doc.document.kind,JSON.stringify(doc.document),html,createHash('sha256').update(html).digest('hex')]);}
  check((await action('admin','rollback',{versionId:legacyVersion})).status===200,'pre-existing paired published content remains rollback-compatible');
  const legacyBoot=await request('student','/api/bootstrap');check(legacyBoot.body.package.active_version===3&&legacyBoot.body.documents.length===2,'legacy guidebook/handbook archives remain readable');
  check((await action('admin','rollback',{versionId:staged2.body.id})).status===200&&(await request('student','/api/bootstrap')).body.documents.length===1,'moving from legacy pair back to approved single guidebook works');
  check(priorRecordsUnchanged(await savedRecords(owners.student),beforeRecords),'switching legacy and new versions never rewrites pre-existing learning records');
  check((await db.query('select count(*)::int n from ai_usage_logs where student_id=any($1::uuid[])',[profiles])).rows[0].n===0&&(await db.query('select count(*)::int n from usage_records where student_id=any($1::uuid[])',[profiles])).rows[0].n===0,'regression consumes no AI calls or paid usage');
  observations.push({flow:'single final guidebook → validation → private preview confirmation → publication → linked quiz/interview',activityEvaluationPreserved:true,removedQuestionHistoryPreserved:true,legacyRollbackCompatible:true,paidAiCalls:0});
}catch(error){failed=redactEnvironmentSecrets(error instanceof Error?error.message:String(error));process.exitCode=1;}
finally{
  try{
    await db.query('begin');
    await db.query('delete from answer_revisions where answer_id in(select id from user_answers where student_id=any($1::uuid[]))',[profiles]);
    for(const table of ['answer_comments','user_answers','quiz_recordings','quiz_responses','quiz_sessions','interview_reports','interview_turns','media_assets','interview_sessions','study_session_events','study_session_tabs','study_imported_events','study_sessions','memory_attempts','preparation_states','student_confirmations','student_preferences','reading_progress','notifications','staff_assignments','documents'])await db.query(`delete from ${table} where student_id=any($1::uuid[])`,[profiles]);
    await db.query('delete from content_versions where package_id in(select id from content_packages where student_id=any($1::uuid[]))',[profiles]);
    await db.query('delete from content_packages where student_id=any($1::uuid[])',[profiles]);
    await db.query('delete from production_links where student_id=any($1::uuid[])',[profiles]);
    await db.query('delete from support_targets where student_id=any($1::uuid[])',[profiles]);
    await db.query('delete from audit_logs where student_id=any($1::uuid[]) or actor_id=any($1::uuid[])',[profiles]);
    await db.query('delete from sessions where user_id=any($1::uuid[])',[profiles]);
    await db.query('delete from profiles where id=any($1::uuid[])',[profiles]);
    await db.query('commit');
    cleaned=(await db.query('select count(*)::int n from profiles where id=any($1::uuid[])',[profiles])).rows[0].n===0;check(cleaned,'all exact owned synthetic fixtures cleaned');
  }catch(error){await db.query('rollback');failed=[failed,'Fixture cleanup: '+redactEnvironmentSecrets(error instanceof Error?error.message:String(error))].filter(Boolean).join('; ');process.exitCode=1;}
  await db.end();
  const evidence={status:failed?'failed':'passed',checkedAt:new Date().toISOString(),checks,fixturesCreated:profiles.length,fixturesCleaned:cleaned,paidAiCalls:0,observations,error:failed};
  writeFileSync(join(projectRoot,'.local/guidebook-import-api-check.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(failed?`Final guidebook integration failed after ${checks} checks: ${failed}`:`Final guidebook API checks passed: ${checks}; ${profiles.length} exact synthetic fixtures cleaned; no AI calls.`);
}
