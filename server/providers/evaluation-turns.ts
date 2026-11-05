import type { InterviewSession, RecordedTurn } from "../protocol";
import { assertQuestionContractIntegrity } from '../question-objective';

/** Scoring cannot silently adopt changed questions, demands, source proof or approval metadata. */
export function assertEvaluationQuestionContracts(session: Pick<InterviewSession, 'turns'>) {
  for (const turn of session.turns) {
    if (!turn.metadata.approvedQuestion) continue;
    assertQuestionContractIntegrity({ ...turn.metadata, acknowledgement: null, questionText: turn.questionText, questionKind: turn.questionKind, parentMainQuestionId: turn.questionKind === 'main' ? null : turn.parentMainQuestionId, evidenceIds: turn.evidenceIds }, turn.metadata.approvedQuestion);
  }
}

export interface EvaluationAnswerAttempt {
  sourceTurnId: string;
  answerId: string | null;
  questionText: string;
  kind: RecordedTurn["questionKind"];
  rawTranscript: string;
  transcriptStatus: RecordedTurn["transcriptStatus"] | null;
  finalized: boolean;
  observationClassification: NonNullable<RecordedTurn["answerObservation"]>["classification"] | null;
}
export interface EvaluationUnit {
  turn: RecordedTurn;
  answerAttempts: EvaluationAnswerAttempt[];
  clarificationTurnIds: string[];
  hasFinalTranscript: boolean;
}

/** Restatement answers belong to the actual original demand, never a second scoring rubric. */
export function buildEvaluationUnits(session: Pick<InterviewSession, "turns">) {
  const units: EvaluationUnit[] = [], byId = new Map<string, EvaluationUnit>();
  const unassignedClarificationTurnIds: string[] = [];
  for (const turn of session.turns) {
    const clarification = turn.questionKind === "clarification" || turn.metadata.nonEvaluative === true;
    let unit: EvaluationUnit | undefined;
    if (clarification) {
      // Follow only the recorded lineage. Replay/restatement ancestry may name
      // another non-evaluative attempt; missing links never borrow a root.
      unit = turn.metadata.clarificationOfTurnId ? byId.get(turn.metadata.clarificationOfTurnId) : undefined;
      if (!unit || unit.turn.parentMainQuestionId !== turn.parentMainQuestionId) {
        unassignedClarificationTurnIds.push(turn.id);
        continue;
      }
      unit.clarificationTurnIds.push(turn.id);
      // Only an already resolved attempt becomes an alias. Forward links,
      // cycles and broken intermediate links cannot manufacture lineage.
      byId.set(turn.id, unit);
    } else {
      unit = { turn, answerAttempts: [], clarificationTurnIds: [], hasFinalTranscript: false };
      units.push(unit); byId.set(turn.id, unit);
    }
    if (turn.answerId || turn.transcriptStatus !== undefined || turn.rawTranscript !== undefined) {
      const rawTranscript = turn.rawTranscript ?? "";
      const finalized = turn.transcriptStatus === "finalized";
      unit.answerAttempts.push({ sourceTurnId: turn.id, answerId: turn.answerId ?? null, questionText: turn.questionText, kind: turn.questionKind, rawTranscript, transcriptStatus: turn.transcriptStatus ?? null, finalized, observationClassification: turn.answerObservation?.classification ?? null });
      unit.hasFinalTranscript ||= finalized && Boolean(rawTranscript.trim());
    }
  }
  return {
    units,
    scoredUnits: units.filter(unit => unit.hasFinalTranscript),
    unscoredAnswers: units.filter(unit => unit.answerAttempts.length && !unit.hasFinalTranscript).map(unit => ({
      turnId: unit.turn.id,
      answerAttemptTurnIds: unit.answerAttempts.map(attempt => attempt.sourceTurnId),
      clarificationTurnIds: unit.clarificationTurnIds,
      status: "NOT_EVALUABLE" as const,
      reason: unit.answerAttempts.some(attempt => attempt.transcriptStatus === "error") ? "TRANSCRIPTION_ERROR"
        : unit.answerAttempts.some(attempt => attempt.rawTranscript.trim()) ? "UNFINALIZED_TRANSCRIPT"
        : unit.answerAttempts.every(attempt => attempt.observationClassification === "silence_observed") ? "NO_SPEECH_OBSERVED" : "NO_TRANSCRIBED_CONTENT",
      score: null,
    })),
    unassignedClarificationTurnIds,
  };
}

/** No concatenation: a quote must be wholly inside one unchanged finalized answer. */
export function evaluationQuoteSource(unit: EvaluationUnit, quote: string) {
  if (!quote.trim()) return null;
  for (const attempt of unit.answerAttempts) {
    if (!attempt.finalized) continue;
    const start = attempt.rawTranscript.indexOf(quote);
    if (start >= 0) return { sourceTurnId: attempt.sourceTurnId, answerId: attempt.answerId, start, end: start + quote.length };
  }
  return null;
}
