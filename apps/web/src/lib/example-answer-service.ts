import 'server-only';
import {randomUUID} from 'node:crypto';
import {ApiError,transaction} from './db';
import {completeEvidenceAnswer,exampleAnswerBasis,exampleRequestSchema,type CompletedExample} from './example-answer-model';
import type {PoolClient} from 'pg';
import {refineExampleAnswer} from './example-answer-provider';

async function scope(db:PoolClient,studentId:string,reportId:string,turnId:string,lock=false){
 const {rows:reports}=await db.query('select r.*,s.data as session_data,s.state as session_state from interview_reports r join interview_sessions s on s.id=r.session_id and s.student_id=r.student_id where r.id=$1 and r.student_id=$2'+(lock?' for update of r,s':''),[reportId,studentId]);
 const report=reports[0];if(!report)throw new ApiError(404,'면접 리포트를 찾을 수 없어요.');
 if(report.session_state!=='completed')throw new ApiError(409,'면접을 모두 마친 뒤 예시답변을 확인해 주세요.');
 const {rows:turns}=await db.query('select * from interview_turns where id=$1 and student_id=$2 and session_id=$3'+(lock?' for update':''),[turnId,studentId,report.session_id]);
 const turn=turns[0],sections=(report.data.sections||[]).filter((value:Record<string,any>)=>value.turnId===turnId);
 if(!turn||turn.data.invalidated===true||sections.length!==1)throw new ApiError(404,'이 리포트의 유효한 질문을 선택해 주세요.');
 const {rows:confirmations}=await db.query('select entity_id,state,data,confirmation_status from student_confirmations where student_id=$1',[studentId]);
 const section={...sections[0],reportId},basis=exampleAnswerBasis({section,turn:turn.data,context:report.session_data.context||{},confirmations});
 const history:CompletedExample[]=(Array.isArray(turn.data.exampleAnswers)?turn.data.exampleAnswers:[]).filter((value:CompletedExample)=>value.reportId===reportId&&value.turnId===turnId);
 return {report,turn,basis,history};
}
export async function getExampleAnswer(studentId:string,reportId:string,turnId:string){return transaction(async db=>{const value=await scope(db,studentId,reportId,turnId);return {basis:value.basis,history:value.history.map(item=>({...item,stale:item.basisHash!==value.basis.hash})),latest:value.history.at(-1)||null};});}
export async function saveExampleAnswer(studentId:string,payload:unknown){
 const parsed=exampleRequestSchema.safeParse(payload);if(!parsed.success)throw new ApiError(400,'확인한 사실과 질문 정보를 선택해 주세요.');const input=parsed.data;
 async function checked(db:PoolClient,lock=false){
  const value=await scope(db,studentId,input.reportId,input.turnId,lock),all:CompletedExample[]=Array.isArray(value.turn.data.exampleAnswers)?value.turn.data.exampleAnswers:[];
  const previous=all.find(item=>item.requestId===input.requestId);
  if(previous){if(previous.reportId!==input.reportId||previous.turnId!==input.turnId||previous.basisHash!==input.basisHash||JSON.stringify(previous.citations.map(item=>item.id))!==JSON.stringify(input.factIds))throw new ApiError(409,'이미 사용한 요청이에요. 현재 사실을 다시 확인해 주세요.');return {value,all,previous};}
  if(value.basis.blocked)throw new ApiError(409,value.basis.reason!);
  if(value.basis.hash!==input.basisHash)throw new ApiError(409,'근거가 바뀌었어요. 새로 불러와 사실을 다시 확인해 주세요.');
  if(value.history.length>=20)throw new ApiError(409,'이 질문의 예시 이력이 20개예요. 저장한 버전을 골라 활용해 주세요.');
  return {value,all,previous:null};
 }
 const leaseToken=randomUUID();
 const preparation=await transaction(async db=>{
  const result=await checked(db);if(result.previous)return result;
  const claimed=await db.query(`insert into interview_example_requests(student_id,request_id,report_id,turn_id,basis_hash,fact_ids,status,lease_token,lease_until) values($1,$2,$3,$4,$5,$6::jsonb,'processing',$7,now()+interval '2 minutes') on conflict(student_id,request_id) do nothing returning request_id`,[studentId,input.requestId,input.reportId,input.turnId,input.basisHash,JSON.stringify(input.factIds),leaseToken]);
  if(!claimed.rows.length){
   const pending=(await db.query('select *,lease_until>now() as active from interview_example_requests where student_id=$1 and request_id=$2 for update',[studentId,input.requestId])).rows[0];
   if(!pending||pending.report_id!==input.reportId||pending.turn_id!==input.turnId||pending.basis_hash!==input.basisHash||JSON.stringify(pending.fact_ids)!==JSON.stringify(input.factIds))throw new ApiError(409,'이미 사용한 요청이에요. 현재 사실을 다시 확인해 주세요.');
   if(pending.status==='completed'||pending.status==='processing'&&pending.active)throw new ApiError(409,'같은 예시를 완성하고 있어요. 잠시 후 새로 불러와 주세요.');
   await db.query("update interview_example_requests set status='processing',lease_token=$3,lease_until=now()+interval '2 minutes',updated_at=now() where student_id=$1 and request_id=$2",[studentId,input.requestId,leaseToken]);
  }
  return result;
 });
 if(preparation.previous)return {example:preparation.previous,duplicate:true};
 try{
 let extract:CompletedExample;try{extract=completeEvidenceAnswer(preparation.value.basis,input,{id:randomUUID(),version:preparation.value.history.length+1,at:new Date().toISOString()});}catch{throw new ApiError(400,'원문과 내 발화에서 확인한 문장을 각각 하나 이상 골라 주세요.');}
 // Provider latency never holds a database transaction. Ownership and facts are checked again on save.
 const refined=await refineExampleAnswer(studentId,extract);
 return await transaction(async db=>{
  const lease=(await db.query("select * from interview_example_requests where student_id=$1 and request_id=$2 and lease_token=$3 and status='processing' for update",[studentId,input.requestId,leaseToken])).rows[0];if(!lease)throw new ApiError(409,'예시 완성 요청이 갱신됐어요. 새로 불러와 주세요.');
  const {value,all,previous}=await checked(db,true);if(previous)return {example:previous,duplicate:true};
  const example={...refined,version:value.history.length+1};
  await db.query("update interview_turns set data=jsonb_set(data,'{exampleAnswers}',$3::jsonb) where id=$1 and student_id=$2",[input.turnId,studentId,JSON.stringify([...all,example])]);
  await db.query("update interview_example_requests set status='completed',updated_at=now() where student_id=$1 and request_id=$2 and lease_token=$3",[studentId,input.requestId,leaseToken]);
  return {example,duplicate:false};
 });
 }catch(error){await transaction(db=>db.query("update interview_example_requests set status='failed',updated_at=now() where student_id=$1 and request_id=$2 and lease_token=$3 and status='processing'",[studentId,input.requestId,leaseToken]));throw error;}
}
