/** Offline only. Do not import this module into an interview request handler. */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { verifyFollowupLatencyEvidence } from './followup-latency-gate';

export const SEMANTIC_GATE_VERSION = 'followup-semantic-release-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1);
const action = z.enum(['FOLLOW_UP', 'CLARIFICATION', 'REPLAY', 'TRANSITION', 'CLOSING', 'CONTINUE_ANSWER']);
const verdict = z.enum(['pass', 'fail', 'unresolved']);
const model = z.object({ requestedModel: text, responseModel: text, reasoningEffort: z.enum(['none', 'low', 'medium', 'high']), maxOutputTokens: z.number().int().positive() }).strict();
export const semanticModelConfigSchema = z.object({ policyMode: z.enum(['compiled', 'full']), core: model, factReview: model, surfaceRepair: model }).strict();
export type SemanticModelConfig = z.infer<typeof semanticModelConfigSchema>;
const artifactFile = z.object({ path: text, sha256: digest }).strict();
export const semanticIdentitySchema = z.object({
  schemaVersion: z.literal(1), gateVersion: z.literal(SEMANTIC_GATE_VERSION), purpose: z.enum(['release', 'fixture']),
  releaseKey: digest, engineSources: z.record(z.string(), digest), supportSources: z.record(z.string(), digest),
  promptSha256: digest, contractSha256: digest, policySha256: digest, inputProjectionSha256: digest,
  gold: artifactFile, rubric: artifactFile, rubricContentSha256: digest, modelConfigFile: artifactFile, policyFiles: z.array(artifactFile).min(1),
  modelConfig: semanticModelConfigSchema,
}).strict();
export type SemanticReleaseIdentity = z.infer<typeof semanticIdentitySchema>;
export const semanticRubricSchema = z.object({
  schemaVersion: z.literal(1), version: text, requiredCoverage: z.array(text),
  acceptedReviewProvenance: z.array(z.enum(['human', 'model'])).min(1).default(['human']),
  cases: z.array(z.object({
    caseId: text, repeats: z.number().int().positive().default(1), required: z.boolean().default(true), coverage: z.array(text),
    expectedActions: z.array(action).min(1), expectedCoverage: z.array(z.enum(['met', 'partial', 'unknown'])).optional(),
    expectedResponse: z.array(z.enum(['answered', 'unavailable', 'unrelated', 'unclear'])).optional(),
    followUpScope: z.string().nullable().optional(),
  }).strict()).min(1),
}).strict();
export type SemanticRubric = z.infer<typeof semanticRubricSchema>;
const modelObservation = z.object({ stage: z.enum(['core', 'review', 'repair']), requestedModel: text, responseModel: text,
  reasoningEffort: z.enum(['none', 'low', 'medium', 'high']).optional(), maxOutputTokens: z.number().int().positive().optional() }).strict();
export const semanticOutcomeSchema = z.object({
  caseId: text, repeat: z.number().int().positive(), phase: z.enum(['candidate-only', 'final-runtime', 'delivered']),
  inputSha256: digest, historySha256: digest, coreDecisionSha256: digest,
  finalQuestionSha256: digest.nullable(), factualReviewSha256: digest.nullable(),
  surfaceOrigin: z.enum(['core', 'repair', 'restatement', 'none']), executedAction: action,
  coverage: z.enum(['met', 'partial', 'unknown']).nullable(), response: z.enum(['answered', 'unavailable', 'unrelated', 'unclear']).nullable(),
  executionReady: z.boolean(), structuralChecksPassed: z.boolean(), models: z.array(modelObservation),
  reportSha256: digest, sourcePointer: text, outcomeSha256: digest,
}).strict();
export type SemanticOutcome = z.infer<typeof semanticOutcomeSchema>;
export interface GateDiagnostic { code: string; caseKey?: string; detail: string }
export interface SemanticCandidate {
  schemaVersion: 1; identity: SemanticReleaseIdentity; rubric: SemanticRubric; reports: Array<{ path: string; sha256: string }>;
  outcomes: SemanticOutcome[]; diagnostics: GateDiagnostic[];
}
const semanticReviewChecksSchema = z.object({
  demandRelation: verdict, answeredScopePreserved: verdict,
  usefulSingleSubpoint: z.union([verdict, z.literal('not-applicable')]),
  refusalNegationCorrectionPreserved: verdict,
  repairedMeaningPreserved: z.union([verdict, z.literal('not-applicable')]), historyConsistency: verdict,
}).strict();
export const semanticReviewSchema = z.object({
  releaseKey: digest, outcomeSha256: digest, rubricSha256: digest,
  provenance: z.enum(['human', 'model', 'unreviewed']), reviewer: text, reviewedAt: z.string().datetime({ offset: true }),
  checks: semanticReviewChecksSchema, note: text,
}).strict();
export type SemanticReview = z.infer<typeof semanticReviewSchema>;
export const semanticReviewsSchema = z.object({ schemaVersion: z.literal(1), reviews: z.array(semanticReviewSchema) }).strict();

