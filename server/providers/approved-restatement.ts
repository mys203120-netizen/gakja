import { createHash } from 'node:crypto';
import type { InterviewContext } from '../data/load-interview-context';
import type { InterviewSession, QuestionDraft } from '../protocol';
import type { AnswerReaction } from './answer-reaction';
import { canonicalizeQuestionCitations, type GroundingSource } from './question-grounding';
import { assertQuestionPresentation, assertReactionQuestionDraft, attachVerifiedQuestionPlan } from './question-plan';
import { assertInterviewQuestionSpeech } from './interview-speech';
import { matchesConstrainedFollowUpTemplate } from './realtime-core';
import { assertQuestionContractIntegrity, createQuestionBlueprint, approveQuestionContract } from '../question-objective';
import { buildQuestionAnchorCandidates, restoreQuestionIR, QUESTION_REALIZATION_VERSION, type QuestionAnchor, type QuestionIR, type RealizedQuestion } from './question-realization';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Rehydrate only an existing approved surface against its earlier actual same-cluster sources. */
function restoreStrategyQuestion(session: InterviewSession): RealizedQuestion | null {
  const previous = session.turns.at(-1), saved = previous?.metadata.questionRealization;
  const audit = previous?.metadata.premiseValidation;
  if (!previous || !saved || saved.policyVersion !== QUESTION_REALIZATION_VERSION || saved.semanticReview !== 'not_independently_reviewed' || !audit || audit.method !== 'approved_strategy_ir' || audit.reviewModel !== QUESTION_REALIZATION_VERSION || !saved.anchorProof?.length || saved.anchorProof.length > 2) return null;
  const anchors: QuestionAnchor[] = [];
  for (const proof of saved.anchorProof) {
    const sourceIndex = session.turns.findIndex(turn => proof.sourceId === 'ANSWER_TURN:' + turn.id + ':' + turn.answerId);
    const source = session.turns[sourceIndex];
    if (!source || sourceIndex >= session.turns.length - 1 || source.parentMainQuestionId !== previous.parentMainQuestionId || source.transcriptStatus !== 'finalized' || !source.answerId || typeof source.rawTranscript !== 'string' || hash(source.rawTranscript) !== proof.sourceSha256 || !Number.isInteger(proof.sourceStartOffset) || !Number.isInteger(proof.sourceEndOffset) || proof.sourceStartOffset < 0 || proof.sourceEndOffset > source.rawTranscript.length || proof.sourceEndOffset <= proof.sourceStartOffset) return null;
    const quote = source.rawTranscript.slice(proof.sourceStartOffset, proof.sourceEndOffset);
    const anchor = buildQuestionAnchorCandidates({ turnId: source.id, answerId: source.answerId, rawTranscript: source.rawTranscript, quoteOptions: [quote] }).find(candidate => candidate.id === proof.anchorId && candidate.start === proof.sourceStartOffset && candidate.end === proof.sourceEndOffset);
    if (!anchor || anchors.some(existing => existing.id === anchor.id)) return null;
    anchors.push(anchor);
  }
  if (saved.anchorId !== anchors[0].id) return null;
  try {
    const ir = { operation: saved.operation, anchorId: saved.anchorId, anchorMode: saved.anchorMode, secondaryAnchorId: anchors[1]?.id ?? null } as QuestionIR;
    const restored = restoreQuestionIR(ir, { anchors, templateId: saved.templateId, questionText: previous.questionText, primaryTurnId: anchors[0].turnId, contradictionPairs: anchors.length === 2 ? [[anchors[0].id, anchors[1].id]] : [] });
    if (restored.primaryFunction !== previous.metadata.primaryFunction || restored.depth !== previous.metadata.depth || restored.questionIntent !== previous.metadata.questionIntent || JSON.stringify(restored.targetEvidence) !== JSON.stringify(previous.metadata.targetEvidence) || restored.family !== saved.family || JSON.stringify(restored.anchorProof) !== JSON.stringify(saved.anchorProof) || JSON.stringify(restored.proof) !== JSON.stringify(audit.supportedPremises) || JSON.stringify(restored.openChecks) !== JSON.stringify(audit.openChecks)) return null;
    return restored;
  } catch { return null; }
}

