import { createHash } from 'node:crypto';
import type { InterviewContext } from '../data/load-interview-context';
import type { InterviewSession } from '../protocol';
import { buildEvaluationObservations, type EvaluationObservations } from './answer-observations';
import { buildEvaluationUnits, type EvaluationUnit } from './evaluation-turns';
import { evaluationKnowledgeInput } from './evaluation-knowledge-gate';
import { parseApprovedKnowledgeBundle } from '../data/approved-knowledge';
import { findExactQuestionEvaluationSpec } from '../data/evaluation-scope-registry';

export const EVALUATION_PIPELINE_VERSION = 'source-bound-cluster-evaluation-v5-reviewed-supply';
export const HISTORICAL_REVIEWED_KNOWLEDGE_PIPELINE_VERSION = 'source-bound-cluster-evaluation-v4-reviewed-knowledge';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const nonnegative = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown) => typeof value === 'string' ? value : null;
const numericFields = (value: unknown, keys: readonly string[]) => {
  const source = object(value);
  return Object.fromEntries(keys.map(key => [key, nonnegative(source[key])]));
};

/** A checkpoint is usable only for its exact, versioned request. It is not an
 * approval cache for another transcript, policy, observation, or question. */
export interface EvaluationClusterCheckpoint {
  version: typeof EVALUATION_PIPELINE_VERSION;
  clusterId: string;
  inputSha256: string;
  output: unknown;
  completedAt: string;
}

/** Raw camera samples, client event backups and engine traces remain in the
 * original session/journal. Neither a model request nor its stored result
 * needs another copy. Keep the existing observations API shape for consumers. */
export function buildEvaluationObservationSummary(session: InterviewSession): EvaluationObservations {
  const observations = buildEvaluationObservations(session);
  return {
    answers: observations.answers.map(answer => {
      const vision = object(answer.vision), summary = object(vision.summary);
      const speech = answer.speech === null ? null : {
        ...numericFields(answer.speech, [
          'durationMs', 'speakingMs', 'silenceMs', 'firstSpeechMs', 'pauseCount', 'speechStartCount',
          'rmsMean', 'rmsMax', 'peak', 'clippingRatio', 'eojeolsPerMinute', 'speechRate',
          'characterCount', 'eojeolCount', 'hangulSyllableCount', 'cpm', 'speakingCpm',
          'eojeolPerMinute', 'hangulSyllablesPerMinuteApprox',
        ]),
        units: { cpm: 'Unicode_letters_and_numbers_per_total_minute', speakingCpm: 'Unicode_letters_and_numbers_per_voiced_minute',
          eojeolPerMinute: 'whitespace_separated_eojeols_per_total_minute',
          hangulSyllablesPerMinuteApprox: 'Hangul_syllable_characters_per_total_minute_not_phonetic_syllables' },
      };
      return {
        turnId: answer.turnId, answerId: answer.answerId, transcriptStatus: answer.transcriptStatus,
        finalized: answer.finalized, transcriptObserved: answer.transcriptObserved,
        speech,
        vision: answer.vision === null ? null : {
          method: text(vision.method),
          measurementScope: 'observed_turn_summary_only',
          summary: {
            answerRecordCount: nonnegative(summary.answerRecordCount),
            gazeOffFrameRatio: nonnegative(summary.gazeOffFrameRatio),
            gazeOffTimeRatio: nonnegative(summary.gazeOffTimeRatio),
            gazeEpisodeCount: nonnegative(summary.gazeEpisodeCount),
            smileObservedFrameRatio: nonnegative(summary.smileObservedFrameRatio),
            browDownObservedFrameRatio: nonnegative(summary.browDownObservedFrameRatio),
            measuredGazeDurationMs: nonnegative(summary.measuredGazeDurationMs),
            unavailableRatio: nonnegative(summary.unavailableRatio),
          },
        },
        // Runtime speed is not delivery coaching and never an answer score.
        clientTimings: null, providerTimings: null,
        sttObservations: answer.sttObservations?.map(item => ({
          segmentId: item.segmentId, revision: item.revision,
          confidence: finite(item.confidence), startTimestamp: finite(item.startTimestamp), endTimestamp: finite(item.endTimestamp),
        })) ?? null,
        habits: answer.habits, languageCandidates: answer.languageCandidates,
        durationMs: answer.durationMs,
        unavailable: {
          speechTiming: answer.unavailable.speechTiming, vad: answer.unavailable.vad,
          vision: answer.unavailable.vision, providerConfidence: answer.unavailable.providerConfidence,
          wordTimestamps: true,
        },
      };
    }),
    sessionMetrics: null,
    scope: observations.scope,
  };
}

/** Exact MD paragraphs, not a model-written summary. Every normative article
 * is accounted for; arithmetic, persistence, output navigation and acceptance
 * tests are implemented outside the scoring model. Examples are reference
 * material and never evidence about this student. */
