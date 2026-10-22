// Manual local HTTP acceptance: node --import tsx tests/support-inquiry-api.mts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { loadProjectEnv } from '../scripts/load-env.mjs';
import { PRIVACY_POLICY_VERSION } from '../apps/web/src/lib/privacy-policy';
loadProjectEnv();
const base = process.env.TEST_BASE_URL || JSON.parse(readFileSync('.local/server.json', 'utf8')).url;
if (process.env.AUTH_MODE !== 'local' || !['localhost','127.0.0.1'].includes(new URL(base).hostname) || !['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname)) throw Error('Local test server/database required.');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const email = `support-acceptance-${randomUUID()}@example.test`;
const requestId = randomUUID();
const payload = { email, type: 'privacy', content: '실제 학생 자료가 아닌 합성 문의입니다.', consent: true, policyVersion: PRIVACY_POLICY_VERSION, requestId };
let count = 0;
const check = (value: unknown) => { assert.ok(value); count++; };
async function call(method: string, body?: unknown, cookie = '', origin = base) {
  const response = await fetch(`${base}/api/support/inquiries`, { method, headers: { Origin: origin, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}
async function login(email: string) {
  const response = await fetch(`${base}/api/auth`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'login', email, password: process.env.TEST_ACCOUNT_PASSWORD }) });
  check(response.ok);
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}
await db.connect();
try {
  check((await call('GET')).status === 401);
  check((await call('PATCH', { id: requestId, status: 'resolved', note: '' })).status === 401);
  check((await call('POST', { ...payload, consent: false })).status === 400);
  check((await call('POST', { ...payload, policyVersion: 'old' })).status === 400);
  check((await call('POST', payload, '', 'https://evil.test')).status === 403);
  const saved = await call('POST', payload);
  check(saved.status === 201 && saved.body.receipt && saved.body.replyChannel === 'email');
  const [row] = (await db.query('select * from support_inquiries where request_id=$1', [requestId])).rows;
  check(row.email === email && row.student_id === null && row.policy_version === PRIVACY_POLICY_VERSION);
  check(saved.body.responseTime === row.response_time_notice);
  check(saved.headers.get('cache-control')?.includes('no-store'));
  const duplicate = await call('POST', payload);
  check(duplicate.status === 200 && duplicate.body.receipt === saved.body.receipt);
  check((await call('POST', { ...payload, content: '서로 다른 내용' })).status === 409);
  check((await db.query('select count(*)::int n from support_inquiries where request_id=$1', [requestId])).rows[0].n === 1);
  for (let i = 0; i < 2; i++) check((await call('POST', { ...payload, requestId: randomUUID() })).status === 201);
  check((await call('POST', { ...payload, requestId: randomUUID() })).status === 429);
  const student = await login('harin@gakja.test');
  check((await call('GET', undefined, student)).status === 403);
  check((await call('PATCH', { id: row.id, status: 'resolved', note: '합성 처리' }, student)).status === 403);
  const admin = await login('admin@gakja.test');
  const list = await call('GET', undefined, admin);
  check(list.status === 200 && list.body.inquiries.some((item: {id:string}) => item.id === row.id));
  check((await call('PATCH', { id: row.id, status: 'in_progress', note: '합성 문의 확인 중' }, admin)).status === 200);
  const [updated] = (await db.query('select status,operator_note from support_inquiries where id=$1', [row.id])).rows;
  check(updated.status === 'in_progress' && updated.operator_note === '합성 문의 확인 중');
  check((await db.query("select id from audit_logs where action='support.inquiry.updated' and data->>'inquiryId'=$1", [row.id])).rowCount === 1);
  console.log(`Support HTTP acceptance: ${count} checks passed; synthetic inquiries cleaned.`);
} finally {
  await db.query("delete from audit_logs where action='support.inquiry.updated' and data->>'inquiryId' in (select id::text from support_inquiries where email=$1)", [email]);
  await db.query('delete from support_inquiries where email=$1', [email]);
  await db.end();
}
