import { createHash } from 'node:crypto';
import type { InterviewContext } from './data/load-interview-context';
import type { InterviewSession, RecordedTurn } from './protocol';
import type { SessionStore } from './storage/session-store';
import { compilePolicyClauseRegistry, COMPILED_RUNTIME_POLICY_VERSION } from './policy/compiled-runtime-policy';

export const SESSION_RUNTIME_VERSION = 'session-runtime-v1';
export const AUTHENTICATED_SESSION_RUNTIME_VERSION = 'authenticated-session-runtime-v1';
export const SESSION_RECOVERY_WINDOW_MS = 10 * 60_000;
export const localDevelopmentOwner = () => ({ id: process.env.LOCAL_INTERVIEW_OWNER_ID?.trim() || 'local-development-owner', mode: 'local-development' as const });
export const snapshotHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ClosingUtterance {
  id: string; text: string; audioUrl: string; interviewerId: string; nonEvaluative: true;
  reason: 'time_expired' | 'user_ended' | 'candidate_exhausted' | 'technical_failure';
  voiceSettings?: { speaker: string; speed: number; pitch: number; volume: number; format: string };
}
export interface PersistedNextResult { turn: RecordedTurn | null; done: boolean; closingUtterance?: ClosingUtterance }
export interface SessionRuntimeCommon {
  engineVersion: string; contextSnapshotSha256: string; epoch: number;
  runtimePolicy?: { mode: 'compiled' | 'full'; version: string; registrySha256: string | null };
  checkpoint: { phase: string; at: string; turnId: string | null; answerId: string | null; disconnectedAt?: string; deliveryUncertain?: boolean };
  operations: Record<string, { status: 'running' | 'committed' | 'blocked' | 'retryable'; startedAt: string; epoch: number; prepared?: unknown; retiredPrepared?: unknown[]; acknowledgementDelivery?: { startedAt?: string; completedAt?: string }; failureCode?: 'PREPARATION_REQUIRED' | 'QUESTION_PROVIDER_UNAVAILABLE' | 'QUESTION_REVIEW_UNAVAILABLE' | 'QUESTION_REPAIR_RECOVERY_UNAVAILABLE'; result?: PersistedNextResult }>;
  answerCandidates?: Record<string, import('./answer-candidate-state').AnswerCandidateState>;
  submissionAttempts?: Record<string, import('./submission-work').SubmissionWorkRecord>;
  endRequestedAt?: string;
  /** First accepted end payload survives a retry/restart while STT is draining. */
  acceptedEndRequest?: { elapsedMs: number; metrics: Record<string, unknown> };
  /** Durable evaluation revision, independent of later model configuration changes. */
  evaluationJob?: { id: string; pipelineVersion: string; sourceSha256: string; model: string };
  /** First accepted end input is immutable across retries and delayed browser events. */
  evaluationInputFrozenAt?: string;
  closingUtterance?: ClosingUtterance;
  closingDelivery?: { startedAt?: string; completedAt?: string; interrupted?: boolean };
  opening?: { id: string; questionTurnId: string; text: string; audioUrl: string; interviewerId: string; delivery?: { startedAt?: string; completedAt?: string } };
  firstEvaluationDelivery?: { eventId: string; turnId: string; observedAt: string; clockId: string; status: 'normal_delivery_observed'; entitlementLedgerImplemented: false };
}
export interface LocalSessionRuntimeState extends SessionRuntimeCommon {
  version: typeof SESSION_RUNTIME_VERSION;
  owner: { id: string; mode: 'local-development' };
}
export interface AuthenticatedSessionRuntimeState extends SessionRuntimeCommon {
  version: typeof AUTHENTICATED_SESSION_RUNTIME_VERSION;
  owner: { id: string; mode: 'authenticated' };
  /** The capture owner received the ordered end marker and owns the bounded
   * external drain. Other servers wait for its durable finalization receipt. */
  endCaptureDrain?: { intentId: string; streamId: string; turnId: string; answerId: string; captureRevision: number; markerReceivedAt: string; providerDeadlineAt: string };
}
export type SessionRuntimeState = LocalSessionRuntimeState | AuthenticatedSessionRuntimeState;
function runtimeState(context: InterviewContext, now: string): SessionRuntimeCommon {
  const registry = context.interviewerPolicy ? compilePolicyClauseRegistry(context) : null;
  return { engineVersion: context.manifest.rulesVersion, contextSnapshotSha256: snapshotHash(context), epoch: 0,
    runtimePolicy: { mode: 'compiled', version: COMPILED_RUNTIME_POLICY_VERSION, registrySha256: registry?.contentSha256 ?? null },
    checkpoint: { phase: 'prepared', at: now, turnId: null, answerId: null }, operations: {} };
}
export function createSessionRuntime(context: InterviewContext, owner = localDevelopmentOwner(), now = new Date().toISOString()): LocalSessionRuntimeState {
  return { version: SESSION_RUNTIME_VERSION, owner, ...runtimeState(context, now) };
}
/** The caller gets ownerId from A/B authority; this function does not mint it. */
export function createAuthenticatedSessionRuntime(context: InterviewContext, ownerId: string, now = new Date().toISOString()): AuthenticatedSessionRuntimeState {
  if (!ownerId || ownerId !== ownerId.trim()) throw new Error('AUTHENTICATED_SESSION_OWNER_REQUIRED');
  return { version: AUTHENTICATED_SESSION_RUNTIME_VERSION, owner: { id: ownerId, mode: 'authenticated' }, ...runtimeState(context, now) };
}
export function assertSessionOwner(session: InterviewSession, ownerId: string) {
  if (!session.runtime || session.runtime.version !== SESSION_RUNTIME_VERSION || session.runtime.owner.mode !== 'local-development' || session.runtime.owner.id !== ownerId) throw new Error('SESSION_OWNER_MISMATCH');
}
export function assertRecoverableSession(session: InterviewSession, ownerId: string, now = Date.now()) {
  assertSessionOwner(session, ownerId);
  assertSessionRecoveryWindow(session, now);
}
/** Shared existing 10-minute policy; DB generation remains a separate fence. */
export function assertSessionRecoveryWindow(session: InterviewSession, now = Date.now()) {
  if (session.status !== 'active') return;
  const checkpoint = session.runtime!.checkpoint;
  const interruptedAt = Date.parse(checkpoint.disconnectedAt ?? checkpoint.at);
  if (!Number.isFinite(interruptedAt) || now - interruptedAt > SESSION_RECOVERY_WINDOW_MS || now < interruptedAt) throw new Error('SESSION_RECOVERY_EXPIRED');
}
/** A new socket is required. A saved partial text is preserved, never promoted to final. */
export function restoreLogicalSession(session: InterviewSession, ownerId: string, now = Date.now()) {
  assertRecoverableSession(session, ownerId, now);
  return restoreSessionRuntimeState(session);
}
export function assertAuthenticatedSessionOwner(session: InterviewSession, ownerId: string) {
  if (session.runtime?.version !== AUTHENTICATED_SESSION_RUNTIME_VERSION || session.runtime.owner.mode !== 'authenticated' || session.runtime.owner.id !== ownerId) throw new Error('AUTHENTICATED_SESSION_OWNER_MISMATCH');
}
export function restoreAuthenticatedSession(session: InterviewSession, ownerId: string, now = Date.now()) {
  assertAuthenticatedSessionOwner(session, ownerId);
  assertSessionRecoveryWindow(session, now);
  return restoreSessionRuntimeState(session);
}
function restoreSessionRuntimeState(session: InterviewSession) {
  const restored = structuredClone(session);
  if (restored.status === 'active') {
    restored.runtime!.epoch++;
    const current = restored.turns.at(-1);
    if (current?.transcriptStatus === 'streaming') current.transcriptStatus = 'paused';
    restored.runtime!.checkpoint.deliveryUncertain = Boolean(current && !restored.questionPresentations?.some(event => event.turnId === current.id && event.completedAtMs !== null && !event.interrupted));
    for (const operation of Object.values(restored.runtime!.operations)) if (operation.status === 'running') operation.epoch = restored.runtime!.epoch;
  }
  return restored;
}
export function checkpointSession(session: InterviewSession, phase: string, now = new Date().toISOString()) {
  if (!session.runtime) return;
  const current = session.turns.at(-1);
  session.runtime.checkpoint = { ...session.runtime.checkpoint, phase, at: now, turnId: current?.id ?? null, answerId: current?.answerId ?? null };
}
/** Persist the current snapshot without renewing its checkpoint/recovery window. */
export async function saveSessionSnapshot(session: InterviewSession, store: Pick<SessionStore, 'save'>, now = new Date().toISOString()) {
  session.updatedAt = now;
  await store.save(session);
}
export function recoveryProjection(session: InterviewSession) {
  const current = session.turns.at(-1);
  return { available: Boolean(session.runtime), phase: session.runtime?.checkpoint.phase ?? 'legacy_read_only', epoch: session.runtime?.epoch ?? null,
    currentTurn: current ?? null, elapsedMs: session.elapsedMs, transcript: current?.rawTranscript ?? '', transcriptStatus: current?.transcriptStatus ?? null,
    answerId: current?.answerId ?? null, deliveryUncertain: session.runtime?.checkpoint.deliveryUncertain ?? false,
    captureRevision: current?.metadata.answerCaptureRevision ?? 0,
    answerCommitStatus: current?.metadata.answerCommitStatus ?? (current?.transcriptStatus === 'finalized' ? 'committed' : 'capturing'),
    candidateId: current?.metadata.answerCandidateId,
    endingObservation: current?.metadata.answerEndingObservation,
    closingUtterance: session.runtime?.closingUtterance ?? null,
    closingDelivered: Boolean(session.runtime?.closingDelivery?.completedAt),
    limitations: ['음성 인식 연결은 새로 생성합니다.', '저장하지 않은 음성과 미확정 음성 구간은 복원하지 않습니다.', '관찰하지 못한 재생 완료는 확정하지 않습니다.'] };
}
