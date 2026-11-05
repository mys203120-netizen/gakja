import { z } from 'zod';

export const MAX_PLAYBACK_EVENT_BATCH = 4096;
export const clientConversationEventSchema = z.object({
  eventId: z.string().uuid(),
  type: z.enum(['phase_changed', 'acknowledgement_playing', 'question_playing', 'audio_ended', 'client_error']),
  turnId: z.string().uuid().optional(), phase: z.string().min(1).max(64).optional(),
  atMs: z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER), clockId: z.string().uuid().optional(),
  payload: z.unknown().optional(),
});
export const playbackEventSchema = clientConversationEventSchema.extend({
  type: z.enum(['acknowledgement_playing', 'question_playing', 'audio_ended']),
  turnId: z.string().uuid(), clockId: z.string().uuid(),
});
export const playbackEventBatchSchema = z.array(playbackEventSchema).max(MAX_PLAYBACK_EVENT_BATCH);
export type ClientPlaybackEvent = z.infer<typeof playbackEventSchema>;
export interface ClientEventReceipt { acceptedClientEventIds?: string[] }
