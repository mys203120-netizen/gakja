// Run against a seeded local dev server: node tests/security-ai.mjs
import { loadProjectEnv, projectRoot } from '../scripts/load-env.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

loadProjectEnv();
let lastServerUrl;
try { lastServerUrl = JSON.parse(readFileSync(join(projectRoot, '.local/server.json'), 'utf8')).url; }
catch { /* Tests can use an explicit URL before the launcher has saved its state. */ }
const base = process.env.TEST_BASE_URL || process.env.SMOKE_BASE_URL || lastServerUrl || process.env.NEXT_PUBLIC_APP_URL || 'http://127.0.0.1:3000';
if (process.env.AUTH_MODE === 'supabase') throw new Error('이 검사는 로컬 합성 테스터 전용입니다.');
if (process.env.OPENAI_API_KEY?.trim()) throw new Error('이 검사는 API 호출 없이 실행합니다. 키가 없는 로컬 테스트 설정을 사용하세요.');
if (!['127.0.0.1', 'localhost'].includes(new URL(process.env.DATABASE_URL).hostname)) throw new Error('로컬 PostgreSQL에서만 검사를 실행하세요.');
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const createdSessions = [];
const createdThreads = [];
const createdBriefings = [];
let passed = 0;
async function expectStatus(response, status, label) {
  assert.equal(response.status, status, `${label}: ${await response.clone().text()}`);
  passed++;
  return response;
}
async function login(email) {
  const response = await fetch(`${base}/api/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ action: 'login', email, password: process.env.TEST_ACCOUNT_PASSWORD || 'Gakja!2026' }) });
  await expectStatus(response, 200, '테스터 로그인');
  return response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
}
function api(path, cookie, body, method = 'POST') {
  return fetch(`${base}${path}`, { method: body === undefined ? 'GET' : method, headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: base, ...(body instanceof FormData || body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
}
function wav() {
  const b = Buffer.alloc(44 + 320); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(320, 40); return b;
}
try {
  const [student, other, admin] = await Promise.all([login('harin@gakja.test'), login('doyun@gakja.test'), login('admin@gakja.test')]);
  const bootstrap = await (await api('/api/bootstrap', student)).json();
  const question = bootstrap.learning.questions[0];
  const target = bootstrap.targets[0];
  const otherBootstrap = await (await api('/api/bootstrap', other)).json();
  const otherActivityId = otherBootstrap.learning.activities[0].id;
  await expectStatus(await api('/api/interviews', student, { action: 'start', activityId: otherActivityId }), 404, '다른 학생 활동으로 면접 시작 차단');
  await expectStatus(await api('/api/chat', student, { message: '활동 설명', activityId: otherActivityId }), 404, '다른 학생 활동 챗 맥락 차단');
  const activity = bootstrap.learning.activities.find(a => bootstrap.learning.questions.filter(q => q.activity_ids.includes(a.id)).length >= 2) || bootstrap.learning.activities[0];
  const linkedQuestions = bootstrap.learning.questions.filter(q => q.activity_ids.includes(activity.id));
  const activitySession = await (await expectStatus(await api('/api/interviews', student, { action: 'start', activityId: activity.id, targetId: target.id, questionCount: 8 }), 200, '활동에서 연결된 면접 시작')).json();
  createdSessions.push(activitySession.session.id);
  assert.ok(linkedQuestions.some(q => q.id === activitySession.question.id));
  const activityRecord = (await db.query('select data from interview_sessions where id=$1', [activitySession.session.id])).rows[0].data;
  assert.equal(activityRecord.context.activityId, activity.id);
  assert.ok(activityRecord.questionQueue.every(q => q.activity_ids.includes(activity.id))); passed++;
  const unrelatedQuestion = bootstrap.learning.questions.find(q => !q.activity_ids.includes(activity.id));
  if (unrelatedQuestion) await expectStatus(await api('/api/interviews', student, { action: 'start', activityId: activity.id, questionId: unrelatedQuestion.id }), 409, '활동과 무관한 지정 질문 차단');
  const briefingId = randomUUID(); createdBriefings.push(briefingId);
  const briefingData = { summary: '합성 보안 검사 자료', discussion_question: '근거를 확인할 때 무엇을 볼까요?', source_url: 'https://example.com/security-test-source', source_kind: 'synthetic_test_briefing', checked_at: '2026-10-08', synthetic: true };
  await db.query("insert into briefings(id,title,category,data,status) values($1,'security-test-only','test',$2,'draft')", [briefingId, JSON.stringify(briefingData)]);
  await expectStatus(await api('/api/chat', student, { message: '이 이슈를 설명해줘', briefingId }), 404, '미발행 브리핑 챗 접근 차단');
  await db.query("update briefings set status='published' where id=$1", [briefingId]);
  await expectStatus(await api('/api/chat', student, { message: '이 이슈를 설명해줘', briefingId }), 503, '발행 브리핑은 키 미등록 상태를 정직하게 표시');
  const noKey = await api('/api/chat', student, { message: '내 역할을 어떻게 말할까요?', activityId: null, questionId: null, targetId: target.id });
  await expectStatus(noKey, 503, '키 미등록 상태에서 가짜 AI 응답 차단');
  assert.equal((await noKey.json()).code, 'AI_NOT_CONFIGURED');
  await expectStatus(await api('/api/chat', admin), 403, '관리자 개인 챗 차단');
  await expectStatus(await api('/api/interviews', '', { action: 'start' }), 401, '로그아웃 면접 차단');
  await expectStatus(await api('/api/interviews', student, { action: 'start', targetId: 'other-student-target' }), 404, '지원처 소유권 차단');
  const requestId = randomUUID();
  const started = await (await expectStatus(await api('/api/interviews', student, { action: 'start', kind: 'video', mode: 'basic', targetId: target.id, questionId: question.id, questionCount: 2, requestId }), 200, '승인 질문으로 실제 면접 시작')).json();
  const sessionId = started.session.id; createdSessions.push(sessionId);
  const duplicate = await (await api('/api/interviews', student, { action: 'start', kind: 'video', targetId: target.id, questionId: question.id, requestId })).json();
  assert.equal(duplicate.session.id, sessionId); passed++;
  await expectStatus(await api(`/api/interviews?id=${sessionId}`, other), 404, '다른 학생 면접 열람 차단');
  await expectStatus(await api('/api/interviews', other, { action: 'answer', sessionId, answer: '다른 계정 답변' }), 404, '다른 학생 답변 제출 차단');
  const bytes = wav();
  const upload = new FormData(); upload.append('sessionId', sessionId); upload.append('questionId', started.question.id); upload.append('turnId', started.question.turnId); upload.append('consent', 'true'); upload.append('recording', new Blob([bytes], { type: 'audio/wav' }), 'answer.wav');
  const media = await (await expectStatus(await api('/api/media', student, upload), 200, '실제 음성 비공개 저장')).json();
  assert.equal(media.transcript, null); assert.equal(media.transcriptionStatus, 'not_configured'); passed++;
  const mediaRepeat = await (await api('/api/media', student, upload)).json();
  assert.equal(mediaRepeat.media.id, media.media.id); passed++;
  const ownerMedia = await expectStatus(await api(media.media.url, student), 200, '소유자 미디어 조회');
  assert.deepEqual(Buffer.from(await ownerMedia.arrayBuffer()), bytes); passed++;
  await expectStatus(await api(media.media.url, other), 404, '다른 학생 미디어 차단');
  await expectStatus(await api(media.media.url, admin), 403, '관리자 개인 미디어 차단');
  await expectStatus(await api(media.media.url, ''), 401, '로그아웃 미디어 차단');
  const range = await fetch(`${base}${media.media.url}`, { headers: { Cookie: student, Range: 'bytes=0-11' } });
  await expectStatus(range, 206, '미디어 부분 재생'); assert.equal((await range.arrayBuffer()).byteLength, 12); passed++;
  const answer = '저는 실험의 조건을 기록하고 비교했습니다. 역할과 실제 행동을 더 확인하겠습니다.';
  const answerRequest = { action: 'answer', sessionId, turnId: started.question.turnId, answer, requestId: randomUUID() };
  const answered = await (await expectStatus(await api('/api/interviews', student, answerRequest), 200, '답변 저장과 다음 승인 질문')).json();
  const repeat = await (await api('/api/interviews', student, answerRequest)).json();
  assert.equal(repeat.turn.id, answered.turn.id); assert.equal(repeat.nextQuestion?.turnId, answered.nextQuestion?.turnId); passed++;
  await expectStatus(await api('/api/interviews', student, { action: 'answer', sessionId, turnId: started.question.turnId, answer }), 409, '이전 질문 중복 제출 차단');
  const report = await (await expectStatus(await api('/api/interviews', student, { action: 'finish', sessionId }), 200, '실제 답변 자기 점검 리포트')).json();
  assert.equal(report.report.metrics.answeredQuestions, 1); assert.equal(report.report.metrics.recordedCharacters, answer.length); assert.equal(report.report.aiStatus, 'not_configured'); assert.equal(report.report.sections[0].answer, answer); assert.equal(report.report.aiFeedback, undefined); passed++;
  await expectStatus(await api('/api/interviews', student, { action: 'transcript', sessionId, turnId: started.question.turnId, transcript: '정정한 학생 답변' }), 200, '전사 정정 보존');
  const revision = await (await api('/api/interviews', student, { action: 'finish', sessionId })).json();
  assert.equal(revision.report.reportRevision, 2); assert.equal(revision.report.revisions[0].sections[0].answer, answer); assert.equal(revision.report.sections[0].answer, '정정한 학생 답변'); passed++;
  for (const mode of ['documents', 'followup', 'major', 'university', 'pressure']) {
    const result = await expectStatus(await api('/api/interviews', student, { action: 'start', mode, targetId: target.id }), 200, `${mode} 면접 모드`);
    const body = await result.json(); createdSessions.push(body.session.id);
    await expectStatus(await api('/api/interviews', student, { action: 'cancel', sessionId: body.session.id }), 200, '진행 면접 취소');
    await expectStatus(await api('/api/interviews', student, { action: 'finish', sessionId: body.session.id }), 409, '취소 면접 리포트 생성 차단');
  }
  const context = { packageId: bootstrap.package.id, contentVersion: String(bootstrap.package.active_version), targetId: target.id, activityId: null, questionId: question.id, target, studentContext: bootstrap.learning.student_context, activities: bootstrap.learning.activities, questions: bootstrap.learning.questions, answerScripts: bootstrap.learning.answer_scripts, sources: bootstrap.learning.source_refs };
  const [thread] = (await db.query('insert into chat_threads(student_id,target_id,content_version,title,context) values($1,$2,$3,$4,$5) returning id', [bootstrap.user.id, target.id, Number(context.contentVersion), 'security-test-only', JSON.stringify(context)])).rows; createdThreads.push(thread.id);
  await db.query("insert into chat_messages(thread_id,student_id,role,content) values($1,$2,'user','ownership test fixture')", [thread.id, bootstrap.user.id]);
  await expectStatus(await api(`/api/chat?threadId=${thread.id}`, student), 200, '소유자 대화 복구');
  await expectStatus(await api(`/api/chat?threadId=${thread.id}`, other), 404, '다른 학생 대화 차단');
  await expectStatus(await api('/api/chat', other, { threadId: thread.id, message: '다른 학생 대화 질문' }), 404, '다른 학생 AI 입력 차단');
  await expectStatus(await api(`/api/chat?threadId=${thread.id}`, admin), 403, '관리자 개인 대화 접근 차단');
  const briefingSnapshot = { ...briefingData, id: briefingId, title: 'security-test-only', category: 'test' };
  const [briefThread] = (await db.query('insert into chat_threads(student_id,target_id,content_version,title,context) values($1,$2,$3,$4,$5) returning id', [bootstrap.user.id, target.id, Number(context.contentVersion), 'security-test-only-briefing', JSON.stringify({ ...context, briefingId, briefing: briefingSnapshot })])).rows; createdThreads.push(briefThread.id);
  await db.query("update briefings set data=jsonb_set(data,'{summary}','\"변경된 최신 브리핑\"'::jsonb) where id=$1", [briefingId]);
  const pinnedBriefing = await (await expectStatus(await api(`/api/chat?threadId=${briefThread.id}`, student), 200, '기존 브리핑 대화 조회')).json();
  assert.equal(pinnedBriefing.thread.context.briefing.summary, briefingData.summary);
  assert.equal(pinnedBriefing.thread.context.briefing.source_url, briefingData.source_url); passed++;
  await db.query("update briefings set status='draft' where id=$1", [briefingId]);
  await expectStatus(await api('/api/chat', student, { threadId: briefThread.id, message: '이 이슈를 다시 설명해줘' }), 404, '회수한 브리핑의 후속 AI 접근 차단');
  console.log(`PASS ${passed} AI·면접·미디어 격리/복구 검사 (외부 API 호출 0회)`);
} finally {
  await db.query('delete from media_assets where session_id=any($1::uuid[])', [createdSessions]);
  await db.query('delete from interview_reports where session_id=any($1::uuid[])', [createdSessions]);
  await db.query('delete from interview_sessions where id=any($1::uuid[])', [createdSessions]);
  await db.query('delete from chat_threads where id=any($1::uuid[])', [createdThreads]);
  await db.query('delete from briefings where id=any($1::uuid[])', [createdBriefings]);
  await db.end();
}
