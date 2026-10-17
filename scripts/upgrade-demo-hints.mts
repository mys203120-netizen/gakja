import { createHash } from 'node:crypto';
import pg from 'pg';
import { loadProjectEnv } from './load-env.mjs';
import { createDemoPack, hashLearningData, renderLearningHtml, validatePair, type LearningPack } from '../packages/content-contracts/src/index';
loadProjectEnv();
if(process.env.AUTH_MODE!=='local'||!process.env.DATABASE_URL||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname))throw new Error('로컬 합성 테스터 자료에서만 실행할 수 있어요.');
const accounts=[{id:'10000000-0000-4000-8000-000000000003',email:'harin@gakja.test',track:'environment'},{id:'10000000-0000-4000-8000-000000000004',email:'doyun@gakja.test',track:'biology'}] as const;
const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
try {
  for(const account of accounts) {
    await client.query('begin');
    try {
      const [profile]=(await client.query("select * from profiles where id=$1 and email=$2 and role='student' and active=true",[account.id,account.email])).rows;
      if(!profile)throw new Error('고정된 합성 테스터 계정을 확인해 주세요.');
      const [pack]=(await client.query('select * from content_packages where student_id=$1 for update',[account.id])).rows;
      const [old]=(await client.query("select v.*,p.data as production_data from content_versions v join production_links p on p.id=v.production_job_ref where v.package_id=$1 and v.version=$2 and v.status='published'",[pack?.id,pack?.active_version])).rows;
      if(!old||old.review?.synthetic!==true||old.production_data?.synthetic!==true||old.data.student_context?.student_id!==account.id)throw new Error('검수된 합성 발행 자료에만 새 버전을 추가할 수 있어요.');
      const authored=createDemoPack(account.id,profile.name,account.track)[0],learning=structuredClone(old.data);
      const script=learning.answer_scripts.find((script:any)=>script.id===`${account.id}-answer-1`),expected=authored.learning_data.answer_scripts[0];
      const oldPrefix=account.track==='environment'?'비가 온 뒤 하천 색이 달라지는 이유가 궁금했다. ':'효소가 작용하기 좋은 조건을 직접 확인하고 싶었다. ';
      if(script?.text===expected.text){await client.query('commit');console.log(`${account.email}: first-sentence role hint already current`);continue;}
      if(!script||script.question_id!==expected.question_id||script.verification_status!=='synthetic_reviewed'||script.text!==oldPrefix+expected.text)throw new Error('알려진 합성 답안의 첫 문장만 변경할 수 있어요.');
      const previous=script.text;
      Object.assign(script,expected,{revision:(script.revision||1)+1});
      const docs=(await client.query('select * from documents where package_id=$1 and content_version=$2 order by kind',[pack.id,old.version])).rows;
      if(docs.length!==2)throw new Error('두 교재 원본을 확인해 주세요.');
      const version=Number((await client.query('select max(version)::int as n from content_versions where package_id=$1',[pack.id])).rows[0].n)+1,jobId=`${account.id}-demo-role-hint-v${version}`,at=new Date().toISOString();
      const learningHash=hashLearningData(learning);
      const pair:LearningPack[]=docs.map(doc=>{
        const document=structuredClone(doc.data);
        for(const block of document.blocks||[])for(const key of ['text','content'])if(typeof block[key]==='string'&&block[key].includes(previous))block[key]=block[key].replace(previous,expected.text);
        return {...authored,package_id:pack.id,content_version:version,production_job_ref:jobId,learning_data:learning,learning_data_hash:learningHash,document,criteria_version:learning.criteria_version,knowledge_release_refs:learning.knowledge_release_refs,provenance:{...authored.provenance,production_ref:jobId,review_ref:`${jobId}-synthetic-review`,reviewed_at:at,synthetic:true}};
      });
      const registered=(await client.query('select id from support_targets where student_id=$1',[account.id])).rows.map(t=>t.id);
      validatePair(pair,{studentId:account.id,productionJobRef:jobId,registeredTargetIds:registered});
      await client.query('insert into production_links(id,student_id,data) values($1,$2,$3)',[jobId,account.id,JSON.stringify({title:'합성 테스터 역할 중심 첫 문장 힌트',synthetic:true,purpose:'demo_role_first_hint',based_on_version:old.version})]);
      await client.query("insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref,published_at,review) values($1,$2,$3,$4,'published',$5,now(),$6)",[pack.id,version,JSON.stringify(learning),learningHash,jobId,JSON.stringify({synthetic:true,reviewed_by:'local_demo_fixture_script',based_on_version:old.version,checks:['schema','references','hash_pair','role_first_sentence','no_invented_difficulty']})]);
      for(const book of pair){const html=renderLearningHtml(book);await client.query('insert into documents(student_id,package_id,content_version,kind,data,html,file_hash) values($1,$2,$3,$4,$5,$6,$7)',[account.id,pack.id,version,book.document.kind,JSON.stringify(book.document),html,createHash('sha256').update(html).digest('hex')]);}
      await client.query('update content_packages set active_version=$2 where id=$1',[pack.id,version]);
      await client.query('insert into audit_logs(student_id,action,data) values($1,$2,$3)',[account.id,'demo.role_first_hint',JSON.stringify({synthetic:true,previous_version:old.version,new_version:version,script_id:script.id,original_records_preserved:true})]);
      await client.query('commit');console.log(`${account.email}: new role hint version ${version}; every previous content version and response preserved`);
    }catch(error){await client.query('rollback');throw error;}
  }
}finally{await client.end();}
