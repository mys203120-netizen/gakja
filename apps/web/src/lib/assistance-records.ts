export type HelpKind = 'evidence' | 'ai' | 'hint' | 'video' | 'carried_help';
export type HelpReceipt = { kind: HelpKind; receiptId: string; at: string; threadId?: string; messageId?: string; status?: 'partial' | 'completed' | 'interrupted'; updatedAt?: string };

/** Help is attempt evidence, never an answer, correctness judgment or learning achievement. */
export function addHelpReceipt(data: Record<string, any>, receipt: HelpReceipt) {
  const events: HelpReceipt[] = Array.isArray(data.helpEvents) ? data.helpEvents : [];
  const known = events.some(event => event.receiptId === receipt.receiptId);
  return {
    ...data,
    assistance_recorded: true,
    assisted: true,
    hint_used: data.hint_used === true || receipt.kind === 'hint',
    helpKinds: [...new Set([...(Array.isArray(data.helpKinds) ? data.helpKinds : []), receipt.kind])],
    helpEvents: known ? events.map(event=>event.receiptId!==receipt.receiptId?event:{...event,...receipt,at:event.at,status:event.status==='completed'?'completed':receipt.status||event.status,updatedAt:receipt.at}) : [...events, receipt].slice(-100),
  };
}

export type InterviewHelpScope = { sessionId: string; turnId: string; questionId: string; targetId: string | null; contentVersion: string; activityId: string | null; briefingId: string | null };
export function interviewHelpContextMatches(scope: InterviewHelpScope, context: Record<string, any>) {
  return (context.targetId || null) === scope.targetId
    && String(context.contentVersion) === scope.contentVersion
    && (context.briefingId || null) === scope.briefingId
    && (scope.briefingId ? true : context.questionId === scope.questionId)
    && (!scope.activityId || context.activityId === scope.activityId);
}

/** Missing legacy help logs cannot prove independent performance. */
export function assistanceEvidence(data: Record<string, any> = {}) {
  const helpKinds = Array.isArray(data.helpKinds) ? data.helpKinds : [];
  const hintUsed = data.hint_used === true || data.hintUsed === true || helpKinds.includes('hint');
  const assisted = data.assisted === true || hintUsed || helpKinds.length > 0;
  return { assistance_recorded: data.assistance_recorded === true, assisted, hint_used: hintUsed, helpKinds };
}
