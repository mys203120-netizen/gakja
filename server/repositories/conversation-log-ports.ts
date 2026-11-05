export interface ConversationLogScope { ownerId: string; sessionId: string }
/** Physical log I/O only. Sequence, deduplication, redaction, malformed rows,
 * optional failure diagnostics and shared queues remain with the logger. */
export interface ConversationLogRepository {
  readonly ownerId: string;
  /** Opaque shared serialization identity. Local adapters return the exact old
   * resolved file identity so different logger instances still share queues. */
  coordinationKey(scope: ConversationLogScope): string;
  ensureDirectory(scope: ConversationLogScope): Promise<void>;
  read(scope: ConversationLogScope): Promise<string>;
  append(request: ConversationLogScope & { text: string }): Promise<void>;
  sync(scope: ConversationLogScope): Promise<void>;
}
