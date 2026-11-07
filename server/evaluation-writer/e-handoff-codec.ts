import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AUTHENTICATED_SESSION_ENVELOPE_VERSION, decodeAuthenticatedSessionEnvelope } from '../contracts/authenticated-session-codec';
import { EVALUATION_PIPELINE_VERSION, evaluationSessionSourceFingerprint } from '../providers/evaluation-input';
import type { SessionCommandSnapshot } from '../session-writer/session-command-ports';
import { EvaluationWriterError } from './evaluation-writer-ports';

export const SESSION_EVALUATION_HANDOFF_VERSION = 'session-evaluation-handoff-v1';
const hex = z.string().regex(/^[a-f0-9]{64}$/u);
const identifier = z.string().min(1).max(300);
export const sessionEvaluationHandoffPayloadSchema = z.object({
  version: z.literal(SESSION_EVALUATION_HANDOFF_VERSION), sessionId: z.string().uuid(), ownerId: identifier,
  studentId: identifier, applicationTargetId: identifier, supportTargetId: identifier,
  acceptedEndIntentId: z.string().uuid(), acceptedEndInputSha256: hex,
  contextSnapshotSha256: hex, frozenSessionSha256: hex, evaluationSourceSha256: hex,
  model: z.string().min(1), pipelineVersion: z.string().min(1),
  sessionJson: z.string().min(2), contextJson: z.string().min(2), pinsJson: z.string().min(2),
  state: z.literal('awaiting-evaluation-consumer'), evaluationApprovalGranted: z.literal(false),
}).strict();
export type SessionEvaluationHandoffPayload = z.infer<typeof sessionEvaluationHandoffPayloadSchema>;
export const evaluationTextSha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const denied = (code: string): never => { throw new EvaluationWriterError(409, code); };

/** Read the immutable E contract. Nothing here mints an owner, approves a
 * reviewer, rewrites E JSON, or replaces it with today's context/session. */
