import dotenv from 'dotenv';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ResponseCreateParamsNonStreaming, ResponseFormatTextConfig } from 'openai/resources/responses/responses';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession } from '../server/protocol';
import { safeProviderError } from '../server/protocol';
import type { RealtimeCoreRequest } from '../server/providers/realtime-core';
import type { SingleCoreDecision } from '../server/providers/single-core-contract';
import { normalizeProviderUsage, estimateProviderCost, aggregateProviderCosts } from '../server/observability/provider-cost';

export const LATEST_HUMAN_SESSION = '8f54631b-d1ce-404a-97ba-17394fd111b9';
const sourcePath = `data/sessions/${LATEST_HUMAN_SESSION}.json`;
const journalPath = `data/conversation-logs/${LATEST_HUMAN_SESSION}.jsonl`;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
type CoreModule = typeof import('../server/providers/single-core-runtime');
type ContractModule = typeof import('../server/providers/single-core-contract');
type RuntimeModule = typeof import('../server/session-runtime');
type PlanModule = typeof import('../server/interview-planner');
type ProtocolModule = typeof import('../server/protocol');
interface JournalRow { seq: number; type: string; timestamp: string; turnId?: string; answerId?: string; payload?: Record<string, unknown> }
interface Expected { actions: SingleCoreDecision['next']['action'][]; coverage?: string[]; note: string; critical?: boolean }
// Labels describe admissible progress actions only. Semantic fidelity of the
// actual follow-up/reaction still requires reading the exact Q/A and candidate.
export const latestHumanLabels: Record<number, Expected> = {
  1: { actions: ['CLARIFICATION', 'FOLLOW_UP'], note: '무기한 타당성 주장과 원래 범위 요구를 구분하고 전체 요구를 F로 반복하지 않는다.' },
  2: { actions: ['TRANSITION', 'CLARIFICATION'], note: '알파 범위를 이해했다고 지어내지 않고 재진술 예산을 지킨다.' },
  3: { actions: ['TRANSITION', 'FOLLOW_UP'], coverage: ['met'], note: '벡터 성분화에 관심을 보였다는 답은 관심 주제 요구를 충족한다. 새 원리 설명을 소급하지 않는다.' },
  4: { actions: ['TRANSITION'], note: '비교 조건을 기억하지 못한다는 범위를 수용한다.' },
  5: { actions: ['CLARIFICATION', 'TRANSITION'], note: '어렵다는 표현을 무조건 기억 상실로 바꾸지 않는다.' },
  6: { actions: ['CLARIFICATION', 'FOLLOW_UP'], note: '소변 냄새 설명을 검증된 에너지 설명으로 승인하지 않으며 취지를 재안내하거나 실제 주장 한 지점을 확인한다.', critical: true },
  7: { actions: ['TRANSITION', 'CLARIFICATION'], note: '꼬리질문이 없는 이유를 묻는 대화 요청을 내용 답변으로 평가하지 않는다.' },
  8: { actions: ['CLARIFICATION'], note: '무엇을 제안했는지 기억 맥락 요청에 승인 기록의 짧은 맥락을 제시한다. 같은 문장만 읽으면 실패다.', critical: true },
  9: { actions: ['TRANSITION'], note: '쉬운 설명을 못 받았다는 지적을 수용하며 같은 질문을 또 읽지 않는다.' },
  10: { actions: ['CLARIFICATION', 'TRANSITION', 'FOLLOW_UP'], note: '단순 반복인지 실제 수행 설명인지 읽고 새 F라면 구체적인 미답 지점을 구분한다.' },
  11: { actions: ['TRANSITION', 'FOLLOW_UP'], coverage: ['met'], note: '무응답 제외 후 유효 응답 평균이라는 방법을 제공했다. 다른 방법 요구를 소급하지 않는다.', critical: true },
  12: { actions: ['CLARIFICATION'], note: '머리 담당이라는 모호한 역할을 같은 요구의 뜻풀이로 확인한다.', critical: true },
  13: { actions: ['TRANSITION', 'CLARIFICATION'], note: '브레인이라는 완결된 짧은 답이 구체적이지 않아도 열린 문장으로 만들지 않는다.', critical: true },
  14: { actions: ['FOLLOW_UP', 'TRANSITION'], coverage: ['partial'], note: '폭·적중 가능성의 함정은 이미 설명했다. F라면 실제 미답인 표본 크기→폭 변화 관계 한 점만 묻는다. 폭과 불확실성의 전체 설명을 다시 요구하면 라벨이 F여도 실패다. 더 확실하다고 주장했다고 만들지 않는다.', critical: true },
  15: { actions: ['TRANSITION', 'FOLLOW_UP'], coverage: ['met'], note: '범위와 적중 가능성의 관계를 실제 예로 설명했다. 기본은 전환이며 같은 판단 근거를 다시 요구하면 실패다. F는 실제 새 확인 실익과 기답 범위와의 차이가 문장에 있어야 한다.', critical: true },
  16: { actions: ['TRANSITION'], note: '그만 묻고 넘어가라는 요청과 수학을 모른다는 범위를 수용한다.' },
  17: { actions: ['CLARIFICATION'], note: '노력했다는 말로는 역할이 구체화되지 않았다. 전체 역할 재요구는 F가 아닌 재진술이다.', critical: true },
  18: { actions: ['TRANSITION', 'FOLLOW_UP'], coverage: ['met'], note: '전체 설계와 기록 조언을 본인이 한 일로 수용한다.' },
  19: { actions: ['TRANSITION', 'FOLLOW_UP'], coverage: ['met'], note: '진로 조사·교사 상담·안내 흐름을 설명했다. 추가 F는 이미 제공한 과정 반복이 아니어야 한다.' },
  20: { actions: ['TRANSITION', 'FOLLOW_UP'], coverage: ['met'], note: '접속·입력·제출이라는 수집 절차를 답했다. 다시 동일 절차를 요구하지 않는다.' },
  21: { actions: ['CLARIFICATION', 'TRANSITION'], note: '정치 구호를 환경 캠페인 답으로 수용하지 않는다. 남은 시간/재진술 예산이 허용하면 취지 재안내, 전환이면 이유를 짧게 표현한다.', critical: true },
  22: { actions: ['REPLAY', 'CLOSING'], note: '재청취 요청을 새 평가 질문으로 만들지 않고 종료 시간과 실행을 일치시킨다.' },
};

