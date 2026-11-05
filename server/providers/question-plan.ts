import { currentPlanSlot, nextMainPlanSlot } from "../interview-planner";
import type { InterviewSession, QuestionDraft } from "../protocol";
import { QuestionValidationError } from "./question-grounding";
import type { AnswerReaction } from "./answer-reaction";

/** Product speech budgets derived from the guideline's one-listen/one-task requirement. */
export const questionSpeechLimits = { main: 100, follow_up: 75, clarification: 80 } as const;
const hasSingleCoreFactReview = (draft: QuestionDraft) => draft.premiseValidation?.method === 'bounded_fact_review' && draft.premiseValidation.status === 'approved' && draft.premiseValidation.semanticAuthority === 'single_core';
const functionMeanings: Record<QuestionDraft["primaryFunction"], { name: string; meaning: string }> = {
  FACT: { name: "내용·사실 확인", meaning: "어떤 활동인지, 실제로 무엇을 했는지 확인한다." },
  MOTIVE: { name: "동기·계기", meaning: "왜 관심을 갖거나 참여했는지 확인한다." },
  ROLE: { name: "개인 기여", meaning: "본인이 구체적으로 담당한 행동을 확인한다." },
  PROCESS: { name: "수행 과정", meaning: "실제로 수행한 순서나 방법을 확인한다. 활동명이나 결과만 묻지 않는다." },
  CHOICE: { name: "선택·판단 근거", meaning: "왜 해당 주제나 방법을 선택했는지 판단 기준을 확인한다." },
  CONCEPT: { name: "개념·원리", meaning: "기록에 사용된 용어나 이론을 설명할 수 있는지 확인한다." },
  EVIDENCE: { name: "주장·결과의 근거", meaning: "무엇을 보고 해당 주장이나 결과를 판단했는지 근거를 확인한다. 결과 자체를 나열하도록 묻지 않는다." },
  RESULT: { name: "결과·산출물", meaning: "실제로 관찰하거나 제작하거나 도출한 내용을 확인한다." },
  LIMIT: { name: "오류·한계·반례", meaning: "결과를 어디까지 해석할 수 있는지 확인한다." },
  ALTERNATIVE: { name: "개선·대안", meaning: "다시 한다면 무엇을 바꿀지 확인한다." },
  TRANSFER: { name: "비교·새 상황 적용", meaning: "확인된 내용을 비슷한 문제에 어떻게 적용할지 확인한다." },
  CONNECTION: { name: "경험·교과·진로 연계", meaning: "앞선 경험이 다음 학습이나 관심으로 이어졌는지 열린 질문으로 확인한다." },
  VALUE: { name: "가치·태도·판단", meaning: "무엇을 우선했는지와 그 판단을 한 이유 중 한 가지 요구를 확인한다." },
  CLARIFY_CONTENT: { name: "답변 내용의 구체화", meaning: "실제 답변의 막연한 표현을 구체적인 행동 한 가지로 확인하는 평가용 후속 질문이다." },
  VERIFY_CLAIM: { name: "응답 주장 재검증", meaning: "실제 답변에서 새로 제시한 주장이나 사실의 근거 한 가지를 확인한다. 진실성이나 과학적 정답을 단정하지 않는다." },
};
const depthMeanings: Record<QuestionDraft["depth"], string> = {
  D1: "사실·기초 설명", D2: "과정·판단 이유", D3: "개념 적용·비교", D4: "근거 한계·반례·대안",
};
/** Restore only the selected definitions from guideline §§9–10, never the full matrix. */
export function questionFunctionContext(primaryFunction: QuestionDraft["primaryFunction"], depth: QuestionDraft["depth"]) {
  return { primaryFunction, ...functionMeanings[primaryFunction], depth: { code: depth, meaning: depthMeanings[depth] }, guidelineSections: [9, 10] };
}
/** Output-format contract only. This neither judges Korean grammatical meaning
 * nor adds punctuation/edits a model's sentence to make it pass. */
export function assertSubordinateQuestionTermination(draft: Pick<QuestionDraft, 'questionKind' | 'questionText'>) {
  if ((draft.questionKind === 'follow_up' || draft.questionKind === 'clarification') && !/[?.？。]$/u.test(draft.questionText.trimEnd())) throw new QuestionValidationError('INVALID_FORMAT');
}
export function assertQuestionPresentation(draft: QuestionDraft) {
  if (draft.questionKind === "end") return;
  assertSubordinateQuestionTermination(draft);
  if ([...draft.questionText].length > questionSpeechLimits[draft.questionKind]) throw new QuestionValidationError("UNAPPROVED_QUESTION");
  if (draft.questionKind !== "clarification" && draft.targetEvidence.length !== 1) throw new QuestionValidationError("MULTIPLE_QUESTIONS");
  if (!hasSingleCoreFactReview(draft) && /무엇(?:이며|이고).*(?:왜|어떻게|이유|근거)|(?:설명|말씀|알려)해\s*주(?:세요|십시오).*(?:그리고|또한|아울러).*(?:설명|말씀|알려)/u.test(draft.questionText)) throw new QuestionValidationError("MULTIPLE_QUESTIONS");
}

