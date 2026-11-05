import { createHash } from 'node:crypto';
import { assertRenderedQuestionIntegrity, type RealizedQuestion } from './question-realization';

export const QUESTION_GUARDS_VERSION = 'source-bound-question-guards-v1';
export type QuestionGuardCode = 'QUESTION_CLUSTER_MISMATCH' | 'QUESTION_PARENT_MISMATCH' | 'QUESTION_ANSWER_MISMATCH' | 'QUESTION_SOURCE_MISMATCH' | 'QUESTION_TARGET_UNBOUND' | 'QUESTION_REPEATED_TARGET' | 'QUESTION_NO_USEFUL_PROBE' | 'QUESTION_DECLINED_CURRENT_DEMAND' | 'QUESTION_FOLLOW_UP_LIMIT' | 'QUESTION_TIME_EXHAUSTED' | 'QUESTION_SURFACE_LIMIT';
export class QuestionGuardError extends Error {
  constructor(public readonly code: QuestionGuardCode) { super(code); this.name = 'QuestionGuardError'; }
}
export interface QuestionIRFlowContext {
  clusterId: string;
  expectedClusterId: string;
  parentQuestionId: string;
  expectedParentQuestionId: string;
  answerTurnId: string;
  expectedAnswerTurnId: string;
  objectiveId: string;
  clusterObjectiveId: string;
  expectedClusterObjectiveId: string;
  subordinationRationale: string;
  allowedSourceIds: readonly string[];
  askedObjectiveIds: readonly string[];
  followUpCount: number;
  maxFollowUps: number;
  elapsedMs: number;
  durationSeconds: number;
  minimumRemainingSeconds?: number;
  maxCharacters?: number;
}

/** Values here are server-owned state. A model rationale alone never grants a new cluster or count. */
export function assertQuestionIRFlow(context: QuestionIRFlowContext) {
  if (!context.clusterId || context.clusterId !== context.expectedClusterId || context.clusterObjectiveId !== context.expectedClusterObjectiveId) throw new QuestionGuardError('QUESTION_CLUSTER_MISMATCH');
  if (!context.parentQuestionId || context.parentQuestionId !== context.expectedParentQuestionId) throw new QuestionGuardError('QUESTION_PARENT_MISMATCH');
  if (!context.answerTurnId || context.answerTurnId !== context.expectedAnswerTurnId) throw new QuestionGuardError('QUESTION_ANSWER_MISMATCH');
  if (!context.objectiveId || !context.clusterObjectiveId || context.subordinationRationale.trim().length < 5) throw new QuestionGuardError('QUESTION_TARGET_UNBOUND');
  if (context.askedObjectiveIds.includes(context.objectiveId)) throw new QuestionGuardError('QUESTION_REPEATED_TARGET');
  if (!Number.isSafeInteger(context.followUpCount) || context.followUpCount < 0 || !Number.isSafeInteger(context.maxFollowUps) || context.maxFollowUps < 0 || context.maxFollowUps > 2 || context.followUpCount >= context.maxFollowUps) throw new QuestionGuardError('QUESTION_FOLLOW_UP_LIMIT');
  const minimum = context.minimumRemainingSeconds ?? 0;
  if (!Number.isFinite(context.elapsedMs) || context.elapsedMs < 0 || !Number.isFinite(context.durationSeconds) || context.durationSeconds <= 0 || !Number.isFinite(minimum) || minimum < 0 || context.durationSeconds * 1000 - context.elapsedMs <= minimum * 1000) throw new QuestionGuardError('QUESTION_TIME_EXHAUSTED');
}

/** Structural/source approval only: residual target/strategy semantic quality remains separately auditable. */
export function verifyRealizedQuestion(rendered: RealizedQuestion, context: QuestionIRFlowContext) {
  assertQuestionIRFlow(context);
  assertRenderedQuestionIntegrity(rendered);
  const sources = [rendered.anchor, ...(rendered.secondaryAnchor ? [rendered.secondaryAnchor] : [])];
  if (sources.some(anchor => !context.allowedSourceIds.includes(anchor.sourceId)) || rendered.anchor.turnId !== context.answerTurnId) throw new QuestionGuardError('QUESTION_SOURCE_MISMATCH');
  if ([...rendered.questionText].length > (context.maxCharacters ?? 75)) throw new QuestionGuardError('QUESTION_SURFACE_LIMIT');
  return Object.freeze({ version: QUESTION_GUARDS_VERSION, method: 'approved_ir_surface' as const, independentSemanticReview: false as const, questionSha256: createHash('sha256').update(rendered.questionText).digest('hex'), clusterId: context.clusterId, clusterObjectiveId: context.clusterObjectiveId, objectiveId: context.objectiveId, parentQuestionId: context.parentQuestionId, answerTurnId: context.answerTurnId, anchorIds: sources.map(anchor => anchor.id), checks: ['source_binding', 'approved_surface', 'single_request_structure', 'cluster_binding', 'duplicate_target_id', 'follow_up_budget', 'time_budget'] as const });
}
