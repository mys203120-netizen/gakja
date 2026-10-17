import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from './load-env.mjs';
loadProjectEnv();
const { schools } = JSON.parse(readFileSync(new URL('../apps/web/src/data/school-bible.json', import.meta.url), 'utf8'));
const base = [
  ['motivation','지원하려는 전공에 관심을 갖게 된 이유와 대학에서 더 배우고 싶은 내용을 설명해 주세요.','motivation'],
  ['learning','최근 스스로 궁금해서 알아본 주제 하나를 고르고, 무엇을 새롭게 이해했는지 설명해 주세요.','academic'],
  ['collaboration','함께 의견을 맞춰야 할 때 생각이 다르면 어떻게 대화하겠어요?','community'],
  ['evidence','관심 있는 분야의 주장 하나를 고르고, 그 주장을 판단할 때 어떤 근거를 확인하겠어요?','academic'],
  ['growth','잘 풀리지 않는 과제를 다시 시도한다면 어떤 점부터 바꾸겠어요?','growth'],
  ['perspective','관심 있는 사회 문제를 서로 다른 두 관점에서 설명해 주세요.','current_affairs'],
  ['future','대학에서 배우고 싶은 내용이 앞으로의 진로와 어떻게 이어질지 설명해 주세요.','career'],
  ['reflection','관심 있는 개념 하나를 고르고, 처음 듣는 사람에게 예시를 들어 설명해 주세요.','reflection'],
];
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false });
await client.connect();
try {
  await client.query('begin'); let imported = 0;const importedIds=[];
  for (const school of schools) {
    const { source, commonQuestions, ...data } = school;
    await client.query('insert into school_reference_catalog(id,revision,university,status,data,source) values($1,1,$2,$3,$4,$5) on conflict(id,revision) do nothing',[school.id,school.university,school.status,JSON.stringify(data),JSON.stringify(source)]);
    for (let index = 0; index < commonQuestions.length; index++) {
      const q = commonQuestions[index]; const id = `${school.id}_general_${createHash('sha256').update(q.prompt).digest('hex').slice(0,12)}`;importedIds.push(id);
      const qSource = { ...source, pdfPage: q.pdfPage, lineStart: q.line, lineEnd: q.line, scope: 'school_reference_not_track_confirmed', original: true };
      await client.query("insert into common_interview_questions(id,revision,prompt,source_type,status,school_reference_id,data,source) values($1,1,$2,'book_reference','published',$3,$4,$5) on conflict(id,revision) do nothing",[id,q.prompt,school.id,JSON.stringify({ question_types:['general'],grounding_types:['school_reference'],activity_ids:[],source_ref_ids:[`school_source_${school.id}`],answer_elements:[],applicability:'general_practice',requires_personal_fact:false }),JSON.stringify(qSource)]); imported++;
    }
  }
  // Retire earlier extraction candidates without deleting their immutable session provenance.
  await client.query("update common_interview_questions set status='withdrawn' where source_type='book_reference' and source->>'sha256'=$1 and not(id=any($2::text[]))",[schools[0].source.sha256,importedIds]);
  for (const [id,prompt,bucket] of base) await client.query("insert into common_interview_questions(id,revision,prompt,source_type,status,data,source) values($1,1,$2,'general_practice','published',$3,$4) on conflict(id,revision) do nothing",[`common_${id}`,prompt,JSON.stringify({ question_types:['general'],grounding_types:['general_practice'],activity_ids:[],source_ref_ids:[],answer_elements:[],allocation_bucket:bucket,applicability:'general_practice',requires_personal_fact:false }),JSON.stringify({ title:'각자ON 공통 연습',kind:'training',version:1,officialConfirmed:false })]);
  await client.query('commit'); console.log(JSON.stringify({ schools: schools.length, bookReferenceQuestions: imported, generalPracticeQuestions: base.length }));
} catch(error) { await client.query('rollback'); throw error; } finally { await client.end(); }
const talentImport=spawnSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./import-school-talents.mts',import.meta.url))],{stdio:'inherit'});
if(talentImport.status!==0)process.exit(talentImport.status ?? 1);