const purposeSignals: Partial<Record<QuestionDraft["primaryFunction"], RegExp>> = {
  PROCESS: /어떻게|순서|방법|방식|과정|절차|단계|진행|수행/u,
  CONCEPT: /의미|원리|개념|이해|무엇|어떤|영향|작용|관계/u,
  EVIDENCE: /근거|판단|확인|자료|해석|뒷받침|어떻게.{0,12}알/u,
  CHOICE: /왜|이유|기준|선택|고려|판단|결정/u,
  LIMIT: /한계|오차|어려|제약|확정|일반화|주의|불확실|적용.{0,8}범위|어디까지\s*해석|해석할\s*수\s*있는\s*범위/u,
  ALTERNATIVE: /개선|보완|바꾼|바꿀|다시|대안|달리/u,
  ROLE: /본인|직접|맡|담당|기여|역할/u,
  VALUE: /중요|우선|원칙|기준|판단|가치/u,
  CONNECTION: /이어|영향|연결|연계|관련|이후.{0,8}학습/u,
  MOTIVE: /계기|왜|이유|관심|동기/u,
  RESULT: /결과|관찰|도출|산출|얻|알게|변화/u,
  VERIFY_CLAIM: /근거|확인|구체|판단|어떻게|무엇/u,
};

export function questionPlanContext(session: InterviewSession) {
  return {
    nextMainSlot: nextMainPlanSlot(session),
    currentRootSlot: currentPlanSlot(session),
    mainQuestionTarget: session.mainQuestionTarget ?? session.plan?.mainQuestionTarget ?? null,
    limitations: session.plan?.limitations ?? [],
  };
}

/** Safe validation facts: no PDF text, raw answer, credentials or model prompt. */
export function questionPlanDiagnostics(draft: QuestionDraft, session: InterviewSession, reaction?: AnswerReaction) {
  const previous = session.turns.at(-1), slot = draft.questionKind === "main" ? nextMainPlanSlot(session) : currentPlanSlot(session);
  const root = session.turns.find(turn => turn.id === previous?.parentMainQuestionId) ?? previous;
  const functionForSurface = draft.questionKind === "main" ? slot?.primaryFunction : draft.questionKind === "clarification" ? previous?.metadata.primaryFunction : reaction?.probeBasis === "answer_claim" ? "VERIFY_CLAIM" : root?.metadata.primaryFunction;
  const purpose = functionForSurface ? purposeSignals[functionForSurface] : undefined;
  return {
    kind: draft.questionKind, expectedSlotExists: Boolean(slot), expectedFunction: slot?.primaryFunction ?? null, actualFunction: draft.primaryFunction,
    expectedDepth: slot?.depth ?? null, actualDepth: draft.depth,
    evidenceIdCount: draft.evidenceIds.length, evidenceQuoteCount: draft.evidenceQuotes.length,
    evidenceIdsAllowed: Boolean(slot && draft.evidenceIds.every(id => slot.evidenceIds.includes(id))),
    mainFunctionMatches: draft.questionKind !== "main" || draft.primaryFunction === slot?.primaryFunction,
    mainDepthMatches: draft.questionKind !== "main" || draft.depth === slot?.depth,
    targetCount: draft.targetEvidence.length, singleTargetMatches: draft.questionKind === "clarification" || draft.targetEvidence.length === 1,
    questionCharacters: [...draft.questionText].length, speechBudget: draft.questionKind === "end" ? null : questionSpeechLimits[draft.questionKind],
    spokenPurposeMatches: purpose ? purpose.test(draft.questionText) : null,
    metadataPurposeMatches: purpose ? purpose.test(`${draft.questionIntent} ${draft.targetEvidence.join(" ")}`) : null,
    reactionDirective: reaction?.directive ?? null,
  };
}

