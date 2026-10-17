import {growthContextKey,growthContextResolver,growthStage,type GrowthVersion} from './learning-growth';

export function validPlanDay(value: string): boolean {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function koreaToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
export function shiftPlanDay(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export function planWeek(day: string): string[] {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  const monday = shiftPlanDay(day, -((weekday + 6) % 7));
  return Array.from({length:7},(_,i)=>shiftPlanDay(monday,i));
}
export function monthDays(month: string): string[] {
  const first = `${month}-01`, weekday = new Date(`${first}T00:00:00Z`).getUTCDay();
  const start = shiftPlanDay(first,-weekday);
  const [year,number] = month.split('-').map(Number);
  const size = new Date(Date.UTC(year,number,0)).getUTCDate();
  return Array.from({length:Math.ceil((weekday+size)/7)*7},(_,i)=>shiftPlanDay(start,i));
}
export type PlanTarget = {
  kind: 'question' | 'activity' | 'video' | 'assignment'; id: string; common?: boolean; targetId?: string;
  sourceType?: 'personal' | 'common'; sourceVersion?: number; contentVersion?: number | null;
  targetSnapshot?: Record<string, any> | null; questionSnapshot?: Record<string, any> | null;
  activityIds?: string[];
};
export type PlanTargetOption = PlanTarget & { title: string };
/** Receives server-validated owned targets; the client never supplies a URL. */
export function planTargetHref(target: PlanTarget, kind: string): string {
  const id = encodeURIComponent(target.id);
  if (target.kind === 'video') return `/knowledge/${id}`;
  if (target.kind === 'assignment') return `/quiz/assignments/${id}`;
  const context = new URLSearchParams();
  if (target.targetId) context.set('targetId', target.targetId);
  if (target.sourceType || target.common) context.set('sourceType', target.sourceType || 'common');
  else if (!target.common && target.contentVersion) context.set('sourceType', 'personal');
  const version = target.sourceVersion ?? (target.sourceType !== 'common' ? target.contentVersion : undefined);
  if (version) context.set('sourceVersion', String(version));
  const suffix = context.size ? '&' + context.toString() : '';
  if (target.kind === 'activity') return kind === 'interview' ? `/interview/new?activityId=${id}${suffix}` : `/materials/activities/${id}${context.size ? '?' + context.toString() : ''}`;
  return kind === 'quiz' ? `/quiz?questionId=${id}${suffix}` : kind === 'interview' || target.common ? `/interview/new?questionId=${id}${suffix}` : `/materials/questions/${id}${context.size ? '?' + context.toString() : ''}`;
}

/** An actual review must happen after scheduling, on/after its Korean calendar day, in the saved source context. */
export function planPracticeEventMatches(plan: Record<string, any>, event: Record<string, any>, questionIds: Set<string>, sameTargetSnapshot: (saved: Record<string, any>, actual: Record<string, any>) => boolean, scopeEvents: Record<string, any>[] = [event]): boolean {
  const target = plan.target as PlanTarget | null;
  if (!target) return false;
  const eventTime = new Date(event.created_at), createdAt = new Date(plan.created_at);
  if (!Number.isFinite(eventTime.getTime()) || !Number.isFinite(createdAt.getTime()) || eventTime < createdAt || koreaToday(eventTime) < plan.date) return false;
  const data = event.data || {};
  if (target.kind === 'video') return event.kind === 'knowledge_progress' && data.videoId === target.id && (data.completed === true || data.explanationSaved === true || data.action === 'reflection' && Boolean(data.reflection?.trim()));
  if (target.kind === 'assignment') return data.assignmentId === target.id && event.kind === 'assignment_submission';
  if (plan.kind === 'quiz' && !['quiz_response','memory_review','assignment_submission'].includes(event.kind)) return false;
  if (plan.kind === 'interview' && event.kind !== 'interview_answer') return false;
  if (!questionIds.has(data.questionId) && !(target.kind === 'activity' && Array.isArray(data.activityIds) && data.activityIds.includes(target.id))) return false;
  const actualTargetId = data.targetId || data.target_id || null;
  // A legacy unscoped plan cannot claim practice performed for an unrelated school.
  if ((target.targetId || null) !== actualTargetId) return false;
  if (target.targetSnapshot) {
    const snapshot = data.targetSnapshot || data.target_snapshot;
    if (!snapshot || !sameTargetSnapshot(target.targetSnapshot, snapshot)) return false;
  }
  const commonRevision = data.commonRevision || data.common_revision;
  const common = Boolean(commonRevision || data.sourceKind === 'common' || data.source_kind === 'common' || data.sourceType === 'common' || data.source_type === 'common');
  if (target.sourceType === 'common' || target.common) {
    if (!common || Number(commonRevision) !== Number(target.sourceVersion)) return false;
  } else {
    const version = target.sourceVersion ?? target.contentVersion;
    if (common || !version || Number(data.contentVersion ?? data.content_version) !== Number(version)) return false;
  }
  const asVersion=(value:Record<string,any>,id:string):GrowthVersion=>({id,question_id:value.questionId||target.id,script:'',created_at:'',target_id:value.targetId||value.target_id||undefined,target_snapshot:value.targetSnapshot||value.target_snapshot||null,
    source_type:value.sourceType||value.source_type||value.sourceKind||value.source_kind,common_revision:value.commonRevision||value.common_revision,content_version:value.contentVersion??value.content_version});
  const saved=asVersion({questionId:data.questionId||target.id,targetId:target.targetId,targetSnapshot:target.targetSnapshot,sourceType:target.sourceType||(target.common?'common':'personal'),commonRevision:target.common||target.sourceType==='common'?target.sourceVersion:undefined,contentVersion:target.contentVersion??target.sourceVersion},'planned');
  const actual=asVersion(data,'performed');
  const versions=[saved,...scopeEvents.map((item,index)=>asVersion(item.data||{},'event-'+index))];
  const sameBase=(value:GrowthVersion)=>value.question_id===saved.question_id&&growthContextKey(value,null)===growthContextKey(saved,null);
  const knownStages=new Set(versions.filter(sameBase).map(value=>growthStage(value.target_snapshot?.interview_stage||value.target_snapshot?.stage)).filter(Boolean));
  // Missing stage data may join one known stage, but it must never bridge two different interview stages.
  if (knownStages.size>1&&(!growthStage(saved.target_snapshot?.interview_stage||saved.target_snapshot?.stage)||!growthStage(actual.target_snapshot?.interview_stage||actual.target_snapshot?.stage))) return false;
  const resolve=growthContextResolver(versions);
  return resolve(saved)===resolve(actual);
}
