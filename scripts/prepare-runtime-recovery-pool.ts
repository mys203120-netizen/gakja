import dotenv from 'dotenv';
import OpenAI from 'openai';
import { z } from 'zod';
import { zodTextFormat } from 'openai/helpers/zod';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContext, type InterviewContext } from '../server/data/load-interview-context';
import { preparedActivitiesModel } from '../server/data/prepared-activities';
import { loadQuestionBank, type PreparedQuestionBank, type PreparedMainCandidate } from '../server/data/prepared-question-bank';
import { loadApprovedRecoveryVariants, recoveryVariantIdentity, saveApprovedRecoveryVariants } from '../server/data/approved-recovery-variants';
import { buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview, materializeStablePremiseReview, QUESTION_PREMISE_REVIEW_RULES, resolveVerifiedCommonPremiseAuthority, stableQuestionPremiseReviewSchema, STABLE_PREMISE_PROOF_RULES, type QuestionPremiseReviewInput } from '../server/providers/question-premises';
import { buildRuntimeReviewPayload } from '../server/providers/natural-question';
import { assertQuestionPresentation, questionSpeechLimits } from '../server/providers/question-plan';
import { assertInterviewQuestionSpeech } from '../server/providers/interview-speech';
import { QuestionValidationError } from '../server/providers/question-grounding';
import { synthesizeSpeech, type SpeechSynthesisTiming } from '../server/providers/clova-tts';
import { aggregateProviderCosts, estimateProviderCost, normalizeProviderUsage, type ProviderUsageObservation } from '../server/observability/provider-cost';
import type { QuestionDraft, RecordedTurn } from '../server/protocol';

