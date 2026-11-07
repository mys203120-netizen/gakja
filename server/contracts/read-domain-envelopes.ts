import type { AnalysisReadOptions } from '../repositories/analysis-read-ports';
import type { BankOptions } from '../data/prepared-question-bank';
import type { InterviewContext } from '../data/load-interview-context';
import { loadFullRecord } from '../data/full-student-analysis';
import { readVerifiedQuestionDomainExport } from './question-domain-adapters';
import { createDomainEnvelope, emptyDomainScope, type DomainEnvelope } from './domain-envelope';

/** Read-only bridge for a future Python consumer. Current loaders still verify
 * their authoritative TS codecs and bank/source provenance first. No writer,
 * approval issuer, active pointer change or DB conversion is introduced. */
export async function readExistingDomainEnvelopes(context: InterviewContext, options: { ownerId: string; root?: string; readOptions?: AnalysisReadOptions; bankOptions?: BankOptions }) {
  if(options.readOptions?.repositories?.kind==='shadow'&&(!options.bankOptions?.readOnly||options.bankOptions.readOptions?.repositories!==options.readOptions.repositories))throw new Error('SHADOW_BANK_READER_REQUIRED');
  const root = options.root ?? process.cwd();
  const verified = await readVerifiedQuestionDomainExport(context, { ownerId: options.ownerId, root, bankOptions: options.bankOptions });
  const source = await loadFullRecord(root, context.student.pdfSha256, options.readOptions);
  if (source && source.studentId !== verified.scope.studentId) throw new Error('DOMAIN_SOURCE_STUDENT_MISMATCH');
  if (context.studentAnalysis && context.targetAnalysis && context.targetAnalysis.commonAnalysisRevision !== context.studentAnalysis.revision) throw new Error('DOMAIN_COMMON_TARGET_REVISION_MISMATCH');
  const scope = { ...emptyDomainScope(), ownerId: verified.scope.ownerId, studentId: verified.scope.studentId,
    supportTargetId: verified.scope.supportTargetId, sourceRevision: source?.revision ?? null,
    recordRevision: source?.recordRevision ?? null, sourceContentSha256: source?.contentSha256 ?? null,
    analysisRevision: context.studentAnalysis?.revision ?? null, profileRevision: context.targetAnalysis?.profileRevision ?? null,
    bankKey: verified.scope.bankKey };
  const envelopes: DomainEnvelope[] = [];
  if (context.studentAnalysis) envelopes.push(createDomainEnvelope('full-student-analysis', context.studentAnalysis, scope));
  if (context.targetAnalysis) envelopes.push(createDomainEnvelope('target-student-analysis', context.targetAnalysis,
    { ...scope, analysisRevision: context.targetAnalysis.analysisRevision }));
  for (const objective of verified.objectives) envelopes.push(createDomainEnvelope('student-objective-candidate', objective,
    { ...scope, analysisRevision: objective.analysisRevision ?? scope.analysisRevision }));
  for (const candidate of verified.candidates) {
    envelopes.push(createDomainEnvelope('prepared-main-candidate', candidate, scope));
    if (candidate.draft.approvedQuestion) envelopes.push(createDomainEnvelope('approved-question-contract', candidate.draft.approvedQuestion, scope, { draft: candidate.draft }));
  }
  await options.readOptions?.repositories?.assertSnapshotUnchanged?.();
  return { version: 'existing-domain-read-bridge-v1', scope, envelopes, questionVerification: verified.verification,
    analysisActivation: false, evaluationApprovalGranted: false, writes: 0, providerCalls: 0 };
}
