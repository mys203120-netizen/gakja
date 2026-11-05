import { createHash } from 'node:crypto';
import type { InterviewContext } from '../data/load-interview-context';
import type { InterviewSession, QuestionDraft } from '../protocol';
import { assertQuestionContractIntegrity, createQuestionBlueprint, approveQuestionContract } from '../question-objective';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
/** Exact audio re-listening is a new non-evaluative attempt, not a new meaning demand or semantic generation. */
export function approvedAudioReplay(context: InterviewContext, session: InterviewSession): QuestionDraft | null {
  const previous = session.turns.at(-1), contract = previous?.metadata.approvedQuestion, audit = previous?.metadata.premiseValidation;
  if (!previous || previous.transcriptStatus !== 'finalized' || !contract || !audit || context.errors.length || audit.questionSha256 !== hash(previous.questionText) || previous.metadata.rulesVersion !== context.manifest.rulesVersion) return null;
  try {
    const original: QuestionDraft = { ...structuredClone(previous.metadata), acknowledgement: null, acknowledgementQuote: null, questionText: previous.questionText, questionKind: previous.questionKind, parentMainQuestionId: previous.questionKind === 'main' ? null : previous.parentMainQuestionId, evidenceIds: [...previous.evidenceIds] };
    assertQuestionContractIntegrity(original, contract);
    for (const ref of contract.blueprint.anchorRefs) {
      if (ref.kind === 'RECORD') {
        const source = context.student.evidence.find(source => source.id === ref.sourceId);
        if (!source || source.sourceRef.pdfSha256 !== ref.revision || ref.start < 0 || ref.end <= ref.start || ref.end > source.text.length) return null;
      } else if (ref.kind === 'ANSWER_TURN') {
        const source = session.turns.find(turn => ref.sourceId === `ANSWER_TURN:${turn.id}:${turn.answerId}`);
        if (!source || source.transcriptStatus !== 'finalized' || hash(source.rawTranscript ?? '') !== ref.revision || ref.start < 0 || ref.end <= ref.start || ref.end > (source.rawTranscript?.length ?? 0)) return null;
      } else return null;
    }
    if (contract.blueprint.grounding.kind === 'COMMON_APPROVED' && contract.blueprint.grounding.supportTargetId !== context.school.interview?.id) return null;
    const draft: QuestionDraft = { ...original, questionKind: 'clarification', clarificationMode: 'repeat_audio', parentMainQuestionId: previous.parentMainQuestionId,
      premiseValidation: { ...structuredClone(audit), method: 'verified_approved_restatement', reusedFrom: { turnId: previous.id, questionSha256: audit.questionSha256, transform: 'exact' } } };
    delete draft.approvedQuestion; delete draft.questionBlueprint;
    const answerRefs = contract.blueprint.anchorRefs.filter(ref => ref.kind === 'ANSWER_TURN').map(ref => {
      const source = session.turns.find(turn => ref.sourceId === `ANSWER_TURN:${turn.id}:${turn.answerId}`)!;
      return { turnId: source.id, answerId: source.answerId!, start: ref.start, end: ref.end };
    });
    const blueprint = createQuestionBlueprint(draft, context, session, { grounding: contract.blueprint.grounding, targetDescription: contract.blueprint.target.description, subordinationRationale: contract.blueprint.subordinationRationale, expansionRationale: contract.blueprint.expansionRationale, strategyIds: contract.blueprint.strategyIds, answerRefs });
    draft.questionBlueprint = blueprint;
    draft.approvedQuestion = approveQuestionContract(draft, blueprint, { policyDigest: contract.policyDigest ?? undefined, strategyCatalogDigest: contract.strategyCatalogDigest ?? undefined });
    draft.providerTimings = { premiseReviewMs: 0, premiseReviewAttempts: 0, approvedAudioReplayReuse: 1 };
    return draft;
  } catch { return null; }
}
