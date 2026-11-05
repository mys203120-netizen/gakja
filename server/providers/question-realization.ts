import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { QuestionDraft } from '../protocol';
import { hasObservedComparison, hasObservedMeasurement, type FollowUpGoal } from './follow-up-language';
import { findTranscriptSpan, assertInterviewQuestionSpeech } from './interview-speech';
import { isIncompleteAnswerFragment } from './answer-context';
import { selectNonRepeatingTemplate, type UtteranceHistoryItem } from './utterance-variation';

/** Code-reviewed speech acts. Book strategy extraction cannot add arbitrary spoken text. */
export const QUESTION_REALIZATION_VERSION = 'source-bound-question-ir-v1';
export const questionOperations = ['factual_recall', 'motivation', 'choice_basis', 'process', 'own_action', 'numeric_verification', 'evidence_verification', 'contradiction', 'star_situation', 'star_task', 'star_action', 'star_result', 'comparison', 'limit', 'alternative', 'transfer', 'connection', 'value_judgement', 'concept_clarification', 'answer_anchor'] as const;
export type QuestionOperation = typeof questionOperations[number];
export const questionAnchorModes = ['none', 'short_context', 'exact_quote'] as const;
export type QuestionAnchorMode = typeof questionAnchorModes[number];
export interface QuestionAnchor {
  readonly id: string;
  readonly sourceId: string;
  readonly turnId: string;
  readonly answerId: string;
  readonly sourceSha256: string;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}
const bindings = new WeakMap<QuestionAnchor, string>();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export class QuestionIRValidationError extends Error {
  constructor(public readonly code: 'IR_NO_ANCHOR' | 'IR_INVALID' | 'IR_SOURCE_INVALID' | 'IR_OPERATION_UNSUPPORTED' | 'IR_UNSUPPORTED_OBSERVATION' | 'IR_CONTRADICTION_PAIR_REQUIRED' | 'IR_SURFACE_INVALID') { super(code); this.name = 'QuestionIRValidationError'; }
}

