import { createHash, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import type { AuthenticatedRequestContext } from '../auth/request-identity';
import { evaluationTextSha256 } from './e-handoff-codec';
import { EvaluationWriterError, type EvaluationReviewArtifact } from './evaluation-writer-ports';

export const evaluationReviewerActionSchema = z.enum(['publish-spec', 'supply-session', 'withdraw']);
export type EvaluationReviewerAction = z.infer<typeof evaluationReviewerActionSchema>;
const text = z.string().min(1).max(300);
const reviewerSchema = z.object({
  issuer: text, subject: text, actorId: text, publicKey: z.string().min(1).max(16_384),
  actions: z.array(evaluationReviewerActionSchema).min(1).max(3),
  notBefore: z.string().datetime(), expiresAt: z.string().datetime(), revoked: z.boolean(),
}).strict();
export const evaluationReviewTrustSchema = z.object({
  version: z.literal('evaluation-review-trust-v1'), ownerId: text, studentId: text,
  applicationTargetId: text, supportTargetId: text, reviewers: z.array(reviewerSchema).min(1).max(64),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type EvaluationReviewTrust = z.infer<typeof evaluationReviewTrustSchema>;
const reject = (code: string): never => { throw new EvaluationWriterError(403, code); };

/** Public key identity is SPKI-DER SHA256. It is deliberately distinct from
 * the raw trust TEXT hash and the existing JSON.stringify domain seal. */
export function evaluationReviewerKeySha256(publicKey: string) {
  try {
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\r?\n?$/u.test(publicKey))
      return reject('F_REVIEW_KEY_PUBLIC_ONLY');
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') return reject('F_REVIEW_KEY_UNSUPPORTED');
    return createHash('sha256').update(key.export({ format: 'der', type: 'spki' })).digest('hex');
  } catch (cause) {
    if (cause instanceof EvaluationWriterError) throw cause;
    return reject('F_REVIEW_KEY_INVALID');
  }
}
export function parseEvaluationReviewTrust(artifact: EvaluationReviewArtifact, context: AuthenticatedRequestContext) {
  if (artifact.kind !== 'trust' || evaluationTextSha256(artifact.json) !== artifact.rawSha256) return reject('F_REVIEW_TRUST_BYTES_CHANGED');
  let value: EvaluationReviewTrust;
  try {
    const raw: unknown = JSON.parse(artifact.json);
    if (!evaluationReviewTrustSchema.safeParse(raw).success) return reject('F_REVIEW_TRUST_INVALID');
    value = raw as EvaluationReviewTrust;
  } catch (cause) {
    if (cause instanceof EvaluationWriterError) throw cause;
    return reject('F_REVIEW_TRUST_INVALID');
  }
  const { contentSha256, ...body } = value;
  if (contentSha256 !== artifact.contentSha256 || evaluationTextSha256(JSON.stringify(body)) !== contentSha256 || !context.scope ||
    value.ownerId !== context.account.ownerId || value.studentId !== context.scope.studentId ||
    value.applicationTargetId !== context.scope.applicationTargetId || value.supportTargetId !== context.scope.supportTargetId) return reject('F_REVIEW_TRUST_BINDING_CHANGED');
  const subjects = new Set<string>(), actors = new Set<string>();
  for (const reviewer of value.reviewers) {
    const subject = JSON.stringify([reviewer.issuer, reviewer.subject]);
    if (subjects.has(subject) || actors.has(reviewer.actorId) || new Set(reviewer.actions).size !== reviewer.actions.length ||
      Date.parse(reviewer.expiresAt) <= Date.parse(reviewer.notBefore)) return reject('F_REVIEW_TRUST_CONFLICT');
    evaluationReviewerKeySha256(reviewer.publicKey);
    subjects.add(subject); actors.add(reviewer.actorId);
  }
  return value;
}

/** Only a server-installed current trust revision grants an action. Receipt
 * signatures, DTO roles and a supplied approver string do not grant it. */
export function resolveEvaluationReviewer(artifact: EvaluationReviewArtifact | null, context: AuthenticatedRequestContext,
  action: EvaluationReviewerAction, serverNow: string) {
  if (!artifact) return reject('F_REVIEW_TRUST_REQUIRED');
  const trust = parseEvaluationReviewTrust(artifact, context), time = Date.parse(serverNow);
  if (!Number.isFinite(time)) return reject('F_REVIEW_TRUST_TIME_UNAVAILABLE');
  const actor = trust.reviewers.find(item => item.issuer === context.principal.issuer && item.subject === context.principal.subject);
  if (!actor || actor.revoked || !actor.actions.includes(action) || time < Date.parse(actor.notBefore) || time >= Date.parse(actor.expiresAt))
    return reject('F_REVIEWER_NOT_AUTHORIZED');
  return { ...actor, publicKeySha256: evaluationReviewerKeySha256(actor.publicKey), trustSha256: trust.contentSha256 };
}

/** Workers may verify stored signed artifacts without becoming their issuer.
 * Use the persisted actor and current trust, never the worker's own subject. */
export function resolveStoredEvaluationReviewer(artifact: EvaluationReviewArtifact | null, context: AuthenticatedRequestContext,
  actorId: string, action: EvaluationReviewerAction, serverNow: string) {
  if (!artifact) return reject('F_REVIEW_TRUST_REQUIRED');
  const trust = parseEvaluationReviewTrust(artifact, context), time = Date.parse(serverNow);
  const actor = trust.reviewers.find(item => item.actorId === actorId);
  if (!Number.isFinite(time) || !actor || actor.revoked || !actor.actions.includes(action) || time < Date.parse(actor.notBefore) || time >= Date.parse(actor.expiresAt))
    return reject('F_REVIEWER_NOT_AUTHORIZED');
  return { ...actor, publicKeySha256: evaluationReviewerKeySha256(actor.publicKey), trustSha256: trust.contentSha256 };
}
