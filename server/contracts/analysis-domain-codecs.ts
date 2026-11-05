/** G2/PR05: schemas describe the existing domain, not a replacement canonical.
 * Validation callers must retain the original object order for legacy hashes. */
import { z } from 'zod';
import { studentAnalysisCodecV2Schema } from '../data/full-student-analysis';
import { studentObjectiveCandidateSchema } from './question-domain-codecs';

export { studentAnalysisCodecV2Schema };
const name = z.string().min(1), sha = z.string().regex(/^[a-f0-9]{64}$/u);
const grade = z.number().int().min(1).max(3).nullable(), semester = z.number().int().min(1).max(2).nullable();
const gradingSystem = z.enum(['nine_grade', 'achievement', 'pass_fail', 'raw_table_unclear']);
export const analysisProofSchema = z.object({ sourceRefId: name, page: z.number().int().positive(), pageStart: z.number().int().nonnegative(), pageEnd: z.number().int().positive(), quote: name, sourceTextSha256: sha }).strict();
const proofs = z.array(analysisProofSchema);
const interpretation = z.object({ field: z.string(), text: z.string(), basisProofs: proofs, status: z.literal('model_interpretation_not_record_fact') }).strict();
const literal = z.object({ kind: z.literal('academic_literal'), value: z.string(), valueProof: analysisProofSchema,
  provenance: z.object({ rowIndex: z.number().int().nonnegative().nullable(), columnIndex: z.number().int().nonnegative().nullable(),
    rowLabel: analysisProofSchema.nullable(), columnLabel: analysisProofSchema.nullable(), grade, semester, subject: z.string().nullable(), gradingSystem,
    gradeProofs: proofs, semesterProofs: proofs, subjectProofs: proofs, gradingSystemProofs: proofs, structureStatus: z.enum(['resolved', 'unresolved']) }).strict(),
}).strict();
const activity = z.object({ id: name, localId: z.string(), title: z.string(), grade, area: z.string(),
  facts: z.object({ recordedContext: proofs, studentActions: proofs, teamActions: proofs, choiceReasons: proofs, outcomes: proofs, teacherObservations: proofs }).strict(),
  unknowns: z.array(z.string()), mergedFromLegacyIds: z.array(z.string()), interpretations: z.array(interpretation).optional(),
}).strict();
const academic = z.object({ id: name, localId: z.string(), grade, semester, subject: z.string().nullable(), gradingSystem,
  recordedValues: z.array(z.string()), proofs, interpretationLimit: z.string(), comparisonEligible: z.boolean(), literalValues: z.array(literal).optional(),
  tableStructure: z.object({ status: z.enum(['resolved', 'unresolved']), unresolvedReasons: z.array(z.string()) }).strict().optional(), interpretations: z.array(interpretation).optional(),
}).strict();
const sourceReview = z.object({ version: z.literal('bounded-academic-source-review-v1'), reviewer: z.literal('codex-source-review'),
  parentProposalPath: name, parentProposalSha256: sha, parentAnalysisRevision: name, artifactPath: name, artifactSha256: sha, reviewedAt: name,
  scope: z.literal('explicit_visually_reviewed_academic_rows_only') }).strict();
const poolSelectionBase = z.object({ artifactPath: name, artifactSha256: sha, baseRevisionPath: name, baseRevisionFileSha256: sha, donorBankKey: sha,
  retainedObjectiveIds: z.array(name), selectedDeepObjectiveIds: z.array(name), omittedDeepObjectiveIds: z.array(name), questionApprovalGranted: z.literal(false) }).strict();
const poolSelection = z.discriminatedUnion('version', [
  // Observed historical v1 has no donor evidence imports. Do not synthesize []
  // or relabel it v2: either action would alter its canonical body hash.
  poolSelectionBase.extend({ version: z.literal('deep-question-pool-source-selection-v1') }).strict(),
  poolSelectionBase.extend({ version: z.literal('deep-question-pool-source-selection-v2'), reviewedDonorEvidenceImports: z.array(z.object({ evidenceId: name, evidenceSha256: sha, originEntityId: name.nullable(), page: z.number().int().positive(), startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive() }).strict()) }).strict(),
]);
const commonBody = z.object({ schemaVersion: z.enum(['full-student-analysis-v1', 'full-student-analysis-v2']),
  codecVersion: z.literal('student-analysis-codec-v2').optional(), identityBase: sha.optional(), inputSha256: sha.optional(), sourceReview: sourceReview.optional(),
  derivationVersion: z.literal('full-record-deep-v1').optional(), revision: name, recordRevision: name, sourceContentSha256: sha, studentId: name, model: name, generatedAt: name,
  activities: z.array(activity), academicRecords: z.array(academic), trajectories: z.array(z.object({ id: name, fromEntityId: name, toEntityId: name,
    relationship: z.string(), rationale: z.string(), proofs, status: z.literal('possible_connection_not_causal_fact') }).strict()),
  sourceDispositions: z.array(z.object({ sourceRefId: name, status: z.string(), reason: z.string() }).strict()),
  coverage: z.object({ expectedPages: z.number().int().nonnegative(), extractedPages: z.number().int().nonnegative(), sourceBlockCount: z.number().int().nonnegative(),
    dispositionCount: z.number().int().nonnegative(), analyzedSourceCount: z.number().int().nonnegative(), excludedSourceCount: z.number().int().nonnegative(),
    needsReviewSourceCount: z.number().int().nonnegative(), verifiedAnchorCount: z.number().int().nonnegative(), partiallyStructuredSourceCount: z.number().int().nonnegative(),
    allSourceBlocksAccountedFor: z.boolean(), independentSemanticReview: z.literal(false) }).strict(),
  limitations: z.array(z.string()), contentSha256: sha,
}).strict();
export const fullStudentAnalysisV1Schema = commonBody.extend({ schemaVersion: z.literal('full-student-analysis-v1') }).strict();
export const fullStudentAnalysisV2Schema = commonBody.extend({ schemaVersion: z.literal('full-student-analysis-v2'), codecVersion: z.literal('student-analysis-codec-v2'), identityBase: sha, inputSha256: sha,
  academicRecords: z.array(academic.extend({ literalValues: z.array(literal), tableStructure: z.object({ status: z.enum(['resolved', 'unresolved']), unresolvedReasons: z.array(z.string()) }).strict() }).strict()),
}).strict();
export const fullStudentAnalysisSchema = z.discriminatedUnion('schemaVersion', [fullStudentAnalysisV1Schema, fullStudentAnalysisV2Schema]);

