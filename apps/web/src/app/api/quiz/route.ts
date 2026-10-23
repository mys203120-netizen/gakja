import { recordingForm, recordingRedirect } from '@/lib/recording-upload';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { checkOrigin, requireUser } from '@/lib/auth';
import { getLearning } from '@/lib/data';
import { ApiError, errorResponse, query, transaction } from '@/lib/db';
import { eligibleQuizItems, firstSentenceHint, quizOutcome, quizPracticeIdentity, remainingChoiceMs, type SessionItem } from '@/lib/quiz-rules';
import { recordStudyEvent } from '@/lib/study-sessions';
import { mapSavedQuizItem, selectQuizItems } from '@/lib/quiz-selection';
import { analyzeSpeech, validateSpeechTelemetry } from '@/lib/speech-analysis';
import {commonInterviewQuestions,schoolLearningIdentityMatches} from '@/lib/school-learning';
import {quizSchoolMetadata,sameSchoolQuizSource,schoolQuizItems,schoolQuizTargetIdentity} from '@/lib/school-quiz';
import {quizHelpFacts,recordQuizHelp} from '@/lib/quiz-assistance';
import {snapshotSpeechAnswer} from '@/lib/transcript-provenance';
import {PRIVACY_POLICY_VERSION} from '@/lib/privacy-policy';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const uuid = z.string().uuid(), mode = z.enum(['choice','answer','oral']);
const json = (value: unknown) => Response.json(value, { headers: { 'Cache-Control':'private, no-store' } });
const publicItem = (item: SessionItem) => {const identity=quizPracticeIdentity(item);return { id:item.id, question_id:identity.questionId,practice_kind:identity.practiceKind,practice_prompt:identity.practicePrompt,linked_question_id:identity.linkedQuestionId,activity_ids:item.activity_ids, prompt:item.prompt, kind:item.kind, options:item.options, memory_keywords:item.memory_keywords, source_ref_ids:item.source_ref_ids, hasHint:!!item.modelAnswer,...quizSchoolMetadata(item) };};
const sessionLabel = (row:any) => ({ ...row, timed:row.mode==='choice'&&row.metadata?.timed!==false, topicLabel:row.items?.[0]?.prompt || '질문 연습',questionIds:row.items?.map((item:any)=>quizPracticeIdentity(item).questionId)||[],memoryItemIds:row.items?.map((item:any)=>item.id)||[] });
async function sessionView(row: any) {
  let responses = await query('select * from quiz_responses where session_id=$1 and student_id=$2 order by item_index', [row.id,row.student_id]);
  let originalSourceUnavailable=false,learning:any=null;
  if(row.content_version>0) {
    try {
      const original=await getLearning(row.student_id,row.content_version);
      if(!original.package)throw new ApiError(404,'발행된 자료를 찾을 수 없어요.');
      learning=original.learning;
      responses=responses.map(response=>{
        if(response.data?.source_quotes)return response;
        const saved=row.items[response.item_index],sources=(saved?.source_ref_ids||[]).flatMap((id:string)=>{const source=learning.source_refs?.find((source:any)=>source.id===id);return source?.quote?[{id,text:source.quote,area:source.area,page:source.page}]:[];});
        return {...response,data:{...response.data,source_quotes:sources}};
      });
    }catch {originalSourceUnavailable=true;}
  }
  const recordings = await query("select id,item_index,mime,duration_ms,created_at,metadata->'speechAnalysis' as speech_analysis,metadata->>'transcript' as raw_transcript,metadata->>'displayTranscript' as display_transcript,metadata->'transcriptCleanup' as transcript_cleanup,metadata->>'transcriptionStatus' as transcription_status from quiz_recordings where session_id=$1 and student_id=$2 order by created_at desc", [row.id,row.student_id]);
  const {items,...session} = row;
  return { session:sessionLabel({...session,items:items.map(publicItem)}), learning, contentVersion:row.content_version, responses, recordings:recordings.map(r=>({...r,url:`/api/quiz?recordingId=${r.id}`})), originalSourceUnavailable, serverTime:new Date().toISOString() };
}
async function student() { const user=await requireUser(); if(user.role!=='student')throw new ApiError(403,'학생 계정으로 퀴즈를 풀어주세요.'); return user; }
function failure(error:unknown) { if(error instanceof z.ZodError)return Response.json({error:'입력 항목을 확인해 주세요.'},{status:400}); return errorResponse(error); }
async function quizTarget(studentId:string,requestedId?:string|null) {
  let targetId=requestedId;
  if(targetId===undefined){const [preferences]=await query('select data from student_preferences where student_id=$1',[studentId]);targetId=preferences?.data?.selectedTargetId || null;}
  if(!targetId)return null;
  const [target]=await query("select id,data from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null",[targetId,studentId]);
  if(!target)throw new ApiError(404,'지원 학교를 찾을 수 없어요.');
  return {...target.data,id:target.id};
}
function versionedQuizTarget(learning:any,registeredTarget:Record<string,any>|null,personalVersion?:number) {
  const publishedTarget=personalVersion&&registeredTarget?learning.support_targets?.find((item:any)=>item.id===registeredTarget.id):null;
  const target=publishedTarget?{...publishedTarget,id:registeredTarget!.id}:registeredTarget;
  const targetSnapshotStale=Boolean(publishedTarget&&registeredTarget&&!schoolLearningIdentityMatches(schoolQuizTargetIdentity(publishedTarget)!,schoolQuizTargetIdentity(registeredTarget)!));
  return {target,targetSnapshotStale};
}
function scopedPersonalItems(learning:any,selectedMode:'choice'|'answer'|'oral',target:Record<string,any>|null) {
  return eligibleQuizItems(learning,selectedMode).filter(item=>{
    const question=learning.questions?.find((question:any)=>question.id===item.linked_question_id || question.id===item.question_id);
    const targetIds=question?.support_target_ids || [];
    if(!target)return !targetIds.length;
    if(!targetIds.length)return true;
    if(!targetIds.includes(target.id))return false;
    const publishedTarget=learning.support_targets?.find((item:any)=>item.id===target.id);
    return !publishedTarget || schoolLearningIdentityMatches(schoolQuizTargetIdentity({...publishedTarget,id:target.id})!,schoolQuizTargetIdentity(target)!);
  });
}
function selectedQuizActivity(learning:any,activityId?:string|null) {
  if(!activityId)return null;
  const activity=learning.activities?.find((item:any)=>item.id===activityId);
  if(!activity || !['verified','approved','confirmed','synthetic_reviewed','confirmed_from_record','confirmed_by_student'].includes(activity.fact_confirmation))throw new ApiError(404,'확인된 내 활동을 다시 선택해 주세요.');
  return activity;
}

