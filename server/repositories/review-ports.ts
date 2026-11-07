/** Raw local review persistence. Domain callers retain schema, signer/actor,
 * owner, exact input, CAS preconditions and latest-revocation authority. */
export interface ReviewRepository {
  readRegistryPointer(): Promise<string>;
  readRegistryRevision(contentSha256: string): Promise<string>;
  ensureRegistryRevisions(): Promise<void>;
  acquireRegistryPublishLock(): Promise<{ release(): Promise<void> }>;
  /** Called inside the existing publish lock after domain CAS validation. */
  writeRegistryRevision(contentSha256: string, content: string): Promise<void>;
  publishRegistryPointer(content: string): Promise<void>;
  readSessionReceipt(receiptSha256: string): Promise<string>;
  writeSessionReceipt(receiptSha256: string, content: string): Promise<void>;
  writeKnowledgeRevision(contentSha256: string, content: string, options?: { encoding?: 'utf8' }): Promise<void>;
  knowledgeRevisionPath(contentSha256: string): string;
  writeEvaluationContext(contentSha256: string, content: string, options?: { encoding?: 'utf8' }): Promise<void>;
  evaluationContextPath(contentSha256: string): string;
}
export type BankScopeRegistryReader = Pick<ReviewRepository, 'readRegistryPointer' | 'readRegistryRevision'>;
