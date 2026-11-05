import type { InterviewSession } from "../protocol";
import { observeSpeechHabits } from "../../lib/interview/speech-habits";
import { summarizeVisionRecords } from "../../lib/interview/vision-metrics";

interface Span { start: number; end: number; surface: string }
export type LanguageCandidateKind = "context_filler" | "repeated_vocabulary" | "repeated_ending";
export interface LanguageCandidate {
  id: string; turnId: string; kind: LanguageCandidateKind; surface: string; spans: Span[]; observedCount: number;
}
export interface LanguageClassification {
  turnId: string; candidateId: string;
  classification: "filler" | "meaningful" | "habit_candidate" | "topic_required" | "uncertain";
  reason: string;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function positiveDuration(value: unknown) { return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null; }
function visionForAnswer(metrics: Record<string, unknown>, sessionMetrics: Record<string, unknown>, turnId: string) {
  const explicit = metrics.vision != null;
  const input = explicit ? metrics.vision : sessionMetrics.vision;
  const vision = object(input);
  if (!Object.keys(vision).length) return null;
  // /end can attach a whole-session snapshot to the last answer. Its presence is not proof of per-turn scope.
  if (!Array.isArray(vision.records)) return explicit ? input : { ...vision, records: [], summary: null };
  const records = Array.isArray(vision.records) ? vision.records.map(object).filter(record => record.turnId === turnId) : [];
  return { ...vision, records, summary: records.length ? summarizeVisionRecords(records) : null };
}
function visionUnavailable(value: unknown) {
  const vision = object(value), summary = object(vision.summary);
  if (!Object.keys(vision).length || vision.method === "not_measured") return true;
  const records = Array.isArray(vision.records) ? vision.records.map(object) : [];
  const observedFrames = records.some(record => ["validFrameCount", "gazeValidFrameCount", "smileValidFrameCount", "browDownValidFrameCount"].some(key => typeof record[key] === "number" && Number.isFinite(record[key]) && (record[key] as number) > 0));
  const observedSummary = ["gazeOffFrameRatio", "gazeOffTimeRatio", "smileObservedFrameRatio", "browDownObservedFrameRatio"].some(key => typeof summary[key] === "number" && Number.isFinite(summary[key]));
  return !observedFrames && !observedSummary;
}

/** Exact surface repetitions are observations, never automatic judgments of poor speaking. */
export function observeTranscriptRepetitions(turnId: string, rawTranscript: string): LanguageCandidate[] {
  const candidates: LanguageCandidate[] = [];
  const groups = (kind: LanguageCandidateKind, pattern: RegExp, omit?: RegExp) => {
    const bySurface = new Map<string, Span[]>();
    for (const match of rawTranscript.matchAll(pattern)) {
      const surface = match[0];
      if (omit?.test(surface)) continue;
      const span = { start: match.index, end: match.index + surface.length, surface };
      bySurface.set(surface, [...bySurface.get(surface) ?? [], span]);
    }
    const repeated = [...bySurface].filter(([, spans]) => spans.length >= 2).sort((a, b) => b[1].length - a[1].length || a[1][0].start - b[1][0].start).slice(0, 8);
    for (const [surface, spans] of repeated) candidates.push({ id: `${turnId}:${kind}:${spans[0].start}:${spans[0].end}`, turnId, kind, surface, spans, observedCount: spans.length });
  };
  groups("repeated_vocabulary", /(?<![\p{L}\p{N}])[\p{L}\p{N}]{2,}(?![\p{L}\p{N}])/gu, /^(?:어+|음+|저기|약간|이제|그래서|그리고|그런데|하지만|합니다|했습니다|하였습니다|있습니다|없습니다|됩니다|같습니다|생각합니다)$/u);
  groups("repeated_ending", /(?:라고\s*생각합니다|것\s*같습니다|것\s*같아요|생각합니다|생각해요|하였습니다|했습니다|합니다|됩니다|있습니다|없습니다|거든요|잖아요|같습니다)(?=\s*(?:[.!?。]|$))/gu);
  return candidates;
}

export function buildEvaluationObservations(session: InterviewSession) {
  const sessionMetrics = object(session.metrics);
  return {
    answers: session.turns.map(turn => {
      const raw = turn.rawTranscript ?? "";
      const metrics = object(turn.metrics), speech = object(metrics.speech);
      const vision = visionForAnswer(metrics, sessionMetrics, turn.id);
      const durationMs = positiveDuration(speech.durationMs);
      const habits = raw.trim() ? observeSpeechHabits(turn.answerId ?? turn.id, raw, durationMs ?? 0) : null;
      const languageCandidates: LanguageCandidate[] = [
        ...habits?.occurrences.filter(item => item.classification === "context_candidate").slice(0, 16).map(item => ({ id: item.id, turnId: turn.id, kind: "context_filler" as const, surface: item.surface, spans: [{ start: item.start, end: item.end, surface: item.surface }], observedCount: 1 })) ?? [],
        ...observeTranscriptRepetitions(turn.id, raw),
      ];
      return {
        turnId: turn.id, answerId: turn.answerId ?? null, transcriptStatus: turn.transcriptStatus ?? null,
        finalized: turn.transcriptStatus === "finalized", transcriptObserved: Boolean(raw.trim()),
        speech: metrics.speech ?? null, vision,
        clientTimings: turn.metadata.clientTimings ?? metrics.clientTimings ?? null, providerTimings: turn.metadata.providerTimings ?? null,
        sttObservations: turn.sttObservations ?? null, habits, languageCandidates, durationMs,
        unavailable: {
          speechTiming: durationMs === null,
          vad: typeof speech.speakingMs !== "number" || !Number.isFinite(speech.speakingMs),
          vision: visionUnavailable(vision),
          providerConfidence: !turn.sttObservations?.some(item => item.confidence !== null && Number.isFinite(item.confidence)),
          wordTimestamps: true,
        },
      };
    }),
    sessionMetrics: session.metrics ?? null,
    scope: "전사 원문에서 관찰한 표면어·종결 표현만 센다. 문맥상 반복 습관 여부는 별도이며 원음 전체 횟수·감정·인성·진실성을 뜻하지 않는다.",
  };
}
export type EvaluationObservations = ReturnType<typeof buildEvaluationObservations>;

/** Model labels may classify existing spans; they cannot invent an occurrence, count or timestamp. */
export function finalizeLanguageObservations(observations: EvaluationObservations, classifications: LanguageClassification[]) {
  const byId = new Map(observations.answers.flatMap(answer => answer.languageCandidates.map(candidate => [candidate.id, candidate] as const)));
  const verified = new Map<string, LanguageClassification>();
  for (const classification of classifications) {
    const candidate = byId.get(classification.candidateId);
    const allowed = candidate?.kind === "context_filler" ? ["filler", "meaningful", "uncertain"] : ["habit_candidate", "meaningful", "topic_required", "uncertain"];
    if (!candidate || candidate.turnId !== classification.turnId || verified.has(candidate.id) || !allowed.includes(classification.classification)) throw new Error("언어습관 보조 분류가 관찰된 원문 구간과 일치하지 않습니다.");
    verified.set(candidate.id, classification);
  }
  return observations.answers.map(answer => {
    const candidates = answer.languageCandidates.map(candidate => ({ ...candidate, classification: verified.get(candidate.id)?.classification ?? "uncertain", reason: verified.get(candidate.id)?.reason ?? "문맥상 습관 여부를 확정하지 않았습니다." }));
    const additionalFillers = candidates.filter(candidate => candidate.kind === "context_filler" && candidate.classification === "filler").reduce((sum, candidate) => sum + candidate.spans.length, 0);
    const confirmedFillerCount = answer.habits === null ? null : answer.habits.confirmedCount + additionalFillers;
    return {
      ...answer, languageCandidates: candidates, confirmedFillerCount,
      confirmedFillersPerMinute: confirmedFillerCount !== null && answer.durationMs !== null ? confirmedFillerCount * 60000 / answer.durationMs : null,
      // A repeated topic word is not automatically added to the filler count.
      repeatedVocabulary: candidates.filter(candidate => candidate.kind === "repeated_vocabulary"),
      repeatedEndings: candidates.filter(candidate => candidate.kind === "repeated_ending"),
    };
  });
}
