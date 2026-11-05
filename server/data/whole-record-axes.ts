/** Zero-provider read projection over an existing canonical deep-analysis revision.
 * This adds neither a second analysis authority nor an approval/publication state. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { InterviewContext } from './load-interview-context';
import { decodeStudentAnalysisV2, loadFullRecord, loadFullStudentAnalysis, verifyStudentAnalysisSourceQuote, studentAnalysisCodecV2Schema, type AnalysisProof, type FullRecordSource, type FullStudentAnalysis } from './full-student-analysis';
import { studentDeepSynthesisSchema } from './student-analysis-batches';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const deepAxesArtifactSchema = z.object({
  schemaVersion: z.literal('unapproved-full-analysis-proposal-v2'),
  codecVersion: z.literal('student-analysis-codec-v2'),
  model: z.string().min(1), generatedAt: z.string().min(1),
  sourceContentSha256: z.string().regex(/^[a-f0-9]{64}$/u), status: z.literal('completed'),
  output: studentAnalysisCodecV2Schema,
  wholeRecordAxes: studentDeepSynthesisSchema.shape.wholeRecordAxes,
}).passthrough();
export interface WholeRecordAxesArtifactReference { path: string; sha256: string }
export interface WholeRecordAxesReadProjection {
  version: 'whole-record-axes-read-view-v1'; commonRevision: string; commonContentSha256: string;
  sourceRevision: string; sourceContentSha256: string; artifactSha256: string; dictionarySha256: string;
  axes: Array<{ axis: z.infer<typeof studentDeepSynthesisSchema>['wholeRecordAxes'][number]['axis']; interpretation: string; proofs: AnalysisProof[]; unknowns: string[]; status: 'source_bound_interpretation_not_causal_fact' }>;
  independentlyReviewedSemantics: false; scientificTruthVerified: false; providerCalls: 0; contentSha256: string;
}
function assertBodyHash(value: { contentSha256: string }, code: string) {
  const { contentSha256, ...body } = value;
  if (sha(JSON.stringify(body)) !== contentSha256) throw new Error(code);
}

/** Call only with the verified canonical source/common returned by their existing
 * loaders. Exact proposal bytes must be pinned by the caller, not guessed from
 * the newest filename. Existing artifact interpretations remain interpretations. */
export function projectWholeRecordAxes(common: FullStudentAnalysis, source: FullRecordSource, artifactBytes: Buffer, expectedArtifactSha256: string): WholeRecordAxesReadProjection {
  if (!/^[a-f0-9]{64}$/u.test(expectedArtifactSha256) || sha(artifactBytes) !== expectedArtifactSha256) throw new Error('WHOLE_RECORD_AXES_ARTIFACT_HASH_MISMATCH');
  assertBodyHash(source, 'WHOLE_RECORD_AXES_SOURCE_HASH_MISMATCH');
  assertBodyHash(common, 'WHOLE_RECORD_AXES_COMMON_HASH_MISMATCH');
  if (common.schemaVersion !== 'full-student-analysis-v2' || common.codecVersion !== 'student-analysis-codec-v2' || common.derivationVersion !== 'full-record-deep-v1' || common.studentId !== source.studentId || common.recordRevision !== source.recordRevision || common.sourceContentSha256 !== source.contentSha256) throw new Error('WHOLE_RECORD_AXES_REVISION_MISMATCH');
  const artifact = deepAxesArtifactSchema.parse(JSON.parse(artifactBytes.toString('utf8')));
  if (artifact.model !== common.model || artifact.generatedAt !== common.generatedAt || artifact.sourceContentSha256 !== source.contentSha256 || !Number.isFinite(Date.parse(artifact.generatedAt))) throw new Error('WHOLE_RECORD_AXES_ARTIFACT_CONTEXT_MISMATCH');
  const decoded = decodeStudentAnalysisV2(source, artifact.output);
  // Use the existing TS serializer exactly; this is the original revision's
  // input identity, not a new sorted-key hash or a regenerated common analysis.
  const inputSha256 = sha(JSON.stringify({ wire: decoded.parsed, derivationVersion: common.derivationVersion, sourceReview: common.sourceReview ?? null }));
  if (common.inputSha256 !== inputSha256 || common.revision !== sha(JSON.stringify({ identityBase: common.identityBase, inputSha256 }))) throw new Error('WHOLE_RECORD_AXES_PROPOSAL_OUTPUT_MISMATCH');
  const dictionary = new Map(decoded.parsed.quoteDictionary.map(row => [row.id, row]));
  if (new Set(artifact.wholeRecordAxes.map(row => row.axis)).size !== 11) throw new Error('WHOLE_RECORD_AXES_INCOMPLETE');
  const axes = artifact.wholeRecordAxes.map(row => ({ axis: row.axis, interpretation: row.interpretation, unknowns: [...row.unknowns], status: row.status, proofs: row.basisProofRefs.map(ref => {
    const entry = dictionary.get(ref.quoteId); if (!entry) throw new Error('WHOLE_RECORD_AXES_PROOF_MISSING');
    return verifyStudentAnalysisSourceQuote(source, { sourceKey: entry.sourceKey, quote: entry.quote });
  }) }));
  const body = { version: 'whole-record-axes-read-view-v1' as const, commonRevision: common.revision, commonContentSha256: common.contentSha256, sourceRevision: source.revision, sourceContentSha256: source.contentSha256, artifactSha256: expectedArtifactSha256, dictionarySha256: sha(JSON.stringify(decoded.parsed.quoteDictionary)), axes, independentlyReviewedSemantics: false as const, scientificTruthVerified: false as const, providerCalls: 0 as const };
  return { ...body, contentSha256: sha(JSON.stringify(body)) };
}

/** Read-only composition: common/target/evidence objects and their IDs/hashes are
 * returned unchanged. No pointer, source file, proposal or manifest is written. */
export async function loadStudentAnalysisWithAxes(context: InterviewContext, reference: WholeRecordAxesArtifactReference, root = process.cwd()) {
  const analysis = await loadFullStudentAnalysis(context, root); if (!analysis) return null;
  const source = await loadFullRecord(root, analysis.common.recordRevision); if (!source) throw new Error('WHOLE_RECORD_AXES_SOURCE_MISSING');
  const file = path.resolve(root, reference.path), base = path.resolve(root, 'data/prepared/student-analysis-proposals'), relative = path.relative(base, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('WHOLE_RECORD_AXES_ARTIFACT_PATH_INVALID');
  const axes = projectWholeRecordAxes(analysis.common, source, await readFile(file), reference.sha256);
  return { ...analysis, wholeRecordAxes: axes };
}
