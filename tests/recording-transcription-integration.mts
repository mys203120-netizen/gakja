// Real PostgreSQL locking/persistence; synthetic audio and a stubbed provider, never paid calls.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import pg from 'pg';
import {loadProjectEnv,projectRoot} from '../scripts/load-env.mjs';
loadProjectEnv();
const source=process.env.DATABASE_URL!;
if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(new URL(source).hostname))throw new Error('Local isolated PostgreSQL only.');
const schema='qa_transcription_'+randomUUID().replaceAll('-','');
const admin=new pg.Client({connectionString:source});await admin.connect();
const target=new URL(source);target.searchParams.set('options',`-c search_path=${schema}`);process.env.DATABASE_URL=target.toString();
process.env.OPENAI_TRANSCRIPT_CLEANUP_MODEL='gpt-6-luna';process.env.TRANSCRIPT_CLEANUP_ENABLED='true';
// Exercise the configured-provider branch with a local stub; never depend on a real key.
process.env.OPENAI_API_KEY='synthetic-transcription-provider-fixture';
const state={stt:0,format:0,fail:false,raw:'음, 저는 관찰했습니다. 이유가 궁금했습니다.',display:'음, 저는 관찰했습니다.\n이유가 궁금했습니다.',beforeFormat:null as null|(()=>Promise<void>)};
(globalThis as any).__qaTranscriptionState=state;
const providerStub=pathToFileURL(join(projectRoot,'tests/fixtures/transcription-provider.mjs')).href;
registerHooks({resolve(specifier,context,nextResolve){
  if(specifier==='server-only')return {url:pathToFileURL(join(projectRoot,'node_modules/next/dist/compiled/server-only/empty.js')).href,shortCircuit:true};
  if(specifier==='./speech-transcription'&&context.parentURL?.includes('/apps/web/src/lib/'))return {url:providerStub,shortCircuit:true};
  if(specifier.startsWith('@/'))return {url:pathToFileURL(join(projectRoot,'apps/web/src',specifier.slice(2)+(specifier.endsWith('.json')?'':'.ts'))).href,shortCircuit:true};
  return nextResolve(specifier,context);
}});
const {pool}=await import('../apps/web/src/lib/db.ts');
const {transcribeOwnedInterviewRecording}=await import('../apps/web/src/lib/interview-transcription.ts');
const {transcribeOwnedQuizRecording}=await import('../apps/web/src/lib/speech-growth-store.ts');
const {ownedInterviewTranscriptSelection}=await import('../apps/web/src/lib/interview-transcript-selection.ts');
const {snapshotSpeechAnswer}=await import('../apps/web/src/lib/transcript-provenance.ts');
const {closeRecordingTranscriptionLocks}=await import('../apps/web/src/lib/recording-transcription.ts');
let checks=0;function check(value:unknown,message:string){assert.ok(value,message);checks++;}
const student=randomUUID(),other=randomUUID();
const user={id:student,role:'student'} as any;
async function fixture(draft='',answer:string|null=null){
  const session=randomUUID(),turn=randomUUID(),media=randomUUID();
  await pool.query("insert into interview_sessions(id,student_id,state) values($1,$2,'active')",[session,student]);
  await pool.query('insert into interview_turns(id,session_id,student_id,data) values($1,$2,$3,$4)',[turn,session,student,JSON.stringify({question:'합성 질문',draft,answer})]);
  await pool.query('insert into media_assets(id,student_id,session_id,data,mime,metadata) values($1,$2,$3,$4,$5,$6)',[media,student,session,Buffer.from('synthetic'), 'audio/wav',JSON.stringify({kind:'answer_recording',turnId:turn,provider:'postgresql',durationSeconds:10})]);
  return {session,turn,media};
}
try {
  await admin.query(`create schema ${schema}`);
  await pool.query('create table interview_sessions(id uuid primary key,student_id uuid,state text);create table interview_turns(id uuid primary key,session_id uuid,student_id uuid,data jsonb);create table media_assets(id uuid primary key,student_id uuid,session_id uuid,data bytea,mime text,text text,metadata jsonb);create table quiz_sessions(id uuid primary key,student_id uuid);create table quiz_recordings(id uuid primary key,session_id uuid,student_id uuid,data bytea,mime text,duration_ms integer,metadata jsonb);');
  const first=await fixture();
  state.beforeFormat=async()=>{const row=(await pool.query('select text,metadata from media_assets where id=$1',[first.media])).rows[0];check(row.text===state.raw&&row.metadata.transcriptionStatus==='completed','raw STT committed before formatter can run');check(!row.metadata.displayTranscript,'unfinished text never becomes normal display');};
  const results=await Promise.all([transcribeOwnedInterviewRecording(student,first.media),transcribeOwnedInterviewRecording(student,first.media)]);
  state.beforeFormat=null;
  check(state.stt===1&&state.format===1,'concurrent identical requests pay once per stage');
  check(results.every(result=>result.transcript===state.display&&result.rawTranscript===state.raw&&result.cleanupStatus==='completed'),'normal responses contain only finished cleaned text');
  const firstTurn=(await pool.query('select data from interview_turns where id=$1',[first.turn])).rows[0].data;
  check(firstTurn.draft===state.display&&firstTurn.rawTranscript===state.raw,'empty current draft receives finished text and separate raw source');
  check(firstTurn.mediaVersions.length===1&&firstTurn.transcriptRevisions.length===0,'formatting is not a new speech attempt or student correction');
  const failed=await fixture();state.fail=true;const failedResult=await transcribeOwnedInterviewRecording(student,failed.media);
  check(failedResult.transcript===null&&failedResult.rawTranscript===state.raw&&failedResult.transcriptionStatus==='completed'&&failedResult.cleanupStatus==='failed','format failure preserves raw without false completion');
  check((await pool.query('select data from interview_turns where id=$1',[failed.turn])).rows[0].data.draft==='','failed cleanup cannot populate answer draft');
  const beforeRetry=state.stt;state.fail=false;await transcribeOwnedInterviewRecording(student,failed.media);
  check(state.stt===beforeRetry&&state.format===3,'format retry reuses raw audio recognition');
  const typed=await fixture('제가 직접 쓴 초안입니다.');await transcribeOwnedInterviewRecording(student,typed.media);
  check((await pool.query('select data from interview_turns where id=$1',[typed.turn])).rows[0].data.draft==='제가 직접 쓴 초안입니다.','existing manually typed draft is never overwritten');
  const selectionDb=await pool.connect();
  try {
    await selectionDb.query('begin');
    const selected=await ownedInterviewTranscriptSelection(selectionDb,student,typed.session,typed.turn,typed.media);
    await selectionDb.query('update interview_turns set data=data || $2::jsonb where id=$1',[typed.turn,JSON.stringify(selected)]);
    await selectionDb.query('commit');
    const selectedTurn=(await pool.query('select data from interview_turns where id=$1',[typed.turn])).rows[0].data;
    check(selectedTurn.draft===state.display&&selectedTurn.mediaId===typed.media&&selectedTurn.rawTranscriptMediaId===typed.media,'explicit selection attaches the selected rerecording and finished draft together');
    const frozen=snapshotSpeechAnswer(selectedTurn.rawTranscript,selectedTurn.displayTranscript,selectedTurn.transcriptCleanup,selectedTurn.draft,selectedTurn.mediaId);
    check(frozen?.rawText===state.raw&&frozen.displayText===state.display&&!frozen.studentEdited,'selected rerecording retains actual spoken content in the submitted source snapshot');
    await assert.rejects(()=>ownedInterviewTranscriptSelection(selectionDb,other,typed.session,typed.turn,typed.media),error=>(error as any).code==='TRANSCRIPT_MEDIA_NOT_FOUND');checks++;
    await assert.rejects(()=>ownedInterviewTranscriptSelection(selectionDb,student,first.session,first.turn,typed.media),error=>(error as any).code==='TRANSCRIPT_MEDIA_NOT_FOUND');checks++;
    await pool.query("update media_assets set metadata=metadata || '{\"transcriptCleanup\":{\"status\":\"failed\"}}'::jsonb where id=$1",[typed.media]);
    await assert.rejects(()=>ownedInterviewTranscriptSelection(selectionDb,student,typed.session,typed.turn,typed.media),error=>(error as any).code==='TRANSCRIPT_NOT_READY');checks++;
  } finally {selectionDb.release();}
  const late=await fixture();state.beforeFormat=async()=>{await pool.query("update interview_turns set data=data || '{\"answer\":\"이미 제출한 답변\",\"draft\":\"제출 당시 초안\"}'::jsonb where id=$1",[late.turn]);};await transcribeOwnedInterviewRecording(student,late.media);state.beforeFormat=null;
  const lateData=(await pool.query('select data from interview_turns where id=$1',[late.turn])).rows[0].data;
  check(lateData.answer==='이미 제출한 답변'&&lateData.draft==='제출 당시 초안','late completion cannot replace a submitted answer or draft');
  const changed=await fixture();state.beforeFormat=async()=>{await pool.query("update interview_turns set data=data || '{\"draft\":\"다른 탭에서 수정한 초안\"}'::jsonb where id=$1",[changed.turn]);};await transcribeOwnedInterviewRecording(student,changed.media);state.beforeFormat=null;
  check((await pool.query('select data from interview_turns where id=$1',[changed.turn])).rows[0].data.draft==='다른 탭에서 수정한 초안','concurrent manual editing is protected');
  await assert.rejects(()=>transcribeOwnedInterviewRecording(other,first.media),error=>(error as any).code==='MEDIA_NOT_FOUND');checks++;
  const quizSession=randomUUID(),quizRecording=randomUUID();await pool.query('insert into quiz_sessions(id,student_id) values($1,$2)',[quizSession,student]);await pool.query('insert into quiz_recordings(id,session_id,student_id,data,mime,duration_ms,metadata) values($1,$2,$3,$4,$5,10000,$6)',[quizRecording,quizSession,student,Buffer.from('synthetic'),'audio/wav',JSON.stringify({provider:'postgresql'})]);
  const oldStt=state.stt,oldFormat=state.format;await Promise.all([transcribeOwnedQuizRecording(user,quizRecording),transcribeOwnedQuizRecording(user,quizRecording)]);
  const quiz=(await pool.query('select metadata from quiz_recordings where id=$1',[quizRecording])).rows[0].metadata;
  check(state.stt===oldStt+1&&state.format===oldFormat+1,'quiz concurrent requests share same two-stage cache');
  check(quiz.transcript===state.raw&&quiz.displayTranscript===state.display&&quiz.speechAnalysis.transcript.fillerCount===1,'quiz raw fillers remain measurable after display cleanup');
  await assert.rejects(()=>transcribeOwnedQuizRecording({...user,id:other},quizRecording),error=>(error as any).status===404);checks++;
  // An explicit retry upgrades old formatting without paying for STT again.
  await pool.query("update media_assets set metadata=jsonb_set(metadata,'{transcriptCleanup,promptVersion}','\"gakja-transcript-copyedit-1\"'::jsonb) where id=$1",[first.media]);
  const sttBeforeUpgrade=state.stt,formatBeforeUpgrade=state.format;
  await transcribeOwnedInterviewRecording(student,first.media);
  check(state.stt===sttBeforeUpgrade&&state.format===formatBeforeUpgrade+1,'old prompt version reuses raw but runs new formatting on explicit retry');
  console.log(`Recording transcription PostgreSQL: ${checks} checks passed; external provider calls: 0.`);
} finally {await closeRecordingTranscriptionLocks();await pool.end();await admin.query(`drop schema ${schema} cascade`);await admin.end();delete (globalThis as any).__qaTranscriptionState;}
