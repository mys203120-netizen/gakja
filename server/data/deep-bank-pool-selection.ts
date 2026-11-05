/** Offline selection only. Keeping a source objective is not approval of its
 * final question. Fresh premise reviews and the normal bank gate are required. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { InterviewContext, StudentEvidence } from './load-interview-context';
import type { FullRecordSource, FullStudentAnalysis } from './full-student-analysis';
import { analysisQAManifest, loadFullRecord } from './full-student-analysis';
import { loadStagedInterviewContextAt } from './staged-interview-context';
import type { PreparedQuestionBank } from './prepared-question-bank';
import type { StudentObjectiveCandidate } from '../question-objective';
import { deepRebindDigest } from './deep-bank-rebind';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const same = (a: unknown, b: unknown) => deepRebindDigest(a) === deepRebindDigest(b);
const version = 'deep-question-pool-source-selection-v2' as const;
export interface DeepPoolSelectionArtifact {
  version: typeof version; reviewerId: string; reviewedAt: string;
  questionApprovalGranted: false; sourcePdfSha256: string; sourceContentSha256: string;
  donorBankKey: string; donorBankContentSha256: string; donorBankFileSha256: string;
  donorAnalysisPath: string; donorAnalysisFileSha256: string;
  baseRevisionPath: string; baseRevisionFileSha256: string; commonContentSha256: string; baseTargetContentSha256: string;
  retainedObjectives: Array<{ objectiveId: string; objectiveSha256: string }>;
  selectedDeepObjectives: Array<{ objectiveId: string; objectiveSha256: string; reason: string }>;
  reviewedDonorEvidenceImports: Array<{ evidenceId: string; evidenceSha256: string; originEntityId: string | null; page: number; startOffset: number; endOffset: number }>;
  omittedDeepObjectiveIds: string[]; omittedPurposesPreservedInBaseRevision: true;
}
type Pins = Pick<DeepPoolSelectionArtifact, 'donorBankFileSha256' | 'donorAnalysisPath' | 'donorAnalysisFileSha256' | 'baseRevisionPath' | 'baseRevisionFileSha256'>;
type Review = { artifactPath: string; artifactSha256: string; reviewerId: string; reviewedAt: string };
export interface PoolSelectionInput {
  context: InterviewContext; stagedContext: InterviewContext; donorBank: PreparedQuestionBank;
  baseEvidenceIds: string[];
  selected: Array<{ objectiveId: string; reason: string }>; pins: Pins;
  reviewerId: string; reviewedAt: string;
}
function retainedObjectives(input: PoolSelectionInput) {
  const ids = [...new Set(input.donorBank.slots.flatMap(slot => slot.candidates).map(candidate => input.donorBank.plan.slots.find(slot => slot.id === candidate.slotId)?.objective)
    .filter((row): row is StudentObjectiveCandidate => Boolean(row && row.originKind !== 'common_approved')).map(row => row.id))];
  if (!ids.length || ids.length > 28) throw new Error('DEEP_POOL_RETAINED_COUNT_INVALID');
  return ids.map(id => { const objective = input.context.targetAnalysis?.objectives.find(row => row.id === id); if (!objective) throw new Error('DEEP_POOL_DONOR_OBJECTIVE_MISSING'); return objective; });
}
/** The caller must read every chosen purpose. This function pins that explicit
 * choice and preserves every omitted purpose in the immutable full analysis. */
