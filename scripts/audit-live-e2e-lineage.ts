import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { buildEvaluationUnits } from '../server/providers/evaluation-turns';
import type { InterviewSession } from '../server/protocol';
import { maskConversationSecrets } from '../server/storage/conversation-log';
import { replayHash } from './live-e2e-replay';

type Data = Record<string, any>;
const started = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value;
const equal = (a: unknown, b: unknown) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));

/** Structural audit of actual saved state. No text-based demand classifier. */
export function auditLiveLineage(report: Data, durable: InterviewSession, endJournalCount: number) {
  const issues: string[] = [], units = buildEvaluationUnits(durable);
  const turns = new Map(durable.turns.map(turn => [turn.id, turn]));
  const evaluation = durable.evaluation && typeof durable.evaluation === 'object' && !Array.isArray(durable.evaluation)
    ? durable.evaluation as Data : undefined;
  if (durable.evaluationStatus === 'completed' && !Array.isArray(evaluation?.answers)) issues.push('DURABLE_EVALUATION_SHAPE_INVALID');
  const recordedEvaluation = report.finalSession?.evaluation;
  const evaluationEssentialFieldMatches = Object.fromEntries(['answers', 'unscoredAnswers', 'clusterScores', 'sessionScore',
    'overallWeightedScore', 'aggregation', 'partialReport', 'summary'].map(key => [key, equal(recordedEvaluation?.[key], evaluation?.[key])]));
  const recordedEvaluationMatchesAfterStandardRedaction = equal(recordedEvaluation, maskConversationSecrets(evaluation));
  if (!Object.values(evaluationEssentialFieldMatches).every(Boolean)) issues.push('DURABLE_EVALUATION_ESSENTIAL_FIELDS_MISMATCH');
  if (!recordedEvaluationMatchesAfterStandardRedaction) issues.push('DURABLE_EVALUATION_REPORT_MISMATCH_AFTER_REDACTION');
  const scored = new Set(units.scoredUnits.map(unit => unit.turn.id));
  let attempts503 = 0, retries = 0, quoteCount = 0;
  const decisions: Data[] = [];
  for (const row of report.turns) {
    const turn = turns.get(row.turnId);
    if (!row.capture || !turn || turn.answerId !== row.capture.answerId || turn.rawTranscript !== row.capture.rawTranscript || turn.transcriptStatus !== 'finalized') issues.push(`ANSWER_NOT_PRESERVED:${row.index}`);
    const core = turn?.metadata.coreDecision as Data | undefined;
    if (core && (core.sourceTurnId !== row.turnId || core.sourceAnswerId !== row.capture?.answerId)) issues.push(`CORE_SOURCE_ID_CHANGED:${row.index}`);
    if ((row.explicitRetryCount ?? 0) > 1) issues.push(`RETRY_LIMIT_EXCEEDED:${row.index}`);
    retries += row.explicitRetryCount ?? 0;
    for (const attempt of [row.firstFailedResponse, row.response].filter(Boolean)) if (attempt.status === 503) attempts503++;
    if (row.firstFailedDecision && (row.firstFailedDecision.sourceTurnId !== row.turnId || row.firstFailedDecision.sourceAnswerId !== row.capture.answerId)) issues.push(`FAILED_RETRY_SOURCE_CHANGED:${row.index}`);
    const next = turns.get(row.next?.turnId), action = core?.execution?.action;
    if (action === 'CLARIFICATION' || action === 'REPLAY') {
      if (next && next.questionKind !== 'clarification') issues.push(`SAME_DEMAND_WRONG_PRESENTED_KIND:${row.index}`);
      if (next && scored.has(next.id)) issues.push(`SAME_DEMAND_HAS_INDEPENDENT_UNIT:${row.index}`);
      if (action === 'REPLAY' && next && (next.questionText !== turn?.questionText || next.questionAudioUrl !== turn?.questionAudioUrl)) issues.push(`REPLAY_AUDIO_OR_TEXT_CHANGED:${row.index}`);
    }
    if (action === 'FOLLOW_UP' && next && next.questionKind !== 'follow_up') issues.push(`NEW_SUBPOINT_WRONG_PRESENTED_KIND:${row.index}`);
    decisions.push({ index: row.index, sourceTurnId: row.turnId, sourceAnswerId: row.capture?.answerId,
      coreAction: core?.semanticDecision?.next.action ?? null, executedAction: action ?? null,
      actualDirective: core?.actualDirective ?? null, nextTurnId: next?.id ?? null, nextQuestionKind: next?.questionKind ?? null,
      nextClarificationMode: next?.metadata.clarificationMode ?? null, explicitRetries: row.explicitRetryCount ?? 0 });
  }
  for (const turn of durable.turns) if (turn.questionKind === 'clarification' || turn.metadata.nonEvaluative) {
    if (scored.has(turn.id) || evaluation?.answers?.some((answer: Data) => answer.turnId === turn.id)) issues.push(`CLARIFICATION_SCORED_SEPARATELY:${turn.id}`);
    if (turn.answerId && !units.units.some(unit => unit.answerAttempts.some(a => a.sourceTurnId === turn.id && a.answerId === turn.answerId))) issues.push(`CLARIFICATION_ANSWER_LINEAGE_MISSING:${turn.id}`);
  }
  for (const answer of evaluation?.answers ?? []) {
    const unit = units.scoredUnits.find(item => item.turn.id === answer.turnId);
    if (!unit) { issues.push(`EVALUATION_UNIT_UNKNOWN:${answer.turnId}`); continue; }
    for (const [axis, observation] of Object.entries(answer.axes ?? {}) as Array<[string, Data]>) {
      if (typeof observation.quote !== 'string' || !observation.quote.trim()) continue;
      quoteCount++; const binding = answer.quoteSources?.[axis], source = turns.get(binding?.sourceTurnId);
      if (!binding || !source || source.answerId !== binding.answerId || source.rawTranscript?.slice(binding.start, binding.end) !== observation.quote ||
        !unit.answerAttempts.some(attempt => attempt.sourceTurnId === source.id && attempt.answerId === source.answerId)) issues.push(`EVALUATION_QUOTE_NOT_BOUND:${answer.turnId}:${axis}`);
    }
    if (JSON.stringify(answer.answerAttemptTurnIds) !== JSON.stringify(unit.answerAttempts.map(attempt => attempt.sourceTurnId))) issues.push(`EVALUATION_ATTEMPT_IDS_CHANGED:${answer.turnId}`);
  }
  const clusterWeights: Data[] = [];
  for (const cluster of evaluation?.clusterScores ?? []) {
    const presentedF = new Set((durable.questionPresentations ?? []).filter(p => p.rootTurnId === cluster.rootTurnId && p.questionKind === 'follow_up' &&
      (started(p.startedAtMs) || started(p.completedAtMs))).map(p => p.turnId));
    for (const member of cluster.members) {
      const turn = turns.get(member.turnId);
      if (!turn || turn.questionKind === 'clarification' || turn.metadata.nonEvaluative || turn.questionKind !== member.questionKind) issues.push(`CLUSTER_MEMBER_KIND_INVALID:${member.turnId}`);
      if (member.questionKind === 'follow_up' && !presentedF.has(member.turnId)) issues.push(`UNPRESENTED_F_WEIGHTED:${member.turnId}`);
      const expected = presentedF.size > 2 ? null : member.questionKind === 'main' ? presentedF.size ? 0.7 : 1 : presentedF.size === 1 ? 0.3 : 0.15;
      if (member.weight !== expected) issues.push(`MD_WEIGHT_MISMATCH:${member.turnId}`);
    }
    clusterWeights.push({ rootTurnId: cluster.rootTurnId, status: cluster.status, presentedFollowUps: presentedF.size,
      members: cluster.members.map((member: Data) => ({ turnId: member.turnId, kind: member.questionKind, weight: member.weight, score: member.score })) });
  }
  if (endJournalCount !== 1) issues.push(`END_JOURNAL_COUNT:${endJournalCount}`);
  const captured = report.turns.filter((row: Data) => row.capture), finalReady = captured.filter((row: Data) => row.response?.status === 200).length;
  return { sessionId: durable.id, integrityPass: issues.length === 0, issues, finalizedAnswers: captured.length,
    finalReadyAnswers: finalReady, observed503Attempts: attempts503, explicitRetries: retries,
    retryPathExercised: attempts503 > 0, endJournalCount,
    evaluationStatus: durable.evaluationStatus, evaluationDurable: durable.evaluationStatus === 'completed' && Boolean(evaluation),
    recordedEvaluationMatchesDurable: replayHash(JSON.stringify(report.finalSession?.evaluation ?? null)) === replayHash(JSON.stringify(evaluation ?? null)),
    recordedEvaluationMatchesAfterStandardRedaction, evaluationEssentialFieldMatches,
    storageComparisonNote: 'The report is redacted; generic *Tokens aggregate objects and key/semanticKey/poolKey identifiers may differ from the unredacted durable file. Essential scores/answers and the entire identically redacted evaluation must match.',
    capturedAnswersReady: finalReady === captured.length,
    runtimePass: finalReady === captured.length && durable.evaluationStatus === 'completed' && report.endedThroughApi === true &&
      (!report.replay || report.replay.allOriginalAnswersReady === true),
    matchedFrozenInputs: captured.filter((row: Data) => row.capture.exactReplayInput).length,
    adaptiveSupplements: captured.filter((row: Data) => row.adaptiveSupplement).length,
    allOriginalAnswersReady: report.replay?.allOriginalAnswersReady ?? null,
    independentScoredUnitIds: [...scored], checkedNonNullAxisQuotes: quoteCount, decisions, clusterWeights,
    limits: ['Presentation events and client clock are synthetic simulations; no actual browser playback or human microphone observed.',
      'Quote offsets and structural weights are checked; semantic scoring rationales and question purpose still need manual review.',
      'Zero observed503 means the retry path was not exercised in this batch; earlier failure/recovery evidence remains separate.'] };
}

