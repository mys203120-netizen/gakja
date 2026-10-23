import {getStudentRecords} from '@/lib/student-records';
import {INTERVIEW_CHARACTERS,INTERVIEW_POLICY_VERSION,interviewPolicy,interviewPressureForStart,interviewEvaluationEvidence,generatedInterviewQuestion} from '@/lib/interview-policy';
import {parseInterviewFeedback,INTERVIEW_RUBRIC_PROMPT,interviewGuidelineInstruction} from '@/lib/interview-feedback';
import {after} from 'next/server';
import {interviewCompletion} from '@/lib/interview-completion';
import { stoppedInterviewTimer, settledInterviewTimer, renewInterviewTimer, INTERVIEW_LEASE_MS } from '@/lib/interview-timer';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireUser, checkOrigin } from '@/lib/auth';
import { query, transaction } from '@/lib/db';
import { recordStudyEvent } from '@/lib/study-sessions';
import { assistanceEvidence } from '@/lib/assistance-records';
import { snapshotSpeechAnswer } from '@/lib/transcript-provenance';
import { ownedInterviewTranscriptSelection } from '@/lib/interview-transcript-selection';
import { ownedInterviewHelpScope, recordInterviewHelp } from '@/lib/interview-assistance';
import { getSchoolProfile } from '@/lib/learning-workflows';
import { referenceSchoolProfile } from '@/lib/school-learning';
import { neutralReaction } from '@/lib/interviewer-reaction';
import {interviewPracticeForContext,isStudentRecordQuestion} from '@/lib/school-interview-scope';
import {recordMatchesCurrentTarget} from '@/lib/learning-target-scope';
import { aiEnabled, assertPublishedAccess, coach, entityText, FeatureError, featureError, getLearningContext, interviewQuestions, normalizeMode, planRootQuestions, PROMPT_VERSION, requireStudent, selfCheckReport, type LearningContext } from '@/lib/ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const inputSchema = z.object({
  action: z.enum(['start', 'answer', 'answer_recording', 'finish', 'report_feedback', 'cancel', 'transcript', 'use_transcript', 'pause', 'resume', 'draft', 'settings', 'help', 'heartbeat', 'suspend','retry']), sessionId: z.string().uuid().optional(),
  sessionMode:z.enum(['practice','real']).default('practice'),
  kind: z.enum(['chat', 'video']).default('chat'), mode: z.string().max(40).default('basic'), targetId: z.string().max(160).nullish(), questionId: z.string().max(160).nullish(),
  briefingId: z.string().uuid().nullish(), briefingQuestionIndex: z.number().int().min(0).max(10).optional(),
  experienceCardId:z.string().uuid().optional(), experienceRevision:z.coerce.number().int().positive().optional(),
  activityId: z.string().min(1).max(160).nullish(),
  sourceVersion: z.coerce.number().int().min(1).max(100000).optional(),
  sourceType:z.enum(['personal','common']).optional(),
  assisted:z.boolean().optional(), helpKind:z.enum(['evidence','video']).optional(),
  followups: z.boolean().optional(), pressure: z.boolean().optional(), interviewerReactions: z.boolean().optional(), panelistCount: z.number().int().min(1).max(5).optional(), draft: z.string().max(12000).optional(), difficulty: z.union([z.enum(['standard', 'deep', 'basic', 'easy', 'advanced']), z.number().int().min(1).max(4)]).optional(),
  feedbackTiming: z.enum(['turn', 'end', 'each']).default('end'), answer: z.string().trim().max(12000).optional(),
  transcript: z.string().trim().max(12000).optional(), turnId: z.string().uuid().optional(), mediaId:z.string().uuid().optional(),requestId: z.string().min(8).max(100).optional(),
  questionCount: z.number().int().min(1).max(8).optional(),
  questionIds:z.array(z.string().min(1).max(200)).min(1).max(8).optional(),trainingPlanId:z.string().uuid().optional(),trainingPurpose:z.enum(['diagnostic','recall','focus','mixed']).optional(),trainingImprovement:z.string().trim().min(1).max(500).optional(),
  generation:z.number().int().nonnegative().optional(),discardDraft:z.boolean().optional(),
});
function json(value: unknown, status = 200) { return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store' } }); }
function turnView(turn: Record<string, any>) { return { ...turn, ...turn.data, question_id: turn.question_id }; }
function publicTurnView(turn:Record<string,any>,session:Record<string,any>){const value=turnView(turn);if(session.state==='active'&&interviewPolicy(session.data).feedbackTiming==='end'){value.feedback=null;value.evaluation=null;value.data={...value.data,feedback:null,evaluation:null};}return value;}
function sessionView(session: Record<string, any>) {
  const { context, questionQueue: _queue, ...rawData } = session.data || {};
  const data = {...rawData,questionCount:Array.isArray(_queue)?_queue.length:0,...settledInterviewTimer(rawData)};
  // Return only the owning student's fixed learning resources; internal student facts,
  // identity, selection history, and AI processing context stay on the server.
  const resources=context ? {sourceKind:context.sourceKind||'personal',contentVersion:context.contentVersion,targetSnapshotStale:Boolean(context.targetSnapshotStale),targetId:context.targetId,activityId:context.activityId,questionId:context.questionId,briefingId:context.briefingId||null,
    questions:context.questions||[],activities:context.activities||[],sources:context.sources||[],answerScripts:context.answerScripts||[],briefing:context.briefing||null} : null;
  if(resources&&session.state==='active'&&interviewPolicy(data).mode==='real'){resources.questions=[];resources.activities=[];resources.sources=[];resources.answerScripts=[];resources.briefing=null;}
  return { ...session, supportTarget: context?.target || null, sourceKind:context?.sourceKind || 'personal', practiceLabel:data.practiceScope==='personal_record'?'일반 경험 면접':context?.sourceKind === 'common' ? '일반 연습' : data.schoolPracticeOnly ? '연습 설정' : null, data:{...data,context:resources} };
}
function reportView(report: Record<string, any>) { return report ? { ...report, ...report.data } : null; }
const stoppedTimer = stoppedInterviewTimer;
function questionView(turn: Record<string, any> | undefined) { return turn ? { id: turn.question_id, rootQuestionId: turn.data.rootQuestionId || turn.question_id, prompt: turn.data.question, turnId: turn.id, speakerId: turn.data.speakerId || 'A', questionKind: turn.data.questionKind, draft: turn.data.draft || '' } : null; }
function panelists(_count: number) { return INTERVIEW_CHARACTERS.map(person=>({...person})); }
function rootTurn(question: Record<string, any>, index: number, settings: Record<string, any>) {
  const activity = settings.context.activities.find((item: Record<string, any>) => (question.activity_ids || []).includes(item.id));
  const carriedHelp=Boolean(settings.assisted&&index===0||settings.experienceCard?.data?.writingAssistance?.length);
  const prompt=entityText(question as any,'prompt');
  return { question: prompt, rootQuestionId: question.id, questionKind: settings.pressure ? 'verification' : question.common_revision ? 'common_practice' : 'published', answer: null, feedback: null, contentVersion: settings.context.contentVersion, sourceType:question.source_type || 'personal', sourceSnapshot:question.source_snapshot || null, commonRevision:question.common_revision || null, practiceLabel:question.practice_label || null, answerElements: question.answer_elements || [], sourceIds: question.source_ref_ids || [], rootIndex: index, followupDepth: 0, speakerId: settings.panelists[index % settings.panelists.length].id, assisted:carriedHelp, assistance_recorded:true, helpKinds:carriedHelp?['carried_help']:[], draft: '' };
}
async function schoolProfile(studentId: string, targetId: string | null) {
  if (!targetId) return null;
  return (await getSchoolProfile(studentId, targetId)) || referenceSchoolProfile(studentId, targetId);
}
async function sessionFor(studentId: string, sessionId?: string) {
  if (!sessionId) throw new FeatureError(400, '면접 기록을 선택해 주세요.', 'SESSION_ID_REQUIRED');
  const [session] = await query('select * from interview_sessions where id=$1 and student_id=$2', [sessionId, studentId]);
  if (!session) throw new FeatureError(404, '면접 기록을 찾을 수 없어요.', 'SESSION_NOT_FOUND');
  await assertPublishedAccess(studentId, session.data.context);
  return session;
}

async function ownedExperience(studentId:string,id?:string|null,revision?:string|number|null){
 if(!id)return null;
 z.string().uuid().parse(id);
 const [card]=await query('select id,data,revision from experience_cards where id=$1 and student_id=$2',[id,studentId]);
 if(!card)throw new FeatureError(404,'경험 카드를 찾을 수 없어요.');
 if(!card.data.confirmed)throw new FeatureError(409,'상황과 내 행동을 확인한 뒤 연습해 주세요.');
 if(!revision || Number(revision)!==card.revision)throw new FeatureError(409,'카드가 수정됐어요. 내 경험에서 다시 연습을 시작해 주세요.');
 return card;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(); requireStudent(user);
    const url = new URL(request.url);
    if (url.searchParams.get('preview') === '1') {
      const sourceType = url.searchParams.get('sourceType') ? z.enum(['personal','common']).parse(url.searchParams.get('sourceType')) : undefined;
      const context = await getLearningContext(user.id,{targetId:url.searchParams.get('targetId'),activityId:url.searchParams.get('activityId'),questionId:url.searchParams.get('questionId'),briefingId:url.searchParams.get('briefingId'),sourceVersion:url.searchParams.get('sourceVersion'),sourceType,allowCommon:true});
      const practice=interviewPracticeForContext({...context,sourceKind:sourceType==='common'?'common':context.sourceKind});
      let question = context.questions.find(q => q.id === context.questionId) || null;
      if(context.briefing) {
        const raw = context.briefing.questions || context.briefing.discussion_questions || context.briefing.interview_questions || [context.briefing.discussion_question];
        const prompts = Array.isArray(raw) ? raw.map(item => typeof item === 'string' ? item : item && typeof item === 'object' ? String(item.question || item.prompt || item.text || '') : '').filter(Boolean) : [];
        const index = z.coerce.number().int().min(0).max(10).parse(url.searchParams.get('briefingQuestionIndex') || 0);
        if(!prompts[index]) throw new FeatureError(409,'발행된 브리핑 질문을 선택해 주세요.','BRIEFING_QUESTION_REQUIRED');
        question = {id:`briefing_${context.briefing.id}_${index}`,prompt:prompts[index],briefing_id:context.briefing.id};
      }
      const experienceCard = await ownedExperience(user.id,url.searchParams.get('experienceCardId'),url.searchParams.get('experienceRevision'));
      return json({experienceCard,question,questions:practice.questions,activities:context.activities,sources:context.sources,contentVersion:context.contentVersion,sourceKind:practice.scope==='personal_record'?'personal':context.sourceKind || 'personal',practiceAllowed:practice.allowed&&!(practice.scope==='personal_record'&&sourceType==='common'),practiceScope:practice.scope,practiceLabel:practice.label,practiceNotice:practice.notice,targetSnapshotStale:Boolean(context.targetSnapshotStale),supportTarget:context.target});
    }
    const sessionId = url.searchParams.get('id');
    if(!sessionId){const params=new URLSearchParams(url.searchParams);params.set('kind','interviews');const result=await getStudentRecords(user.id,params);return json({sessions:'items' in result?result.items:[],page:'page' in result?result.page:null});}
    z.string().uuid().parse(sessionId);
    const session = await sessionFor(user.id, sessionId);
    if (session.data.processing && Date.now() - Number(session.data.processingAt || 0) > 120000) {
      await query("update interview_sessions set data=data-'processing'-'processingAt',updated_at=now() where id=$1 and student_id=$2", [sessionId, user.id]);
      delete session.data.processing; delete session.data.processingAt;
    }
    const [turns, reports, media] = await Promise.all([
      query('select * from interview_turns where session_id=$1 and student_id=$2 order by created_at,id', [sessionId, user.id]),
      query('select * from interview_reports where session_id=$1 and student_id=$2', [sessionId, user.id]),
      query('select id,session_id,mime,text,metadata,created_at from media_assets where session_id=$1 and student_id=$2 order by created_at', [sessionId, user.id]),
    ]);
    const current = [...turns].reverse().find((turn) => !turn.data.answer && !turn.data.invalidated);
    session.data={...session.data,trainingProgress:interviewCompletion(session.data,turns)};
    return json({ session: sessionView(session), turns: turns.map(turn=>publicTurnView(turn,session)), question: session.data.processing ? null : questionView(current), report: reportView(reports[0]), media: media.map((item) => ({ ...item, url: `/api/media?id=${item.id}` })), aiAvailable: aiEnabled() });
  } catch (error) { const result = featureError(error); return json({ error: result.error, code: result.code }, result.status); }
}

