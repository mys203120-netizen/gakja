import dotenv from 'dotenv';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { InterviewSession } from '../server/protocol';
import { loadInterviewContext } from '../server/data/load-interview-context';
import { createEvaluationActionRevision, applyEvaluationActionRevision, evaluateSessionWithActionRevision } from '../server/providers/evaluation-action-revision';
import { EvaluationJobStore } from '../server/evaluation-job-store';
import { buildEvaluationUnits } from '../server/providers/evaluation-turns';
import { normalizeProviderUsage, aggregateProviderCosts, estimateProviderCost } from '../server/observability/provider-cost';
import { LATEST_HUMAN_SESSION } from './benchmark-latest-interview';

dotenv.config({ path: '.env.local', quiet: true });
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const file = `data/sessions/${LATEST_HUMAN_SESSION}.json`, journalFile = `data/conversation-logs/${LATEST_HUMAN_SESSION}.jsonl`;
const bytes = await readFile(file), journalBytes = await readFile(journalFile);
const original = JSON.parse(bytes.toString('utf8')) as InterviewSession, context = await loadInterviewContext();
if (context.errors.length || original.turns.length !== 22) throw new Error('LATEST_ACTION_REVIEW_SOURCE_INVALID');
const target = original.turns[16], corrected = original.turns[17];
if (target.questionKind !== 'main' || corrected.questionKind !== 'follow_up' || target.parentMainQuestionId !== corrected.parentMainQuestionId) throw new Error('LATEST_ACTION_REVIEW_LINEAGE_CHANGED');
const span = (kind: 'question' | 'answer', turn: typeof target) => {
  const quote = kind === 'question' ? turn.questionText : turn.rawTranscript!;
  return { kind, turnId: turn.id, start: 0, end: quote.length, quote };
};
const revision = createEvaluationActionRevision(context, original, {
  reviewerAuthority: 'developer_review', reviewerId: 'codex-source-bound-dialogue-review-20261104', reviewedAt: new Date().toISOString(),
  reason: '실제 질문 두 문장과 그 사이 답변을 대조한 개발 검수다. 같은 전체 본인 수행 요구를 재안내한 발화를 독립 F 점수로 계산하지 않는다. 자동 의미 분류나 학생 기록 변경이 아니다.',
  changes: [{ turnId: corrected.id, sourceAnswerId: corrected.answerId!, originalKind: 'follow_up', correctedKind: 'clarification', clarificationOfTurnId: target.id,
    reason: '본인이 직접 한 일이 있다면 무엇인지 물은 뒤 세포 노화 방지를 위해 애썼다는 답에 다시 직접 맡은 일을 물었다. 새로운 하위 요구가 추가되지 않았으므로 같은 요구의 재진술이다.',
    reviewedSpans: [span('question', target), span('answer', target), span('question', corrected)] }],
});
const projection = applyEvaluationActionRevision(context, original, revision);
const usage: Array<ReturnType<typeof normalizeProviderUsage>> = [];
const report = { version: 'latest-human-reviewed-action-projection-v1', originalSessionId: original.id, originalSha256: hash(bytes), originalJournalSha256: hash(journalBytes),
  revision, audit: projection.audit, originalScoredUnits: buildEvaluationUnits(original).scoredUnits.length,
  revisedScoredUnits: buildEvaluationUnits(projection.session).scoredUnits.length, actualQuestionTextUnchanged: projection.session.turns.every((turn, index) => turn.questionText === original.turns[index].questionText),
  actualAnswersUnchanged: projection.session.turns.every((turn, index) => turn.rawTranscript === original.turns[index].rawTranscript && turn.answerId === original.turns[index].answerId),
  evaluation: null as unknown, reusedClusters: null as number | null, observedProviderCalls: 0, observedProviderCost: null as unknown, originalFilesModified: false };
if (process.argv.includes('--run-live')) {
  const previousPath = process.argv.find(value => value.startsWith('--previous='))?.slice('--previous='.length);
  if (!previousPath) throw new Error('LATEST_ACTION_REVIEW_PREVIOUS_RESULT_REQUIRED');
  const previous = JSON.parse(await readFile(previousPath, 'utf8')) as { job: { jobsDirectory: string; id: string } };
  const jobs = new EvaluationJobStore(previous.job.jobsDirectory), job = await jobs.get(previous.job.id);
  if (!job || job.status !== 'completed') throw new Error('LATEST_ACTION_REVIEW_BASE_EVALUATION_INCOMPLETE');
  const result = await evaluateSessionWithActionRevision(context, original, revision, { model: job.model, resumeClusters: job.checkpoints,
    onProviderUsage: observation => { usage.push(observation); } });
  report.evaluation = result; report.reusedClusters = 'evaluationPipeline' in result ? result.evaluationPipeline.reusedClusters : 0;
  report.observedProviderCalls = usage.length; report.observedProviderCost = aggregateProviderCosts(usage.map(estimateProviderCost));
}
if (hash(await readFile(file)) !== report.originalSha256 || hash(await readFile(journalFile)) !== report.originalJournalSha256) throw new Error('LATEST_ACTION_REVIEW_MODIFIED_ORIGINAL');
const output = `artifacts/latest-human-action-revision-${new Date().toISOString().replace(/[-:.]/gu, '')}.json`;
await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ output, originalScoredUnits: report.originalScoredUnits, revisedScoredUnits: report.revisedScoredUnits,
  questionsUnchanged: report.actualQuestionTextUnchanged, answersUnchanged: report.actualAnswersUnchanged, providerCalls: report.observedProviderCalls,
  reusedClusters: report.reusedClusters, publicRateCost: report.observedProviderCost, originalFilesModified: false }));