const modelArticles = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 35, 42]);
const serverArticles = new Set([16, 18, 30, 31, 32, 36, 37, 38, 45]);
const presentationArticles = new Set([33, 34, 39, 40, 41, 43, 44]);
export function evaluationPolicyProjection(guidelines: string) {
  const matches = [...guidelines.matchAll(/^### 제(\d+)조[^\r\n]*/gmu)];
  if (!matches.length) return {
    instructions: guidelines,
    trace: { sourceSha256: hash(guidelines), modelArticles: [] as number[], articles: [] as Array<{ article: number; stage: string; start: number; end: number; sha256: string }>, referenceMaterialRetainedInSource: true },
  };
  const articles = matches.map(match => {
    const start = match.index!;
    const following = guidelines.slice(start + match[0].length).search(/^#{1,3} /mu);
    const end = following < 0 ? guidelines.length : start + match[0].length + following;
    const article = Number(match[1]);
    const stage = modelArticles.has(article) ? 'model_anchor_and_feedback'
      : serverArticles.has(article) ? 'server_formula_validation_and_persistence'
      : presentationArticles.has(article) ? 'output_and_other_modes' : null;
    if (!stage) throw new Error('EVALUATION_POLICY_ARTICLE_UNMAPPED:' + article);
    return { article, stage, start, end, sha256: hash(guidelines.slice(start, end)) };
  });
  if (new Set(articles.map(item => item.article)).size !== articles.length) throw new Error('EVALUATION_POLICY_ARTICLE_DUPLICATED');
  return {
    instructions: articles.filter(item => item.stage === 'model_anchor_and_feedback').map(item => guidelines.slice(item.start, item.end)).join('\n'),
    trace: { sourceSha256: hash(guidelines), modelArticles: articles.filter(item => item.stage === 'model_anchor_and_feedback').map(item => item.article), articles, referenceMaterialRetainedInSource: true },
  };
}

function answerInput(unit: EvaluationUnit) {
  const turn = unit.turn;
  return {
    id: turn.id, parentMainQuestionId: turn.parentMainQuestionId, questionKind: turn.questionKind,
    questionText: turn.questionText,
    contract: {
      approvedContractSha256: turn.metadata.approvedQuestion?.contentSha256 ?? null,
      questionIntent: turn.metadata.questionIntent, targetEvidence: turn.metadata.targetEvidence,
      primaryFunction: turn.metadata.primaryFunction, depth: turn.metadata.depth,
    },
    evidenceIds: [...(turn.evidenceIds ?? [])],
    clarificationTurnIds: [...unit.clarificationTurnIds],
    answerAttempts: unit.answerAttempts.map(attempt => ({
      sourceTurnId: attempt.sourceTurnId, answerId: attempt.answerId,
      questionText: attempt.questionText, kind: attempt.kind,
      rawTranscript: attempt.rawTranscript, transcriptStatus: attempt.transcriptStatus,
      finalized: attempt.finalized, observationClassification: attempt.observationClassification,
    })),
  };
}

function modelObservation(answer: EvaluationObservations['answers'][number]) {
  const confidences = answer.sttObservations?.map(item => item.confidence).filter((value): value is number => value !== null) ?? [];
  return {
    turnId: answer.turnId, answerId: answer.answerId, finalized: answer.finalized,
    transcriptObserved: answer.transcriptObserved,
    speech: answer.speech, vision: answer.vision, durationMs: answer.durationMs,
    stt: { observedSegments: answer.sttObservations?.length ?? 0, confidenceObserved: confidences.length > 0,
      minimumConfidence: confidences.length ? Math.min(...confidences) : null,
      meanConfidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
      wordTimestampsAvailable: false },
    habits: answer.habits === null ? null : {
      confirmedCount: answer.habits.confirmedCount, candidateCount: answer.habits.candidateCount,
      confirmedPerMinute: answer.habits.confirmedPerMinute, confirmedPer100Eojeol: answer.habits.confirmedPer100Eojeol,
      scope: answer.habits.scope,
    },
    languageCandidates: answer.languageCandidates.map(candidate => ({
      id: candidate.id, turnId: candidate.turnId, kind: candidate.kind, surface: candidate.surface,
      spans: candidate.spans.map(span => ({ start: span.start, end: span.end, surface: span.surface })), observedCount: candidate.observedCount,
    })),
    unavailable: answer.unavailable,
  };
}

export function buildEvaluationClusterInputs(context: InterviewContext, session: InterviewSession) {
  const units = buildEvaluationUnits(session).scoredUnits;
  const observations = buildEvaluationObservationSummary(session);
  const groups = new Map<string, EvaluationUnit[]>();
  for (const unit of units) {
    const clusterId = unit.turn.parentMainQuestionId || unit.turn.id;
    groups.set(clusterId, [...groups.get(clusterId) ?? [], unit]);
  }
  return [...groups].map(([clusterId, clusterUnits]) => {
    const evidenceIds = new Set(clusterUnits.flatMap(unit => unit.turn.evidenceIds ?? []));
    const turnIds = new Set(clusterUnits.flatMap(unit => [unit.turn.id, ...unit.answerAttempts.map(attempt => attempt.sourceTurnId)]));
    const activityIds = new Set(clusterUnits.flatMap(unit => unit.turn.metadata.activityIds ?? []));
    return {
      version: EVALUATION_PIPELINE_VERSION,
      clusterId,
      target: { university: context.target?.university ?? null, department: context.target?.department ?? null,
        academicYear: context.target?.academicYear ?? null, admissionTrack: context.target?.admissionTrack ?? null },
      school: { schoolReferenceId: context.school.schoolReferenceId ?? null,
        officialEvaluationElements: context.school.officialInterviewCriteria?.elements.map(element => element.name) ?? [] },
      studentEvidence: (context.student?.evidence ?? []).filter(source => evidenceIds.has(source.id)).map(source => ({
        id: source.id, activityId: source.activityId, page: source.page, text: source.text,
        scientificTruthVerification: source.scientificTruthVerification,
        sourceRef: { pdfSha256: source.sourceRef.pdfSha256, page: source.sourceRef.page,
          startOffset: source.sourceRef.startOffset, endOffset: source.sourceRef.endOffset },
      })),
      activityStrategy: context.targetAnalysis ? {
        revision: context.targetAnalysis.revision, supportTargetId: context.targetAnalysis.supportTargetId,
        activityPriorities: context.targetAnalysis.activityPriorities.filter(item => activityIds.has(item.activityId)).map(item => ({
          activityId: item.activityId, priority: item.priority, reason: item.reason, criterionName: item.criterionName,
        })), scoreInfluence: false,
      } : null,
      answers: clusterUnits.map(unit => {
        const spec = context.evaluationScopeRegistry ? findExactQuestionEvaluationSpec(context, session, unit.turn, context.evaluationScopeRegistry) : undefined;
        return { ...answerInput(unit), knowledge: evaluationKnowledgeInput(context, session, unit),
          ...(spec?.review.status === 'approved' ? { evaluationSpecification: { id: spec.evaluationSpecId, revision: spec.revision,
            reviewedDemand: spec.reviewedDemand, assessableCriteria: spec.assessableCriteria, excludedCriteria: spec.excludedCriteria,
            evidenceExpectations: spec.evidenceExpectations, rubricVersion: spec.rubricVersion } } : {}) };
      }),
      questionPresentations: (session.questionPresentations ?? []).filter(item => turnIds.has(item.turnId)).map(item => ({
        turnId: item.turnId, rootTurnId: item.rootTurnId, questionKind: item.questionKind,
        clockId: item.clockId, startedAtMs: item.startedAtMs, completedAtMs: item.completedAtMs,
        interrupted: item.interrupted ?? false, errorCodes: item.errorCodes ?? [],
      })),
      observations: { answers: observations.answers.filter(answer => turnIds.has(answer.turnId)).map(modelObservation),
        scope: observations.scope },
    };
  });
}
export type EvaluationClusterInput = ReturnType<typeof buildEvaluationClusterInputs>[number];

/** Ignores lifecycle/polling/provider ledgers while pinning all data actually
 * consumed by the evaluator. The immutable full snapshot is stored separately. */
export function evaluationSessionSourceFingerprint(context: InterviewContext, session: InterviewSession, model = process.env.OPENAI_ANALYSIS_MODEL || 'gpt-6.1-terra') {
  return hash(JSON.stringify({ version: EVALUATION_PIPELINE_VERSION,
    model,
    evaluationGuidelinesSha256: hash(context.evaluationGuidelines ?? ''),
    approvedKnowledgeSha256: context.approvedKnowledge ? parseApprovedKnowledgeBundle(context.approvedKnowledge).contentSha256 : null,
    evaluationScopePolicySha256: context.evaluationScopePolicy?.contentSha256 ?? null,
    evaluationSpecRegistrySha256: context.evaluationScopeRegistry?.contentSha256 ?? null,
    sessionReviewReceiptSha256: context.manifest?.recordIds?.sessionReviewReceiptSha256 ?? null,
    clusters: buildEvaluationClusterInputs(context, session),
    unscored: buildEvaluationUnits(session).unscoredAnswers,
  }));
}

/** Frozen v4 input contract for reading completed historical results only.
 * Never upgrades an old context or authorizes execution by the current worker.
 * Its field order and absent scope-policy field preserve the published v4 hash. */
export function historicalEvaluationSourceFingerprint(context: InterviewContext, session: InterviewSession,
  version: string, model: string) {
  if (version !== HISTORICAL_REVIEWED_KNOWLEDGE_PIPELINE_VERSION || context.evaluationScopePolicy || context.evaluationScopeRegistry) {
    throw new Error('HISTORICAL_EVALUATION_PIPELINE_UNSUPPORTED');
  }
  return hash(JSON.stringify({ version, model,
    evaluationGuidelinesSha256: hash(context.evaluationGuidelines ?? ''),
    approvedKnowledgeSha256: context.approvedKnowledge ? parseApprovedKnowledgeBundle(context.approvedKnowledge).contentSha256 : null,
    clusters: buildEvaluationClusterInputs(context, session).map(input => ({ ...input, version })),
    unscored: buildEvaluationUnits(session).unscoredAnswers,
  }));
}