export function semanticHash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
/** Object order is normalized; exact strings (including utterances) are never normalized. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value); if (serialized === undefined) throw new Error('SEMANTIC_NON_JSON_VALUE'); return serialized;
  }
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const object = value as Record<string, unknown>;
  return '{' + Object.keys(object).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(object[key])).join(',') + '}';
}
const hashObject = (value: unknown) => semanticHash(canonicalJson(value));
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const rows = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.map(object) : [];
const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const caseKey = (value: Pick<SemanticOutcome, 'caseId' | 'repeat'>) => `${value.caseId}:${value.repeat}`;
function identityKey(identity: Omit<SemanticReleaseIdentity, 'releaseKey'> | SemanticReleaseIdentity) {
  const { releaseKey: _ignored, ...body } = identity as SemanticReleaseIdentity; void _ignored; return hashObject(body);
}
export function assertSemanticIdentity(value: unknown): SemanticReleaseIdentity {
  const identity = semanticIdentitySchema.parse(value);
  if (identity.releaseKey !== identityKey(identity)) throw new Error('SEMANTIC_RELEASE_KEY_MISMATCH');
  return identity;
}
export function hashSemanticOutcome(value: Omit<SemanticOutcome, 'outcomeSha256'> | SemanticOutcome): string {
  const { outcomeSha256: _ignored, ...body } = value as SemanticOutcome; void _ignored; return hashObject(body);
}

const relativeFile = (root: string, file: string) => {
  const absolute = path.resolve(root, file), relative = path.relative(path.resolve(root), absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('SEMANTIC_FILE_OUTSIDE_WORKSPACE');
  return relative.replace(/\\/gu, '/');
};
async function fileDigest(root: string, file: string) { const relative = relativeFile(root, file); return { path: relative, sha256: semanticHash(await readFile(path.join(root, relative))) }; }
export async function semanticEngineSources(root: string): Promise<Record<string, string>> {
  const entries = await readdir(path.join(root, 'server'), { recursive: true });
  const files = ['interview.config.ts', ...entries.filter(file => file.endsWith('.ts')).map(file => 'server/' + file.replace(/\\/gu, '/'))].sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [file, semanticHash(await readFile(path.join(root, file)))])));
}
export async function createSemanticIdentity(root: string, options: { gold: string; rubric: string; modelConfig: string; policies: string[]; purpose?: 'release' | 'fixture' }): Promise<SemanticReleaseIdentity> {
  if (!options.policies.length) throw new Error('SEMANTIC_POLICY_ARTIFACT_REQUIRED');
  const [engineSources, gold, rubric, modelConfigFile, policyFiles] = await Promise.all([
    semanticEngineSources(root), fileDigest(root, options.gold), fileDigest(root, options.rubric), fileDigest(root, options.modelConfig), Promise.all(options.policies.map(file => fileDigest(root, file))),
  ]);
  const modelConfig = semanticModelConfigSchema.parse(JSON.parse(await readFile(path.join(root, modelConfigFile.path), 'utf8')));
  const parsedRubric = semanticRubricSchema.parse(JSON.parse(await readFile(path.join(root, rubric.path), 'utf8')));
  const support = ['interview-files.mjs', 'package-lock.json', 'scripts/lib/semantic-release-gate.ts', 'scripts/lib/followup-latency-gate.ts', 'scripts/verify-semantic-release.ts',
    'scripts/evaluate-historical-dialogue-gold.ts', 'scripts/replay-actual-user-core.ts', 'scripts/replay-gold-surface-repairs.ts', 'scripts/live-demand-boundary-e2e.ts',
    'scripts/benchmark-latest-interview.ts', 'scripts/verify-followup-final-runtime.ts'];
  const supportSources = Object.fromEntries(await Promise.all(support.map(async file => [file, semanticHash(await readFile(path.join(root, file)))])));
  const select = (files: string[]) => files.map(file => { const sha256 = engineSources[file]; if (!sha256) throw new Error('SEMANTIC_SOURCE_REQUIRED:' + file); return { path: file, sha256 }; });
  const policySources = Object.entries(engineSources).filter(([file]) => file.startsWith('server/policy/')).map(([file, sha256]) => ({ path: file, sha256 }));
  const body: Omit<SemanticReleaseIdentity, 'releaseKey'> = {
    schemaVersion: 1 as const, gateVersion: SEMANTIC_GATE_VERSION, purpose: options.purpose ?? 'release', engineSources, supportSources,
    promptSha256: hashObject(select(['server/providers/single-core-contract.ts', 'server/policy/compiled-runtime-policy.ts', 'server/policy/full-md-policy.ts'])),
    contractSha256: engineSources['server/providers/single-core-contract.ts'], policySha256: hashObject({ policyFiles, policySources }),
    inputProjectionSha256: hashObject(select(['server/providers/runtime-core-payload.ts', 'server/providers/runtime-core-scope.ts'])),
    gold, rubric, rubricContentSha256: hashObject(parsedRubric), modelConfigFile, policyFiles, modelConfig,
  };
  return assertSemanticIdentity({ ...body, releaseKey: identityKey(body) });
}
/** Called by offline replay runners before spending on an explicitly requested run. */
export async function assertSemanticIdentityWorkspace(root: string, value: unknown): Promise<SemanticReleaseIdentity> {
  const identity = assertSemanticIdentity(value);
  const actual = await createSemanticIdentity(root, { gold: identity.gold.path, rubric: identity.rubric.path, modelConfig: identity.modelConfigFile.path, policies: identity.policyFiles.map(file => file.path), purpose: identity.purpose });
  if (actual.releaseKey !== identity.releaseKey) throw new Error('SEMANTIC_WORKSPACE_CHANGED');
  return identity;
}
export async function loadOfflineSemanticBinding(args: string[], root = process.cwd()): Promise<SemanticReleaseIdentity | null> {
  const option = args.find(arg => arg.startsWith('--semantic-identity='));
  if (!option) return null;
  const file = relativeFile(root, option.slice('--semantic-identity='.length));
  return assertSemanticIdentityWorkspace(root, JSON.parse(await readFile(path.join(root, file), 'utf8')));
}

