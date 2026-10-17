import { createHash } from 'node:crypto';
import pg from 'pg';
import { loadProjectEnv } from './load-env.mjs';
import { createDemoPack, hashLearningData, renderLearningHtml, validatePair, type LearningData, type LearningPack } from '../packages/content-contracts/src/index';
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
      if(!old||old.review?.synthetic!==true||old.production_data?.synthetic!==true||old.data.student_context?.student_id!==account.id)throw new Error('발행된 합성 자료에만 새 버전을 추가할 수 있어요.');
      const learning:LearningData=structuredClone(old.data),authored=createDemoPack(account.id,profile.name,account.track)[0].learning_data;
      const known=new Map(authored.memory_items.filter(m=>m.kind==='choice').map(m=>[m.id,m]));let changed=0;
      const legacyPrompt=account.track==='environment'?'흡착을 설명하는 문장을 골라보세요.':'효소의 역할을 설명하는 문장을 골라보세요.';
      const legacyText=account.track==='environment'
        ?['물질이 다른 물질의 표면에 붙는 현상','물질이 다른 물질의 내부로 스며드는 현상','조건과 무관하게 오염 물질을 모두 제거하는 현상','물질이 표면에 붙지 않고 내부로만 스며드는 현상']
        :['반응의 활성화 에너지를 낮추는 생체 촉매','반응이 끝날 때마다 반드시 소모되는 물질','어떤 온도에서도 동일한 속도로 작용하는 물질','활성화 에너지를 높여 반응을 느리게 만드는 물질'];
      const legacyOptions=legacyText.map((text,index)=>({id:['a','b','c','d'][index],text}));
      const legacyKeywords=account.track==='environment'?['흡착','표면']:['효소','활성화 에너지'];
      for(const item of learning.memory_items.filter(m=>m.kind==='choice')) {
        const fixture=known.get(item.id);
        if(!fixture||item.verification_status!=='synthetic_reviewed'||item.correct_option_id!=='a'||item.question_id!==fixture.question_id||item.answer_script_id!==null)throw new Error('합성 원본 문항과 정답이 일치하지 않아요.');
        const sourceId=`${account.id}-src-concept`,source=learning.source_refs.find(s=>s.id===sourceId),expectedSource=authored.source_refs.find(s=>s.id===sourceId);
        if(!item.source_ref_ids.includes(sourceId)||!source||source.type!=='synthetic_learning_material'||(source as any).synthetic!==true||source.quote!==expectedSource?.quote)throw new Error('합성 개념 정의 원본이 일치하지 않아요.');
        if(item.prompt===fixture.prompt&&JSON.stringify(item.options)===JSON.stringify(fixture.options)&&JSON.stringify(item.memory_keywords)===JSON.stringify(fixture.memory_keywords))continue;
        const legacy=item.prompt===legacyPrompt&&JSON.stringify(item.memory_keywords)===JSON.stringify(legacyKeywords)&&(item.options?.length===3||item.options?.length===4)&&JSON.stringify(item.options)===JSON.stringify(legacyOptions.slice(0,item.options?.length));
        if(!legacy)throw new Error('알려진 합성 원본 보기만 새 개념 문항으로 변경할 수 있어요.');
        item.prompt=fixture.prompt;item.options=structuredClone(fixture.options);item.memory_keywords=[...fixture.memory_keywords];changed++;
      }
      if(!changed){await client.query('commit');console.log(`${account.email}: already has three distinct four-choice questions`);continue;}
      const docs=(await client.query('select * from documents where package_id=$1 and content_version=$2 order by kind',[pack.id,old.version])).rows;
      if(docs.length!==2||!docs.some(d=>d.kind==='guidebook')||!docs.some(d=>d.kind==='handbook'))throw new Error('두 교재 원본을 확인해 주세요.');
      const version=Number((await client.query('select max(version)::int as n from content_versions where package_id=$1',[pack.id])).rows[0].n)+1;
      const jobId=`${account.id}-demo-quiz-four-v${version}`,learningHash=hashLearningData(learning),at=new Date().toISOString();
      const base=createDemoPack(account.id,profile.name,account.track)[0];
      const pair:LearningPack[]=docs.map(doc=>({...base,package_id:pack.id,content_version:version,production_job_ref:jobId,learning_data:learning,learning_data_hash:learningHash,document:doc.data,criteria_version:learning.criteria_version,knowledge_release_refs:learning.knowledge_release_refs,provenance:{...base.provenance,production_ref:jobId,review_ref:`${jobId}-synthetic-review`,reviewed_at:at,synthetic:true}}));
      const registered=(await client.query('select id from support_targets where student_id=$1',[account.id])).rows.map(t=>t.id);
      validatePair(pair,{studentId:account.id,productionJobRef:jobId,registeredTargetIds:registered});
      const production={title:'합성 테스터 개념별 4지선다 교재',synthetic:true,purpose:'demo_quiz_distinct_concepts',based_on_version:old.version,authored_fixture:'packages/content-contracts/src/fixtures.ts'};
      await client.query('insert into production_links(id,student_id,data) values($1,$2,$3)',[jobId,account.id,JSON.stringify(production)]);
      const choices=learning.memory_items.filter(m=>m.kind==='choice');
      if(choices.length!==3||new Set(choices.map(m=>m.prompt)).size!==3||choices.some(m=>m.options?.length!==4||new Set(m.options.map(o=>o.text)).size!==4))throw new Error('서로 다른 개념 문항 3개와 보기 4개가 필요해요.');
      const review={synthetic:true,reviewed_by:'local_demo_fixture_script',checks:['schema','toc','references','hash_pair','ownership','three_distinct_concepts','four_distinct_choices','source_definition_correct_key'],based_on_version:old.version,purpose:'demo_quiz_distinct_concepts'};
      await client.query("insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref,published_at,review) values($1,$2,$3,$4,'published',$5,now(),$6)",[pack.id,version,JSON.stringify(learning),learningHash,jobId,JSON.stringify(review)]);
      for(const book of pair) {
        const html=renderLearningHtml(book),fileHash=createHash('sha256').update(html).digest('hex');
        await client.query('insert into documents(student_id,package_id,content_version,kind,data,html,file_hash) values($1,$2,$3,$4,$5,$6,$7)',[account.id,pack.id,version,book.document.kind,JSON.stringify(book.document),html,fileHash]);
      }
      await client.query('update content_packages set active_version=$2 where id=$1',[pack.id,version]);
      await client.query('insert into audit_logs(student_id,action,data) values($1,$2,$3)',[account.id,'demo.quiz_four_options',JSON.stringify({synthetic:true,executor:'local_demo_fixture_script',previous_version:old.version,new_version:version,changed_items:changed})]);
      await client.query('commit');console.log(`${account.email}: version ${old.version} → ${version}, ${changed} synthetic quiz items; old data preserved`);
    }catch(error){await client.query('rollback');throw error;}
  }
}finally{await client.end();}