/** A reaction cannot be replaced by an unrelated main question or a new follow-up root. */
export function assertReactionQuestionDraft(draft: QuestionDraft, session: InterviewSession, reaction: AnswerReaction) {
  const previous = session.turns.at(-1);
  if (!previous || reaction.sourceTurnId !== previous.id || reaction.sourceAnswerId !== (previous.answerId ?? null) || reaction.parentMainQuestionId !== previous.parentMainQuestionId) throw new QuestionValidationError("FOLLOW_UP_RULE");
  if (reaction.directive === "next_main") {
    if (draft.questionKind === "follow_up" || draft.questionKind === "clarification" || draft.questionKind === "end" && Boolean(nextMainPlanSlot(session))) throw new QuestionValidationError("FOLLOW_UP_RULE");
    return;
  }
  if (reaction.directive === "clarification_same_target") {
    if (draft.questionKind !== "clarification" || draft.parentMainQuestionId !== previous.parentMainQuestionId || draft.primaryFunction !== previous.metadata.primaryFunction || draft.depth !== previous.metadata.depth || draft.questionIntent !== previous.metadata.questionIntent || JSON.stringify(draft.targetEvidence) !== JSON.stringify(previous.metadata.targetEvidence)) throw new QuestionValidationError("FOLLOW_UP_RULE");
    const purpose = purposeSignals[previous.metadata.primaryFunction];
    if (!hasSingleCoreFactReview(draft) && purpose && !purpose.test(draft.questionText)) throw new QuestionValidationError("PLAN_MISMATCH");
    return;
  }
  const claimProbe = reaction.probeBasis === "answer_claim";
  if (draft.questionKind !== "follow_up" || draft.parentMainQuestionId !== previous.parentMainQuestionId || draft.primaryFunction !== (claimProbe ? "VERIFY_CLAIM" : "CLARIFY_CONTENT") || draft.depth !== (claimProbe ? "D2" : previous.metadata.depth) || draft.targetEvidence.length !== 1 || draft.targetEvidence[0] !== reaction.missingTarget) throw new QuestionValidationError("FOLLOW_UP_RULE");
  const root = session.turns.find(turn => turn.id === previous.parentMainQuestionId) ?? previous;
  const purpose = purposeSignals[claimProbe ? "VERIFY_CLAIM" : root.metadata.primaryFunction];
  if (!hasSingleCoreFactReview(draft) && purpose && !purpose.test(draft.questionText)) throw new QuestionValidationError("PLAN_MISMATCH");
}

/** Server-owned slot bindings cannot be replaced by a model's self-reported plan metadata. */
export function attachVerifiedQuestionPlan(draft: QuestionDraft, session: InterviewSession, options: { independentReviewFollows?: boolean } = {}) {
  if (!session.plan || draft.questionKind === "end") return;
  const slot = draft.questionKind === "main" ? nextMainPlanSlot(session) : currentPlanSlot(session);
  if (!slot) throw new QuestionValidationError("PLAN_MISMATCH");
  if (draft.evidenceIds.some(id => !slot.evidenceIds.includes(id))) throw new QuestionValidationError("PLAN_MISMATCH");
  if (draft.questionKind === "main") {
    const common = slot.objective && 'grounding' in slot.objective ? slot.objective.grounding as QuestionDraft['commonApproval'] : undefined;
    const commonMatches = common?.kind === 'COMMON_APPROVED' && draft.commonApproval && JSON.stringify(common) === JSON.stringify(draft.commonApproval) && !draft.evidenceIds.length;
    if (!draft.evidenceIds.length && !commonMatches || draft.evidenceIds.some(id => !slot.evidenceIds.includes(id)) || draft.primaryFunction !== slot.primaryFunction || draft.depth !== slot.depth || draft.targetEvidence.length !== 1) throw new QuestionValidationError("PLAN_MISMATCH");
    if (session.plan.scheduling === 'time_based' && slot.objective && (draft.questionIntent !== slot.objective.questionIntent || JSON.stringify(draft.targetEvidence) !== JSON.stringify(slot.objective.targetEvidence))) throw new QuestionValidationError('PLAN_MISMATCH');
    // A surface check supplements the model's intent/utterance review; it is not a semantic-similarity score.
    const purpose = purposeSignals[slot.primaryFunction];
    const purposeHandledByAuthority = draft.premiseValidation?.method === 'bounded_semantic_review' && draft.premiseValidation.status === 'approved' || hasSingleCoreFactReview(draft);
    // The legacy semantic reviewer or the single core owns meaning. A keyword
    // pattern must not become a second semantic decision in the fact-only path.
    if (!options.independentReviewFollows && !purposeHandledByAuthority && purpose && (!purpose.test(draft.questionText) || !purpose.test(`${draft.questionIntent} ${draft.targetEvidence.join(" ")}`))) throw new QuestionValidationError("PLAN_MISMATCH");
    const alreadyCovered = session.turns.some(turn => turn.questionKind === "main" && (session.plan?.scheduling === 'time_based'
      ? Boolean(slot.semanticKey && turn.metadata.selectionTrace?.semanticKey === slot.semanticKey || slot.objective && turn.metadata.questionBlueprint?.clusterObjective.id === slot.objective.id)
      : turn.metadata.primaryFunction === slot.primaryFunction && (turn.metadata.activityIds ?? []).some(id => slot.activityIds.includes(id))));
    if (alreadyCovered) throw new QuestionValidationError("REPEATED_INTENT");
  }
  draft.planSlotId = slot.id;
  draft.topicArea = slot.topicArea;
  draft.interviewerRole = slot.interviewerRole;
  draft.schoolConnections = structuredClone(slot.schoolConnections);
}
