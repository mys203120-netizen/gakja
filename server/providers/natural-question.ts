import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { createHash } from 'node:crypto';
import { primaryFunctions, type InterviewSession, type QuestionDraft } from '../protocol';
import type { InterviewContext } from '../data/load-interview-context';
import { buildConversationLedger, ledgerTargetKey } from '../conversation-ledger';
import { buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview, stableQuestionPremiseReviewSchema, buildStablePremiseProofOptions, materializeStablePremiseReview, STABLE_PREMISE_PROOF_RULES, resolveVerifiedCommonPremiseAuthority, type QuestionPremiseReviewInput } from './question-premises';
import { canonicalizeQuestionCitations, findVerifiedSourceQuote, QuestionValidationError } from './question-grounding';
import { assertInterviewQuestionSpeech, findTranscriptSpan, verifyAcknowledgement } from './interview-speech';
import { assertQuestionPresentation, attachVerifiedQuestionPlan, questionSpeechLimits } from './question-plan';
import { createQuestionBlueprint, approveQuestionContract } from '../question-objective';
import type { AnswerReaction } from './answer-reaction';
import { QuestionGuardError } from './question-guards';
import { personalActionWitness } from './local-demand-witness';
import { normalizeProviderUsage, type ProviderUsageObservation } from '../observability/provider-cost';
import { runtimeReviewBaseRules, RUNTIME_REVIEW_POLICY_VERSION } from '../policy/runtime-review-policy';
import { interpretTranscriptTerms } from './transcript-interpretation';

export const NATURAL_QUESTION_VERSION = 'answer-grounded-question-v4';
/** Technical budgets, not a product SLA. Normal: one core and one independent review. Failure-only repair: at most one short rewrite plus one independent review; all attempts are logged. */
export const realtimeReviewBudget = Object.freeze({ coreTimeoutMs: 15000, reviewTimeoutMs: 12000, maxReviewCalls: 2, maxRewriteCalls: 1, maxInputCharacters: 22000 });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const text = (n: number) => z.string().max(n);
const interpretationSchema = z.object({
  meaning: text(220), dialogueRequests: z.array(z.enum(['repeat_audio', 'explain_question', 'skip', 'cannot_recall', 'correction', 'recognition_problem'])).max(6),
  covered: z.array(z.object({ targetId: text(100), answerQuote: z.string().min(1).max(240) }).strict()).max(8),
  unresolved: z.array(z.object({ targetId: text(100), missingMeaning: text(180) }).strict()).max(8),
  corrections: z.array(text(180)).max(4), uncertainty: z.array(text(120)).max(4),
}).strict();
export type DialogueInterpretation = z.infer<typeof interpretationSchema>;
const questionWire = (limit: number) => z.object({ text: z.string().min(8).max(limit), intent: z.string().min(5).max(180), target: z.string().min(3).max(180), primaryFunction: z.enum(primaryFunctions), depth: z.enum(['D1','D2','D3','D4']), answerQuote: z.string().min(2).max(240), strategyId: z.string().nullable(), matchedEstablishedTargetIds: z.array(text(100)).max(8) }).strict().nullable();
const decisionFields = {
    fulfillment: z.enum(['met', 'partial', 'unknown']),
    reason: z.enum(['missing_requested_detail', 'verify_actual_claim', 'two_statements_need_confirmation', 'requested_target_met', 'no_useful_probe', 'repeat_or_budget', 'unable_to_answer', 'repeat_request', 'meaning_request', 'off_topic', 'unclear', 'time_or_interview_complete']),
    necessity: text(180),
    reaction: z.object({ quote: z.string().min(2).max(28), text: text(76) }).strict().nullable(),
};
export const naturalCoreWireSchema = z.object({
  answerRelation: z.object({ kind: z.enum(['related', 'unrelated', 'unclear', 'non_answer']), note: z.string().min(2).max(100) }).strict(),
  interpretation: interpretationSchema,
  decision: z.discriminatedUnion('action', [
    z.object({ action: z.literal('FOLLOW_UP'), ...decisionFields, question: questionWire(questionSpeechLimits.follow_up) }).strict(),
    z.object({ action: z.literal('CLARIFICATION'), ...decisionFields, question: questionWire(questionSpeechLimits.clarification) }).strict(),
    z.object({ action: z.literal('TRANSITION'), ...decisionFields, question: questionWire(questionSpeechLimits.follow_up) }).strict(),
    z.object({ action: z.literal('CLOSING'), ...decisionFields, question: questionWire(questionSpeechLimits.follow_up) }).strict(),
  ]),
}).strict();
export type NaturalCoreOutput = z.infer<typeof naturalCoreWireSchema>;
export interface NaturalReviewOptions {
  onProviderUsage?: (observation: ProviderUsageObservation) => void;
  onReviewStarted?: () => void;
  requestReview?: (input: QuestionPremiseReviewInput) => Promise<unknown>;
  onReviewUsage?: (usage: { reviewInputTokens: number; reviewOutputTokens: number; reviewCachedInputTokens: number }) => void;
  /** Private diagnostics only: no source/answer text, prompt, provider response or credentials. */
  onReviewTrace?: (trace: NaturalReviewTrace) => void;
}
export interface NaturalReviewTrace {
  version: 'runtime-question-review-trace-v1';
  policyVersion?: typeof RUNTIME_REVIEW_POLICY_VERSION;
  questionSha256: string;
  stage?: 'surface_precheck' | 'independent_review' | 'canonical_contract' | 'approved';
  schemaValid: boolean;
  verdict: 'allowed' | 'rewrite' | 'uncertain' | null;
  accepted: boolean;
  rejectReason: string | null;
  failureCode: string | null;
  invalidReason: string | null;
  completeAssertionCoverage?: boolean;
  coreIntentCount?: number;
  intentMatches?: boolean;
  clarificationPreservesIntent?: boolean;
  runtimePurpose?: RuntimePurposeTrace | null;
  /** An answer disposition never approves or speaks the rejected candidate. */
  answerDisposition?: { kind: 'declined_current_demand'; accepted: boolean; rejectReason: string | null };
  declaredDemandIdentity?: boolean;
  canonicalQuestionKind?: 'clarification' | 'follow_up';
  turnLocalCoverage?: { turnId: string; fulfillment: 'met' | 'partial' | 'unknown'; source: 'independent_question_review' | 'spoken_local_demand_witness'; witness?: { start: number; end: number; quoteSha256: string } };
  premises: Array<{ questionSpan: string; basis: 'record' | 'answer_turn_attributed' | 'open_check' | 'hypothetical'; supported: boolean; proofId: string | null; sourceQuoteSha256: string | null }>;
}
const demandRelations = ['same_whole_demand_rephrase', 'missing_subpart', 'new_claim_probe', 'outside_current_demand'] as const;
const missingSubpartProofSchema = z.object({
  answeredDemandSpan: z.string().min(1).max(100),
  missingDemandSpan: z.string().min(1).max(100),
  scopeOperatorQuote: z.string().min(1).max(100),
  answeredAnswerQuote: z.string().min(1).max(240),
  answeredAnswerProofId: z.string().nullable(),
}).strict();
const unavailableDemandProofSchema = z.object({
  answerQuote: z.string().min(2).max(240),
  currentQuestionSpan: z.string().min(2).max(100),
  scopeRelation: z.enum(['same_requested_demand', 'different_or_unclear']),
  answerProofId: z.string().nullable(),
}).strict();
const followUpPurposeReviewSchema = z.object({
  subordinateToCluster: z.boolean(),
  hasAdditionalVerificationValue: z.boolean(),
  repeatedEstablishedTargetIds: z.array(z.string()).max(8),
  demandRelation: z.enum(demandRelations),
  currentDemandFulfillment: z.enum(['met', 'partial', 'unknown']),
  demandStructure: z.enum(['single_undivided_or_alternative', 'explicit_comparison', 'separate_parts_requested']),
  missingSubpartProof: missingSubpartProofSchema.nullable(),
  unavailableDemandProof: unavailableDemandProofSchema.nullable(),
}).strict();
const injectedPurposeReviewSchema = followUpPurposeReviewSchema.extend({
  missingSubpartProof: missingSubpartProofSchema.partial({ answeredAnswerProofId: true }).nullable(),
  unavailableDemandProof: unavailableDemandProofSchema.partial({ answerProofId: true }).nullable(),
}).partial({ demandRelation: true, currentDemandFulfillment: true, demandStructure: true, missingSubpartProof: true, unavailableDemandProof: true });
type InjectedRuntimePurpose = z.infer<typeof injectedPurposeReviewSchema>;
type RuntimePurposeTrace = Omit<InjectedRuntimePurpose, 'missingSubpartProof' | 'unavailableDemandProof'> & {
  missingSubpartProof?: Omit<NonNullable<InjectedRuntimePurpose['missingSubpartProof']>, 'answeredAnswerQuote'> & { answeredAnswerQuoteSha256: string } | null;
  unavailableDemandProof?: Omit<NonNullable<InjectedRuntimePurpose['unavailableDemandProof']>, 'answerQuote'> & { answerQuoteSha256: string; answerStartOffset: number | null; answerEndOffset: number | null } | null;
};
/** Normal semantic stops require an approved premise verdict. A separately
 * source-bound declined-answer disposition can stop without speaking a candidate. */
