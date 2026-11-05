import dotenv from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadInterviewContextAt, type InterviewContext } from '../server/data/load-interview-context';
import { mayAskFollowUp } from '../server/interview-planner';
import { mayAskClarification, mayReplayQuestion, type InterviewSession, type RecordedTurn } from '../server/protocol';
import { createSessionRuntime } from '../server/session-runtime';
import { runSingleCoreRuntime } from '../server/providers/single-core-runtime';
import { decodeSingleCoreCandidateDecision, encodeSingleCoreCandidateResponse } from '../server/providers/single-core-contract';
import { assertSubordinateQuestionTermination } from '../server/providers/question-plan';
import { buildEvaluationUnits } from '../server/providers/evaluation-turns';
import { writeRevisedBankCapture } from './capture-revised-bank-turns';
import { LATEST_HUMAN_SESSION, visibleFollowUpCounts } from './benchmark-latest-interview';
import type { ProviderUsageObservation } from '../server/observability/provider-cost';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourcePath = `data/sessions/${LATEST_HUMAN_SESSION}.json`;
const journalPath = `data/conversation-logs/${LATEST_HUMAN_SESSION}.jsonl`;
const decisionPath = 'artifacts/quality-v13-core-full-20261104.json';

/** No question regeneration or original-session mutation: the historical Q8
 * prefix and its IDs stay fixed inside a newly identified in-memory session. */