export async function POST(request: Request) {
  try {
    checkOrigin(request); const user = await requireUser(); requireStudent(user);
    const input = inputSchema.parse(await request.json());
    if (input.action === 'start') {
      if(input.sessionMode==='real'&&(input.kind!=='video'||input.assisted))throw new FeatureError(400,'실전은 도움 없이 화상 면접으로 시작해 주세요.','REAL_INTERVIEW_POLICY');
      let trainingPlan:Record<string,any>|undefined;
      if(input.trainingPlanId){
        if(input.requestId){const [previous]=await query("select * from interview_sessions where student_id=$1 and request_id=$2 and data->>'trainingPlanId'=$3",[user.id,input.requestId,input.trainingPlanId]);if(previous){const previousTurns=await query('select * from interview_turns where session_id=$1 and student_id=$2 order by created_at,id',[previous.id,user.id]);const current=[...previousTurns].reverse().find(turn=>!turn.data.answer&&!turn.data.invalidated);return json({session:sessionView(previous),turn:current?turnView(current):null,question:questionView(current),aiAvailable:aiEnabled()});}}
        [trainingPlan]=await query("select id,target,completed,to_char(planned_date,'YYYY-MM-DD') as date from student_plans where id=$1 and student_id=$2",[input.trainingPlanId,user.id]);
        if(!trainingPlan?.target?.automaticPractice?.hybrid||trainingPlan.target.automaticPractice.status==='superseded'||trainingPlan.target.targetId!==input.targetId||trainingPlan.target.sourceType!==input.sourceType||Number(trainingPlan.target.sourceVersion)!==Number(input.sourceVersion))throw new FeatureError(409,'오늘 계획과 같은 지원처·자료로 시작해 주세요.','TRAINING_PLAN_MISMATCH');
        const kind=trainingPlan.target.automaticPractice.hybrid.kind,today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
        if(trainingPlan.completed||trainingPlan.date!==today||!trainingPlan.target.automaticPractice.startedAt||!['diagnostic','recall','focus','mixed'].includes(kind)||kind!=='diagnostic'&&input.questionId!==trainingPlan.target.id||input.questionIds&&kind!=='diagnostic')throw new FeatureError(409,'오늘 계획에서 해당 훈련을 시작해 주세요.','TRAINING_PLAN_MISMATCH');
        const [school]=await query("select data from support_targets where id=$1 and student_id=$2 and nullif(data->>'archived_at','') is null",[input.targetId,user.id]);
        if(!school||!recordMatchesCurrentTarget({targetId:input.targetId,targetSnapshot:trainingPlan.target.targetSnapshot},[{...school.data,id:input.targetId}]))throw new FeatureError(409,'지원 정보가 바뀌었어요. 오늘 계획을 다시 확인해 주세요.','TRAINING_PLAN_MISMATCH');
      }
      const context = await getLearningContext(user.id, { ...input, allowCommon:true });
      const practice=interviewPracticeForContext({...context,sourceKind:input.sourceType==='common'?'common':context.sourceKind});
      if(!practice.allowed||practice.scope==='personal_record'&&input.sourceType==='common')throw new FeatureError(409,practice.notice||'지원 전형의 면접 방식을 확인해 주세요.','INTERVIEW_OUT_OF_SCOPE');
      const personalPractice=practice.scope==='personal_record';
      const requestedMode=normalizeMode(input.mode);
      const mode=personalPractice&&requestedMode==='university'?'basic':requestedMode;
      if(personalPractice)Object.assign(context,{questions:practice.questions,sourceKind:'personal',schoolTalent:null,majorContext:null,practiceScope:practice.scope,practiceNotice:practice.notice});
      const experienceCard = await ownedExperience(user.id,input.experienceCardId,input.experienceRevision);
      if(experienceCard) context.studentContext={...context.studentContext,student_reported_experience:{...experienceCard.data,notice:'학생이 직접 작성하고 확인한 진술. 승인된 학생부 사실이 아니며, 현재 답변과 충돌하면 확인할 것.'}};
      let candidates = context.briefing && !context.questions.length ? [] : interviewQuestions(context, mode, input.questionId || undefined).filter((q) => !q.parent_question_id && !q.parent_answer_id&&isStudentRecordQuestion(q));
      if(input.questionId&&!candidates.some(question=>question.id===input.questionId))throw new FeatureError(409,'이 앱에서는 학생부형 면접 질문을 연습할 수 있어요.','QUESTION_OUT_OF_SCOPE');
      if (context.briefing) {
        const raw = context.briefing.questions || context.briefing.discussion_questions || context.briefing.interview_questions || [context.briefing.discussion_question];
        const prompts = Array.isArray(raw) ? raw.map(item => typeof item === 'string' ? item : item && typeof item === 'object' ? String(item.question || item.prompt || item.text || '') : '').filter(Boolean) : [];
        const selectedPrompt = prompts[input.briefingQuestionIndex || 0];
        if (!selectedPrompt) throw new FeatureError(409, '발행된 브리핑 질문을 선택해 주세요.', 'BRIEFING_QUESTION_REQUIRED');
        candidates = [{ id: `briefing_${context.briefing.id}_${input.briefingQuestionIndex || 0}`, prompt: selectedPrompt, question_types: ['current_affairs'], grounding_types: ['published_briefing'], source_ref_ids: [context.briefing.id], support_target_ids: context.targetId ? [context.targetId] : [], briefing_id: context.briefing.id, allocation_bucket: 'current_affairs' }, ...candidates];
      }
      if (!candidates.length) throw new FeatureError(409, '연습할 본 질문이 아직 없어요.', 'NO_ROOT_QUESTIONS');
      const profile = personalPractice||context.targetSnapshotStale ? null : await schoolProfile(user.id, context.targetId);
      const distribution = profile?.data?.question_distribution;
      const approvedDistribution = distribution?.basis === 'official' && profile?.status !== 'official_confirmed' ? null : distribution || null;
      if(input.questionIds&&(new Set(input.questionIds).size!==input.questionIds.length||input.questionIds.some(id=>!candidates.some(question=>question.id===id))))throw new FeatureError(409,'현재 지원처에서 사용할 수 있는 진단 질문을 선택해 주세요.','TRAINING_QUESTIONS_MISMATCH');
      const selection = input.questionIds ? planRootQuestions(input.questionIds.map(id=>candidates.find(question=>question.id===id)!),input.questionIds.length,null,input.questionIds[0]) : planRootQuestions(candidates, input.questionCount || (input.questionId || context.briefing ? 1 : 5), approvedDistribution, context.briefing ? candidates[0].id : input.questionId || undefined);
      const questions = selection.questions;
      const verified = profile?.status === 'official_confirmed';
      const supported = !profile || !profile.data?.format || ['document_individual', 'document', 'document_based', '서류기반'].includes(profile.data.format);
      const formalRange = verified && supported ? profile.data?.interviewer_count : null;
      const range = formalRange?.min <= 5 ? { min: formalRange.min, max: Math.min(formalRange.max, 5) } : null;
      const requestedCount = input.panelistCount || range?.min || profile?.data?.training_panelist_count || 2;
      const count = range ? Math.max(range.min, Math.min(range.max, requestedCount)) : requestedCount;
      const sessionData = { context, experienceCard, trainingImprovement:input.trainingImprovement||null, trainingPlanId:input.trainingPlanId||null, trainingPurpose:trainingPlan?.target?.automaticPractice?.hybrid?.kind||input.trainingPurpose||null, practiceScope:practice.scope, practiceNotice:practice.notice, assisted:input.assisted ?? false, briefingId: context.briefingId || null, activityId: context.activityId, questionQueue: questions, questionPlan: selection.plan, followups: input.followups ?? mode === 'followup', pressure: interviewPressureForStart({...input,mode},trainingPlan), interviewerReactions: false, maxFollowups: 2, panelists: panelists(Math.max(1, Math.min(5, count))), schoolProfile: profile, schoolPracticeOnly: !verified || !supported || Boolean(formalRange && !range) || profile?.data?.interview_conducted === false, difficulty: input.difficulty || 'standard', feedbackTiming: input.feedbackTiming === 'each' ? 'turn' : input.feedbackTiming, promptVersion: PROMPT_VERSION, aiAvailable: aiEnabled(), index: 0, generation: 0, paused: input.kind==='video', elapsedMs: 0, activeSince: input.kind==='video'?null:Date.now(), timerLeaseUntil: input.kind==='video'?null:Date.now()+INTERVIEW_LEASE_MS, settingsHistory: [] };
      Object.assign(sessionData,{sessionMode:input.sessionMode,policyVersion:INTERVIEW_POLICY_VERSION,maxFollowups:sessionData.pressure?2:1,feedbackTiming:input.sessionMode==='real'?'end':'turn'});
      const started = await transaction(async (client) => {
        const requestId = input.requestId || randomUUID();
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`start:${user.id}:${requestId}`]);
        const existing = await client.query('select * from interview_sessions where student_id=$1 and request_id=$2', [user.id, requestId]);
        if (existing.rows.length) {
          const turns = await client.query('select * from interview_turns where session_id=$1 and student_id=$2 order by created_at desc limit 1', [existing.rows[0].id, user.id]);
          return { session: existing.rows[0], turn: turns.rows[0] };
        }
        const created = await client.query('insert into interview_sessions(student_id,kind,mode,target_id,content_version,data,request_id) values($1,$2,$3,$4,$5,$6,$7) returning *', [user.id, input.kind, mode, context.targetId, Number(context.contentVersion), JSON.stringify(sessionData), requestId]);
        const first = questions[0];
        const turn = await client.query('insert into interview_turns(session_id,student_id,question_id,data) values($1,$2,$3,$4) returning *', [created.rows[0].id, user.id, first.id, JSON.stringify(rootTurn(first, 0, sessionData))]);
        return { session: created.rows[0], turn: turn.rows[0] };
      });
      return json({ session: sessionView(started.session), turn: turnView(started.turn), question: questionView(started.turn), aiAvailable: aiEnabled() });
    }
    let session = await sessionFor(user.id, input.sessionId);
    const policy=interviewPolicy(session.data);
    if(policy.mode==='real'&&['help','retry','settings','answer','draft','use_transcript'].includes(input.action))throw new FeatureError(403,'실전 면접에서는 도움·다시 답변·글 답변을 사용할 수 없어요.','REAL_INTERVIEW_POLICY');
    if(policy.mode==='real'&&session.state==='active'&&input.action==='transcript')throw new FeatureError(403,'실전 전사는 면접을 마친 뒤 확인해 주세요.','REAL_INTERVIEW_POLICY');
    if(policy.mode==='real'&&input.draft?.trim())throw new FeatureError(403,'실전 답변은 녹음으로 제출해 주세요.','REAL_INTERVIEW_POLICY');
    if(input.action==='retry'){
      return json(await transaction(async client=>{
        const locked=(await client.query('select * from interview_sessions where id=$1 and student_id=$2 for update',[session.id,user.id])).rows[0];
        if(!interviewPolicy(locked.data).retryAllowed)throw new FeatureError(403,'실전 면접에서는 다시 답변할 수 없어요.','REAL_INTERVIEW_POLICY');
        if(locked.state!=='active'||locked.data.processing)throw new FeatureError(409,'답변 저장이 끝난 뒤 다시 시도해 주세요.','INTERVIEW_PENDING');
        const turns=(await client.query('select * from interview_turns where session_id=$1 and student_id=$2 order by created_at,id',[session.id,user.id])).rows;
        const current=[...turns].reverse().find(turn=>!turn.data.answer&&!turn.data.invalidated);
        if(!current||current.id!==input.turnId)throw new FeatureError(409,'현재 질문에서 다시 답해 주세요.','STALE_TURN');
        if(input.generation!==undefined&&input.generation!==Number(locked.data.generation||0))throw new FeatureError(409,'질문 상태가 바뀌었어요.','STALE_GENERATION');
        const generation=Number(locked.data.generation||0)+1;
        const {draft,rawTranscript,rawTranscriptMediaId,displayTranscript,transcript,transcriptCleanup,mediaId,autoTranscriptApplied,speechSource,...rest}=current.data;
        const attempts=[...(rest.attempts||[]),{generation:generation-1,draft:draft||'',rawTranscript:rawTranscript||null,mediaId:mediaId||rawTranscriptMediaId||null,at:new Date().toISOString()}];
        await client.query('update interview_turns set data=$2 where id=$1 and student_id=$3',[current.id,JSON.stringify({...rest,attempts,draft:''}),user.id]);
        const saved=(await client.query('update interview_sessions set data=$2,updated_at=now() where id=$1 and student_id=$3 returning *',[session.id,JSON.stringify({...locked.data,...stoppedTimer(locked.data),generation,paused:true}),user.id])).rows[0];
        return {session:sessionView(saved)};
      }));
    }
    if (input.action === 'heartbeat' || input.action === 'suspend') {
      return json(await transaction(async client => {
        const selected = await client.query('select * from interview_sessions where id=$1 and student_id=$2 for update', [session.id,user.id]);
        const locked = selected.rows[0];
        if (locked.state !== 'active') return {session:sessionView(locked)};
        const timer = input.action === 'suspend' ? {...stoppedTimer(locked.data),paused:true} : renewInterviewTimer(locked.data);
        // Timer-only updates must not invalidate an answer being generated in parallel.
        const saved = await client.query('update interview_sessions set data=$3,updated_at=now() where id=$1 and student_id=$2 returning *', [session.id,user.id,JSON.stringify({...locked.data,...timer})]);
        return {session:sessionView(saved.rows[0])};
      }));
    }
    const context = session.data.context as LearningContext;
    if (input.action === 'help') {
      if (!input.turnId || !input.helpKind) throw new FeatureError(400, '도움을 확인할 질문을 선택해 주세요.', 'HELP_SCOPE_REQUIRED');
      const scope = await ownedInterviewHelpScope(user.id, session.id, input.turnId, false);
      const turn = await transaction(client => recordInterviewHelp(client, user.id, scope, {kind:input.helpKind!,at:new Date().toISOString(),receiptId:input.requestId || randomUUID()},false));
      return json({turn:turnView(turn),assistance:assistanceEvidence(turn.data)});
    }
    if (['pause', 'resume', 'draft', 'settings', 'use_transcript'].includes(input.action)) {
      return json(await transaction(async (client) => {
        const selected = await client.query('select * from interview_sessions where id=$1 and student_id=$2 for update', [session.id, user.id]);
        const locked = selected.rows[0];
        if (locked.state !== 'active') throw new FeatureError(409, '종료된 면접이에요.', 'SESSION_ENDED');
        if (locked.data.processing && Date.now() - Number(locked.data.processingAt || 0) < 120000) throw new FeatureError(409, '답변 저장 후 다시 시도해 주세요.', 'INTERVIEW_PENDING');
        const currentRows = await client.query("select * from interview_turns where session_id=$1 and student_id=$2 and data->>'answer' is null and coalesce(data->>'invalidated','false')!='true' order by created_at desc limit 1 for update", [session.id, user.id]);
        let current = currentRows.rows[0];
        if (input.turnId && current?.id !== input.turnId) throw new FeatureError(409, '현재 질문에서 이어가 주세요.', 'STALE_TURN');
        const data = { ...locked.data, ...settledInterviewTimer(locked.data) };
        // Resuming the same Live capture is idempotent, including a retried resume
        // received while it is already active. Neither changes the question or
        // invalidates a recording saved while transcription was in progress.
        const resumeLiveTimer=input.action==='resume'&&locked.kind==='video';
        if(input.action==='use_transcript') {
          if(!input.turnId||!input.mediaId||!current)throw new FeatureError(400,'현재 질문의 정리된 전사를 선택해 주세요.','TRANSCRIPT_MEDIA_REQUIRED');
          if(locked.data.paused)throw new FeatureError(409,'면접을 재개한 뒤 전사를 선택해 주세요.','SESSION_PAUSED');
          if(locked.kind!=='video')throw new FeatureError(409,'녹음 답변에서 전사를 선택해 주세요.','TRANSCRIPT_MODE_REQUIRED');
          Object.assign(current.data,await ownedInterviewTranscriptSelection(client,user.id,session.id,current.id,input.mediaId));
        }
        if (input.action === 'settings') {
          data.followups = input.followups ?? data.followups;
          if(!data.trainingPlanId)data.pressure = input.pressure ?? data.pressure;
          data.maxFollowups = data.pressure?2:1;
          data.interviewerReactions = false;
          data.settingsHistory = [...(data.settingsHistory || []), { followups: data.followups, pressure: data.pressure, interviewerReactions: !!data.interviewerReactions, feedbackTiming: data.feedbackTiming, at: new Date().toISOString() }];
          if (!data.followups && current?.data.questionKind === 'generated') {
            await client.query('update interview_turns set data=data || $3::jsonb where id=$1 and student_id=$2', [current.id, user.id, JSON.stringify({ invalidated: true, invalidationReason: 'followups_disabled' })]);
            const rootIndex = Number(current.data.rootIndex ?? data.index) + 1;
            const candidate = data.questionQueue[rootIndex];
            if (candidate) {
              const next = await client.query('insert into interview_turns(session_id,student_id,question_id,data) values($1,$2,$3,$4) returning *', [session.id, user.id, candidate.id, JSON.stringify(rootTurn(candidate, rootIndex, data))]);
              current = next.rows[0]; data.index = rootIndex;
            } else current = undefined;
          } else if (current && current.data.followupDepth === 0 && !current.data.draft) {
            const candidate = data.questionQueue[current.data.rootIndex];
            if (candidate) current.data = { ...current.data, ...rootTurn(candidate, current.data.rootIndex, data), assistance_recorded:current.data.assistance_recorded,helpKinds:current.data.helpKinds||[],assisted:Boolean(current.data.assisted || data.assisted && current.data.rootIndex===0) };
          }
        } else if (input.action === 'pause') { Object.assign(data, stoppedTimer(data)); data.paused = true; }
        else if (input.action === 'resume') {
          await client.query("update chat_messages set status='failed',data=data || '{\"error\":\"응답이 중단됐어요. 다시 질문해 주세요.\",\"code\":\"RESPONSE_INTERRUPTED\"}'::jsonb where student_id=$1 and status='pending' and data->'interviewHelp'->>'sessionId'=$2 and created_at<now()-interval '2 minutes'", [user.id,session.id]);
          const pending = await client.query("select id from chat_messages where student_id=$1 and status='pending' and data->'interviewHelp'->>'sessionId'=$2", [user.id,session.id]);
          if (pending.rows.length) throw new FeatureError(409,'도움 답변이 끝난 뒤 면접으로 돌아가 주세요.','HELP_PENDING');
          if (data.paused) data.activeSince = Date.now(); data.paused = false; data.timerLeaseUntil = Date.now() + INTERVIEW_LEASE_MS;
          // Client storage is a draft cache, never the authority for help evidence.
        }
        if (current) {
          if (input.draft !== undefined&&input.action!=='use_transcript') current.data.draft = input.draft;
          await client.query('update interview_turns set data=$3 where id=$1 and student_id=$2', [current.id, user.id, JSON.stringify(current.data)]);
        }
        if (!['draft','use_transcript'].includes(input.action)&&!resumeLiveTimer) data.generation = Number(data.generation || 0) + 1;
        const saved = await client.query('update interview_sessions set data=$3,updated_at=now() where id=$1 and student_id=$2 returning *', [session.id, user.id, JSON.stringify(data)]);
        return { session: sessionView(saved.rows[0]), question: questionView(current), turn: current ? turnView(current) : null };
      }));
    }
    if (input.action === 'cancel') {
      return json(await transaction(async client=>{
        const rows=await client.query('select * from interview_sessions where id=$1 and student_id=$2 for update',[session.id,user.id]);
        const locked=rows.rows[0];
        if(locked.state!=='active')return {session:sessionView(locked)};
        const timer={...stoppedTimer(locked.data),paused:true,generation:Number(locked.data.generation||0)+1};
        const saved=await client.query("update interview_sessions set state='cancelled',data=(data-'processing'-'processingAt') || $3::jsonb,updated_at=now(),completed_at=now() where id=$1 and student_id=$2 returning *",[session.id,user.id,JSON.stringify(timer)]);
        return {session:sessionView(saved.rows[0])};
      }));
    }
    if (input.action === 'transcript') {
      if (!input.turnId || !input.transcript?.trim()) throw new FeatureError(400, '정정할 전사를 입력해 주세요.', 'TRANSCRIPT_REQUIRED');
      const revised = await transaction(async (client) => {
        const sessions = await client.query('select * from interview_sessions where id=$1 and student_id=$2 for update', [session.id, user.id]);
        const locked = sessions.rows[0];
        if (locked.state === 'cancelled') throw new FeatureError(409, '폐기한 면접은 수정할 수 없어요.', 'SESSION_CANCELLED');
        if (locked.data.processing) throw new FeatureError(409, '질문 준비가 끝난 뒤 정정해 주세요.', 'INTERVIEW_PENDING');
        const selected = await client.query('select * from interview_turns where id=$1 and session_id=$2 and student_id=$3 for update', [input.turnId, session.id, user.id]);
        const turn = selected.rows[0]; if (!turn) throw new FeatureError(404, '답변을 찾을 수 없어요.', 'TURN_NOT_FOUND');
        const revisions = [...(turn.data.transcriptRevisions || []), { revision: (turn.data.transcriptRevisions || []).length + 1, transcript: input.transcript, correctedBy: 'student', at: new Date().toISOString() }];
        const answerRevisions = turn.data.answer ? [...(turn.data.answerRevisions || [{ revision: 1, text: turn.data.originalAnswer || turn.data.answer, kind: 'submitted_answer', at: turn.data.answeredAt }]), { revision: (turn.data.answerRevisions?.length || 1) + 1, text: input.transcript, kind: 'transcript_correction', at: new Date().toISOString() }] : turn.data.answerRevisions || [];
        const next = await client.query('update interview_turns set data=$2 where id=$1 and student_id=$3 returning *', [turn.id, JSON.stringify({ ...turn.data, originalAnswer: turn.data.originalAnswer || turn.data.answer || null, answer: turn.data.answer ? input.transcript : null, transcript: input.transcript, transcriptRevisions: revisions, answerRevisions, alignmentStatus: 'answer_only', ...(turn.data.reaction ? { reaction: neutralReaction('invalidated'), reactionRevisions: [...(turn.data.reactionRevisions || []), { ...turn.data.reaction, invalidatedAt: new Date().toISOString(), reason: 'transcript_corrected' }] } : {}), ...(turn.data.answer ? {} : { draft: input.transcript }) }), user.id]);
        const invalidated = await client.query("update interview_turns set data=data || '{\"invalidated\":true,\"invalidationReason\":\"transcript_corrected\"}'::jsonb where session_id=$1 and student_id=$2 and data->>'parentTurnId'=$3 and data->>'answer' is null returning *", [session.id, user.id, turn.id]);
        if (locked.state === 'active' && invalidated.rows.length) {
          const rootIndex = Number(turn.data.rootIndex ?? locked.data.index ?? 0) + 1;
          const candidate = locked.data.questionQueue[rootIndex];
          if (candidate) await client.query('insert into interview_turns(session_id,student_id,question_id,data) values($1,$2,$3,$4)', [session.id, user.id, candidate.id, JSON.stringify(rootTurn(candidate, rootIndex, { ...locked.data, panelists: locked.data.panelists || panelists(2) }))]);
          await client.query('update interview_sessions set data=data || $3::jsonb where id=$1 and student_id=$2', [session.id, user.id, JSON.stringify({ index: rootIndex, generation: Number(locked.data.generation || 0) + 1 })]);
        }
        const descendants = await client.query("select id,data from interview_turns where session_id=$1 and student_id=$2 and data->>'parentTurnId'=$3 and data->>'answer' is not null for update", [session.id, user.id, turn.id]);
        for (const descendant of descendants.rows) await client.query('update interview_turns set data=$3 where id=$1 and student_id=$2', [descendant.id, user.id, JSON.stringify({ ...descendant.data, derivedFromCorrectedTranscript: true, reaction: neutralReaction('invalidated'), ...(descendant.data.reaction ? { reactionRevisions: [...(descendant.data.reactionRevisions || []), { ...descendant.data.reaction, invalidatedAt: new Date().toISOString(), reason: 'parent_transcript_corrected' }] } : {}) })]);
        await client.query("update interview_reports set data=data || '{\"transcriptChanged\":true}'::jsonb where session_id=$1 and student_id=$2", [session.id, user.id]);
        return next.rows[0];
      });
      return json({ session: sessionView(session), turn: turnView(revised) });
    }
    if (input.action === 'finish'||input.action==='report_feedback') return json(await finishSession(user.id,session,input.action==='report_feedback',input.action==='finish'&&input.discardDraft===true));
    const automaticRecording=input.action==='answer_recording';
    if(automaticRecording&&(!input.turnId||!input.mediaId||input.generation===undefined||!input.requestId))throw new FeatureError(400,'제출할 녹음과 현재 질문 정보를 확인해 주세요.','RECORDING_ANSWER_SCOPE_REQUIRED');
    if(automaticRecording&&input.answer!==undefined)throw new FeatureError(400,'녹음 자동 제출에는 답변 글 대신 녹음만 선택해 주세요.','RECORDING_ANSWER_TEXT_FORBIDDEN');
    if (!automaticRecording&&session.state !== 'active') throw new FeatureError(409, '종료된 면접이에요. 새 면접에서 이어가 주세요.', 'SESSION_ENDED');
    if (!automaticRecording&&!input.answer?.trim()) throw new FeatureError(400, '답변을 입력해 주세요.', 'ANSWER_REQUIRED');
    const requestId = input.requestId || randomUUID();
    const processId = randomUUID();
    const submitted = await transaction(async (client) => {
      const selected = await client.query('select * from interview_sessions where id=$1 and student_id=$2 for update', [session.id, user.id]);
      const locked = selected.rows[0];
      // A lost response may be retried after pause or completion. Return its durable
      // receipt without submitting again or resuming the session.
      if(automaticRecording&&locked.data.lastRequestId===requestId){
        const turns=await client.query('select * from interview_turns where session_id=$1 and student_id=$2 order by created_at,id',[session.id,user.id]);
        const previous=turns.rows.find(turn=>turn.id===locked.data.lastTurnId);
        if(previous?.id!==input.turnId||previous?.data.submittedMediaId!==input.mediaId)throw new FeatureError(409,'이미 사용한 요청 정보예요. 제출한 녹음 기록을 확인해 주세요.','REQUEST_CONFLICT');
        return {duplicate:true,session:locked,previous,next:turns.rows.find(turn=>!turn.data.answer&&!turn.data.invalidated)};
      }
      if (locked.state !== 'active') throw new FeatureError(409, '종료된 면접이에요.', 'SESSION_ENDED');
      if (settledInterviewTimer(locked.data).paused) throw new FeatureError(409, '면접으로 돌아온 후 답변을 제출해 주세요.', 'SESSION_PAUSED');
      if (locked.data.lastRequestId === requestId) {
        const turns = await client.query('select * from interview_turns where session_id=$1 and student_id=$2 order by created_at,id', [session.id, user.id]);
        return { duplicate: true, session: locked, previous: turns.rows.find((turn) => turn.id === locked.data.lastTurnId), next: turns.rows.find((turn) => !turn.data.answer && !turn.data.invalidated) };
      }
      if (locked.data.processing && Date.now() - Number(locked.data.processingAt || 0) < 120000) throw new FeatureError(409, '다음 질문을 준비 중이에요.', 'INTERVIEW_PENDING');
      const turns = await client.query('select * from interview_turns where session_id=$1 and student_id=$2 order by created_at,id', [session.id, user.id]);
      const current = [...turns.rows].reverse().find((turn) => !turn.data.answer && !turn.data.invalidated);
      if (!current) throw new FeatureError(409, '준비된 질문에 모두 답했어요. 면접을 종료해 주세요.', 'NO_OPEN_QUESTION');
      if (input.turnId && input.turnId !== current.id) throw new FeatureError(409, '이미 제출한 답변이에요. 현재 질문에서 이어가 주세요.', 'STALE_TURN');
      let answer=input.answer!;
      if(automaticRecording){
        if(locked.kind!=='video')throw new FeatureError(409,'Live 면접의 녹음 답변을 선택해 주세요.','TRANSCRIPT_MODE_REQUIRED');
        if(input.generation!==Number(locked.data.generation||0))throw new FeatureError(409,'녹음 이후 질문 상태가 바뀌었어요. 현재 질문에서 이어가 주세요.','STALE_GENERATION');
        const recording=await ownedInterviewTranscriptSelection(client,user.id,session.id,current.id,input.mediaId!,{generation:input.generation!});
        const draft=String(current.data.draft||'').trim();
        if(draft&&!(current.data.autoTranscriptApplied===true&&current.data.mediaId===input.mediaId&&draft===recording.displayTranscript.trim()))throw new FeatureError(409,'직접 수정한 초안이 있어요. 내용을 확인하고 답변을 보내 주세요.','ANSWER_DRAFT_CHANGED');
        if(recording.displayTranscript.length>12000)throw new FeatureError(409,'전사가 너무 길어요. 답변을 확인하고 나누어 보내 주세요.','ANSWER_TOO_LONG');
        Object.assign(current.data,recording);
        answer=recording.displayTranscript;
      }
      const speechSource = locked.kind==='video'&&current.data.autoTranscriptApplied===true&&current.data.mediaId===current.data.rawTranscriptMediaId
        ?snapshotSpeechAnswer(current.data.rawTranscript,current.data.displayTranscript,current.data.transcriptCleanup,answer,current.data.mediaId):null;
      const answerData = { ...current.data, answer, originalAnswer:answer, submissionSource:automaticRecording?'recording':'text', ...(automaticRecording?{submittedMediaId:input.mediaId,submittedGeneration:input.generation}:{}), ...(speechSource?{speechSource}:{}), answerRevisions: [{ revision: 1, text:answer, kind: 'submitted_answer', at: new Date().toISOString() }], draft: '', answeredAt: new Date().toISOString(), requestId, answerFinalized: true };
      if (locked.kind === 'video' && current.data.transcript && current.data.transcript !== answer) {
        answerData.transcript = answer;
        answerData.transcriptRevisions = [...(current.data.transcriptRevisions || []), { revision: (current.data.transcriptRevisions || []).length + 1, transcript:answer, correctedBy: 'student', at: new Date().toISOString() }];
      }
      const answered = await client.query('update interview_turns set data=$2 where id=$1 and student_id=$3 returning *', [current.id, JSON.stringify(answerData), user.id]);
      await recordStudyEvent(client,user.id,{kind:'interview_answer',sourceId:current.id,data:{sessionId:session.id,trainingPlanId:locked.data.trainingPlanId||null,trainingPurpose:locked.data.trainingPurpose||null,rootQuestionId:current.data.rootQuestionId||current.question_id,questionKind:current.data.questionKind,activityIds:(locked.data.context.questions||[]).find((q:Record<string,any>)=>q.id===(current.data.rootQuestionId||current.question_id))?.activity_ids||[],experienceCardId:locked.data.experienceCard?.id||null,kind:locked.kind,submissionSource:automaticRecording?'recording':'text',questionId:current.question_id,question:current.data.question,answer,...assistanceEvidence(current.data),hintUsed:assistanceEvidence(current.data).hint_used,contentVersion:locked.data.context.contentVersion,targetId:locked.data.context.targetId||null,targetSnapshot:locked.data.context.target||null,sourceKind:locked.data.context.sourceKind || 'personal',sourceType:current.data.sourceType || 'personal',commonRevision:current.data.commonRevision || null}});
      const rootIndex = Number(current.data.rootIndex ?? locked.data.index ?? 0);
      const nextIndex = rootIndex + 1;
      const nextQuestion = locked.data.questionQueue[nextIndex];
      let next;
      if (nextQuestion) {
        const result = await client.query('insert into interview_turns(session_id,student_id,question_id,data) values($1,$2,$3,$4) returning *', [session.id, user.id, nextQuestion.id, JSON.stringify(rootTurn(nextQuestion, nextIndex, { ...locked.data, panelists: locked.data.panelists || panelists(2) }))]);
        next = result.rows[0];
      }
      const settings = { ...locked.data, ...stoppedTimer(locked.data), index: nextIndex, lastRequestId: requestId, lastTurnId: current.id, processing: processId, processingAt: Date.now() };
      const result = await client.query('update interview_sessions set data=$2,updated_at=now() where id=$1 and student_id=$3 returning *', [session.id, JSON.stringify(settings), user.id]);
      return { duplicate: false, session: result.rows[0], previous: answered.rows[0], next };
    });
    session = submitted.session;
    if (submitted.duplicate) return json({ session: sessionView(session), turn: publicTurnView(submitted.previous,session), nextQuestion: session.state==='active'&&!session.data.processing?questionView(submitted.next):null, feedback:interviewPolicy(session.data).feedbackTiming==='turn'?submitted.previous?.data.feedback||null:null });
    const evaluation=interviewEvaluationEvidence(submitted.previous.data);
    const submittedAnswer=JSON.stringify(evaluation);
    let feedback:(Awaited<ReturnType<typeof coach>>&{evaluation?:ReturnType<typeof parseInterviewFeedback>['evaluation']})|null=null;
    let aiError: string | null = null;
    let next = submitted.next;
    try {
      if (aiEnabled()) {
        feedback = await coach(user.id, { ...context, questionId: submitted.previous.question_id }, `면접 모드 ${session.mode}, 질문 깊이 ${session.data.difficulty}. 평가는 입력 객체의 answer 원발화만 사용한다. submittedAnswer는 학생의 작성·수정본이므로 발화 점수의 근거로 쓰지 않는다. 학생 답변의 질문 대응·실제 역할·근거를 짧게 피드백한다. 강점과 확인할 부분을 학생의 실제 문장 인용으로 구분한다. 합격률이나 종합 능력 점수는 만들지 않고 아래의 명시된 학습용 척도만 사용한다. 학생 진술과 승인 원문을 구분하며, 미확인 경험을 넣은 완성형 답변을 대신 쓰지 않는다. 다음 확인 질문은 직전 질문에서 명시한 요구를 우선한다. content는 JSON 문자열로 {summary:string,needsReview:boolean|null,reason:string,evidence:string[]} 형식으로 반환한다. summary는 질문 대응 요약과 보완점 하나, needsReview는 반복 연습 필요 여부이며 판단 근거 부족은 null, reason은 그 이유, evidence는 학생 원발화의 정확한 인용 1~3개이다. 말하지 않은 사실로 평가하지 않는다. ${INTERVIEW_RUBRIC_PROMPT} ${interviewGuidelineInstruction(context.studentContext?.operating_guidelines,['evaluation','feedback'])}`, [{ role: 'user', content: `질문: ${submitted.previous.data.question}\n학생 답변: ${submittedAnswer}` }], 'interview', session.id);
        const parsed=parseInterviewFeedback(feedback.content,interviewEvaluationEvidence(submitted.previous.data).answer,context.sources,context.studentContext?.operating_guidelines);
        feedback={...feedback,content:parsed.summary,evaluation:parsed.evaluation};
      }
      // Each dynamic follow-up is based on the just-recorded answer; static fallbacks remain recoverable.
      if (aiEnabled() && session.data.followups && Number(submitted.previous.data.followupDepth || 0) < interviewPolicy(session.data).maxFollowups) {
        const rootIndex = Number(submitted.previous.data.rootIndex ?? Math.max(0, session.data.index - 1));
        const root = session.data.questionQueue[rootIndex];
        const dynamic = await coach(user.id, { ...context, questionId: root?.id || submitted.previous.question_id }, `먼저 직전 질문의 요구에 충분하고 명확하게 답했는지 판단한다. 충분하면 content에 정확히 [NEXT]만 출력한다. 불명확하거나 빠진 핵심이 있을 때만 확인 질문 하나를 120자 이내 한 문장으로 출력한다. 학교 인재상 이름을 직접 요구하지 않는다. ${session.data.pressure ? '근거·모순·반대 사례·한계 중 가장 필요한 하나만 확인한다.' : '구체적 행동 또는 이유 중 가장 필요한 하나만 확인한다.'} 이미 확인한 내용을 반복하지 않는다. 공격적 호칭·모욕·인격 평가는 금지한다. ${interviewGuidelineInstruction(context.studentContext?.operating_guidelines,['questions'])}`, [{ role: 'user', content: `직전 질문: ${submitted.previous.data.question}\n학생의 원발화 근거: ${submittedAnswer}` }], 'interview', session.id);
        const followup=generatedInterviewQuestion(dynamic.content,(context.questions||[]).map((item:Record<string,any>)=>item.talent_profile?.point?.label).filter((label:unknown):label is string=>typeof label==='string'));
        if(followup)next = { ...(next || { id: randomUUID(), session_id: session.id, student_id: user.id }), question_id: `followup_${randomUUID()}`, data: { question: followup, rootQuestionId: root?.id, answer: null, feedback: null, draft: '', questionKind: 'generated', rootIndex, followupDepth: Number(submitted.previous.data.followupDepth || 0) + 1, speakerId: submitted.previous.data.speakerId || 'A', parentTurnId: submitted.previous.id, parentQuestionId: submitted.previous.question_id, sources: dynamic.sources, model: dynamic.model, promptVersion: dynamic.promptVersion, assisted: false, assistance_recorded:true, helpKinds:[] } };
      }
    } catch (error) { aiError = featureError(error).error; }
    const finalized = await transaction(async (client) => {
      const selected = await client.query('select * from interview_sessions where id=$1 and student_id=$2 for update', [session.id, user.id]);
      const latest = selected.rows[0];
      if (latest.state !== 'active' || latest.data.processing !== processId || Number(latest.data.generation || 0) !== Number(session.data.generation || 0)) return { session: latest, turn: submitted.previous, next: submitted.next };
      const answered = await client.query('update interview_turns set data=$2 where id=$1 and student_id=$3 returning *', [submitted.previous.id, JSON.stringify({ ...submitted.previous.data, feedback, evaluation:feedback?.evaluation||{needsReview:null,reason:'평가를 아직 확인하지 못했어요.',evidence:[]}, aiError }), user.id]);
      if (next && submitted.next) await client.query('update interview_turns set question_id=$2,data=$3 where id=$1 and student_id=$4', [next.id, next.question_id, JSON.stringify(next.data), user.id]);
      else if (next) await client.query('insert into interview_turns(id,session_id,student_id,question_id,data) values($1,$2,$3,$4,$5)', [next.id, session.id, user.id, next.question_id, JSON.stringify(next.data)]);
      const cleaned = { ...latest.data, ...settledInterviewTimer(latest.data) }; delete cleaned.processing; delete cleaned.processingAt;
      cleaned.activeSince = cleaned.paused ? null : Date.now();
      cleaned.timerLeaseUntil = cleaned.paused ? null : Date.now() + INTERVIEW_LEASE_MS;
      if (next?.data.questionKind === 'generated') cleaned.index = next.data.rootIndex;
      const saved = await client.query('update interview_sessions set data=$2,updated_at=now() where id=$1 and student_id=$3 returning *', [session.id, JSON.stringify(cleaned), user.id]);
      return { session: saved.rows[0], turn: answered.rows[0], next };
    });
    return json({ session: sessionView(finalized.session), turn: publicTurnView(finalized.turn,finalized.session), nextQuestion: finalized.session.state === 'active' ? questionView(finalized.next) : null, feedback:interviewPolicy(finalized.session.data).feedbackTiming==='turn'?feedback:null, aiError, aiAvailable: aiEnabled() });
  } catch (error) { const result = featureError(error); return json({ error: result.error, code: result.code }, result.status); }
}