export const OFFLINE_RECOVERY_POLICY_VERSION = 'offline-same-demand-recovery-policy-v2';
export const OFFLINE_RECOVERY_GENERATION_INSTRUCTIONS = 'MD8 제13조와 MD9 제12·16조의 같은 질문 재진술만 만든다. actualQuestion은 학생이 실제 들은 원질문이며 동일 요구의 기준이다. intent/targetEvidence/기능/깊이는 내부 준비 맥락이다. 내부 목표가 더 넓거나 여러 확인 지점을 담아도 actualQuestion이 요구하지 않은 과제를 복구 질문에 추가하지 않는다. 먼저 실제 원질문의 주된 요구 한 가지와 그 한정 조건을 식별하고, 그 요구만 쉬운 존댓말로 다시 표현한다. 학생 답변은 아직 없다. 새 근거·방법·역할·이유·힌트·정답을 추가하지 않는다. 원질문이 방법만 요청하면 배경 문제나 이유 설명을 추가하지 않는다. 관찰한 결과를 미리 계획한 목적이나 동기로 바꾸지 않는다. 부정·주어·시점·연구/문헌/팀 등 귀속·기술 용어·수치·단위·비교 대상·대조 조건을 보존한다. 기술 용어를 다른 개념의 쉬운 말로 바꾸지 말고 주변 문장만 쉽게 쓴다. 기록에서 확인한 연구 결과를 보편적 과학 사실이나 학생의 직접 실험 성과로 바꾸지 않는다. 원질문이 열어 둔 존재 조건은 반드시 유지한다. "있다면/있나요/연결되었다면"에 대응하는 조건을 빼지 말고 경험이나 역할이 없다고 답할 여지를 보존한다. 원질문의 확인된 사실을 불필요한 가정으로 바꾸지도 않는다. 두 활동의 연결 여부를 열어 두었다면 계속 열어 둔다. 원문과 다른 자연스러운 존댓말 한 문장, 물음표 최대1개, 80자 이내다. 설명·인사·전환 예고를 붙이지 않는다.';
export const OFFLINE_RECOVERY_REVIEW_INSTRUCTIONS = QUESTION_PREMISE_REVIEW_RULES + STABLE_PREMISE_PROOF_RULES + '\n현재는 학생 답변 없이 승인 Q0를 쉽게 재진술한 clarification의 독립 검수다. 동일 요구 비교의 기준은 originalQuestion.questionText에 실제 발화된 한 가지 요구와 한정 조건이다. questionIntent/targetEvidence는 내부 준비 맥락이며 원질문보다 넓을 수 있다. 원질문이 요청하지 않은 내부 목표까지 채워야 한다고 판정하거나, 내부 목표에 있는 과제를 재진술에 추가하도록 요구하지 않는다. 실제 원질문과 후보의 요구·귀속·존재 조건·부정·시점·기술 용어·수치·비교·대조 범위를 의미로 대조한다. 이를 바꿨거나 과제를 추가/누락하면 clarificationPreservesIntent=false다. 원질문의 승인 자체는 후보의 새 사실 전제를 승인하는 근거가 아니며 사실은 계속 sources로 독립 검수한다. questionSpan은 반드시 input.question.questionText 안에 실제 있는 연속 구간이다. originalQuestion이나 sources의 표현을 최종 질문에 있는 것처럼 questionSpan에 옮기지 않는다. 존재를 열어 둔 절을 검수할 때는 조건이 걸리는 범위를 함께 읽고, 조건부 개인 역할을 조건 없는 수행 사실로 잘라 해석하지 않는다. 원질문이 허용한 역할·방법·이유·개념의 설명 요청은 그 답 자체를 기록된 사실로 전제하지 않는다. 요청하는 미확인 답의 내용에 관련 없는 proofId를 억지로 붙이지 않는다. 숨은 수행·원인·결과 단정이 없는 열린 요구는 open_check, supported=true, proofId=null이며 예상 답이 자료에 없다는 이유만으로 거부하지 않는다. 연구 귀속을 지우거나 발견 결과를 사전 목적·동기로 바꾼 전제는 계속 거부한다. 모든 전제와 한 요구를 독립 검수한 뒤 verdict를 그 결과와 일관되게 반환한다. 실제 위반은 해당 판정 필드/전제에 반영해 rewrite, 미확인은 uncertain이다. 모든 조건이 충족됐다는 판정과 근거 없이 rewrite를 함께 반환하지 않는다. 이 지시는 자동 승인이 아니며 최종 후보의 사실 전제와 동일 요구가 모두 확인되어야 allowed다.';
const instructionHash = (text: string) => createHash('sha256').update(text).digest('hex');
const offlineRecoveryPolicyBody = { version: OFFLINE_RECOVERY_POLICY_VERSION, generationInstructions: OFFLINE_RECOVERY_GENERATION_INSTRUCTIONS, reviewInstructions: OFFLINE_RECOVERY_REVIEW_INSTRUCTIONS };
export const OFFLINE_RECOVERY_REPORT_POLICY = Object.freeze({ ...offlineRecoveryPolicyBody, generationSha256: instructionHash(OFFLINE_RECOVERY_GENERATION_INSTRUCTIONS), reviewSha256: instructionHash(OFFLINE_RECOVERY_REVIEW_INSTRUCTIONS), contentSha256: instructionHash(JSON.stringify(offlineRecoveryPolicyBody)) });
export type RuntimeRecoveryReportPolicy = typeof OFFLINE_RECOVERY_REPORT_POLICY;