async function main() {
  dotenv.config({ path: '.env.local', quiet: true });
  const args = process.argv.slice(2), output = args.find(a => a.startsWith('--out='))?.slice(6);
  if (!output || !/^artifacts\/[a-zA-Z0-9-]+\.json$/u.test(output)) throw new Error('LINEAGE_OUTPUT_PATH_INVALID');
  if (await access(output).then(() => true, () => false)) throw new Error('LINEAGE_OUTPUT_ALREADY_EXISTS');
  const sources = args.filter(a => !a.startsWith('--')), runs = [];
  for (const source of sources) {
    const reportText = await readFile(source, 'utf8'), report: Data = JSON.parse(reportText);
    const durablePath = `data/sessions/${report.sessionId}.json`, durableText = await readFile(durablePath, 'utf8');
    const logs = (await readFile(report.logPath, 'utf8')).split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
    runs.push({ source, sourceSha256: replayHash(reportText), durablePath, durableSha256: replayHash(durableText),
      ...auditLiveLineage(report, JSON.parse(durableText), logs.filter(row => row.type === 'session.ended').length) });
  }
  await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(), runs }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, runs: runs.map(run => ({ sessionId: run.sessionId, integrityPass: run.integrityPass, runtimePass: run.runtimePass, issues: run.issues })) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
