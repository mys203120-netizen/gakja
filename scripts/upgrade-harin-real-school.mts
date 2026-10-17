import{createHash}from'node:crypto';
import{writeFileSync}from'node:fs';
import pg from'pg';
import{loadProjectEnv}from'./load-env.mjs';
import{createDemoPack,hashLearningData,renderLearningHtml,validatePair,type LearningPack,type SupportTarget}from'../packages/content-contracts/src/index';
loadProjectEnv();
if(process.env.AUTH_MODE!=='local'||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Local tester only');
const studentId='10000000-0000-4000-8000-000000000003',targetId='target_42527423-93f5-4e86-a8fa-21625a84f0d3';
const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
try{
 await client.query('begin');
 const [user]=(await client.query("select id,name from profiles where id=$1 and email=$2 and role='student'",[studentId,'harin@gakja.test'])).rows;
 const [pack]=(await client.query('select * from content_packages where student_id=$1 for update',[studentId])).rows;
 const [old]=(await client.query("select v.*,p.data as production_data from content_versions v join production_links p on p.id=v.production_job_ref where v.package_id=$1 and v.version=$2 and v.status='published'",[pack?.id,pack?.active_version])).rows;
 const [row]=(await client.query('select * from support_targets where student_id=$1 and id=$2',[studentId,targetId])).rows;
 if(!user||!old?.review?.synthetic||!old.production_data.synthetic||row?.data.university!=='서울시립대학교'||row.data.major!=='환경공학부')throw Error('Known tester and verified registered target required');
 if(old.data.support_targets.some((t:any)=>t.id===targetId)){await client.query('commit');console.log('Real school already connected');}
 else{
  const originalVersions=(await client.query('select id,data,learning_hash from content_versions where package_id=$1 order by version',[pack.id])).rows;
  const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');const before=digest(originalVersions);
  const learning=structuredClone(old.data),sourceId=studentId+'-src-uos-2027-official';
  const sourceUrl='https://file.uos.ac.kr/upload/admission/2027%ED%95%99%EB%85%84%EB%8F%84%20%EC%88%98%EC%8B%9C%EB%AA%A8%EC%A7%91%20%EC%8B%A0%EC%9E%85%EC%83%9D%20%EB%AA%A8%EC%A7%91%EC%9A%94%EA%B0%95_260831.pdf';
  learning.source_refs.push({id:sourceId,type:'official_admissions',revision:1,url:sourceUrl,location:'2027 수시모집 요강: 모집단위 및 학생부종합Ⅰ 면접평가',quote:'환경공학부 학생부종합Ⅰ(면접형). 면접 약 12분, 면접위원 2인과 지원자 1인. 학업역량 35%, 잠재역량 40%, 사회역량 25%. 평가 비율은 질문 주제 비율과 다름.'});
  const field_sources=Object.fromEntries(['university','campus','department','admission_type','admission_year'].map(key=>[key,{source_ref_ids:[sourceId],verification_status:'verified'}]));
  const target:SupportTarget={id:targetId,student_id:studentId,university:row.data.university,campus:row.data.campus,department:row.data.major,admission_type:row.data.admission_type||row.data.track,admission_year:row.data.admission_year,verification_status:'verified',field_sources,talent_tags:[],evaluation_elements:['학업역량','잠재역량','사회역량'],major_connection:'환경공학 관련 개인 탐구 경험을 지원 전공과 연결해 연습한다. 기존 합성 테스터 경험을 보존하며, 대학의 실제 기출로 주장하지 않는다.',source_ref_ids:[sourceId],knowledge_release_refs:[]};
  learning.support_targets.push(target);
  const fictional=new Set(learning.support_targets.filter((t:any)=>t.synthetic).map((t:any)=>t.id));
  let connectedQuestions=0;
  for(const question of learning.questions)if(question.support_target_ids.some((id:string)=>fictional.has(id))){question.support_target_ids.push(targetId);connectedQuestions++;}
  // Retain synthetic activity-priority decisions; do not invent university-specific rankings or evaluation links.
  const docs=(await client.query('select * from documents where package_id=$1 and content_version=$2',[pack.id,old.version])).rows;
  if(docs.length!==2)throw Error('Two published books required');
  const version=Number((await client.query('select max(version)::int n from content_versions where package_id=$1',[pack.id])).rows[0].n)+1;
  const jobId=studentId+'-real-school-context-v'+version,authored=createDemoPack(studentId,user.name,'environment')[0],learningHash=hashLearningData(learning),at=new Date().toISOString();
  const pair:LearningPack[]=docs.map(doc=>({...authored,package_id:pack.id,content_version:version,production_job_ref:jobId,learning_data:learning,learning_data_hash:learningHash,document:structuredClone(doc.data),criteria_version:learning.criteria_version,knowledge_release_refs:learning.knowledge_release_refs,provenance:{...authored.provenance,production_ref:jobId,review_ref:jobId+'-review',reviewed_at:at,synthetic:true}}));
  const registered=(await client.query('select id from support_targets where student_id=$1',[studentId])).rows.map(t=>t.id);validatePair(pair,{studentId,productionJobRef:jobId,registeredTargetIds:registered});
  await client.query('insert into production_links(id,student_id,data) values($1,$2,$3)',[jobId,studentId,JSON.stringify({synthetic:true,purpose:'tester_real_school_context',based_on_version:old.version,official_source:sourceUrl})]);
  await client.query("insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref,published_at,review) values($1,$2,$3,$4,'published',$5,now(),$6)",[pack.id,version,JSON.stringify(learning),learningHash,jobId,JSON.stringify({synthetic:true,based_on_version:old.version,official_target_verified:true,checks:['schema','references','hash_pair','historical_versions_preserved','no_invented_experience','no_official_question_claim']})]);
  for(const book of pair){const html=renderLearningHtml(book);await client.query('insert into documents(student_id,package_id,content_version,kind,data,html,file_hash) values($1,$2,$3,$4,$5,$6,$7)',[studentId,pack.id,version,book.document.kind,JSON.stringify(book.document),html,digest(html)]);}
  await client.query('update content_packages set active_version=$2 where id=$1',[pack.id,version]);
  await client.query('insert into audit_logs(student_id,action,data) values($1,$2,$3)',[studentId,'demo.real_school_context',JSON.stringify({previous:old.version,version,targetId,connectedQuestions,historical_records_preserved:true})]);
  const previousNow=(await client.query('select id,data,learning_hash from content_versions where package_id=$1 and version<=$2 order by version',[pack.id,old.version])).rows;
  if(before!==digest(previousNow))throw Error('Historical content changed');
  await client.query('commit');
  const evidence={student:'harin@gakja.test',targetId,previousVersion:old.version,version,connectedQuestions,previousVersionsPreserved:originalVersions.length,originalAnswersAndReportsUntouched:true,sourceUrl};
  writeFileSync('.local/harin-real-school-learning.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
 }
}catch(error){await client.query('rollback');throw error;}finally{await client.end();}
