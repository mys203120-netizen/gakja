// Local integration: node --import tsx tests/briefing-thought-api.mts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadProjectEnv, projectRoot } from '../scripts/load-env.mjs';

loadProjectEnv();
let lastServerUrl: string | undefined;
try { lastServerUrl = JSON.parse(readFileSync(join(projectRoot, '.local/server.json'), 'utf8')).url; }
catch { /* An explicit test URL is also supported. */ }
const base = process.env.TEST_BASE_URL || process.env.SMOKE_BASE_URL || lastServerUrl || process.env.NEXT_PUBLIC_APP_URL || 'http://127.0.0.1:3000';
let localDatabase = false, localServer = false;
try {
  localDatabase = ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname);
  const server = new URL(base);
  localServer = ['localhost', '127.0.0.1'].includes(server.hostname) && server.protocol === 'http:';
} catch { /* Reject malformed settings without exposing the DB connection string. */ }
if (process.env.AUTH_MODE !== 'local' || !localDatabase || !localServer) throw new Error('브리핑 생각 검사는 로컬 테스터 DB와 HTTP 서버에서만 실행해 주세요.');

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const publishedId = randomUUID(), draftId = randomUUID(), missingId = randomUUID();
const fixtureIds: string[] = [];
const cookies: Record<string, string> = {};
let checks = 0;
function check(value: unknown, label: string): asserts value { assert.ok(value, label); checks++; }
async function request(actor: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, ...(cookies[actor] ? { Cookie: cookies[actor] } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = response.headers.getSetCookie();
  if (set.length) cookies[actor] = set.map(value => value.split(';')[0]).join('; ');
  return { status: response.status, body: await response.json(), headers: response.headers };
}
function get(actor: string, briefingId = publishedId) { return request(actor, `/api/actions?briefingId=${briefingId}`); }
function save(actor: string, content: string, expectedRevision: unknown, briefingId = publishedId, extra: Record<string, unknown> = {}) {
  return request(actor, '/api/actions', { action: 'briefing_thought', payload: { briefingId, content, expectedRevision, ...extra } });
}
await db.connect();
try {
  check(Boolean((await db.query("select to_regclass('briefing_thoughts') as thoughts,to_regclass('briefing_thought_revisions') as revisions")).rows[0]?.thoughts), 'briefing-thought migration is applied');
  for (const [id, status] of [[publishedId, 'published'], [draftId, 'draft']]) {
    await db.query('insert into briefings(id,title,category,data,status) values($1,$2,$3,$4,$5)', [id, '브리핑 생각 API 합성 검증', 'synthetic-test', JSON.stringify({ synthetic: true, fixture: 'briefing-thought-api', summary: '실제 기사나 사용자 자료가 아닌 일회성 API 검사 자료입니다.', source_url: 'https://example.test/briefing-thought-fixture' }), status]);
    fixtureIds.push(id);
  }
  for (const [actor, email] of [['student', 'harin@gakja.test'], ['other', 'doyun@gakja.test'], ['staff', 'staff@gakja.test']]) {
    check((await request(actor, '/api/auth', { action: 'login', email, password: process.env.TEST_ACCOUNT_PASSWORD || 'Gakja!2026' })).status === 200, `${actor} independent login`);
  }
  const studentId = (await db.query('select id from profiles where email=$1', ['harin@gakja.test'])).rows[0].id;
  const otherId = (await db.query('select id from profiles where email=$1', ['doyun@gakja.test'])).rows[0].id;

  check((await get('')).status === 401, 'anonymous read denied');
  check((await save('', '익명 검증', 0)).status === 401, 'anonymous write denied');
  check((await get('staff')).status === 403, 'staff read denied');
  check((await save('staff', '담당자 검증', 0)).status === 403, 'staff write denied');
  for (const id of [draftId, missingId]) {
    check((await get('student', id)).status === 404, 'unpublished or absent briefing read denied');
    check((await save('student', '발행되지 않은 자료 검증', 0, id)).status === 404, 'unpublished or absent briefing write denied');
  }
  const initial = await get('student');
  check(initial.status === 200 && initial.body.thought === null && initial.body.versions.length === 0, 'new fixture has no saved user thought');
  check(initial.headers.get('cache-control')?.includes('private') && initial.headers.get('cache-control')?.includes('no-store'), 'private thought read prevents shared caching');

  const firstContent = '이 문장은 새 합성 브리핑에만 저장한 첫 번째 테스트 생각입니다.';
  const first = await save('student', `  ${firstContent}  `, 0);
  check(first.status === 200 && first.body.thought.content === firstContent && first.body.thought.revision === 1 && first.body.thought.student_id === studentId, 'owner content is trimmed and saved at revision one');
  const firstRead = await get('student');
  check(firstRead.body.thought.id === first.body.thought.id && firstRead.body.versions.length === 1 && firstRead.body.versions[0].content === firstContent, 'owner reads own thought and original revision');
  const duplicate = await save('student', firstContent, 0);
  check(duplicate.status === 200 && duplicate.body.thought.id === first.body.thought.id && duplicate.body.thought.revision === 1, 'same-content retry is idempotent even after first submit');
  check((await get('student')).body.versions.length === 1, 'duplicate does not append a revision');

  const secondContent = '수정한 합성 생각: 근거와 관점을 구분하겠습니다.';
  const second = await save('student', secondContent, 1);
  check(second.status === 200 && second.body.thought.revision === 2 && second.body.thought.id === first.body.thought.id, 'owner update increments same record revision');
  const secondRead = await get('student');
  check(secondRead.body.versions.map((v: any) => v.revision).join(',') === '2,1' && secondRead.body.versions[1].content === firstContent && secondRead.body.versions[0].content === secondContent, 'revision history preserves original and newest content');
  check((await save('student', '오래된 화면의 합성 수정', 1)).status === 409, 'stale revision is rejected');
  check((await get('student')).body.thought.content === secondContent, 'conflict leaves current content unchanged');
  for (const revision of [undefined, -1, 1.5, '2']) check((await save('student', '잘못된 수정 번호', revision)).status === 400, 'invalid expected revision is rejected');
  check((await save('student', ' \n ', 2)).status === 400, 'empty thought is rejected');

  const otherEmpty = await get('other');
  check(otherEmpty.status === 200 && otherEmpty.body.thought === null && otherEmpty.body.versions.length === 0, 'other student cannot see owner content or versions');
  const otherContent = '두 번째 테스터의 분리된 합성 생각입니다.';
  const otherSaved = await save('other', otherContent, 0, publishedId, { studentId, thoughtId: first.body.thought.id });
  check(otherSaved.status === 200 && otherSaved.body.thought.student_id === otherId && otherSaved.body.thought.id !== first.body.thought.id, 'forged owner IDs cannot redirect a write to another student');
  check((await get('student')).body.thought.content === secondContent && (await get('other')).body.versions.every((v: any) => v.content === otherContent), 'students retain separate current content and history');
  check((await save('other', '다른 학생의 수정 번호를 사용한 합성 생각', 2)).status === 409, 'another student revision cannot authorize an update');

  const race = await Promise.all([save('student', '동시 수정 A', 2), save('student', '동시 수정 B', 2)]);
  check(race.map(result => result.status).sort().join(',') === '200,409', 'concurrent writes accept exactly one revision');
  const raceWinner = race.find(result => result.status === 200)!;
  const afterRace = await get('student');
  check(afterRace.body.thought.revision === 3 && afterRace.body.versions.length === 3 && afterRace.body.thought.content === raceWinner.body.thought.content, 'concurrent conflict does not lose or duplicate saved revisions');

  const maximumContent = '가'.repeat(8000);
  const maximum = await save('student', maximumContent, 3);
  check(maximum.status === 200 && maximum.body.thought.content.length === 8000 && maximum.body.thought.revision === 4, 'exact maximum content length is accepted');
  check((await save('student', '가'.repeat(8001), 4)).status === 400, 'over maximum content length is rejected');
  const afterInvalid = await get('student');
  check(afterInvalid.body.thought.content === maximumContent && afterInvalid.body.versions.length === 4, 'length rejection leaves saved thought and revision count unchanged');

  await db.query("update briefings set status='draft' where id=$1", [publishedId]);
  check((await get('student')).status === 404 && (await save('student', '회수된 합성 자료의 수정', 4)).status === 404, 'withdrawn briefing blocks even its already saved thought');
  check(Number((await db.query('select count(*)::int as n from briefing_thoughts where briefing_id=$1', [draftId])).rows[0].n) === 0, 'draft access rejection created no thought');
  console.log(`PASS ${checks} briefing-thought integration checks (own content, revisions, retries, concurrency, isolation, roles, publication and length; paid API calls 0).`);
} finally {
  // These IDs were created above; never delete by seeded user or a broad title match.
  try {
    await db.query('begin');
    await db.query('delete from briefing_thoughts where briefing_id=any($1::uuid[])', [fixtureIds]);
    await db.query('delete from briefings where id=any($1::uuid[])', [fixtureIds]);
    await db.query('commit');
  } catch (error) { await db.query('rollback'); throw error; }
  finally {
    for (const actor of Object.keys(cookies)) await request(actor, '/api/auth', { action: 'logout' }).catch(() => {});
    await db.end();
  }
}
