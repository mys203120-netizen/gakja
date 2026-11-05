import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { estimateProviderCost, type ProviderUsageObservation } from '../server/observability/provider-cost';
import { maskConversationSecrets } from '../server/storage/conversation-log';
import { replayHash } from './live-e2e-replay';

type Data = Record<string, any>;
const identity = (item: Data) => `${item.baselinePath}:${item.originalAnswerSha256}`;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, min: sorted[0] ?? null,
    median: sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null,
    mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    max: sorted.at(-1) ?? null };
}
function resultSummary(item: Data) {
  const result = item.result ?? {};
  const observations: Data[] = item.providerUsage ?? [];
  const requests = observations.map(({ stage, observation }) => ({ stage, observation,
    estimatedCost: estimateProviderCost(observation as ProviderUsageObservation) }));
  const byStage: Data = {};
  for (const request of requests) {
    const stage = byStage[request.stage] ??= { requests: 0, completeUsageRequests: 0, inputTokens: 0,
      outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
      reasoningBreakdownKnownRequests: 0, reasoningTokenCount: 0, nonReasoningOutputTokenCount: 0,
      knownEstimatedUsd: 0, unknownCostRequests: 0 };
    stage.requests++;
    const usage = request.observation?.usage;
    if (request.observation?.validity === 'complete' && usage) {
      stage.completeUsageRequests++;
      stage.inputTokens += usage.input_tokens; stage.outputTokens += usage.output_tokens;
      stage.cachedInputTokens += usage.input_tokens_details.cached_tokens;
      stage.cacheWriteInputTokens += usage.input_tokens_details.cache_write_tokens ?? 0;
      const reasoning = usage.output_tokens_details?.reasoning_tokens;
      if (finite(reasoning)) {
        stage.reasoningBreakdownKnownRequests++; stage.reasoningTokenCount += reasoning;
        stage.nonReasoningOutputTokenCount += usage.output_tokens - reasoning;
      }
    }
    if (finite(request.estimatedCost.usd)) stage.knownEstimatedUsd += request.estimatedCost.usd;
    else stage.unknownCostRequests++;
  }
  const failure = item.failure ?? (result.execution?.status === 'blocked' || result.questionRecoveryRequired ||
    result.providerUnavailable || result.origin === 'fallback' ? result.failureDetail ?? 'EXECUTION_BLOCKED' :
    result.execution?.status === 'ready' ? null : result.failureDetail ?? null);
  return { success: item.checkpointValid === true && Boolean(item.result) && !failure, failure,
    engineVersion: result.engineVersion ?? null, nextAction: result.nextAction ?? null,
    interactionAction: result.execution?.action ?? (result.clarificationMode === 'repeat_audio' ? 'REPLAY' : result.nextAction ?? null),
    fulfillment: result.fulfillment ?? null, origin: result.origin ?? null,
    decisionReasonCode: result.decisionReasonCode ?? null,
    clarificationMode: result.clarificationMode ?? null,
    question: result.draft?.questionText ?? null, reaction: result.reaction?.reply ?? null,
    semanticDecision: result.semanticDecision ?? null, execution: result.execution ?? null,
    recoveredRejection: !failure ? result.failureDetail ?? null : null,
    factReviewTraces: result.factReviewTraces ?? [],
    interpretation: result.interpretation ?? null, answerRelation: result.answerRelation ?? null,
    serverGuards: result.serverGuards ?? [], providerTimings: result.providerTimings ?? {},
    checkpointWallMs: finite(item.wallMs) ? item.wallMs : null, requests, byStage };
}

/** Strict input pairing only. Semantic quality is reviewed from the exact output,
 * never inferred from an action label or runtime success. */
