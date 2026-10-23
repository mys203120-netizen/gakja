import 'server-only';
import { ApiError, query } from './db';
import { getLearning } from './data';
import { KNOWLEDGE_CATALOG, matchKnowledgeVideos } from './knowledge-bites-catalog';
import { planPracticeEventMatches, planTargetHref, type PlanTarget, type PlanTargetOption } from './planner-model';
import { commonInterviewQuestions } from './school-learning';
import { learningScopeIdentity } from './learning-target-scope';
import { learningTargetIdentityMatches } from '@gakja/content-contracts/workflows';
import {growthStage} from './learning-growth';
import {readStudentModel} from './student-read-model';
import {knowledgeTargetKey} from './knowledge-flow-model';
import {koreaToday} from './planner-model';

type Value = Record<string, any>;
type Source = { kind:'question'|'activity'; id:string; title:string; sourceType:'personal'|'common'; sourceVersion:number; entity:Value; learning?:Value; targetId?:string };
const sameTarget = (a:Value,b:Value) => learningTargetIdentityMatches({...learningScopeIdentity(a),interview_stage:growthStage(a.interview_stage||a.stage)},{...learningScopeIdentity(b),interview_stage:growthStage(b.interview_stage||b.stage)});

export async function buildPlanContext(studentId: string, savedTargets: PlanTarget[] = [], options?:{readOnly?:boolean}) {
  const [content, assignments, progress, events, common, schoolTargets, archives, preferences] = await Promise.all([
    getLearning(studentId), query("select id,title from quiz_assignments where student_id=$1 and (id=any($2::uuid[]) or id in(select id from quiz_assignments where student_id=$1 order by case when state in('assigned','in_progress','retry_due') then 0 else 1 end,created_at desc,id desc limit 30)) order by created_at desc", [studentId,savedTargets.filter(target=>target?.kind==='assignment'&&/^[0-9a-f-]{36}$/i.test(target.id)).map(target=>target.id)]),
    query('select video_id from knowledge_bite_progress where student_id=$1', [studentId]),
    query('select id,source_id,kind,data,created_at from study_session_events where student_id=$1 union all select id,source_id,kind,data,occurred_at as created_at from study_imported_events where student_id=$1 order by created_at desc', [studentId]),
    commonInterviewQuestions(studentId,null,undefined,options), query("select id,data from support_targets where student_id=$1 and nullif(data->>'archived_at','') is null", [studentId]),
    query("select v.version,v.data from content_versions v join content_packages p on p.id=v.package_id where p.student_id=$1 and v.status='published'", [studentId]),
    query("select jsonb_build_object('selectedTargetId',data->'selectedTargetId') as data from student_preferences where student_id=$1", [studentId]),
  ]);
  const schoolQuestions = (await Promise.all(schoolTargets.map(async target => (await commonInterviewQuestions(studentId,target.id,undefined,options)).map(question => ({...question,targetId:target.id}))))).flat();
  const currentCommon = [...common.map(question => ({...question,targetId:undefined as string|undefined})),...schoolQuestions];
  const sources:Source[] = archives.flatMap(archive => [
    ...(archive.data.questions || []).map((entity:Value) => ({kind:'question' as const,id:entity.id,title:entity.prompt,sourceType:'personal' as const,sourceVersion:Number(archive.version),entity,learning:archive.data})),
    ...(archive.data.activities || []).map((entity:Value) => ({kind:'activity' as const,id:entity.id,title:entity.title,sourceType:'personal' as const,sourceVersion:Number(archive.version),entity,learning:archive.data})),
  ]);
  sources.push(...currentCommon.map(entity => ({kind:'question' as const,id:entity.id,title:entity.prompt,sourceType:'common' as const,sourceVersion:Number(entity.common_revision),entity,targetId:entity.targetId})));
  const requested = [...new Map(savedTargets.filter(target => target?.kind === 'question' && (target.sourceType === 'common' || target.common) && target.sourceVersion).map(target => [`${target.targetId||''}:${target.sourceVersion}`,target])).values()];
  for (const target of requested) {
    if (target.targetId && !schoolTargets.some(row => row.id === target.targetId)) continue;
    const questions = await commonInterviewQuestions(studentId,target.targetId || null,target.sourceVersion,options);
    sources.push(...questions.map(entity => ({kind:'question' as const,id:entity.id,title:entity.prompt,sourceType:'common' as const,sourceVersion:Number(entity.common_revision),entity,targetId:target.targetId})));
  }
  const commonQuestions = [...new Map(currentCommon.map(question => [question.id,question])).values()];
  const videos = matchKnowledgeVideos(content.learning);
  const ownedVideos = new Set([...videos.map(video => video.id), ...progress.map(row => row.video_id)]);
  const targets: PlanTargetOption[] = [
    ...(content.learning.questions || []).filter((question:Value)=>!question.support_target_ids?.length || schoolTargets.some(target=>question.support_target_ids.includes(target.id))).map((question:Value) => ({kind:'question' as const,id:question.id,title:question.prompt,sourceType:'personal' as const,sourceVersion:content.package?.active_version || undefined})),
    ...commonQuestions.filter(question => !(content.learning.questions || []).some((item:Value) => item.id === question.id)).map(question => ({kind:'question' as const,id:question.id,title:question.prompt,common:true,sourceType:'common' as const,sourceVersion:Number(question.common_revision),...(question.targetId ? {targetId:question.targetId} : {})})),
    ...(content.learning.activities || []).map((activity:Value) => ({kind:'activity' as const,id:activity.id,title:activity.title,sourceType:'personal' as const,sourceVersion:content.package?.active_version || undefined})),
    ...KNOWLEDGE_CATALOG.filter(video => ownedVideos.has(video.id)).map(video => ({ kind: 'video' as const, id: video.id, title: video.label })),
    ...assignments.map(row => ({ kind: 'assignment' as const, id: row.id as string, title: row.title as string })),
  ];
  return {targets,events,learning:content.learning,contentVersion:content.package?.active_version ?? null,sources,schoolTargets,selectedTargetId:preferences[0]?.data?.selectedTargetId as string|undefined};
}
type RawContext=Awaited<ReturnType<typeof buildPlanContext>>;

