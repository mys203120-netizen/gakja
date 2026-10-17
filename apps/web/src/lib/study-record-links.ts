type SavedStudyContext = Record<string, any>;

const commonSources = new Set(['common', 'general_practice', 'book_reference', 'verified_past', 'school_talent']);
const positiveVersion = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 100000 ? String(Number(value)) : null;

/** A history link belongs to its saved event, never the currently selected school. */
function savedStudyContext(record: SavedStudyContext) {
  const query = new URLSearchParams();
  const snapshot = record.targetSnapshot || record.target_snapshot;
  const targetId = record.targetId || record.target_id || snapshot?.id;
  const source = record.sourceType || record.source_type || record.sourceKind || record.source_kind;
  const commonRevision = positiveVersion(record.commonRevision ?? record.common_revision);
  const contentVersion = positiveVersion(record.contentVersion ?? record.content_version);
  const common = Boolean(commonRevision || commonSources.has(source));
  if (typeof targetId === 'string' && targetId) query.set('targetId', targetId);
  if (common) {
    query.set('sourceType', 'common');
    if (commonRevision) query.set('sourceVersion', commonRevision);
  } else if (source === 'personal' || contentVersion) {
    query.set('sourceType', 'personal');
    if (contentVersion) query.set('sourceVersion', contentVersion);
  }
  return query;
}

export function studyAnswerComparisonHref(questionId: string, record: SavedStudyContext, turnId?: string) {
  const query = savedStudyContext(record);
  if (turnId) query.set('turnId', turnId);
  return '/records/comparisons/' + encodeURIComponent(questionId) + (query.size ? '?' + query.toString() : '');
}

export function studyWeakPointHref(point: SavedStudyContext) {
  const query = new URLSearchParams();
  if (point.memoryItemId) query.set('memoryItemId', String(point.memoryItemId));
  else if (point.questionId) query.set('questionId', String(point.questionId));
  for (const [key, value] of savedStudyContext(point)) query.set(key, value);
  return '/quiz' + (query.size ? '?' + query.toString() : '');
}
