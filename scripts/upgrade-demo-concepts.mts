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
      if(!old||old.review?.synthetic!==true||old.production_data?.synthetic!==true||old.data.student_context?.student_id!==account.id)throw new Error('검수된 합성 자료만 업그레이드할 수 있어요.');
      const authored=createDemoPack(account.id,profile.name,account.track)[0],learning=structuredClone(old.data),concepts=authored.learning_data.questions.filter(q=>q.question_types.includes('concept'));
      const choices=authored.learning_data.memory_items.filter(item=>item.kind==='choice');
      let changed=0;
      for(const fixture of choices) {
        const item=learning.memory_items.find((item:any)=>item.id===fixture.id),concept=concepts.find(question=>question.id===fixture.question_id);
        if(!item||!concept||item.verification_status!=='synthetic_reviewed'||item.answer_script_id!==null||item.prompt!==fixture.prompt||item.correct_option_id!==fixture.correct_option_id||JSON.stringify(item.options)!==JSON.stringify(fixture.options)||JSON.stringify(item.source_ref_ids)!==JSON.stringify(fixture.source_ref_ids))throw new Error('알려진 검수된 합성 개념 문항만 변경할 수 있어요.');
        const source=learning.source_refs.find((source:any)=>source.id===`${account.id}-src-concept`),expectedSource=authored.learning_data.source_refs.find(source=>source.id===`${account.id}-src-concept`);
        if(!source||(source as any).synthetic!==true||source.quote!==expectedSource?.quote)throw new Error('검수된 합성 개념 근거가 일치하지 않아요.');
        const existing=learning.questions.find((question:any)=>question.id===concept.id);
        if(existing&&JSON.stringify(existing)!==JSON.stringify(concept))throw new Error('기존에 다른 내용의 개념 질문이 있어요.');
        if(item.question_id===concept.id&&JSON.stringify(item.activity_ids)===JSON.stringify(concept.activity_ids)&&existing)continue;
        const legacyNumber=Number(item.id.split('-memory-').at(-1)),legacyId=`${account.id}-q-${legacyNumber}`,legacyQuestion=learning.questions.find((question:any)=>question.id===legacyId);
        if(item.question_id!==legacyId||!legacyQuestion||JSON.stringify(item.activity_ids)!==JSON.stringify(legacyQuestion.activity_ids))throw new Error('알려진 기존 개인 질문 연결만 분리할 수 있어요.');
        item.question_id=fixture.question_id;item.activity_ids=[...fixture.activity_ids];item.category='concept';changed++;
        if(!existing)learning.questions.push(structuredClone(concept));
        const design=authored.learning_data.answer_designs.find(design=>design.question_id===concept.id);
        if(!design)throw new Error('개념 질문의 답변 구조가 필요해요.');
        if(!learning.answer_designs.some((design:any)=>design.question_id===concept.id))learning.answer_designs.push(structuredClone(design));
      }
      if(!changed){await client.query('commit');console.log(`${account.email}: dedicated concept identities already current`);continue;}
      const docs=(await client.query('select * from documents where package_id=$1 and content_version=$2 order by kind',[pack.id,old.version])).rows;
      if(docs.length!==2)throw new Error('두 교재 원본을 확인해 주세요.');
      const version=Number((await client.query('select max(version)::int as n from content_versions where package_id=$1',[pack.id])).rows[0].n)+1,jobId=`${account.id}-demo-concept-identity-v${version}`,at=new Date().toISOString(),learningHash=hashLearningData(learning);
      const pair:LearningPack[]=docs.map(doc=>{
        const document=structuredClone(doc.data),section=document.sections?.[document.kind==='guidebook'?4:4]?.children?.[1]||document.sections?.at(-1)?.children?.[0];
        if(!section)throw new Error('개념 질문을 연결할 교재 절이 없어요.');
        for(const question of concepts)if(!document.blocks.some((block:any)=>block.type==='question_ref'&&block.question_id===question.id))document.blocks.push({id:`${account.id}-${document.kind}-concept-ref-${question.id.split('-concept-q-').at(-1)}`,section_id:section.id,type:'question_ref',question_id:question.id});
        return {...authored,package_id:pack.id,content_version:version,production_job_ref:jobId,learning_data:learning,learning_data_hash:learningHash,document,criteria_version:learning.criteria_version,knowledge_release_refs:learning.knowledge_release_refs,provenance:{...authored.provenance,production_ref:jobId,review_ref:`${jobId}-synthetic-review`,reviewed_at:at,synthetic:true}};
      });
      const registered=(await client.query('select id from support_targets where student_id=$1',[account.id])).rows.map(target=>target.id);
      validatePair(pair,{studentId:account.id,productionJobRef:jobId,registeredTargetIds:registered});
      await client.query('insert into production_links(id,student_id,data) values($1,$2,$3)',[jobId,account.id,JSON.stringify({title:'합성 테스터 개념 질문 분리',synthetic:true,purpose:'demo_concept_identity',based_on_version:old.version})]);
      await client.query("insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref,published_at,review) values($1,$2,$3,$4,'published',$5,now(),$6)",[pack.id,version,JSON.stringify(learning),learningHash,jobId,JSON.stringify({synthetic:true,reviewed_by:'local_demo_fixture_script',based_on_version:old.version,checks:['schema','references','hash_pair','dedicated_concept_question_identity','concept_source_meanings','personal_questions_preserved','no_invented_experience']})]);
      for(const book of pair){const html=renderLearningHtml(book);await client.query('insert into documents(student_id,package_id,content_version,kind,data,html,file_hash) values($1,$2,$3,$4,$5,$6,$7)',[account.id,pack.id,version,book.document.kind,JSON.stringify(book.document),html,createHash('sha256').update(html).digest('hex')]);}
      await client.query('update content_packages set active_version=$2 where id=$1',[pack.id,version]);
      await client.query('insert into audit_logs(student_id,action,data) values($1,$2,$3)',[account.id,'demo.concept_identity',JSON.stringify({synthetic:true,previous_version:old.version,new_version:version,changed_items:changed,new_question_ids:concepts.map(question=>question.id),original_records_preserved:true})]);
      await client.query('commit');console.log(`${account.email}: version ${version}, ${changed} concepts have dedicated question identities; previous content and answers preserved`);
    }catch(error){await client.query('rollback');throw error;}
  }
}finally{await client.end();}
