import type { EvaluationSessionOptions } from '../../server/providers/openai';
import { normalizeProviderUsage } from '../../server/observability/provider-cost';

/** Only raw provider I/O is synthetic. The real evaluator validates this
 * response, preserves held members and performs the existing aggregation. */
export const syntheticEvaluationResponse: NonNullable<EvaluationSessionOptions['requestEvaluation']> = async (request, execution) => {
  const input = JSON.parse(request.input) as { answers: Array<{ id: string; answerAttempts: Array<{ finalized: boolean; rawTranscript: string }> }> };
  execution?.onProviderUsage?.(normalizeProviderUsage({ model: request.model, id: 'explicit-synthetic-response', usage: { input_tokens: 17, output_tokens: 23, total_tokens: 40, input_tokens_details: { cached_tokens: 0 } } }, { requestedModel: request.model }));
  return { summary: 'Explicit public synthetic response; no semantic-quality claim.', languageClassifications: [],
    answers: input.answers.map(answer => {
      const quote = answer.answerAttempts.find(item => item.finalized && item.rawTranscript)?.rawTranscript ?? '';
      const axes = Object.fromEntries(['I', 'A', 'S', 'R', 'C'].map(axis => [axis, { anchor: 3, quote, rationale: 'Explicit synthetic response tied to the exact finalized source.' }]));
      return { turnId: answer.id, status: 'PARTIAL', deferredReason: null, axes, verifiedCoreError: false, verifiedCoreErrorEvidence: null,
        strengths: [], improvements: [], conflictNeedsReview: [], deliveryCoaching: [], strategyCoaching: [] };
    }) };
};