interface CapturedCase { id: string; number: number; captureRevision?: number; turnId: string; answerId: string; question: string; rawTranscript: string;
  questionSha256: string; transcriptSha256: string; endingObservation: unknown; elapsedMs: number; expected: Expected;
  request: RealtimeCoreRequest; requestSha256: string; oldDecision: unknown; policyTrace?: unknown }
interface Capture { version: 'latest-human-frozen-requests-v1'; label: string; createdAt: string; sourcePath: string; sourceSha256: string;
  journalPath: string; journalSha256: string; contextManifestSha256: string; moduleRoot: string; engineVersion: string; contractVersion: string;
  schema: Record<string, unknown>; cases: CapturedCase[]; sourceRecordsModified: false; providerCalls: 0 }

/** Reconstruct only delivered F rows visible in this historical prefix. The
 * final session counter includes later answers and is not checkpoint input. */
export function visibleFollowUpCounts(session: Pick<InterviewSession, 'turns' | 'questionPresentations'>) {
  const visible = new Map(session.turns.map(turn => [turn.id, turn]));
  const delivered = session.questionPresentations === undefined
    ? session.turns.filter(turn => turn.questionKind === 'follow_up')
    : [...new Set(session.questionPresentations.filter(item => item.startedAtMs !== null && item.questionKind === 'follow_up' && visible.has(item.turnId)).map(item => item.turnId))]
      .map(id => visible.get(id)!).filter(turn => turn.questionKind === 'follow_up');
  const counts: Record<string, number> = {};
  for (const turn of delivered) counts[turn.parentMainQuestionId] = (counts[turn.parentMainQuestionId] ?? 0) + 1;
  return counts;
}
async function writeNew(file: string, value: unknown) {
  const resolved = path.resolve(file), relative = path.relative(process.cwd(), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !/^(?:artifacts|\.local)[/\\]/u.test(relative)) throw new Error('BENCHMARK_OUTPUT_OUTSIDE_WORKSPACE');
  await mkdir(path.dirname(resolved), { recursive: true });
  const handle = await open(resolved, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2)); } finally { await handle.close(); }
}

