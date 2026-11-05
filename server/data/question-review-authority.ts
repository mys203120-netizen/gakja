import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { InterviewContext } from './load-interview-context';
import type { FullStudentAnalysis, TargetStudentAnalysis } from './full-student-analysis';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const hashLike = (value: string | undefined) => Boolean(value && /^[a-f0-9]{64}$/u.test(value));
const bodyMatches = (value: { contentSha256: string }) => { const { contentSha256, ...body } = value; return hashLike(contentSha256) && sha(JSON.stringify(body)) === contentSha256; };
interface Envelope { common: FullStudentAnalysis; target: TargetStudentAnalysis; evidence: unknown[] }
interface EnvelopeRead { envelope: Envelope; fileSha256: string }

/** One bank-loading operation owns one immutable read snapshot. This is not a
 * process cache or an approval cache: a subsequent load gets a fresh scope. */
export class QuestionReviewAuthorityScope {
  private readonly envelopes = new Map<string, Promise<EnvelopeRead | null>>();
  private readonly bodies = new WeakMap<object, boolean>();
  private readonly serialized = new WeakMap<object, string>();
  private readonly reads = new Map<string, number>();
  private serializationCount = 0;
  readonly root: string;
  constructor(readonly context: InterviewContext, root: string) { this.root = path.resolve(root); }
  matches(context: InterviewContext, root: string) { return this.context === context && this.root === path.resolve(root); }
  text(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    const previous = this.serialized.get(value); if (previous !== undefined) return previous;
    const text = JSON.stringify(value); this.serialized.set(value, text); this.serializationCount++; return text;
  }
  bodyMatches(value: { contentSha256: string }) {
    const previous = this.bodies.get(value); if (previous !== undefined) return previous;
    const result = bodyMatches(value); this.bodies.set(value, result); return result;
  }
  read(file: string) {
    const absolute = path.resolve(file), previous = this.envelopes.get(absolute); if (previous) return previous;
    const pending = (async () => {
      this.reads.set(absolute, (this.reads.get(absolute) ?? 0) + 1);
      try { const bytes = await readFile(absolute); return { envelope: JSON.parse(bytes.toString('utf8')) as Envelope, fileSha256: sha(bytes) }; }
      catch { return null; }
    })();
    this.envelopes.set(absolute, pending); return pending;
  }
  diagnostics() { return { fileReads: Object.fromEntries(this.reads), totalFileReads: [...this.reads.values()].reduce((sum, value) => sum + value, 0), serializedObjects: this.serializationCount }; }
}
export function createQuestionReviewAuthorityScope(context: InterviewContext, root = process.cwd()) { return new QuestionReviewAuthorityScope(context, root); }
export interface QuestionReviewAuthority {
  kind: 'current_target_review' | 'unchanged_objective_ancestor_review';
  objectiveId: string; questionSha256: string; reviewModel: string; reviewArtifactSha256: string;
  sourceRevision: string;
  chain: Array<{ revision: string; contentSha256: string }>;
}

function authorityAt(target: TargetStudentAnalysis, objectiveId: string, questionSha256: string, reviewModel: string) {
  const trace = target.objectiveContractRevision;
  if (!trace || trace.blockedObjectives.some(row => row.objectiveId === objectiveId)) return null;
  if (trace.reviewModel !== reviewModel || !hashLike(trace.reviewArtifactSha256) || !trace.changedObjectiveIds.includes(objectiveId) || !trace.approvedQuestions?.some(row => row.objectiveId === objectiveId && row.questionSha256 === questionSha256)) return null;
  return trace;
}

/** An inherited independent approval is not a model-wide allowlist. Its exact
 * old utterance is usable only while the objective and record snapshot are
 * unchanged across verified immutable parent links. A newer decision about this
 * objective supersedes all older approvals, including an explicit rejection. */
