import { createHash } from 'node:crypto';
import { loadInterviewContextAt, type InterviewContext, type InterviewContextReadOptions, type StudentEvidence } from './load-interview-context';
import { loadStagedFullStudentAnalysisSnapshot } from './full-student-analysis';
import { projectPreparedActivities } from './prepared-activities';
import { buildStudentTrajectory, createStudentObjectiveCandidates } from '../question-objective';
import { verifyStudentSourceText } from './verify-student-source';
import { emptyReadScope, assertReadOwner } from '../repositories/analysis-read-ports';
import { createLocalReadRepositories } from '../repositories/local-read-repositories';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Build the exact context a staged revision will expose after activation, without
 * changing the analysis pointer or saving the overlay as the current manifest. */
export async function loadStagedInterviewContextAt(root: string, revisionPath: string, options: InterviewContextReadOptions = {}) {
  const repositories = options.repositories ?? createLocalReadRepositories(root);
  const scope = { ...emptyReadScope(repositories.ownerId), ...options.scope }, purpose = options.purpose ?? 'staged-context';
  assertReadOwner(repositories, scope);
  const readOptions = { repositories, scope, purpose };
  const base = await loadInterviewContextAt(root, { ...options, ...readOptions });
  const unrelatedErrors = base.errors.filter(error => !/^(?:FULL_ANALYSIS|FULL_STUDENT_ANALYSIS|ANALYSIS_)/u.test(error));
  if (unrelatedErrors.length) throw new Error('STAGED_CONTEXT_SOURCE_INVALID');
  const context = structuredClone(base);
  context.errors = [...unrelatedErrors]; context.manifest.errors = context.errors;
  const readPinned = async (role: string) => {
    const pin = base.manifest.files.find(file => file.role === role);
    if (!pin?.sha256) throw new Error('STAGED_CONTEXT_PIN_MISSING');
    const { bytes } = await repositories.source.readPinnedInput({ scope, purpose, pin });
    if (sha(bytes) !== pin.sha256) throw new Error('STAGED_CONTEXT_SOURCE_CHANGED');
    return bytes;
  };
  const [snapshot, originalStudentBytes, pdf] = await Promise.all([loadStagedFullStudentAnalysisSnapshot(base, revisionPath, root, readOptions), readPinned('preparedStudent'), readPinned('studentPdf')]);
  const staged = snapshot.analysis;
  const originalStudent = JSON.parse(originalStudentBytes.toString('utf8')) as InterviewContext['student'];
  const supplement: StudentEvidence[] = originalStudent.evidence.flatMap(legacy => {
    const activity = staged.common.activities.find(activity => activity.id === legacy.activityId && activity.mergedFromLegacyIds.includes(legacy.activityId));
    const proofs = activity ? Object.values(activity.facts).flat() : [];
    if (!activity || !proofs.length || !proofs.every(proof => proof.page === legacy.page && proof.pageStart >= legacy.sourceRef.startOffset && proof.pageEnd <= legacy.sourceRef.endOffset && legacy.text.slice(proof.pageStart - legacy.sourceRef.startOffset, proof.pageEnd - legacy.sourceRef.startOffset) === proof.quote) || legacy.sourceRef.pdfSha256 !== originalStudent.pdfSha256 || legacy.text.length > 2200) return [];
    return [{ ...structuredClone(legacy), sourceKind: 'activity', originEntityId: activity.id, projectionProvenance: { kind: 'legacy_verified_range_same_declared_activity_id', legacyEvidenceId: legacy.id, analysisRevision: staged.common.revision }, sourceRef: { ...legacy.sourceRef, sourceRefId: legacy.id, recordRevision: staged.common.recordRevision } }];
  });
  const evidence = [...staged.evidence, ...supplement.filter(row => !staged.evidence.some(item => item.id === row.id))];
  if (!originalStudent.pageCount || !await verifyStudentSourceText(pdf, evidence, originalStudent.pageCount)) throw new Error('FULL_ANALYSIS_PDF_TEXT_MISMATCH');
  context.studentAnalysis = staged.common; context.targetAnalysis = staged.target;
  context.student = { ...originalStudent, studentId: staged.common.studentId, recordRevision: staged.common.recordRevision, analysisRevision: staged.common.revision, evidence, schemaVersion: 'full-record-analysis-evidence-v1', extractionStatus: staged.common.coverage.needsReviewSourceCount ? 'full_document_extracted_partially_structured' : 'full_document_source_bound_structure', limitations: [...staged.common.limitations] };
  if (!await repositories.analysis.analysisDocumentUnchanged({ scope, purpose, captured: snapshot.document })) throw new Error('FULL_ANALYSIS_MANIFEST_REVISION_CHANGED');
  const analysisPath = snapshot.document.path.replace(/\\/gu, '/'), analysisBytes = snapshot.document.bytes;
  const envelope = snapshot.document.value;
  if (envelope.common.contentSha256 !== staged.common.contentSha256 || envelope.target.contentSha256 !== staged.target.contentSha256 || sha(JSON.stringify(envelope.evidence)) !== sha(JSON.stringify(staged.evidence))) throw new Error('FULL_ANALYSIS_MANIFEST_REVISION_CHANGED');
  context.manifest.files = context.manifest.files.filter(file => file.role !== 'fullStudentAnalysis');
  context.manifest.files.push({ role: 'fullStudentAnalysis', path: analysisPath, sha256: sha(analysisBytes) });
  Object.assign(context.manifest.recordIds, { studentId: staged.common.studentId, recordRevision: staged.common.recordRevision, studentAnalysisRevision: staged.common.revision, targetAnalysisRevision: staged.target.revision, commonAnalysisContentSha256: staged.common.contentSha256, targetAnalysisContentSha256: staged.target.contentSha256, admissionProfileRevision: staged.target.profileRevision, evidenceProjectionVersion: 'analysis-and-explicit-legacy-range-v1', verifiedLegacySupplementCount: String(supplement.length) });
  context.manifest.evidenceIds = evidence.map(row => row.id);
  Object.assign(context.manifest.sourceIntegrity, { evidenceCount: evidence.length, fullDocumentExtracted: true, sourceBlocksAccountedFor: staged.common.coverage.allSourceBlocksAccountedFor, independentSemanticReview: false });
  context.preparedActivities = projectPreparedActivities(context, staged.common);
  context.studentObjectives = createStudentObjectiveCandidates(context, context.preparedActivities);
  context.studentTrajectory = buildStudentTrajectory(context);
  return { context, staged };
}
