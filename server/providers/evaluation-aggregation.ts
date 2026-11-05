import type { InterviewSession, QuestionPresentation, RecordedTurn } from "../protocol";
import { buildEvaluationUnits } from "./evaluation-turns";

/** Persisted observations of actual question playback; prepared drafts are not presentation. */
export type EvaluationQuestionPresentation = QuestionPresentation;
type AggregationSession = Pick<InterviewSession, "turns" | "questionPresentations">;
export interface AggregationAnswer {
  turnId: string;
  status: string;
  score: number | null;
  deferredReason?: string | null;
}
interface UnscoredAnswer { turnId: string; reason: string }
interface Exclusion { turnId: string; code: string; detail?: string }
interface ClusterMember {
  turnId: string;
  questionKind: "main" | "follow_up";
  weight: number | null;
  score: number | null;
}
export interface EvaluationClusterScore {
  rootTurnId: string;
  status: "SCORABLE" | "CLUSTER_NOT_EVALUABLE";
  score: number | null;
  members: ClusterMember[];
  exclusionReasons: Exclusion[];
}
const observedTime = (value: number | null) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const started = (presentation: EvaluationQuestionPresentation) => observedTime(presentation.startedAtMs) || observedTime(presentation.completedAtMs);

/** Missing/failed delivery is never evidence that the student declined to answer. */
export function questionPresentationIssue(presentation: EvaluationQuestionPresentation | undefined): string | null {
  if (!presentation) return "QUESTION_PRESENTATION_UNVERIFIED";
  if (!presentation.clockId?.trim()) return "PRESENTATION_CLOCK_UNVERIFIED";
  if (!observedTime(presentation.startedAtMs)) return "QUESTION_PRESENTATION_UNVERIFIED";
  if (presentation.interrupted) return "QUESTION_DELIVERY_INTERRUPTED";
  if (presentation.errorCodes?.length) return "QUESTION_DELIVERY_ERROR";
  if (!observedTime(presentation.completedAtMs)) return "QUESTION_DELIVERY_INCOMPLETE";
  if (presentation.completedAtMs! < presentation.startedAtMs!) return "QUESTION_PRESENTATION_CLOCK_INVALID";
  return null;
}

const captureObserved = (turn: RecordedTurn) => Boolean(turn.answerId || turn.transcriptStatus !== undefined || turn.rawTranscript !== undefined);