export class NaturalQuestionDecisionError extends QuestionGuardError {
  constructor(code: 'QUESTION_REPEATED_TARGET' | 'QUESTION_NO_USEFUL_PROBE' | 'QUESTION_DECLINED_CURRENT_DEMAND', public readonly semanticFulfillment?: 'met' | 'partial' | 'unknown') { super(code); }
}
const runtimePurposeReviewRules = `
runtimePurpose는 F/재진술 모두 현재 답변에 독립적으로 판정한다. question의 실제 요구가 clusterObjective에 종속되는지, 추가 확인 실익이 있는지, 충족한 의미를 다시 묻는지 확인한다. 이미 충족한 의미 반복은 실제 target.id를 repeatedEstablishedTargetIds에 기재한다. 생성기의 matchedEstablishedTargetIds는 정답으로 믿지 않는다.
currentDemandFulfillment는 오직 originalQuestion.questionText로 실제 들은 현재 요구의 충족이다. root/cluster의 다른 공백이나 내부 target을 현재 발화에 소급하지 않는다. '~하거나/중 한 가지/본인이 한 일'에서 하나의 실제 행동을 요구했다면 한 행동으로 충족할 수 있다. A/B 비교는 양쪽 설명이 실제 요구이며 A만 답했으면 부분 충족이다.
같은 묶음에서 앞선 A 설명과 현재 B 설명을 합쳐 의미상 대조가 확인되면 비교 요구를 충족할 수 있으며, 답변에 '차이는'이라는 단어가 없다는 이유만으로 비교를 다시 요구하지 않는다.
demandRelation은 실제 두 질문의 요구를 비교한다. 원래 요구 전체를 다시 묻는 same_whole_demand_rephrase는 답변이 막연해도 새 F가 아니다. 실제 비교에서 답한 부분을 빼고 미답 한 지점만 확인하면 missing_subpart다. 실제 새 주장·정정·진술 차이 검증은 new_claim_probe, 소재만 같고 종속되지 않으면 outside_current_demand다. clarificationPreservesIntent는 F로 제안했어도 원 질문의 동일 요구 재진술로 허용되는지 실제 문장으로 판정한다.
원 질문이 A/B 비교이고 A만 답한 뒤 B의 변화·A와의 차이를 묻는 후보는 빠진 B를 확인하는 missing_subpart다. 비교 기준으로 이미 설명한 A를 짧게 언급했다고 전체 요구 반복으로 판정하지 않는다. 답한 A까지 다시 처음부터 설명하라는 후보와 구분하고, 실제 원 질문의 A/B 구간·비교 지시·A 답변을 missingSubpartProof로 연결한다. 특정 변화 방향을 단정하지 않는 개념 변화·차이의 열린 요구는 예상 정답의 기록 증명이 필요한 사실 전제가 아니다.
demandStructure는 현재 실제 발화가 단일/선택 요구인지, 양쪽 비교인지, 각각의 부분을 별도로 요구했는지다. 여러 활동 이름만 언급한 것은 여러 필수 요구가 아니다. 두 활동에서 본인이 한 일을 물었는데 막연히 다같이 했다고 답한 경우, 개인이 한 일을 다시 묻는 것은 전체 요구 재진술이다.
missing_subpart는 missingSubpartProof에 현재 질문의 서로 다른 answeredDemandSpan/missingDemandSpan, 양쪽/각각을 실제 요구한 scopeOperatorQuote, 실제 답변의 answeredAnswerQuote를 연속 원문으로 제시해야 한다. 주제 이름 두 개만 뽑아 필수 부분을 만들지 않는다. 비교/각각/둘 다/모두 같은 실제 요구가 없고 전체 요구를 다시 물으면 same_whole_demand_rephrase다. 다른 관계에서는 proof=null이다.
답변 근거를 선택할 때 missingSubpartProof.answeredAnswerProofId 또는 unavailableDemandProof.answerProofId에 현재 answer source의 proofChoices ID를 우선 선택한다. 서버가 그 ID의 원문 구간을 복원하며, 과거 answerSources/record ID나 모델이 정규화한 표기는 원문 근거가 아니다. 해당 선택지가 없으면 ID=null과 실제 연속 원문 인용을 쓰며, 글자·발음·용어를 고치거나 떨어진 구간을 합성하지 않는다.
새 실익이 없으면 hasAdditionalVerificationValue=false다. currentDemandFulfillment=met이면 root의 공백을 되살리지 않는다. 구체적인 새 주장 검증은 충족 후에도 가능하나 숫자·남은 F만으로 묻지 않는다. 본인 행동이 분명하면 개인·팀 구분을 재확인하지 않고 기억 불가 범위를 다시 요구하지 않는다. CLARIFICATION도 runtimePurpose를 채운다. 이미 충족했으며 현재 뜻 확인/재청취 요청도 없다면 같은 요구 재진술은 필요하지 않다.
unavailableDemandProof는 후보 질문의 승인과 별개인 현재 답변 처분 근거다. 학생이 실제 현재 요구의 미답 범위를 기억하지 못하거나 모름/답변 불가라고 명시했고 더 물을 실익이 없을 때만, actual answer의 부정·주어·한정을 포함한 연속 answerQuote와 originalQuestion의 해당 연속 currentQuestionSpan을 연결한다. scopeRelation=same_requested_demand는 두 span이 의미상 같은 미답 요구일 때만 허용한다. 다른 과제/다른 부분의 기억 불가, 상대방 말의 인용, 부정·이중부정, 이후 철회·정정, 범위 불명확이면 different_or_unclear 또는 null이다. 단어 겹침이나 무관한 모름만으로 같은 요구로 판정하지 않는다. 일부 답변 후 나머지 근거/조건은 기억나지 않는다고 밝혔으면 답한 부분을 보존하고 그 불가 범위를 다시 요구하지 않는다. 이 경우 currentDemandFulfillment=partial/unknown, hasAdditionalVerificationValue=false다. 모름을 met·장난·무관·기술 장애로 바꾸지 않는다. 후보 전제가 틀렸으면 후보는 계속 rewrite/uncertain으로 거부한다. 유효한 불가 근거가 없으면 unavailableDemandProof=null이며 no-useful-probe만으로 검수 실패를 덮지 않는다.`;
const runtimeProofOffsetRules = `proofChoices의 sourceId는 sources 또는 answer/answerSources의 실제 id다. startOffset/endOffset은 그 source.text의 JavaScript UTF-16 연속 구간이며, 해당 부분이 기존 supportQuote 선택지다. 동일 원문을 중복하지 않기 위해 위치만 전송한다. 원문 전체의 주어·부정·한정 맥락도 읽고, 단어가 일치한다는 이유로 supported=true로 판정하지 않는다. 출력에는 동일 proofId를 사용하며, 서버가 실제 원문 선택지로 복원해 검증한다. 긴 설명이나 원문을 출력하지 말고 스키마의 판단 필드와 필요한 전제 구간만 반환한다.
supported는 예상 정답이 출처에 있다는 뜻이 아니라 해당 basis로 발화를 허용할 수 있는지다. record/answer는 정확한 proof가 필수다. open_check/hypothetical은 승인 범위의 열린 요구/명시 가정이며 숨은 사실 단정이 없으면 supported=true·proofId=null이다. 교과 개념의 변화·차이를 묻는 열린 절을 답이 기록에 없다는 이유로 record/unsupported로 바꾸지 않는다. 단정한 변화 방향·수치·수행 사실은 별도 구간으로 계속 증명한다. 이미 답한 부분은 반복하지 않고 미답 부분만 확인할 수 있다. false인 구간이 있으면 allowed를 반환하지 않는다.`;