/** Quotes and UTF-16 offsets are selected and bound by the server, never supplied by the model. */
export function buildQuestionAnchorCandidates(input: { turnId: string; answerId: string; rawTranscript: string; quoteOptions?: readonly string[] }): QuestionAnchor[] {
  if (!input.turnId || !input.answerId) return [];
  const sourceId = `ANSWER_TURN:${input.turnId}:${input.answerId}`, sourceSha256 = sha(input.rawTranscript);
  const proposed = input.quoteOptions ?? input.rawTranscript.split(/[.!?。\n]/u).map(part => part.trim()).filter(part => part.length <= 28);
  const seen = new Set<string>(), anchors: QuestionAnchor[] = [];
  for (const quote of proposed) {
    if (anchors.length >= 48) break;
    if (quote.length < 2 || quote.length > 28 || /[\r\n“”‘’"'?？;:]/u.test(quote) || isIncompleteAnswerFragment(quote)) continue;
    const span = findTranscriptSpan(input.rawTranscript, quote);
    if (!span || seen.has(`${span.start}:${span.end}`)) continue;
    const anchor: QuestionAnchor = Object.freeze({ id: `QA-${sha(`${sourceId}:${sourceSha256}:${span.start}:${span.end}`).slice(0, 20)}`, sourceId, turnId: input.turnId, answerId: input.answerId, sourceSha256, start: span.start, end: span.end, quote: span.surface });
    bindings.set(anchor, input.rawTranscript); seen.add(`${span.start}:${span.end}`); anchors.push(anchor);
  }
  return anchors;
}

/** Only this projection belongs in a model request; no hidden source text is serialized. */
export function questionAnchorProjection(anchors: readonly QuestionAnchor[]) {
  return anchors.map(({ id, sourceId, quote }) => ({ id, sourceId, quote }));
}
export function assertQuestionAnchorBinding(anchor: QuestionAnchor) {
  const raw = bindings.get(anchor);
  if (raw === undefined || sha(raw) !== anchor.sourceSha256 || raw.slice(anchor.start, anchor.end) !== anchor.quote || anchor.sourceId !== `ANSWER_TURN:${anchor.turnId}:${anchor.answerId}` || anchor.id !== `QA-${sha(`${anchor.sourceId}:${anchor.sourceSha256}:${anchor.start}:${anchor.end}`).slice(0, 20)}`) throw new QuestionIRValidationError('IR_SOURCE_INVALID');
  return raw;
}

type Profile = { primaryFunction: QuestionDraft['primaryFunction']; depth: QuestionDraft['depth']; goal: FollowUpGoal; target: string; requests: readonly string[]; context: string };
const profiles: Record<QuestionOperation, Profile> = {
  factual_recall: { primaryFunction: 'FACT', depth: 'D1', goal: 'meaning', target: '실제로 설명할 수 있는 핵심 내용 한 가지', context: '말씀하신 내용에 관해, ', requests: ['핵심 내용을 한 가지만 설명해 주세요.', '어떤 내용인지 한 가지만 말씀해 주세요.', '어떤 내용인지 한 가지를 들어 설명해 주세요.'] },
  motivation: { primaryFunction: 'MOTIVE', depth: 'D2', goal: 'motive', target: '관심을 갖게 된 계기', context: '그 관심에 관해, ', requests: ['관심을 갖게 된 계기가 있었다면 무엇인가요?', '어떤 계기로 관심을 갖게 됐나요?', '관심을 갖게 된 이유를 한 가지만 말씀해 주세요.'] },
  choice_basis: { primaryFunction: 'CHOICE', depth: 'D2', goal: 'choice', target: '선택에서 우선한 판단 기준 한 가지', context: '그 선택에 관해, ', requests: ['그 선택에서 가장 중요하게 본 기준은 무엇인가요?', '선택할 때 어떤 기준을 우선했나요?', '그 선택의 기준을 한 가지만 말씀해 주세요.'] },
  process: { primaryFunction: 'PROCESS', depth: 'D2', goal: 'process', target: '직접 진행한 구체적인 과정 한 단계', context: '그 과정에 관해, ', requests: ['직접 진행한 과정이 있다면 한 단계만 설명해 주세요.', '실제로 어떻게 진행했는지 한 단계만 말씀해 주세요.', '그 과정에서 먼저 한 일은 무엇이었나요?'] },
  own_action: { primaryFunction: 'ROLE', depth: 'D2', goal: 'own_action', target: '본인이 실제로 한 행동 한 가지', context: '그 활동에 관해, ', requests: ['본인이 직접 한 일이 있다면 무엇인가요?', '본인이 실제로 한 일을 한 가지만 말씀해 주세요.', '그중 본인이 직접 한 부분은 무엇인가요?'] },
  numeric_verification: { primaryFunction: 'EVIDENCE', depth: 'D2', goal: 'measurement', target: '실제로 말한 수치를 확인한 기준', context: '그 수치에 관해, ', requests: ['그 값은 어떻게 확인했나요?', '그 수치를 확인한 기준은 무엇인가요?', '그 값을 확인할 때 무엇을 기준으로 삼았나요?'] },
  evidence_verification: { primaryFunction: 'EVIDENCE', depth: 'D2', goal: 'basis', target: '현재 판단을 뒷받침하는 근거 한 가지', context: '그 판단에 관해, ', requests: ['무엇을 보고 그렇게 판단했나요?', '그 판단을 뒷받침하는 근거는 무엇인가요?', '그렇게 볼 수 있는 이유를 한 가지만 말씀해 주세요.'] },
  contradiction: { primaryFunction: 'VERIFY_CLAIM', depth: 'D2', goal: 'basis', target: '출처가 연결된 두 진술 사이의 정정 여부', context: '', requests: ['앞선 설명과 이번 설명 중 정정할 부분이 있나요?', '앞서 말씀과 함께 보면, 어떤 설명으로 이해하면 될까요?', '두 설명을 함께 볼 때 보완할 부분이 있나요?'] },
  star_situation: { primaryFunction: 'FACT', depth: 'D1', goal: 'meaning', target: '행동이 이루어진 당시 상황 한 가지', context: '말씀하신 경험에서, ', requests: ['당시는 어떤 상황이었나요?', '당시 상황을 한 가지만 구체적으로 말씀해 주세요.', '그 일이 어떤 상황에서 있었는지 설명해 주세요.'] },
  star_task: { primaryFunction: 'ROLE', depth: 'D1', goal: 'own_action', target: '당시 본인에게 과제가 있었다면 그 내용 한 가지', context: '말씀하신 경험에서, ', requests: ['본인에게 주어진 과제가 있었다면 무엇인가요?', '본인이 해야 했던 일이 있다면 무엇인가요?', '본인의 과제가 있었다면 한 가지만 말씀해 주세요.'] },
  star_action: { primaryFunction: 'ROLE', depth: 'D2', goal: 'own_action', target: '상황에 대응해 본인이 실제로 한 행동 한 가지', context: '그 상황에서, ', requests: ['본인이 직접 취한 행동이 있다면 무엇인가요?', '실제로 어떻게 행동했는지 한 가지만 말씀해 주세요.', '본인이 직접 한 행동을 하나 말씀해 주세요.'] },
  star_result: { primaryFunction: 'RESULT', depth: 'D1', goal: 'result', target: '직접 확인한 결과 한 가지', context: '말씀하신 과정 이후에, ', requests: ['확인한 결과가 있다면 한 가지만 말씀해 주세요.', '실제로 확인할 수 있었던 것은 무엇인가요?', '관찰한 내용이 있다면 한 가지만 설명해 주세요.'] },
  comparison: { primaryFunction: 'TRANSFER', depth: 'D3', goal: 'comparison', target: '실제로 언급한 비교에서 확인한 차이', context: '그 비교에 관해, ', requests: ['무엇이 다르다고 보셨나요?', '비교했을 때 어떤 차이가 있었나요?', '그 비교에서 확인한 차이를 한 가지만 말씀해 주세요.'] },
  limit: { primaryFunction: 'LIMIT', depth: 'D4', goal: 'limit', target: '현재 설명이나 판단을 적용할 수 있는 범위', context: '그 설명에 관해, ', requests: ['이 설명만으로 판단하기 어려운 부분이 있다면 어디인가요?', '이 설명을 적용하기 어려운 경우가 있다면 무엇일까요?', '그 판단을 어디까지 적용할 수 있다고 보나요?'] },
  alternative: { primaryFunction: 'ALTERNATIVE', depth: 'D4', goal: 'alternative', target: '다시 한다면 제안할 구체적 변화 한 가지', context: '말씀하신 내용을 바탕으로, ', requests: ['다시 한다면 무엇을 하나 바꾸겠어요?', '한 가지만 달리해 본다면 무엇을 바꾸겠어요?', '다른 방법을 제안한다면 무엇인가요?'] },
  transfer: { primaryFunction: 'TRANSFER', depth: 'D3', goal: 'connection', target: '설명한 내용을 다른 상황에 적용할 때 고려할 조건', context: '지금 설명을 바탕으로, ', requests: ['다른 상황에 적용할 때 무엇을 먼저 살펴야 할까요?', '이 내용을 다른 사례에 적용한다면 어떤 조건을 봐야 할까요?', '적용하는 상황이 달라지면 무엇을 먼저 고려해야 할까요?'] },
  connection: { primaryFunction: 'CONNECTION', depth: 'D3', goal: 'connection', target: '실제로 언급한 내용이 다른 경험과 연결되는 지점이 있는지', context: '그 내용에 관해, ', requests: ['다른 경험과 연결되는 점이 있다면 무엇인가요?', '다른 경험으로 이어지는 부분이 있다면 말씀해 주세요.', '다른 경험과 이어진 부분이 있다면 어떤 점인가요?'] },
  value_judgement: { primaryFunction: 'VALUE', depth: 'D2', goal: 'choice', target: '현재 상황에서 우선할 가치나 판단 기준 한 가지', context: '그 상황에 관해, ', requests: ['무엇을 가장 우선해야 한다고 보나요?', '가장 중요하게 볼 기준을 하나 꼽는다면 무엇인가요?', '그 상황에서 지키고 싶은 원칙은 무엇인가요?'] },
  concept_clarification: { primaryFunction: 'CONCEPT', depth: 'D1', goal: 'meaning', target: '실제로 언급한 개념이나 표현의 의미', context: '그 표현에 관해, ', requests: ['어떤 의미로 이해하고 있나요?', '그 개념을 본인의 말로 설명해 주세요.', '그 말이 무엇을 뜻하는지 설명해 주세요.'] },
  answer_anchor: { primaryFunction: 'CLARIFY_CONTENT', depth: 'D2', goal: 'meaning', target: '현재 답변의 표현이 가리키는 구체적인 내용', context: '그 부분에 관해, ', requests: ['구체적으로 어떤 뜻인가요?', '그 부분을 한 가지 예로 설명해 주세요.', '어떤 내용을 말하는지 조금 더 구체적으로 말씀해 주세요.'] },
};
export function questionOperationProfile(operation: QuestionOperation) {
  const profile = profiles[operation];
  return { primaryFunction: profile.primaryFunction, depth: profile.depth, goal: profile.goal, target: profile.target };
}

export interface QuestionIR { operation: QuestionOperation; anchorId: string; anchorMode: QuestionAnchorMode; secondaryAnchorId: string | null }
export interface QuestionIROptions { allowedOperations?: readonly QuestionOperation[]; contradictionPairs?: readonly (readonly [string, string])[]; primaryTurnId?: string }

function eligibleAnchors(operation: QuestionOperation, anchors: readonly QuestionAnchor[], primaryTurnId?: string) {
  return anchors.filter(anchor => {
    const raw = assertQuestionAnchorBinding(anchor);
    if (primaryTurnId && anchor.turnId !== primaryTurnId) return false;
    return operation === 'numeric_verification' ? hasObservedMeasurement(raw, anchor.quote) : operation === 'comparison' ? hasObservedComparison(raw, anchor.quote) : true;
  });
}
function contradictionPairs(anchors: readonly QuestionAnchor[], pairs: QuestionIROptions['contradictionPairs'], primaryTurnId?: string) {
  const ids = new Set(anchors.map(anchor => anchor.id));
  return (pairs ?? []).filter(([first, second]) => first !== second && ids.has(first) && ids.has(second) && (!primaryTurnId || anchors.some(anchor => anchor.id === first && anchor.turnId === primaryTurnId)));
}
export function availableQuestionOperations(anchors: readonly QuestionAnchor[], options: QuestionIROptions = {}): QuestionOperation[] {
  const allowed = new Set(options.allowedOperations ?? questionOperations);
  return questionOperations.filter(operation => allowed.has(operation) && eligibleAnchors(operation, anchors, options.primaryTurnId).length > 0 && (operation !== 'contradiction' || contradictionPairs(anchors, options.contradictionPairs, options.primaryTurnId).length > 0));
}

/** A correlated union prevents an operation from borrowing a quote of an unrelated observation. */
export function questionIRWireSchema(anchors: readonly QuestionAnchor[], options: QuestionIROptions = {}) {
  const operations = availableQuestionOperations(anchors, options);
  if (!operations.length) throw new QuestionIRValidationError('IR_NO_ANCHOR');
  const variants: z.ZodType<QuestionIR>[] = [];
  for (const operation of operations) {
    if (operation === 'contradiction') {
      // Group by the primary source: identical permitted pairs, without a schema branch per cross-product pair.
      const byPrimary = new Map<string, Set<string>>();
      for (const [anchorId, secondaryAnchorId] of contradictionPairs(anchors, options.contradictionPairs, options.primaryTurnId)) {
        if (!byPrimary.has(anchorId)) byPrimary.set(anchorId, new Set());
        byPrimary.get(anchorId)!.add(secondaryAnchorId);
      }
      for (const [anchorId, secondaryIds] of byPrimary) variants.push(z.object({ operation: z.literal(operation), anchorId: z.literal(anchorId), anchorMode: z.enum(questionAnchorModes), secondaryAnchorId: z.enum([...secondaryIds] as [string, ...string[]]) }).strict());
    } else variants.push(z.object({ operation: z.literal(operation), anchorId: z.enum(eligibleAnchors(operation, anchors, options.primaryTurnId).map(anchor => anchor.id) as [string, ...string[]]), anchorMode: z.enum(questionAnchorModes), secondaryAnchorId: z.null() }).strict());
  }
  return variants.length === 1 ? variants[0] : z.union(variants as [z.ZodType<QuestionIR>, z.ZodType<QuestionIR>, ...Array<z.ZodType<QuestionIR>>]);
}

function quoteSuffix(quote: string) {
  const code = quote.trim().at(-1)?.charCodeAt(0) ?? 0;
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 ? '이라고 하셨는데, ' : '라고 하셨는데, ';
}
interface SurfaceTemplate { id: string; family: string; request: string }
export interface RealizedQuestion {
  questionText: string;
  primaryFunction: QuestionDraft['primaryFunction'];
  depth: QuestionDraft['depth'];
  questionIntent: string;
  targetEvidence: [string];
  goal: FollowUpGoal;
  templateId: string;
  family: string;
  policyVersion: typeof QUESTION_REALIZATION_VERSION;
  ir: QuestionIR;
  anchor: QuestionAnchor;
  secondaryAnchor: QuestionAnchor | null;
  anchorProof: Array<{ anchorId: string; sourceId: string; sourceSha256: string; sourceStartOffset: number; sourceEndOffset: number; questionStartOffset: number | null; questionEndOffset: number | null }>;
  proof: Array<{ questionStartOffset: number; questionEndOffset: number; basis: 'answer_turn_attributed'; sourceId: string; sourceStartOffset: number; sourceEndOffset: number }>;
  openChecks: Array<{ questionStartOffset: number; questionEndOffset: number; kind: 'open_check' | 'hypothetical' }>;
  validation: { method: 'approved_ir_surface'; independentSemanticReview: false; questionSha256: string };
}

/** Meaning selection still belongs to the core; this renderer verifies only approved structure and source binding. */
export function renderQuestionIR(input: unknown, options: QuestionIROptions & { anchors: readonly QuestionAnchor[]; seed: string; history?: readonly UtteranceHistoryItem[]; maxCharacters?: number; templateIdToRestore?: string }): RealizedQuestion {
  const parsed = questionIRWireSchema(options.anchors, options).safeParse(input);
  if (!parsed.success) throw new QuestionIRValidationError('IR_INVALID');
  const ir = parsed.data as QuestionIR;
  const anchor = options.anchors.find(candidate => candidate.id === ir.anchorId)!;
  assertQuestionAnchorBinding(anchor);
  const secondaryAnchor = ir.secondaryAnchorId ? options.anchors.find(candidate => candidate.id === ir.secondaryAnchorId)! : null;
  if (secondaryAnchor) assertQuestionAnchorBinding(secondaryAnchor);
  const profile = profiles[ir.operation];
  const before = ir.anchorMode === 'exact_quote' ? '‘' : '';
  const prefix = ir.anchorMode === 'exact_quote' ? `${before}${anchor.quote}’${quoteSuffix(anchor.quote)}` : ir.anchorMode === 'short_context' ? profile.context : '';
  const max = Math.min(75, options.maxCharacters ?? 75);
  const templates: SurfaceTemplate[] = profile.requests.map((request, index) => ({ id: `${QUESTION_REALIZATION_VERSION}.${ir.operation}.${index + 1}.${ir.anchorMode}`, family: `${ir.operation}.request-${index + 1}`, request })).filter(template => [...`${prefix}${template.request}`].length <= max);
  const selected = options.templateIdToRestore ? templates.find(template => template.id === options.templateIdToRestore) : selectNonRepeatingTemplate(templates, options.seed, options.history);
  if (!selected) throw new QuestionIRValidationError('IR_SURFACE_INVALID');
  const questionText = `${prefix}${selected.request}`;
  assertInterviewQuestionSpeech(questionText, { isFirstTurn: false });
  const questionStart = ir.anchorMode === 'exact_quote' ? before.length : null;
  const anchorProof = [anchor, ...(secondaryAnchor ? [secondaryAnchor] : [])].map((item, index) => ({ anchorId: item.id, sourceId: item.sourceId, sourceSha256: item.sourceSha256, sourceStartOffset: item.start, sourceEndOffset: item.end, questionStartOffset: index === 0 ? questionStart : null, questionEndOffset: index === 0 && questionStart !== null ? questionStart + anchor.quote.length : null }));
  const proof = questionStart === null ? [] : [{ questionStartOffset: questionStart, questionEndOffset: questionStart + anchor.quote.length, basis: 'answer_turn_attributed' as const, sourceId: anchor.sourceId, sourceStartOffset: anchor.start, sourceEndOffset: anchor.end }];
  return { questionText, primaryFunction: profile.primaryFunction, depth: profile.depth, questionIntent: profile.target, targetEvidence: [profile.target], goal: profile.goal, templateId: selected.id, family: selected.family, policyVersion: QUESTION_REALIZATION_VERSION, ir, anchor, secondaryAnchor, anchorProof, proof, openChecks: [{ questionStartOffset: prefix.length, questionEndOffset: questionText.length, kind: ['alternative', 'transfer', 'value_judgement'].includes(ir.operation) ? 'hypothetical' : 'open_check' }], validation: { method: 'approved_ir_surface', independentSemanticReview: false, questionSha256: sha(questionText) } };
}

/** Rebuild saved speech from an exact code-registry identity and freshly verified original source bindings. */
export function restoreQuestionIR(input: unknown, options: QuestionIROptions & { anchors: readonly QuestionAnchor[]; templateId: string; questionText: string }): RealizedQuestion {
  const restored = renderQuestionIR(input, { ...options, seed: 'restore-approved-ir', templateIdToRestore: options.templateId });
  if (restored.questionText !== options.questionText) throw new QuestionIRValidationError('IR_SURFACE_INVALID');
  assertRenderedQuestionIntegrity(restored);
  return restored;
}

/** Saved IR must be re-bound to actual source text; a supplied text/hash alone is not an approval. */
export function assertRenderedQuestionIntegrity(rendered: RealizedQuestion) {
  const anchor = rendered.anchor, profile = profiles[rendered.ir.operation];
  if (!profile || !questionAnchorModes.includes(rendered.ir.anchorMode) || rendered.policyVersion !== QUESTION_REALIZATION_VERSION || rendered.validation.method !== 'approved_ir_surface' || rendered.validation.independentSemanticReview !== false || rendered.validation.questionSha256 !== sha(rendered.questionText)) throw new QuestionIRValidationError('IR_SURFACE_INVALID');
  const raw = assertQuestionAnchorBinding(anchor);
  if (rendered.ir.anchorId !== anchor.id || rendered.ir.secondaryAnchorId !== (rendered.secondaryAnchor?.id ?? null)) throw new QuestionIRValidationError('IR_SOURCE_INVALID');
  if (rendered.secondaryAnchor) assertQuestionAnchorBinding(rendered.secondaryAnchor);
  if (rendered.ir.operation === 'numeric_verification' && !hasObservedMeasurement(raw, anchor.quote) || rendered.ir.operation === 'comparison' && !hasObservedComparison(raw, anchor.quote)) throw new QuestionIRValidationError('IR_UNSUPPORTED_OBSERVATION');
  if (rendered.ir.operation === 'contradiction' ? !rendered.secondaryAnchor || rendered.secondaryAnchor.id === anchor.id : Boolean(rendered.secondaryAnchor)) throw new QuestionIRValidationError('IR_CONTRADICTION_PAIR_REQUIRED');
  const prefix = rendered.ir.anchorMode === 'exact_quote' ? `‘${anchor.quote}’${quoteSuffix(anchor.quote)}` : rendered.ir.anchorMode === 'short_context' ? profile.context : '';
  const requestIndex = profile.requests.findIndex(request => rendered.questionText === `${prefix}${request}`);
  if (requestIndex < 0 || rendered.templateId !== `${QUESTION_REALIZATION_VERSION}.${rendered.ir.operation}.${requestIndex + 1}.${rendered.ir.anchorMode}` || rendered.family !== `${rendered.ir.operation}.request-${requestIndex + 1}` || rendered.goal !== profile.goal || rendered.primaryFunction !== profile.primaryFunction || rendered.depth !== profile.depth || rendered.questionIntent !== profile.target || rendered.targetEvidence.length !== 1 || rendered.targetEvidence[0] !== profile.target || [...rendered.questionText].length > 75) throw new QuestionIRValidationError('IR_SURFACE_INVALID');
  const at = rendered.ir.anchorMode === 'exact_quote' ? 1 : null;
  const expectedAnchorProof = [anchor, ...(rendered.secondaryAnchor ? [rendered.secondaryAnchor] : [])].map((item, index) => ({ anchorId: item.id, sourceId: item.sourceId, sourceSha256: item.sourceSha256, sourceStartOffset: item.start, sourceEndOffset: item.end, questionStartOffset: index === 0 ? at : null, questionEndOffset: index === 0 && at !== null ? at + anchor.quote.length : null }));
  const expectedProof = at === null ? [] : [{ questionStartOffset: at, questionEndOffset: at + anchor.quote.length, basis: 'answer_turn_attributed', sourceId: anchor.sourceId, sourceStartOffset: anchor.start, sourceEndOffset: anchor.end }];
  const expectedOpenChecks = [{ questionStartOffset: prefix.length, questionEndOffset: rendered.questionText.length, kind: ['alternative', 'transfer', 'value_judgement'].includes(rendered.ir.operation) ? 'hypothetical' : 'open_check' }];
  if (JSON.stringify(rendered.anchorProof) !== JSON.stringify(expectedAnchorProof) || JSON.stringify(rendered.proof) !== JSON.stringify(expectedProof) || JSON.stringify(rendered.openChecks) !== JSON.stringify(expectedOpenChecks)) throw new QuestionIRValidationError('IR_SOURCE_INVALID');
  assertInterviewQuestionSpeech(rendered.questionText, { isFirstTurn: false });
}