export function compareCoreCheckpoints(before: Data, after: Data) {
  if (!before.live || !after.live || !before.completedAt || !after.completedAt) throw new Error('CONTROLLED_LIVE_REPORT_INCOMPLETE');
  if (before.bankIdentity !== after.bankIdentity || before.bankContentSha256 !== after.bankContentSha256) throw new Error('CONTROLLED_BANK_CHANGED');
  if (before.sourceFilesModified !== false || after.sourceFilesModified !== false || before.originalSessionSaved !== false || after.originalSessionSaved !== false) throw new Error('CONTROLLED_SOURCE_SESSION_CHANGED');
  if (before.engineSourceUnchanged === false || after.engineSourceUnchanged === false) throw new Error('CONTROLLED_ENGINE_CHANGED_DURING_RUN');
  if (!Array.isArray(before.cases) || !Array.isArray(after.cases) || before.cases.length !== after.cases.length || !before.cases.length) throw new Error('CONTROLLED_CASE_SET_CHANGED');
  if (before.frozenInputManifest && after.frozenInputManifest && before.frozenInputManifest.sha256 !== after.frozenInputManifest.sha256) throw new Error('CONTROLLED_FROZEN_MANIFEST_CHANGED');
  if (before.checkpointConstruction !== after.checkpointConstruction) throw new Error('CONTROLLED_CHECKPOINT_CONSTRUCTION_CHANGED');
  const afterByIdentity = new Map<string, Data>(after.cases.map((item: Data) => [identity(item), item]));
  if (new Set(before.cases.map(identity)).size !== before.cases.length || afterByIdentity.size !== after.cases.length) throw new Error('CONTROLLED_DUPLICATE_CASE');
  const pairs = before.cases.map((old: Data, index: number) => {
    const next = afterByIdentity.get(identity(old));
    if (!next) throw new Error('CONTROLLED_CASE_IDENTITY_CHANGED');
    for (const field of ['baselineSha256', 'observedSessionId', 'observedSessionSha256', 'question', 'questionKind',
      'rawTranscript', 'rawTranscriptSha256', 'prefixTurnCount', 'currentTurnId', 'currentAnswerId']) {
      if (old[field] !== next[field]) throw new Error(`CONTROLLED_INPUT_CHANGED_${field}`);
    }
    if (old.checkpointSessionId !== next.checkpointSessionId) throw new Error('CONTROLLED_RETRIEVAL_SEED_CHANGED');
    if (!old.originalSessionUnchanged || !next.originalSessionUnchanged || JSON.stringify(old.options) !== JSON.stringify(next.options)) throw new Error('CONTROLLED_CHECKPOINT_CHANGED');
    return { caseId: next.caseId ?? `case-${index}`, baselinePath: old.baselinePath,
      sourceIndex: next.sourceIndex ?? null, answerScenario: next.answerScenario ?? null,
      originalAnswerSha256: old.originalAnswerSha256, question: old.question,
      rawTranscript: old.rawTranscript, rawTranscriptSha256: old.rawTranscriptSha256,
      identicalQuestionTranscriptAndHistoricalPrefix: true, before: resultSummary(old), after: resultSummary(next) };
  });
  const summarize = (side: 'before' | 'after') => {
    const results = pairs.map((pair: Data) => pair[side]);
    const stages: Data = {};
    for (const result of results) for (const [name, counts] of Object.entries(result.byStage) as Array<[string, Data]>) {
      const stage = stages[name] ??= {};
      for (const [field, value] of Object.entries(counts)) stage[field] = (stage[field] ?? 0) + value;
    }
    return { cases: results.length, runtimeSuccesses: results.filter((r: Data) => r.success).length,
      runtimeFailures: results.filter((r: Data) => !r.success).length, byStage: stages,
      checkpointWallMsAllCases: distribution(results.map((r: Data) => r.checkpointWallMs).filter(finite)),
      realtimeTurnMsAllCases: distribution(results.map((r: Data) => r.providerTimings.realtimeTurnMs).filter(finite)),
      coreRequestMsModelCases: distribution(results.filter((r: Data) => r.providerTimings.coreModelCalls > 0).map((r: Data) => r.providerTimings.coreRequestMs).filter(finite)),
      reviewMsCasesWithReview: distribution(results.filter((r: Data) => r.providerTimings.premiseReviewAttempts > 0).map((r: Data) => r.providerTimings.premiseReviewMs).filter(finite)) };
  };
  const successfulPairs = pairs.filter((pair: Data) => pair.before.success && pair.after.success);
  return { scope: 'Controlled voice-free independent historical checkpoints; exact original question, transcript and historical prefix. Not continuous HTTP/WS/STT/TTS, browser or human-microphone E2E.',
    limitations: ['One observed run per engine; sample size, provider variability and cache state prevent causal speed or SLA claims.',
      'Runtime success and action equality do not establish semantic or utterance quality. Review exact outputs.',
      'Known cost sums exclude unknown prices/usage; request-level unknown reasons are retained. Public estimates are not invoices.',
      'Historical earlier-turn metadata remains the same observed baseline in both engines; each checkpoint is independent.'],
    bankIdentity: before.bankIdentity, bankContentSha256: before.bankContentSha256,
    requestedConfigurations: { before: { engineMode: before.engineMode ?? null, coreReasoningEffort: before.requestedCoreReasoningEffort ?? null,
      coreOutputTokenBudget: before.requestedCoreOutputTokenBudget ?? null },
    after: { engineMode: after.engineMode ?? null, coreReasoningEffort: after.requestedCoreReasoningEffort ?? null,
      coreOutputTokenBudget: after.requestedCoreOutputTokenBudget ?? null } },
    before: summarize('before'), after: summarize('after'),
    pairedRuntimeSuccesses: successfulPairs.length,
    successfulPairCheckpointWallMs: { before: distribution(successfulPairs.map((pair: Data) => pair.before.checkpointWallMs).filter(finite)),
      after: distribution(successfulPairs.map((pair: Data) => pair.after.checkpointWallMs).filter(finite)) },
    pairs };
}

async function main() {
  const args = process.argv.slice(2);
  const paths = ['--before=', '--after=', '--out='].map(prefix => args.find(arg => arg.startsWith(prefix))?.slice(prefix.length));
  if (paths.some(file => !file || !/^artifacts\/[a-zA-Z0-9-]+\.json$/u.test(file))) throw new Error('CONTROLLED_COMPARISON_PATH_INVALID');
  const [beforePath, afterPath, output] = paths as string[];
  if (await access(output).then(() => true, () => false)) throw new Error('CONTROLLED_COMPARISON_OUTPUT_ALREADY_EXISTS');
  const [beforeText, afterText] = await Promise.all([readFile(beforePath, 'utf8'), readFile(afterPath, 'utf8')]);
  const comparison = compareCoreCheckpoints(JSON.parse(beforeText), JSON.parse(afterText));
  const report = { generatedAt: new Date().toISOString(), sources: { before: { path: beforePath, sha256: replayHash(beforeText) },
    after: { path: afterPath, sha256: replayHash(afterText) } }, ...comparison };
  await writeFile(output, JSON.stringify(maskConversationSecrets(report), null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ output, cases: comparison.pairs.length, pairedRuntimeSuccesses: comparison.pairedRuntimeSuccesses,
    beforeRuntimeFailures: comparison.before.runtimeFailures, afterRuntimeFailures: comparison.after.runtimeFailures }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
