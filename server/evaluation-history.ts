import type { InterviewContext } from './data/load-interview-context';
import type { InterviewSession } from './protocol';
import type { EvaluationRepository } from './repositories/evaluation-job-ports';
import { assertSessionOwner, snapshotHash } from './session-runtime';
import { assertEvaluationQuestionContracts } from './providers/evaluation-turns';
import { historicalEvaluationSourceFingerprint, HISTORICAL_REVIEWED_KNOWLEDGE_PIPELINE_VERSION } from './providers/evaluation-input';
import { knowledgeSessionQuestionAnswerHash } from './data/approved-knowledge';

function frozenInput(session: InterviewSession) {
  return { id: session.id, createdAt: session.createdAt, target: session.target, sourceManifest: session.sourceManifest,
    turns: session.turns, metrics: session.metrics, elapsedMs: session.elapsedMs, durationSeconds: session.durationSeconds,
    plan: session.plan, mainQuestionTarget: session.mainQuestionTarget, questionPresentations: session.questionPresentations,
    questionPresentationEventIds: session.questionPresentationEventIds, followUpCountByMainQuestion: session.followUpCountByMainQuestion,
    contextSnapshotSha256: session.runtime?.contextSnapshotSha256, engineVersion: session.runtime?.engineVersion,
    evaluationInputFrozenAt: session.runtime?.evaluationInputFrozenAt, acceptedEndRequest: session.runtime?.acceptedEndRequest };
}
export const evaluationFrozenInputHash = (session: InterviewSession) => snapshotHash(frozenInput(session));

/** A completed historical job is a read-only result revision. Validate both
 * stored immutable inputs and today's session projection; never trust an old
 * session.evaluation field, re-run an old worker or relabel its version. */
export async function loadHistoricalCompletedEvaluation(session: InterviewSession, context: InterviewContext,
  ownerId: string, jobs: Pick<EvaluationRepository, 'get' | 'snapshot' | 'result'>) {
  const reference = session.runtime?.evaluationJob;
  if (!reference || reference.pipelineVersion !== HISTORICAL_REVIEWED_KNOWLEDGE_PIPELINE_VERSION || session.status === 'active') return null;
  assertSessionOwner(session, ownerId);
  const job = await jobs.get(reference.id);
  if (!job || job.status !== 'completed') return null;
  if (job.id !== reference.id || job.sessionId !== session.id || job.ownerId !== ownerId || job.pipelineVersion !== reference.pipelineVersion ||
    job.sourceSha256 !== reference.sourceSha256 || job.model !== reference.model ||
    job.contextSnapshotSha256 !== session.runtime!.contextSnapshotSha256 || snapshotHash(context) !== job.contextSnapshotSha256) {
    throw new Error('HISTORICAL_EVALUATION_SOURCE_MISMATCH');
  }
  const snapshot = await jobs.snapshot(job), original = snapshot.session, originalReference = original.runtime?.evaluationJob;
  if (!originalReference || snapshotHash(originalReference) !== snapshotHash(reference) || original.status === 'active' ||
    snapshotHash(frozenInput(original)) !== snapshotHash(frozenInput(session)) ||
    knowledgeSessionQuestionAnswerHash(original) !== knowledgeSessionQuestionAnswerHash(session)) throw new Error('HISTORICAL_EVALUATION_INPUT_CHANGED');
  assertEvaluationQuestionContracts(original); assertEvaluationQuestionContracts(session);
  if (historicalEvaluationSourceFingerprint(context, original, job.pipelineVersion, job.model) !== job.sourceSha256 ||
    historicalEvaluationSourceFingerprint(context, session, job.pipelineVersion, job.model) !== job.sourceSha256) throw new Error('HISTORICAL_EVALUATION_SOURCE_MISMATCH');
  const result = await jobs.result(job);
  if (!result) throw new Error('HISTORICAL_EVALUATION_RESULT_MISSING');
  return result;
}