export interface SemanticReportSource { path: string; sha256: string; value: unknown; bytes?: string | Buffer }
export function semanticReportSource(file: string, bytes: string | Buffer): SemanticReportSource {
  return { path: file, sha256: semanticHash(bytes), value: JSON.parse(bytes.toString()), bytes };
}
function observedModels(value: unknown): SemanticOutcome['models'] {
  const observations: SemanticOutcome['models'] = [];
  for (const entry of rows(value)) {
    const observation = object(entry.observation ?? entry), stage = entry.stage;
    if ((stage === 'core' || stage === 'review' || stage === 'repair') && typeof observation.requestedModel === 'string' && typeof observation.responseModel === 'string')
      observations.push({ stage, requestedModel: observation.requestedModel, responseModel: observation.responseModel,
        ...(observation.requestedReasoningEffort ?? observation.reasoningEffort ? { reasoningEffort: observation.requestedReasoningEffort ?? observation.reasoningEffort } : {}),
        ...(observation.requestedMaxOutputTokens ?? observation.maxOutputTokens ? { maxOutputTokens: observation.requestedMaxOutputTokens ?? observation.maxOutputTokens } : {}) });
  }
  return observations;
}
function finalSurfaceOrigin(value: unknown): SemanticOutcome['surfaceOrigin'] {
  return value === 'bounded_surface_repair' || value === 'repair' ? 'repair' : value === 'approved_restatement' || value === 'restatement' ? 'restatement' : value === 'core' ? 'core' : 'none';
}
function fromLegacyCase(row: Record<string, any>, report: Record<string, any>, source: SemanticReportSource, index: number, inherited?: Record<string, any>): SemanticOutcome {
  const result = object(row.result), decision = object(result.semanticDecision ?? row.newDecision), next = object(decision.next), assessment = object(decision.assessment);
  const execution = object(result.execution ?? row.execution), draft = object(result.draft), previous = inherited ?? {};
  const textValue = draft.questionText;
  const phase = row.newDecision && !row.result ? 'candidate-only' : 'final-runtime';
  const finalText = typeof textValue === 'string' ? textValue : null;
  const answerSha256 = row.sourceAnswerSha256 ?? row.answerSha256;
  const answer = row.rawTranscript ?? row.syntheticAnswer;
  const questionSha256 = row.sourceQuestionSha256 ?? (typeof row.question === 'string' ? semanticHash(row.question) : null);
  const inputSha256 = isDigest(row.inputSha256) ? row.inputSha256 : isDigest(answerSha256) && questionSha256 ? hashObject({ questionSha256, answerSha256, questionContractSha256: row.questionContractSha256 ?? null })
    : typeof answer === 'string' && questionSha256 ? hashObject({ questionSha256, answerSha256: semanticHash(answer), questionContractSha256: row.questionContractSha256 ?? null }) : previous.inputSha256;
  const historySha256 = row.historicalPrefixSha256 ?? row.priorSha256 ?? previous.historySha256;
  const executedAction = execution.action ?? result.nextAction ?? next.action;
  const body = {
    caseId: String(row.variantId ?? row.id ?? row.caseId ?? report.variantId ?? ''), repeat: row.repeat ?? 1, phase,
    inputSha256: isDigest(inputSha256) ? inputSha256 : '',
    historySha256: isDigest(historySha256) ? historySha256 : Object.hasOwn(row, 'history') ? hashObject(row.history) : '',
    coreDecisionSha256: Object.keys(decision).length ? hashObject(decision) : row.originalCoreDecisionSha256 ?? '',
    finalQuestionSha256: finalText === null ? null : semanticHash(finalText),
    factualReviewSha256: draft.premiseValidation ? hashObject(draft.premiseValidation) : null,
    surfaceOrigin: finalSurfaceOrigin(execution.surfaceOrigin ?? (finalText ? 'core' : 'none')),
    executedAction, coverage: assessment.coverage ?? null, response: assessment.response ?? null,
    executionReady: execution.status === 'ready',
    structuralChecksPassed: !row.failure && !result.failureDetail && (row.labelCheck?.structuralLabelsPassed ?? (row.rubric ? row.rubric.actionInExpectedSet && row.rubric.coverageInExpectedSet && row.rubric.responseInExpectedSet : true)),
    models: observedModels(row.providerUsage ?? result.providerUsage), reportSha256: source.sha256, sourcePointer: `/cases/${index}`,
  };
  return semanticOutcomeSchema.parse({ ...body, outcomeSha256: hashSemanticOutcome(body as Omit<SemanticOutcome, 'outcomeSha256'>) });
}
function fromDelivered(row: Record<string, any>, source: SemanticReportSource, index: number, history: Record<string, any>[]): SemanticOutcome {
  const core = object(row.coreDecision), decision = object(core.semanticDecision), assessment = object(decision.assessment), execution = object(core.execution);
  const event = rows(row.events).find(event => event.type === 'turn_ready'), turn = object(event?.turn), proof = object(row.deliveredProof);
  const originalAction = execution.action ?? core.nextAction ?? object(decision.next).action;
  const asks = originalAction === 'FOLLOW_UP' || originalAction === 'CLARIFICATION' || originalAction === 'REPLAY';
  const questionText = asks && typeof turn.questionText === 'string' ? turn.questionText : null;
  const body = {
    caseId: String(row.caseId ?? row.turnId ?? ''), repeat: row.repeat ?? 1, phase: 'delivered' as const,
    inputSha256: typeof row.rawTranscript === 'string' && typeof row.question === 'string' ? hashObject({ question: row.question, answer: row.rawTranscript }) : '',
    historySha256: isDigest(row.historySha256) ? row.historySha256 : hashObject(history),
    coreDecisionSha256: Object.keys(decision).length ? hashObject(decision) : '', finalQuestionSha256: questionText === null ? null : semanticHash(questionText),
    factualReviewSha256: asks && isDigest(proof.premiseValidationSha256) ? proof.premiseValidationSha256 : null,
    surfaceOrigin: finalSurfaceOrigin(execution.surfaceOrigin ?? (questionText ? 'core' : 'none')),
    executedAction: originalAction, coverage: assessment.coverage ?? null, response: assessment.response ?? null,
    executionReady: row.responseStatus >= 200 && row.responseStatus < 300 && Boolean(event),
    structuralChecksPassed: row.rawAndAnswerIdPreserved === true && (!asks || proof.questionSha256 === semanticHash(questionText ?? '') && proof.turnId === turn.id && proof.validationStatus === 'approved'),
    models: observedModels(core.providerUsage), reportSha256: source.sha256, sourcePointer: `/advances/${index}`,
  };
  return semanticOutcomeSchema.parse({ ...body, outcomeSha256: hashSemanticOutcome(body) });
}

