import dotenv from 'dotenv';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { loadInterviewContextAt } from '../server/data/load-interview-context';
import { loadQuestionBank } from '../server/data/prepared-question-bank';
import { buildQuestionPremiseReviewInput, QUESTION_PREMISE_REVIEW_RULES, questionPremiseReviewWireSchema, validateQuestionPremises } from '../server/providers/question-premises';
import { saveApprovedRecoveryVariants, loadApprovedRecoveryVariants } from '../server/data/approved-recovery-variants';
import { synthesizeSpeech } from '../server/providers/clova-tts';
import type { RecordedTurn } from '../server/protocol';

if (!process.argv.includes('--run-live')) throw new Error('EXPLICIT_RUN_LIVE_REQUIRED');
dotenv.config({ path: '.env.local', quiet: true });
const context = await loadInterviewContextAt(process.cwd()), bank = await loadQuestionBank(context);
if (context.errors.length || !bank) throw new Error('BANK_NOT_READY');
const candidate = bank.slots.flatMap(slot => slot.candidates).find(candidate => candidate.draft.questionText.includes('온도 상승에 따른 약전해질'));
if (!candidate) throw new Error('CONCEPT_CANDIDATE_MISSING');
const id = randomUUID(), metadata = structuredClone(candidate.draft);
const original = { id, parentMainQuestionId: id, questionKind: 'main', questionText: metadata.questionText, evidenceIds: metadata.evidenceIds, metadata } as unknown as RecordedTurn;
if ((await loadApprovedRecoveryVariants(context, original)).length) {
  console.log(JSON.stringify({ cacheHit: true, providerCalls: 0 }));
} else {
  const variant = { ...structuredClone(metadata), questionKind: 'clarification' as const, parentMainQuestionId: id, questionText: '온도가 올라갈 때 약전해질과 강전해질의 전도도는 각각 어떻게 변하는지 비교해 주세요.' };
  const sources = context.student.evidence.filter(source => variant.evidenceIds.includes(source.id));
  const originalQuestion = { questionText: original.questionText, questionIntent: metadata.questionIntent, targetEvidence: metadata.targetEvidence, primaryFunction: metadata.primaryFunction, depth: metadata.depth };
  const input = buildQuestionPremiseReviewInput(variant, sources, undefined, originalQuestion);
  const model = process.env.OPENAI_QUESTION_MODEL || 'gpt-6-luna';
  const response = await new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000, maxRetries: 0 }).responses.parse({ model, store: false, reasoning: { effort: 'low' }, instructions: QUESTION_PREMISE_REVIEW_RULES, input: JSON.stringify(input), text: { format: zodTextFormat(questionPremiseReviewWireSchema(input), 'concept_recovery_independent_review') }, max_output_tokens: 1600 });
  const review = response.output_parsed;
  const trace = { observedAt: new Date().toISOString(), originalQuestion: input.originalQuestion, finalQuestion: input.question, model, review, failure: null as unknown };
  try {
    if (!review) throw new Error('REVIEW_MISSING');
    await validateQuestionPremises({ draft: variant, sources, originalQuestion, reviewModel: model, requestReview: async () => review, onValidationFailure: failure => { trace.failure = failure; } });
    const artifact = await saveApprovedRecoveryVariants(context, original, [{ questionText: variant.questionText, reviewedAt: trace.observedAt, reviewModel: model, review }]);
    await synthesizeSpeech(variant.questionText, candidate.voiceSettings.speaker, { settings: candidate.voiceSettings });
    if (!(await loadApprovedRecoveryVariants(context, original)).length) throw new Error('SAVED_RECOVERY_NOT_READY');
    console.log(JSON.stringify({ ready: true, providerCalls: 1, identity: artifact.identity, questionText: variant.questionText }));
  } finally {
    await mkdir('artifacts', { recursive: true });
    await writeFile('artifacts/concept-recovery-variant-review.json', JSON.stringify(trace, null, 2), { mode: 0o600 });
  }
}