/** Compact planner facts, rather than serialized historical answers or repeated publication bodies. */
export function compactPlanContext(context:RawContext,savedTargets:PlanTarget[]=[]) {
  const versions=new Set([context.contentVersion,...savedTargets.filter(target=>target.sourceType!=='common').map(target=>target.sourceVersion)].filter(Boolean));
  const sources=context.sources.filter(source=>source.sourceType==='common'||versions.has(source.sourceVersion));
  const latest=new Map<string,any>();
  const entities=new Set([...sources.map(source=>source.id),...(context.learning.memory_items||[]).map((item:Value)=>item.id),...context.targets.map(target=>target.id)]);
  const todayStart=new Date(koreaToday()+'T00:00:00+09:00').getTime();
  for(const event of context.events){
    const data=event.data||{},entity=data.questionId||data.memoryItemId||data.videoId||data.assignmentId;
    if(!entity||!entities.has(entity))continue;
    if(data.contentVersion&& !data.commonRevision&&!versions.has(Number(data.contentVersion)))continue;
    const targetId=data.targetId||data.target_id;
    if(targetId&&!context.schoolTargets.some(target=>target.id===targetId&&learningTargetIdentityMatches(learningScopeIdentity(data.targetSnapshot||data.target_snapshot||{}),learningScopeIdentity(target.data))))continue;
    const key=knowledgeTargetKey({kind:event.kind,entity,targetId,source:data.commonRevision||data.common_revision||data.contentVersion||data.content_version,trainingPlanId:data.trainingPlanId&&event.created_at&&new Date(event.created_at).getTime()>=todayStart?data.trainingPlanId:null});
    const previous=latest.get(key);
    if(previous&&new Date(previous.created_at).getTime()>=new Date(event.created_at).getTime())continue;
    const compact=Object.fromEntries(['questionId','memoryItemId','videoId','assignmentId','targetId','target_id','sourceType','source_type','commonRevision','common_revision','contentVersion','content_version','trainingPlanId','sessionId','outcome','assisted','hintUsed','timedOut','completed','activityIds','practiceKind','cannotRecall','recall_state','rating'].filter(key=>data[key]!==undefined).map(key=>[key,data[key]]));
    if(data.targetSnapshot||data.target_snapshot)compact.targetSnapshot=learningScopeIdentity(data.targetSnapshot||data.target_snapshot);
    latest.set(key,{...event,data:compact});
  }
  const archives=Object.fromEntries(sources.filter(source=>source.learning).map(source=>[String(source.sourceVersion),source.learning]));
  return {context:{...context,events:[...latest.values()],sources:sources.map(({learning:_,...source})=>source)},archives};
}

