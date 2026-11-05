import type { InterviewContext } from '../data/load-interview-context';
import { freezeKnowledge, knowledgeHash } from '../data/approved-knowledge';

export const EVALUATION_SCOPE_POLICY_VERSION = 'question-evaluation-spec-policy-v1';
/** Identity metadata only. Neither this object nor a question label grants an
 * evaluation scope, a human approval or scientific truth authority. */
export interface EvaluationScopePolicy {
  version: typeof EVALUATION_SCOPE_POLICY_VERSION;
  questionPolicySha256: string; rubricSha256: string; sourceManifestSha256: string;
  contentSha256: string;
}
export function compileEvaluationScopePolicy(context: InterviewContext): EvaluationScopePolicy {
  const body: Omit<EvaluationScopePolicy, 'contentSha256'> = { version: EVALUATION_SCOPE_POLICY_VERSION,
    questionPolicySha256: knowledgeHash(context.questionGuidelines ?? ''), rubricSha256: knowledgeHash(context.evaluationGuidelines ?? ''),
    sourceManifestSha256: knowledgeHash(JSON.stringify(context.manifest)) };
  return freezeKnowledge({ ...body, contentSha256: knowledgeHash(JSON.stringify(body)) });
}
