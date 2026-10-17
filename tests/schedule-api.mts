import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadProjectEnv, projectRoot } from '../scripts/load-env.mjs';

loadProjectEnv();
const config = JSON.parse(readFileSync(join(projectRoot, '.local/server.json'), 'utf8'));
const base = process.env.SMOKE_BASE_URL || config.url;
if (process.env.AUTH_MODE !== 'local' || !['127.0.0.1','localhost'].includes(new URL(process.env.DATABASE_URL!).hostname) || !['127.0.0.1','localhost'].includes(new URL(base).hostname)) throw new Error('일정 API 검증은 로컬 합성 DB와 서버에서만 실행해 주세요.');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const cookies: Record<string, string> = {};
const fixture = randomUUID();
let studentId: string | null = null, briefingId: string | null = null, checks = 0;
async function request(actor: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: base, ...(cookies[actor] ? { Cookie: cookies[actor] } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.getSetCookie(); if (set.length) cookies[actor] = set.map(value => value.split(';')[0]).join('; ');
  return { status: res.status, body: await res.json() };
}
async function action(actor: string, name: string, payload: unknown) { return request(actor, '/api/actions', { action: name, payload }); }
function check(value: unknown, message: string) { assert.ok(value, message); checks++; }
await client.connect();
try {
  for (const [actor, email] of [['admin','admin@gakja.test'], ['staff','staff@gakja.test']]) check((await request(actor, '/api/auth', { action: 'login', email, password: process.env.TEST_ACCOUNT_PASSWORD || 'Gakja!2026' })).status === 200, `${actor} login`);
  const email = `schedule-check-${fixture}@gakja.test`, password = 'Schedule!Test2026';
  const created = await action('admin', 'create_student', { email, name: '일정 API 격리 검증 학생', password });
  check(created.status === 200, 'isolated synthetic student created'); studentId = created.body.student.id;
  check((await request('student', '/api/auth', { action: 'login', email, password })).status === 200, 'synthetic student login');
  const id = `schedule-test-${fixture}`;
  const save = (actor: string, schedule: unknown, extra: unknown = {}) => action(actor, 'support_target', { studentId, id, data: { schedule, ...extra as Record<string, any> } });
  const initial = await action('admin', 'support_target', { studentId, id, data: { university: '일정 검증 모의대학교', department: '검증학과', preserved_approved_field: 'keep', interview_date: '2026-11-02', synthetic: true } });
  check(initial.status === 200, 'isolated target created');
  const schedule = { period_start: '2026-11-01', period_end: '2026-11-03', personal_date: '2026-11-02', personal_at: null, location: '검증 장소', required_materials: ['신분증'], source_url: 'https://example.test/synthetic-notice', checked_at: '2026-10-12', status: 'reviewed', review_note: 'API 합성 검증' };
  check((await save('student', schedule)).status === 403, 'student schedule mutation denied');
  check((await save('staff', schedule)).status === 403, 'unassigned staff schedule mutation denied');
  check((await save('admin', { ...schedule, source_url: '' })).status === 400, 'reviewed schedule requires source');
  check((await save('admin', { ...schedule, personal_at: '2026-11-04T09:00' })).status === 400, 'outside-period personal time denied');
  const first = await save('admin', schedule);
  check(first.status === 200 && first.body.target.preserved_approved_field === 'keep', 'approved fields preserved by merge');
  check(first.body.target.schedule.personal_at === null && first.body.target.interview_date === '2026-11-02', 'date-only personal schedule remains date-only');
  const count = async () => Number((await client.query('select count(*)::int as n from notifications where student_id=$1', [studentId])).rows[0].n);
  const firstCount = await count();
  const duplicate = await save('admin', schedule);
  check(duplicate.status === 200 && duplicate.body.scheduleChanged === false && await count() === firstCount, 'identical schedule update does not duplicate notification');
  const reviewed = await save('admin', { ...schedule, checked_at: '2026-10-13', review_note: '검증용 확인일 변경' });
  check(reviewed.status === 200 && reviewed.body.scheduleChanged === false && await count() === firstCount, 'provenance-only edit does not notify');
  const change = await save('admin', { ...schedule, personal_at: '2026-11-02T00:30:00.000Z' });
  check(change.status === 200 && change.body.scheduleChanged === true && change.body.target.schedule.personal_at === '2026-11-02T09:30:00+09:00' && await count() === firstCount + 1, 'actual personal time change normalizes KST and sends exactly one app notification');
  const stale = await action('admin', 'support_target', { studentId, id, expectedRevision: 0, data: { schedule } });
  check(stale.status === 409 && await count() === firstCount + 1, 'stale revision fails without notification');
  const audits = (await client.query("select data from audit_logs where student_id=$1 and action='support_target.update' order by created_at", [studentId])).rows;
  check(audits.some(row => row.data.before?.schedule?.personal_at === null && row.data.after?.schedule?.personal_at === '2026-11-02T09:30:00+09:00' && row.data.schedule_changed === true), 'audit keeps transaction before and after schedule provenance');

  const rich = await action('admin', 'briefing', { title: 'API 격리 검증 브리핑', category: '합성 검증', status: 'draft', sourceURL: 'https://example.test/synthetic-briefing', sourceKind: 'synthetic_test_briefing', publishedDate: '2026-10-11', eventDate: '2026-10-10', checkedAt: '2026-10-12', facts: [{ text: '실제 보도가 아닌 API 검증용 문장입니다.', source_id: 'primary' }], viewpoints: [{ stakeholder: '검증 참여자', viewpoint: '검증용 관점' }], concepts: ['출처 확인'], questions: ['어떤 출처를 확인하겠어요?'], data: { synthetic: true, preserved_editorial_field: 'keep' } });
  check(rich.status === 200 && rich.body.item.data.revision === 1, 'rich draft stores structured editorial fields'); briefingId = rich.body.item.id;
  const update = await action('admin', 'briefing', { id: briefingId, summary: '검증용 요약만 수정', expectedRevision: 1 });
  check(update.status === 200 && update.body.item.data.facts.length === 1 && update.body.item.data.preserved_editorial_field === 'keep' && update.body.item.data.revision === 2, 'partial editorial update preserves rich fields and increments revision');
  check((await action('admin', 'briefing', { id: briefingId, expectedRevision: 1, summary: '오래된 수정' })).status === 409, 'stale editorial revision denied');
  check((await action('admin', 'briefing', { id: briefingId, facts: ['1','2','3','4'] })).status === 400, 'briefing caps facts at three');
  check((await action('admin', 'briefing', { id: briefingId, sourceURL: 'javascript:alert(1)' })).status === 400, 'executable source link denied');
  check((await action('admin', 'briefing', { id: briefingId, eventDate: '2026-02-30' })).status === 400, 'invalid editorial date denied');
  check((await action('admin', 'briefing', { id: briefingId, status: 'published', sourceURL: '' })).status === 400, 'publication missing provenance denied');
  const briefAudit = (await client.query("select data from audit_logs where action='briefing.draft' and data->>'id'=$1 order by created_at", [briefingId])).rows;
  check(briefAudit.length === 2 && briefAudit[1].data.before.data.revision === 1 && briefAudit[1].data.after.data.revision === 2, 'editorial revision audit snapshots persist');
  console.log(`Schedule/editorial API checks passed: ${checks}. No original tester content changed.`);
} finally {
  // Only UUIDs created by this run are removed; seeded accounts are untouched.
  await client.query('begin');
  try {
    if (briefingId) { await client.query("delete from audit_logs where action like 'briefing.%' and data->>'id'=$1",[briefingId]); await client.query('delete from briefings where id=$1',[briefingId]); }
    if (studentId) {
      await client.query('delete from sessions where user_id=$1',[studentId]);
      await client.query('delete from notifications where student_id=$1',[studentId]);
      await client.query('delete from audit_logs where student_id=$1',[studentId]);
      await client.query('delete from support_targets where student_id=$1',[studentId]);
      await client.query('delete from profiles where id=$1',[studentId]);
    }
    await client.query('commit');
  } catch(error) { await client.query('rollback'); throw error; }
  await request('admin', '/api/auth', { action: 'logout' });
  await request('staff', '/api/auth', { action: 'logout' });
  await client.end();
}