/** Existing reports can be inspected without a binding, but cannot silently gain release approval. */
export function collectSemanticCandidate(identityValue: unknown, rubricValue: unknown, reports: SemanticReportSource[]): SemanticCandidate {
  const identity = assertSemanticIdentity(identityValue), rubric = semanticRubricSchema.parse(rubricValue);
  if (hashObject(rubric) !== identity.rubricContentSha256) throw new Error('SEMANTIC_RUBRIC_CHANGED');
  const diagnostics: GateDiagnostic[] = [], outcomes: SemanticOutcome[] = [];
  if (new Set(rubric.cases.map(row => row.caseId)).size !== rubric.cases.length) throw new Error('SEMANTIC_DUPLICATE_RUBRIC_CASE');
  for (const source of reports) {
    if (!isDigest(source.sha256)) throw new Error('SEMANTIC_REPORT_HASH_INVALID');
    const report = object(source.value), binding = object(report.semanticReleaseIdentity);
    if (binding.releaseKey !== identity.releaseKey && report.releaseKey !== identity.releaseKey)
      diagnostics.push({ code: 'REPORT_RELEASE_UNBOUND', detail: source.path });
    if (report.engineSourceSha256 && hashObject(report.engineSourceSha256) !== hashObject(identity.engineSources))
      diagnostics.push({ code: 'REPORT_ENGINE_CHANGED', detail: source.path });
    if (report.engineSourceUnchanged === false) diagnostics.push({ code: 'REPORT_ENGINE_CHANGED_DURING_RUN', detail: source.path });
    if (report.coreReasoningEffort && report.coreReasoningEffort !== identity.modelConfig.core.reasoningEffort)
      diagnostics.push({ code: 'REPORT_REASONING_CONFIG_CHANGED', detail: source.path });
    if (report.version === 'semantic-release-report-v1') {
      for (const [index, raw] of rows(report.outcomes).entries()) {
        try {
          const body: Record<string, any> = { ...raw, reportSha256: source.sha256, sourcePointer: `/outcomes/${index}` }; delete body.outcomeSha256;
          const outcome = semanticOutcomeSchema.parse({ ...body, outcomeSha256: hashSemanticOutcome(body as Omit<SemanticOutcome, 'outcomeSha256'>) }); outcomes.push(outcome);
        } catch { diagnostics.push({ code: 'REPORT_OUTCOME_INVALID', detail: source.path + `#/outcomes/${index}` }); }
      }
      continue;
    }
    for (const [index, row] of rows(report.cases).entries()) {
      try {
        let inherited: Record<string, any> | undefined;
        if (row.originalCoreDecisionSha256 && report.sourceSha256 && !(row.answerSha256 && row.priorSha256 && row.question)) {
          const original = reports.find(item => item.sha256 === report.sourceSha256), originalReport = object(original?.value);
          const originalIndex = rows(originalReport.cases).findIndex(item => (item.variantId ?? item.id ?? item.caseId) === report.variantId);
          if (original && originalIndex >= 0) inherited = fromLegacyCase(rows(originalReport.cases)[originalIndex], originalReport, original, originalIndex);
          const originalDecision = originalIndex >= 0 ? object(rows(originalReport.cases)[originalIndex].result).semanticDecision : null;
          if (!inherited || !originalDecision || semanticHash(JSON.stringify(originalDecision)) !== row.originalCoreDecisionSha256) throw new Error('REPAIR_SOURCE_CHANGED');
        }
        outcomes.push(fromLegacyCase(row, report, source, index, inherited));
      } catch { diagnostics.push({ code: 'REPORT_OUTCOME_INCOMPLETE', detail: source.path + `#/cases/${index}` }); }
    }
    for (const [index, row] of rows(report.advances).entries()) {
      try { outcomes.push(fromDelivered(row, source, index, rows(report.advances).slice(0, index))); }
      catch { diagnostics.push({ code: 'REPORT_DELIVERED_OUTCOME_INCOMPLETE', detail: source.path + `#/advances/${index}` }); }
    }
  }
  return { schemaVersion: 1, identity, rubric, reports: reports.map(({ path, sha256 }) => ({ path, sha256 })), outcomes, diagnostics };
}