/** Preserve each complete source once; proof choices point into that same immutable text. */
export function buildRuntimeReviewPayload(input: QuestionPremiseReviewInput) {
  const originals = new Map([...input.sources, ...(input.answer ? [input.answer] : []), ...(input.answerSources ?? [])].map(source => [source.id, source.text]));
  const proofChoices = buildStablePremiseProofOptions(input).map(choice => {
    const source = originals.get(choice.sourceId);
    const span = source === undefined ? null : findVerifiedSourceQuote(source, choice.supportQuote);
    if (!span) throw new Error('CORE_REVIEW_PROOF_INPUT_INVALID');
    return { proofId: choice.proofId, basis: choice.basis, sourceId: choice.sourceId, startOffset: span.sourceStartOffset, endOffset: span.sourceEndOffset };
  });
  // Only record sources can authorize a spelling. A generated question is not
  // vocabulary authority; readings never replace raw answer text or proof IDs.
  const vocabulary = ['CNT', 'MXene', 'STEM'].filter(term => input.sources.some(source => new RegExp(`\\b${term}\\b`, 'iu').test(source.text)));
  const pronunciationReadings = [...(input.answer ? [input.answer] : []), ...(input.answerSources ?? [])].flatMap(answer => {
    const { normalizedReading: _duplicateReading, ...reading } = interpretTranscriptTerms(answer.text, vocabulary);
    void _duplicateReading;
    return reading.readings.length ? [{ sourceId: answer.id, ...reading }] : [];
  });
  return { ...input, proofChoices, pronunciationReadings,
    pronunciationPolicy: 'Source-bound spelling hints only; all quotes/proofs remain exact raw answer spans. No inferred words, corrected numbers, or restored omissions.' };
}

