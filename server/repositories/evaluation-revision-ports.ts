export interface EvaluationRevisionScope { ownerId: string; sessionId: string }
/** Physical revision persistence. The domain still validates exact source,
 * receipt authority, reference hashes and conflicting revision order. */
export interface EvaluationRevisionRepository {
  list(scope: EvaluationRevisionScope): Promise<string[]>;
  read(scope: EvaluationRevisionScope, contentSha256: string): Promise<string>;
  publish(scope: EvaluationRevisionScope, contentSha256: string, value: unknown): Promise<void>;
}
