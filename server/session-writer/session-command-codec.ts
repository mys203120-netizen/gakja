import { createHash } from 'node:crypto';
import { z } from 'zod';

export const AUTHENTICATED_SESSION_COMMAND_VERSION = 'authenticated-session-command-v1';
/** Transport envelope only. Each action reuses its existing domain validator.
 * CAS/fence metadata is separate from the exact business-input fingerprint. */
export const authenticatedSessionCommandSchema = z.object({
  version: z.literal(AUTHENTICATED_SESSION_COMMAND_VERSION), key: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/u),
  expectedRevision: z.string().regex(/^\d+$/u), writerGeneration: z.string().regex(/^\d+$/u), resume: z.boolean().optional(), payload: z.unknown(),
}).strict();
export type AuthenticatedSessionCommand = z.infer<typeof authenticatedSessionCommandSchema>;
export const sessionCommandInputSha256 = (action: string, payload: unknown) => createHash('sha256')
  .update(JSON.stringify({ version: AUTHENTICATED_SESSION_COMMAND_VERSION, action, payload })).digest('hex');