export function validateInterpretation(value: DialogueInterpretation, session: InterviewSession): DialogueInterpretation {
  const ledger = buildConversationLedger(session), current = session.turns.at(-1)!;
  const targets = new Set(ledger.requestedTargets.map(t => t.id));
  const actual = ledger.answers.filter(a => a.sameCluster).map(a => a.rawTranscript);
  for (const point of value.covered) if (!targets.has(point.targetId) || !actual.some(raw => findTranscriptSpan(raw, point.answerQuote))) throw new Error('CORE_INTERPRETATION_SOURCE_INVALID');
  for (const point of value.unresolved) if (!targets.has(point.targetId)) throw new Error('CORE_INTERPRETATION_TARGET_INVALID');
  if (!current.answerId) throw new Error('CORE_INTERPRETATION_ANSWER_INVALID');
  return value;
}

export function naturalReaction(output: NaturalCoreOutput, session: InterviewSession, action: AnswerReaction['directive']): AnswerReaction {
  const current = session.turns.at(-1)!;
  const relation = output.answerRelation.kind, decision = output.decision;
  const history = session.turns.map(t => t.acknowledgement).filter((s): s is string => Boolean(s));
  const validated = decision.reaction ? verifyAcknowledgement(current.rawTranscript ?? '', decision.reaction.quote, decision.reaction.text, history) : null;
  const classification = relation === 'related' ? decision.fulfillment === 'partial' ? 'partial' : 'relevant' : relation === 'unrelated' ? 'off_topic' : relation === 'non_answer' ? 'non_answer' : 'unclear';
  const questionQuote = decision.question?.answerQuote;
  const span = questionQuote ? findTranscriptSpan(current.rawTranscript ?? '', questionQuote) : null;
  return { classification, action: action === 'next_main' ? 'proceed' : action === 'clarification_same_target' ? 'clarify' : 'probe', directive: action,
    reasonCode: classification === 'partial' ? 'MISSING_REQUESTED_DETAIL' : classification === 'relevant' ? 'ANSWER_RELATED' : classification === 'off_topic' ? 'NO_SEMANTIC_CONNECTION' : classification === 'non_answer' ? 'NO_ANSWER' : 'UNINTELLIGIBLE_CONTENT',
    keywordQuote: validated?.quote ?? (span && questionQuote!.length <= 28 ? span.surface : null), evidenceSpan: validated ? { start: validated.span.start, end: validated.span.end } : span && questionQuote!.length <= 28 ? { start: span.start, end: span.end } : null,
    reply: validated?.text ?? null, missingTarget: decision.question?.target ?? null, requestedTarget: current.metadata.targetEvidence[0] ?? null,
    sourceTurnId: current.id, sourceAnswerId: current.answerId ?? null, parentMainQuestionId: current.parentMainQuestionId, origin: 'model', durationMs: 0, probeBasis: decision.reason === 'verify_actual_claim' || decision.reason === 'two_statements_need_confirmation' ? 'answer_claim' : 'answer_detail',
  };
}

const normalizedDemand = (value: string) => value.normalize('NFC').replace(/\s+/gu, '');
function missingSubpartFailure(purpose: InjectedRuntimePurpose, input: QuestionPremiseReviewInput): string | null {
  const proof = purpose.missingSubpartProof, asked = input.originalQuestion?.questionText;
  if (!proof || !asked || !['explicit_comparison', 'separate_parts_requested'].includes(purpose.demandStructure ?? '')) return 'missing_subpart_without_separate_requested_parts';
  const answered = asked.indexOf(proof.answeredDemandSpan), missing = asked.indexOf(proof.missingDemandSpan);
  if (answered < 0 || missing < 0 || !asked.includes(proof.scopeOperatorQuote)) return 'missing_subpart_question_span_not_found';
  if (normalizedDemand(proof.answeredDemandSpan) === normalizedDemand(proof.missingDemandSpan)
    || Math.max(answered, missing) < Math.min(answered + proof.answeredDemandSpan.length, missing + proof.missingDemandSpan.length)) return 'missing_subpart_overlapping_parts';
  if (!input.answer || !findTranscriptSpan(input.answer.text, proof.answeredAnswerQuote)) return 'missing_subpart_answer_quote_not_found';
  // Topic names joined with "and" do not prove that each topic is a required
  // response. The proof must point to an actual spoken comparison/each/all act.
  const operator = normalizedDemand(proof.scopeOperatorQuote).replace(/[.!?。？]$/u, '');
  const comparison = /(?:비교해(?:서)?(?:설명해(?:주세요|주십시오|주시겠어요)?)?|비교하여(?:설명해(?:주세요|주십시오)?)?|비교하시오|비교하세요|대조해|대조하여|(?:차이|차이점|공통점)(?:(?:가|이)?있(?:나요|는지)|(?:은|는)?무엇(?:인가요|인지)|(?:을|를)?설명해(?:주세요|주십시오|주시겠어요))?|(?:어떻게)?다른(?:지|가요)(?:설명해(?:주세요|주십시오|주시겠어요))?|각각|둘다|모두|양쪽)$/u;
  const parts = /(?:각각|둘다|모두|양쪽|각부분|각항목|각경우|각대상)$/u;
  if (!(purpose.demandStructure === 'explicit_comparison' ? comparison : parts).test(operator)) return 'missing_subpart_no_explicit_spoken_scope';
  return null;
}

