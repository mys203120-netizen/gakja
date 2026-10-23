import {after} from 'next/server';
import {checkOrigin,requireUser} from '@/lib/auth';
import {ApiError,errorResponse,query} from '@/lib/db';
import {DOCUMENT_CONSENT_VERSION,DOCUMENT_MAX_BYTES,DocumentValidationError} from '@/lib/student-document-model';
import {correctStudentDocumentText,retryStudentDocument,runStudentDocumentAnalysis,studentDocumentDetail} from '@/lib/student-document-service';
import {confirmStudentDocument,processStudentDocumentPreview,retryStudentDocumentOcr,stageStudentDocument,studentDocumentPreview} from '@/lib/student-document-preview';
import {z} from 'zod';
export const runtime='nodejs';
export const maxDuration=240;
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
async function student(){const user=await requireUser();if(user.role!=='student')throw new ApiError(403,'학생 계정으로 이용해 주세요.');return user;}
export async function GET(request:Request){try{
  const user=await student(),params=new URL(request.url).searchParams,download=params.get('download');
  if(params.has('page')){
    const page=Number(params.get('page')),previewId=params.get('preview');if(!Number.isInteger(page)||page<1||page>60)throw new ApiError(400,'페이지 번호를 확인해 주세요.');
    if(previewId&&!z.string().uuid().safeParse(previewId).success)throw new ApiError(400,'미리보기 번호를 확인해 주세요.');
    const [doc]=previewId?await query('select bytes from student_document_previews where id=$1 and student_id=$2 and expires_at>now()',[previewId,user.id]):await query('select bytes from student_documents where student_id=$1',[user.id]);
    if(!doc)throw new ApiError(404,'확인할 원본이 없어요.');
    const {renderStudentDocumentPage}=await import('@/lib/student-document-pdf');const image=await renderStudentDocumentPage(doc.bytes,page,1200);
    return new Response(new Uint8Array(image),{headers:{...headers,'Content-Type':'image/png'}});
  }
  if(download==='original'){
    const [doc]=await query('select bytes from student_documents where student_id=$1',[user.id]);if(!doc)throw new ApiError(404,'등록한 원본이 없어요.');
    return new Response(new Uint8Array(doc.bytes),{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="student-record.pdf"'}});
  }
  if(download==='markdown'){
    const [analysis]=await query("select markdown from student_document_analyses where student_id=$1 and status='completed' order by revision desc limit 1",[user.id]);if(!analysis)throw new ApiError(404,'완료한 분석이 없어요.');
    return new Response(analysis.markdown,{headers:{...headers,'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':'attachment; filename="student-record-analysis.md"'}});
  }
  const detail=await studentDocumentDetail(user.id),preview=detail.document?null:await studentDocumentPreview(user.id);
  if(preview&&['pending','processing'].includes(preview.status))after(()=>processStudentDocumentPreview(preview.id));
  return Response.json({...detail,preview},{headers});
}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{
  checkOrigin(request);const user=await student();
  if(Number(request.headers.get('content-length')||0)>DOCUMENT_MAX_BYTES+65_536)throw new ApiError(413,'PDF는 10MB까지 등록할 수 있어요.');
  if((await query('select id from student_documents where student_id=$1',[user.id])).length)throw new ApiError(409,'이미 확정한 원본이 있어요. 같은 원본으로 다시 분석할 수 있어요.');
  const reader=request.body?.getReader();if(!reader)throw new ApiError(400,'생기부 PDF를 선택해 주세요.');
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>DOCUMENT_MAX_BYTES+65_536){await reader.cancel();throw new ApiError(413,'PDF는 10MB까지 등록할 수 있어요.');}chunks.push(value);}}finally{reader.releaseLock();}
  const body=Buffer.concat(chunks),form=await new Response(body,{headers:{'Content-Type':request.headers.get('content-type')||''}}).formData();
  if(form.get('consent')!==DOCUMENT_CONSENT_VERSION)throw new ApiError(400,'원본 고정과 분석 처리를 확인해 주세요.');
  const files=form.getAll('file');if(files.length!==1||!(files[0] instanceof File))throw new ApiError(400,'생기부 PDF 한 파일을 선택해 주세요.');
  const file=files[0];if(!/\.pdf$/i.test(file.name)||file.size===0||file.size>DOCUMENT_MAX_BYTES)throw new ApiError(400,'10MB 이내의 PDF 파일을 선택해 주세요.');
  const bytes=Buffer.from(await file.arrayBuffer());if(bytes.subarray(0,5).toString('ascii')!=='%PDF-')throw new ApiError(422,'PDF 파일 형식을 확인해 주세요.');
  const result=await stageStudentDocument(user.id,{filename:file.name.replace(/[\x00-\x1f/\\]/g,'_').slice(0,200),bytes});
  after(()=>processStudentDocumentPreview(result.id));
  return Response.json(result,{status:201,headers});
}catch(error){return errorResponse(error instanceof DocumentValidationError?new ApiError(422,error.message):error);}}
export async function PATCH(request:Request){try{
  checkOrigin(request);const user=await student();
  // Stream-bound JSON too, including requests without Content-Length.
  const reader=request.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
  if(reader)try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>700_000){await reader.cancel();throw new ApiError(413,'인식문이 너무 길어요. 전체 12만 자까지 확인해 주세요.');}chunks.push(value);}}finally{reader.releaseLock();}
  let body:Record<string,any>={};try{body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};if(!body||typeof body!=='object'||Array.isArray(body))throw Error('INVALID_OBJECT');}catch{throw new ApiError(400,'요청 내용을 확인해 주세요.');}
  let result:Record<string,any>;
  if(body.action==='confirm'){
    if(body.consent!==DOCUMENT_CONSENT_VERSION||!z.string().uuid().safeParse(body.previewId).success)throw new ApiError(400,'원본 고정과 분석 동의를 확인해 주세요.');
    result=await confirmStudentDocument(user.id,body.previewId,body.pages);
  }else if(body.action==='retry_ocr'){
    if(!z.string().uuid().safeParse(body.previewId).success)throw new ApiError(400,'미리보기 번호를 확인해 주세요.');
    result=await retryStudentDocumentOcr(user.id,body.previewId);after(()=>processStudentDocumentPreview(result.id));return Response.json(result,{headers});
  }else if(body.action==='correct_text'){
    const parsed=z.object({expectedRevision:z.number().int().positive(),pages:z.unknown(),reason:z.string().trim().min(1).max(500)}).parse(body);
    return Response.json(await correctStudentDocumentText(user.id,parsed),{headers});
  }else if(!body.action||body.action==='reanalyze')result=await retryStudentDocument(user.id);
  else throw new ApiError(400,'지원하지 않는 요청이에요.');
  if(result.status==='pending')after(()=>runStudentDocumentAnalysis(result.id));
  return Response.json(result,{headers});
}catch(error){return errorResponse(error instanceof DocumentValidationError||error instanceof z.ZodError?new ApiError(422,error instanceof z.ZodError?'모든 페이지의 텍스트와 확인 표시를 점검해 주세요.':error.message):error);}}
