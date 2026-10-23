import 'server-only';
import {randomUUID} from 'node:crypto';
import {ApiError,query,transaction} from './db';
import {recognizeStudentDocument,reviewedDocumentPages,type DocumentPage} from './student-document-model';
import {registerStudentDocumentTransaction} from './student-document-service';

/** Expired, unconfirmed files only; callable by maintenance as well as document traffic. */
export async function cleanupStudentDocumentPreviews(){return query('delete from student_document_previews where expires_at<=now() returning id');}
export async function studentDocumentPreview(studentId:string){await cleanupStudentDocumentPreviews();const [row]=await query('select id,filename,pages,status,error_message,created_at,expires_at from student_document_previews where student_id=$1',[studentId]);return row||null;}
export async function stageStudentDocument(studentId:string,input:{filename:string;bytes:Buffer}){
  await cleanupStudentDocumentPreviews();
  return transaction(async db=>{
    await db.query('select id from profiles where id=$1 for update',[studentId]);
    if((await db.query('select id from student_documents where student_id=$1',[studentId])).rowCount)throw new ApiError(409,'확정한 원본은 교체할 수 없어요. 인식문만 정정할 수 있어요.');
    if(!(await db.query("select id from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null",[studentId])).rowCount)throw new ApiError(409,'지원 학교와 학과를 먼저 등록해 주세요.');
    const [active]=(await db.query('select lease_until from student_document_previews where student_id=$1',[studentId])).rows;
    if(active?.lease_until&&new Date(active.lease_until).getTime()>Date.now())throw new ApiError(409,'현재 페이지 인식이 끝나면 다른 PDF를 선택할 수 있어요.');
    await db.query('delete from student_document_previews where student_id=$1',[studentId]);
    return (await db.query('insert into student_document_previews(student_id,filename,bytes) values($1,$2,$3) returning id,status',[studentId,input.filename,input.bytes])).rows[0];
  });
}
export async function confirmStudentDocument(studentId:string,previewId:string,pages:unknown){return transaction(async db=>{
  await db.query('select id from profiles where id=$1 for update',[studentId]);
  const [preview]=(await db.query("select * from student_document_previews where id=$1 and student_id=$2 and expires_at>now() and status='ready' for update",[previewId,studentId])).rows;
  if(!preview)throw new ApiError(409,'확인할 PDF를 다시 불러와 주세요. 인식 중이거나 임시 보관 시간이 지났을 수 있어요.');
  const reviewed=reviewedDocumentPages(preview.pages,pages),recognition=recognizeStudentDocument(reviewed);
  const result=await registerStudentDocumentTransaction(db,studentId,{filename:preview.filename,bytes:preview.bytes,pages:preview.pages,reviewedPages:reviewed,recognition});
  await db.query('delete from student_document_previews where id=$1',[previewId]);return result;
});}
export async function retryStudentDocumentOcr(studentId:string,id:string){
  const [row]=await query("update student_document_previews set pages=(select coalesce(jsonb_agg(case when p->>'ocrStatus'='failed' or (p->>'confidence')::numeric<75 then p||'{\"ocrStatus\":\"pending\"}'::jsonb else p end),'[]') from jsonb_array_elements(pages) p),status='pending',error_message=null where id=$1 and student_id=$2 and expires_at>now() and (lease_until is null or lease_until<now()) returning id,status",[id,studentId]);
  if(!row)throw new ApiError(409,'현재 인식이 끝난 뒤 다시 요청해 주세요.');return row;
}
type PdfAdapter=typeof import('./student-document-pdf');
/** At most three pages per lease; authenticated polling resumes the next batch. */
export async function processStudentDocumentPreview(id:string,adapter?:PdfAdapter){
  const lease=randomUUID();
  const run=await transaction(async db=>{
    await db.query("select pg_advisory_xact_lock(hashtext('student-document-ocr-capacity'))");
    const [{count}]=(await db.query('select count(*)::int as count from student_document_previews where lease_until>now()')).rows;if(count>=2)return null;
    return (await db.query("update student_document_previews set status='processing',lease_token=$2,lease_until=now()+interval '4 minutes' where id=$1 and expires_at>now() and status in ('pending','processing') and (lease_until is null or lease_until<now()) returning *",[id,lease])).rows[0];
  });if(!run)return;
  let worker:Awaited<ReturnType<PdfAdapter['createLocalStudentOcr']>>|undefined;
  try{
    const pdf=adapter||await import('./student-document-pdf');
    const pages:DocumentPage[]=run.pages.length?run.pages:await pdf.extractStudentDocumentPages(run.bytes);
    await query('update student_document_previews set pages=$3 where id=$1 and lease_token=$2',[id,lease,JSON.stringify(pages)]);
    const pending=pages.filter(p=>p.ocrStatus==='pending').slice(0,3);
    if(pending.length){
      try{worker=await pdf.createLocalStudentOcr();}catch{for(const page of pending)Object.assign(page,{ocrStatus:'failed',confidence:null,issue:'인식 도구를 준비하지 못했어요. 원본을 보며 직접 정정하거나 다시 인식해 주세요.'});}
      if(worker)for(const page of pending){Object.assign(page,await pdf.ocrStudentPage(run.bytes,page,worker.recognize));await query('update student_document_previews set pages=$3 where id=$1 and lease_token=$2',[id,lease,JSON.stringify(pages)]);}
    }
    await query('update student_document_previews set pages=$3,status=$4,lease_token=null,lease_until=null,error_message=null where id=$1 and lease_token=$2',[id,lease,JSON.stringify(pages),pages.some(p=>p.ocrStatus==='pending')?'pending':'ready']);
  }catch{
    await query("update student_document_previews set status='failed',lease_token=null,lease_until=null,error_message='PDF를 읽지 못했어요. 암호를 해제하고 열 수 있는 전체 PDF인지 확인해 주세요. 원본은 고정되지 않았어요.' where id=$1 and lease_token=$2",[id,lease]);
  }finally{try{await worker?.terminate();}catch{/* Already terminated after timeout. */}}
}
