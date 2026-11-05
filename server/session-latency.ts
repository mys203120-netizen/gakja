import type { InterviewSession } from "./protocol";

function distribution(values: number[]) {
  const sorted = values.filter(value => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
  return { samples: sorted.length, p50Ms: percentile(.5), p95Ms: percentile(.95) };
}

/** Durations share a clock within each observation; never subtract server and browser timestamps. */
export function summarizeSessionLatency(session: Pick<InterviewSession, "turns"> & Partial<Pick<InterviewSession, "metrics" | "runtime">>) {
  const providers = ["sttFinalizeMs", "reactionMs", "coreMs", "realtimeTurnMs", "llmMs", "questionGenerationMs", "premiseReviewMs", "questionTtsMs", "acknowledgementTtsMs", "prepareMs", "ackReadyMs", "questionReadyMs"];
  const result: Record<string, ReturnType<typeof distribution>> = {};
  const warmup: Record<string, ReturnType<typeof distribution>> = {};
  for (const key of providers) result[key] = distribution(session.turns.flatMap(turn => {
    // A consumed first-question cache keeps its original provider timings, not an in-session wait.
    if (key !== "sttFinalizeMs" && turn.metadata.providerTimings?.preparedCacheHit === 1) return [];
    const value = turn.metadata.providerTimings?.[key]; return typeof value === "number" ? [value] : [];
  }));
  for (const key of providers.filter(key => key !== "sttFinalizeMs")) warmup[key] = distribution(session.turns.flatMap(turn => {
    const value = turn.metadata.providerTimings?.[key]; return turn.metadata.providerTimings?.preparedCacheHit === 1 && typeof value === "number" ? [value] : [];
  }));
  for (const [name, from, to] of [["submitToFinalTranscriptMs", "submittedAt", "finalizedAt"], ["submitToAcknowledgementMs", "submittedAt", "acknowledgementStarted"], ["submitToQuestionMs", "submittedAt", "questionStarted"]]) {
    result[name] = distribution(session.turns.flatMap(turn => {
      const timings = turn.metadata.clientTimings;
      return timings && typeof timings[from] === "number" && typeof timings[to] === "number" && timings[to] >= timings[from] ? [timings[to] - timings[from]] : [];
    }));
  }
  result.submitToFirstPlaybackMs = distribution(session.turns.flatMap(turn => {
    const times = turn.metadata.clientTimings, from = times?.submittedAt;
    if (typeof from !== 'number' || !Number.isFinite(from)) return [];
    const starts = [times?.acknowledgementStarted, times?.questionStarted].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= from);
    return starts.length ? [Math.min(...starts) - from] : [];
  }));
  const attempts = Object.values(session.runtime?.submissionAttempts ?? {});
  const waitingOutcomes = { recordedAttempts: attempts.length, expiredAttempts: attempts.filter(row => row.status === 'expired').length,
    cancelledAttempts: attempts.filter(row => row.status === 'cancelled').length, completedAttempts: attempts.filter(row => row.status === 'completed').length,
    runningAttempts: attempts.filter(row => row.status === 'running').length };
  const object = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const playback = object(object(session.metrics).questionPlaybackTimingsByTurn);
  result.acknowledgementEndToQuestionMs = distribution(session.turns.slice(0, -1).flatMap((turn, index) => {
    const transition = turn.metadata.clientTimings ?? {}, nextPlayback = object(playback[session.turns[index + 1].id]);
    const timings = typeof transition.acknowledgementEnded === "number" ? transition : nextPlayback;
    const from = timings.acknowledgementEnded, to = timings.questionStarted;
    return typeof from === "number" && typeof to === "number" && Number.isFinite(from) && Number.isFinite(to) && to >= from ? [to - from] : [];
  }));
  const decisions = session.turns.flatMap(turn => {
    const decision = object(turn.metadata.coreDecision), timings = object(decision.providerTimings);
    return decision.sourceTurnId === turn.id && decision.sourceAnswerId === turn.answerId ? [timings] : [];
  });
  const totals = Object.fromEntries(['coreModelCalls', 'premiseReviewAttempts', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'reviewInputTokens', 'reviewOutputTokens', 'reviewCachedInputTokens'].map(key => {
    const values = decisions.flatMap(timing => typeof timing[key] === 'number' && Number.isFinite(timing[key]) && timing[key] >= 0 ? [timing[key] as number] : []);
    return [key, { observedTurns: values.length, total: values.length ? values.reduce((a, b) => a + b, 0) : null }];
  }));
  return { version: "turn-latency-v3", units: "milliseconds", measured: result, warmup, waitingOutcomes, coreUsage: { scope: 'bound-live-core-decisions-only; core/review tokens separately observed; offline preparation excluded', totals, estimatedMonetaryCost: null }, note: "면접 시작 전 준비는 warmup으로 분리합니다. 제출→첫 native playing·질문 시작은 같은 브라우저 시각이며 실제 스피커 청취를 측정하지 않습니다. 백분위는 관찰 표본만 포함하고 만료·취소 제출은 waitingOutcomes에 별도 집계하며 미관찰 값은 null입니다." };
}
