import { z } from 'zod';
import type { AuthenticatedRequestContext } from '../auth/request-identity';
import type { SessionAccessBinding } from '../request-realtime-server';
import { evaluationTextSha256 } from './e-handoff-codec';

export const AUTHENTICATED_EVALUATION_COMMAND_VERSION = 'authenticated-evaluation-command-v1';
const generation = z.string().regex(/^\d+$/u);
export const authenticatedEvaluationCommandSchema = z.object({
  version: z.literal(AUTHENTICATED_EVALUATION_COMMAND_VERSION), key: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/u),
  expectedTrustGeneration: generation, expectedRegistryGeneration: generation, expectedApprovalGeneration: generation,
  payload: z.unknown(),
}).strict();
export type AuthenticatedEvaluationCommand = z.infer<typeof authenticatedEvaluationCommandSchema>;
export type EvaluationQueryAction = 'status' | 'registry' | 'review' | 'approval' | 'commands' | 'revision';
export type EvaluationMutationAction = 'registry' | 'approval' | 'withdraw' | 'consume' | 'retry';
export function evaluationCommandInputSha256(sessionId: string, action: EvaluationMutationAction, payload: unknown) {
  return evaluationTextSha256(JSON.stringify({ version: AUTHENTICATED_EVALUATION_COMMAND_VERSION, sessionId, action, payload }));
}
export interface ServiceEvaluationMutations {
  readonly kind: 'isolated-db-evaluation-writer';
  query(context: AuthenticatedRequestContext, binding: SessionAccessBinding, action: EvaluationQueryAction, query: Record<string, string>): Promise<unknown>;
  command(context: AuthenticatedRequestContext, binding: SessionAccessBinding, action: EvaluationMutationAction, input: unknown): Promise<unknown>;
}
