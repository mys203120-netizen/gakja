import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { InterviewSession, RecordedTurn } from './protocol';
import type { SingleCoreCandidateResult } from './providers/single-core-runtime';
import { playbackEventBatchSchema } from '../lib/interview/client-event-contract';

export const answerEndingObservationSchema = z.object({
  stopSource: z.enum(['space', 'button', 'session_end']),
  lastSpeechMs: z.number().finite().nonnegative().nullable(),
  trailingSilenceMs: z.number().finite().nonnegative().nullable(),
  speechActiveAtEnd: z.boolean().nullable(),
  vadAvailable: z.boolean(),
  microphoneEnabled: z.boolean().optional(),
  tailDrainMs: z.number().finite().nonnegative().optional(),
  requestedAtMs: z.number().finite().nonnegative().optional(),
}).strict();
export type AnswerEndingObservation = z.infer<typeof answerEndingObservationSchema>;
export const answerCandidateRequestSchema = z.object({
  turnId: z.string().uuid(), answerId: z.string().min(1).max(160), captureRevision: z.number().int().positive(),
  elapsedMs: z.number().finite().min(0).max(86_400_000), metrics: z.unknown().optional(),
  endingObservation: answerEndingObservationSchema,
  clientEvents: playbackEventBatchSchema.optional(),
  submissionAttemptId: z.string().uuid().optional(),
});
export interface AnswerCandidateState {
  id: string; turnId: string; answerId: string; captureRevision: number; sourceTranscriptSha256: string;
  status: 'deciding' | 'continuing' | 'advance_ready' | 'advancing' | 'committed' | 'failed';
  createdAt: string; endingObservation: AnswerEndingObservation; decision?: SingleCoreCandidateResult;
}
export const transcriptHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** This gate inspects identity/commit state only, never words or sufficiency. */
export function assertCaptureMayStart(session: InterviewSession, turn: RecordedTurn) {
  if (session.runtime?.endRequestedAt) throw new Error('ANSWER_ADVANCE_LOCKED');
  const operation = turn.answerId ? session.runtime?.operations[`${session.id}:${turn.id}:${turn.answerId}`] : undefined;
  if (operation && ['running', 'committed'].includes(operation.status) || turn.transcriptStatus === 'finalized' || turn.transcriptStatus === 'streaming' ||
    ['deciding', 'advance_ready', 'advancing', 'committed'].includes(turn.metadata.answerCommitStatus ?? '')) throw new Error('ANSWER_ADVANCE_LOCKED');
}
export function assertCandidateSource(turn: RecordedTurn, candidate: AnswerCandidateState) {
  if (candidate.turnId !== turn.id || candidate.answerId !== turn.answerId || candidate.captureRevision !== turn.metadata.answerCaptureRevision ||
    candidate.sourceTranscriptSha256 !== transcriptHash(turn.rawTranscript ?? '')) throw new Error('ANSWER_CANDIDATE_SOURCE_CHANGED');
}
/** A recovered partial transcript is not a provider-confirmed capture. */
export function assertCaptureConfirmed(turn: RecordedTurn) {
  const part = turn.metadata.captureParts?.find(row => row.streamId === turn.metadata.lastStreamId && row.captureRevision === turn.metadata.answerCaptureRevision);
  if (!part || part.sha256 !== transcriptHash(part.rawTranscript)) throw new Error('CAPTURE_FINAL_NOT_CONFIRMED');
}
export function capturePart(turn: RecordedTurn, streamId: string, text: string) {
  const existing = turn.metadata.captureParts?.find(part => part.streamId === streamId);
  const sha256 = transcriptHash(text);
  if (existing) { if (existing.sha256 !== sha256) throw new Error('CAPTURE_PART_CHANGED'); return; }
  turn.metadata.captureParts = [...(turn.metadata.captureParts ?? []), { streamId, captureRevision: turn.metadata.answerCaptureRevision ?? 0,
    rawTranscript: text, sha256, endedAt: new Date().toISOString() }];
}
