import type { AuthenticatedRequestContext } from '../auth/request-identity';
import type { SessionAccessBinding } from '../request-realtime-server';

/** An explicitly isolated composition. No local SessionStore or operational
 * fallback is available through this interface. JSON envelopes are validated
 * again by the command service and database; client owner/role is never used. */
export interface ServiceSessionMutations {
  readonly kind: 'isolated-db-session-writer';
  create(context: AuthenticatedRequestContext, input: unknown): Promise<unknown>;
  read(context: AuthenticatedRequestContext, binding: SessionAccessBinding): Promise<unknown>;
  context(context: AuthenticatedRequestContext, binding: SessionAccessBinding): Promise<unknown>;
  command(context: AuthenticatedRequestContext, binding: SessionAccessBinding, action: string, input: unknown): Promise<unknown>;
  receipt(context: AuthenticatedRequestContext, binding: SessionAccessBinding, query: { key: string; inputSha256: string }): Promise<unknown>;
  connect(context: AuthenticatedRequestContext, binding: SessionAccessBinding): Promise<{ writerGeneration: string; connectionToken: string }>;
  assertSocketCurrent(context: AuthenticatedRequestContext, binding: SessionAccessBinding, writerGeneration: string): Promise<void>;
  socket(context: AuthenticatedRequestContext, binding: SessionAccessBinding, writerGeneration: string, message: unknown, connectionToken: string): Promise<unknown>;
  audio(context: AuthenticatedRequestContext, binding: SessionAccessBinding, writerGeneration: string, bytes: Buffer, connectionToken: string): Promise<void>;
  disconnect(context: AuthenticatedRequestContext, binding: SessionAccessBinding, writerGeneration: string, connectionToken: string): Promise<void>;
}