type UsageObserver = (usage: ProviderUsageObservation) => void;
export interface RuntimeRecoveryPoolProviders {
  generate(original: RecordedTurn, excluded: string[], onUsage: UsageObserver): Promise<string>;
  review(input: QuestionPremiseReviewInput, onUsage: UsageObserver): Promise<unknown>;
  warm(questionText: string, candidate: PreparedMainCandidate): Promise<unknown>;
}
const safeFailure = (error: unknown) => error instanceof QuestionValidationError ? error.code : error instanceof Error && /^[A-Z_]+$/u.test(error.message) ? error.message : error instanceof Error ? error.name : 'UNKNOWN_FAILURE';
export function recoveryOriginal(candidate: PreparedMainCandidate): RecordedTurn {
  const id = randomUUID(), metadata = structuredClone(candidate.draft);
  // This is an offline question identity, never a fabricated student answer/session.
  return { id, parentMainQuestionId: id, questionKind: 'main', questionText: metadata.questionText,
    evidenceIds: [...metadata.evidenceIds], metadata } as unknown as RecordedTurn;
}
export async function prepareRuntimeRecoveryPool(context: InterviewContext, bank: PreparedQuestionBank, providers: RuntimeRecoveryPoolProviders, options: { root?: string; checkOnly?: boolean; reviewModel?: string; policy?: RuntimeRecoveryReportPolicy; candidateIds?: readonly string[]; maxCandidatesPerQuestion?: 1 | 2; onProgress?: (report: Record<string, any>) => Promise<void> } = {}) {
  const originalBank = JSON.stringify(bank), root = options.root ?? process.cwd(), reviewModel = options.reviewModel ?? bank.questionModel;
  if (!reviewModel.trim()) throw new Error('RECOVERY_REVIEW_MODEL_REQUIRED');
  const report: Record<string, any> = { version: 'offline-same-demand-recovery-pool-v1', startedAt: new Date().toISOString(), bankKey: bank.key,
    bankContentSha256: bank.contentSha256, generationModel: bank.questionModel, reviewModel, checkOnly: Boolean(options.checkOnly), maxCandidatesPerQuestion: options.maxCandidatesPerQuestion ?? 2,
    studentAnswerCreated: false, bankMutated: false, ...(options.policy ? { policy: structuredClone(options.policy) } : {}), questions: [], usage: [] };
  const progress = async () => { report.cost = aggregateProviderCosts(report.usage.map((u: any) => estimateProviderCost(u.observation))); await options.onProgress?.(report); };
  for (const candidate of bank.slots.flatMap(slot => slot.candidates)) {
    if (options.candidateIds && !options.candidateIds.includes(candidate.id)) continue;
    const original = recoveryOriginal(candidate), cached = await loadApprovedRecoveryVariants(context, original, root);
    const item: Record<string, any> = { candidateId: candidate.id, question: original.questionText, identity: recoveryVariantIdentity(context, original),
      cachedBefore: cached.length, ready: cached.length > 0, attempts: [], sourceDemand: { primaryFunction: original.metadata.primaryFunction,
        depth: original.metadata.depth, intent: original.metadata.questionIntent, targetEvidence: original.metadata.targetEvidence } };
    report.questions.push(item);
    if (cached.length) {
      item.cacheHit = true;
      item.cachedReviewModels = [...new Set(cached.map(draft => draft.premiseValidation?.reviewModel).filter(Boolean))];
      if (!options.checkOnly) { item.audio = await providers.warm(cached[0].questionText, candidate); item.audioReady = true; }
      await progress(); continue;
    }
    if (options.checkOnly) { await progress(); continue; }
    const excluded = [original.questionText];
    for (let attempt = 1; attempt <= report.maxCandidatesPerQuestion; attempt++) {
      const trial: Record<string, any> = { attempt, startedAt: new Date().toISOString(), stage: 'generation' };
      item.attempts.push(trial);
      const observed = new Set<string>();
      const observer = (stage: string) => (observation: ProviderUsageObservation) => {
        observed.add(stage); report.usage.push({ candidateId: candidate.id, attempt, stage, observation });
      };
      try {
        const at = performance.now();
        const questionText = await providers.generate(original, excluded, observer('generation'));
        trial.generationMs = performance.now() - at; trial.questionText = questionText;
        if (!questionText.trim() || excluded.includes(questionText)) throw new Error('RECOVERY_REPEAT_OR_EMPTY');
        excluded.push(questionText);
        const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText, questionKind: 'clarification',
          parentMainQuestionId: original.id, evidenceIds: [...original.evidenceIds], evidenceQuotes: structuredClone(original.metadata.evidenceQuotes),
          primaryFunction: original.metadata.primaryFunction, depth: original.metadata.depth, questionIntent: original.metadata.questionIntent,
          targetEvidence: [...original.metadata.targetEvidence], groundingRationale: '동일한 실제 요구를 쉽게 다시 표현하는 사전 승인 복구 후보.',
          validationStatus: 'approved', validationFailures: [], ...(original.metadata.commonApproval ? { commonApproval: structuredClone(original.metadata.commonApproval) } : {}) };
        trial.stage = 'surface_precheck';
        assertInterviewQuestionSpeech(questionText, { isFirstTurn: false }); assertQuestionPresentation(draft);
        const sources = context.student.evidence.filter(source => draft.evidenceIds.includes(source.id));
        const input = buildQuestionPremiseReviewInput(draft, sources, undefined, {
          questionText: original.questionText, questionIntent: original.metadata.questionIntent, targetEvidence: original.metadata.targetEvidence,
          primaryFunction: original.metadata.primaryFunction, depth: original.metadata.depth,
        }, [], resolveVerifiedCommonPremiseAuthority(context, draft));
        trial.stage = 'independent_review'; const reviewedAt = performance.now();
        const review = await providers.review(input, observer('review'));
        trial.reviewMs = performance.now() - reviewedAt; trial.review = review;
        draft.premiseValidation = finalizeQuestionPremiseReview(review, input, reviewModel);
        trial.stage = 'immutable_save';
        await saveApprovedRecoveryVariants(context, original, [{ questionText, reviewedAt: new Date().toISOString(), reviewModel, review }], root);
        const loaded = await loadApprovedRecoveryVariants(context, original, root);
        if (loaded.length !== 1 || loaded[0].questionText !== questionText) throw new Error('RECOVERY_SAVE_NOT_READY');
        trial.stage = 'audio_warmup'; const audioAt = performance.now(); trial.audio = await providers.warm(questionText, candidate);
        trial.audioMs = performance.now() - audioAt; trial.approved = true; item.ready = true; item.audioReady = true; item.variant = questionText;
        trial.stage = 'ready'; break;
      } catch (error) {
        trial.failure = safeFailure(error); trial.approved = false;
        if (['generation', 'independent_review'].includes(trial.stage) && !observed.has(trial.stage === 'generation' ? 'generation' : 'review')) {
          observer(trial.stage === 'generation' ? 'generation' : 'review')(normalizeProviderUsage(null, { requestedModel: trial.stage === 'generation' ? bank.questionModel : reviewModel, requestedServiceTier: 'default', requestedCacheTtl: '30m' }));
        }
        // Only validation failures use the explicit second candidate budget.
        const validation = error instanceof QuestionValidationError || trial.failure === 'RECOVERY_REPEAT_OR_EMPTY';
        if (!validation) { item.providerOrStorageFailure = true; break; }
      } finally { trial.completedAt = new Date().toISOString(); await progress(); }
    }
  }
  if (JSON.stringify(bank) !== originalBank) throw new Error('QUESTION_BANK_MUTATED');
  report.coverage = { approvedOriginals: report.questions.length, ready: report.questions.filter((q: any) => q.ready).length,
    cached: report.questions.filter((q: any) => q.cacheHit).length, audioReady: options.checkOnly ? null : report.questions.filter((q: any) => q.audioReady).length,
    missing: report.questions.filter((q: any) => !q.ready).map((q: any) => q.candidateId) };
  report.completedAt = new Date().toISOString(); await progress(); return report;
}

