import pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { schoolTalentQuestionRows,schoolTalentCoverage } from '../apps/web/src/lib/school-talent-model.ts';
import { loadProjectEnv } from './load-env.mjs';
loadProjectEnv();
const db=new pg.Client({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:true}:false});
const generic=[
  {id:'common_talent_integrity',prompt:'좋은 결과를 빨리 얻는 것과 정직하게 과정을 지키는 일이 충돌한다면 어떤 기준으로 판단하겠어요? 실제 경험이 있다면 연결해 주세요.',point:'책임과 정직'},
  {id:'common_talent_values',prompt:'본인이 중요하게 생각하는 가치 하나는 무엇인가요? 그 가치를 선택한 이유와 대학에서 실천할 방법을 설명해 주세요.',point:'가치관'},
];
await db.connect();
try{
  await db.query('begin');let inserted=0;
  const rows=[...schoolTalentQuestionRows(true),...generic.map(item=>({id:item.id,revision:1,school_reference_id:null,prompt:item.prompt,data:{question_types:['general','talent','community'],grounding_types:['general_practice'],activity_ids:[],source_ref_ids:[],answer_elements:['판단 기준','선택의 이유','경험 또는 실천 계획'],allocation_bucket:'talent',applicability:'general_practice',requires_personal_fact:false},source:{title:'각자ON 가치관 연습',kind:'training',version:1,officialPastQuestion:false,schoolTalentClaim:false}}))];
  for(const row of rows){
    const existing=(await db.query('select prompt,data,source,source_type,school_reference_id from common_interview_questions where id=$1 and revision=$2',[row.id,row.revision])).rows[0];
    // A changed profile is a new revision; never rewrite a question used by a past session.
    if(existing){if(existing.prompt!==row.prompt || !isDeepStrictEqual(existing.data,row.data)||!isDeepStrictEqual(existing.source,row.source)||existing.source_type!=='general_practice'||existing.school_reference_id!==row.school_reference_id)throw new Error(`인재상 자료 ${row.id}의 revision을 올려 주세요.`);continue;}
    await db.query("insert into common_interview_questions(id,revision,prompt,source_type,status,school_reference_id,data,source) values($1,$2,$3,'general_practice','published',$4,$5,$6)",[row.id,row.revision,row.prompt,row.school_reference_id,JSON.stringify(row.data),JSON.stringify(row.source)]);inserted++;
  }
  await db.query('commit');const coverage=schoolTalentCoverage();console.log(JSON.stringify({registeredSchools:coverage.registeredSchools,officialSourceSchools:coverage.officialSourceSchools,needsConfirmationSchools:coverage.needsConfirmationSchools,profileCount:coverage.profiles,questionRows:rows.length,inserted}));
}catch(error){await db.query('rollback');throw error;}finally{await db.end();}
