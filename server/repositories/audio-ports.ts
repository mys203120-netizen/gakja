import { emptyReadScope, type ReadScope } from './analysis-read-ports';

/** Carried local ownership/source pins; an audio key is not an authorization. */
export interface AudioScope extends ReadScope { bankKey: string | null; bankContentSha256: string | null }
export const emptyAudioScope = (ownerId: string): AudioScope => ({ ...emptyReadScope(ownerId), bankKey: null, bankContentSha256: null });
export type AudioPurpose = 'speech-cache' | 'question-bank-validation' | 'question-bank-preparation' | 'approved-audio-replay' | 'audio-serving';
export interface AudioReadRequest { id: string; scope: AudioScope; purpose: AudioPurpose }
export interface AudioPublishRequest extends AudioReadRequest {
  bytes: Buffer;
  /** Preserve the two existing writers: background plain write versus offline
   * bank temp/write/rename. Neither implies a distributed transaction. */
  publication: 'speech-cache' | 'bank-atomic';
}
export interface AudioRepository {
  readonly ownerId: string;
  /** Raw durable bytes/errors. Cache hit/miss and integrity decisions stay in
   * the existing cache/bank domain, and never trigger synthesis here. */
  read(request: AudioReadRequest): Promise<Buffer>;
  publish(request: AudioPublishRequest): Promise<void>;
}
export function assertAudioOwner(repository: AudioRepository, scope: AudioScope): void {
  if (!scope.ownerId || scope.ownerId !== repository.ownerId) throw new Error('AUDIO_REPOSITORY_OWNER_MISMATCH');
}
