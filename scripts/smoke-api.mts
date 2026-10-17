import { loadProjectEnv, projectRoot } from './load-env.mjs';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDemoPack, renderLearningHtml } from '../packages/content-contracts/src/index';

loadProjectEnv();
let lastServerUrl: string | undefined;
try { lastServerUrl = JSON.parse(readFileSync(join(projectRoot, '.local/server.json'), 'utf8')).url; }
catch { /* An explicit SMOKE_BASE_URL can be used before running the launcher. */ }
const base = process.env.SMOKE_BASE_URL || lastServerUrl || process.env.NEXT_PUBLIC_APP_URL || 'http://127.0.0.1:3000';
if (process.env.AUTH_MODE !== 'local' || !['127.0.0.1','localhost'].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error('API smoke는 로컬 합성 DB에서만 실행해 주세요.');
const jars: Record<string, string> = {};
let checks = 0, studentId: string | null = null, briefingId: string | null = null;
function check(value: unknown, message: string) { assert.ok(value, message); checks++; }
async function request(path: string, actor = '', body?: unknown) {
  const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: base, ...(actor && jars[actor] ? { Cookie: jars[actor] } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const cookies = response.headers.getSetCookie(); if (actor && cookies.length) jars[actor] = cookies.map((cookie) => cookie.split(';')[0]).join('; ');
  return { status: response.status, body: await response.json() };
}
async function action(actor: string, name: string, payload: unknown) { return request('/api/actions', actor, { action: name, payload }); }
async function login(actor: string, email: string, password = process.env.TEST_ACCOUNT_PASSWORD || 'Gakja!2026') { const res = await request('/api/auth', actor, { action: 'login', email, password }); check(res.status === 200, `login ${actor}: ${JSON.stringify(res.body)}`); return res; }
function upload(packs: ReturnType<typeof createDemoPack>, id: string, job: string) {
  const form = new FormData(); form.set('studentId', id); form.set('productionJobRef', job);
  packs.forEach((p) => form.append('files', new File([renderLearningHtml(p)], `${p.document.kind}.html`, { type: 'text/html' })));
  return form;
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  check((await request('/api/bootstrap')).status === 401, 'anonymous bootstrap denied');
  check((await request('/api/v1/activities')).status === 401, 'anonymous v1 denied');
  const authInfo = await request('/api/auth'); check(authInfo.body.authMode === 'local' && authInfo.body.canSetPassword === false, 'auth session state exposed safely');
  check((await request('/api/auth', '', { action: 'reset_password', email: 'harin@gakja.test' })).status === 503, 'local reset cannot report fake mail');
  check((await request('/api/auth', '', { action: 'set_password', password: 'Smoke!Only2026' })).status === 503, 'local callback password flow unavailable');
  check((await request('/api/auth', '', { action: 'accept_invite', email: 'admin@gakja.test', password: process.env.TEST_ACCOUNT_PASSWORD || 'Gakja!2026' })).status === 400, 'unknown invitation action cannot fall through to login');
  const foreign = await fetch(`${base}/api/auth`, { method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', email: 'admin@gakja.test', password: process.env.TEST_ACCOUNT_PASSWORD || 'Gakja!2026' }) }); check(foreign.status === 403, 'foreign origin denied');
  const callback = await fetch(`${base}/auth/callback?next=https://foreign.example`, { redirect: 'manual' }); check(callback.status === 302 && !callback.headers.get('location')?.includes('foreign.example'), 'callback rejects external redirect');
  await login('admin', 'admin@gakja.test'); await login('staff', 'staff@gakja.test'); await login('harin', 'harin@gakja.test');
  check((await request('/api/v1/dashboard', 'staff')).status === 403, 'staff cannot use student v1 data adapter');
  const created = await action('admin', 'create_student', { name: 'API 격리 검증 학생', email: `api-smoke-${Date.now()}@gakja.test`, password: 'Smoke!Only2026' });
  check(created.status === 200, 'create student'); studentId = created.body.student.id;
  await login('student', created.body.student.email, 'Smoke!Only2026');
  const packs = createDemoPack(studentId!, 'API 격리 검증 학생', 'environment');
  for (const target of packs[0].learning_data.support_targets) check((await action('admin', 'support_target', { studentId, id: target.id, data: target })).status === 200, 'register owned target');
  check((await action('admin', 'production_link', { studentId, id: packs[0].production_job_ref, data: { synthetic: true } })).status === 200, 'register owned production link');
  check((await request('/api/imports', 'student', upload(packs, studentId!, packs[0].production_job_ref))).status === 403, 'student cannot import');
  check((await request('/api/imports', 'staff', upload(packs, studentId!, packs[0].production_job_ref))).status === 403, 'unassigned staff cannot import');
  const staged = await request('/api/imports', 'admin', upload(packs, studentId!, packs[0].production_job_ref));
  check(staged.status === 200 && staged.body.status === 'staged', 'valid pair staged');
  check((await request('/api/bootstrap', 'student')).body.package === null, 'staged content hidden from student');
  const duplicate = await request('/api/imports', 'admin', upload(packs, studentId!, packs[0].production_job_ref));
  check(duplicate.body.duplicate === true && duplicate.body.id === staged.body.id, 'same import idempotent');
  check((await action('admin', 'publish', { versionId: staged.body.id })).status === 200, 'publish pair');
  const boot = await request('/api/bootstrap', 'student');
  check(boot.body.learning.activities.length === 8 && boot.body.learning.questions.length === 12 && boot.body.documents.length === 2, 'published content auto linked');
  check((await request('/api/v1/me/dashboard', 'student')).body.user.id === studentId, 'PRD me/dashboard alias');
  check((await request('/api/v1/memory/items', 'student')).body.items.length > 0, 'PRD memory/items list alias');
  check((await request('/api/v1/content', 'student')).body.documents.length === 2, 'v1 structured content alias');
  check((await request(`/api/v1/documents/${boot.body.documents[0].id}`, 'student')).status === 200, 'v1 private structured document');
  check((await request(`/api/v1/documents/${boot.body.documents[0].id}`, 'harin')).status === 404, 'v1 other student document denied');
  check((await request(`/api/v1/activities/${boot.body.learning.activities[0].id}`, 'student')).body.activity.id === boot.body.learning.activities[0].id, 'v1 owned activity detail');
  const qid = boot.body.learning.questions[0].id;
  const answer = await request(`/api/v1/answers/${qid}`, 'student', { structure: '동기 → 역할 → 배운 점', script: '통합 검증 답변', expectedRevision: 0 });
  check(answer.status === 200 && answer.body.answer.revision === 1, 'answer persisted');
  check((await action('student', 'save_answer', { questionId: qid, structure: '', script: '충돌', expectedRevision: 0 })).status === 409, 'optimistic conflict denied');
  check((await action('harin', 'save_answer', { questionId: qid, structure: '', script: '다른 학생 접근', expectedRevision: 0 })).status === 404, 'other student question denied');
  check((await request(`/api/actions?questionId=${qid}`, 'student')).body.versions.length === 1, 'answer revision stored');
  check((await request(`/api/v1/answers/${qid}/versions`, 'student')).body.versions.length === 1, 'v1 answer history delegates owned handler');
  const memory = boot.body.learning.memory_items.find((m: any) => m.kind === 'choice');
  const recall = await action('student', 'memory_attempt', { memoryItemId: memory.id, rating: 'good', answer: memory.correct_option_id, elapsedSeconds: 5 });
  check(recall.status === 200 && recall.body.attempt.data.correct === true && !!recall.body.attempt.due_at, 'memory scheduling + approved objective answer');
  check((await request('/api/v1/memory/attempts', 'student', { memoryItemId: memory.id, rating: 'hard', answer: memory.correct_option_id })).status === 200, 'PRD memory attempts mutation delegates with original authorization');
  const history = await request('/api/bootstrap', 'student'); check(history.body.memoryAttempts.length === 1 && history.body.memoryHistory.length === 2, 'latest review queue separated from full chronological history');
  check((await request('/api/v1/history', 'student')).body.memoryHistory.length === 2, 'v1 owned history alias');
  check((await request('/api/v1/preferences', 'student', { preparationNote: 'API 검증 메모' })).body.preferences.preparationNote === 'API 검증 메모', 'v1 preference mutation');
  check((await request('/api/v1/chat', 'student')).status === 200 && (await request('/api/v1/interviews', 'student')).status === 200, 'v1 chat and interviews delegate verified student handlers');
  check((await action('student', 'preparation_state', { entityId: boot.body.learning.activities[0].id, stage: 'read', completed: true })).status === 200, 'separate self check stage saved');
  check((await action('student', 'preference', { selectedTargetId: `${'10000000-0000-4000-8000-000000000003'}-target-1` })).status === 404, 'other student target rejected');
  const confirmed = await action('student', 'confirmation', { entityId: qid, question: '실제 역할 정정 요청' });
  check(confirmed.status === 200 && confirmed.body.confirmation.state === 'pending', 'correction remains pending');
  check((await request(`/api/v1/confirmations/${confirmed.body.confirmation.id}/respond`, 'student', { response: '검증 학생의 실제 역할 확인', state: 'different' })).status === 200, 'PRD confirmation response path injects owned ID');
  check((await action('staff', 'review', { studentId, confirmationId: confirmed.body.confirmation.id, note: '검토' })).status === 403, 'unassigned staff cannot review');
  check((await action('admin', 'assignments', { studentId, staffId: '10000000-0000-4000-8000-000000000002' })).status === 200, 'staff assigned');
  check((await action('staff', 'review', { studentId, confirmationId: confirmed.body.confirmation.id, note: '다음 제작본 검토', state: 'needs_revision' })).status === 200, 'assigned staff review');
  const next = structuredClone(packs); next.forEach((p) => { p.content_version = 2; p.document.document_revision = 2; });
  const staged2 = await request('/api/imports', 'admin', upload(next, studentId!, next[0].production_job_ref));
  check(staged2.status === 200, 'higher version staged');
  check((await action('admin', 'publish', { versionId: staged2.body.id })).status === 200, 'higher version published');
  const after = await request('/api/bootstrap', 'student');
  check(after.body.answers[0].script === '통합 검증 답변' && after.body.package.active_version === 2, 'student answer preserved during publication');
  check((await action('admin', 'rollback', { versionId: staged.body.id })).status === 200, 'published rollback');
  check((await request('/api/bootstrap', 'student')).body.package.active_version === 1, 'active pointer restored');
  const interview = await request('/api/v1/interviews', 'student', { kind: 'chat', questionCount: 1 });
  check(interview.status === 200 && interview.body.session.id, 'PRD interview creation injects start');
  const interviewId = interview.body.session.id;
  check((await request(`/api/v1/interviews/${interviewId}/turns`, 'student', { answer: '검증 학생으로서 탐구 조건을 직접 정리했습니다.' })).status === 200, 'PRD interview turns injects action and session');
  check((await request(`/api/v1/interviews/${interviewId}/finish`, 'student', {})).status === 200, 'PRD interview finish injects action and session');
  const session = (await client.query('select data from interview_sessions where id=$1', [interviewId])).rows[0];
  const thread = (await client.query('insert into chat_threads(student_id,target_id,content_version,context) values($1,$2,1,$3) returning id', [studentId, session.data.context.targetId, JSON.stringify(session.data.context)])).rows[0];
  check((await request(`/api/v1/chat/threads/${thread.id}/messages`, 'student')).body.thread.id === thread.id, 'PRD chat message GET alias');
  const chatSend = await request(`/api/v1/chat/threads/${thread.id}/messages`, 'student', { threadId: '20000000-0000-4000-8000-000000000001', message: '연결된 자료를 설명해 주세요.' });
  check(chatSend.status === 503, 'PRD chat POST uses path thread ID, then reports missing key truthfully');
  const admin = await request('/api/bootstrap', 'admin');
  check(Array.isArray(admin.body.admin.usage.logs) && Array.isArray(admin.body.admin.staff), 'admin real usage/staff loaded');
  check((await action('admin', 'notification', { studentId, title: '검증 알림', body: '합성 테스트', href: '/my' })).status === 200, 'in-app notification persisted');
  const briefing = await action('admin', 'briefing', { title: 'API 검증 자료', category: '검증', summary: '합성 테스트 자료', status: 'draft' });
  check(briefing.status === 200, 'briefing draft saved'); briefingId = briefing.body.item.id;
  check((await action('admin', 'briefing', { id: briefingId, title: 'API 검증 자료', status: 'published' })).status === 400, 'unsourced briefing publication denied');
  check((await action('admin', 'deactivate', { studentId, active: false })).status === 200, 'account deactivated');
  check((await request('/api/bootstrap', 'student')).status === 401, 'deactivated account session revoked');
  console.log(`API integration: ${checks} checks passed (authorization, imports, publication, version preservation, recall, reviews, revocation).`);
} finally {
  if (briefingId) await client.query('delete from audit_logs where data->>\'id\'=$1', [briefingId]);
  if (briefingId) await client.query('delete from briefings where id=$1', [briefingId]);
  if (studentId) {
    await client.query('begin');
    try {
      for (const table of ['chat_messages','chat_threads','interview_reports','interview_turns','media_assets','interview_sessions','ai_usage_logs','usage_records']) await client.query(`delete from ${table} where student_id=$1`, [studentId]);
      await client.query('delete from answer_revisions where answer_id in(select id from user_answers where student_id=$1)', [studentId]);
      for (const table of ['answer_comments','user_answers','documents','memory_attempts','preparation_states','notifications','student_confirmations','student_preferences','reading_progress','staff_assignments','support_targets']) await client.query(`delete from ${table} where student_id=$1`, [studentId]);
      await client.query('delete from content_versions where package_id in(select id from content_packages where student_id=$1)', [studentId]);
      await client.query('delete from content_packages where student_id=$1', [studentId]);
      await client.query('delete from production_links where student_id=$1', [studentId]);
      await client.query('delete from audit_logs where student_id=$1 or actor_id=$1', [studentId]);
      await client.query('delete from sessions where user_id=$1', [studentId]);
      await client.query('delete from profiles where id=$1', [studentId]);
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
  }
  await client.end();
}
