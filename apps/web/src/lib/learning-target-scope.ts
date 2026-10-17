import { learningTargetIdentityMatches } from '@gakja/content-contracts/workflows';

type RecordValue = Record<string, any>;

/** Recommendations require both an active registration and its saved identity. */
export function recordMatchesCurrentTarget(record: RecordValue, targets: RecordValue[]): boolean {
  const id = record.target_id || record.targetId;
  const snapshot = record.target_snapshot || record.targetSnapshot;
  return Boolean(id && snapshot && targets.some(target => !target.archived_at && target.id === id &&
    learningTargetIdentityMatches(learningScopeIdentity(snapshot), learningScopeIdentity(target))));
}

/** Client-safe aliases only: this never rewrites a stored support-target snapshot. */
export function learningScopeIdentity(target: RecordValue) {
  return {
    university: target.university || '',
    admission_year: target.admission_year || target.year || null,
    campus: target.campus || '',
    department: target.department || target.major || '',
    admission_type: target.admission_type || target.track || '',
    interview_stage: target.interview_stage || target.stage || null,
    ...(target.interest_department?{interest_department:target.interest_department}:{}),
  };
}

export function interviewTargetSnapshot(session: RecordValue): RecordValue | null {
  return session.data?.context?.target || session.supportTarget || null;
}

/** A stable ID alone must not move a frozen interview into a changed school context. */
export function interviewMatchesLearningTarget(session: RecordValue, target: RecordValue | null | undefined): boolean {
  if (!target?.id) return false;
  const savedId = session.target_id || session.data?.context?.targetId;
  const snapshot = interviewTargetSnapshot(session);
  return Boolean(savedId === target.id && snapshot
    && learningTargetIdentityMatches(learningScopeIdentity(snapshot), learningScopeIdentity(target)));
}

export function splitInterviewsByLearningTarget<T extends RecordValue>(sessions: T[], target: RecordValue | null | undefined) {
  return {
    current: sessions.filter(session => interviewMatchesLearningTarget(session, target)),
    other: sessions.filter(session => !interviewMatchesLearningTarget(session, target)),
  };
}

/** Unscoped personal plans stay visible; school-specific items follow the selected target. */
export function inLearningTargetScope(itemTargetId: unknown, selectedTargetId: string, includeAll = false): boolean {
  return includeAll || !selectedTargetId || !itemTargetId || itemTargetId === selectedTargetId;
}
