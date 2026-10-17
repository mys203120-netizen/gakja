type MaterialEntity = Record<string, any>;
const approved = new Set(['verified', 'approved', 'confirmed', 'synthetic_reviewed', 'confirmed_from_record', 'confirmed_by_student']);

/** An evaluation belongs to one support target; a missing match must not borrow another school's grade. */
export function materialActivityEvaluation(activity: MaterialEntity, targetId?: string) {
  const assignment = targetId ? activity.priority_assignments?.find((item: MaterialEntity) => item.support_target_id === targetId) : undefined;
  return {
    targetId: assignment?.support_target_id || null,
    priority: targetId ? assignment?.priority || null : activity.interview_priority || null,
    reason: targetId ? assignment?.reason || assignment?.priority_reason || null : activity.priority_reason || null,
    talentTags: assignment?.talent_tags ?? activity.talent_tags ?? [],
    majorRelevance: assignment?.major_relevance !== undefined ? assignment.major_relevance : activity.major_relevance,
    representativeCandidate: assignment?.representative_candidate,
    representativeReason: assignment?.representative_reason || null,
    sourceRefIds: assignment?.source_ref_ids || [],
  };
}

export function materialQuestionMatchesTarget(question: MaterialEntity, targetId?: string) {
  return !targetId || !question.support_target_ids?.length || question.support_target_ids.includes(targetId);
}

/** Use authored, approved practice items only; do not generate answers from an activity summary. */
export function materialQuestionPracticeItems(question: MaterialEntity, memoryItems: MaterialEntity[], targetId?: string) {
  if (!approved.has(question.verification_status) || !materialQuestionMatchesTarget(question, targetId)) return [];
  return memoryItems.filter(item => {
    if (item.question_id !== question.id || !approved.has(item.verification_status) || item.kind === 'order') return false;
    if (item.kind !== 'choice') return true;
    return item.options?.length === 4 && new Set(item.options.map((option: MaterialEntity) => option.id)).size === 4
      && item.options.every((option: MaterialEntity) => typeof option.text === 'string' && option.text.trim())
      && item.options.some((option: MaterialEntity) => option.id === item.correct_option_id)
      && item.evaluation_method === 'reviewed_correct_answer' && item.category !== 'experiential';
  });
}

export function materialInterviewHref(questionId: string, context: { targetId?: string; sourceVersion?: number }) {
  const query = new URLSearchParams({ questionId, sourceType: 'personal' });
  if (context.targetId) query.set('targetId', context.targetId);
  if (context.sourceVersion) query.set('sourceVersion', String(context.sourceVersion));
  return '/interview/new?' + query.toString();
}

/** Current published materials must keep their school and publication when opening another workspace. */
export function materialContextHref(path: '/on' | '/records/comparisons', context: { questionId?: string; activityId?: string; briefingId?: string; targetId?: string; sourceVersion?: number }) {
  const query = new URLSearchParams({ sourceType: 'personal' });
  if (context.questionId) query.set('questionId', context.questionId);
  if (context.activityId) query.set('activityId', context.activityId);
  if (context.briefingId) query.set('briefingId', context.briefingId);
  if (context.targetId) query.set('targetId', context.targetId);
  if (Number.isInteger(context.sourceVersion) && Number(context.sourceVersion) > 0) query.set('sourceVersion', String(context.sourceVersion));
  return path + '?' + query.toString();
}

/** Explicit links never fall back to another school's or another publication's answer. */
export function materialComparisonVersions<T extends MaterialEntity>(versions: T[], context: { targetId?: string | null; sourceType?: string | null; sourceVersion?: string | null }) {
  const commonTypes = new Set(['common', 'general_practice', 'book_reference', 'verified_past']);
  const requestedVersion = context.sourceVersion ? Number(context.sourceVersion) : null;
  if (context.sourceType && !['personal', 'common'].includes(context.sourceType)) return [];
  if (context.sourceVersion && (!Number.isInteger(requestedVersion) || Number(requestedVersion) < 1)) return [];
  return versions.filter(version => {
    if (context.targetId && version.target_id !== context.targetId) return false;
    const sourceType = Number(version.common_revision) > 0 || commonTypes.has(version.source_type || version.source_kind) ? 'common' : 'personal';
    if (context.sourceType && sourceType !== context.sourceType) return false;
    if (requestedVersion !== null && Number(sourceType === 'common' ? version.common_revision : version.content_version) !== requestedVersion) return false;
    return true;
  });
}

export function materialQuizHref(item: MaterialEntity, targetId?: string, mode?: 'choice' | 'answer' | 'oral', sourceVersion?: number) {
  const query = new URLSearchParams({ memoryItemId: item.id, mode: mode || (item.kind === 'choice' ? 'choice' : 'answer'), sourceType: 'personal' });
  if (targetId) query.set('targetId', targetId);
  if (sourceVersion) query.set('sourceVersion', String(sourceVersion));
  return '/quiz?' + query.toString();
}

export function materialFactStatusLabel(status: string) {
  return ({
    verified: '검증 완료', approved: '검수 완료', confirmed: '확인 완료', synthetic_reviewed: '테스트 검수본',
    confirmed_from_record: '학생부에서 확인', confirmed_by_student: '학생이 확인',
    needs_confirmation: '확인 필요', student_says_different: '기록과 다름', cannot_confirm: '확인할 수 없음',
  } as Record<string, string>)[status] || '확인 필요';
}

export function publishedMaterialBooks(documents: MaterialEntity[]) {
  const books = [{ kind: 'guidebook', title: '가이드북', sub: '활동 분석과 답변 설계' }, { kind: 'handbook', title: '암기 핸드북', sub: '핵심 내용과 회상 훈련' }];
  return books.filter(book => documents.some(document => document.kind === book.kind || (book.kind === 'handbook' && document.kind === 'memory_handbook')));
}
