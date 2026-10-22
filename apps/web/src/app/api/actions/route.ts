import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { appOrigin, checkOrigin, hashPassword, requireStaff, requireUser } from '@/lib/auth';
import { getLearning } from '@/lib/data';
import { ApiError, errorResponse, query, transaction } from '@/lib/db';
import { normalizeSchedule, safeSourceURL, scheduleChanged, scheduleLabel, validateDateOnly, validateKSTDateTime } from '@/lib/schedule';
import { recordStudyEvent } from '@/lib/study-sessions';
import { memoryReviewOutcome, quizAnswerContext } from '@/lib/learning-record-rules';
import type { LearningData } from '@gakja/content-contracts';
import { chatCandidateProvenance } from '@/lib/answer-provenance';
import { assertRegisteredTargets, FINAL_GUIDEBOOK_CONTRACT, publicationDigest, validatePublication } from '@/lib/content-publication';
import {PRIVACY_POLICY_VERSION} from '@/lib/privacy-policy';

const text = (value: unknown, limit = 10_000) => { const str = String(value ?? '').trim(); if (str.length > limit) throw new ApiError(400, '입력 가능한 길이를 넘었어요.'); return str; };
const uuid = (value: unknown) => { const str = text(value, 100); if (!/^[0-9a-f-]{36}$/i.test(str)) throw new ApiError(400, '대상을 확인해 주세요.'); return str; };
async function audit(actor: string, student: string | null, action: string, data: unknown) { await query('insert into audit_logs(actor_id,student_id,action,data) values($1,$2,$3,$4)', [actor, student, action, JSON.stringify(data)]); }

