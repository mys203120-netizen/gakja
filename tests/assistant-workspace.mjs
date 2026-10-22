import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import ts from 'typescript';
import { z } from 'zod';

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
class FeatureError extends Error { constructor(status, message, code = 'REQUEST_FAILED') { super(message); this.status = status; this.code = code; } }
const featureError = error => error instanceof FeatureError ? { status: error.status, error: error.message, code: error.code } : error instanceof z.ZodError ? { status: 400, error: '입력 내용을 확인해 주세요.', code: 'INVALID_INPUT' } : { status: 500, error: '실패', code: 'INTERNAL_ERROR' };
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function load(relative, overrides) {
  const module = { exports: {} }, source = fs.readFileSync(path.join(root, relative), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(output, { module, exports: module.exports, Buffer, TextDecoder, TextEncoder, AbortController, ReadableStream, Request, Response, File, FormData, URL, process, console, setTimeout, clearTimeout, require(name) {
    if (name === 'server-only') return {};
    if (name in overrides) return overrides[name];
    if (name.startsWith('node:') || name === 'zod') return require(name);
    throw new Error(`Unmocked dependency ${name}`);
  } });
  return module.exports;
}
function zip(entries) {
  const files = [], central = []; let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name), raw = Buffer.from(text), data = deflateRawSync(raw), local = Buffer.alloc(30), record = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(filename.length, 26);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(8, 10); record.writeUInt32LE(data.length, 20); record.writeUInt32LE(raw.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
    files.push(local, filename, data); central.push(record, filename); offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, directory, end]);
}
const format = load('apps/web/src/lib/chat-attachments.ts', { '@/lib/auth': {}, '@/lib/db': {}, '@/lib/ai': { FeatureError } });
const validate = (name, type, bytes) => format.validateChatAttachment({ name, type, size: bytes.length }, bytes);
function rejected(name, mime, bytes, code) { assert.throws(() => validate(name, mime, bytes), error => error instanceof FeatureError && (!code || error.code === code)); checks++; }
check(validate('활동.txt', 'text/plain', Buffer.from('내 역할은 분석이었다.')).text === '내 역할은 분석이었다.', 'UTF-8 Korean is preserved');
check(validate('notes.md', '', Buffer.from('# 실험\n**관찰**')).kind === 'text', 'Markdown with missing browser MIME is supported');
check(validate('../notes.txt', 'text/plain', Buffer.from('안전')).name === '.._notes.txt', 'the original file name cannot become a storage path');
rejected('secret.svg', 'image/svg+xml', Buffer.from('<svg/>'), 'ATTACHMENT_UNSUPPORTED');
rejected('page.html', 'text/html', Buffer.from('<script/>'), 'ATTACHMENT_UNSUPPORTED');
rejected('fake.png', 'image/png', Buffer.from('<script/>'));
rejected('notes.txt', 'image/png', Buffer.from('text'), 'ATTACHMENT_UNSUPPORTED');
rejected('bad.txt', 'text/plain', Buffer.from([0xff, 0xfe]));
rejected('binary.txt', 'text/plain', Buffer.from([1, 0, 2]));
rejected('empty.txt', 'text/plain', Buffer.from('   '), 'ATTACHMENT_EMPTY_TEXT');
rejected('large.txt', 'text/plain', Buffer.alloc(100001, 65), 'ATTACHMENT_TEXT_TOO_LONG');
rejected('large.pdf', 'application/pdf', Buffer.alloc(15 * 1024 * 1024 + 1), 'ATTACHMENT_SIZE_LIMIT');
rejected('bad.pdf', 'application/pdf', Buffer.from('%PDF-1.4\ninvalid'));
check(validate('paper.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF')).kind === 'pdf', 'PDF remains a native provider document');
const doc = zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>역할 &amp; 결과</w:t></w:r></w:p><w:p><w:r><w:t>둘째 줄</w:t></w:r></w:p></w:body></w:document>']]);
check(validate('notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc).text === '역할 & 결과\n둘째 줄', 'DOCX main body extracts paragraphs and XML entities');
rejected('notes.docx', '', zip([['word/document.xml', '<w:document>내용</w:document>']]));
rejected('macro.docx', '', zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:p>본문</w:p>'], ['word/vbaProject.bin', 'macro']]));
rejected('dtd.docx', '', zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<!DOCTYPE x><w:p>내용</w:p>']]));
rejected('bomb.docx', '', zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', 'a'.repeat(4 * 1024 * 1024 + 1)]]));
rejected('traversal.docx', '', zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', '<w:p>본문</w:p>'], ['../escape', 'bad']]));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i5x0AAAAASUVORK5CYII=', 'base64');
check(validate('image.png', 'image/png', png).kind === 'image', 'PNG signature is accepted');
check(format.chatAttachmentView({ id: 'safe-id', name: 'notes', mime: 'text/plain', kind: 'text', size: 3, storage: { path: 'secret' } }).url === '/api/chat/attachments/safe-id', 'views expose an authenticated URL, never the storage path');
await assert.rejects(format.chatAttachmentInputs([{ kind: 'text', name: 'a', extracted_text: 'a'.repeat(160001) }]), error => error.code === 'ATTACHMENT_CONTEXT_TOO_LONG'); checks++;
console.log(`Attachment validation: ${checks} assertions passed`);

if (!process.argv.includes('--postgres')) process.exit(0);
const { loadProjectEnv } = await import('../scripts/load-env.mjs'); loadProjectEnv();
const database = new URL(process.env.DATABASE_URL || '');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname) && process.env.AUTH_MODE !== 'supabase', 'Integration tests only use local PostgreSQL');
const { default: pg } = await import('pg'), pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const student = randomUUID(), other = randomUUID(); let current = student, providerCalls = 0, providerMode = 'normal', providerGate;
const query = async (sql, params = []) => (await pool.query(sql, params)).rows;
const transaction = async fn => { const client = await pool.connect(); try { await client.query('begin'); const result = await fn(client); await client.query('commit'); return result; } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); } };
const context = { ownerStudentId: student, sourceKind: 'common', packageId: 'common-bank', contentVersion: '1', targetId: null, activityId: null, questionId: null, briefingId: null, target: null, studentContext: {}, activities: [], questions: [], answerScripts: [], sources: [] };
const auth = { requireUser: async () => ({ id: current, role: 'student' }), checkOrigin(request) { if (request.headers.get('origin') !== new URL(request.url).origin) throw new FeatureError(403, 'origin', 'ORIGIN'); }, supabaseServer: () => { throw new Error('External storage is forbidden in this test'); } };
const ai = { FeatureError, featureError, requireStudent(user) { if (user.role !== 'student') throw new FeatureError(403, 'student'); }, assertPublishedAccess: async () => {}, openai: () => ({}), getLearningContext: async () => ({ ...context, ownerStudentId: current }), coach: async () => { providerCalls++; return { content: '완료', sources: [] }; }, coachStream: async (_student, _context, _task, _history, _feature, _thread, onDelta, inputs, signal) => {
  providerCalls++;
  if (providerMode === 'hold') {
    await new Promise(resolve => setTimeout(resolve, 550)); await onDelta('부분 답변');
    await new Promise((resolve, reject) => { providerGate = resolve; signal.addEventListener('abort', () => reject(new FeatureError(499, '끊김', 'RESPONSE_INTERRUPTED')), { once: true }); });
  } else { await onDelta('**내 역할**'); await onDelta('\n이 분석이었다.'); }
  if (providerMode === 'failure') throw new FeatureError(502, '검증 실패', 'AI_INVALID_SOURCE');
  return { content: providerMode === 'hold' ? '부분 답변 완료' : '**내 역할**\n이 분석이었다.', sources: [], attachmentCount: inputs.length };
} };
const attachment = load('apps/web/src/lib/chat-attachments.ts', { '@/lib/auth': auth, '@/lib/db': { query, transaction }, '@/lib/ai': ai });
// This contract exercises ordinary conversations and attachments. Attempt-specific
// help is covered separately; fail closed if an unscoped fixture reaches it.
const unexpectedHelp = name => () => { throw new Error(`Unexpected learning-help dependency in ordinary chat fixture: ${name}`); };
const helpModules = {
  '@/lib/student-records':{getStudentRecords:unexpectedHelp('getStudentRecords')},
  '@/lib/thought-writing': {ownedWritingReceipt:unexpectedHelp('ownedWritingReceipt')},
  '@gakja/content-contracts': { learningTargetIdentityMatches: unexpectedHelp('learningTargetIdentityMatches') },
  '@/lib/school-quiz': { schoolQuizTargetIdentity: unexpectedHelp('schoolQuizTargetIdentity') },
  '@/lib/interview-assistance': Object.fromEntries(['ownedInterviewHelpScope', 'ownedInterviewChatContext', 'assertInterviewHelpContext', 'recordInterviewHelp', 'settleInterviewHelp', 'lockInterviewHelpScope'].map(name => [name, unexpectedHelp(name)])),
  '@/lib/learning-workflows': Object.fromEntries(['recordAssignmentHelp', 'getAssignmentHelpContext'].map(name => [name, unexpectedHelp(name)])),
  '@/lib/quiz-assistance': Object.fromEntries(['getQuizHelpContext', 'recordQuizHelp'].map(name => [name, unexpectedHelp(name)])),
  '@/lib/interview-answer-evidence': load('apps/web/src/lib/interview-answer-evidence.ts', {}),
};
const routes = load('apps/web/src/app/api/chat/route.ts', { '@/lib/auth': auth, '@/lib/db': { query, transaction }, '@/lib/ai': ai, '@/lib/data': { getLearning: async () => ({ learning: {}, documents: [] }) }, '@/lib/chat-attachments': attachment, ...helpModules });
const upload = load('apps/web/src/app/api/chat/attachments/route.ts', { '@/lib/auth': auth, '@/lib/db': { query, transaction }, '@/lib/ai': ai, '@/lib/chat-attachments': attachment });
const binary = load('apps/web/src/app/api/chat/attachments/[id]/route.ts', { '@/lib/auth': auth, '@/lib/db': { query, transaction }, '@/lib/ai': ai, '@/lib/chat-attachments': attachment });
const request = (url, body, method = 'POST') => new Request('http://localhost:3100' + url, { method, headers: { origin: 'http://localhost:3100', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const events = async response => (await response.text()).split('\n\n').filter(Boolean).map(line => JSON.parse(line.replace(/^data: /, '')));
async function eventual(fn) { for (let attempt = 0; attempt < 60; attempt++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('Expected saved state did not settle'); }
const before = checks;
try {
  for (const id of [student, other]) await query("insert into profiles(id,email,name,role,active) values($1,$2,'AI 비서 계약 검증','student',true)", [id, `assistant-contract-${id}@gakja.test`]);
  for (const incompleteScope of [{ quizSessionId: randomUUID() }, { interviewSessionId: randomUUID() }, { assignmentId: randomUUID() }]) {
    check((await routes.POST(request('/api/chat', { message: '불완전한 도움 맥락', ...incompleteScope }))).status === 400, 'an incomplete attempt scope fails before ordinary-chat fixtures or provider access');
  }
  check((await query('select id from chat_threads where student_id=$1', [student])).length === 0 && providerCalls === 0, 'invalid help scopes create no conversation and call no provider');
  const form = new FormData(); form.append('files', new File(['내 역할은 시료 분석이었다.'], 'notes.md', { type: 'text/markdown' }));
  const uploaded = await upload.POST(new Request('http://localhost:3100/api/chat/attachments', { method: 'POST', headers: { origin: 'http://localhost:3100' }, body: form }));
  check(uploaded.status === 201, 'upload creates private draft'); const file = (await uploaded.json()).attachments[0];
  const mixed = new FormData(); mixed.append('files', new File(['정상'], 'valid.txt', { type: 'text/plain' })); mixed.append('files', new File(['<svg/>'], 'bad.png', { type: 'image/png' }));
  check((await upload.POST(new Request('http://localhost:3100/api/chat/attachments', { method: 'POST', headers: { origin: 'http://localhost:3100' }, body: mixed }))).status === 415, 'a mixed invalid batch is rejected');
  check((await query('select id from chat_attachments where student_id=$1', [student])).length === 1, 'invalid batch does not create a partial draft');
  const many = new FormData(); for (let index = 0; index < 4; index++) many.append('files', new File(['내용'], `${index}.txt`, { type: 'text/plain' }));
  check((await upload.POST(new Request('http://localhost:3100/api/chat/attachments', { method: 'POST', headers: { origin: 'http://localhost:3100' }, body: many }))).status === 400, 'the three-file count is enforced');
  let sourceCancelled = false, chunk = 0;
  const oversized = new ReadableStream({ pull(controller) { if (chunk++ < 48) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close(); }, cancel() { sourceCancelled = true; } });
  check((await upload.POST(new Request('http://localhost:3100/api/chat/attachments', { method: 'POST', duplex: 'half', headers: { origin: 'http://localhost:3100', 'content-type': 'multipart/form-data; boundary=synthetic' }, body: oversized }))).status === 413, 'a chunked upload without Content-Length is bounded');
  check(sourceCancelled, 'oversized uploads stop reading the incoming stream');
  check((await upload.POST(new Request('http://localhost:3100/api/chat/attachments', { method: 'POST', headers: { origin: 'http://localhost:3100', 'content-type': 'multipart/form-data; boundary=synthetic' }, body: 'broken multipart' }))).status === 400, 'malformed multipart is a client error');
  const unused = new FormData(); unused.append('files', new File(['지울 초안'], 'unused.txt', { type: 'text/plain' }));
  const draft = (await (await upload.POST(new Request('http://localhost:3100/api/chat/attachments', { method: 'POST', headers: { origin: 'http://localhost:3100' }, body: unused }))).json()).attachments[0];
  check((await upload.DELETE(request('/api/chat/attachments?id=' + draft.id, undefined, 'DELETE'))).status === 200, 'unused upload deletion succeeds');
  check((await binary.GET(request('/api/chat/attachments/' + draft.id, undefined, 'GET'), { params: Promise.resolve({ id: draft.id }) })).status === 404, 'discarded draft binary is unavailable');
  check((await binary.GET(request('/api/chat/attachments/' + file.id, undefined, 'GET'), { params: Promise.resolve({ id: file.id }) })).headers.get('content-disposition').startsWith('attachment;'), 'original is delivered as a sandboxed download');
  current = other;
  check((await binary.GET(request('/api/chat/attachments/' + file.id, undefined, 'GET'), { params: Promise.resolve({ id: file.id }) })).status === 404, 'foreign original is hidden');
  check((await routes.POST(request('/api/chat', { message: '타인 파일', attachmentIds: [file.id] }))).status === 404, 'foreign attachment cannot create a conversation');
  check((await query('select id from chat_threads where student_id=$1', [other])).length === 0, 'unauthorized attachment creates no empty thread'); current = student;
  const first = await routes.POST(request('/api/chat', { message: '내 역할을 정리해줘', attachmentIds: [file.id], stream: true, requestId: 'first-send-idempotency' })), firstEvents = await events(first), threadId = firstEvents[0].threadId;
  check(first.headers.get('content-type').includes('text/event-stream'), 'POST opts into actual SSE');
  check(firstEvents.map(event => event.type).join(',') === 'start,delta,delta,done', 'deltas precede completed message');
  check(firstEvents[3].message.content === '**내 역할**\n이 분석이었다.', 'completion preserves Markdown');
  check(firstEvents[0].userMessage.attachments[0].id === file.id, 'sent message preserves source attachment');
  check(firstEvents[3].message.data.attachmentCount === 1, 'attachment is passed to the model adapter');
  const count = providerCalls;
  const retry = await events(await routes.POST(request('/api/chat', { message: '내 역할을 정리해줘', attachmentIds: [file.id], stream: true, requestId: 'first-send-idempotency' })));
  check(retry[0].threadId === threadId && retry.at(-1).type === 'done', 'first-turn retry works even without a learned thread ID');
  check(providerCalls === count, 'duplicate completed send does not repeat the provider');
  check((await upload.DELETE(request('/api/chat/attachments?id=' + file.id, undefined, 'DELETE'))).status === 409, 'sent evidence cannot be discarded as a draft');
  const next = await routes.POST(request('/api/chat', { message: '다음에도 이 자료를 써줘', threadId }));
  check((await next.json()).message.data.attachmentCount === 1, 'follow-up reuses private source material');
  let result = await routes.PATCH(request('/api/chat', { threadId, action: 'rename', title: '나의 분석 경험' }, 'PATCH'));
  check(result.status === 200 && (await result.json()).thread.title === '나의 분석 경험', 'rename persists');
  check((await routes.PATCH(request('/api/chat', { threadId, action: 'rename', title: ' ' }, 'PATCH'))).status === 400, 'blank rename is rejected');
  await routes.PATCH(request('/api/chat', { threadId, action: 'archive' }, 'PATCH'));
  check((await (await routes.GET(request('/api/chat', undefined, 'GET'))).json()).threads.length === 0, 'active list excludes archive');
  check((await (await routes.GET(request('/api/chat?view=archived', undefined, 'GET'))).json()).threads[0].id === threadId, 'archive list includes owned thread');
  check((await routes.POST(request('/api/chat', { message: '계속', threadId }))).status === 409, 'archived thread needs explicit restoration');
  check((await routes.GET(request('/api/chat?threadId=' + threadId, undefined, 'GET'))).status === 200, 'archive remains readable');
  await routes.PATCH(request('/api/chat', { threadId, action: 'restore' }, 'PATCH'));
  current = other;
  for (const action of ['rename', 'archive', 'restore', 'delete']) check((await routes.PATCH(request('/api/chat', { threadId, action, title: '가로채기' }, 'PATCH'))).status === 404, `foreign ${action} is denied`);
  check((await routes.GET(request('/api/chat?threadId=' + threadId, undefined, 'GET'))).status === 404, 'foreign messages are hidden'); current = student;
  await routes.DELETE(request('/api/chat?threadId=' + threadId, undefined, 'DELETE'));
  check((await routes.GET(request('/api/chat?threadId=' + threadId, undefined, 'GET'))).status === 404, 'deleted thread detail is hidden');
  check((await binary.GET(request('/api/chat/attachments/' + file.id, undefined, 'GET'), { params: Promise.resolve({ id: file.id }) })).status === 404, 'deleted conversation attachment is hidden');
  check((await query('select id from chat_messages where thread_id=$1', [threadId])).length === 4, 'delete preserves original learning evidence');
  await routes.PATCH(request('/api/chat', { threadId, action: 'restore' }, 'PATCH'));
  check((await routes.GET(request('/api/chat?threadId=' + threadId, undefined, 'GET'))).status === 200, 'soft-deleted conversation can be restored');
  providerMode = 'hold';
  const pendingResponse = await routes.POST(request('/api/chat', { message: '중단 테스트', threadId, stream: true, requestId: 'pending-send-idempotency' })), reader = pendingResponse.body.getReader();
  const start = JSON.parse(new TextDecoder().decode((await reader.read()).value).replace(/^data: /, '').trim());
  check(start.type === 'start', 'reservation appears before the provider finishes');
  await reader.read();
  await eventual(async () => (await query('select content from chat_messages where id=$1', [start.assistantId]))[0].content === '부분 답변');
  const partial = (await query('select * from chat_messages where id=$1', [start.assistantId]))[0];
  check(partial.status === 'pending' && partial.content === '부분 답변', 'pending partial tokens persist for reconnect');
  const pendingDuplicate = await events(await routes.POST(request('/api/chat', { message: '중단 테스트', threadId, stream: true, requestId: 'pending-send-idempotency' })));
  check(pendingDuplicate.at(-1).type === 'pending', 'duplicate pending request does not invent a completion');
  check((await routes.POST(request('/api/chat', { message: '중복 새 요청', threadId }))).status === 409, 'a pending turn blocks another request');
  for (const action of ['rename', 'archive', 'restore', 'delete']) check((await routes.PATCH(request('/api/chat', { threadId, action, title: '대기' }, 'PATCH'))).status === 409, `pending ${action} is denied`);
  await reader.cancel();
  await eventual(async () => (await query('select status from chat_messages where id=$1', [start.assistantId]))[0].status === 'failed');
  const interrupted = (await query('select * from chat_messages where id=$1', [start.assistantId]))[0];
  check(interrupted.content === '부분 답변' && interrupted.data.code === 'RESPONSE_INTERRUPTED', 'cancellation keeps a failed partial instead of a fake result');
  providerMode = 'failure';
  const invalid = await events(await routes.POST(request('/api/chat', { message: '근거 오류', threadId, stream: true })));
  check(invalid.at(-1).type === 'error' && invalid.at(-1).code === 'AI_INVALID_SOURCE', 'provider validation failure becomes a stream error');
  const failed = (await query('select * from chat_messages where id=$1', [invalid.at(-1).messageId]))[0];
  check(failed.status === 'failed' && failed.content.includes('내 역할'), 'invalid completed source never becomes a completed answer');
  check((await routes.POST(request('/api/chat', { message: '다른 학교', threadId, targetId: 'foreign-target' }))).status === 409, 'learning context stays pinned');
  const staleId = randomUUID();
  await query("insert into chat_messages(id,thread_id,student_id,role,content,status,created_at) values($1,$2,$3,'assistant','남은 토큰','pending',now()-interval '3 minutes')", [staleId, threadId, student]);
  await routes.GET(request('/api/chat?threadId=' + threadId, undefined, 'GET'));
  const stale = (await query('select content,status,data from chat_messages where id=$1', [staleId]))[0];
  check(stale.status === 'failed' && stale.content === '남은 토큰' && stale.data.code === 'RESPONSE_INTERRUPTED', 'expired pending recovery preserves partial content');
  console.log(`Assistant PostgreSQL/stream lifecycle: ${checks - before} assertions passed; external provider calls: 0`);
} finally {
  const files = await query('select storage from chat_attachments where student_id=any($1::uuid[])', [[student, other]]);
  await query('delete from chat_attachments where student_id=any($1::uuid[])', [[student, other]]);
  await query('delete from chat_threads where student_id=any($1::uuid[])', [[student, other]]);
  await query('delete from profiles where id=any($1::uuid[]) and email like $2', [[student, other], 'assistant-contract-%@gakja.test']);
  for (const file of files) if (file.storage.provider === 'local') await unlink(path.join(root, '.local/private-chat-files', file.storage.path)).catch(() => {});
  await pool.end();
}