const targetBody = z.object({ schemaVersion: z.enum(['full-student-analysis-v1', 'full-student-analysis-v2']), codecVersion: z.literal('student-analysis-codec-v2').optional(),
  revision: name, commonAnalysisRevision: name, studentId: name, supportTargetId: name, profileRevision: name, analysisRevision: name,
  activityPriorities: z.array(z.object({ activityId: name, priority: z.enum(['S', 'A', 'B', 'C', 'F']), reason: z.string(), criterionName: z.string().nullable(), representative: z.boolean() }).strict()),
  objectives: z.array(studentObjectiveCandidateSchema), contentSha256: sha,
  objectiveContractRevision: z.object({ version: z.literal('independently-reviewed-objective-contract-v1'), parentRevision: name, parentContentSha256: sha,
    reviewArtifactSha256: sha, reviewModel: name, reviewedAt: name, changedObjectiveIds: z.array(name),
    approvedQuestions: z.array(z.object({ objectiveId: name, questionSha256: sha }).strict()).optional(),
    blockedObjectives: z.array(z.object({ objectiveId: name, failureCode: z.string() }).strict()) }).strict().optional(),
  objectiveSourceReview: z.object({ version: z.literal('source-reviewed-objective-extension-v1'), parentRevision: name, parentContentSha256: sha,
    reviewArtifactPath: name, reviewArtifactSha256: sha, reviewerId: name, reviewedAt: name, addedObjectiveIds: z.array(name) }).strict().optional(),
  // Existing target-only migration provenance is hash-bearing data. Keeping it
  // does not reinstate the historical tool's special counts as service policy.
  objectivePoolSelection: poolSelection.optional(),
  objectiveSourceClosureReview: z.object({ version: z.literal('explicit-academic-objective-source-closure-v1'), parentRevision: name, parentContentSha256: sha,
    reviewArtifactPath: name, reviewArtifactSha256: sha, changedObjectiveIds: z.array(name), addedEvidenceIds: z.array(name) }).strict().optional(),
}).strict();
export const targetStudentAnalysisV1Schema = targetBody.extend({ schemaVersion: z.literal('full-student-analysis-v1') }).strict();
export const targetStudentAnalysisV2Schema = targetBody.extend({ schemaVersion: z.literal('full-student-analysis-v2'), codecVersion: z.literal('student-analysis-codec-v2') }).strict();
export const targetStudentAnalysisSchema = z.discriminatedUnion('schemaVersion', [targetStudentAnalysisV1Schema, targetStudentAnalysisV2Schema]);
export const analysisDomainSchemas = { 'student-analysis-codec-v2': studentAnalysisCodecV2Schema, 'full-student-analysis': fullStudentAnalysisSchema, 'target-student-analysis': targetStudentAnalysisSchema };

export const analysisDomainFieldSemantics = {
  version: 'analysis-domain-contracts-v1',
  authority: 'existing TS/Zod wire, FullStudentAnalysis and TargetStudentAnalysis; no parallel canonical',
  legacyHash: 'SHA-256 of the original TS JSON.stringify UTF-8 bytes; object insertion order is significant',
  coordinates: '0-based UTF-16 code units in the immutable canonical page text; end exclusive',
  stringLengths: 'the installed authoritative Zod counts Unicode code points for string min/max; offsets remain UTF-16 units',
  wireLiteralCoordinates: 'UTF-16 offsets relative to the exact dictionary quote, or an explicitly unique literal',
  nullability: 'null is an observed unknown; missing optional legacy provenance stays missing; [] records an explicit empty collection',
  statusAuthority: 'record fact, model interpretation, scientific verification and independent semantic review remain distinct',
  versions: 'v1 is read without promotion; v2 retains typed proof_ref/academic_literal/interpretation and its original hashes',
  targetBoundary: 'target references the exact common revision; priorities are preparation needs, not ability scores',
  ownership: 'owner/student/target/source metadata is carried outside legacy hash bodies; transport is not authentication and callers retain the existing owner/source guards',
} as const;