/** v2.3 articles 35–38: whole clusters, no renormalization, and no synthetic zeroes. */
export function aggregateSessionEvaluation(session: AggregationSession, answers: AggregationAnswer[], unscoredAnswers: UnscoredAnswer[] = []) {
  const ledger = session.questionPresentations;
  if (!ledger) return {
    aggregationRulesVersion: "answer-v2.3-clusters" as const,
    clusterScores: [] as EvaluationClusterScore[], sessionScore: null, overallWeightedScore: null,
    aggregation: { status: "PRESENTATION_UNVERIFIED" as const, reasonCodes: ["PRESENTATION_UNVERIFIED"], N_total: null, N_valid: null, validRatio: null, minValidClusters: 2, minValidRatio: 0.6 },
    partialReport: true,
  };
  const turnsById = new Map(session.turns.map(turn => [turn.id, turn]));
  const evaluationUnits = buildEvaluationUnits(session);
  const unitsById = new Map(evaluationUnits.units.map(unit => [unit.turn.id, unit]));
  const answerRows = new Map<string, AggregationAnswer[]>();
  for (const answer of answers) answerRows.set(answer.turnId, [...answerRows.get(answer.turnId) ?? [], answer]);
  const unscoredById = new Map([...unscoredAnswers, ...evaluationUnits.unscoredAnswers].map(answer => [answer.turnId, answer.reason]));
  const byRoot = new Map<string, Map<string, EvaluationQuestionPresentation[]>>();
  for (const presentation of ledger) {
    if (!started(presentation) || presentation.questionKind === "clarification") continue;
    if (!byRoot.has(presentation.rootTurnId)) byRoot.set(presentation.rootTurnId, new Map());
    const root = byRoot.get(presentation.rootTurnId)!;
    root.set(presentation.turnId, [...root.get(presentation.turnId) ?? [], presentation]);
  }
  // A server-observed capture is evidence that a root began even if its playback event was lost.
  // It does not establish normal delivery, and cannot make that root valid without the real ledger.
  for (const turn of session.turns) {
    if (turn.questionKind !== "clarification" && captureObserved(turn) && !byRoot.has(turn.parentMainQuestionId)) byRoot.set(turn.parentMainQuestionId, new Map());
  }
  const clusterScores: EvaluationClusterScore[] = [];
  for (const [rootTurnId, records] of byRoot) {
    const exclusions: Exclusion[] = [];
    const presentations = [...records.values()].map(copies => {
      const first = copies[0];
      // Exact duplicated end backups are harmless; conflicting observations cannot hide a fault.
      if (copies.some(copy => copy.questionKind !== first.questionKind || copy.clockId !== first.clockId || copy.startedAtMs !== first.startedAtMs || copy.completedAtMs !== first.completedAtMs || Boolean(copy.interrupted) !== Boolean(first.interrupted) || JSON.stringify(copy.errorCodes ?? []) !== JSON.stringify(first.errorCodes ?? []))) {
        exclusions.push({ turnId: first.turnId, code: "PRESENTATION_RECORD_CONFLICT" });
      }
      const otherRoots = ledger.some(copy => copy.turnId === first.turnId && copy.rootTurnId !== rootTurnId && started(copy));
      if (otherRoots) exclusions.push({ turnId: first.turnId, code: "PRESENTATION_ROOT_CONFLICT" });
      return first;
    });
    const mains = presentations.filter(presentation => presentation.questionKind === "main");
    const followUps = presentations.filter(presentation => presentation.questionKind === "follow_up");
    if (mains.length !== 1 || mains[0]?.turnId !== rootTurnId) exclusions.push({ turnId: rootTurnId, code: "MAIN_QUESTION_NOT_PRESENTED" });
    if (followUps.length > 2) exclusions.push({ turnId: rootTurnId, code: "FOLLOW_UP_LIMIT_EXCEEDED" });
    for (const turn of session.turns) {
      if (turn.parentMainQuestionId === rootTurnId && turn.questionKind !== "clarification" && captureObserved(turn) && !records.has(turn.id)) {
        exclusions.push({ turnId: turn.id, code: "CAPTURED_QUESTION_PRESENTATION_UNVERIFIED" });
        if (turn.metadata.nonEvaluative === true) exclusions.push({ turnId: turn.id, code: "QUESTION_EVALUATION_IDENTITY_INVALID" });
      }
    }
    const members: ClusterMember[] = presentations.map(presentation => {
      const turn = turnsById.get(presentation.turnId);
      const rows = answerRows.get(presentation.turnId) ?? [];
      const answer = rows.length === 1 ? rows[0] : undefined;
      const presentationIssue = questionPresentationIssue(presentation);
      if (presentationIssue) exclusions.push({ turnId: presentation.turnId, code: presentationIssue, ...(presentation.errorCodes?.length ? { detail: presentation.errorCodes.join(", ") } : {}) });
      if (!turn) exclusions.push({ turnId: presentation.turnId, code: "QUESTION_RECORD_MISSING" });
      else if (turn.parentMainQuestionId !== rootTurnId || turn.questionKind !== presentation.questionKind) exclusions.push({ turnId: presentation.turnId, code: "QUESTION_IDENTITY_MISMATCH" });
      if (turn?.metadata.nonEvaluative === true) exclusions.push({ turnId: presentation.turnId, code: "QUESTION_EVALUATION_IDENTITY_INVALID" });
      if (rows.length > 1) exclusions.push({ turnId: presentation.turnId, code: "DUPLICATE_ANSWER_EVALUATION" });
      const finalTranscriptAvailable = unitsById.get(presentation.turnId)?.hasFinalTranscript === true;
      const scorableAnswer = finalTranscriptAvailable && turn?.metadata.nonEvaluative !== true && answer && ["SATISFIED", "PARTIAL", "NOT_SATISFIED"].includes(answer.status) && typeof answer.score === "number" && Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= 100;
      if (!scorableAnswer) {
        exclusions.push({ turnId: presentation.turnId, code: unscoredById.get(presentation.turnId) ?? (!finalTranscriptAvailable ? "FINAL_TRANSCRIPT_UNAVAILABLE" : answer ? "ANSWER_NOT_EVALUABLE" : "ANSWER_EVALUATION_MISSING"), ...(answer?.deferredReason ? { detail: answer.deferredReason } : {}) });
      }
      return {
        turnId: presentation.turnId, questionKind: presentation.questionKind as "main" | "follow_up",
        weight: followUps.length > 2 ? null : presentation.questionKind === "main" ? followUps.length ? 0.7 : 1 : followUps.length === 1 ? 0.3 : 0.15,
        score: scorableAnswer ? answer.score : null,
      };
    });
    const valid = exclusions.length === 0;
    // Validity above establishes every score and weight; no absent answer becomes a zero.
    const score = valid ? members.reduce((sum, member) => sum + member.score! * member.weight!, 0) : null;
    clusterScores.push({ rootTurnId, status: valid ? "SCORABLE" : "CLUSTER_NOT_EVALUABLE", score, members, exclusionReasons: exclusions });
  }
  const N_total = clusterScores.length;
  const validClusters = clusterScores.filter(cluster => cluster.status === "SCORABLE");
  const N_valid = validClusters.length;
  const validRatio = N_total ? N_valid / N_total : null;
  const reasonCodes = [
    ...(N_total === 0 ? ["NO_PRESENTED_CLUSTERS"] : []),
    ...(N_valid < 2 ? ["INSUFFICIENT_VALID_CLUSTERS"] : []),
    ...(N_total > 0 && N_valid * 5 < N_total * 3 ? ["INSUFFICIENT_VALID_RATIO"] : []),
  ];
  const sessionScore = reasonCodes.length ? null : validClusters.reduce((sum, cluster) => sum + cluster.score!, 0) / N_valid;
  return {
    aggregationRulesVersion: "answer-v2.3-clusters" as const, clusterScores, sessionScore, overallWeightedScore: sessionScore,
    aggregation: { status: sessionScore !== null ? "SCORABLE" as const : N_valid < 2 ? "INSUFFICIENT_SAMPLE" as const : "NORMAL_EVALUATION_UNAVAILABLE" as const, reasonCodes, N_total, N_valid, validRatio, minValidClusters: 2, minValidRatio: 0.6 },
    partialReport: N_total === 0 || N_valid !== N_total,
  };
}