function materializePurposeAnswerProofs(purpose: InjectedRuntimePurpose | null, input: QuestionPremiseReviewInput, choices: ReturnType<typeof buildStablePremiseProofOptions>): InjectedRuntimePurpose | null {
  if (!purpose) return null;
  const rawQuote = (proofId: string): string => {
    const choice = choices.find(proof => proof.proofId === proofId);
    if (!choice || !input.answer || choice.sourceId !== input.answer.id || choice.basis !== 'answer_turn_attributed') throw new Error('CORE_REVIEW_ANSWER_PROOF_INVALID');
    const span = findVerifiedSourceQuote(input.answer.text, choice.supportQuote);
    if (!span) throw new Error('CORE_REVIEW_ANSWER_PROOF_INVALID');
    return input.answer.text.slice(span.sourceStartOffset, span.sourceEndOffset);
  };
  return { ...purpose,
    ...(purpose.missingSubpartProof ? { missingSubpartProof: { ...purpose.missingSubpartProof,
      answeredAnswerQuote: purpose.missingSubpartProof.answeredAnswerProofId ? rawQuote(purpose.missingSubpartProof.answeredAnswerProofId) : purpose.missingSubpartProof.answeredAnswerQuote } } : {}),
    ...(purpose.unavailableDemandProof ? { unavailableDemandProof: { ...purpose.unavailableDemandProof,
      answerQuote: purpose.unavailableDemandProof.answerProofId ? rawQuote(purpose.unavailableDemandProof.answerProofId) : purpose.unavailableDemandProof.answerQuote } } : {}),
  };
}

/** This is evidence of an explicit inability to answer, not a domain/knowledge
 * classifier. Semantic scope belongs to the independent reviewer; the server
 * binds its two immutable spans and rejects ambiguous linguistic polarity. */
