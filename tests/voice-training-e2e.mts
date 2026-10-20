// Explicit opt-in: real Korean speech bytes, actual paid STT/cleanup/feedback, real local HTTP + PostgreSQL.
// This covers the captured-file boundary; it does not claim that a physical microphone was tested.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import pg from 'pg';
import {loadProjectEnv,redactEnvironmentSecrets,projectRoot} from '../scripts/load-env.mjs';
import {registerReviewedSchool} from './school-registration-fixture.mts';

loadProjectEnv();
if(process.env.RUN_PAID_VOICE_TRAINING_E2E!=='1'){
 console.log('Skipped real-provider voice E2E. Set RUN_PAID_VOICE_TRAINING_E2E=1 and VOICE_TRAINING_AUDIO to an actual Korean speech WAV.');
}else{
 const base=process.env.VOICE_TRAINING_TEST_URL||'http://localhost:3100';
 if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(new URL(base).hostname)||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw new Error('Local QA server/database required.');
 assert.ok(process.env.OPENAI_API_KEY?.trim(),'An actual provider key is required.');
 const audioPath=process.env.VOICE_TRAINING_AUDIO;assert.ok(audioPath,'Provide a Korean speech WAV.');
 const audio=await readFile(audioPath);assert.equal(audio.subarray(0,4).toString(),'RIFF');assert.equal(audio.subarray(8,12).toString(),'WAVE');
 const duration=(audio.length-44)/audio.readUInt32LE(28);assert.ok(duration>1&&duration<60,'Use 1–60 seconds of real speech.');
 const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();
 const id=randomUUID(),email=`voice-training-${id}@gakja.test`,token=randomBytes(32).toString('hex'),hash=createHash('sha256').update(token).digest('hex');
 let created=false,failure:unknown,pool:undefined|{end:()=>Promise<void>},stage='fixture';
 const checks:string[]=[],result:Record<string,any>={physicalMicrophoneTested:false,audioSource:process.env.VOICE_TRAINING_AUDIO_SOURCE||'provided Korean speech WAV',durationSeconds:Math.round(duration*10)/10};
 function check(value:unknown,label:string){assert.ok(value,label);checks.push(label);}
 async function request(path:string,body?:unknown,status=200){
  const form=body instanceof FormData;
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:base,Cookie:'gakja_session='+token,...(form?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:form?body:JSON.stringify(body)}),signal:AbortSignal.timeout(180000)});
  const value=await response.json();assert.equal(response.status,status,`${stage}: ${path.split('?')[0]} ${response.status}: ${value.code||value.error||'unexpected status'}`);return value;
 }
 function phase(name:string){stage=name;console.log('Voice E2E: '+name);}
 try{
  await db.query("insert into profiles(id,email,name,role) values($1,$2,'격리 음성 종단 검증','student')",[id,email]);created=true;
  await db.query("insert into sessions(id,user_id,expires_at) values($1,$2,now()+interval '45 minutes')",[hash,id]);
  const catalogue=await request('/api/schools/catalog'),school=catalogue.schools.find((s:any)=>s.canonicalName==='서울시립대학교');assert.ok(school);
  const detail=await request('/api/schools/catalog?schoolId='+school.id),department=detail.school.departments.find((d:any)=>d.name==='환경공학부');assert.ok(department);
  const registered=await registerReviewedSchool(async(path,body)=>({status:200,body:await request(path,body)}),{referenceId:school.id,departmentId:department.id,admissionYear:2027,track:'학생부종합전형Ⅰ(면접형)'}),target=registered.body.target;
  const availability={weekdayMinutes:120,weekendMinutes:120,csatDate:null,beforeCsatWeekdayMinutes:120,beforeCsatWeekendMinutes:120,blockedDates:[],overrides:{}};
  await request('/api/training/preferences',{expectedRevision:0,availability});
  const before=await request('/api/training?targetId='+target.id),plan=before.today.tasks.find((t:any)=>t.kind==='diagnostic');assert.ok(plan);
  const today=before.today.date,tomorrow=before.days[1].date;
  const storedPlan=(await db.query('select revision,completed from student_plans where id=$1 and student_id=$2',[plan.id,id])).rows[0];
  await request('/api/planner',{action:'update',id:plan.id,expectedRevision:storedPlan.revision,completed:true},409);
  await request('/api/planner',{action:'update',id:plan.id,expectedRevision:storedPlan.revision,date:tomorrow},409);
  check((await db.query('select completed from student_plans where id=$1 and student_id=$2',[plan.id,id])).rows[0].completed===false,'Manual planner changes cannot mark an untouched hybrid training task complete or move its date');
  const cardId=randomUUID(),card=(await request('/api/armory',{id:cardId,revision:0,data:{title:'수질 탐구 음성 검증',category:'탐구',situation:'측정 결과가 달랐다',action:'같은 시간과 장소에서 재측정을 제안하고 조건을 기록했다',result:'반복 결과와 한계를 함께 비교했다',confirmed:true,pinned:false,sourceNote:'실제 사용자와 분리된 종단 검증용 경험'}})).card;
  const questionId=before.diagnosticInput.questionIds[0];
  const scoped={targetId:target.id,sourceType:before.diagnosticInput.sourceType,sourceVersion:before.diagnosticInput.sourceVersion,experienceCardId:cardId,experienceRevision:card.revision,questionId,questionCount:1,followups:false};
  phase('written diagnostic baseline');
  const startedTask=(await request('/api/training',{action:'task_start',planId:plan.id})).task;
  const written=await request('/api/interviews',{action:'start',kind:'video',...scoped,questionIds:[questionId],trainingPlanId:plan.id,trainingPurpose:'diagnostic',feedbackTiming:'end',requestId:startedTask.requestId||randomUUID()});
  check(written.aiAvailable===true,'Actual app server has AI enabled');
  await request('/api/training',{action:'link_session',planId:plan.id,sessionId:written.session.id,diagnostic:true});
  await request('/api/interviews',{action:'resume',sessionId:written.session.id});
  const baselineText='저는 과학 동아리에서 수질 탐구를 했습니다. 같은 시간과 장소에서 재측정하자고 제안하고 조건을 표에 기록했습니다.';
  await request('/api/interviews',{action:'answer',sessionId:written.session.id,turnId:written.question.turnId,answer:baselineText,requestId:randomUUID()});
  const writtenFinish=await request('/api/interviews',{action:'finish',sessionId:written.session.id});
  check(writtenFinish.report?.aiStatus==='completed','Written diagnostic report receives real AI feedback');
  const baseline=await request('/api/training?targetId='+target.id),baselineItem=baseline.readiness.items.find((item:any)=>item.id==='experience:'+cardId);
  check(baselineItem?.textAttempts===1&&baselineItem.audioAttempts===0,'One written answer contributes to the selected activity');
  phase('actual recording-upload and real transcription');
  const voice=await request('/api/interviews',{action:'start',kind:'video',...scoped,trainingPurpose:'focus',followups:true,feedbackTiming:'turn',requestId:randomUUID()});
  const resumed=await request('/api/interviews',{action:'resume',sessionId:voice.session.id}),generation=Number(resumed.session.data.generation||0);
  const uploadFields={sessionId:voice.session.id,questionId:voice.question.id,turnId:voice.question.turnId,generation:String(generation),durationSeconds:String(duration),consent:'true'};
  const intent=await request('/api/uploads',{kind:'interview',fields:uploadFields,files:[{field:'recording',mime:'audio/wav',size:audio.length}]});
  check(intent.transport==='multipart','The actual local recording-upload negotiation selects multipart');
  const form=new FormData();for(const[key,value]of Object.entries(uploadFields))form.set(key,value);form.set('recording',new File([audio],'korean-answer.wav',{type:'audio/wav'}));
  const uploaded=await request('/api/media',form);result.transcription={status:uploaded.transcriptionStatus,cleanupStatus:uploaded.cleanupStatus,cleanupCode:uploaded.cleanupCode,recognizedCharacters:uploaded.rawTranscript?.length||0};
  check(uploaded.transcriptionStatus==='completed'&&uploaded.rawTranscript?.length>20,'Actual provider recognizes the Korean recording');
  check(uploaded.cleanupStatus==='completed'&&uploaded.transcript?.length>20,'Actual provider finishes immutable display-only transcript cleanup');
  check(/측정|탐구/.test(uploaded.rawTranscript),'Recognized transcript contains the spoken activity');
  const usageBeforeCache=(await db.query('select count(*)::int count from ai_usage_logs where student_id=$1',[id])).rows[0].count;
  const repeated=await request('/api/media',{action:'transcribe',mediaId:uploaded.media.id});
  check(repeated.cached===true&&repeated.rawTranscript===uploaded.rawTranscript,'Repeated transcription reuses the actual durable recognition and formatting');
  check((await db.query('select count(*)::int count from ai_usage_logs where student_id=$1',[id])).rows[0].count===usageBeforeCache,'A cached transcription makes no second paid provider request');
  phase('recording submission, real AI feedback and follow-up');
  await request('/api/interviews',{action:'resume',sessionId:voice.session.id});
  const answerInput={action:'answer_recording',sessionId:voice.session.id,turnId:voice.question.turnId,mediaId:uploaded.media.id,generation,requestId:randomUUID()};
  const answer=await request('/api/interviews',answerInput);
  result.feedback={contentCharacters:answer.feedback?.content?.length||0,model:answer.feedback?.model,aiError:answer.aiError||null};
  check(answer.turn.submissionSource==='recording'&&answer.turn.speechSource?.rawText===uploaded.rawTranscript,'Submitted answer preserves original audio-derived text and recording provenance');
  check(answer.feedback?.content?.length>10&&!answer.aiError,'Real AI turn feedback is durably attached to the spoken answer');
  check(answer.nextQuestion?.questionKind==='generated','Real AI produces an activity-linked follow-up question');
  const duplicate=await request('/api/interviews',answerInput);check(duplicate.turn.id===answer.turn.id,'Retrying the same recording receipt does not create a second attempt');
  const finished=await request('/api/interviews',{action:'finish',sessionId:voice.session.id});
  check(finished.report?.aiStatus==='completed'&&finished.report.aiFeedback?.content?.length>10,'Real AI final feedback completes after the voice answer');
  const after=await request('/api/training?targetId='+target.id),item=after.readiness.items.find((row:any)=>row.id==='experience:'+cardId);
  check(item?.textAttempts===1&&item.audioAttempts===1&&item.mainAnswers===2,'Same activity combines exactly one written and one voice attempt');
  const original=(await request('/api/interviews?id='+written.session.id)).turns[0];check(original.answer===baselineText,'The earlier written answer remains unchanged');
  const media=(await db.query('select data,text,metadata from media_assets where id=$1 and student_id=$2',[uploaded.media.id,id])).rows[0];
  check(Buffer.compare(media.data,audio)===0&&media.text===uploaded.rawTranscript,'Original recording bytes and raw transcript remain immutable');
  phase('diagnostic reflection and real next-day durable replanning');
  await request('/api/training',{action:'diagnostic_reflection',sessionId:written.session.id,needsReviewQuestionIds:[questionId],focusCategories:['major']});
  const reflected=await request('/api/training?targetId='+target.id);check(reflected.diagnostics.needsReviewQuestionIds.includes(questionId),'Student-selected improvement persists for planning');
  registerHooks({resolve(specifier,context,nextResolve){
   if(specifier==='server-only')return {url:pathToFileURL(join(projectRoot,'node_modules/next/dist/compiled/server-only/empty.js')).href,shortCircuit:true};
   if(specifier.startsWith('@/'))return {url:pathToFileURL(join(projectRoot,'apps/web/src',specifier.slice(2)+(specifier.endsWith('.json')?'':'.ts'))).href,shortCircuit:true};
   return nextResolve(specifier,context);
  }});
  const store=await import('../apps/web/src/lib/hybrid-training-store.ts');pool=(await import('../apps/web/src/lib/db.ts')).pool;
  const nextDay=await store.getHybridTraining(id,target.id,tomorrow);
  result.nextDay={date:tomorrow,capacityMinutes:nextDay.today.capacityMinutes,plannedMinutes:nextDay.today.plannedMinutes,mode:nextDay.today.allocation.mode,tasks:nextDay.today.tasks.map(task=>({kind:task.kind,questionId:task.questionId,minutes:task.minutes,reason:task.reason}))};
  check(nextDay.today.date===tomorrow&&nextDay.today.capacityMinutes===120&&nextDay.today.plannedMinutes<=120,'The production planner advances to the next day within actual available minutes');
  check(nextDay.today.allocation.mode==='repair'&&nextDay.today.tasks.some(task=>task.kind==='recall'&&task.questionId===questionId)&&nextDay.today.tasks.some(task=>task.kind==='focus'&&/직접|진단|보완/.test(task.reason)),'The next day recalls the actual answered question and allocates focused repair from student diagnosis');
  check(!nextDay.today.tasks.some(task=>task.kind==='diagnostic'),'Completed diagnosis does not restart on the next day');
  const preserved=(await db.query('select id from student_plans where id=$1 and student_id=$2',[plan.id,id])).rows;check(preserved.length===1,'Past completed training remains after the next-day replan');
  result.usage=(await db.query('select feature,model,status,count(*)::int requests from ai_usage_logs where student_id=$1 group by feature,model,status order by feature',[id])).rows;
  check(result.usage.every((entry:any)=>entry.status==='completed'),'All actual provider requests completed successfully');
 }catch(error){failure=error;result.failedStage=stage;result.error=redactEnvironmentSecrets(error instanceof Error?error.message:String(error));}
 finally{
  try{if(created){
   const owner=(await db.query('select email from profiles where id=$1',[id])).rows[0];assert.equal(owner?.email,email,'Cleanup only the exact synthetic profile created by this run');
   await db.query('begin');
   for(const table of ['interview_reports','media_assets','interview_turns','interview_sessions','study_session_events','study_session_tabs','study_sessions','experience_card_drafts','experience_cards','student_plans','ai_usage_logs','notifications','student_preferences','school_profiles','support_targets'])await db.query(`delete from ${table} where student_id=$1`,[id]);
   await db.query('delete from audit_logs where actor_id=$1 or student_id=$1',[id]);await db.query('delete from sessions where user_id=$1',[id]);await db.query('delete from profiles where id=$1 and email=$2',[id,email]);await db.query('commit');result.syntheticDataCleaned=true;
  }}catch(error){await db.query('rollback');failure??=error;result.cleanupError=redactEnvironmentSecrets(error instanceof Error?error.message:String(error));}
  await pool?.end();await db.end();
 }
 result.checks=checks;result.passed=!failure;await mkdir(join(projectRoot,'.local'),{recursive:true});await writeFile(join(projectRoot,'.local/voice-training-e2e-result.json'),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));if(failure)process.exitCode=1;
}
