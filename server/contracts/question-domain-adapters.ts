import { createHash } from 'node:crypto';
import path from 'node:path';
import type { InterviewContext } from '../data/load-interview-context';
import { loadQuestionBank, type PreparedQuestionBank } from '../data/prepared-question-bank';
import { createStudentObjectiveCandidates } from '../question-objective';
import { localDevelopmentOwner } from '../session-runtime';
import { decodeApprovedQuestionContract, decodePreparedMainCandidate, decodeStudentObjectiveCandidate, QUESTION_DOMAIN_CODEC_VERSION } from './question-domain-codecs';

export const QUESTION_DOMAIN_EXPORT_VERSION = 'verified-question-domain-export-v1';
/** This adapter uses the existing local server owner boundary. It is not a
 * multi-user authentication implementation; G3 must supply a repository port.
 * Scope metadata never changes the IDs or hashes of the legacy domain payload. */
export async function readVerifiedQuestionDomainExport(context: InterviewContext, options: {
  ownerId: string; root?: string; plan?: PreparedQuestionBank['plan']; environment?: Record<string, string | undefined>;
}) {
  const owner = localDevelopmentOwner();
  if (!options.ownerId || options.ownerId !== owner.id) throw new Error('QUESTION_DOMAIN_EXPORT_OWNER_MISMATCH');
  const studentId = context.student.studentId, supportTargetId = context.targetAnalysis?.supportTargetId ?? context.school.interview?.id;
  if (!studentId || !supportTargetId || context.errors.length) throw new Error('QUESTION_DOMAIN_EXPORT_CONTEXT_UNVERIFIED');
  const bank = await loadQuestionBank(context, { root: path.resolve(options.root ?? process.cwd()), plan: options.plan, environment: options.environment });
  if (!bank) throw new Error('QUESTION_DOMAIN_EXPORT_APPROVED_BANK_REQUIRED');
  const authoritativeObjectives = createStudentObjectiveCandidates(context, context.preparedActivities);
  if (context.studentObjectives && JSON.stringify(context.studentObjectives) !== JSON.stringify(authoritativeObjectives)) throw new Error('QUESTION_DOMAIN_EXPORT_OBJECTIVE_CONTEXT_CHANGED');
  const objectives = (context.studentObjectives ?? authoritativeObjectives).map(decodeStudentObjectiveCandidate);
  const candidates = bank.slots.flatMap(slot => slot.candidates).map(decodePreparedMainCandidate);
  const approvedContracts = candidates.flatMap(candidate => candidate.draft.approvedQuestion
    ? [decodeApprovedQuestionContract(candidate.draft.approvedQuestion, { draft: candidate.draft })] : []);
  return { version: QUESTION_DOMAIN_EXPORT_VERSION, codecVersion: QUESTION_DOMAIN_CODEC_VERSION,
    scope: { ownerId: owner.id, ownerMode: owner.mode, studentId, supportTargetId,
      sourceManifestSha256: createHash('sha256').update(JSON.stringify(context.manifest)).digest('hex'),
      bankKey: bank.key, bankContentSha256: bank.contentSha256, bankSourceFingerprint: bank.sourceFingerprint,
      policyDigest: context.interviewerPolicy?.contentSha256 ?? null },
    objectives, candidates, approvedContracts,
    verification: { existingBankValidatorUsed: true, durableAudioHashesVerified: true, providerCalls: 0,
      questionApprovalIsEvaluationApproval: false, originalFilesModified: false } };
}