export async function resolveQuestionReviewAuthority(context: InterviewContext, objectiveId: string, questionSha256: string, reviewModel: string, root = process.cwd(), scope = createQuestionReviewAuthorityScope(context, root)): Promise<QuestionReviewAuthority | null> {
  if (!scope.matches(context, root)) return null;
  const current = context.targetAnalysis;
  if (!current || !hashLike(questionSha256) || !reviewModel) return null;
  const latestTrace = current.objectiveContractRevision;
  if (latestTrace?.blockedObjectives.some(row => row.objectiveId === objectiveId)) return null;
  const direct = authorityAt(current, objectiveId, questionSha256, reviewModel);
  if (direct) return { kind: 'current_target_review', objectiveId, questionSha256, reviewModel, reviewArtifactSha256: direct.reviewArtifactSha256, sourceRevision: current.revision, chain: [] };
  if (latestTrace?.changedObjectiveIds.includes(objectiveId)) return null;
  const objective = current.objectives?.find(row => row.id === objectiveId);
  const manifest = context.manifest.files.find(row => row.role === 'fullStudentAnalysis');
  // Retain the original live-context body check on every ancestry lookup. The
  // caller's mutable target never obtains validity from the snapshot memo.
  if (!objective || !manifest?.sha256 || !hashLike(manifest.sha256) || !bodyMatches(current)) return null;
  const base = path.resolve(root, 'data/prepared/student-analysis-revisions'), currentFile = path.resolve(root, manifest.path), relative = path.relative(base, currentFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  let envelope: Envelope;
  try {
    const loaded = await scope.read(currentFile);
    if (!loaded || loaded.fileSha256 !== manifest.sha256) return null;
    envelope = loaded.envelope;
    if (envelope.target.contentSha256 !== current.contentSha256 || !scope.bodyMatches(envelope.target) || !scope.bodyMatches(envelope.common) || envelope.common.contentSha256 !== context.studentAnalysis?.contentSha256 || !/^[a-f0-9]{64}$/u.test(envelope.common.revision)) return null;
  } catch { return null; }
  const commonBytes = scope.text(envelope.common), evidenceBytes = scope.text(envelope.evidence), objectiveBytes = scope.text(objective);
  const commonDirectory = path.resolve(base, envelope.common.revision);
  const queue = [{ target: envelope.target, chain: [{ revision: current.revision, contentSha256: current.contentSha256 }] }];
  const visited = new Set<string>();
  while (queue.length && visited.size < 16) {
    const { target, chain } = queue.shift()!;
    if (visited.has(target.contentSha256)) continue;
    visited.add(target.contentSha256);
    if (scope.text(target.objectives.find(row => row.id === objectiveId)) !== objectiveBytes || target.objectiveContractRevision?.blockedObjectives.some(row => row.objectiveId === objectiveId)) continue;
    const authority = authorityAt(target, objectiveId, questionSha256, reviewModel);
    if (authority) return { kind: 'unchanged_objective_ancestor_review', objectiveId, questionSha256, reviewModel, reviewArtifactSha256: authority.reviewArtifactSha256, sourceRevision: target.revision, chain };
    if (target.objectiveContractRevision?.changedObjectiveIds.includes(objectiveId)) continue;
    const parents = [target.objectiveContractRevision, target.objectiveSourceReview].filter((value): value is NonNullable<typeof value> => Boolean(value));
    for (const parent of parents) {
      if (!/^target-[a-f0-9]{64}$/u.test(parent.parentRevision) || !hashLike(parent.parentContentSha256)) continue;
      // Original target snapshots can be stored directly under the common
      // revision; every fallback still has to match both the revision and hash.
      for (const file of [path.join(commonDirectory, parent.parentRevision, 'analysis.json'), path.join(commonDirectory, 'analysis.json')]) {
        try {
          const loaded = await scope.read(file); if (!loaded) continue;
          const previous = loaded.envelope;
          if (previous.target.revision !== parent.parentRevision || previous.target.contentSha256 !== parent.parentContentSha256 || !scope.bodyMatches(previous.target) || scope.text(previous.common) !== commonBytes || scope.text(previous.evidence) !== evidenceBytes || scope.text(previous.target.objectives.find(row => row.id === objectiveId)) !== objectiveBytes) continue;
          queue.push({ target: previous.target, chain: [...chain, { revision: previous.target.revision, contentSha256: previous.target.contentSha256 }] });
          break;
        } catch { /* Missing, changed or unrelated parent cannot grant approval. */ }
      }
    }
  }
  return null;
}