export interface SemanticReleaseReceipt {
  schemaVersion: 1; gateVersion: typeof SEMANTIC_GATE_VERSION; releaseKey: string; purpose: 'release' | 'fixture';
  semanticStatus: 'pass' | 'fail' | 'incomplete'; latencyStatus: 'pass' | 'fail' | 'not-provided' | 'unbound'; releaseStatus: 'pass' | 'fail' | 'incomplete';
  candidateSha256: string; reviewsSha256: string; latencyReceiptSha256: string | null; outcomeHashes: string[];
  covered: string[]; requiredCoverage: string[]; diagnostics: GateDiagnostic[];
  scope: { offlineOnly: true; newRuntimeCalls: 0; sampleEvidenceOnly: true; humanIdentityNotCryptographicallyVerified: true };
  receiptSha256: string;
}
/** Pure verifier: no files, network, provider SDK, runtime policy loading or model calls. */
export function verifySemanticRelease(candidateValue: SemanticCandidate, reviewsValue: unknown, options: {
  sourceReports?: SemanticReportSource[]; latencyReceipt?: unknown; latencyEvidence?: { before: unknown; after: unknown };
} = {}): SemanticReleaseReceipt {
  const identity = assertSemanticIdentity(candidateValue.identity), rubric = semanticRubricSchema.parse(candidateValue.rubric);
  if (hashObject(rubric) !== identity.rubricContentSha256) throw new Error('SEMANTIC_RUBRIC_CHANGED');
  const reviews = semanticReviewsSchema.parse(reviewsValue), diagnostics: GateDiagnostic[] = [...candidateValue.diagnostics];
  let failed = false, incomplete = diagnostics.length > 0;
  const add = (code: string, key: string, detail: string, failure = false) => { diagnostics.push({ code, caseKey: key, detail }); if (failure) failed = true; else incomplete = true; };
  const outcomes = candidateValue.outcomes.map(value => semanticOutcomeSchema.parse(value));
  if (!options.sourceReports) {
    add('SOURCE_REPORTS_REQUIRED', '', 'Verification must reload the pinned report bytes and recollect outcomes.');
  } else {
    try {
      const actualSources = options.sourceReports.map(source => {
        if (source.bytes === undefined || semanticHash(source.bytes) !== source.sha256) throw new Error('REPORT_RAW_BYTES_CHANGED');
        const parsed = semanticReportSource(source.path, source.bytes);
        if (canonicalJson(parsed.value) !== canonicalJson(source.value)) throw new Error('REPORT_PARSED_VALUE_CHANGED');
        return parsed;
      });
      const recollected = collectSemanticCandidate(identity, rubric, actualSources);
      if (canonicalJson(recollected) !== canonicalJson(candidateValue)) add('CANDIDATE_RECOLLECTION_MISMATCH', '', 'Candidate fields/diagnostics differ from the pinned raw reports.', true);
    } catch (error) { add('SOURCE_REPORT_VERIFICATION_FAILED', '', error instanceof Error ? error.message : 'Report verification failed.', true); }
  }
  const covered = new Set<string>(), seen = new Set<string>();
  for (const planned of rubric.cases) for (let repeat = 1; repeat <= planned.repeats; repeat++) {
    const key = caseKey({ caseId: planned.caseId, repeat }), matching = outcomes.filter(item => caseKey(item) === key);
    if (!matching.length) { if (planned.required) add('CASE_MISSING', key, 'Planned case/repeat has no observed outcome.'); continue; }
    if (matching.length !== 1) { add('CASE_DUPLICATE', key, 'Collect one final outcome for each planned repeat.'); continue; }
    const outcome = matching[0]; seen.add(key);
    if (!candidateValue.reports.some(report => report.sha256 === outcome.reportSha256)) { add('OUTCOME_REPORT_NOT_BOUND', key, 'Outcome is not bound to a collected report.', true); continue; }
    if (outcome.outcomeSha256 !== hashSemanticOutcome(outcome)) { add('OUTCOME_HASH_CHANGED', key, 'Outcome fields changed after collection.', true); continue; }
    if (outcome.phase === 'candidate-only') { add('FINAL_EXECUTION_NOT_OBSERVED', key, 'A candidate-only decision cannot approve final speech.'); continue; }
    if (!outcome.executionReady || !outcome.structuralChecksPassed) add('EXECUTION_CHECK_FAILED', key, 'Execution/structural checks failed.', true);
    const asks = outcome.executedAction === 'FOLLOW_UP' || outcome.executedAction === 'CLARIFICATION';
    if (asks && (!outcome.finalQuestionSha256 || !outcome.factualReviewSha256)) add('FINAL_SURFACE_OR_REVIEW_MISSING', key, 'Final question and factual approval must be bound.');
    if (!asks && outcome.executedAction !== 'REPLAY' && outcome.finalQuestionSha256 !== null) add('NON_QUESTION_HAS_UTTERANCE', key, 'Do not bind a next Q0 as this decision\'s follow-up.', true);
    if (!planned.expectedActions.includes(outcome.executedAction)) add('ACTION_OUTSIDE_GOLD', key, outcome.executedAction, true);
    if (planned.expectedCoverage && (!outcome.coverage || !planned.expectedCoverage.includes(outcome.coverage))) add('COVERAGE_OUTSIDE_GOLD', key, String(outcome.coverage), true);
    if (planned.expectedResponse && (!outcome.response || !planned.expectedResponse.includes(outcome.response))) add('RESPONSE_OUTSIDE_GOLD', key, String(outcome.response), true);
    const requiredStages = ['core', ...(asks && outcome.surfaceOrigin !== 'restatement' ? ['review'] : []), ...(outcome.surfaceOrigin === 'repair' ? ['repair'] : [])];
    for (const stage of requiredStages) {
      const configured = stage === 'core' ? identity.modelConfig.core : stage === 'review' ? identity.modelConfig.factReview : identity.modelConfig.surfaceRepair;
      const observations = outcome.models.filter(item => item.stage === stage);
      if (!observations.length) add('MODEL_OBSERVATION_MISSING', key, stage);
      else if (observations.some(item => item.requestedModel !== configured.requestedModel || item.responseModel !== configured.responseModel)) add('MODEL_CHANGED', key, stage, true);
      if (observations.some(item => item.reasoningEffort === undefined || item.maxOutputTokens === undefined)) add('MODEL_REQUEST_CONFIG_UNOBSERVED', key, stage);
      else if (observations.some(item => item.reasoningEffort !== configured.reasoningEffort || item.maxOutputTokens !== configured.maxOutputTokens)) add('MODEL_REQUEST_CONFIG_CHANGED', key, stage, true);
    }
    const matchingReviews = reviews.reviews.filter(review => review.releaseKey === identity.releaseKey && review.rubricSha256 === identity.rubric.sha256 && review.outcomeSha256 === outcome.outcomeSha256);
    if (matchingReviews.length !== 1) { add('REVIEW_MISSING_OR_DUPLICATE', key, 'Require exactly one review bound to this release/rubric/outcome.'); continue; }
    const review = matchingReviews[0];
    if (!rubric.acceptedReviewProvenance.some(provenance => provenance === review.provenance)) { add('REVIEW_AUTHORITY_NOT_ACCEPTED', key, review.provenance); continue; }
    const values = Object.values(review.checks);
    if (values.includes('fail')) { add('SEMANTIC_REVIEW_FAILED', key, review.note, true); continue; }
    if (values.includes('unresolved')) { add('SEMANTIC_REVIEW_UNRESOLVED', key, review.note); continue; }
    if (outcome.executedAction === 'FOLLOW_UP' && review.checks.usefulSingleSubpoint !== 'pass') { add('FOLLOWUP_SCOPE_NOT_APPROVED', key, 'F requires usefulSingleSubpoint pass.'); continue; }
    if (outcome.surfaceOrigin === 'repair' && review.checks.repairedMeaningPreserved !== 'pass') { add('REPAIRED_MEANING_NOT_APPROVED', key, 'The final repaired utterance needs meaning-preservation review.'); continue; }
    planned.coverage.forEach(category => covered.add(category));
  }
  for (const outcome of outcomes) if (!seen.has(caseKey(outcome))) add('UNPLANNED_OUTCOME', caseKey(outcome), 'Outcome must be represented in the frozen rubric.');
  for (const category of rubric.requiredCoverage) if (!covered.has(category)) add('REQUIRED_COVERAGE_MISSING', category, 'Only reviewed planned outcomes cover a category.');
  const semanticStatus = failed ? 'fail' : incomplete ? 'incomplete' : 'pass';
  const latency = object(options.latencyReceipt);
  const latencyStatus = options.latencyReceipt === undefined || options.latencyEvidence === undefined ? 'not-provided' : latency.releaseKey !== identity.releaseKey ? 'unbound' : verifyFollowupLatencyEvidence(options.latencyReceipt, options.latencyEvidence.before, options.latencyEvidence.after, identity.releaseKey) ? 'pass' : 'fail';
  const releaseStatus = semanticStatus === 'fail' || latencyStatus === 'fail' ? 'fail' : semanticStatus === 'pass' && latencyStatus === 'pass' && identity.purpose === 'release' ? 'pass' : 'incomplete';
  const body: Omit<SemanticReleaseReceipt, 'receiptSha256'> = {
    schemaVersion: 1 as const, gateVersion: SEMANTIC_GATE_VERSION, releaseKey: identity.releaseKey, purpose: identity.purpose,
    semanticStatus, latencyStatus, releaseStatus, candidateSha256: hashObject(candidateValue), reviewsSha256: hashObject(reviews),
    latencyReceiptSha256: options.latencyReceipt === undefined ? null : hashObject(options.latencyReceipt),
    outcomeHashes: outcomes.map(item => item.outcomeSha256).sort(), covered: [...covered].sort(), requiredCoverage: [...rubric.requiredCoverage].sort(), diagnostics,
    scope: { offlineOnly: true as const, newRuntimeCalls: 0 as const, sampleEvidenceOnly: true as const, humanIdentityNotCryptographicallyVerified: true as const },
  };
  return { ...body, receiptSha256: hashObject(body) };
}
