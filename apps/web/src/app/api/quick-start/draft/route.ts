import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {PoolClient} from 'pg';
import {checkOrigin,requireUser} from '@/lib/auth';
import {ApiError,transaction} from '@/lib/db';
import {featureError,requireStudent} from '@/lib/ai';
import {generateQuickStartDraft,QUICK_START_DRAFT_VERSION} from '@/lib/quick-start-ai';
import {recordQuizHelp} from '@/lib/quiz-assistance';
import {schoolQuizTargetIdentity} from '@/lib/school-quiz';
import {schoolLearningIdentityMatches} from '@/lib/school-learning';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
const schema=z.object({sessionId:z.string().uuid(),targetId:z.string().min(1).max(160).nullable(),thoughts:z.string().trim().min(1).max(40000),history:z.array(z.object({question:z.string().max(2000),answer:z.string().trim().min(1).max(40000)}).strict()).default([]),requestId:z.string().uuid(),stream:z.boolean().optional()}).strict();
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store'}});

async function ownedQuestion(db:PoolClient,studentId:string,input:z.infer<typeof schema>){
  const [session]=(await db.query('select * from quiz_sessions where id=$1 and student_id=$2 for update',[input.sessionId,studentId])).rows;
  if(!session)throw new ApiError(404,'공통 질문 기록을 찾을 수 없어요.');
  const item=session.items?.[0];
  if(session.mode!=='answer'||session.items?.length!==1||item?.source_kind!=='common'||typeof item.prompt!=='string')throw new ApiError(400,'첫 공통 질문에서 답변을 정리해 주세요.');
  if(['completed','ended'].includes(session.state)||session.current_index!==0)throw new ApiError(409,'이미 답한 질문이에요. 새 질문 연습에서 다시 시작해 주세요.');
  const targetId=session.metadata?.targetId||null;
  if(targetId!==input.targetId||(item.target_id||null)!==targetId)throw new ApiError(409,'지원 학교가 달라졌어요. 현재 학교의 공통 질문에서 다시 시작해 주세요.');
  if(targetId){
    const [target]=(await db.query("select id,data from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null",[targetId,studentId])).rows;
    const current=target?schoolQuizTargetIdentity({...target.data,id:target.id}):null;
    if(!current||!session.metadata?.targetSnapshot||!schoolLearningIdentityMatches(session.metadata.targetSnapshot,current))throw new ApiError(409,'지원 학교 정보가 바뀌었어요. 현재 공통 질문에서 다시 시작해 주세요.');
  }
  return {session,item};
}