const object = (value: unknown): Record<string, any> => {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(400, '자료 형식을 확인해 주세요.');
  return value as Record<string, any>;
};
function validated<T>(fn: () => T): T { try { return fn(); } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, error instanceof Error ? error.message : '입력을 확인해 주세요.'); } }
function sameData(a: unknown, b: unknown): boolean {
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
function editorialData(input: Record<string, any>, previous: Record<string, any>, kind: string) {
  const data = { ...previous, ...object(input.data) };
  for (const [requestKey, dataKey] of [['summary','summary'], ['discussionQuestion','discussion_question'], ['sourceURL','source_url'], ['sourceKind','source_kind'], ['publishedDate','published_date'], ['eventDate','event_date'], ['checkedAt','checked_at'], ['majorConnection','major_connection'], ['reviewNote','review_note'], ['facts','facts'], ['viewpoints','viewpoints'], ['concepts','concepts'], ['questions','questions'], ['sources','sources'], ['tags','tags'], ['university','university'], ['year','year'], ['documentType','document_type']]) {
    if (Object.hasOwn(input, requestKey)) data[dataKey] = input[requestKey];
  }
  const valueText = (value: unknown, label: string, max: number) => {
    if (value !== undefined && value !== null && typeof value !== 'string') throw new ApiError(400, `${label} 형식을 확인해 주세요.`);
    return text(value, max);
  };
  for (const [key, label, max] of [['summary','요약',8000], ['discussion_question','연습 질문',2000], ['source_kind','출처 유형',80], ['major_connection','전공 연결',4000], ['review_note','검수 메모',4000], ['university','대학',200], ['document_type','자료 유형',100]] as const) {
    if (Object.hasOwn(data, key)) data[key] = valueText(data[key], label, max);
  }
  if (!data.source_kind) data.source_kind = 'official';
  const sourceURL = valueText(data.source_url, '출처 URL', 2000);
  if (sourceURL && !safeSourceURL(sourceURL)) throw new ApiError(400, '출처 URL을 확인해 주세요.');
  data.source_url = sourceURL ? safeSourceURL(sourceURL) : '';
  for (const key of ['published_date','event_date','checked_at'] as const) {
    if (Object.hasOwn(data, key)) data[key] = validated(() => key === 'checked_at' && String(data[key] ?? '').includes('T') ? validateKSTDateTime(data[key], '확인 시각') : validateDateOnly(data[key], { published_date: '발행일', event_date: '사건일', checked_at: '확인일' }[key]));
  }
  if (Object.hasOwn(data, 'year') && data.year !== null && data.year !== '') {
    const year = Number(data.year); if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ApiError(400, '모집 연도를 확인해 주세요.'); data.year = year;
  } else if (Object.hasOwn(data, 'year')) data.year = null;
  for (const [key, max] of [['facts',3], ['viewpoints',8], ['concepts',12], ['questions',kind === 'briefing' ? 2 : 20], ['sources',15], ['tags',15]] as const) {
    if (!Object.hasOwn(data, key)) continue;
    if (!Array.isArray(data[key]) || data[key].length > max) throw new ApiError(400, `${{ facts: '핵심 사실', viewpoints: '서로 다른 관점', concepts: '연결 개념', questions: '연습 질문', sources: '출처', tags: '태그' }[key]}은 ${max}개 이내로 입력해 주세요.`);
    data[key] = data[key].map((entry: unknown) => {
      if (typeof entry === 'string') {
        const result = valueText(entry, '항목', 4000); if (!result) throw new ApiError(400, '빈 항목을 확인해 주세요.');
        if (key === 'sources') { if (!safeSourceURL(result)) throw new ApiError(400, '출처 URL을 확인해 주세요.'); return { url: safeSourceURL(result) }; }
        return result;
      }
      if (key === 'tags') throw new ApiError(400, '태그를 글자로 입력해 주세요.');
      const item = { ...object(entry) };
      for (const textKey of ['id','title','name','text','fact','stakeholder','viewpoint','concept','definition','prompt','source_id','quote','interpretation']) if (Object.hasOwn(item, textKey)) item[textKey] = valueText(item[textKey], '항목', 4000);
      for (const urlKey of ['url','source_url']) if (Object.hasOwn(item, urlKey)) { const raw = valueText(item[urlKey], '출처 URL', 2000); if (raw && !safeSourceURL(raw)) throw new ApiError(400, '출처 URL을 확인해 주세요.'); item[urlKey] = raw ? safeSourceURL(raw) : ''; }
      for (const dateKey of ['published_date','checked_at']) if (Object.hasOwn(item, dateKey)) item[dateKey] = validated(() => dateKey === 'checked_at' && String(item[dateKey] ?? '').includes('T') ? validateKSTDateTime(item[dateKey], '출처 확인 시각') : validateDateOnly(item[dateKey], '출처 날짜'));
      if (key === 'sources' && !item.url) throw new ApiError(400, '출처 URL을 입력해 주세요.');
      if (key !== 'sources' && !['text','fact','viewpoint','concept','definition','prompt','name'].some(k => item[k])) throw new ApiError(400, '항목 내용을 입력해 주세요.');
      if (item.source_ids && (!Array.isArray(item.source_ids) || item.source_ids.length > 15 || item.source_ids.some((id: unknown) => typeof id !== 'string' || id.length > 160))) throw new ApiError(400, '연결 출처를 확인해 주세요.');
      return item;
    });
  }
  const sourceIds = new Set((data.sources ?? []).map((source: any) => source.id).filter(Boolean));
  if (data.source_url) sourceIds.add('primary');
  for (const entry of [...(data.facts ?? []), ...(data.viewpoints ?? []), ...(data.questions ?? [])]) {
    if (typeof entry !== 'object') continue;
    if ((entry.source_id && !sourceIds.has(entry.source_id)) || (entry.source_ids ?? []).some((id: string) => !sourceIds.has(id))) throw new ApiError(400, '연결한 출처 ID를 확인해 주세요.');
  }
  if (JSON.stringify(data).length > 60000) throw new ApiError(400, '공용 자료 길이를 확인해 주세요.');
  return data;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(), url = new URL(request.url), questionId = url.searchParams.get('questionId');
    if(url.searchParams.has('briefingId')) {
      if(user.role!=='student')throw new ApiError(403,'학생 계정으로 이용해 주세요.');
      const briefingId=uuid(url.searchParams.get('briefingId'));
      const [briefing]=await query("select id from briefings where id=$1 and status='published' and (data->>'owner_student_id' is null or data->>'owner_student_id'=$2)",[briefingId,user.id]);
      if(!briefing)throw new ApiError(404,'발행된 브리핑을 찾을 수 없어요.');
      const [thought]=await query('select * from briefing_thoughts where student_id=$1 and briefing_id=$2',[user.id,briefingId]);
      const versions=thought?await query('select id,content,revision,created_at from briefing_thought_revisions where thought_id=$1 and student_id=$2 order by revision desc',[thought.id,user.id]):[];
      return Response.json({thought:thought||null,versions},{headers:{'Cache-Control':'private, no-store'}});
    }
    if (!questionId) throw new ApiError(400, '질문을 선택해 주세요.');
    const versions = await query('select r.* from answer_revisions r join user_answers a on a.id=r.answer_id where a.student_id=$1 and a.question_id=$2 order by r.revision desc', [user.id, questionId]);
    const comments = await query('select c.id,c.content,c.created_at,p.name as author_name from answer_comments c join user_answers a on a.id=c.answer_id join profiles p on p.id=c.author_id where a.student_id=$1 and a.question_id=$2 order by c.created_at desc', [user.id, questionId]);
    return Response.json({ versions, comments });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request); const user = await requireUser(); const { action, payload: input } = await request.json(); const p = input ?? {};
    if(action==='briefing_thought') {
      if(user.role!=='student')throw new ApiError(403,'학생 계정으로 작성해 주세요.');
      const briefingId=uuid(p.briefingId),content=text(p.content,8000);
      if(!content)throw new ApiError(400,'내 생각을 적어주세요.');
      if(!Number.isInteger(p.expectedRevision)||p.expectedRevision<0)throw new ApiError(400,'저장본을 확인해 주세요.');
      const thought=await transaction(async db=>{
        const [briefing]=(await db.query("select id from briefings where id=$1 and status='published' and (data->>'owner_student_id' is null or data->>'owner_student_id'=$2)",[briefingId,user.id])).rows;
        if(!briefing)throw new ApiError(404,'발행된 브리핑을 찾을 수 없어요.');
        await db.query('select pg_advisory_xact_lock(hashtext($1))',[`thought:${user.id}:${briefingId}`]);
        const [old]=(await db.query('select * from briefing_thoughts where student_id=$1 and briefing_id=$2 for update',[user.id,briefingId])).rows;
        if(old?.content===content)return old;
        if((old?.revision||0)!==p.expectedRevision)throw new ApiError(409,'다른 화면에서 수정했어요. 최신 저장본을 불러와 주세요.');
        const [saved]=(await db.query('insert into briefing_thoughts(student_id,briefing_id,content,revision) values($1,$2,$3,$4) on conflict(student_id,briefing_id) do update set content=excluded.content,revision=excluded.revision,updated_at=now() returning *',[user.id,briefingId,content,p.expectedRevision+1])).rows;
        await db.query('insert into briefing_thought_revisions(thought_id,student_id,content,revision) values($1,$2,$3,$4)',[saved.id,user.id,content,saved.revision]);
        return saved;
      });
      return Response.json({ok:true,thought});
    }
    if (action === 'save_answer') {
      if (user.role !== 'student') throw new ApiError(403, '학생 계정으로 작성해 주세요.');
      const questionId = text(p.questionId ?? p.question_id, 160), structure = text(p.structure), script = text(p.script);
      const { learning, package: pack } = await getLearning(user.id);
      if (!learning.questions.some((q: any) => q.id === questionId)) throw new ApiError(404, '발행된 질문을 찾을 수 없어요.');
      if (!Number.isInteger(p.expectedRevision) || p.expectedRevision < 0) throw new ApiError(400, '답변 버전을 확인해 주세요.');
      const answer = await transaction(async (db) => {
        await db.query('select pg_advisory_xact_lock(hashtext($1))', [`${user.id}:${questionId}`]);
        const assistance=await chatCandidateProvenance(db,user.id,{chatThreadId:p.chatThreadId,chatMessageId:p.chatMessageId,questionId,packageId:pack?.id,contentVersion:pack?.active_version});
        const existing = (await db.query('select * from user_answers where student_id=$1 and question_id=$2 for update', [user.id, questionId])).rows[0];
        if ((existing?.revision ?? 0) !== p.expectedRevision) throw new ApiError(409, '다른 화면에서 답변이 변경되었어요. 최신 답변을 다시 불러와 주세요.');
        const result = existing
          ? await db.query('update user_answers set structure=$1,script=$2,revision=revision+1,updated_at=now() where id=$3 returning *', [structure, script, existing.id])
          : await db.query('insert into user_answers(student_id,question_id,structure,script) values($1,$2,$3,$4) returning *', [user.id, questionId, structure, script]);
        const row = result.rows[0]; await db.query('insert into answer_revisions(answer_id,revision,structure,script,data) values($1,$2,$3,$4,$5)', [row.id, row.revision, structure, script,JSON.stringify({question:learning.questions.find((q:any)=>q.id===questionId),answerDesign:learning.answer_designs?.find((d:any)=>d.question_id===questionId),contentVersion:pack?.active_version,provenance:'saved_answer_content',...assistance})]); return row;
      });
      return Response.json({ ok: true, answer });
    }
    if (action === 'memory_attempt') {
      if (user.role !== 'student') throw new ApiError(403, '학생 계정으로 훈련해 주세요.');
      const memoryId = text(p.memoryItemId ?? p.memory_item_id, 160), rating = text(p.rating, 20);
      const { learning, package: pack } = await getLearning(user.id), item = learning.memory_items.find((m: any) => m.id === memoryId);
      if (!item) throw new ApiError(404, '암기 항목을 찾을 수 없어요.');
      const delay: Record<string, number> = { again: 10 * 60_000, hard: 24 * 60 * 60_000, good: 3 * 24 * 60 * 60_000, easy: 7 * 24 * 60 * 60_000 };
      if (!delay[rating]) throw new ApiError(400, '복습 결과를 선택해 주세요.');
      let correct: boolean | null = null;
      try {correct=memoryReviewOutcome(learning as LearningData,memoryId,p.answer);} catch(error){throw new ApiError(400,(error as Error).message);}
      const identity=quizAnswerContext(item,{},learning as LearningData);
      const attempt = await transaction(async db=>{
        const [saved] = (await db.query('insert into memory_attempts(student_id,memory_item_id,rating,data,due_at) values($1,$2,$3,$4,$5) returning *', [user.id, memoryId, rating, JSON.stringify({ answer: p.answer ?? null, correct, elapsed_seconds: p.elapsedSeconds ?? null, content_version: pack?.active_version, evaluation_method: correct!==null?'reviewed_correct_answer':'self_check',prompt:item.prompt,question_id:item.question_id }), new Date(Date.now() + delay[rating])])).rows;
        await recordStudyEvent(db,user.id,{kind:'memory_review',sourceId:saved.id,data:{memoryItemId:memoryId,questionId:identity.question_id,linkedQuestionId:identity.linked_question_id,practiceKind:identity.practice_kind,practicePrompt:identity.question,prompt:item.prompt,response:p.answer??null,outcome:correct,rating,verified:correct!==null,evaluationMethod:correct!==null?'reviewed_correct_answer':'self_check',contentVersion:pack?.active_version,sourceRefIds:item.source_ref_ids,dueAt:saved.due_at}});
        return saved;
      });
      return Response.json({ ok: true, attempt });
    }
    if (action === 'confirmation') {
      if (user.role !== 'student') throw new ApiError(403, '학생 계정으로 확인해 주세요.');
      if (p.id) {
        const response = text(p.response), state = ['confirmed','different','unknown','cannot_confirm'].includes(p.state) ? p.state : 'responded';
        if (!response && state === 'responded') throw new ApiError(400, '회신을 입력해 주세요.');
        const [confirmation] = await query('update student_confirmations set response=$1,state=$2,updated_at=now() where id=$3 and student_id=$4 returning *', [response, state, uuid(p.id), user.id]);
        if (!confirmation) throw new ApiError(404, '확인 요청을 찾을 수 없어요.');
        await audit(user.id, user.id, 'confirmation.response', { id: p.id, state }); return Response.json({ ok: true, confirmation });
      }
      const question = text(p.question ?? p.message, 2_000); if (!question) throw new ApiError(400, '확인할 내용을 입력해 주세요.');
      const entityId = text(p.entityId ?? p.entity_id, 160) || null;
      if (entityId) { const { learning } = await getLearning(user.id); if (![...learning.activities, ...learning.questions, ...learning.source_refs].some((x: any) => x.id === entityId)) throw new ApiError(404, '연결 자료를 찾을 수 없어요.'); }
      const [confirmation] = await query('insert into student_confirmations(student_id,entity_id,question,data) values($1,$2,$3,$4) returning *', [user.id, entityId, question, JSON.stringify({ source: 'student', is_correction: !!p.isCorrection })]);
      return Response.json({ ok: true, confirmation });
    }
    if (action === 'mark_read') {
      if (p.notificationId ?? p.id) await query('update notifications set read_at=now() where id=$1 and student_id=$2', [uuid(p.notificationId ?? p.id), user.id]);
      else if (p.all) await query('update notifications set read_at=now() where student_id=$1 and read_at is null', [user.id]);
      else if (p.documentKind && p.sectionId) {
        const { documents } = await getLearning(user.id), doc = documents.find((d: any) => d.kind === p.documentKind);
        if (!doc?.sections.some((s: any) => s.id === p.sectionId || s.children?.some((c: any) => c.id === p.sectionId))) throw new ApiError(404, '목차를 찾을 수 없어요.');
        await query('insert into reading_progress(student_id,document_kind,section_id) values($1,$2,$3) on conflict(student_id,document_kind) do update set section_id=excluded.section_id,updated_at=now()', [user.id, p.documentKind, p.sectionId]);
      }
      return Response.json({ ok: true });
    }
    if (action === 'preparation_state') {
      if (user.role !== 'student') throw new ApiError(403, '학생 계정으로 준비 상태를 저장해 주세요.');
      const entityId = text(p.entityId, 160), stage = text(p.stage, 30);
      if (!['read','answer','recall','speech','followup'].includes(stage)) throw new ApiError(400, '준비 단계를 확인해 주세요.');
      const { learning } = await getLearning(user.id);
      if (![...learning.activities, ...learning.questions, ...learning.memory_items].some((e: any) => e.id === entityId)) throw new ApiError(404, '연결 자료를 찾을 수 없어요.');
      const [state] = await query('insert into preparation_states(student_id,entity_id,stage,completed,source) values($1,$2,$3,$4,\'self_check\') on conflict(student_id,entity_id,stage) do update set completed=excluded.completed,source=excluded.source,updated_at=now() returning *', [user.id, entityId, stage, !!p.completed]);
      return Response.json({ ok: true, state });
    }
    if (action === 'preference') {
      const allowed = ['answerLength','explanationStyle','preparationNote','selectedTargetId','notificationsEnabled','helpEnabled','enterToSend','liveRecordingConsent','liveCameraEnabled','displayName'];
      const data = Object.fromEntries(Object.entries(p).filter(([key]) => allowed.includes(key)));
      if (Object.hasOwn(data,'notificationsEnabled') && typeof data.notificationsEnabled!=='boolean') throw new ApiError(400,'알림 설정을 확인해 주세요.');
      for(const key of ['helpEnabled','enterToSend','liveRecordingConsent','liveCameraEnabled']) {
        if(Object.hasOwn(data,key)&&typeof data[key]!=='boolean')throw new ApiError(400,'화면·입력·녹음 설정을 확인해 주세요.');
      }
      if (JSON.stringify(data).length > 5_000) throw new ApiError(400, '설정 길이를 확인해 주세요.');
      if (data.selectedTargetId) { const [target] = await query("select id from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null", [data.selectedTargetId, user.id]); if (!target) throw new ApiError(404, '지원처를 확인해 주세요.'); }
      const hasRecordingChoice=Object.hasOwn(data,'liveRecordingConsent');
      if(hasRecordingChoice&&p.policyVersion!==undefined&&p.policyVersion!==PRIVACY_POLICY_VERSION)throw new ApiError(400,'현재 개인정보 처리방침을 확인해 주세요.');
      if(hasRecordingChoice){data.liveRecordingPolicyVersion=p.policyVersion??null;data.liveRecordingConsentAt=new Date().toISOString();}
      const projection=[...allowed,'liveRecordingPolicyVersion','liveRecordingConsentAt'].map(key=>`'${key}',student_preferences.data->'${key}'`).join(',');
      const preferences=await transaction(async db=>{
        const [saved]=(await db.query(`insert into student_preferences(student_id,data) values($1,$2) on conflict(student_id) do update set data=student_preferences.data||excluded.data,updated_at=now() returning jsonb_strip_nulls(jsonb_build_object(${projection})) as data`,[user.id,JSON.stringify(data)])).rows;
        if(hasRecordingChoice)await db.query('insert into audit_logs(actor_id,student_id,action,data) values($1,$2,$3,$4)',[user.id,user.role==='student'?user.id:null,'recording.consent',JSON.stringify({granted:data.liveRecordingConsent,policyVersion:data.liveRecordingPolicyVersion,recordedAt:data.liveRecordingConsentAt,source:'live_recording_settings'})]);
        return saved;
      });
      return Response.json({ ok: true, preferences: preferences.data });
    }

    if (['invite','create_student'].includes(action)) {
      if (user.role !== 'admin') throw new ApiError(403, '관리자만 계정을 만들 수 있어요.');
      const email = text(p.email, 254).toLowerCase(), name = text(p.name, 80), role = ['student','staff'].includes(p.role) ? p.role : 'student';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) throw new ApiError(400, '이메일과 이름을 확인해 주세요.');
      const password = text(p.password || process.env.TEST_ACCOUNT_PASSWORD || '', 256);
      let id: string = randomUUID(), passwordHash: string | null = null;
      if (process.env.AUTH_MODE === 'supabase') {
        if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new ApiError(503, '관리자 인증 설정이 필요해요.');
        const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
        const result = action === 'invite' ? await supabase.auth.admin.inviteUserByEmail(email, { data: { name }, redirectTo: `${appOrigin(request)}/auth/callback?next=/invite` }) : await supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
        if (result.error || !result.data.user) throw new ApiError(400, result.error?.message ?? '계정을 만들지 못했어요.'); id = result.data.user.id;
      } else { if (password.length < 10) throw new ApiError(400, '비밀번호는 10자 이상 입력해 주세요.'); passwordHash = await hashPassword(password); }
      const [student] = await query('insert into profiles(id,email,name,role,password_hash) values($1,$2,$3,$4,$5) returning id,email,name,role,active', [id, email, name, role, passwordHash]);
      await audit(user.id, role === 'student' ? student.id : null, `account.${action}`, { email, role }); return Response.json({ ok: true, student });
    }
    if (action === 'assignments') {
      if (user.role !== 'admin') throw new ApiError(403, '관리자만 배정을 바꿀 수 있어요.');
      const studentId = uuid(p.studentId), staffId = uuid(p.staffId);
      const [student] = await query('select id from profiles where id=$1 and role=\'student\'', [studentId]); const [staff] = await query('select id from profiles where id=$1 and role=\'staff\' and active=true', [staffId]);
      if (!student || !staff) throw new ApiError(400, '학생과 담당자를 확인해 주세요.');
      if (p.remove) await query('delete from staff_assignments where staff_id=$1 and student_id=$2', [staffId, studentId]);
      else await query('insert into staff_assignments(staff_id,student_id,permissions) values($1,$2,$3) on conflict(staff_id,student_id) do update set permissions=excluded.permissions', [staffId, studentId, JSON.stringify(['import','publish','review'])]);
      await audit(user.id, studentId, 'assignment.update', { staffId, remove: !!p.remove }); return Response.json({ ok: true });
    }
    if (action === 'support_target') {
      const studentId = uuid(p.studentId); await requireStaff(studentId, 'import');
      const id = text(p.id, 160); if (!id) throw new ApiError(400, '연결 ID를 입력해 주세요.');
      const patch = object(p.data);
      if (JSON.stringify(patch).length > 60000) throw new ApiError(400, '지원 정보 길이를 확인해 주세요.');
      const result = await transaction(async db => {
        await db.query('select pg_advisory_xact_lock(hashtext($1))', [`support_target:${id}`]);
        const existing = (await db.query('select * from support_targets where id=$1 for update', [id])).rows[0];
        if (existing && existing.student_id !== studentId) throw new ApiError(409, '다른 학생에게 연결된 ID예요.');
        const before = existing?.data ?? {}, next = { ...before, ...patch };
        delete next.student_id; delete next.created_at; next.id = id;
        let changed = false;
        if (Object.hasOwn(patch, 'schedule')) {
          if (p.expectedRevision !== undefined && p.expectedRevision !== (before.schedule?.revision ?? 0)) throw new ApiError(409, '일정이 변경되었어요. 최신 일정을 다시 불러와 주세요.');
          const schedule = validated(() => normalizeSchedule(patch.schedule, before.schedule));
          const legacyDate = typeof before.interview_date === 'string' ? before.interview_date : typeof before.interview_at === 'string' ? before.interview_at : null;
          const comparison = before.schedule ?? { personal_date: legacyDate?.slice(0, 10) ?? null, personal_at: legacyDate?.includes('T') ? validated(() => validateKSTDateTime(legacyDate)) : null };
          changed = scheduleChanged(comparison, schedule);
          const previousSchedule = before.schedule ?? {};
          const { revision: _revision, reviewed_by: _reviewer, updated_at: _updated, ...previousFields } = previousSchedule;
          const scheduleEdited = !sameData(previousFields, schedule);
          next.schedule = { ...schedule, revision: (previousSchedule.revision ?? 0) + (scheduleEdited ? 1 : 0), reviewed_by: schedule.status === 'reviewed' ? user.id : previousSchedule.reviewed_by ?? null, updated_at: scheduleEdited ? new Date().toISOString() : previousSchedule.updated_at };
          next.interview_date = schedule.personal_at || schedule.personal_date;
        }
        const target = (await db.query('insert into support_targets(id,student_id,data) values($1,$2,$3) on conflict(id) do update set data=excluded.data returning *', [id, studentId, JSON.stringify(next)])).rows[0];
        await db.query('insert into audit_logs(actor_id,student_id,action,data) values($1,$2,$3,$4)', [user.id, studentId, 'support_target.update', JSON.stringify({ id, before, after: next, schedule_changed: changed })]);
        if (changed) await db.query('insert into notifications(student_id,title,body,href) values($1,$2,$3,$4)', [studentId, '면접 일정이 변경되었어요', `${next.university ?? next.university_name ?? '지원처'} · ${scheduleLabel(next)}`, '/my']);
        return { target: { ...target.data, id: target.id, student_id: target.student_id }, scheduleChanged: changed };
      });
      return Response.json({ ok: true, ...result });
    }
    if (action === 'production_link') {
      const studentId = uuid(p.studentId); await requireStaff(studentId, 'import');
      const id = text(p.id, 160); if (!id) throw new ApiError(400, '연결 ID를 입력해 주세요.');
      const table = action === 'production_link' ? 'production_links' : 'support_targets';
      const [existing] = await query(`select student_id from ${table} where id=$1`, [id]);
      if (existing && existing.student_id !== studentId) throw new ApiError(409, '다른 학생에게 연결된 ID예요.');
      await query(`insert into ${table}(id,student_id,data) values($1,$2,$3) on conflict(id) do update set data=excluded.data`, [id, studentId, JSON.stringify(p.data ?? {})]);
      await audit(user.id, studentId, `${action}.update`, { id }); return Response.json({ ok: true });
    }
    if (action === 'preview_confirm') {
      const versionId = uuid(p.versionId);
      const [version] = await query('select v.*,c.student_id from content_versions v join content_packages c on c.id=v.package_id where v.id=$1', [versionId]);
      if (!version) throw new ApiError(404, '등록 자료를 찾을 수 없어요.');
      await requireStaff(version.student_id, 'review');
      const confirmed = await transaction(async db => {
        await db.query('select id from content_packages where id=$1 for update', [version.package_id]);
        const locked = (await db.query('select v.*,c.student_id from content_versions v join content_packages c on c.id=v.package_id where v.id=$1 for update of v', [versionId])).rows[0];
        if (locked.status !== 'staged') throw new ApiError(409, '발행 대기 중인 자료만 미리보기 확인을 할 수 있어요.');
        const documents = (await db.query('select id,kind,data,html,file_hash from documents where package_id=$1 and content_version=$2 order by kind for update', [locked.package_id, locked.version])).rows;
        validatePublication(locked, documents);
        const digest = publicationDigest(locked, documents);
        if (p.digest !== digest) throw new ApiError(409, '미리보기와 현재 교재가 달라요. 교재 미리보기를 다시 열어 주세요.');
        const confirmation = { digest, confirmed_at: new Date().toISOString(), confirmed_by: user.id };
        await db.query('update content_versions set review=review||$1::jsonb where id=$2', [JSON.stringify({ preview_confirmation: confirmation }), versionId]);
        await db.query('insert into audit_logs(actor_id,student_id,action,data) values($1,$2,$3,$4)', [user.id, locked.student_id, 'content.preview.confirmed', JSON.stringify({ versionId, ...confirmation })]);
        return confirmation;
      });
      return Response.json({ ok: true, preview_confirmation: confirmed });
    }
    if (action === 'publish' || action === 'rollback') {
      const versionId = p.versionId ?? p.id;
      const [version] = await query('select v.*,c.student_id,c.active_version from content_versions v join content_packages c on c.id=v.package_id where v.id=$1', [uuid(versionId)]);
      if (!version) throw new ApiError(404, '등록된 버전을 찾을 수 없어요.'); await requireStaff(version.student_id, 'publish');
      await transaction(async (db) => {
        await db.query('select id from profiles where id=$1 for update', [version.student_id]);
        await db.query('select id from content_packages where id=$1 for update', [version.package_id]);
        const locked = (await db.query('select v.*,c.student_id,c.active_version from content_versions v join content_packages c on c.id=v.package_id where v.id=$1 for update of v', [version.id])).rows[0];
        if (action === 'rollback' && locked.status !== 'published') throw new ApiError(400, '발행했던 버전으로만 복귀할 수 있어요.');
        if (action === 'publish' && locked.status === 'rejected') throw new ApiError(400, '반려된 등록은 발행할 수 없어요.');
        const docs = (await db.query('select id,kind,data,html,file_hash from documents where package_id=$1 and content_version=$2 order by kind for update', [locked.package_id, locked.version])).rows;
        validatePublication(locked, docs);
        if (action === 'publish' && locked.review?.import_contract === FINAL_GUIDEBOOK_CONTRACT) {
          if (!locked.review?.preview_confirmation?.confirmed_at || locked.review.preview_confirmation.digest !== publicationDigest(locked, docs)) throw new ApiError(409, '교재 미리보기를 확인한 뒤 발행해 주세요.');
          const targets = (await db.query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null order by id for update", [locked.student_id])).rows;
          assertRegisteredTargets(locked.data, targets);
        }
        await db.query('update content_versions set status=\'published\',published_by=$1,published_at=coalesce(published_at,now()),review=review||$2::jsonb where id=$3', [user.id, JSON.stringify({ publish_note: text(p.note, 2000) }), version.id]);
        await db.query('update content_packages set active_version=$1 where id=$2', [version.version, version.package_id]);
        // School registrations and schedules are owned by their own workflows.
        // Book analysis is read from this content version, including on historical rollback.
        await db.query('insert into notifications(student_id,title,body,href) values($1,$2,$3,$4)', [version.student_id, action === 'rollback' ? '이전 자료로 복귀했어요' : '새 자료가 도착했어요', `콘텐츠 v${version.version}`, '/materials/guidebook']);
        await db.query('insert into audit_logs(actor_id,student_id,action,data) values($1,$2,$3,$4)', [user.id, version.student_id, `content.${action}`, JSON.stringify({ packageId: version.package_id, version: version.version, previous: locked.active_version })]);
      }); return Response.json({ ok: true, version: version.version });
    }
    if (action === 'review') {
      const studentId = uuid(p.studentId); await requireStaff(studentId, 'review');
      if (p.confirmationId) {
        const [confirmation] = await query('update student_confirmations set state=$1,reviewed_by=$2,data=data||$3::jsonb,updated_at=now() where id=$4 and student_id=$5 returning *', [['reviewed','needs_revision','rejected'].includes(p.state) ? p.state : 'reviewed', user.id, JSON.stringify({ review_note: text(p.note, 4000), accepted_for_next_revision: !!p.accepted }), uuid(p.confirmationId), studentId]);
        if (!confirmation) throw new ApiError(404, '확인 요청을 찾을 수 없어요.');
      } else if (p.answerId) {
        const [answer] = await query('select id from user_answers where id=$1 and student_id=$2', [uuid(p.answerId), studentId]); if (!answer) throw new ApiError(404, '답변을 찾을 수 없어요.');
        const note = text(p.note, 4000); if (!note) throw new ApiError(400, '코멘트를 입력해 주세요.');
        await query('insert into answer_comments(answer_id,student_id,author_id,content) values($1,$2,$3,$4)', [answer.id, studentId, user.id, note]);
      } else if (p.versionId) {
        const [version] = await query('update content_versions v set review=review||$1::jsonb,status=case when $2 then \'rejected\' else status end from content_packages c where v.id=$3 and c.id=v.package_id and c.student_id=$4 and (not $2::boolean or v.status<>\'published\') returning v.id', [JSON.stringify({ note: text(p.note, 4000), reviewer: user.id }), !!p.reject, uuid(p.versionId), studentId]); if (!version) throw new ApiError(409, '발행본은 반려할 수 없어요. 발행 대기 자료를 선택하거나 새 버전을 등록해 주세요.');
      } else throw new ApiError(400, '검토 대상을 선택해 주세요.');
      await audit(user.id, studentId, 'review.completed', { confirmationId: p.confirmationId, answerId: p.answerId, versionId: p.versionId }); return Response.json({ ok: true });
    }
    if (action === 'notification') {
      const studentId = uuid(p.studentId); await requireStaff(studentId, 'review');
      const title = text(p.title, 200), body = text(p.body, 2000), href = text(p.href, 500) || '/my';
      if (!title || !href.startsWith('/') || href.startsWith('//')) throw new ApiError(400, '알림 제목과 이동 경로를 확인해 주세요.');
      const [notification] = await query('insert into notifications(student_id,title,body,href) values($1,$2,$3,$4) returning *', [studentId, title, body, href]);
      await audit(user.id, studentId, 'notification.created', { id: notification.id }); return Response.json({ ok: true, notification });
    }
    if (action === 'briefing' || action === 'knowledge_release') {
      if (user.role !== 'admin') throw new ApiError(403, '공용 자료는 관리자가 검수해 주세요.');
      const table = action === 'briefing' ? 'briefings' : 'knowledge_releases';
      const item = await transaction(async db => {
        const existing = p.id ? (await db.query(`select * from ${table} where id=$1 for update`, [uuid(p.id)])).rows[0] : null;
        if (p.id && !existing) throw new ApiError(404, '자료를 찾을 수 없어요.');
        if (p.expectedRevision !== undefined && p.expectedRevision !== (existing?.data?.revision ?? 0)) throw new ApiError(409, '자료가 변경되었어요. 최신 자료를 다시 불러와 주세요.');
        const title = text(p.title ?? existing?.title, 200), category = text(p.category ?? existing?.category, 100);
        const status = p.status ?? existing?.status ?? 'draft';
        if (!title) throw new ApiError(400, '제목을 입력해 주세요.');
        if (!['draft','published'].includes(status)) throw new ApiError(400, '발행 상태를 확인해 주세요.');
        const data = editorialData(p, existing?.data ?? {}, action);
        if (status === 'published' && (!data.source_url || !data.checked_at)) throw new ApiError(400, '발행 전에 출처와 확인일을 입력해 주세요.');
        if (status === 'published' && action === 'knowledge_release' && (!data.university || !data.year)) throw new ApiError(400, '발행 전에 대학과 모집 연도를 입력해 주세요.');
        const { revision: _revision, reviewed_by: _reviewer, reviewed_at: _reviewed, ...content } = data;
        const oldContent = { ...(existing?.data ?? {}) }; delete oldContent.revision; delete oldContent.reviewed_by; delete oldContent.reviewed_at;
        const edited = !existing || existing.title !== title || existing.category !== category || existing.status !== status || !sameData(oldContent, content);
        const revision = (existing?.data?.revision ?? 0) + (edited ? 1 : 0);
        const next = { ...content, revision, reviewed_by: status === 'published' ? user.id : existing?.data?.reviewed_by ?? null, reviewed_at: status === 'published' && edited ? new Date().toISOString() : existing?.data?.reviewed_at ?? null };
        const result = existing
          ? await db.query(`update ${table} set title=$1,category=$2,data=$3,status=$4 where id=$5 returning *`, [title, category, JSON.stringify(next), status, existing.id])
          : await db.query(`insert into ${table}(title,category,data,status,created_by) values($1,$2,$3,$4,$5) returning *`, [title, category, JSON.stringify(next), status, user.id]);
        const row = result.rows[0];
        await db.query('insert into audit_logs(actor_id,student_id,action,data) values($1,$2,$3,$4)', [user.id, null, `${action}.${status}`, JSON.stringify({ id: row.id, revision, changed: edited, before: existing ? { title: existing.title, category: existing.category, status: existing.status, data: existing.data } : null, after: { title, category, status, data: next } })]);
        return row;
      });
      return Response.json({ ok: true, item });
    }
    if (action === 'deactivate') {
      if (user.role !== 'admin') throw new ApiError(403, '관리자만 계정을 비활성화할 수 있어요.');
      const studentId = uuid(p.studentId); if (studentId === user.id) throw new ApiError(400, '본인 관리자 계정은 유지해 주세요.');
      await transaction(async (db) => { await db.query('update profiles set active=$1,updated_at=now() where id=$2', [p.active === true, studentId]); if (!p.active) await db.query('delete from sessions where user_id=$1', [studentId]); });
      await audit(user.id, studentId, 'account.active', { active: p.active === true }); return Response.json({ ok: true });
    }
    throw new ApiError(400, '처리할 작업을 확인해 주세요.');
  } catch (error) { return errorResponse(error); }
}
