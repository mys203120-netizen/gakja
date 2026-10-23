import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {canonicalJson} from '@gakja/content-contracts';
import {ApiError,query,transaction} from './db';
import {DEFAULT_GUIDELINES,GUIDELINE_KINDS,DOCUMENT_CONSENT_VERSION,documentLearning,validateDocumentAnalysis,reviewedDocumentPages,recognizeStudentDocument,type DocumentPage,type GuidelineSnapshot,type GuidelineKind} from './student-document-model';
import {analyzeStudentDocument,studentDocumentAnalysisConfigured,type DocumentAnalyzer} from './student-document-provider';
import {schoolTalentForTarget} from './school-talent-model';

const snapshot=async(db:PoolClient)=>{const rows=(await db.query("select distinct on(kind) id,kind,version,body,rules from student_document_guidelines where status='published' order by kind,version desc")).rows;return GUIDELINE_KINDS.map(kind=>rows.find(row=>row.kind===kind)||{kind,version:0,body:DEFAULT_GUIDELINES[kind],id:null}) as GuidelineSnapshot[];};
const targetsFor=async(db:PoolClient,studentId:string)=>(await db.query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null order by id for share",[studentId])).rows.map(row=>({...row.data,id:row.id}));
export async function studentDocumentSummary(studentId:string){
  const [row]=await query(`select d.id,d.filename,d.page_count,d.locked_at,
    a.id as analysis_id,a.revision,a.status,a.error_message,a.created_at as analysis_created_at,
    (select max(revision) from student_document_analyses where document_id=d.id and status='completed') as completed_revision
    from student_documents d left join lateral(select id,revision,status,error_message,created_at from student_document_analyses where document_id=d.id order by revision desc limit 1) a on true where d.student_id=$1`,[studentId]);
  return row||null;
}
export async function studentDocumentDetail(studentId:string){
  const document=await studentDocumentSummary(studentId);
  if(!document)return {document:null,analysis:null,pages:[],history:[]};
  const [[original],[analysis],history,textVersions]=await Promise.all([
    query('select pages,recognition from student_documents where id=$1 and student_id=$2',[document.id,studentId]),
    query("select id,revision,text_revision,result,guidelines,targets,completed_at from student_document_analyses where document_id=$1 and student_id=$2 and status='completed' order by revision desc limit 1",[document.id,studentId]),
    query('select id,revision,status,created_at,completed_at,error_message from student_document_analyses where document_id=$1 and student_id=$2 order by revision desc limit 12',[document.id,studentId]),
    query('select revision,pages,reason,created_at from student_document_text_versions where document_id=$1 and student_id=$2 order by revision desc',[document.id,studentId]),
  ]);
  return {document,analysis:analysis||null,pages:textVersions[0]?.pages||original.pages,originalPages:original.pages,textRevision:textVersions[0]?.revision||1,textVersions,recognition:original.recognition,history};
}
async function queueAnalysis(db:PoolClient,studentId:string,documentId:string){
  // Recover a worker interrupted after response. An old lease may never publish over a new run.
  await db.query("update student_document_analyses set status='failed',error_code='INTERRUPTED',error_message='분석 연결이 중단됐어요. 같은 원본으로 다시 분석할 수 있어요.',completed_at=now(),lease_token=null where document_id=$1 and status in ('pending','processing') and created_at<now()-interval '5 minutes'",[documentId]);
  const [running]=(await db.query("select id,status from student_document_analyses where document_id=$1 and status in ('pending','processing')",[documentId])).rows;
  if(running)return running;
  if(!studentDocumentAnalysisConfigured()){
    const [latest]=(await db.query('select id,status,text_revision from student_document_analyses where document_id=$1 order by revision desc limit 1',[documentId])).rows;
    const [text]=(await db.query('select max(revision) as revision from student_document_text_versions where document_id=$1',[documentId])).rows;
    if(latest?.status==='unconfigured'&&latest.text_revision===text.revision)return latest;
  }
  const [{count}]=(await db.query("select count(*)::int as count from student_document_analyses where document_id=$1 and created_at>now()-interval '24 hours' and status<>'unconfigured'",[documentId])).rows;
  if(count>=3)throw new ApiError(429,'분석은 하루 세 번까지 요청할 수 있어요. 기존 결과와 원본은 계속 볼 수 있어요.');
  const targets=await targetsFor(db,studentId);if(!targets.length)throw new ApiError(409,'지원 학교와 학과를 먼저 등록해 주세요.');
  const guidelines=await snapshot(db),status=studentDocumentAnalysisConfigured()?'pending':'unconfigured';
  return (await db.query(`insert into student_document_analyses(document_id,student_id,revision,status,guidelines,targets,error_code,error_message,text_revision)
    values($1,$2,(select coalesce(max(revision),0)+1 from student_document_analyses where document_id=$1),$3,$4,$5,$6,$7,(select max(revision) from student_document_text_versions where document_id=$1)) returning id,status`,
    [documentId,studentId,status,JSON.stringify(guidelines),JSON.stringify(targets),status==='unconfigured'?'NOT_CONFIGURED':null,status==='unconfigured'?'원본은 안전하게 등록됐어요. 자동 분석 연결을 준비 중이에요.':null])).rows[0];
}
type Registration={filename:string;bytes:Buffer;pages:DocumentPage[];recognition:unknown;reviewedPages?:DocumentPage[]};
export async function registerStudentDocumentTransaction(db:PoolClient,studentId:string,input:Registration){
    await db.query('select id from profiles where id=$1 for update',[studentId]);
    if((await db.query('select id from student_documents where student_id=$1',[studentId])).rowCount)throw new ApiError(409,'이미 확정한 생기부가 있어요. 원본을 교체할 수 없으며 같은 원본으로 다시 분석할 수 있어요.');
    if(!(await targetsFor(db,studentId)).length)throw new ApiError(409,'지원 학교와 학과를 먼저 등록해 주세요.');
    const [document]=(await db.query(`insert into student_documents(student_id,filename,mime,bytes,sha256,pages,page_count,recognition,consent_version) values($1,$2,'application/pdf',$3,$4,$5,$6,$7,$8) returning id`,[studentId,input.filename,input.bytes,createHash('sha256').update(input.bytes).digest('hex'),JSON.stringify(input.pages),input.pages.length,JSON.stringify(input.recognition),DOCUMENT_CONSENT_VERSION])).rows;
    await db.query('insert into student_document_text_versions(document_id,student_id,revision,pages,reason) values($1,$2,1,$3,$4)',[document.id,studentId,JSON.stringify(input.reviewedPages||input.pages),input.reviewedPages?'원본 고정 전 학생 인식문 확인':'PDF 추출문']);
    const analysis=await queueAnalysis(db,studentId,document.id);return {documentId:document.id,...analysis};
}
export async function registerStudentDocument(studentId:string,input:Registration){return transaction(db=>registerStudentDocumentTransaction(db,studentId,input));}
export async function correctStudentDocumentText(studentId:string,input:{expectedRevision:number;pages:unknown;reason:string}){return transaction(async db=>{
  await db.query('select id from profiles where id=$1 for update',[studentId]);
  const [doc]=(await db.query('select id,pages from student_documents where student_id=$1',[studentId])).rows;if(!doc)throw new ApiError(404,'등록한 원본이 없어요.');
  const [latest]=(await db.query('select revision from student_document_text_versions where document_id=$1 order by revision desc limit 1',[doc.id])).rows;
  if(latest?.revision!==input.expectedRevision)throw new ApiError(409,'다른 창에서 인식문이 변경됐어요. 새로 불러와 주세요.');
  const [{count}]=(await db.query("select count(*)::int as count from student_document_text_versions where document_id=$1 and created_at>now()-interval '24 hours'",[doc.id])).rows;
  if(count>=10)throw new ApiError(429,'인식문은 하루 열 번까지 저장할 수 있어요. 현재 원본과 확인한 인식문은 보존돼요.');
  const pages=reviewedDocumentPages(doc.pages,input.pages);recognizeStudentDocument(pages);
  if(!input.reason?.trim()||input.reason.length>500)throw new ApiError(400,'정정 이유를 500자 이내로 입력해 주세요.');
  // Invalidate the old lease before saving a new transcription. It cannot publish stale evidence.
  await db.query("update student_document_analyses set status='failed',lease_token=null,completed_at=now(),error_code='TEXT_REVISED',error_message='인식문이 정정됐어요. 새 인식문으로 다시 분석해 주세요.' where document_id=$1 and status in ('pending','processing')",[doc.id]);
  await db.query('insert into student_document_text_versions(document_id,student_id,revision,pages,reason) values($1,$2,$3,$4,$5)',[doc.id,studentId,latest.revision+1,JSON.stringify(pages),input.reason.trim()]);
  return {textRevision:latest.revision+1};
});}
export async function retryStudentDocument(studentId:string){return transaction(async db=>{
  await db.query('select id from profiles where id=$1 for update',[studentId]);
  const [doc]=(await db.query('select id from student_documents where student_id=$1',[studentId])).rows;if(!doc)throw new ApiError(404,'등록한 생기부가 없어요.');
  return queueAnalysis(db,studentId,doc.id);
});}
export async function runStudentDocumentAnalysis(id:string,analyzer:DocumentAnalyzer=analyzeStudentDocument){
  const lease=randomUUID();
  const [run]=await query("update student_document_analyses set status='processing',lease_token=$2,started_at=now() where id=$1 and status='pending' returning *",[id,lease]);if(!run)return;
  try{
    const [doc]=await query('select pages from student_document_text_versions where document_id=$1 and student_id=$2 and revision=$3',[run.document_id,run.student_id,run.text_revision]);if(!doc)throw new Error('MISSING_DOCUMENT');
    const excludedTalentLabels=[...new Set((run.targets as Record<string,any>[]).flatMap(target=>schoolTalentForTarget(target).points.filter(point=>point.definitionKind==='talent').map(point=>point.label)))];
    const generated=await analyzer({pages:doc.pages,targets:run.targets,guidelines:run.guidelines,excludedTalentLabels});
    const result=validateDocumentAnalysis(generated.value,doc.pages,run.targets,excludedTalentLabels);
    const {learning,markdown}=documentLearning({documentId:run.document_id,revision:run.revision,studentId:run.student_id,analysis:result,targets:run.targets,guidelines:run.guidelines,pages:doc.pages,textRevision:run.text_revision});
    await transaction(async db=>{
      await db.query('select id from profiles where id=$1 for update',[run.student_id]);
      const [current]=(await db.query("select id from student_document_analyses where id=$1 and lease_token=$2 and status='processing' for update",[id,lease])).rows;if(!current)return;
      const targets=await targetsFor(db,run.student_id);
      if(canonicalJson(targets)!==canonicalJson(run.targets))throw new Error('TARGETS_CHANGED');
      let [pack]=(await db.query('select id from content_packages where student_id=$1 for update',[run.student_id])).rows;
      if(!pack){[pack]=(await db.query('insert into content_packages(id,student_id) values($1,$2) returning id',['student_record_'+run.student_id,run.student_id])).rows;}
      await db.query('select pg_advisory_xact_lock(hashtext($1))',[pack.id]);
      const productionId='student-document:'+run.document_id;
      await db.query('insert into production_links(id,student_id,data) values($1,$2,$3) on conflict(id) do nothing',[productionId,run.student_id,JSON.stringify({source:'student_document_analysis',documentId:run.document_id,externalApproval:false})]);
      const [{version}]=(await db.query('select coalesce(max(version),0)+1 as version from content_versions where package_id=$1',[pack.id])).rows;
      const [content]=(await db.query(`insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref,created_by,published_at,review)
        values($1,$2,$3,$4,'published',$5,$6,now(),$7) returning id`,[pack.id,version,JSON.stringify(learning),createHash('sha256').update(JSON.stringify(learning)).digest('hex'),productionId,run.student_id,JSON.stringify({source:'student_document_analysis',analysisId:id,checks:['schema','all_pages','verbatim_evidence','target_ownership'],external_approval:null,notice:'AI 분석 제안. 운영자 검수 또는 문서 진위 확인이 아님.'})])).rows;
      await db.query('update content_packages set active_version=$2 where id=$1',[pack.id,version]);
      await db.query("update student_document_analyses set status='completed',result=$3,markdown=$4,model=$5,content_version_id=$6,completed_at=now(),lease_token=null where id=$1 and lease_token=$2",[id,lease,JSON.stringify(result),markdown,generated.model,content.id]);
    });
  }catch(error){
    const changed=error instanceof Error&&error.message==='TARGETS_CHANGED';
    await query("update student_document_analyses set status='failed',error_code=$3,error_message=$4,completed_at=now(),lease_token=null where id=$1 and lease_token=$2 and status='processing'",[id,lease,changed?'TARGETS_CHANGED':'ANALYSIS_FAILED',changed?'지원 정보가 분석 중 변경됐어요. 현재 지원처로 다시 분석해 주세요.':'분석을 완료하지 못했어요. 원본은 보존했으며, 이전 결과가 있으면 그대로 이용할 수 있어요.']);
  }
}
export async function documentGuidelines(){const versions=await query('select id,kind,version,body,rules,status,created_at,published_at from student_document_guidelines order by kind,version desc');return {defaults:DEFAULT_GUIDELINES,versions};}
export async function saveDocumentGuideline(actorId:string,input:{kind:GuidelineKind;body:string;publish:boolean;review?:boolean;rules?:Record<string,unknown>}){return transaction(async db=>{
  await db.query('select pg_advisory_xact_lock(hashtext($1))',['document-guideline:'+input.kind]);
  return (await db.query("insert into student_document_guidelines(kind,version,body,status,created_by,published_at,rules) values($1,(select coalesce(max(version),0)+1 from student_document_guidelines where kind=$1),$2,$3,$4,case when $3='published' then now() end,$5) returning id,version,status",[input.kind,input.body,input.publish?'published':input.review?'review':'draft',actorId,input.rules?JSON.stringify(input.rules):null])).rows[0];
});}