export async function captureLatestRequests(moduleRoot: string, label: string, options: {
  onCheckpoint?: (context: InterviewContext, session: InterviewSession, number: number, captureRevision?: number) => Promise<void>;
} = {}): Promise<Capture> {
  const sourceBytes = await readFile(sourcePath), journalBytes = await readFile(journalPath);
  const original = JSON.parse(sourceBytes.toString('utf8')) as InterviewSession;
  const journal = journalBytes.toString('utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line) as JournalRow);
  if (original.id !== LATEST_HUMAN_SESSION || original.turns.length !== 22 || original.runtime?.owner.id !== 'local-development-owner') throw new Error('LATEST_HUMAN_SOURCE_INVALID');
  const load = async <T>(relative: string) => await import(pathToFileURL(path.resolve(moduleRoot, relative)).href) as T;
  const [core, contract, runtime, planner, protocol] = await Promise.all([
    load<CoreModule>('server/providers/single-core-runtime.ts'), load<ContractModule>('server/providers/single-core-contract.ts'),
    load<RuntimeModule>('server/session-runtime.ts'), load<PlanModule>('server/interview-planner.ts'), load<ProtocolModule>('server/protocol.ts'),
  ]);
  const { loadInterviewContext } = await import('../server/data/load-interview-context');
  const context: InterviewContext = await loadInterviewContext();
  if (context.errors.length) throw new Error('LATEST_BENCHMARK_CONTEXT_INVALID:' + context.errors.join('|'));
  const historicalPdf = (original.sourceManifest as InterviewContext['manifest']).files.find(file => file.role === 'studentPdf')?.sha256;
  if (!historicalPdf || historicalPdf !== context.manifest.files.find(file => file.role === 'studentPdf')?.sha256) throw new Error('LATEST_BENCHMARK_PDF_CHANGED');
  const cases: CapturedCase[] = [];
  const capture = async (number: number, rawTranscript: string, endingObservation: unknown, captureRevision?: number) => {
    const index = number - 1, source = original.turns[index];
    const checkpoint = structuredClone(original);
    checkpoint.turns = checkpoint.turns.slice(0, number); checkpoint.status = 'active'; checkpoint.evaluationStatus = 'pending';
    checkpoint.sourceManifest = structuredClone(context.manifest);
    const timing = journal.find(row => row.turnId === source.id && row.type === 'answer.metrics');
    const elapsed = typeof timing?.payload?.elapsedMs === 'number' ? timing.payload.elapsedMs : original.elapsedMs;
    checkpoint.elapsedMs = elapsed;
    checkpoint.runtime = runtime.createSessionRuntime(context, { id: 'synthetic-latest-frozen-benchmark', mode: 'local-development' });
    delete checkpoint.evaluation; delete checkpoint.evaluationError; delete checkpoint.providerUsageLedger; delete checkpoint.conversationLedger;
    const visible = new Set(checkpoint.turns.map(turn => turn.id));
    checkpoint.questionPresentations = checkpoint.questionPresentations?.filter(item => visible.has(item.turnId));
    checkpoint.questionPresentationEventIds = [];
    checkpoint.followUpCountByMainQuestion = visibleFollowUpCounts(checkpoint);
    if (checkpoint.plan?.selectionContext) delete checkpoint.plan.selectionContext.lastSelection;
    checkpoint.metrics = { verification: { syntheticFrozenHumanReplay: true, voiceFree: true, sourceRecordsModified: false } };
    const current = checkpoint.turns.at(-1)!;
    current.rawTranscript = rawTranscript;
    current.transcriptStatus = 'finalized';
    delete current.metadata.coreDecision; delete current.metadata.answerReaction; delete current.metadata.answerContext;
    delete current.metadata.answerCandidateId; delete current.metadata.answerCommitStatus;
    if (endingObservation) current.metadata.answerEndingObservation = endingObservation as typeof current.metadata.answerEndingObservation;
    else delete current.metadata.answerEndingObservation;
    await options.onCheckpoint?.(context, structuredClone(checkpoint), number, captureRevision);
    let request: RealtimeCoreRequest | undefined;
    const neutral: SingleCoreDecision = { assessment: { coverage: 'unknown', response: 'answered', reason: '출력 입력만 캡처하는 무호출 어댑터' }, next: { action: 'TRANSITION', question: null }, reaction: null };
    const result = await core.runSingleCoreRuntime(context, checkpoint, { candidateOnly: true, policyMode: 'compiled', coreReasoningEffort: 'low',
      allowFollowUp: planner.mayAskFollowUp(checkpoint, checkpoint.durationSeconds ?? 720, 2),
      allowClarification: protocol.mayAskClarification(checkpoint, checkpoint.durationSeconds ?? 720),
      allowReplay: protocol.mayReplayQuestion(checkpoint, checkpoint.durationSeconds ?? 720),
      requestSingleCore: async input => { request = structuredClone(input); return contract.encodeSingleCoreCandidateResponse(neutral); },
    });
    if (!request) throw new Error(`LATEST_REQUEST_NOT_CAPTURED:Q${number}:${result.failureDetail ?? 'no_detail'}`);
    const expected = latestHumanLabels[number];
    cases.push({ id: `Q${number}${captureRevision ? `-capture${captureRevision}` : ''}`, number, captureRevision, turnId: current.id, answerId: current.answerId!,
      question: current.questionText, rawTranscript, questionSha256: hash(current.questionText), transcriptSha256: hash(rawTranscript),
      endingObservation, elapsedMs: elapsed, expected, request, requestSha256: hash(JSON.stringify(request)), oldDecision: source.metadata.coreDecision ?? null, policyTrace: result.policyTrace });
  };
  for (let index = 0; index < original.turns.length; index++) await capture(index + 1, original.turns[index].rawTranscript ?? '', original.turns[index].metadata.answerEndingObservation ?? null);
  const continued = journal.filter(row => row.type === 'answer.candidate_decision' && row.turnId === original.turns[12].id && (row.payload?.decision as { kind?: string } | undefined)?.kind === 'CONTINUE');
  for (const row of continued) {
    const exact = journal.filter(item => item.seq < row.seq && item.turnId === row.turnId && item.type === 'stt.final').at(-1)?.payload?.rawTranscript;
    if (typeof exact !== 'string' || hash(exact) !== row.payload?.sourceTranscriptSha256) throw new Error('LATEST_CONTINUED_CAPTURE_SOURCE_MISMATCH');
    await capture(13, exact, row.payload?.endingObservation, Number(row.payload?.captureRevision));
  }
  if (hash(await readFile(sourcePath)) !== hash(sourceBytes) || hash(await readFile(journalPath)) !== hash(journalBytes)) throw new Error('LATEST_SOURCE_CHANGED_DURING_CAPTURE');
  return { version: 'latest-human-frozen-requests-v1', label, createdAt: new Date().toISOString(), sourcePath, sourceSha256: hash(sourceBytes), journalPath,
    journalSha256: hash(journalBytes), contextManifestSha256: hash(JSON.stringify(context.manifest)), moduleRoot, engineVersion: core.SINGLE_CORE_ENGINE_VERSION,
    contractVersion: contract.SINGLE_CORE_CONTRACT_VERSION, schema: zodTextFormat(contract.singleCoreCandidateWireSchema, 'single_interview_decision') as unknown as Record<string, unknown>,
    cases, sourceRecordsModified: false, providerCalls: 0 };
}

async function main() {
  dotenv.config({ path: '.env.local', quiet: true });
  const captureFile = arg('capture');
  if (captureFile) {
    const result = await captureLatestRequests(arg('module-root') ?? process.cwd(), arg('label') ?? 'candidate');
    await writeNew(captureFile, result);
    console.log(JSON.stringify({ path: captureFile, cases: result.cases.length, engine: result.engineVersion, providerCalls: 0, sourceRecordsModified: false })); return;
  }
  const input = arg('input');
  if (!input) throw new Error('USE_CAPTURE_OR_INPUT');
  const bytes = await readFile(input), frozen = JSON.parse(bytes.toString('utf8')) as Capture;
  if (frozen.version !== 'latest-human-frozen-requests-v1' || hash(await readFile(frozen.sourcePath)) !== frozen.sourceSha256 || hash(await readFile(frozen.journalPath)) !== frozen.journalSha256) throw new Error('LATEST_FROZEN_SOURCE_CHANGED');
  const only = new Set((arg('only') ?? '').split(',').filter(Boolean));
  const cases = frozen.cases.filter(item => !only.size || only.has(item.id));
  const repeats = Number(arg('repeats') ?? '1');
  const maxCalls = Number(arg('max-calls') ?? '24');
  const model = arg('model') ?? 'gpt-6-luna';
  if (!['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'].includes(model) || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 5 || cases.length * repeats > maxCalls || maxCalls > 120) throw new Error('LATEST_BENCHMARK_CALL_BUDGET_INVALID');
  dotenv.config({ path: '.env.local', quiet: true });
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30_000, maxRetries: 0 });
  const contract = await import('../server/providers/single-core-contract');
  const output = arg('out'); if (!output) throw new Error('LATEST_BENCHMARK_OUTPUT_REQUIRED');
  const results: Array<Record<string, unknown>> = [];
  const report = { version: 'latest-human-frozen-benchmark-v1', createdAt: new Date().toISOString(), completedAt: null as string | null, capturePath: input, captureSha256: hash(bytes),
    sourceSessionId: LATEST_HUMAN_SESSION, sourceSha256: frozen.sourceSha256, journalSha256: frozen.journalSha256, model, frozenEngine: frozen.engineVersion, countOnly: process.argv.includes('--count-only'),
    continuousAudioE2E: false, qualityGate: 'structural action/coverage labels plus explicit separate semantic review', maxCalls, providerRequests: 0, results, summary: {} as Record<string, unknown> };
  await writeNew(output, report);
  const file = await open(output, 'r+');
  const save = async () => { await file.truncate(0); await file.write(JSON.stringify(report, null, 2), 0, 'utf8'); await file.sync(); };
  try {
    for (let repeat = 1; repeat <= repeats; repeat++) for (const item of cases) {
      if (hash(JSON.stringify(item.request)) !== item.requestSha256) throw new Error('FROZEN_REQUEST_CHANGED');
      const started = performance.now();
      const format = frozen.schema as unknown as ResponseFormatTextConfig;
      const request = { ...item.request, model, store: false as const, service_tier: 'default' as const, prompt_cache_options: { ttl: '30m' as const }, text: { format: frozen.schema } };
      report.providerRequests++;
      try {
        if (report.countOnly) {
          const count = await client.responses.inputTokens.count({ model, instructions: item.request.instructions, input: item.request.input, text: { format } });
          results.push({ id: item.id, repeat, inputTokens: count.input_tokens, wallMs: performance.now() - started, exactCount: true });
        } else {
          const response = await client.responses.create(request as unknown as ResponseCreateParamsNonStreaming);
          const raw = JSON.parse(response.output_text);
          const decision = contract.decodeSingleCoreCandidateDecision(raw);
          const observation = normalizeProviderUsage(response, { requestedModel: model, requestedServiceTier: 'default', requestedCacheTtl: '30m' });
          const failures = [];
          if (!item.expected.actions.includes(decision.next.action)) failures.push('ACTION_OUTSIDE_LABEL');
          if (item.expected.coverage && (!decision.assessment || !item.expected.coverage.includes(decision.assessment.coverage))) failures.push('COVERAGE_OUTSIDE_LABEL');
          results.push({ id: item.id, repeat, question: item.question, rawTranscript: item.rawTranscript, questionSha256: item.questionSha256, transcriptSha256: item.transcriptSha256,
            expected: item.expected, decision, actionLabelsPassed: !failures.length, failures, wallMs: performance.now() - started,
            providerUsage: observation, cost: estimateProviderCost(observation), semanticReviewRequired: true });
        }
      } catch (error) {
        // Never echo request headers or API credentials in benchmark artifacts.
        const observation = normalizeProviderUsage(null, { requestedModel: model, requestedServiceTier: 'default', requestedCacheTtl: '30m' });
        results.push({ id: item.id, repeat, failure: error instanceof OpenAI.APIError ? { kind: 'provider', status: error.status ?? null, code: error.code ?? null, name: error.name, message: safeProviderError(error) } : { kind: 'parse_or_transport', name: error instanceof Error ? error.name : 'Unknown', message: safeProviderError(error) },
          ...(report.countOnly ? {} : { providerUsage: observation, cost: estimateProviderCost(observation) }), wallMs: performance.now() - started });
      }
      await save();
      const last = results.at(-1)!;
      console.log(JSON.stringify({ id: item.id, repeat, action: (last.decision as SingleCoreDecision | undefined)?.next.action, inputTokens: last.inputTokens ?? (last.providerUsage as ReturnType<typeof normalizeProviderUsage> | undefined)?.usage?.input_tokens, wallMs: Math.round(Number(last.wallMs)), failure: last.failure ?? null }));
    }
    const observations = results.flatMap(row => row.providerUsage ? [row.providerUsage as ReturnType<typeof normalizeProviderUsage>] : []);
    const median = (values: number[]) => { const sorted = [...values].sort((a,b) => a-b); return sorted.length ? sorted.length % 2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2 : null; };
    report.summary = { cases: results.length, failures: results.filter(row => row.failure).length, actionLabelPasses: results.filter(row => row.actionLabelsPassed).length,
      medianWallMs: median(results.map(row => Number(row.wallMs))), medianInputTokens: median(observations.flatMap(row => row.usage ? [row.usage.input_tokens] : [])),
      measuredCost: aggregateProviderCosts(observations.map(estimateProviderCost)), semanticReviewComplete: false };
    report.completedAt = new Date().toISOString(); await save();
  } finally { await file.close(); }
  if (hash(await readFile(frozen.sourcePath)) !== frozen.sourceSha256 || hash(await readFile(frozen.journalPath)) !== frozen.journalSha256) throw new Error('LATEST_SOURCE_CHANGED_DURING_BENCHMARK');
  console.log(JSON.stringify({ output, ...report.summary }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