export function decodeSessionEvaluationHandoff(snapshot: SessionCommandSnapshot) {
  const handoff = snapshot.handoff, ending = snapshot.endIntent, binding = snapshot.binding;
  if (!snapshot.created || !handoff || !ending || handoff.version !== SESSION_EVALUATION_HANDOFF_VERSION ||
    handoff.state !== 'awaiting-evaluation-consumer') return denied('F_HANDOFF_NOT_READY');
  if (!/^\d+$/u.test(handoff.committedRevision) || !/^\d+$/u.test(ending.acceptedRevision) || !/^\d+$/u.test(snapshot.revision) ||
    BigInt(ending.acceptedRevision) >= BigInt(handoff.committedRevision) || BigInt(handoff.committedRevision) > BigInt(snapshot.revision)) return denied('F_HANDOFF_REVISION_CHANGED');
  if (evaluationTextSha256(handoff.payloadJson) !== handoff.payloadSha256 || evaluationTextSha256(ending.inputJson) !== ending.inputSha256 ||
    evaluationTextSha256(snapshot.sessionJson) !== snapshot.sessionSha256 || evaluationTextSha256(snapshot.contextJson) !== snapshot.contextSnapshotSha256 ||
    evaluationTextSha256(snapshot.pinsJson) !== snapshot.pinsSha256) return denied('F_HANDOFF_RAW_BYTES_CHANGED');
  let payload: SessionEvaluationHandoffPayload;
  try {
    const value: unknown = JSON.parse(handoff.payloadJson);
    if (!sessionEvaluationHandoffPayloadSchema.safeParse(value).success) return denied('F_HANDOFF_PAYLOAD_INVALID');
    // Keep the original parsed values and raw TEXT, not Zod's projection.
    payload = value as SessionEvaluationHandoffPayload;
  } catch (cause) {
    if (cause instanceof EvaluationWriterError) throw cause;
    return denied('F_HANDOFF_PAYLOAD_INVALID');
  }
  if (payload.sessionId !== binding.sessionId || payload.ownerId !== binding.ownerId || payload.studentId !== binding.studentId ||
    payload.applicationTargetId !== binding.applicationTargetId || payload.supportTargetId !== binding.supportTargetId ||
    payload.acceptedEndIntentId !== ending.intentId || payload.acceptedEndIntentId !== handoff.intentId || payload.acceptedEndInputSha256 !== ending.inputSha256 ||
    payload.contextSnapshotSha256 !== snapshot.contextSnapshotSha256 || handoff.contextSnapshotSha256 !== snapshot.contextSnapshotSha256 ||
    binding.contextSnapshotSha256 !== snapshot.contextSnapshotSha256 || payload.frozenSessionSha256 !== handoff.frozenSessionSha256 ||
    payload.frozenSessionSha256 !== snapshot.sessionSha256 || payload.sessionJson !== snapshot.sessionJson ||
    payload.contextJson !== snapshot.contextJson || payload.pinsJson !== snapshot.pinsJson) return denied('F_HANDOFF_BINDING_CHANGED');
  let decoded: ReturnType<typeof decodeAuthenticatedSessionEnvelope>;
  let pins: Record<string, unknown>;
  try {
    decoded = decodeAuthenticatedSessionEnvelope({ version: AUTHENTICATED_SESSION_ENVELOPE_VERSION,
      sessionJson: payload.sessionJson, sessionSha256: payload.frozenSessionSha256,
      contextJson: payload.contextJson, contextSha256: payload.contextSnapshotSha256 }, binding.ownerId);
    const rawPins: unknown = JSON.parse(payload.pinsJson);
    if (!rawPins || typeof rawPins !== 'object' || Array.isArray(rawPins)) return denied('F_HANDOFF_DOMAIN_INVALID');
    pins = rawPins as Record<string, unknown>;
  } catch { return denied('F_HANDOFF_DOMAIN_INVALID'); }
  const { session, context } = decoded;
  if (session.status === 'active' || !session.runtime?.evaluationInputFrozenAt || session.runtime.evaluationJob ||
    JSON.stringify(session.runtime.acceptedEndRequest) !== ending.inputJson || session.runtime.contextSnapshotSha256 !== payload.contextSnapshotSha256 ||
    (context.student.studentId ?? context.studentAnalysis?.studentId ?? null) !== binding.studentId ||
    (context.targetAnalysis?.supportTargetId ?? context.school.interview?.id ?? null) !== binding.supportTargetId) return denied('F_HANDOFF_FROZEN_INPUT_CHANGED');
  const authority = pins.sessionAuthority as Record<string, unknown> | undefined;
  const models = pins.models as Record<string, unknown> | undefined;
  // E pins the selected access grant separately from the enrolled source.
  // An absent grant revision allows sources in that scope (A/B can_target),
  // whereas an explicit null/string constrains the document binding. Never
  // insert a missing property or rewrite either original representation.
  const sourcePresent = Object.hasOwn(binding, 'sourceRevision');
  if (sourcePresent && binding.sourceRevision !== null &&
    (typeof binding.sourceRevision !== 'string' || !binding.sourceRevision || binding.sourceRevision !== binding.sourceRevision.trim()))
    return denied('F_HANDOFF_PINS_CHANGED');
  if (!authority || authority.sessionId !== binding.sessionId || authority.ownerId !== binding.ownerId || authority.studentId !== binding.studentId ||
    authority.applicationTargetId !== binding.applicationTargetId || authority.supportTargetId !== binding.supportTargetId ||
    Object.hasOwn(authority, 'sourceRevision') && (!sourcePresent || authority.sourceRevision !== binding.sourceRevision) ||
    Object.hasOwn(pins, 'sourceRevision') && (!sourcePresent || pins.sourceRevision !== binding.sourceRevision) ||
    pins.runtimeVersion !== session.runtime.version || pins.evaluationPipeline !== payload.pipelineVersion || models?.evaluation !== payload.model)
    return denied('F_HANDOFF_PINS_CHANGED');
  if (payload.pipelineVersion !== EVALUATION_PIPELINE_VERSION) return denied('F_HANDOFF_PIPELINE_UNSUPPORTED');
  try {
    if (evaluationSessionSourceFingerprint(context, session, payload.model) !== payload.evaluationSourceSha256) return denied('F_HANDOFF_EVALUATION_SOURCE_CHANGED');
  } catch (cause) {
    if (cause instanceof EvaluationWriterError) throw cause;
    return denied('F_HANDOFF_EVALUATION_SOURCE_CHANGED');
  }
  return { snapshot, handoff, ending, payload, session, context, pins };
}