export async function getPlanContext(studentId:string,savedTargets:PlanTarget[]=[]):Promise<RawContext>{
  const identity=[...new Set(savedTargets.map(target=>knowledgeTargetKey({id:target.id,kind:target.kind,targetId:target.targetId,sourceType:target.sourceType,sourceVersion:target.sourceVersion})))].sort();
  const saved=await readStudentModel(studentId,'plan-context',knowledgeTargetKey({v:1,day:koreaToday(),targets:identity}),async()=>compactPlanContext(await buildPlanContext(studentId,savedTargets),savedTargets));
  return {...saved.context,sources:saved.context.sources.map(source=>({...source,learning:saved.archives[String(source.sourceVersion)]}))};
}
type Context = Awaited<ReturnType<typeof getPlanContext>>;
function sourceFor(context:Context,target:PlanTarget) {
  const sourceType = target.sourceType || (target.common ? 'common' : 'personal');
  const version = target.sourceVersion ?? (sourceType === 'personal' ? target.contentVersion ?? context.contentVersion : undefined);
  return context.sources.find(source => source.kind === target.kind && source.id === target.id && source.sourceType === sourceType && (!version || source.sourceVersion === Number(version)) && (sourceType !== 'common' || (source.targetId || null) === (target.targetId || null)));
}
/** Client IDs/scope are validated; frozen text and snapshots always come from owned server sources. */
export function ownedPlanTarget(context: Context, target: PlanTarget | null | undefined) {
  if (!target) return null;
  if (target.targetId && !context.schoolTargets.some(row => row.id === target.targetId)) throw new ApiError(404,'지원 학교를 찾을 수 없어요.');
  if (target.kind === 'video' || target.kind === 'assignment') {
    const owned = context.targets.find(item => item.kind === target.kind && item.id === target.id);
    if (!owned) throw new ApiError(404,'나의 자료에 있는 학습 항목을 선택해 주세요.');
    return {kind:owned.kind,id:owned.id,title:owned.title};
  }
  const option = context.targets.find(item => item.kind === target.kind && item.id === target.id && (!target.sourceType || item.sourceType === target.sourceType));
  const sourceType = target.sourceType || option?.sourceType || 'personal';
  const preliminary = sourceType === 'personal' ? sourceFor(context,{...target,sourceType}) : null;
  const allowedTargets = preliminary?.entity.support_target_ids || [];
  const targetId = target.targetId || context.selectedTargetId || (allowedTargets.length === 1 ? allowedTargets[0] : undefined) || (context.schoolTargets.length === 1 ? context.schoolTargets[0].id : undefined) || (sourceType === 'common' ? option?.targetId : undefined);
  if (!targetId && context.schoolTargets.length) throw new ApiError(409,'복습할 지원처를 먼저 선택해 주세요.');
  const source = sourceFor(context,{...target,sourceType,...(targetId ? {targetId} : {})});
  if (!source) throw new ApiError(404,'나의 자료에 있는 학습 항목을 선택해 주세요.');
  const allowed = source.entity.support_target_ids || [];
  if (targetId && allowed.length && !allowed.includes(targetId)) throw new ApiError(409,'선택한 지원처의 질문을 선택해 주세요.');
  const registered = context.schoolTargets.find(row => row.id === targetId);
  if (targetId && !registered) throw new ApiError(404,'지원 학교를 찾을 수 없어요.');
  const archivedTarget = source.learning?.support_targets?.find((item:Value) => item.id === targetId);
  if(archivedTarget && registered && !sameTarget(archivedTarget,registered.data))throw new ApiError(409,'지원 학교 정보가 변경되었어요. 현재 지원 정보에 맞는 질문을 선택해 주세요.');
  const snapshot = archivedTarget || registered && {...registered.data,id:registered.id} || null;
  if (sourceType === 'personal' && source.sourceVersion !== context.contentVersion && registered && !archivedTarget) throw new ApiError(409,'이전 자료의 지원처를 확인할 수 없어요. 저장한 답변에서 확인해 주세요.');
  return {kind:source.kind,id:source.id,title:source.title,sourceType,sourceVersion:source.sourceVersion,contentVersion:sourceType === 'personal' ? source.sourceVersion : context.contentVersion,
    ...(sourceType === 'common' ? {common:true} : {}),...(targetId ? {targetId,targetSnapshot:snapshot} : {}),
    ...(source.kind === 'question' ? {questionSnapshot:source.entity,activityIds:source.entity.activity_ids || []} : {activityIds:[source.id]})};
}
export function presentPlan(plan: Record<string, any>, context: Context) {
  const target = plan.target as PlanTarget | null;
  const source = target && ['question','activity'].includes(target.kind) ? sourceFor(context,target) : null;
  const current = target?.targetId ? context.schoolTargets.find(row => row.id === target.targetId) : null;
  const sourceTarget = source?.learning?.support_targets?.find((item:Value) => item.id === target?.targetId);
  const scopeAvailable = !target?.targetId || Boolean(current && (!target.targetSnapshot || sameTarget(target.targetSnapshot,current.data)) && (!sourceTarget || sameTarget(sourceTarget,current.data)));
  const scopeKnown = Boolean(target?.targetId || !context.schoolTargets.length);
  const available = Boolean(target && !(target.common && !target.sourceVersion) && (['question','activity'].includes(target.kind) ? source && scopeAvailable && scopeKnown : context.targets.some(item => item.kind === target.kind && item.id === target.id)));
  const questionIds = new Set<string>(target?.kind === 'question' ? [target.id] : target?.kind === 'activity' ? (source?.learning?.questions || []).filter((question:Value) => question.activity_ids?.includes(target.id)).map((question:Value) => question.id) : []);
  const performed = target && context.events.find(event => planPracticeEventMatches(plan,event,questionIds,sameTarget,context.events));
  return {...plan,href:available ? planTargetHref(target!,plan.kind)+(plan.kind==='interview'&&plan.target?.focusPractice?'&followups=1':'') : null,targetAvailable:!target || available,performedAt:performed?.created_at || null,completionSource:plan.completed ? 'manual' : null};
}
