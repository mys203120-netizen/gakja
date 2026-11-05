import { createHash } from 'node:crypto';
import { analysisDomainSchemas } from './analysis-domain-codecs';
import { analysisQAManifest, decodeStudentAnalysisV2, type FullRecordSource, type FullStudentAnalysis, type TargetStudentAnalysis, type StudentAnalysisCodecV2 } from '../data/full-student-analysis';
import type { StudentEvidence } from '../data/load-interview-context';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const analysisDocumentHash = (value: unknown) => sha(JSON.stringify(value));
export function assertAnalysisDocumentHash(value: { contentSha256: string }) {
  const { contentSha256, ...body } = value;
  if (analysisDocumentHash(body) !== contentSha256) throw new Error('ANALYSIS_CONTRACT_CONTENT_HASH_CHANGED');
}
/** Zod validates shape only; NEVER return its reordered parse output for a
 * persisted hash-bearing object. Copy the original order and do not normalize. */
export function decodeFullAnalysisPreservingOrder(input: unknown): FullStudentAnalysis {
  analysisDomainSchemas['full-student-analysis'].parse(input);
  const value = input as FullStudentAnalysis; assertAnalysisDocumentHash(value);
  if (value.schemaVersion === 'full-student-analysis-v2' && value.revision !== analysisDocumentHash({ identityBase: value.identityBase, inputSha256: value.inputSha256 })) throw new Error('ANALYSIS_CONTRACT_REVISION_CHANGED');
  return structuredClone(value);
}
export function decodeTargetAnalysisPreservingOrder(input: unknown): TargetStudentAnalysis {
  analysisDomainSchemas['target-student-analysis'].parse(input);
  const value = input as TargetStudentAnalysis; assertAnalysisDocumentHash(value); return structuredClone(value);
}
export function decodeAnalysisWireV2PreservingOrder(source: FullRecordSource, input: unknown): StudentAnalysisCodecV2 {
  decodeStudentAnalysisV2(source, input); return structuredClone(input) as StudentAnalysisCodecV2;
}
export function encodeAnalysisWireV2(source: FullRecordSource, value: unknown) { return JSON.stringify(decodeAnalysisWireV2PreservingOrder(source, value)); }
export function encodeFullAnalysis(value: unknown) { return JSON.stringify(decodeFullAnalysisPreservingOrder(value)); }
export function encodeTargetAnalysis(value: unknown) { return JSON.stringify(decodeTargetAnalysisPreservingOrder(value)); }

export interface ExistingAnalysisEnvelope { common: FullStudentAnalysis; target: TargetStudentAnalysis; evidence: StudentEvidence[] }
export interface AnalysisContractPins { studentId?: string; sourceRevision?: string; supportTargetId?: string; commonRevision?: string; profileRevision?: string }
/** These are existing source/relationship invariants, not content approval or
 * owner authentication. No ID, target field, revision or approval is invented. */
export function validateAnalysisEnvelopeSemantics(input: ExistingAnalysisEnvelope, source: FullRecordSource, pins: AnalysisContractPins = {}) {
  assertAnalysisDocumentHash(source);
  const common = decodeFullAnalysisPreservingOrder(input.common), target = decodeTargetAnalysisPreservingOrder(input.target);
  if (common.schemaVersion !== target.schemaVersion || common.studentId !== target.studentId || common.studentId !== source.studentId ||
    common.sourceContentSha256 !== source.contentSha256 || common.recordRevision !== source.recordRevision || target.commonAnalysisRevision !== common.revision ||
    pins.studentId !== undefined && pins.studentId !== common.studentId || pins.sourceRevision !== undefined && pins.sourceRevision !== source.revision ||
    pins.supportTargetId !== undefined && pins.supportTargetId !== target.supportTargetId || pins.commonRevision !== undefined && pins.commonRevision !== common.revision ||
    pins.profileRevision !== undefined && pins.profileRevision !== target.profileRevision) throw new Error('ANALYSIS_CONTRACT_CONTEXT_MISMATCH');
  if (common.schemaVersion === 'full-student-analysis-v2') analysisQAManifest({ common, target, evidence: input.evidence }, source, null);
  else {
    for (const evidence of input.evidence) { const page = source.pages.find(row => row.page === evidence.page); if (!page || page.text.slice(evidence.sourceRef.startOffset, evidence.sourceRef.endOffset) !== evidence.text) throw new Error('FULL_ANALYSIS_EVIDENCE_INVALID'); }
  }
  return { schemaVersion: common.schemaVersion, codecVersion: common.codecVersion ?? null, commonRevision: common.revision, targetRevision: target.revision,
    commonContentSha256: common.contentSha256, targetContentSha256: target.contentSha256, evidenceSha256: analysisDocumentHash(input.evidence),
    providerCalls: 0 as const, canonicalMutation: false as const };
}
