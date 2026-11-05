import type { InterviewSession } from './protocol';

/** One real started question spends one F; replay attempts and prepared drafts do not. */
export function deliveredFollowUpCount(session: Pick<InterviewSession, 'questionPresentations'>, rootTurnId: string | null | undefined): number {
  return new Set((session.questionPresentations ?? []).filter(row => row.rootTurnId === rootTurnId && row.questionKind === 'follow_up' && row.startedAtMs !== null).map(row => row.turnId)).size;
}
