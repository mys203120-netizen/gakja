import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { InterviewSession } from '../protocol';
import type { InterviewContext } from '../data/load-interview-context';
import { AUTHENTICATED_SESSION_RUNTIME_VERSION, assertAuthenticatedSessionOwner } from '../session-runtime';

export const AUTHENTICATED_SESSION_ENVELOPE_VERSION = 'authenticated-session-envelope-v1';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const hex = z.string().length(64).regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().min(1).max(200);
/** Shared structural projection only. The exact raw text and existing domain
 * gates remain authoritative; unknown existing runtime metadata is preserved. */
export const authenticatedRuntimeProjectionSchema = z.object({
  version: z.literal(AUTHENTICATED_SESSION_RUNTIME_VERSION),
  owner: z.object({ id: identifier, mode: z.literal('authenticated') }).strict(),
  engineVersion: z.string().min(1), contextSnapshotSha256: hex, epoch: z.number().int().nonnegative(),
  checkpoint: z.object({ phase: z.string().min(1), at: z.string().min(1), turnId: z.string().nullable(), answerId: z.string().nullable() }).passthrough(),
  operations: z.record(z.string(), z.object({ status: z.enum(['running', 'committed', 'blocked', 'retryable']), startedAt: z.string().min(1), epoch: z.number().int().nonnegative() }).passthrough()),
}).passthrough();
export const authenticatedSessionProjectionSchema = z.object({
  id: z.string().uuid(), createdAt: z.string().min(1), updatedAt: z.string().min(1),
  status: z.enum(['active', 'ending', 'completed']), evaluationStatus: z.enum(['pending', 'running', 'completed', 'failed', 'review_required']),
  runtime: authenticatedRuntimeProjectionSchema,
  target: z.unknown(), sourceManifest: z.unknown(),
  turns: z.array(z.object({ id: z.string().uuid(), questionText: z.string(), questionKind: z.enum(['main', 'follow_up', 'clarification']),
    parentMainQuestionId: z.string().uuid(), mainIndex: z.number().int().positive(), mainCount: z.number().int().nonnegative(), followUpIndex: z.number().int().nonnegative(),
    evidenceIds: z.array(z.string()), questionAudioUrl: z.string(), acknowledgement: z.string().nullable(), acknowledgementAudioUrl: z.string().nullable(), interviewerId: z.string(),
    metadata: z.object({ rulesVersion: z.string(), generatedAt: z.string() }).passthrough(),
    answerId: z.string().optional(), rawTranscript: z.string().optional(), transcriptStatus: z.enum(['streaming', 'paused', 'finalized', 'error']).optional(),
  }).passthrough()),
  followUpCountByMainQuestion: z.record(z.string(), z.number().int().nonnegative()), elapsedMs: z.number().finite().nonnegative(),
}).passthrough();
export const authenticatedSessionEnvelopeSchema = z.object({
  version: z.literal(AUTHENTICATED_SESSION_ENVELOPE_VERSION),
  sessionJson: z.string().min(2), sessionSha256: hex,
  contextJson: z.string().min(2), contextSha256: hex,
}).strict();
export type AuthenticatedSessionEnvelope = z.infer<typeof authenticatedSessionEnvelopeSchema>;
export class AuthenticatedSessionCodecError extends Error {
  constructor(readonly code: 'AUTH_SESSION_ENVELOPE_INVALID' | 'AUTH_SESSION_BYTES_CHANGED' | 'AUTH_SESSION_CONTEXT_CHANGED' | 'AUTH_SESSION_OWNER_MISMATCH') { super(code); this.name = 'AuthenticatedSessionCodecError'; }
}
/** No owner default, ownership minting, JSON normalization or local fallback. */
export function decodeAuthenticatedSessionEnvelope(value: unknown, expectedOwnerId: string) {
  const result = authenticatedSessionEnvelopeSchema.safeParse(value);
  if (!result.success || !expectedOwnerId || expectedOwnerId !== expectedOwnerId.trim()) throw new AuthenticatedSessionCodecError('AUTH_SESSION_ENVELOPE_INVALID');
  const envelope = value as AuthenticatedSessionEnvelope;
  if (Buffer.byteLength(envelope.sessionJson) > 8 * 1024 * 1024 || Buffer.byteLength(envelope.contextJson) > 8 * 1024 * 1024 ||
    hash(envelope.sessionJson) !== envelope.sessionSha256 || hash(envelope.contextJson) !== envelope.contextSha256) throw new AuthenticatedSessionCodecError('AUTH_SESSION_BYTES_CHANGED');
  let parsed: unknown, context: InterviewContext;
  try { parsed = JSON.parse(envelope.sessionJson); context = JSON.parse(envelope.contextJson) as InterviewContext; }
  catch { throw new AuthenticatedSessionCodecError('AUTH_SESSION_ENVELOPE_INVALID'); }
  if (!authenticatedSessionProjectionSchema.safeParse(parsed).success) throw new AuthenticatedSessionCodecError('AUTH_SESSION_ENVELOPE_INVALID');
  const session = parsed as InterviewSession;
  try { assertAuthenticatedSessionOwner(session, expectedOwnerId); }
  catch { throw new AuthenticatedSessionCodecError('AUTH_SESSION_OWNER_MISMATCH'); }
  if (session.runtime!.contextSnapshotSha256 !== hash(JSON.stringify(context)) || !context || typeof context !== 'object' ||
    !context.manifest || session.runtime!.engineVersion !== context.manifest.rulesVersion) throw new AuthenticatedSessionCodecError('AUTH_SESSION_CONTEXT_CHANGED');
  // Return originals rather than Zod's projection: property order, optional
  // presence, numeric spelling and CRLF in either raw JSON string remain exact.
  return { envelope, session, context };
}
export function encodeAuthenticatedSessionEnvelope(session: InterviewSession, context: InterviewContext): AuthenticatedSessionEnvelope {
  const sessionJson = JSON.stringify(session), contextJson = JSON.stringify(context);
  const envelope: AuthenticatedSessionEnvelope = { version: AUTHENTICATED_SESSION_ENVELOPE_VERSION, sessionJson, sessionSha256: hash(sessionJson), contextJson, contextSha256: hash(contextJson) };
  decodeAuthenticatedSessionEnvelope(envelope, session.runtime?.owner.id ?? '');
  return envelope;
}
