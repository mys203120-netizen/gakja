import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import { loadProjectEnv } from '../scripts/load-env.mjs';
import {tsImport} from 'tsx/esm/api';
const training=await tsImport('../apps/web/src/lib/admin-training.ts',import.meta.url);
const planner=await tsImport('../apps/web/src/lib/planner-model.ts',import.meta.url);

// Exercise production getAdminData with real SQL inside one rolled-back local
// transaction. No HTTP authentication fixture or external provider is needed.
loadProjectEnv();
if (!['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('This test requires the local PostgreSQL database.');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const fixture = randomUUID(), people = { assigned: randomUUID(), other: randomUUID(), staff: randomUUID(), emptyStaff: randomUUID(), admin: randomUUID() };
const briefingIds = { public: randomUUID(), nullOwner: randomUUID(), assigned: randomUUID(), other: randomUUID() };
let queries = 0, checks = 0;
let queryTail = Promise.resolve();
function check(value, label) { assert.ok(value, label); checks++; }
function productionQuery(sql, params) {
  queries++;
  const pending = queryTail.then(async () => (await db.query(sql, params)).rows);
  queryTail = pending.then(() => {}, () => {});
  return pending;
}

const source = readFileSync(new URL('../apps/web/src/lib/data.ts', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  module, exports: module.exports,
  require(name) {
    if (name === 'server-only') return {};
    if (name === './school-directory') return { enrichSchoolTarget: target => target };
    if (name === './admin-training') return training;
    if (name === './planner-model') return planner;
    if (name === './db') return { ApiError: class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }, query: productionQuery };
    throw new Error(`Unexpected production import: ${name}`);
  },
});

await db.connect();
try {
  await db.query('begin');
  for (const [name, id] of Object.entries(people)) {
    await db.query('insert into profiles(id,email,name,role) values($1,$2,$3,$4)', [id, `private-news-${name}-${fixture}@gakja.test`, `비공개 기사 권한 합성 검사 ${name}`, name === 'admin' ? 'admin' : ['staff', 'emptyStaff'].includes(name) ? 'staff' : 'student']);
  }
  await db.query('insert into staff_assignments(staff_id,student_id) values($1,$2)', [people.staff, people.assigned]);
  for (const [name, id] of Object.entries(briefingIds)) {
    const data = name === 'public' ? { summary: '합성 공용 기사' } : name === 'nullOwner' ? { owner_student_id: null, summary: '합성 공용 기사' } : { source_kind: 'rss_news', owner_student_id: people[name], thought_snapshot: { content: `합성 개인 생각 ${name}` } };
    await db.query("insert into briefings(id,title,category,data,status,created_by) values($1,$2,'test',$3,'published',$4)", [id, `합성 비공개 뉴스 ${fixture} ${name}`, JSON.stringify(data), people.admin]);
  }

  const assigned = await module.exports.getAdminData({ id: people.staff, role: 'staff' });
  const assignedIds = new Set(assigned.briefings.map(row => row.id));
  check(assignedIds.has(briefingIds.public), 'assigned staff receives legacy public news');
  check(assignedIds.has(briefingIds.nullOwner), 'explicit null owner remains public');
  check(assignedIds.has(briefingIds.assigned), 'assigned staff receives the assigned student reflection');
  check(!assignedIds.has(briefingIds.other), 'unassigned private reflection is excluded');
  check(assigned.students.some(row => row.id === people.assigned) && !assigned.students.some(row => row.id === people.other), 'student assignment scope matches the briefing scope');

  const empty = await module.exports.getAdminData({ id: people.emptyStaff, role: 'staff' });
  const emptyIds = new Set(empty.briefings.map(row => row.id));
  check(emptyIds.has(briefingIds.public) && emptyIds.has(briefingIds.nullOwner), 'staff without assignments can still read public news');
  check(empty.briefings.every(row => row.data.owner_student_id == null), 'staff without assignments receives no private reflections');
  check(!emptyIds.has(briefingIds.assigned) && !emptyIds.has(briefingIds.other), 'all generated private news is hidden without assignments');

  const admin = await module.exports.getAdminData({ id: people.admin, role: 'admin' });
  const adminIds = new Set(admin.briefings.map(row => row.id));
  check(Object.values(briefingIds).every(id => adminIds.has(id)), 'administrator retains global public and private access');

  const beforeDenied = queries;
  await assert.rejects(() => module.exports.getAdminData({ id: people.other, role: 'student' }), error => error.status === 403);
  check(queries === beforeDenied, 'student role is rejected before any administrative query');
} finally {
  // All generated rows disappear together; existing students and reflections
  // were only read, never modified or printed.
  await db.query('rollback');
  try {
    check((await db.query('select count(*)::int as count from profiles where id=any($1::uuid[])', [Object.values(people)])).rows[0].count === 0, 'generated profiles rolled back');
    check((await db.query('select count(*)::int as count from briefings where id=any($1::uuid[])', [Object.values(briefingIds)])).rows[0].count === 0, 'generated news rolled back');
  } finally { await db.end(); }
}
console.log(`Private news staff access: ${checks} checks passed; production function + isolated PostgreSQL, zero external AI requests.`);