export async function prepareTruncatedQuestionRepair(root = process.cwd()) {
  const [sourceBytes, journalBytes, decisionBytes] = await Promise.all([sourcePath, journalPath, decisionPath].map(file => readFile(path.resolve(root, file))));
  const original = JSON.parse(sourceBytes.toString('utf8')) as InterviewSession;
  const journal = journalBytes.toString('utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line) as { type: string; turnId?: string; payload?: { elapsedMs?: number } });
  const report = JSON.parse(decisionBytes.toString('utf8')) as { results: Array<{ id: string; question: string; rawTranscript: string; decision: unknown }> };
  const rows = report.results.filter(row => row.id === 'Q8');
  const source = original.turns[7];
  if (original.id !== LATEST_HUMAN_SESSION || original.turns.length !== 22 || rows.length !== 1 || source.questionKind !== 'main' || source.rawTranscript !== rows[0].rawTranscript || source.questionText !== rows[0].question) throw new Error('TRUNCATED_Q8_SOURCE_MISMATCH');
  const decision = decodeSingleCoreCandidateDecision(encodeSingleCoreCandidateResponse(rows[0].decision as Parameters<typeof encodeSingleCoreCandidateResponse>[0]));
  if (decision.next.action !== 'CLARIFICATION' || decision.next.question.text.length !== 80) throw new Error('TRUNCATED_Q8_DECISION_CHANGED');
  let invalid = false;
  try { assertSubordinateQuestionTermination({ questionKind: 'clarification', questionText: decision.next.question.text }); } catch { invalid = true; }
  if (!invalid) throw new Error('TRUNCATED_Q8_FORMAT_DEFECT_NOT_REPRODUCED');
  const context = await loadInterviewContextAt(root, { writeManifest: false });
  if (context.errors.length) throw new Error('TRUNCATED_Q8_CONTEXT_INVALID');
  const pdf = (original.sourceManifest as InterviewContext['manifest']).files.find(file => file.role === 'studentPdf')?.sha256;
  if (!pdf || pdf !== context.manifest.files.find(file => file.role === 'studentPdf')?.sha256) throw new Error('TRUNCATED_Q8_PDF_CHANGED');
  const session = structuredClone(original), current = session.turns[7];
  session.id = randomUUID(); session.turns = session.turns.slice(0, 8); session.status = 'active'; session.evaluationStatus = 'pending';
  session.sourceManifest = structuredClone(context.manifest);
  session.runtime = createSessionRuntime(context, { id: 'synthetic-truncated-question-repair-check', mode: 'local-development' });
  const elapsed = journal.find(row => row.type === 'answer.metrics' && row.turnId === current.id)?.payload?.elapsedMs;
  if (!Number.isFinite(elapsed)) throw new Error('TRUNCATED_Q8_HISTORICAL_TIME_MISSING');
  session.elapsedMs = elapsed!;
  const visible = new Set(session.turns.map(turn => turn.id));
  session.questionPresentations = session.questionPresentations?.filter(item => visible.has(item.turnId));
  session.questionPresentationEventIds = []; session.followUpCountByMainQuestion = visibleFollowUpCounts(session);
  if (session.plan?.selectionContext) delete session.plan.selectionContext.lastSelection;
  delete session.conversationLedger; delete session.providerUsageLedger; delete session.evaluation; delete session.evaluationError;
  delete current.metadata.coreDecision; delete current.metadata.answerReaction; delete current.metadata.answerContext;
  delete current.metadata.answerCandidateId; delete current.metadata.answerCommitStatus;
  session.metrics = { verification: { syntheticTest: true, scenario: 'frozen-v13-truncated-question-final-gate', historicalQuestionAndAnswerPreserved: true, providerGeneratedStudent: false, questionPlayed: false } };
  return { context, session, decision, sources: [
    { path: sourcePath, sha256: sha(sourceBytes) }, { path: journalPath, sha256: sha(journalBytes) }, { path: decisionPath, sha256: sha(decisionBytes) },
  ] };
}

async function main() {
  dotenv.config({ path: '.env.local', quiet: true });
  const args = process.argv.slice(2), live = args.includes('--run-live');
  if (args.some(arg => arg !== '--run-live' && arg !== '--max-calls=2' && !arg.startsWith('--out=')) || live && !args.includes('--max-calls=2')) throw new Error('USE_OPTIONAL_OUT_OR_RUN_LIVE_WITH_MAX_CALLS_2');
  const output = args.find(arg => arg.startsWith('--out='))?.slice(6) ?? '.local/engine-refactor-bench/truncated-q8-repair-capture.json';
  const { context, session, decision, sources } = await prepareTruncatedQuestionRepair();
  const current = session.turns.at(-1)!, before = JSON.stringify(session), usage: Array<{ stage: string; observation: ProviderUsageObservation }> = [];
  const report: Record<string, unknown> = { version: 'frozen-truncated-question-final-gate-v1', createdAt: new Date().toISOString(), live,
    maxPaidCalls: live ? 2 : 0, maxSdkRetries: 0, coreProviderCalls: 0, sourceRecordsModified: false, persistedAsHumanSession: false, fullAudioE2E: false,
    sources, contextManifestSha256: sha(JSON.stringify(context.manifest)), question: current.questionText, rawTranscript: current.rawTranscript,
    frozenSemanticDecision: decision, historicalTurnId: current.id, historicalAnswerId: current.answerId,
    elapsedMs: session.elapsedMs, followUpCounts: session.followUpCountByMainQuestion,
    note: '기존 80자 미종결 C 결정만 재사용한다. capture 모드는 API 0회. live는 실제 production 표면 재구성 최대 1회와 독립 사실 검수 최대 1회이며 새 코어·TTS·평가·세션 저장은 호출하지 않는다.',
  };
  if (live) {
    // The initial final-format check fails before a factual provider call. The
    // existing bounded repair branch has one repair and one final review, both
    // SDK maxRetries:0. Neither provider seam below returns a fake approval.
    const result = await runSingleCoreRuntime(context, session, {
      policyMode: 'compiled', coreReasoningEffort: 'low',
      allowFollowUp: mayAskFollowUp(session, session.durationSeconds!, 2), allowClarification: mayAskClarification(session, session.durationSeconds!),
      allowReplay: mayReplayQuestion(session, session.durationSeconds!), requestSingleCore: async () => encodeSingleCoreCandidateResponse(decision),
      onProviderUsage: (stage, observation) => { usage.push({ stage, observation }); },
    });
    const draft = result.draft;
    const delivered = draft ? { ...current, id: 'synthetic-repaired-clarification', questionKind: 'clarification', questionText: draft.questionText,
      metadata: { ...current.metadata, ...draft, nonEvaluative: true, clarificationOfTurnId: current.id } } as RecordedTurn : null;
    const evaluation = delivered ? buildEvaluationUnits({ turns: [current, delivered] }) : null;
    Object.assign(report, { result, providerUsage: usage, checks: {
      noCoreProviderUsage: usage.every(item => item.stage !== 'core'), paidCallsAtMostTwo: usage.length <= 2,
      actualRepairOne: result.providerTimings.repairModelCalls === 1, actualFactReviewOne: result.providerTimings.premiseReviewAttempts === 1,
      ready: result.execution?.status === 'ready', kindPreserved: draft?.questionKind === 'clarification',
      meaningPreserved: draft?.questionIntent === current.metadata.questionIntent && JSON.stringify(draft?.targetEvidence) === JSON.stringify(current.metadata.targetEvidence),
      decisionPreserved: JSON.stringify(result.semanticDecision) === JSON.stringify(decision),
      transcriptAndCheckpointPreserved: before === JSON.stringify(session), followUpCountUnchanged: (session.followUpCountByMainQuestion[current.parentMainQuestionId] ?? 0) === 0,
      clarificationAddsNoEvaluationUnit: evaluation?.units.length === 1,
      finalFactReviewApproved: draft?.premiseValidation?.status === 'approved' && draft.premiseValidation.method === 'bounded_fact_review',
    } });
  }
  for (const source of sources) if (sha(await readFile(source.path)) !== source.sha256) throw new Error('TRUNCATED_Q8_SOURCE_CHANGED');
  await writeRevisedBankCapture(output, report);
  console.log(JSON.stringify({ output, live, providerCallsObserved: usage.length, checks: report.checks ?? null }));
  if (live && Object.values(report.checks as Record<string, boolean>).some(passed => !passed)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => {
  console.error(error instanceof Error ? error.message : 'TRUNCATED_Q8_CHECK_FAILED'); process.exitCode = 1;
});