export async function GET(request:Request) {
  try {
    const user=await student(), url=new URL(request.url);
    if(url.searchParams.has('recordingId')) {
      const id=uuid.parse(url.searchParams.get('recordingId'));
      const [asset]=await query('select * from quiz_recordings where id=$1 and student_id=$2',[id,user.id]);
      if(!asset)throw new ApiError(404,'녹음을 찾을 수 없어요.');
      let bytes=asset.data as Buffer;
      if(asset.metadata.provider==='supabase') {
        return recordingRedirect(asset.metadata.bucket,asset.metadata.path);
      }
      const headers={'Content-Type':asset.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'};
      const range=request.headers.get('range');
      if(range) {
        const match=/^bytes=(\d*)-(\d*)$/.exec(range);
        if(!match||!match[1]&&!match[2])return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${bytes.length}`}});
        const start=match[1]?Number(match[1]):Math.max(0,bytes.length-Number(match[2]));
        const end=match[1]&&match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;
        if(start>end||start>=bytes.length)return new Response(null,{status:416,headers:{...headers,'Content-Range':`bytes */${bytes.length}`}});
        return new Response(new Uint8Array(bytes.subarray(start,end+1)),{status:206,headers:{...headers,'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':String(end-start+1)}});
      }
      return new Response(new Uint8Array(bytes),{headers:{...headers,'Content-Length':String(bytes.length)}});
    }
    if(url.searchParams.has('sessionId')) {
      const id=uuid.parse(url.searchParams.get('sessionId'));
      const [row]=await query('select * from quiz_sessions where id=$1 and student_id=$2',[id,user.id]);
      if(!row)throw new ApiError(404,'퀴즈 기록을 찾을 수 없어요.'); return json(await sessionView(row));
    }
    const sourceType=url.searchParams.has('sourceType')?z.enum(['common','personal']).parse(url.searchParams.get('sourceType')):undefined;
    const general=url.searchParams.get('general')==='1';
    if(url.searchParams.has('general')&&(!general||sourceType!=='common'||url.searchParams.has('targetId')||url.searchParams.has('activityId')||url.searchParams.has('memoryItemId')||url.searchParams.get('mode')==='choice'))throw new ApiError(400,'공통 질문 맛보기는 학교를 지정하지 않은 글·말 연습에서 시작해 주세요.');
    const registeredTarget=general?null:await quizTarget(user.id,url.searchParams.has('targetId')?z.string().min(1).max(160).parse(url.searchParams.get('targetId')):undefined);
    const sourceVersion=sourceType&&url.searchParams.has('sourceVersion')?z.coerce.number().int().min(1).max(100000).parse(url.searchParams.get('sourceVersion')):undefined;
    const personalVersion=sourceType==='personal'?sourceVersion:undefined,commonRevision=sourceType==='common'?sourceVersion:undefined;
    const [{learning,package:pack},common]=await Promise.all([getLearning(user.id,personalVersion),commonInterviewQuestions(user.id,registeredTarget?.id || null,commonRevision)]);
    if(personalVersion&&!pack)throw new ApiError(404,'발행된 자료를 찾을 수 없어요.');
    const {target,targetSnapshotStale}=versionedQuizTarget(learning,registeredTarget,personalVersion);
    const [sessions,history]=await Promise.all([
      query('select id,student_id,mode,state,current_index,jsonb_array_length(items) as total,items,metadata,created_at,updated_at,finished_at from quiz_sessions where student_id=$1 order by updated_at desc,id desc limit 30',[user.id]),
      query('select memory_item_id,rating,data,due_at,created_at from memory_attempts where student_id=$1 order by created_at,id',[user.id]),
    ]);
    const activity=selectedQuizActivity(learning,url.searchParams.get('activityId'));
    const schoolItems=targetSnapshotStale?[]:schoolQuizItems(common,target,{activity,sourceRefs:learning.source_refs});
    const pools={choice:general?[]:scopedPersonalItems(learning,'choice',target),answer:[] as SessionItem[],oral:[] as SessionItem[]};
    const requestedMode=url.searchParams.has('mode')?mode.parse(url.searchParams.get('mode')):null;
    const today=selectQuizItems(pools.choice,history);
    let requested:any=null;
    const memoryItemId=url.searchParams.get('memoryItemId'),questionId=url.searchParams.get('questionId'),activityId=url.searchParams.get('activityId');
    const all=[...pools.choice,...pools.answer];
    const current=all.find(item=>memoryItemId?item.id===memoryItemId:questionId?item.question_id===questionId:activityId?item.activity_ids.includes(activityId):false);
    if(current)requested={item:publicItem(current),available:true};
    else if(memoryItemId||questionId) {
      const [old]=await query("select x.item,s.content_version,s.id as session_id from quiz_sessions s cross join lateral jsonb_array_elements(s.items) x(item) where s.student_id=$1 and ($4::int is null or s.content_version=$4) and (($2::text is not null and x.item->>'id'=$2) or ($3::text is not null and x.item->>'question_id'=$3)) order by s.created_at desc limit 1",[user.id,memoryItemId,questionId,personalVersion || null]);
      if(old) { const mapped=mapSavedQuizItem(old.item,all.filter(item=>sameSchoolQuizSource(old.item,item)));requested={item:publicItem(old.item),available:!!mapped,mappedItemId:mapped?.id,contentVersion:old.content_version,sessionId:old.session_id,reason:mapped?'같은 지원처와 출처의 질문으로 이어갈 수 있어요.':'현재 지원처에 같은 연습 항목이 없어요. 저장 당시 질문과 답변은 기록에서 볼 수 있어요.'}; }
    }
    const recommendationQuery=new URLSearchParams({focus:'today',...(target?{targetId:target.id}:{}),...(general?{general:'1'}:{}),...(sourceType?{sourceType}:{}),...(sourceVersion?{sourceVersion:String(sourceVersion)}:{})});
    return json({contentVersion:pack?.active_version || 0,sourceType:sourceType || null,sourceVersion:sourceVersion || null,targetSnapshotStale,library:{choice:pools.choice.map(publicItem),answer:pools.answer.map(publicItem),oral:pools.oral.map(publicItem)},target:schoolQuizTargetIdentity(target),sessions:sessions.map(row=>{const {items,...rest}=sessionLabel(row);return rest;}),requested,recommendation:{count:today.items.length,items:today.items.map(publicItem),wrong:today.wrong,due:today.due,unseen:today.unseen,reason:today.reason,href:'/quiz?'+recommendationQuery.toString()}});
  }catch(error){return failure(error);}
}

function recordingMime(file:File,bytes:Buffer) {
  const mime=file.type.split(';')[0],head=bytes.subarray(0,12);
  const valid=mime==='audio/webm'?head.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))
    :mime==='audio/mp4'?head.subarray(4,8).toString()==='ftyp'
    :['audio/wav','audio/x-wav'].includes(mime)?head.subarray(0,4).toString()==='RIFF'&&head.subarray(8,12).toString()==='WAVE'
    :mime==='audio/ogg'?head.subarray(0,4).toString()==='OggS':false;
  if(!valid)throw new ApiError(415,'녹음 파일 형식을 확인해 주세요.'); return mime;
}
export async function POST(request:Request) {
  try {
    checkOrigin(request); const user=await student();
    if(request.headers.get('content-type')?.includes('multipart/form-data') || request.headers.get('x-recording-upload')==='complete') {
      if(Number(request.headers.get('content-length')||0)>10*1024*1024+65536)throw new ApiError(413,'녹음은 10MB까지 저장할 수 있어요.');
      const {form,files:uploadedFiles}=await recordingForm(request,user.id,'quiz'),file=form.get('recording');
      if(!(file instanceof File)||!file.size)throw new ApiError(400,'녹음 파일을 선택해 주세요.');
      if(file.size>10*1024*1024)throw new ApiError(413,'녹음은 10MB까지 저장할 수 있어요.');
      if(form.get('consent')!=='true')throw new ApiError(400,'비공개 녹음 저장에 동의해 주세요.');
      const consentPolicyVersion=z.literal(PRIVACY_POLICY_VERSION).optional().parse(form.get('policyVersion')??undefined);
      const sessionId=uuid.parse(form.get('sessionId')),itemIndex=z.coerce.number().int().min(0).parse(form.get('itemIndex'));
      const durationMs=z.coerce.number().int().min(1).max(180_000).parse(form.get('durationMs'));
      const rawTelemetry=form.get('speechTelemetry');let speechTelemetry=null;
      if(rawTelemetry!==null) {
        if(typeof rawTelemetry!=='string'||rawTelemetry.length>65_536)throw new ApiError(400,'녹음 측정 정보를 확인해 주세요.');
        let parsed:unknown;try{parsed=JSON.parse(rawTelemetry);}catch{throw new ApiError(400,'녹음 측정 정보를 확인해 주세요.');}
        speechTelemetry=validateSpeechTelemetry(parsed);
        if(!speechTelemetry||Math.abs(speechTelemetry.durationMs-durationMs)>500)throw new ApiError(400,'녹음 시간과 측정 정보가 맞지 않아요.');
      }
      const bytes=Buffer.from(await file.arrayBuffer()),mime=recordingMime(file,bytes),digest=createHash('sha256').update(bytes).digest('hex');
      const saved=await transaction(async db=>{
        const [s]=(await db.query('select * from quiz_sessions where id=$1 and student_id=$2 for update',[sessionId,user.id])).rows;
        if(!s)throw new ApiError(404,'퀴즈 기록을 찾을 수 없어요.');
        if(s.state!=='active'||s.current_index!==itemIndex||s.mode==='choice')throw new ApiError(409,'현재 답변의 녹음을 저장해 주세요.');
        const [old]=(await db.query("select id,item_index,mime,duration_ms from quiz_recordings where session_id=$1 and item_index=$2 and metadata->>'digest'=$3",[sessionId,itemIndex,digest])).rows;
        if(old)return old;
        const id=randomUUID(),metadata:any={provider:'postgresql',digest,consentAt:new Date().toISOString(),...(consentPolicyVersion?{consentPolicyVersion,consentPolicyPath:'/privacy'}:{}),size:bytes.length,speechTelemetry,speechAnalysis:analyzeSpeech({telemetry:speechTelemetry,transcript:null,durationMs})}; let dbBytes=bytes;
        const uploaded=uploadedFiles.find(file=>file.field==='recording');
        if(uploaded) {
          metadata.provider='supabase';metadata.bucket=uploaded.bucket;metadata.path=uploaded.path;dbBytes=Buffer.alloc(0);
        }
        return (await db.query('insert into quiz_recordings(id,session_id,student_id,item_index,data,mime,duration_ms,metadata) values($1,$2,$3,$4,$5,$6,$7,$8) returning id,item_index,mime,duration_ms',[id,sessionId,user.id,itemIndex,dbBytes,mime,durationMs,JSON.stringify(metadata)])).rows[0];
      });
      return json({recording:{...saved,url:`/api/quiz?recordingId=${saved.id}`}});
    }
    const raw=await request.json(),trainingPlanId=uuid.optional().parse(raw.trainingPlanId);
    const input=z.object({action:z.enum(['create','start','pause','draft','answer','hint','assist','end']),sessionId:uuid.optional(),targetId:z.string().min(1).max(160).nullish(),activityId:z.string().min(1).max(160).nullish(),sourceType:z.enum(['common','personal']).optional(),sourceVersion:z.number().int().min(1).max(100000).optional(),mode:mode.optional(),focus:z.enum(['today','free']).optional(),timed:z.boolean().optional(),itemIds:z.array(z.string().min(1).max(160)).min(1).max(30).optional(),itemIndex:z.number().int().min(0).optional(),response:z.string().max(10_000).optional(),selectedOptionId:z.string().max(160).nullable().optional(),timedOut:z.boolean().optional(),rating:z.enum(['again','hard','good','easy']).optional(),recallStatus:z.enum(['remembered','uncertain','needs_confirmation','unchecked']).optional(),helpKind:z.enum(['evidence','video','writing']).optional(),hintUsed:z.boolean().optional(),recordingId:uuid.optional(),responseMode:z.enum(['text','voice']).optional(),requestId:uuid.optional()}).parse(raw);
    if(input.action==='create') {
      if(input.mode&&input.mode!=='choice')throw new ApiError(400,'퀴즈는 정답이 있는 4지선다로 진행해요. 글쓰기·말하기는 답변 연습에서 시작해 주세요.');
      if(input.timed===false)throw new ApiError(400,'퀴즈는 문항당 10초로 진행해요.');
      const selectedMode=input.mode||'choice',registeredTarget=await quizTarget(user.id,input.targetId),personalVersion=input.sourceType==='personal'?input.sourceVersion:undefined;
      const [{learning,package:pack},common]=await Promise.all([getLearning(user.id,personalVersion),selectedMode==='choice'?Promise.resolve([]):commonInterviewQuestions(user.id,registeredTarget?.id || null,input.sourceType==='common'?input.sourceVersion:undefined)]);
      if(personalVersion&&!pack)throw new ApiError(404,'발행된 자료를 찾을 수 없어요.');
      const {target,targetSnapshotStale}=versionedQuizTarget(learning,registeredTarget,personalVersion);
      const activity=selectedQuizActivity(learning,input.activityId);
      const eligible=scopedPersonalItems(learning,'choice',target).filter(item=>!activity||item.activity_ids.includes(activity.id)),contentVersion=pack?.active_version || 0,targetSnapshot=schoolQuizTargetIdentity(target),timed=true,focus=input.focus||'today';
      const row=await transaction(async db=>{
        if(trainingPlanId){
          const {assertTrainingQuizPlan}=await import('@/lib/training-practice-store');await assertTrainingQuizPlan(db,user.id,trainingPlanId,{...input,mode:selectedMode},target);
          const [resumable]=(await db.query("select * from quiz_sessions where student_id=$1 and metadata->>'trainingPlanId'=$2 and state in('ready','paused','active') order by created_at desc,id desc limit 1 for update",[user.id,trainingPlanId])).rows;
          if(resumable)return resumable;
        }
        await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`quiz-create:${user.id}:${selectedMode}:${target?.id || 'general'}`]);
        const history=(await db.query('select memory_item_id,rating,data,due_at,created_at from memory_attempts where student_id=$1 order by created_at,id',[user.id])).rows;
        const selected=selectQuizItems(eligible,history,Date.now(),focus==='today'?6:12);
        const ids=input.itemIds||selected.items.map(m=>m.id),items=ids.map(id=>eligible.find(m=>m.id===id));
        if(!ids.length||new Set(ids).size!==ids.length||items.some(item=>!item))throw new ApiError(400,'현재 지원처의 퀴즈 항목을 선택해 주세요.');
        const key=createHash('sha256').update(JSON.stringify({mode:selectedMode,timed,focus,version:contentVersion,target:targetSnapshot,activityId:activity?.id || null,ids,trainingPlanId:trainingPlanId||null})).digest('hex');
        const [old]=(await db.query("select * from quiz_sessions where student_id=$1 and mode=$2 and current_index=0 and state in ('ready','paused','active') and not exists(select 1 from quiz_responses r where r.session_id=quiz_sessions.id) and content_version=$3 and (mode='choice' and coalesce((metadata->>'timed')::boolean,true) or mode<>'choice' and false)=$4 and (metadata->>'selectionKey'=$5 or ($7::boolean and metadata='{}'::jsonb and (select array_agg(e->>'id' order by ord) from jsonb_array_elements(items) with ordinality x(e,ord))=$6::text[])) order by created_at desc,id desc limit 1",[user.id,selectedMode,contentVersion,timed,key,ids,!target])).rows;
        if(old)return old;
        return (await db.query('insert into quiz_sessions(student_id,mode,content_version,items,metadata) values($1,$2,$3,$4,$5) returning *',[user.id,selectedMode,contentVersion,JSON.stringify(items),JSON.stringify({timed,focus,selectionKey:key,reason:selected.reason,hintIndices:[],assistance_recorded:true,targetId:target?.id || null,targetSnapshot,targetSnapshotStale,activityId:activity?.id || null,...(trainingPlanId?{trainingPlanId,trainingSourceVersion:input.sourceVersion,trainingSourceType:input.sourceType}:{})})])).rows[0];
      });
      return json(await sessionView(row));
    }
    const sessionId=uuid.parse(input.sessionId);
    const result=await transaction(async db=>{
      const [s]=(await db.query('select * from quiz_sessions where id=$1 and student_id=$2 for update',[sessionId,user.id])).rows;
      if(!s)throw new ApiError(404,'퀴즈 기록을 찾을 수 없어요.');
      const item:SessionItem=s.items[s.current_index];
      if(input.action==='end') {
        if(['completed','ended'].includes(s.state))return {row:s};
        const [row]=(await db.query("update quiz_sessions set state='ended',finished_at=now(),deadline_at=null,updated_at=now(),revision=revision+1 where id=$1 returning *",[s.id])).rows;return {row};
      }
      if(input.action==='answer'&&input.itemIndex!==undefined&&input.itemIndex<s.current_index) {
        const [response]=(await db.query('select * from quiz_responses where session_id=$1 and item_index=$2',[s.id,input.itemIndex])).rows;
        if(response&&(response.selected_option_id=== (input.selectedOptionId??null))&&response.response===(input.response||'').trim()&&(response.data?.recording_id||null)===(input.recordingId||null)&&(input.responseMode!=='text'||response.data?.response_mode==='text'))return {row:s,response};
        throw new ApiError(409,'이미 저장된 답변이에요.');
      }
      if(['completed','ended'].includes(s.state)||!item)throw new ApiError(409,'종료된 퀴즈예요.');
      if(input.itemIndex!==undefined&&input.itemIndex!==s.current_index)throw new ApiError(409,'퀴즈 문항이 바뀌었어요.');
      if(input.action==='draft') {
        if(s.mode==='choice')throw new ApiError(400,'선택형 문항에는 답변 초안을 저장할 수 없어요.');
        if(input.itemIndex===undefined)throw new ApiError(400,'저장할 문항을 확인해 주세요.');
        const metadata={...s.metadata,drafts:{...(s.metadata?.drafts||{}),[s.current_index]:{response:input.response||'',updatedAt:new Date().toISOString(),requestId:input.requestId||null}}};
        const [row]=(await db.query('update quiz_sessions set metadata=$2,updated_at=now() where id=$1 returning *',[s.id,JSON.stringify(metadata)])).rows;
        return {row};
      }
      if(input.action==='assist') {
        await recordQuizHelp(user.id,{sessionId:s.id,itemIndex:s.current_index,helpKind:input.helpKind||'evidence',requestId:input.requestId},db);
        const [row]=(await db.query('select * from quiz_sessions where id=$1 and student_id=$2',[s.id,user.id])).rows;
        return {row};
      }
      if(input.action==='hint') {
        if(s.mode==='choice'||!item.modelAnswer)throw new ApiError(404,'발행된 모범답안이 없어요.');
        await recordQuizHelp(user.id,{sessionId:s.id,itemIndex:s.current_index,helpKind:'hint',requestId:input.requestId},db);
        const [row]=(await db.query('select * from quiz_sessions where id=$1 and student_id=$2',[s.id,user.id])).rows;
        const hint=firstSentenceHint(item.modelAnswer);
        // A blur is presentation, not protection: only the permitted first sentence leaves the server.
        return {row,hint:{first:hint.first,rest:hint.rest?'이어지는 답변을 내 말로 떠올려보세요. 이어지는 답변을 내 말로 떠올려보세요.':''}};
      }
      if(input.action==='pause') {
        if(s.state!=='active')return {row:s};
        const isTimed=s.mode==='choice'&&s.metadata?.timed!==false;
        const remaining=isTimed?remainingChoiceMs(s.deadline_at,Date.now()):null;
        const elapsed=isTimed?0:Math.max(0,Date.now()-new Date(s.item_started_at).getTime());
        const [row]=(await db.query("update quiz_sessions set state='paused',deadline_at=null,remaining_ms=$2,item_elapsed_ms=item_elapsed_ms+$3,item_started_at=null,updated_at=now(),revision=revision+1 where id=$1 returning *",[s.id,remaining,elapsed])).rows;return {row};
      }
      if(input.action==='start') {
        if(s.state==='active')return {row:s};
        const ms=s.mode==='choice'&&s.metadata?.timed!==false?(s.remaining_ms??10_000):null;
        const [row]=(await db.query("update quiz_sessions set state='active',deadline_at=$2,remaining_ms=null,item_started_at=now(),updated_at=now(),revision=revision+1 where id=$1 returning *",[s.id,ms===null?null:new Date(Date.now()+ms)])).rows;return {row};
      }
      if(s.state!=='active')throw new ApiError(409,'퀴즈를 시작한 뒤 답해 주세요.');
      const isTimed=s.mode==='choice'&&s.metadata?.timed!==false;
      const timedOut=isTimed&&remainingChoiceMs(s.deadline_at,Date.now())===0;
      if(input.timedOut&&!timedOut)throw new ApiError(409,'아직 답할 시간이 남아 있어요.');
      const selected=timedOut?null:input.selectedOptionId??null,response=s.mode==='choice'?'':(input.response||'').trim();
      if(s.mode==='choice'&&!timedOut&&!item.options?.some(option=>option.id===selected))throw new ApiError(400,'보기 중 하나를 골라주세요.');
      let recording:any=null;
      if(input.recordingId){[recording]=(await db.query('select id,metadata from quiz_recordings where id=$1 and student_id=$2 and session_id=$3 and item_index=$4',[input.recordingId,user.id,s.id,s.current_index])).rows;if(!recording)throw new ApiError(404,'현재 답변의 녹음을 찾을 수 없어요.');}
      if(s.mode!=='choice'&&!response&&!recording)throw new ApiError(400,'답변을 적거나 녹음해 주세요.');
      const textAlternative=s.mode==='oral'&&input.responseMode==='text';
      if(textAlternative&&recording)throw new ApiError(400,'글 답변과 녹음을 함께 제출할 수 없어요.');
      if(s.mode==='oral'&&!recording&&!textAlternative)throw new ApiError(400,'말한 답변을 녹음하거나 글로 답하기를 선택해 주세요.');
      const submittedMode=textAlternative?'answer':s.mode,responseMode=s.mode==='choice'?'choice':recording?'voice':'text';
      const elapsedMs=isTimed?10_000-remainingChoiceMs(s.deadline_at,Date.now()):Math.max(0,Math.min(180_000,s.item_elapsed_ms+Date.now()-new Date(s.item_started_at).getTime()));
      const outcome=quizOutcome(item,submittedMode,response,selected,timedOut);
      const recallState=s.mode==='choice'?null:input.recallStatus||'unchecked';
      const rating=timedOut||outcome===false||recallState==='uncertain'||recallState==='needs_confirmation'?'again':recallState==='unchecked'?'hard':input.rating||'good';
      const help=quizHelpFacts(s,s.current_index);
      const identity=quizPracticeIdentity(item);
      const schoolMetadata={...quizSchoolMetadata(item),target_id:(item as any).target_id || s.metadata?.targetId || null,target_snapshot:(item as any).target_snapshot || s.metadata?.targetSnapshot || null};
      const speechSource=recording&&s.mode==='oral'?snapshotSpeechAnswer(recording.metadata?.transcript,recording.metadata?.displayTranscript,recording.metadata?.transcriptCleanup,response,recording.id):null;
      const speechMetadata=speechSource?{speech_source:speechSource}:{};
      const responseMetadata={response_mode:responseMode,original_mode:s.mode,submitted_mode:submittedMode};
      const hintUsed=help.hint_used,assisted=help.assisted,correctAnswer=s.mode==='choice'?item.options?.find(option=>option.id===item.correct_option_id)?.text:null;
      const [saved]=(await db.query('insert into quiz_responses(session_id,student_id,item_index,memory_item_id,response,selected_option_id,outcome,timed_out,elapsed_ms,hint_used,rating,data) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',[s.id,user.id,s.current_index,item.id,response,selected,outcome,timedOut,elapsedMs,hintUsed,rating,JSON.stringify({question_id:identity.questionId,practice_question_id:identity.questionId,practice_kind:identity.practiceKind,practice_prompt:identity.practicePrompt,linked_question_id:identity.linkedQuestionId,prompt:item.prompt,activity_ids:item.activity_ids,content_version:s.content_version,recording_id:recording?.id||null,correct_answer:correctAnswer,...responseMetadata,...help,recall_state:recallState,requestId:input.requestId||null,model_answer:s.mode==='choice'?null:item.modelAnswer,source_quotes:item.sourceQuotes||[],keywords:item.memory_keywords,...schoolMetadata,...speechMetadata})])).rows;
      const intervals:Record<string,number>={again:600_000,hard:86400_000,good:3*86400_000,easy:7*86400_000},delay=intervals[rating];
      await db.query('insert into memory_attempts(student_id,memory_item_id,rating,data,due_at) values($1,$2,$3,$4,$5)',[user.id,item.id,rating,JSON.stringify({answer:response||selected,question_id:identity.questionId,practice_question_id:identity.questionId,correct:outcome,...help,recall_state:recallState,elapsed_seconds:elapsedMs/1000,content_version:s.content_version,evaluation_method:outcome===null?'self_check':'reviewed_correct_answer',quiz_session_id:s.id,quiz_response_id:saved.id,timed_out:timedOut,recording_id:recording?.id||null,...responseMetadata,...schoolMetadata}),new Date(Date.now()+delay)]);
      const responseText=s.mode==='choice'?item.options?.find(option=>option.id===selected)?.text||'':response;
      await recordStudyEvent(db,user.id,{kind:'quiz_response',sourceId:saved.id,data:{quizSessionId:s.id,memoryItemId:item.id,questionId:identity.questionId,practiceKind:identity.practiceKind,practicePrompt:identity.practicePrompt,linkedQuestionId:identity.linkedQuestionId,activityIds:item.activity_ids,prompt:item.prompt,contentVersion:s.content_version,mode:submittedMode,...responseMetadata,outcome,verified:outcome!==null,rating,hintUsed,...help,recall_state:recallState,correctAnswer,timedOut,elapsedMs,response:responseText,audioId:recording?.id||null,audioUrl:recording?`/api/quiz?recordingId=${recording.id}`:null,...schoolMetadata}});
      const complete=s.current_index+1>=s.items.length;
      const drafts={...(s.metadata?.drafts||{})};delete drafts[s.current_index];
      const [row]=(await db.query("update quiz_sessions set current_index=current_index+1,state=$2,deadline_at=null,remaining_ms=null,item_started_at=null,item_elapsed_ms=0,metadata=$3,finished_at=case when $2='completed' then now() else null end,updated_at=now(),revision=revision+1 where id=$1 returning *",[s.id,complete?'completed':'ready',JSON.stringify({...s.metadata,drafts})])).rows;
      return {row,response:saved};
    });
    return json({...await sessionView(result.row),...('response'in result?{response:result.response}:{}),...('hint'in result?{hint:result.hint}:{})});
  }catch(error){return failure(error);}
}