export async function prepareRuntimeRecoveryPoolCli(args: string[], suppliedContext?: InterviewContext) {
  if (args.some(a => !['--run-live', '--check', '--max-candidates=1', '--max-candidates=2'].includes(a) && !/^--candidate-id=[a-f0-9]{64}$/u.test(a) && !/^--out=artifacts\/[a-z0-9-]+\.json$/u.test(a) && !a.startsWith('--manual-question=') && !/^--review-model=[a-zA-Z0-9._-]+$/u.test(a)) || args.includes('--run-live') === args.includes('--check')) throw new Error('USE_EXACTLY_RUN_LIVE_OR_CHECK');
  dotenv.config({ path: '.env.local', quiet: true });
  const reviewModelArgs = args.filter(arg => arg.startsWith('--review-model='));
  const precisionReviewModel = reviewModelArgs[0]?.slice('--review-model='.length);
  if (reviewModelArgs.length > 1 || precisionReviewModel && precisionReviewModel !== preparedActivitiesModel()) throw new Error('RECOVERY_REVIEW_MODEL_NOT_CONFIGURED');
  const context = suppliedContext ?? await loadInterviewContext(), bank = await loadQuestionBank(context);
  if (context.errors.length || !bank) throw new Error('VERIFIED_BANK_REQUIRED');
  const checkOnly = args.includes('--check'), model = process.env.OPENAI_QUESTION_MODEL || 'gpt-6-luna';
  const reviewModel = precisionReviewModel ?? model;
  const client = checkOnly ? null : new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0, timeout: 30000 });
  const file = args.find(a => a.startsWith('--out='))?.slice(6) ?? 'artifacts/runtime-recovery-pool-preparation.json';
  const candidateId = args.find(a => a.startsWith('--candidate-id='))?.slice('--candidate-id='.length);
  const manualQuestion = args.find(a => a.startsWith('--manual-question='))?.slice('--manual-question='.length);
  if (candidateId && !bank.slots.some(slot => slot.candidates.some(candidate => candidate.id === candidateId))) throw new Error('UNKNOWN_CANDIDATE');
  if (manualQuestion && (!candidateId || !args.includes('--max-candidates=1') || [...manualQuestion].length > questionSpeechLimits.clarification)) throw new Error('MANUAL_REPAIR_REQUIRES_ONE_BOUNDED_TARGET');
  await mkdir('artifacts', { recursive: true });
  const providers: RuntimeRecoveryPoolProviders = {
    async generate(original, excluded, onUsage) {
      if (manualQuestion) return manualQuestion;
      const response = await client!.responses.parse({ model, store: false, service_tier: 'default', prompt_cache_options: { ttl: '30m' }, reasoning: { effort: 'none' },
        instructions: OFFLINE_RECOVERY_GENERATION_INSTRUCTIONS,
        input: JSON.stringify({ actualQuestion: original.questionText, intent: original.metadata.questionIntent, targetEvidence: original.metadata.targetEvidence,
          primaryFunction: original.metadata.primaryFunction, depth: original.metadata.depth, forbiddenIdenticalTexts: excluded }),
        text: { format: zodTextFormat(z.object({ questionText: z.string().min(8).max(questionSpeechLimits.clarification) }).strict(), 'offline_same_demand_recovery') }, max_output_tokens: 180 });
      onUsage(normalizeProviderUsage(response, { requestedModel: model, requestedServiceTier: 'default', requestedCacheTtl: '30m' }));
      if (!response.output_parsed) throw new Error('RECOVERY_GENERATION_EMPTY'); return response.output_parsed.questionText;
    },
    async review(input, onUsage) {
      const response = await client!.responses.parse({ model: reviewModel, store: false, service_tier: 'default', prompt_cache_options: { ttl: '30m' }, reasoning: { effort: precisionReviewModel ? 'low' : 'none' },
        instructions: OFFLINE_RECOVERY_REVIEW_INSTRUCTIONS,
        input: JSON.stringify(buildRuntimeReviewPayload(input)), text: { format: zodTextFormat(stableQuestionPremiseReviewSchema, 'offline_recovery_independent_review') }, max_output_tokens: precisionReviewModel ? 1800 : 900 }, { timeout: precisionReviewModel ? 90000 : 30000 });
      onUsage(normalizeProviderUsage(response, { requestedModel: reviewModel, requestedServiceTier: 'default', requestedCacheTtl: '30m' }));
      if (!response.output_parsed) throw new Error('RECOVERY_REVIEW_EMPTY');
      // A full stored proof is rebuilt from the exact immutable input.
      return materializeStablePremiseReview(response.output_parsed, input);
    },
    async warm(questionText, candidate) {
      let timing: SpeechSynthesisTiming | undefined;
      const audioUrl = await synthesizeSpeech(questionText, candidate.voiceSettings.speaker, { settings: candidate.voiceSettings, onTiming: value => { timing = value; } });
      return { audioUrl, timing };
    },
  };
  const report = await prepareRuntimeRecoveryPool(context, bank, providers, { checkOnly, reviewModel, policy: OFFLINE_RECOVERY_REPORT_POLICY, ...(candidateId ? { candidateIds: [candidateId] } : {}),
    maxCandidatesPerQuestion: args.includes('--max-candidates=1') ? 1 : 2,
    onProgress: value => writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 }) });
  const current = await loadQuestionBank(context);
  report.generationMode = manualQuestion ? 'explicit-human-reviewed-candidate-no-generation-call' : 'model-generated';
  report.bankIdentityUnchanged = current?.key === bank.key && current.contentSha256 === bank.contentSha256;
  await writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ file, bankKey: report.bankKey, bankIdentityUnchanged: report.bankIdentityUnchanged, coverage: report.coverage, cost: report.cost }));
  if (!report.bankIdentityUnchanged || report.coverage.missing.length) process.exitCode = 1;
  return { report, file };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) prepareRuntimeRecoveryPoolCli(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ ready: false, failure: safeFailure(error) })); process.exitCode = 1; });
