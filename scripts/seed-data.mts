import { loadProjectEnv } from './load-env.mjs';
import pg from 'pg';
import { hash } from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';
import { createDemoPack, renderLearningHtml, hashLearningData, validatePair } from '../packages/content-contracts/src/index';
import { createHash } from 'node:crypto';

loadProjectEnv();

export const testAccounts = [
  { id: '10000000-0000-4000-8000-000000000001', email: 'admin@gakja.test', name: '운영 관리자', role: 'admin' },
  { id: '10000000-0000-4000-8000-000000000002', email: 'staff@gakja.test', name: '이지원', role: 'staff' },
  { id: '10000000-0000-4000-8000-000000000003', email: 'harin@gakja.test', name: '김하린', role: 'student', track: 'environment' },
  { id: '10000000-0000-4000-8000-000000000004', email: 'doyun@gakja.test', name: '이도윤', role: 'student', track: 'biology' },
  { id: '10000000-0000-4000-8000-000000000005', email: 'pending@gakja.test', name: '박서연', role: 'student' },
];
if (!process.env.DATABASE_URL) throw new Error('루트 .env.local에 DATABASE_URL을 설정해 주세요.');
const isSupabase = process.argv.includes('--supabase');
if (!isSupabase && !['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('원격 DB 테스터 생성은 seed:supabase를 사용해 주세요.');
const password = process.env.TEST_ACCOUNT_PASSWORD || 'Gakja!2026';
if (isSupabase && password === 'Gakja!2026') throw new Error('원격 테스터 비밀번호는 TEST_ACCOUNT_PASSWORD에 새 값으로 설정해 주세요.');
const passwordHash = await hash(password, 12);
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false });
await client.connect();
try {
  if (isSupabase) {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const existing = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (existing.error) throw existing.error;
    for (const account of testAccounts) {
      const found = existing.data.users.find((u) => u.email === account.email);
      if (found) account.id = found.id;
      else { const result = await supabase.auth.admin.createUser({ email: account.email, password, email_confirm: true, user_metadata: { name: account.name, synthetic_test_account: true } }); if (result.error) throw result.error; account.id = result.data.user.id; }
    }
  }
  await client.query('begin');
  for (const account of testAccounts) await client.query('insert into profiles(id,email,name,role,password_hash) values($1,$2,$3,$4,$5) on conflict(email) do update set name=excluded.name,role=excluded.role,password_hash=excluded.password_hash', [account.id, account.email, account.name, account.role, isSupabase ? null : passwordHash]);
  for (const account of testAccounts.filter((a) => a.role === 'student')) await client.query('insert into staff_assignments(staff_id,student_id) values($1,$2) on conflict do nothing', [testAccounts[1].id, account.id]);
  for (const account of testAccounts.filter((a) => a.track)) {
    const packs = createDemoPack(account.id, account.name, account.track as 'environment' | 'biology');
    const first = packs[0], learning = first.learning_data;
    for (const target of learning.support_targets) await client.query('insert into support_targets(id,student_id,data) values($1,$2,$3) on conflict(id) do nothing', [target.id, account.id, JSON.stringify(target)]);
    await client.query('insert into production_links(id,student_id,data) values($1,$2,$3) on conflict(id) do nothing', [first.production_job_ref, account.id, JSON.stringify({ title: `${account.name} 테스트 교재`, synthetic: true })]);
    validatePair(packs, { studentId: account.id, productionJobRef: first.production_job_ref, registeredTargetIds: learning.support_targets.map((t: any) => t.id) });
    await client.query('insert into content_packages(id,student_id,active_version) values($1,$2,$3) on conflict(id) do nothing', [first.package_id, account.id, first.content_version]);
    await client.query('insert into content_versions(package_id,version,data,learning_hash,status,production_job_ref,created_by,published_by,published_at,review) values($1,$2,$3,$4,\'published\',$5,$6,$6,now(),$7) on conflict(package_id,version) do nothing', [first.package_id, first.content_version, JSON.stringify(learning), hashLearningData(learning), first.production_job_ref, testAccounts[0].id, JSON.stringify({ synthetic: true, checks: ['schema','toc','references','hash_pair','ownership','production_link'], reviewed_by: 'test_seed' })]);
    for (const pack of packs) {
      const html = renderLearningHtml(pack), fileHash = createHash('sha256').update(html).digest('hex');
      await client.query('insert into documents(student_id,package_id,content_version,kind,data,html,file_hash) values($1,$2,$3,$4,$5,$6,$7) on conflict(package_id,content_version,kind) do nothing', [account.id, pack.package_id, pack.content_version, pack.document.kind, JSON.stringify(pack.document), html, fileHash]);
    }
    const q = learning.questions[0];
    const answer = (await client.query('insert into user_answers(student_id,question_id,structure,script) values($1,$2,$3,$4) on conflict(student_id,question_id) do nothing returning *', [account.id, q.id, q.answer_structure.join(' → '), learning.answer_scripts[0]?.text ?? learning.answer_scripts[0]?.sentences?.map((s: any) => s.text).join(' ') ?? ''])).rows[0];
    if (answer) await client.query('insert into answer_revisions(answer_id,revision,structure,script) values($1,$2,$3,$4)', [answer.id, answer.revision, answer.structure, answer.script]);
    if (!(await client.query('select id from notifications where student_id=$1 limit 1', [account.id])).rowCount) await client.query('insert into notifications(student_id,title,body,href) values($1,$2,$3,$4)', [account.id, '가이드북과 암기 핸드북이 도착했어요', '처음 읽을 자료부터 시작해 보세요.', '/materials/guidebook']);
    if (!(await client.query('select id from student_confirmations where student_id=$1 limit 1', [account.id])).rowCount) await client.query('insert into student_confirmations(student_id,entity_id,question,data) values($1,$2,$3,$4)', [account.id, learning.activities[2].id, '활동에서 맡은 역할을 본인 말로 확인해 주세요.', JSON.stringify({ source: 'staff', synthetic: true })]);
  }
  if (!(await client.query('select id from briefings limit 1')).rowCount) {
    await client.query('insert into briefings(title,category,data,status,created_by) values($1,$2,$3,$4,$5)', ['생활 속 데이터로 환경 문제 읽기', '환경 · 데이터', JSON.stringify({ summary: '연습용 토론 자료입니다. 데이터 수집 범위와 측정 방법에 따라 같은 환경 현상도 다른 수치로 나타날 수 있어요.', discussion_question: '환경 데이터를 비교할 때 어떤 조건을 먼저 확인하겠어요?', source_kind: 'synthetic_test_briefing', published_date: null, event_date: null, checked_at: '2026-10-07', synthetic: true, tags: ['데이터 해석','측정 조건','환경'] }), 'published', testAccounts[0].id]);
  }
  await client.query('commit');
  console.log('테스트 계정과 비공개 학습 자료를 생성했어요.');
  for (const account of testAccounts) console.log(`${account.role.padEnd(7)} ${account.email} / ${account.name}`);
} catch (error) { await client.query('rollback'); throw error; } finally { await client.end(); }