async function finishSession(studentId:string,session:Record<string,any>,retryFeedback=false,discardDraft=false){
  if(retryFeedback&&!aiEnabled())throw new FeatureError(503,'AI 피드백 연결을 확인한 뒤 다시 시도해 주세요.','AI_UNAVAILABLE');
  const completed = await transaction(async (client) => {
    const selected = await client.query('select * from interview_sessions where id=$1 and student_id=$2 for update', [session.id, studentId]);
    const locked = selected.rows[0];
    const existing = await client.query('select * from interview_reports where session_id=$1 and student_id=$2', [session.id, studentId]);
    if(retryFeedback&&(locked.state!=='completed'||!existing.rows.length))throw new FeatureError(409,'저장한 면접 리포트에서 다시 요청해 주세요.','REPORT_NOT_READY');
    if(existing.rows.length&&!existing.rows[0].data.transcriptChanged){
      if(!retryFeedback)return {session:locked,report:existing.rows[0],created:false};
      const report=existing.rows[0];
      if(!report.data.sections?.length)return {session:locked,report,created:false};
      if(report.data.aiStatus==='completed')return {session:locked,report,created:false};
      if(report.data.aiStatus==='pending'&&Date.now()-Number(report.data.aiAttemptedAt||0)<60000)throw new FeatureError(409,'피드백을 정리하고 있어요. 잠시 뒤 확인해 주세요.','REPORT_FEEDBACK_PENDING');
      const [claimed]=(await client.query('update interview_reports set data=data || $3::jsonb where session_id=$1 and student_id=$2 returning *',[session.id,studentId,JSON.stringify({aiStatus:'pending',aiAttemptedAt:Date.now()})])).rows;
      return {session:locked,report:claimed,created:true};
    }
    if (locked.state === 'cancelled') throw new FeatureError(409, '취소된 면접은 리포트를 만들 수 없어요.', 'SESSION_CANCELLED');
    if (locked.data.processing && Date.now() - Number(locked.data.processingAt || 0) < 120000) throw new FeatureError(409, '답변 저장 후 면접을 종료해 주세요.', 'INTERVIEW_PENDING');
    // Discard is explicit and scoped to unanswered turns. Submitted answers and
    // their original media remain valid evidence for the resulting report.
    if(discardDraft)await client.query("update interview_turns set data=data-'draft' where session_id=$1 and student_id=$2 and data->>'answer' is null",[session.id,studentId]);
    const turns = await client.query('select * from interview_turns where session_id=$1 and student_id=$2 order by created_at,id', [session.id, studentId]);
    const reportData = selfCheckReport(locked.data.context, turns.rows.map((turn) => ({ ...turn, question: turn.data.question, answer: turn.data.answer })));
    const previous = existing.rows[0]?.data;
    const previousSnapshot = previous ? { ...previous, revisions: undefined } : null;
    const timer = stoppedTimer(locked.data);
    const trainingProgress=interviewCompletion(locked.data,turns.rows);
    const reportPayload = { ...reportData,guidelineVersions:Array.isArray(locked.data.context?.studentContext?.operating_guidelines)?locked.data.context.studentContext.operating_guidelines.map((value:Record<string,any>)=>({kind:value.kind,version:value.version,id:value.id||null})):[],sessionMode:interviewPolicy(locked.data).mode,trainingProgress,aiStatus:aiEnabled()&&reportData.sections.length?'pending':'unavailable',aiAttemptedAt:Date.now(), experienceCard:locked.data.experienceCard?{id:locked.data.experienceCard.id,revision:locked.data.experienceCard.revision}:null, feedbackKind: 'self_check', practiceScope:locked.data.practiceScope||'school', practiceLabel:locked.data.practiceScope==='personal_record'?'일반 경험 면접':null, practiceNotice:locked.data.practiceNotice||null, mode: locked.mode, kind: locked.kind, targetId: locked.target_id, durationSeconds: Math.floor(timer.elapsedMs / 1000), schoolProfile: locked.data.schoolProfile, questionPlan: locked.data.questionPlan, settings: { followups: locked.data.followups, pressure: locked.data.pressure, feedbackTiming: locked.data.feedbackTiming, interviewerReactions: !!locked.data.interviewerReactions, panelists: locked.data.panelists }, settingsHistory: locked.data.settingsHistory || [], assisted: turns.rows.some(turn => turn.data.answer&&!turn.data.invalidated&&assistanceEvidence(turn.data).assisted), assistance_recorded: turns.rows.filter(turn=>turn.data.answer&&!turn.data.invalidated).every(turn=>assistanceEvidence(turn.data).assistance_recorded), helpKinds:[...new Set(turns.rows.filter(turn=>turn.data.answer&&!turn.data.invalidated).flatMap(turn=>assistanceEvidence(turn.data).helpKinds))], actualRootQuestions: turns.rows.filter(turn => turn.data.answer && !turn.data.followupDepth).length, actualFollowups: turns.rows.filter(turn => turn.data.answer && turn.data.followupDepth > 0).length, promptVersion: PROMPT_VERSION, transcriptRevision: turns.rows.reduce((sum, turn) => sum + (turn.data.transcriptRevisions?.length || 0), 0), reportRevision: previous ? Number(previous.reportRevision || 1) + 1 : 1, revisions: previous ? [...(previous.revisions || []), previousSnapshot] : [] };
    const inserted = existing.rows.length
      ? await client.query('update interview_reports set data=$3 where session_id=$1 and student_id=$2 returning *', [session.id, studentId, JSON.stringify(reportPayload)])
      : await client.query('insert into interview_reports(student_id,session_id,data) values($1,$2,$3) returning *', [studentId, session.id, JSON.stringify(reportPayload)]);
    const finished = await client.query("update interview_sessions set state='completed',completed_at=now(),updated_at=now(),data=(data-'processing'-'processingAt') || $3::jsonb where id=$1 and student_id=$2 returning *", [session.id, studentId, JSON.stringify({...timer,trainingProgress})]);
    return { session: finished.rows[0], report: inserted.rows[0], created: true };
  });
  const feedbackRevision=String(completed.report.data.reportRevision),feedbackAttempt=String(completed.report.data.aiAttemptedAt);
  if(completed.created&&completed.report.data.aiStatus==='pending')after(async()=>{
    try {
      const context = completed.session.data.context as LearningContext;
      const reply = await coach(studentId, context, '면접 리포트 내용 피드백을 작성한다. 아래 각 섹션의 evaluationEvidence.answer만 원발화 평가에 사용한다. answer와 submittedAnswer 표시·수정본으로 원발화를 덮어쓰지 않는다. 원발화 문장을 그대로 인용해 질문 대응·근거·자기 표현을 관찰한다. 승인 원문과 학생 진술은 별도로 표시한다. 다음 연습은 각 질문에서 명시한 요구를 먼저 확인한다. 학생에게 없던 실험 절차·행동을 넣은 다듬은 답변이나 1인칭 모범답안은 작성하지 않는다. 미확인 내용은 짧은 확인 질문으로 남긴다. 발화 측정값이나 종합 점수는 생성하지 않는다.'+interviewGuidelineInstruction(context.studentContext?.operating_guidelines,['evaluation','feedback']), [{ role: 'user', content: JSON.stringify(completed.report.data.sections) }], 'interview', session.id);
      await query("update interview_reports set data=data || $3::jsonb where session_id=$1 and student_id=$2 and data->>'reportRevision'=$4 and data->>'aiStatus'='pending' and data->>'aiAttemptedAt'=$5", [session.id, studentId, JSON.stringify({ aiStatus: 'completed', aiFeedback: reply, model: reply.model, promptVersion: reply.promptVersion, feedbackKind: 'ai_content_and_self_check' }),feedbackRevision,feedbackAttempt]);
    } catch (error) {
      await query("update interview_reports set data=data || $3::jsonb where session_id=$1 and student_id=$2 and data->>'reportRevision'=$4 and data->>'aiStatus'='pending' and data->>'aiAttemptedAt'=$5", [session.id, studentId, JSON.stringify({ aiStatus: 'failed', aiError: featureError(error).error }),feedbackRevision,feedbackAttempt]);
    }
  });
  return { session: sessionView(completed.session), report: reportView(completed.report) };
}