export function buildDeepPoolSelectionArtifact(input: PoolSelectionInput): DeepPoolSelectionArtifact {
  const { context: old, stagedContext: current, donorBank: bank } = input;
  const { contentSha256, ...bankBody } = bank;
  if (bank.status !== 'ready' || contentSha256 !== deepRebindDigest(bankBody) || !old.student.pdfSha256 || !current.student.pdfSha256 || !old.studentAnalysis || !current.studentAnalysis || !old.targetAnalysis || !current.targetAnalysis ||
    old.student.pdfSha256 !== current.student.pdfSha256 || old.studentAnalysis.studentId !== current.studentAnalysis.studentId || old.studentAnalysis.sourceContentSha256 !== current.studentAnalysis.sourceContentSha256 || !same(old.target, current.target)) throw new Error('DEEP_POOL_SOURCE_IDENTITY_INVALID');
  if (!input.reviewerId.trim() || !Number.isFinite(Date.parse(input.reviewedAt)) || input.selected.length > 6 || new Set(input.selected.map(row => row.objectiveId)).size !== input.selected.length || input.selected.some(row => !row.reason.trim())) throw new Error('DEEP_POOL_EXPLICIT_SELECTION_INVALID');
  const retained = retainedObjectives(input), kept = new Set(retained.map(row => row.id)), keys = new Set(retained.map(row => row.semanticKey));
  const selected = input.selected.map(row => {
    const objective = current.targetAnalysis!.objectives.find(item => item.id === row.objectiveId);
    if (!objective || kept.has(objective.id) || !objective.semanticKey || keys.has(objective.semanticKey) || objective.originKind === 'common_approved' || objective.targetEvidence.length !== 1) throw new Error('DEEP_POOL_NEW_OBJECTIVE_INVALID');
    keys.add(objective.semanticKey); kept.add(objective.id);
    return { objectiveId: objective.id, objectiveSha256: deepRebindDigest(objective), reason: row.reason };
  });
  const donorSources = [...new Set(bank.slots.flatMap(slot => slot.candidates).flatMap(candidate => {
    const objective = bank.plan.slots.find(slot => slot.id === candidate.slotId)?.objective;
    return [...candidate.draft.evidenceIds, ...(objective?.evidenceIds ?? []), ...(objective?.anchorRefs ?? []).map(ref => ref.sourceId),
      ...(candidate.draft.approvedQuestion?.blueprint.anchorRefs ?? []).filter(ref => ref.kind === 'RECORD').map(ref => ref.sourceId)];
  }))];
  const reviewedDonorEvidenceImports = donorSources.filter(id => !input.baseEvidenceIds.includes(id)).map(id => {
    const row = old.student.evidence.find(item => item.id === id);
    if (!row) throw new Error('DEEP_POOL_DONOR_SOURCE_MISSING');
    return { evidenceId: row.id, evidenceSha256: deepRebindDigest(row), originEntityId: row.originEntityId ?? null, page: row.page, startOffset: row.sourceRef.startOffset, endOffset: row.sourceRef.endOffset };
  });
  return { version, reviewerId: input.reviewerId, reviewedAt: input.reviewedAt, questionApprovalGranted: false,
    sourcePdfSha256: current.student.pdfSha256, sourceContentSha256: current.studentAnalysis.sourceContentSha256,
    donorBankKey: bank.key, donorBankContentSha256: bank.contentSha256, ...input.pins,
    commonContentSha256: current.studentAnalysis.contentSha256, baseTargetContentSha256: current.targetAnalysis.contentSha256,
    retainedObjectives: retained.map(row => ({ objectiveId: row.id, objectiveSha256: deepRebindDigest(row) })), selectedDeepObjectives: selected, reviewedDonorEvidenceImports,
    omittedDeepObjectiveIds: current.targetAnalysis.objectives.filter(row => !kept.has(row.id)).map(row => row.id), omittedPurposesPreservedInBaseRevision: true };
}
function entityAt(common: FullStudentAnalysis, id: string) { return [...common.activities, ...common.academicRecords, ...common.trajectories].find(row => row.id === id); }
/** IDs, literal bytes and coordinates only; no natural-language classification. */
export function poolObjectiveBindingFailures(objective: Pick<StudentObjectiveCandidate, 'id' | 'activityIds' | 'originEntityId' | 'evidenceIds' | 'anchorRefs'>, oldCommon: FullStudentAnalysis | null, common: FullStudentAnalysis, evidence: StudentEvidence[], source: FullRecordSource) {
  const failures: string[] = [];
  const sourceIds = [...new Set([...objective.evidenceIds, ...objective.anchorRefs.map(ref => ref.sourceId)])];
  const entityIds = [...new Set([...objective.activityIds, ...(objective.originEntityId ? [objective.originEntityId] : []), ...evidence.filter(row => sourceIds.includes(row.id) && row.originEntityId).map(row => row.originEntityId!)])];
  for (const id of [...entityIds]) {
    const entity = entityAt(common, id);
    if (entity && 'fromEntityId' in entity) for (const endpoint of [entity.fromEntityId, entity.toEntityId]) if (!entityIds.includes(endpoint)) entityIds.push(endpoint);
  }
  for (const id of entityIds) {
    const current = entityAt(common, id), old = oldCommon ? entityAt(oldCommon, id) : null;
    if (!current) { failures.push(`ENTITY_MISSING:${id}`); continue; }
    if (oldCommon && !old) { failures.push(`DONOR_ENTITY_MISSING:${id}`); continue; }
    if (old && 'facts' in old) {
      if (!('facts' in current) || Object.entries(old.facts).some(([field, proofs]) => proofs.some(proof => !current.facts[field as keyof typeof current.facts].some(item => same(item, proof))))) failures.push(`DONOR_FACT_CHANGED:${id}`);
    } else if (old) {
      // Academic interpretations may be enriched, while every typed literal,
      // table coordinate and provenance field must remain exact.
      const comparable = (entity: typeof current) => 'literalValues' in entity ? { ...entity, interpretations: undefined } : entity;
      if (!same(comparable(old), comparable(current))) failures.push(`DONOR_TYPED_ENTITY_CHANGED:${id}`);
    }
  }
  for (const id of sourceIds) {
    const row = evidence.find(item => item.id === id), page = row && source.pages.find(item => item.page === row.page);
    if (!row || !page || row.sourceRef.pdfSha256 !== source.pdfSha256 || page.text.slice(row.sourceRef.startOffset, row.sourceRef.endOffset) !== row.text) failures.push(`EXACT_EVIDENCE_MISSING:${id}`);
  }
  for (const ref of objective.anchorRefs) {
    const row = evidence.find(item => item.id === ref.sourceId);
    if (ref.kind !== 'RECORD' || ref.revision !== source.pdfSha256 || !row || !Number.isInteger(ref.start) || !Number.isInteger(ref.end) || ref.start < 0 || ref.end > row.text.length || ref.end <= ref.start) failures.push(`ANCHOR_INVALID:${ref.sourceId}`);
  }
  return failures;
}
function contained(root: string, relative: string, directory: string) {
  const file = path.resolve(root, relative), within = path.relative(path.resolve(root, directory), file);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) throw new Error('DEEP_POOL_PATH_INVALID');
  return file;
}
/** Writes a new target-only stage. Never calls providers or changes a pointer. */
export async function stageDeepQuestionPoolSelection(options: { context: InterviewContext; baseRevisionPath: string; donorBank: PreparedQuestionBank; selectedDeepObjectiveIds: string[]; review: Review }, root = process.cwd()) {
  const { context, baseRevisionPath, donorBank: bank, review } = options;
  const artifactBytes = await readFile(contained(root, review.artifactPath, 'artifacts'));
  if (sha(artifactBytes) !== review.artifactSha256) throw new Error('DEEP_POOL_REVIEW_HASH_INVALID');
  const artifact = JSON.parse(artifactBytes.toString('utf8')) as DeepPoolSelectionArtifact;
  if (artifact.version !== version || artifact.reviewerId !== review.reviewerId || artifact.reviewedAt !== review.reviewedAt || !same(artifact.selectedDeepObjectives.map(row => row.objectiveId), options.selectedDeepObjectiveIds)) throw new Error('DEEP_POOL_REVIEW_BINDING_INVALID');
  const { context: stagedContext, staged } = await loadStagedInterviewContextAt(root, baseRevisionPath, { writeManifest: false });
  const originalBytes = await readFile(contained(root, baseRevisionPath, 'data/prepared/student-analysis-revisions'));
  const bankBytes = await readFile(contained(root, `data/prepared/question-banks/${bank.key}.json`, 'data/prepared/question-banks'));
  const donorPin = context.manifest.files.find(row => row.role === 'fullStudentAnalysis');
  if (!donorPin?.sha256) throw new Error('DEEP_POOL_DONOR_ANALYSIS_PIN_MISSING');
  const donorBytes = await readFile(contained(root, donorPin.path, 'data/prepared/student-analysis-revisions'));
  if (sha(donorBytes) !== donorPin.sha256 || !same(JSON.parse(bankBytes.toString('utf8')), bank)) throw new Error('DEEP_POOL_DONOR_PIN_CHANGED');
  const input: PoolSelectionInput = { context, stagedContext, donorBank: bank, baseEvidenceIds: staged.evidence.map(row => row.id), selected: artifact.selectedDeepObjectives.map(row => ({ objectiveId: row.objectiveId, reason: row.reason })),
    pins: { donorBankFileSha256: sha(bankBytes), donorAnalysisPath: donorPin.path, donorAnalysisFileSha256: donorPin.sha256, baseRevisionPath, baseRevisionFileSha256: sha(originalBytes) }, reviewerId: review.reviewerId, reviewedAt: review.reviewedAt };
  if (!same(buildDeepPoolSelectionArtifact(input), artifact)) throw new Error('DEEP_POOL_REVIEW_CONTEXT_CHANGED');
  const retained = retainedObjectives(input), selected = options.selectedDeepObjectiveIds.map(id => staged.target.objectives.find(row => row.id === id)!);
  const evidence = structuredClone(staged.evidence);
  for (const imported of artifact.reviewedDonorEvidenceImports) {
    const source = context.student.evidence.find(row => row.id === imported.evidenceId);
    if (!source || deepRebindDigest(source) !== imported.evidenceSha256 || evidence.some(row => row.id === source.id)) throw new Error('DEEP_POOL_DONOR_SOURCE_IMPORT_CHANGED');
    // An enriched activity can contain facts outside this older excerpt. Its
    // unchanged, explicitly reviewed range remains usable as question evidence;
    // it does not replace or summarize the new canonical activity facts.
    evidence.push(structuredClone(source));
  }
  for (const objective of [...retained, ...selected]) for (const id of [...objective.evidenceIds, ...objective.anchorRefs.map(ref => ref.sourceId)]) {
    if (!evidence.some(row => row.id === id)) { const supplement = stagedContext.student.evidence.find(row => row.id === id); if (supplement) evidence.push(structuredClone(supplement)); }
  }
  const source = await loadFullRecord(root, context.student.pdfSha256); if (!source) throw new Error('DEEP_POOL_FULL_SOURCE_MISSING');
  const donorSourceScopes = artifact.reviewedDonorEvidenceImports.map(imported => {
    const row = context.student.evidence.find(row => row.id === imported.evidenceId)!;
    return { id: `source-import:${row.id}`, activityIds: row.activityId ? [row.activityId] : [], originEntityId: row.originEntityId,
      evidenceIds: [row.id], anchorRefs: [{ kind: 'RECORD' as const, sourceId: row.id, revision: source.pdfSha256, start: 0, end: row.text.length, confirmationStatus: 'confirmed_from_record' as const, claimStatus: 'record_fact' as const }] };
  });
  const pendingBindings = [...retained.map(row => ({ row, old: context.studentAnalysis! })), ...donorSourceScopes.map(row => ({ row, old: context.studentAnalysis! })), ...selected.map(row => ({ row, old: null }))]
    .flatMap(({ row, old }) => poolObjectiveBindingFailures(row, old, staged.common, evidence, source).map(reason => ({ objectiveId: row.id, reason })));
  if (pendingBindings.length) return { revisionPath: null, manifestPath: null, pendingBindings, selectionArtifactPath: review.artifactPath, activated: false as const };
  const target = structuredClone(staged.target);
  delete target.objectiveContractRevision; delete target.objectiveSourceReview;
  const revision = sha(JSON.stringify({ version, baseTarget: target.contentSha256, artifactSha256: review.artifactSha256 }));
  target.revision = `target-${revision}`; target.analysisRevision = revision;
  target.objectives = [...retained, ...selected].map(row => ({ ...structuredClone(row), analysisRevision: revision }));
  const trace = { version, artifactPath: review.artifactPath, artifactSha256: review.artifactSha256, baseRevisionPath, baseRevisionFileSha256: sha(originalBytes), donorBankKey: bank.key,
    retainedObjectiveIds: retained.map(row => row.id), selectedDeepObjectiveIds: options.selectedDeepObjectiveIds, reviewedDonorEvidenceImports: artifact.reviewedDonorEvidenceImports,
    omittedDeepObjectiveIds: artifact.omittedDeepObjectiveIds, questionApprovalGranted: false };
  const selectedTarget = Object.assign(target, { objectivePoolSelection: trace });
  const { contentSha256: ignored, ...body } = selectedTarget; void ignored;
  selectedTarget.contentSha256 = sha(JSON.stringify(body));
  const payload = { common: staged.common, target: selectedTarget, evidence, sourceRevision: source.revision, sourceContentSha256: source.contentSha256 };
  const manifest = analysisQAManifest(payload, source, staged.manifest.parentPointerSha256);
  const directory = path.resolve(root, 'data/prepared/student-analysis-revisions', staged.common.revision, selectedTarget.revision);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'analysis.json'), manifestFile = path.join(directory, 'analysis-qa.json');
  const writeImmutable = async (file: string, value: unknown) => { const bytes = JSON.stringify(value, null, 2); try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== bytes) throw error; } };
  await writeImmutable(file, payload); await writeImmutable(manifestFile, manifest);
  if (sha(await readFile(contained(root, baseRevisionPath, 'data/prepared/student-analysis-revisions'))) !== sha(originalBytes)) throw new Error('DEEP_POOL_ORIGINAL_STAGE_CHANGED');
  const loaded = await loadStagedInterviewContextAt(root, path.relative(root, file), { writeManifest: false });
  if (!same(loaded.staged.common, staged.common) || !same(loaded.staged.target, selectedTarget)) throw new Error('DEEP_POOL_STAGED_RELOAD_MISMATCH');
  return { ...loaded.staged, pendingBindings, selectionArtifactPath: review.artifactPath, activated: false as const };
}
