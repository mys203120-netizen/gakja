/** Local-only, additive example history. Preview by default; pass --apply to persist. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import pg from 'pg';
import { loadProjectEnv, projectRoot, redactEnvironmentSecrets } from './load-env.mjs';
import { schoolQuizTargetIdentity } from '../apps/web/src/lib/school-quiz.ts';
import { questionPracticeState } from '../apps/web/src/lib/learning-flow-view.ts';
import { todayLearningStage } from '../apps/web/src/lib/today-learning-stage.ts';

loadProjectEnv();
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) return nextResolve(new URL(`../apps/web/src/${specifier.slice(2)}.ts`, import.meta.url).href, context);
  return specifier === 'server-only'
    ? { url: new URL('../node_modules/next/dist/compiled/server-only/empty.js', import.meta.url).href, shortCircuit: true }
    : nextResolve(specifier, context);
} });

const database = new URL(process.env.DATABASE_URL || '');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname), 'This example may only write to a local database.');
const apply = process.argv.includes('--apply');
const endDate = process.argv.find(value => value.startsWith('--end-date='))?.split('=')[1]
  || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
assert.match(endDate, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(Date.parse(`${endDate}T00:00:00+09:00`) <= Date.now(), 'Example dates cannot be in the future.');
const directory = join(projectRoot, '.local', 'harin-ten-days', endDate);
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const tablesInOrder = ['quiz_sessions', 'quiz_responses', 'memory_attempts', 'interview_sessions', 'interview_turns', 'interview_reports',
  'study_sessions', 'study_session_events', 'chat_threads', 'chat_messages', 'experience_cards', 'student_plans', 'reading_progress',
  'knowledge_bite_progress', 'knowledge_bite_revisions', 'briefing_thoughts', 'briefing_thought_revisions', 'notifications', 'preparation_states'];
let sharedPool: { end(): Promise<void> } | undefined;

try {
  await db.connect();
  const student = (await db.query("select id,email,name,role,active from profiles where email='harin@gakja.test'" )).rows[0];
  assert.ok(student?.role === 'student' && student.active && student.name === '김하린', 'The named local example account must exist.');
  const batch = `harin-ten-days:${student.id}:${endDate}`;
  const id = (label: string) => {
    const hex = createHash('sha256').update(`${batch}:${label}`).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  };
  const [pack] = (await db.query('select * from content_packages where student_id=$1', [student.id])).rows;
  assert.ok(pack, 'An existing student content package is required.');
  const [preferences] = (await db.query('select data from student_preferences where student_id=$1', [student.id])).rows;
  const targets = (await db.query("select * from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null", [student.id])).rows;
  const targetRow = targets.find(row => row.id === preferences?.data?.selectedTargetId) || targets[0];
  assert.ok(targetRow?.data?.university === '고려대학교' && (targetRow.data.department || targetRow.data.major) === '경영학과', 'Keep the example tied to Harin’s current business target.');
  const target = { ...targetRow.data, id: targetRow.id };
  const snapshot = schoolQuizTargetIdentity(target)!;
  const jobId = `${student.id}-harin-ten-days-${endDate}`;
  const existing = (await db.query('select version from content_versions where package_id=$1 and production_job_ref=$2', [pack.id, jobId])).rows[0];
  const version = existing?.version || Number((await db.query('select coalesce(max(version),0)+1 as next from content_versions where package_id=$1', [pack.id])).rows[0].next);
  const { createHarinTenDaysContent } = await import('./demo/harin-ten-days-content.mts');
  const { createHarinTenDayJourney } = await import('./demo/harin-ten-days-journey.mts');
  const { createHarinTenDayExtras } = await import('./demo/harin-ten-days-extras.mts');
  const { studySummary } = await import('../apps/web/src/lib/study-sessions.ts');
  const { assertRegisteredTargets, validatePublication } = await import('../apps/web/src/lib/content-publication.ts');
  sharedPool = (await import('../apps/web/src/lib/db.ts')).pool;
  const content = createHarinTenDaysContent({ studentId: student.id, studentName: student.name, target, version, packageId: pack.id, productionJobRef: jobId });
  const shared = { studentId: student.id, target: snapshot, learning: content.learning, documents: content.documents, contentVersion: version, packageId: pack.id, endDate, id, practiceExamples: content.practiceExamples, studySummary, summarizeStudy: studySummary };
  const journey = await createHarinTenDayJourney(shared);
  const extras = await createHarinTenDayExtras(shared);
  // Preserve an existing bookmark/reference instead of replacing a student's state.
  const savedReading = new Set((await db.query('select document_kind from reading_progress where student_id=$1', [student.id])).rows.map(row => row.document_kind));
  const savedKnowledge = new Set((await db.query('select video_id from knowledge_bite_progress where student_id=$1', [student.id])).rows.map(row => row.video_id));
  extras.tables.reading_progress = extras.tables.reading_progress.filter(row => !savedReading.has(row.document_kind));
  extras.tables.knowledge_bite_progress = extras.tables.knowledge_bite_progress.filter(row => !savedKnowledge.has(row.video_id));
  extras.tables.knowledge_bite_revisions = extras.tables.knowledge_bite_revisions.filter(row => !savedKnowledge.has(row.video_id));
  const tables: Record<string, any[]> = {};
  for (const source of [journey.tables, extras.tables]) for (const [table, rows] of Object.entries(source)) {
    assert.ok(tablesInOrder.includes(table), `Unexpected example table: ${table}`);
    (tables[table] ||= []).push(...rows as any[]);
  }
  const start = new Date(`${endDate}T07:30:00+09:00`); start.setUTCDate(start.getUTCDate() - 9);
  const publicationAt = start.toISOString();
  const metadata = { synthetic: true, demoScenario: 'harin-ten-days', demoBatchId: batch, endDate,
    notice: '10일 사용 예시용 합성 자료와 학습 이력입니다. 실제 학생부, 실제 학습 성과 또는 유료 AI 실행 기록이 아닙니다.' };
  const documents = content.documents.map(document => ({ id: id(`document:${document.kind}`), student_id: student.id, package_id: pack.id,
    content_version: version, kind: document.kind, data: document.data, html: document.html, file_hash: document.fileHash, created_at: publicationAt }));
  const publication = { id: id('content-version'), student_id: student.id, package_id: pack.id, version, data: content.learning,
    learning_hash: content.learningHash, production_job_ref: jobId, review: metadata, status: 'published' };
  assertRegisteredTargets(content.learning, targets);
  validatePublication(publication as any, documents);

  const questionIds = new Set(content.learning.questions.map(question => question.id));
  const responses = new Map((tables.quiz_responses || []).map(row => [row.id, row]));
  const turns = new Map((tables.interview_turns || []).map(row => [row.id, row]));
  for (const row of Object.values(tables).flat()) assert.equal(row.student_id, student.id, 'Every example row must belong to Harin.');
  const koreanDay = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date(value));
  assert.equal(new Set([...responses.values()].map(row => koreanDay(row.created_at))).size, 10, 'The example must span ten distinct Korean calendar days.');
  for (const [table, rows] of Object.entries(tables)) {
    const rowIds = rows.flatMap(row => row.id ? [row.id] : []);
    assert.equal(new Set(rowIds).size, rowIds.length, `Duplicate example ids in ${table}.`);
    for (const row of rows) for (const field of ['created_at', 'updated_at', 'started_at', 'finished_at', 'ended_at', 'completed_at']) {
      if (row[field]) assert.ok(Date.parse(row[field]) <= Date.now(), `A completed example event cannot be in the future: ${table}.${field}`);
    }
  }
  for (const response of responses.values()) {
    assert.ok(Date.parse(response.created_at) >= Date.parse(publicationAt), 'Learning starts after the example material is published.');
    assert.ok(questionIds.has(response.data.question_id) || response.data.practice_kind === 'concept');
    assert.equal(response.data.target_id, target.id);
    assert.equal(response.data.content_version, version);
    if (response.data.practice_kind !== 'concept') assert.equal(response.outcome, null, 'Personal experience answers are not automatically graded.');
  }
  for (const event of tables.study_session_events || []) {
    const source = event.kind === 'quiz_response' ? responses.get(event.source_id) : event.kind === 'interview_answer' ? turns.get(event.source_id) : null;
    if (['quiz_response', 'interview_answer'].includes(event.kind)) assert.ok(source, 'Study reports must link real example response/turn rows.');
  }
  const counts = Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length]));
  const manifest = { ...metadata, studentId: student.id, targetId: target.id, version, packageId: pack.id, productionJobRef: jobId,
    startDate: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(start), counts, journey: journey.summary, extras: extras.summary,
    rowIds: Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.flatMap(row => row.id ? [row.id] : [])])) };
  if (!apply) {
    const { rowIds, ...preview } = manifest;
    console.log(JSON.stringify({ mode: 'preview', alreadyApplied: Boolean(existing), ...preview }, null, 2));
  } else if (existing) {
    console.log(JSON.stringify({ mode: 'already-applied', version, endDate, message: 'The same example batch already exists; no rows were changed.' }));
  } else {
    mkdirSync(directory, { recursive: true });
    const backupPath = join(directory, 'before.json');
    if (!existsSync(backupPath)) {
      const before: Record<string, unknown> = { student, package: pack, preferences, target: targetRow };
      for (const table of Object.keys(tables)) before[table] = (await db.query(`select * from "${table}" where student_id=$1`, [student.id])).rows;
      writeFileSync(backupPath, JSON.stringify(before, null, 2), { flag: 'wx' });
    }
    const columns = (await db.query("select table_name,column_name,data_type from information_schema.columns where table_schema='public'" )).rows;
    async function insert(table: string, row: Record<string, any>) {
      const names = Object.keys(row).filter(name => row[name] !== undefined);
      for (const name of names) assert.ok(columns.some(column => column.table_name === table && column.column_name === name), `Unknown ${table}.${name}`);
      const values = names.map(name => columns.find(column => column.table_name === table && column.column_name === name)?.data_type === 'jsonb' ? JSON.stringify(row[name]) : row[name]);
      await db.query(`insert into "${table}" (${names.map(name => `"${name}"`).join(',')}) values(${names.map((_, index) => `$${index + 1}`).join(',')})`, values);
    }
    await db.query('begin');
    try {
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [batch]);
      const admin = (await db.query("select id from profiles where role='admin' and active=true order by created_at limit 1")).rows[0];
      await insert('production_links', { id: jobId, student_id: student.id, data: { ...metadata, title: '[예시] 하린의 경영학과 10일 학습' }, created_at: publicationAt });
      const { student_id, ...versionRow } = publication;
      await insert('content_versions', { ...versionRow, created_by: admin?.id || null, published_by: admin?.id || null, created_at: publicationAt, published_at: publicationAt });
      for (const document of documents) await insert('documents', document);
      for (const table of tablesInOrder) for (const row of tables[table] || []) await insert(table, row);
      await db.query('update content_packages set active_version=$2 where id=$1 and student_id=$3', [pack.id, version, student.id]);
      await insert('audit_logs', { id: id('audit'), actor_id: admin?.id || null, student_id: student.id, action: 'demo.harin-ten-days.seed', data: { ...metadata, counts, previousActiveVersion: pack.active_version }, created_at: new Date().toISOString() });
      await db.query('commit');
    } catch (error) { await db.query('rollback'); throw error; }
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ mode: 'applied', version, endDate, counts, backupPath, manifestPath: join(directory, 'manifest.json') }, null, 2));
  }
  if (apply) {
    const { getLearningWorkflows } = await import('../apps/web/src/lib/learning-workflows.ts');
    const workflows = await getLearningWorkflows(student);
    const firstQuestion = content.learning.questions[0];
    const state = questionPracticeState(workflows.versions, firstQuestion, snapshot, version);
    assert.ok(state.canCompare && state.helpUsed.length && state.helpNotOpened.length, 'The example must show comparable aided and independent attempts.');
    const stage = todayLearningStage({ checkingRecord: false, recallAvailable: true, interviewAvailable: true, attempts: state.attempts });
    assert.equal(stage, 'interview', 'The final independent recall should continue into a new interview answer.');
    const currentAnswerIds = new Set([...responses.keys()].map(value => `quiz:${value}`));
    assert.ok(workflows.answerRevisions.filter(row => currentAnswerIds.has(row.id)).every(row => row.content_version === version));
    console.log(JSON.stringify({ verification: 'passed', questionId: firstQuestion.id, attempts: state.attempts.length, helped: state.helpUsed.length,
      withoutHelp: state.helpNotOpened.length, canCompare: state.canCompare, nextStage: stage, followup: `/my/today?questionId=${encodeURIComponent(firstQuestion.id)}&targetId=${encodeURIComponent(target.id)}&sourceType=personal&sourceVersion=${version}` }, null, 2));
  }
} catch (error) {
  console.error(redactEnvironmentSecrets(error instanceof Error ? error.stack || error.message : error));
  process.exitCode = 1;
} finally { await db.end(); await sharedPool?.end(); }