/** A verified projection of an approved question, not an approval cache for newly generated text. */
export function approvedRestatement(context: InterviewContext, session: InterviewSession, sources: GroundingSource[], reaction?: AnswerReaction): QuestionDraft | null {
  if (reaction?.directive !== 'clarification_same_target') return null;
  const previous = session.turns.at(-1), audit = previous?.metadata.premiseValidation;
  if (context.errors.length || !context.manifest.sourceIntegrity.evidenceTextVerified) return null;
  if (!previous || previous.transcriptStatus !== 'finalized' || !audit || audit.status !== 'approved' || audit.version !== 'question-premise-v1' || audit.guidelineVersion !== '2.3' || audit.coreIntentCount !== 1 || audit.method !== 'bounded_semantic_review' && audit.method !== 'constrained_answer_follow_up' && audit.method !== 'approved_strategy_ir') return null;
  if (previous.metadata.rulesVersion !== context.manifest.rulesVersion || audit.questionSha256 !== hash(previous.questionText)) return null;
  const snapshot = session.sourceManifest as Partial<InterviewContext['manifest']> | null;
  if (!snapshot || snapshot.rulesVersion !== context.manifest.rulesVersion || !Array.isArray(snapshot.files)) return null;
  const savedFiles = snapshot.files as Array<{ role: string; path: string; sha256: string | null }>;
  const currentFiles = context.manifest.files;
  if (savedFiles.some(file => !file || typeof file.role !== 'string' || typeof file.path !== 'string' || typeof file.sha256 !== 'string') || savedFiles.length !== currentFiles.length || currentFiles.some(file => !file.sha256 || !savedFiles.some(saved => saved.role === file.role && saved.path === file.path && saved.sha256 === file.sha256))) return null;
  try {
    if (previous.metadata.approvedQuestion) assertQuestionContractIntegrity({ ...previous.metadata, acknowledgement: null, acknowledgementQuote: null, questionText: previous.questionText, questionKind: previous.questionKind, parentMainQuestionId: previous.questionKind === 'main' ? null : previous.parentMainQuestionId, evidenceIds: previous.evidenceIds }, previous.metadata.approvedQuestion);
    else if (audit.method === 'approved_strategy_ir') return null;
  } catch { return null; }
  // Only a standalone, non-factual greeting may be removed. All question words remain identical.
  const greeting = /^(?:안녕하세요|안녕하십니까)[.!。]\s*/u.exec(previous.questionText)?.[0] ?? '';
  const questionText = previous.questionText.slice(greeting.length);
  const spans = [...audit.supportedPremises, ...audit.openChecks];
  if (!spans.length || spans.some(span => span.questionStartOffset < greeting.length || span.questionEndOffset > previous.questionText.length || span.questionEndOffset <= span.questionStartOffset)) return null;
  const restoredStrategy = audit.method === 'approved_strategy_ir' ? restoreStrategyQuestion(session) : null;
  if (audit.method === 'approved_strategy_ir') {
    if (greeting || !restoredStrategy) return null;
  } else if (audit.method === 'constrained_answer_follow_up') {
    if (greeting || audit.reviewModel !== 'server-verified-template-v1' || audit.supportedPremises.length !== 1 || audit.openChecks.length) return null;
    const proof = audit.supportedPremises[0];
    const sourceIndex = session.turns.findIndex(turn => proof.sourceId === `ANSWER_TURN:${turn.id}:${turn.answerId}`);
    const source = session.turns[sourceIndex];
    if (proof.basis !== 'answer_turn_attributed' || !source || sourceIndex >= session.turns.length - 1 || source.parentMainQuestionId !== previous.parentMainQuestionId || source.transcriptStatus !== 'finalized' || !source.answerId || typeof source.rawTranscript !== 'string' || !Number.isInteger(proof.sourceStartOffset) || !Number.isInteger(proof.sourceEndOffset) || proof.sourceStartOffset < 0 || proof.sourceEndOffset > source.rawTranscript.length || proof.sourceEndOffset <= proof.sourceStartOffset) return null;
    const quote = source.rawTranscript.slice(proof.sourceStartOffset, proof.sourceEndOffset);
    if (previous.questionText.slice(proof.questionStartOffset, proof.questionEndOffset) !== quote || !matchesConstrainedFollowUpTemplate(previous.questionText, quote)) return null;
  } else if (audit.supportedPremises.some(proof => {
    if (proof.basis === 'record') return !sources.some(source => source.id === proof.sourceId && proof.sourceStartOffset >= 0 && proof.sourceEndOffset <= source.text.length && proof.sourceEndOffset > proof.sourceStartOffset);
    const sourceIndex = session.turns.findIndex(turn => proof.sourceId === 'ANSWER_TURN:' + turn.id + ':' + turn.answerId);
    const source = session.turns[sourceIndex];
    return !source || sourceIndex >= session.turns.length - 1 || source.parentMainQuestionId !== previous.parentMainQuestionId || source.transcriptStatus !== 'finalized' || typeof source.rawTranscript !== 'string' || proof.sourceStartOffset < 0 || proof.sourceEndOffset > source.rawTranscript.length || proof.sourceEndOffset <= proof.sourceStartOffset;
  })) return null;
  try {
    const draft = canonicalizeQuestionCitations({
      acknowledgement: null, acknowledgementQuote: null, questionText, questionKind: 'clarification',
      ...(previous.metadata.commonApproval ? { commonApproval: structuredClone(previous.metadata.commonApproval) } : {}),
      parentMainQuestionId: previous.parentMainQuestionId, evidenceIds: [...previous.evidenceIds], evidenceQuotes: structuredClone(previous.metadata.evidenceQuotes),
      primaryFunction: previous.metadata.primaryFunction, questionIntent: previous.metadata.questionIntent,
      targetEvidence: [...previous.metadata.targetEvidence], depth: previous.metadata.depth,
      groundingRationale: '같은 원문·규칙에서 승인된 질문을 추가 요구 없이 그대로 재제시한다.', validationStatus: 'approved', validationFailures: [],
    }, sources);
    assertQuestionPresentation(draft);
    if (restoredStrategy) {
      // Exact registry restoration already preserves the original request; no keyword proxy is needed.
      if (reaction.sourceTurnId !== previous.id || reaction.sourceAnswerId !== previous.answerId || reaction.parentMainQuestionId !== previous.parentMainQuestionId) return null;
    } else assertReactionQuestionDraft(draft, session, reaction);
    assertInterviewQuestionSpeech(questionText, { isFirstTurn: false }); attachVerifiedQuestionPlan(draft, session);
    draft.premiseValidation = { ...structuredClone(audit), method: 'verified_approved_restatement', questionSha256: hash(questionText),
      reusedFrom: { turnId: previous.id, questionSha256: audit.questionSha256, transform: greeting ? 'remove_standalone_greeting' : 'exact' },
      supportedPremises: audit.supportedPremises.map(proof => ({ ...proof, questionStartOffset: proof.questionStartOffset - greeting.length, questionEndOffset: proof.questionEndOffset - greeting.length })),
      openChecks: audit.openChecks.map(proof => ({ ...proof, questionStartOffset: proof.questionStartOffset - greeting.length, questionEndOffset: proof.questionEndOffset - greeting.length })),
    };
    draft.providerTimings = { premiseReviewMs: 0, premiseReviewAttempts: 0, approvedRestatementReuse: 1 };
    // Reusing an approved sentence also preserves its reference/template provenance.
    if (previous.metadata.questionReferenceContext) draft.questionReferenceContext = structuredClone(previous.metadata.questionReferenceContext);
    if (previous.metadata.followUpLanguage) draft.followUpLanguage = structuredClone(previous.metadata.followUpLanguage);
    if (previous.metadata.questionRealization) draft.questionRealization = structuredClone(previous.metadata.questionRealization);
    if (previous.metadata.strategyTrace) draft.strategyTrace = structuredClone(previous.metadata.strategyTrace);
    if (previous.metadata.approvedQuestion) {
      const priorBlueprint = previous.metadata.approvedQuestion.blueprint;
      const answerRefs = priorBlueprint.anchorRefs.filter(ref => ref.kind === 'ANSWER_TURN').map(ref => {
        const source = session.turns.find(turn => ref.sourceId === 'ANSWER_TURN:' + turn.id + ':' + turn.answerId);
        if (!source?.answerId || ref.revision !== hash(source.rawTranscript ?? '')) throw new Error('RESTATEMENT_ANSWER_REF_STALE');
        return { turnId: source.id, answerId: source.answerId, start: ref.start, end: ref.end };
      });
      const questionBlueprint = createQuestionBlueprint(draft, context, session, { targetDescription: priorBlueprint.target.description, expansionRationale: priorBlueprint.expansionRationale, subordinationRationale: priorBlueprint.subordinationRationale, strategyIds: priorBlueprint.strategyIds, answerRefs });
      draft.questionBlueprint = questionBlueprint;
      draft.approvedQuestion = approveQuestionContract(draft, questionBlueprint, { policyDigest: previous.metadata.approvedQuestion.policyDigest ?? undefined, strategyCatalogDigest: previous.metadata.approvedQuestion.strategyCatalogDigest ?? undefined });
    }
    return draft;
  } catch { return null; }
}