export async function GET(request:Request){
 try{
  const user=await requireUser();requireStudent(user);const params=new URL(request.url).searchParams;
  const input=schema.parse({sessionId:params.get('sessionId'),targetId:params.get('targetId')||null,requestId:params.get('requestId'),thoughts:'복구 확인',history:[]});
  return await transaction(async db=>{
   const {session}=await ownedQuestion(db,user.id,input),receipt=(session.metadata?.quickStartDrafts||[]).find((value:any)=>value.requestId===input.requestId);
   if(!receipt)throw new ApiError(404,'이어갈 답변 정리를 찾을 수 없어요.');
   return json(receipt.status==='completed'?{status:receipt.status,proposal:receipt.result,assisted:true}:{status:receipt.status});
  });
 }catch(error){const failure=featureError(error);return json({error:failure.error,code:failure.code},failure.status);}
}
export async function POST(request:Request){
 let requestScope:{studentId:string;input:z.infer<typeof schema>;digest:string}|null=null,partial=false;
 async function failed(){
  if(!requestScope)return;const scope=requestScope;
  try{await transaction(async db=>{
   const [session]=(await db.query('select * from quiz_sessions where id=$1 and student_id=$2 for update',[scope.input.sessionId,scope.studentId])).rows;if(!session)return;
   const receipts:Array<Record<string,any>>=Array.isArray(session.metadata?.quickStartDrafts)?session.metadata.quickStartDrafts:[];
   const next=receipts.map(receipt=>receipt.requestId===scope.input.requestId&&receipt.digest===scope.digest&&receipt.status==='pending'?{...receipt,status:'failed',failedAt:new Date().toISOString()}:receipt);
   await db.query('update quiz_sessions set metadata=$3,updated_at=now() where id=$1 and student_id=$2',[session.id,scope.studentId,JSON.stringify({...session.metadata,quickStartDrafts:next})]);
   if(partial)await recordQuizHelp(scope.studentId,{sessionId:session.id,itemIndex:0,helpKind:'writing',requestId:scope.input.requestId,status:'interrupted'},db);
  });}catch{/* An interrupted preview never becomes a submitted answer. */}
 }
 try{
  checkOrigin(request);const user=await requireUser();requireStudent(user);
  const raw=await request.text();if(raw.length>160000)throw new ApiError(413,'입력한 내용이 커서 나누어 정리해 주세요.');
  let value:unknown;try{value=JSON.parse(raw);}catch{throw new ApiError(400,'적은 내용을 확인해 주세요.');}
  const input=schema.parse(value),digest=createHash('sha256').update(JSON.stringify([QUICK_START_DRAFT_VERSION,input.thoughts,input.history])).digest('hex');
  const reservation=await transaction(async db=>{
   const {session,item}=await ownedQuestion(db,user.id,input),receipts:Array<Record<string,any>>=Array.isArray(session.metadata?.quickStartDrafts)?session.metadata.quickStartDrafts:[];
   const previous=receipts.find(receipt=>receipt.requestId===input.requestId);
   if(previous?.digest&&previous.digest!==digest)throw new ApiError(409,'적은 내용이 달라졌어요. 새로 정리해 주세요.');
   if(previous?.status==='completed')return {cached:previous.result};
   if(receipts.some(receipt=>receipt.status==='pending'&&Date.now()-Date.parse(receipt.startedAt)<90_000))throw new ApiError(409,'답변을 정리하고 있어요. 잠시 뒤 다시 이어가 주세요.');
   const receipt={requestId:input.requestId,digest,status:'pending',startedAt:new Date().toISOString()};
   await db.query('update quiz_sessions set metadata=$3,updated_at=now() where id=$1 and student_id=$2',[session.id,user.id,JSON.stringify({...session.metadata,quickStartDrafts:[...receipts.filter(receipt=>receipt.requestId!==input.requestId),receipt].slice(-24)})]);
   return {question:item.prompt};
  });
  if('cached'in reservation)return json({proposal:reservation.cached,assisted:true,duplicate:true});
  requestScope={studentId:user.id,input,digest};
  async function execute(signal:AbortSignal,onDelta?:(delta:string)=>Promise<void>){
   const proposal=await generateQuickStartDraft(user.id,{sessionId:input.sessionId,question:reservation.question!,thoughts:input.thoughts,history:input.history},{signal,onDelta:onDelta?async(delta)=>{
    if(!partial){await transaction(async db=>{await ownedQuestion(db,user.id,input);await recordQuizHelp(user.id,{sessionId:input.sessionId,itemIndex:0,helpKind:'writing',requestId:input.requestId,status:'partial'},db);});partial=true;}
    await onDelta(delta);
   }:undefined});
   if(signal.aborted)throw new ApiError(499,'정리를 멈췄어요. 적은 내용은 그대로 있어요.');
   await transaction(async db=>{
    const {session}=await ownedQuestion(db,user.id,input),receipts:Array<Record<string,any>>=Array.isArray(session.metadata?.quickStartDrafts)?session.metadata.quickStartDrafts:[];
    const pending=receipts.find(receipt=>receipt.requestId===input.requestId&&receipt.digest===digest&&receipt.status==='pending');
    if(!pending)throw new ApiError(409,'현재 답변 정리 요청을 다시 확인해 주세요.');
    const next=receipts.map(receipt=>receipt===pending?{...receipt,status:'completed',completedAt:new Date().toISOString(),result:proposal}:receipt);
    await db.query('update quiz_sessions set metadata=$3,updated_at=now() where id=$1 and student_id=$2',[session.id,user.id,JSON.stringify({...session.metadata,quickStartDrafts:next})]);
    await recordQuizHelp(user.id,{sessionId:session.id,itemIndex:0,helpKind:'writing',requestId:input.requestId,status:'completed'},db);
   });return proposal;
  }
  if(!input.stream){const proposal=await execute(request.signal);return json({proposal,assisted:true});}
  const abort=new AbortController(),encoder=new TextEncoder();let connected=true;
  const stop=()=>abort.abort();request.signal.addEventListener('abort',stop,{once:true});if(request.signal.aborted)stop();
  return new Response(new ReadableStream({async start(controller){
   const emit=(event:unknown)=>{if(connected)controller.enqueue(encoder.encode('data: '+JSON.stringify(event)+'\n\n'));};
   try{emit({type:'start'});const proposal=await execute(abort.signal,async delta=>emit({type:'delta',delta}));emit({type:'done',proposal,assisted:true});}
   catch(error){await failed();const failure=featureError(error);emit({type:'error',error:failure.error,code:failure.code});}
   finally{request.signal.removeEventListener('abort',stop);if(connected){connected=false;controller.close();}}
  },cancel(){connected=false;abort.abort();}}),{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'private, no-store, no-transform','X-Accel-Buffering':'no'}});
 }catch(error){await failed();const failure=featureError(error);return json({error:failure.error,code:failure.code},failure.status);}
}