function unavailableDemandFailure(purpose: InjectedRuntimePurpose, input: QuestionPremiseReviewInput): string | null {
  const proof = purpose.unavailableDemandProof;
  if (!proof || proof.scopeRelation !== 'same_requested_demand') return 'unavailable_scope_different_or_unclear';
  const asked = input.originalQuestion?.questionText, raw = input.answer?.text;
  if (!asked?.includes(proof.currentQuestionSpan)) return 'unavailable_question_span_not_found';
  if (/^[\s?？.!。]*(?:무엇|어떤|어떻게|왜|말씀|설명|주세요|인가요|했나요|하나요|하신가요|해주시겠어요|\s|[?？.!。])+$/u.test(proof.currentQuestionSpan)) return 'unavailable_question_scope_unspecified';
  const start = raw?.indexOf(proof.answerQuote) ?? -1;
  if (!raw || start < 0) return 'unavailable_answer_quote_not_found';
  if (purpose.hasAdditionalVerificationValue || !['partial', 'unknown'].includes(purpose.currentDemandFulfillment ?? '')) return 'unavailable_disposition_conflicts_with_purpose';
  const explicit = /(?:기억(?:이\s*)?(?:나지\s*않(?:습니다|아요)|안\s*(?:나요|납니다))|기억(?:을\s*)?하지\s*못(?:합니다|하겠습니다|해요)|모르(?:겠습니다|겠어요|겠네요)|모릅니다|(?:답변|대답|설명)(?:을)?\s*(?:(?:하지\s*)?못(?:합니다|하겠습니다|하겠어요|해요)|할\s*수\s*없(?:습니다|어요)))/u;
  if (!explicit.test(proof.answerQuote)) return 'unavailable_explicit_inability_missing';
  const before = raw.slice(0, start), after = raw.slice(start + proof.answerQuote.length);
  const boundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n'));
  const followingBoundary = after.search(/[.!?。\n]/u);
  const clause = before.slice(boundary + 1) + proof.answerQuote + (followingBoundary < 0 ? after : after.slice(0, followingBoundary));
  if (/["'“”‘’「」『』]/u.test(clause)
    || /(?:라|다|냐|자)고\s*(?:는|도|만|하|말|했|했었|들었|하셨)/u.test(clause)
    || /(?:친구|팀원|조원|선생님?|교사|상대방|그|그녀|그분|그사람|담당자)(?:은|는|이|가)/u.test(clause)) return 'unavailable_reported_or_other_speaker';
  if (/(?:라는|다는|란|단)\s*(?:뜻|말|의미|것|건).{0,24}(?:아니|아닙|없)|(?:않는|못하는|없는)\s*(?:것|건|다는).{0,12}(?:아니|아닙)|(?:모르겠습니다|모릅니다|기억나지\s*않습니다)\s*(?:는|가|이)\s*(?:아니|아닙)/u.test(clause)) return 'unavailable_negated_or_ambiguous';
  if (/(?:다른|별개(?:의)?|별도(?:의)?|무관한)\s*[^.!?。\n]{0,30}(?:모르|기억|답변|대답)/u.test(clause)) return 'unavailable_other_scope_explicit';
  if (/(?:아니요|정정(?:하|할)|기억(?:이\s*)?(?:났|납니다|나요)|이제\s*(?:기억|알))/u.test(after)) return 'unavailable_later_correction';
  return null;
}

export async function approveNaturalQuestion(context: InterviewContext, session: InterviewSession, output: NaturalCoreOutput, options: NaturalReviewOptions = {}) {
  const current = session.turns.at(-1)!, root = session.turns.find(t => t.id === current.parentMainQuestionId)!;
  const ledger = buildConversationLedger(session), proposal = output.decision.question;
  if (!proposal || !output.decision.necessity.trim()) throw new Error('CORE_QUESTION_MISSING');
  let clarification = output.decision.action === 'CLARIFICATION';
  const span = findTranscriptSpan(current.rawTranscript ?? '', proposal.answerQuote);
  if (!span) throw new Error('CORE_QUESTION_ANSWER_SOURCE_INVALID');
  const targetMeaning = clarification ? current.metadata.targetEvidence[0] : proposal.target;
  const declaredDemandIdentity = current.metadata.targetEvidence.length === 1
    && proposal.primaryFunction === current.metadata.primaryFunction
    && normalizedDemand(proposal.target) === normalizedDemand(current.metadata.targetEvidence[0]);
  const targetKey = 'PROBE-' + hash(root.id + ':' + targetMeaning.normalize('NFC').replace(/\s+/gu, '')).slice(0,24);
  if (!clarification && (ledger.establishedTargets.some(id => proposal.matchedEstablishedTargetIds.includes(id)) || session.turns.some(t => t.parentMainQuestionId === root.id && t.metadata.questionRealization?.semanticObjectiveId === targetKey))) throw new QuestionGuardError('QUESTION_REPEATED_TARGET');
  const sources = context.student.evidence.filter(s => root.evidenceIds.includes(s.id)).map(s => ({ id: s.id, text: s.text }));
  const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: proposal.text,
    questionKind: clarification ? 'clarification' : 'follow_up', parentMainQuestionId: root.id,
    evidenceIds: [...root.evidenceIds], evidenceQuotes: structuredClone(root.metadata.evidenceQuotes),
    ...(root.metadata.commonApproval ? { commonApproval: structuredClone(root.metadata.commonApproval) } : {}),
    primaryFunction: clarification ? current.metadata.primaryFunction : proposal.primaryFunction,
    depth: clarification ? current.metadata.depth : proposal.depth,
    questionIntent: clarification ? current.metadata.questionIntent : proposal.intent,
    targetEvidence: clarification ? [...current.metadata.targetEvidence] : [proposal.target],
    groundingRationale: output.decision.necessity, validationStatus: 'approved', validationFailures: [],
  };
  const model = process.env.OPENAI_QUESTION_MODEL || 'gpt-6-luna', started = performance.now();
  const reviewTrace: NaturalReviewTrace = { version: 'runtime-question-review-trace-v1', policyVersion: RUNTIME_REVIEW_POLICY_VERSION, questionSha256: hash(draft.questionText), stage: 'surface_precheck', schemaValid: false, verdict: null, accepted: false, rejectReason: null, failureCode: null, invalidReason: null, premises: [], declaredDemandIdentity };
  let providerCallMade = false, providerUsageObserved = false;
  try {
    // Match the generation grammar to the exact same server-owned speech budget.
    // A too-long/multi-task candidate never spends a paid semantic review call.
    assertInterviewQuestionSpeech(draft.questionText, { isFirstTurn: false });
    assertQuestionPresentation(draft);
    canonicalizeQuestionCitations(draft, sources);
    const established = ledger.requestedTargets.filter(t => ledger.establishedTargets.includes(t.id));
    // A quote can cover only part of a target. Do not present that whole target
    // as established while the SAME interpretation still marks it unresolved.
    const unresolvedNow = new Set(output.interpretation.unresolved.map(point => point.targetId));
    const currentMeaningCovered = output.decision.fulfillment === 'met'
      ? output.interpretation.covered.filter(point => !unresolvedNow.has(point.targetId)).map(point => ledger.requestedTargets.find(t => t.id === point.targetId)).filter((t): t is NonNullable<typeof t> => Boolean(t))
      : [];
    const alreadyEstablished = [...new Map([...established, ...currentMeaningCovered].map(t => [t.id, { id: t.id, intent: t.intent, requested: t.expectedEvidence }])).values()];
    const currentAnswer = { turnId: current.id, answerId: current.answerId!, parentMainQuestionId: root.id, transcriptStatus: 'finalized' as const, text: current.rawTranscript! };
    const answerSources = session.turns.filter(turn => turn.id !== current.id && turn.parentMainQuestionId === root.id && turn.transcriptStatus === 'finalized' && turn.answerId && turn.rawTranscript?.trim()).map(turn => ({ turnId: turn.id, answerId: turn.answerId!, parentMainQuestionId: root.id, transcriptStatus: 'finalized' as const, text: turn.rawTranscript! }));
    const originalQuestion = { questionText: current.questionText, questionIntent: current.metadata.questionIntent, targetEvidence: current.metadata.targetEvidence, primaryFunction: current.metadata.primaryFunction, depth: current.metadata.depth };
    const commonAuthority = resolveVerifiedCommonPremiseAuthority(context, draft);
    const input = buildQuestionPremiseReviewInput(draft, sources, currentAnswer, originalQuestion, answerSources, commonAuthority);
    const proofChoices = buildStablePremiseProofOptions(input);
    const reviewSchema = stableQuestionPremiseReviewSchema.extend({ runtimePurpose: followUpPurposeReviewSchema });
    const injectedSchema = stableQuestionPremiseReviewSchema.extend({ runtimePurpose: injectedPurposeReviewSchema.nullable() });
    reviewTrace.stage = 'independent_review';
    try { options.onReviewStarted?.(); } catch { /* Diagnostics cannot suppress a review. */ }
    providerCallMade = !options.requestReview;
    const response = options.requestReview ? null : await new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: realtimeReviewBudget.reviewTimeoutMs, maxRetries: 0 }).responses.parse({ model, store: false, reasoning: { effort: 'none' }, service_tier: 'default', prompt_cache_options: { ttl: '30m' }, instructions: runtimeReviewBaseRules + STABLE_PREMISE_PROOF_RULES + runtimePurposeReviewRules + runtimeProofOffsetRules,
      input: JSON.stringify({ ...buildRuntimeReviewPayload(input), clusterObjective: root.metadata.questionIntent, alreadyEstablished, proposedVerificationNeed: output.decision.necessity }),
      text: { format: zodTextFormat(reviewSchema, 'runtime_final_question_review') }, max_output_tokens: 900 });
    if (response) { providerUsageObserved = true; try { options.onProviderUsage?.(normalizeProviderUsage(response, { requestedModel: model, requestedServiceTier: 'default', requestedCacheTtl: '30m' })); } catch { /* Observability cannot approve or reject a question. */ } }
    if (response?.usage) options.onReviewUsage?.({ reviewInputTokens: response.usage.input_tokens, reviewOutputTokens: response.usage.output_tokens, reviewCachedInputTokens: response.usage.input_tokens_details.cached_tokens });
    // Only explicit injected test adapters may use the older purpose shape.
    const reviewed = options.requestReview ? injectedSchema.parse(await options.requestReview(input)) : reviewSchema.parse(response?.output_parsed);
    Object.assign(reviewTrace, { schemaValid: true, verdict: reviewed.verdict,
      completeAssertionCoverage: reviewed.completeAssertionCoverage, coreIntentCount: reviewed.coreIntentCount,
      intentMatches: reviewed.intentMatches, clarificationPreservesIntent: reviewed.clarificationPreservesIntent });
    const purpose = materializePurposeAnswerProofs(reviewed.runtimePurpose, input, proofChoices);
    if (purpose?.demandRelation && purpose.currentDemandFulfillment) {
      const { missingSubpartProof, unavailableDemandProof, ...purposeTrace } = purpose;
      const unavailableStart = unavailableDemandProof ? input.answer?.text.indexOf(unavailableDemandProof.answerQuote) ?? -1 : -1;
      reviewTrace.runtimePurpose = { ...purposeTrace, ...(missingSubpartProof ? {
        missingSubpartProof: { answeredDemandSpan: missingSubpartProof.answeredDemandSpan, missingDemandSpan: missingSubpartProof.missingDemandSpan,
          scopeOperatorQuote: missingSubpartProof.scopeOperatorQuote, answeredAnswerProofId: missingSubpartProof.answeredAnswerProofId,
          answeredAnswerQuoteSha256: hash(missingSubpartProof.answeredAnswerQuote) },
      } : { missingSubpartProof: null }), unavailableDemandProof: unavailableDemandProof ? {
        currentQuestionSpan: unavailableDemandProof.currentQuestionSpan, scopeRelation: unavailableDemandProof.scopeRelation, answerProofId: unavailableDemandProof.answerProofId,
        answerQuoteSha256: hash(unavailableDemandProof.answerQuote), answerStartOffset: unavailableStart < 0 ? null : unavailableStart,
        answerEndOffset: unavailableStart < 0 ? null : unavailableStart + unavailableDemandProof.answerQuote.length,
      } : null };
      reviewTrace.turnLocalCoverage = { turnId: current.id, fulfillment: purpose.currentDemandFulfillment, source: 'independent_question_review' };
    } else reviewTrace.runtimePurpose = null;
    reviewTrace.premises = reviewed.premises.map(premise => {
      const choice = proofChoices.find(choice => choice.proofId === premise.proofId);
      return { ...premise, sourceQuoteSha256: choice ? hash(choice.supportQuote) : null };
    });
    reviewTrace.rejectReason = reviewed.verdict === 'uncertain' ? 'reviewer_uncertain' : !reviewed.completeAssertionCoverage ? 'incomplete_assertion_coverage' : reviewed.verdict !== 'allowed' ? 'reviewer_rewrite' : reviewed.coreIntentCount !== 1 ? 'multiple_or_missing_core_intent' : !reviewed.intentMatches ? 'intent_mismatch' : clarification && !reviewed.clarificationPreservesIntent ? 'clarification_demand_changed' : reviewed.premises.some(premise => !input.question.questionText.includes(premise.questionSpan)) ? 'question_span_not_found' : reviewed.premises.some(premise => !premise.supported) ? 'unsupported_question_span' : null;
    if (purpose?.unavailableDemandProof) {
      const failure = unavailableDemandFailure(purpose, input);
      reviewTrace.answerDisposition = { kind: 'declined_current_demand', accepted: !failure, rejectReason: failure };
      if (!failure) {
        // No candidate leaves this path: its unsupported proof is never upgraded.
        // This separate, independently source-bound disposition preserves the
        // partial/unknown answer and respects an explicit unavailable scope.
        reviewTrace.rejectReason = 'current_requested_demand_explicitly_unavailable';
        throw new NaturalQuestionDecisionError('QUESTION_DECLINED_CURRENT_DEMAND', purpose.currentDemandFulfillment);
      }
    }
    const { runtimePurpose: _purpose, ...premiseVerdict } = reviewed;
    const materialized = materializeStablePremiseReview(premiseVerdict, input);
    // With no valid declined-answer disposition, proof failure always wins
    // over a no-useful-probe/fulfilled semantic transition judgment.
    draft.premiseValidation = finalizeQuestionPremiseReview(materialized, input, model);
    const explicitCurrentRequest = output.interpretation.dialogueRequests.some(request => request === 'explain_question' || request === 'repeat_audio');
    const actionWitness = personalActionWitness(current);
    if (actionWitness && output.answerRelation.kind === 'related' && purpose?.subordinateToCluster && purpose.demandStructure === 'single_undivided_or_alternative'
      && purpose.demandRelation !== 'new_claim_probe' && !explicitCurrentRequest) {
      reviewTrace.turnLocalCoverage = { turnId: current.id, fulfillment: 'met', source: 'spoken_local_demand_witness', witness: { start: actionWitness.start, end: actionWitness.end, quoteSha256: hash(actionWitness.quote) } };
      reviewTrace.rejectReason = 'single_personal_action_already_supplied';
      throw new NaturalQuestionDecisionError('QUESTION_NO_USEFUL_PROBE', 'met');
    }

    if (clarification && purpose) {
      if (purpose.currentDemandFulfillment === 'met' && !explicitCurrentRequest) {
        reviewTrace.rejectReason = 'fulfilled_rephrase_without_current_request';
        throw new NaturalQuestionDecisionError('QUESTION_NO_USEFUL_PROBE', 'met');
      }
      if (purpose.demandRelation && purpose.demandRelation !== 'same_whole_demand_rephrase') {
        reviewTrace.rejectReason = 'clarification_demand_relation_conflict';
        throw new Error('CORE_DEMAND_RELATION_CONFLICT');
      }
    }
    if (!clarification) {
      if (!purpose) { reviewTrace.rejectReason = 'runtime_purpose_missing'; throw new Error('CORE_REVIEW_PURPOSE_MISSING'); }
      if (purpose.repeatedEstablishedTargetIds.some(id => !alreadyEstablished.some(t => t.id === id))) { reviewTrace.rejectReason = 'unknown_established_target'; throw new Error('CORE_REVIEW_TARGET_INVALID'); }
      if (purpose.repeatedEstablishedTargetIds.length) { reviewTrace.rejectReason = 'repeated_established_target'; throw new NaturalQuestionDecisionError('QUESTION_REPEATED_TARGET', purpose.currentDemandFulfillment); }
      if (purpose.currentDemandFulfillment === 'met' && purpose.demandRelation !== 'new_claim_probe') {
        reviewTrace.rejectReason = 'current_spoken_demand_already_met';
        throw new NaturalQuestionDecisionError('QUESTION_NO_USEFUL_PROBE', 'met');
      }
      if (declaredDemandIdentity && purpose.demandRelation && purpose.demandRelation !== 'same_whole_demand_rephrase') {
        reviewTrace.rejectReason = 'declared_same_demand_relation_conflict';
        throw new Error('CORE_DEMAND_RELATION_CONFLICT');
      }
      const legacyInjectedPurpose = Boolean(options.requestReview) && purpose.demandStructure === undefined && purpose.missingSubpartProof === undefined;
      if (purpose.demandRelation === 'missing_subpart' && !legacyInjectedPurpose) {
        const failure = missingSubpartFailure(purpose, input);
        if (failure) { reviewTrace.rejectReason = failure; throw new Error('CORE_DEMAND_RELATION_CONFLICT'); }
      }
      if (purpose.demandRelation === 'same_whole_demand_rephrase') {
        if (!reviewed.clarificationPreservesIntent) { reviewTrace.rejectReason = 'clarification_demand_changed'; throw new QuestionValidationError('MULTIPLE_QUESTIONS'); }
        clarification = true;
        Object.assign(draft, { questionKind: 'clarification', primaryFunction: current.metadata.primaryFunction,
          depth: current.metadata.depth, questionIntent: current.metadata.questionIntent, targetEvidence: [...current.metadata.targetEvidence] });
        // Canonical metadata and the proof verdict must approve the SAME final text.
        const canonicalInput = buildQuestionPremiseReviewInput(draft, sources, currentAnswer, originalQuestion, answerSources, commonAuthority);
        draft.premiseValidation = finalizeQuestionPremiseReview(materialized, canonicalInput, model);
      } else if (purpose.demandRelation === 'outside_current_demand' || !purpose.subordinateToCluster || !purpose.hasAdditionalVerificationValue) {
        reviewTrace.rejectReason = !purpose.subordinateToCluster || purpose.demandRelation === 'outside_current_demand' ? 'outside_cluster_objective' : 'no_additional_verification_value';
        throw new NaturalQuestionDecisionError('QUESTION_NO_USEFUL_PROBE', purpose.currentDemandFulfillment);
      }
    }
    void _purpose;
    reviewTrace.stage = 'canonical_contract';
    reviewTrace.canonicalQuestionKind = clarification ? 'clarification' : 'follow_up';
    assertQuestionPresentation(draft);
    attachVerifiedQuestionPlan(draft, session);
    const strategyId = proposal.strategyId;
    if (strategyId && !context.questionStrategies?.cards.some(c => c.id === strategyId)) throw new Error('CORE_STRATEGY_SOURCE_INVALID');
    const sourceId = 'ANSWER_TURN:' + current.id + ':' + current.answerId;
    draft.questionRealization = { policyVersion: NATURAL_QUESTION_VERSION, operation: draft.primaryFunction.toLowerCase(), anchorMode: 'none', anchorId: targetKey,
      templateId: NATURAL_QUESTION_VERSION + '.generated', family: 'answer_grounded', strategyId, semanticReview: 'independently_reviewed', semanticObjectiveId: clarification ? ledgerTargetKey(current) : targetKey,
      anchorProof: [{ anchorId: targetKey, sourceId, sourceSha256: hash(current.rawTranscript!), sourceStartOffset: span.start, sourceEndOffset: span.end, questionStartOffset: null, questionEndOffset: null }],
    };
    draft.providerTimings = { premiseReviewMs: performance.now() - started, premiseReviewAttempts: 1, runtimeReviewWire: 3, reviewReasoningNone: 1, coreNaturalQuestion: 1 };
    const blueprint = createQuestionBlueprint(draft, context, session, { targetDescription: draft.targetEvidence[0], subordinationRationale: output.decision.necessity, strategyIds: strategyId ? [strategyId] : [], answerRefs: clarification ? [] : [{ turnId: current.id, answerId: current.answerId!, start: span.start, end: span.end }], ...(root.metadata.commonApproval ? { grounding: root.metadata.commonApproval } : {}) });
    draft.questionBlueprint = blueprint;
    draft.approvedQuestion = approveQuestionContract(draft, blueprint, { policyDigest: context.interviewerPolicy?.contentSha256, strategyCatalogDigest: context.questionStrategies?.contentSha256 });
    reviewTrace.accepted = true; reviewTrace.rejectReason = null; reviewTrace.stage = 'approved';
    return draft;
  } catch (error) {
    if (providerCallMade && !providerUsageObserved) { try { options.onProviderUsage?.(normalizeProviderUsage(null, { requestedModel: model, requestedServiceTier: 'default', requestedCacheTtl: '30m' })); } catch { /* A failed request has unknown cost. */ } }
    reviewTrace.failureCode = error instanceof QuestionValidationError || error instanceof QuestionGuardError ? error.code : error instanceof z.ZodError ? 'REVIEW_SCHEMA_INVALID' : 'REVIEW_EXECUTION_FAILED';
    reviewTrace.invalidReason = error instanceof Error && 'invalidReason' in error && typeof error.invalidReason === 'string' ? error.invalidReason : null;
    reviewTrace.rejectReason ??= reviewTrace.stage === 'surface_precheck' ? 'surface_contract_failed' : reviewTrace.stage === 'canonical_contract' ? 'canonical_contract_failed' : reviewTrace.invalidReason ?? (reviewTrace.schemaValid ? 'source_proof_or_numeric_check' : 'schema_or_provider_failure');
    throw error;
  } finally {
    try { options.onReviewTrace?.(reviewTrace); } catch { /* Diagnostics never alter progression. */ }
  }
}
