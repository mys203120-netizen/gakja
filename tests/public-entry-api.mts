// Local-only SSR HTTP checks. Fixtures are generated profile UUIDs and short-lived sessions.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadProjectEnv, projectRoot } from '../scripts/load-env.mjs';

loadProjectEnv();
let stateUrl = '';
try { stateUrl = JSON.parse(readFileSync(join(projectRoot, '.local/server.json'), 'utf8')).url; } catch { /* Explicit local TEST_BASE_URL is supported. */ }
const base = process.env.TEST_BASE_URL || stateUrl || 'http://localhost:3100';
const isLoopback = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
if (process.env.AUTH_MODE !== 'local' || !process.env.DATABASE_URL || !isLoopback(process.env.DATABASE_URL) || !isLoopback(base)) {
  throw new Error('로컬 인증·DB·서버에서만 실행할 수 있어요.');
}
if (!['http:', 'https:'].includes(new URL(base).protocol) || new URL(base).username || new URL(base).password) {
  throw new Error('로컬 웹 서버 주소를 확인해 주세요.');
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const fixture = randomUUID();
type Actor = 'student' | 'staff' | 'admin' | 'expired' | 'inactive';
const actors: Record<Actor, { id: string; role: 'student' | 'staff' | 'admin'; active: boolean; token: string }> = {
  student: { id: randomUUID(), role: 'student', active: true, token: randomBytes(32).toString('hex') },
  staff: { id: randomUUID(), role: 'staff', active: true, token: randomBytes(32).toString('hex') },
  admin: { id: randomUUID(), role: 'admin', active: true, token: randomBytes(32).toString('hex') },
  expired: { id: randomUUID(), role: 'student', active: true, token: randomBytes(32).toString('hex') },
  inactive: { id: randomUUID(), role: 'student', active: false, token: randomBytes(32).toString('hex') },
};
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
let checks = 0;
const cases: string[] = [];
const responses: { label: string; status: number; location: string | null; redirect: string | null }[] = [];
let passed = false;
let fixtureCleanup = false;

function check(value: unknown, label: string) { assert.ok(value, label); checks++; cases.push(label); }
function decodeAttribute(value: string) {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}
// Next may finish a Server Component redirect with an HTTP header, or with a
// meta refresh once a streaming response has already begun. Both are valid.
function redirectTarget(response: Response, html: string): string | null {
  const location = response.headers.get('location');
  if (location) return new URL(location, base).pathname + new URL(location, base).search;
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].find(match => /http-equiv=["']refresh["']/i.test(match[0]));
  if (!meta) return null;
  const content = meta[0].match(/content=["']([^"']*)["']/i)?.[1];
  const target = content?.match(/(?:^|;)\s*url\s*=\s*(.+)$/i)?.[1];
  if (!target) return null;
  const url = new URL(decodeAttribute(target), base);
  return url.origin === new URL(base).origin ? url.pathname + url.search : url.href;
}
async function request(label: string, path: string, token?: string) {
  const response = await fetch(new URL(path, base), {
    redirect: 'manual',
    headers: token ? { Cookie: `gakja_session=${token}` } : {},
    signal: AbortSignal.timeout(60_000),
  });
  const html = await response.text();
  const redirect = redirectTarget(response, html);
  responses.push({ label, status: response.status, location: response.headers.get('location'), redirect });
  return { response, html, redirect };
}
async function expectLogin(label: string, path = '/', token?: string) {
  const { response, html, redirect } = await request(label, path, token);
  check(response.status === 200 && redirect === null, `${label}: direct login without an intermediate redirect`);
  check(/<h1\b[^>]*id="auth-title"[^>]*>나만의 답을 시작해요\.<\/h1>/.test(html), `${label}: login heading is server-rendered`);
  check(/<input\b[^>]*id="auth-email"[^>]*type="email"/.test(html) || /<input\b[^>]*type="email"[^>]*id="auth-email"/.test(html), `${label}: email input is immediately present`);
  check(/<input\b[^>]*id="auth-password"/.test(html) && html.includes('current-password'), `${label}: password input is immediately present`);
  check(html.includes('카카오로 시작') && html.includes('Google로 시작'), `${label}: social login choices are present`);
  check(!html.includes('landing-hero') && !html.includes('나의 답 준비하기'), `${label}: former landing CTA is absent`);
}

await db.connect();
try {
  await expectLogin('guest root');
  await expectLogin('invalid session root', '/', randomBytes(32).toString('hex'));
  await expectLogin('existing login route', '/login');
  for (const [name, actor] of Object.entries(actors)) {
    await db.query('insert into profiles(id,email,name,role,active) values($1,$2,$3,$4,$5)', [actor.id, `entry-${name}-${fixture}@gakja.test`, `합성 첫 화면 검사 ${name}`, actor.role, actor.active]);
    await db.query('insert into sessions(id,user_id,expires_at) values($1,$2,now()+$3::interval)', [digest(actor.token), actor.id, name === 'expired' ? '-1 hour' : '10 minutes']);
  }
  await expectLogin('expired session root', '/', actors.expired.token);
  await expectLogin('inactive account root', '/', actors.inactive.token);

  for (const name of ['student', 'staff', 'admin'] as const) {
    const target = name === 'student' ? '/my' : '/admin';
    const result = await request(`${name} root`, '/', actors[name].token);
    check(result.redirect === target, `${name}: root redirects to ${target}`);
    check([200, 307, 308].includes(result.response.status), `${name}: response supports a Next server redirect`);
    check(!/<input\b[^>]*id="auth-email"/.test(result.html), `${name}: authenticated root does not render login fields`);
    const unsafe = await request(`${name} root with external next`, '/?next=https%3A%2F%2Fforeign.test%2Foutside', actors[name].token);
    check(unsafe.redirect === target, `${name}: an external root next query cannot override the role destination`);
  }
  // Root must remain dynamic across users; an authenticated visit must never
  // make the next guest inherit a cached student/admin redirect.
  await expectLogin('guest root after role visits');
  passed = true;
} finally {
  try {
    await db.query('begin');
    const ids = Object.values(actors).map(actor => actor.id);
    // Generated UUIDs only. Real profiles, learning content, and settings are untouched.
    await db.query('delete from profiles where id=any($1::uuid[]) and email like $2', [ids, `entry-%-${fixture}@gakja.test`]);
    const remaining = (await db.query('select count(*)::int as n from profiles where id=any($1::uuid[])', [ids])).rows[0].n;
    assert.equal(remaining, 0, 'fixture profiles cleaned up');
    const remainingSessions = (await db.query('select count(*)::int as n from sessions where id=any($1::text[])', [Object.values(actors).map(actor => digest(actor.token))])).rows[0].n;
    assert.equal(remainingSessions, 0, 'fixture sessions cleaned up');
    await db.query('commit');
    fixtureCleanup = true;
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    await db.end();
    writeFileSync(join(projectRoot, '.local', 'public-entry-api-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), checks, passed, cases, responses, fixtureCleanup, loginRequests: 0, externalAIRequests: 0 }, null, 2));
  }
}
console.log(`Public entry SSR HTTP/DB checks: ${checks} passed; fixtures cleaned up`);
