import type { AuthenticatedRequestContext, RequestIdentityBoundary } from '../../server/auth/request-identity';
import { createIsolatedEvaluationService } from '../../server/evaluation-writer/isolated-evaluation-service';
import { createEvaluationAdmissionCapability, createEvaluationReviewerCapability } from '../../server/db/postgres-evaluation-writer';
import { EvaluationWriterError, type EvaluationReviewArtifact } from '../../server/evaluation-writer/evaluation-writer-ports';

export function finiteAuthority(context: AuthenticatedRequestContext, identity: RequestIdentityBoundary, expiresAt = Date.now() + 600_000) {
  return { ownerId: context.account.ownerId, ...context.scope!, expiresAt: Math.min(expiresAt, context.principal.expiresAt),
    async checkCurrent() { try { await identity.revalidate(context); return true; } catch { return false; } } };
}
export function composeEvaluation(options: Pick<Parameters<typeof createIsolatedEvaluationService>[0], 'identity' | 'repository' | 'sessions' | 'loadPinnedBank' | 'observe'>,
  trustCurrent: (context: AuthenticatedRequestContext, trust: EvaluationReviewArtifact) => Promise<void>) {
  return createIsolatedEvaluationService({ ...options, environment: 'isolated-evaluation-writer', assertTrustCurrent: trustCurrent,
    mintReviewer(context, value) {
      return createEvaluationReviewerCapability({ ...finiteAuthority(context, options.identity), issuer: context.principal.issuer, subject: context.principal.subject,
        actorId: value.actorId, publicKeySha256: value.publicKeySha256, action: value.action, expectedTrustGeneration: value.control.trustGeneration,
        ...(value.sessionId ? { sessionId: value.sessionId } : {}) });
    }, mintAdmission(context, input) {
      if (!context.scope) throw new EvaluationWriterError(403, 'F_SCOPE_REQUIRED');
      return createEvaluationAdmissionCapability({ ...finiteAuthority(context, options.identity), sessionId: input.sessionId, inputSha256: input.inputSha256,
        handoffIntentId: input.handoffIntentId, handoffPayloadSha256: input.handoffPayloadSha256 });
    } });
}
