import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { InterviewContext } from '../server/data/load-interview-context';
import { selectPreparedMainQuestion, type PreparedQuestionBank } from '../server/data/prepared-question-bank';
import { bindQuestionContractToTurn } from '../server/question-objective';
import { createSessionRuntime } from '../server/session-runtime';
import type { InterviewSession, RecordedTurn } from '../server/protocol';

export const replayHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Capture new implementation modules as well as the historical fixed list. */
export async function replayEngineSourceFingerprints() {
  const entries = await readdir('server', { recursive: true });
  const files = ['interview.config.ts', ...entries.filter(file => file.endsWith('.ts'))
    .map(file => path.join('server', file).replace(/\\/gu, '/'))].sort();
  return Object.fromEntries(await Promise.all(files.map(async file => [file, replayHash(await readFile(file))])));
}
const canonical = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
type Data = Record<string, any>;
export interface ReplayBaseline extends Data { bankKey: string; bankContentSha256: string; turns: Data[]; finalSession: InterviewSession }

export function rootQuestionForBaseline(baseline: ReplayBaseline, row: Data) {
  const root = baseline.finalSession.turns.find(turn => turn.id === row.clusterId);
  if (!root || root.questionKind !== 'main') throw new Error('REPLAY_BASELINE_ROOT_MISSING');
  return root.questionText;
}

/** Preserve original answer order inside the same approved Q0. No text is invented
 * for a new question or for an exhausted/diverged cluster. */
export function nextReplayAnswer(baseline: ReplayBaseline, rootQuestion: string, consumedIndices: ReadonlySet<number>) {
  return baseline.turns.find(row => typeof row.syntheticStudent?.text === 'string' && row.capture &&
    !consumedIndices.has(row.index) && canonical(rootQuestionForBaseline(baseline, row)) === canonical(rootQuestion));
}

/** Optional test-driver expansion only after all fixed answers for this exact
 * original root are consumed. Never substitute an answer from another root. */
export function maySupplementReplayRoot(baseline: ReplayBaseline, rootQuestion: string, consumedIndices: ReadonlySet<number>) {
  const sameRoot = baseline.turns.filter(row => canonical(rootQuestionForBaseline(baseline, row)) === canonical(rootQuestion));
  return sameRoot.length > 0 && sameRoot.every(row => consumedIndices.has(row.index)) &&
    baseline.turns.some(row => !consumedIndices.has(row.index));
}

export function assertReplayBank(baseline: ReplayBaseline, bank: PreparedQuestionBank, original?: Pick<InterviewSession, 'plan'>) {
  // Historical generic log redaction treated *Key as a credential. Recover the
  // identity only from the original server-owned pinned plan, never a guess.
  const baselineKey = baseline.bankKey === '[redacted]' ? original?.plan?.poolKey : baseline.bankKey;
  if (baselineKey !== bank.key || baseline.bankContentSha256 !== bank.contentSha256 ||
    original && (original.plan?.poolKey !== bank.key || original.plan?.poolContentSha256 !== bank.contentSha256)) throw new Error('REPLAY_BANK_CHANGED');
  if (!baseline.turns.length || !baseline.finalSession?.plan || !baseline.finalSession?.turns.length) throw new Error('REPLAY_BASELINE_INCOMPLETE');
  if (baseline.turns.some(row => typeof row.syntheticStudent?.text !== 'string' || !row.capture || typeof row.capture.rawTranscript !== 'string')) throw new Error('REPLAY_ANSWER_MISSING');
}

/** A restored, bank-approved question checkpoint is seeded once BEFORE the
 * isolated server starts. No answers, transcripts or generated decisions from
 * the old session are copied into the new live engine state. */
export function createReplayCheckpoint(context: InterviewContext, bank: PreparedQuestionBank, original: InterviewSession, ownerId: string) {
  const plan = structuredClone(original.plan);
  if (!plan || plan.poolKey !== bank.key || plan.poolContentSha256 !== bank.contentSha256) throw new Error('REPLAY_PLAN_NOT_PINNED');
  if (plan.selectionContext?.scope) plan.selectionContext.scope.ownerId = ownerId;
  if (plan.selectionContext) { plan.selectionContext.historySessionIds = []; delete plan.selectionContext.lastSelection; }
  const now = new Date().toISOString(), runtime = createSessionRuntime(context, { id: ownerId, mode: 'local-development' }, now);
  const session: InterviewSession = {
    id: randomUUID(), createdAt: now, updatedAt: now, status: 'active', evaluationStatus: 'pending',
    target: structuredClone(context.target), runtime,
    sourceManifest: { ...structuredClone(context.manifest), interviewPlan: structuredClone(plan) },
    durationSeconds: context.interviewOverview!.durationSeconds, interviewOverview: structuredClone(context.interviewOverview),
    plan, mainQuestionTarget: plan.mainQuestionTarget, hasGreeted: false, turns: [],
    questionPresentations: [], questionPresentationEventIds: [], followUpCountByMainQuestion: {}, elapsedMs: 0,
    metrics: { verification: { syntheticTest: true, syntheticVoice: true, syntheticClientObservation: true,
      scenario: 'same-answer-bank-checkpoint-replay', noAnswerInjectedAtCheckpoint: true } },
  };
  const selected = selectPreparedMainQuestion(bank, session, 1);
  const originalRoot = original.turns.find(turn => turn.questionKind === 'main');
  if (!selected || !originalRoot || selected.draft.questionText !== originalRoot.questionText) throw new Error('REPLAY_FIRST_QUESTION_CHANGED');
  const id = randomUUID(), draft = selected.draft;
  const binding = bindQuestionContractToTurn(draft, context, session, id);
  const turn: RecordedTurn = {
    id, questionText: draft.questionText, questionKind: 'main', parentMainQuestionId: id,
    mainIndex: 1, mainCount: plan.mainQuestionTarget, followUpIndex: 0, evidenceIds: [...draft.evidenceIds],
    questionAudioUrl: selected.audioUrl, acknowledgement: originalRoot.acknowledgement,
    acknowledgementAudioUrl: originalRoot.acknowledgementAudioUrl, interviewerId: originalRoot.interviewerId,
    metadata: { ...structuredClone(draft), ...binding, rulesVersion: context.manifest.rulesVersion, generatedAt: now,
      answerTurnId: null, sourceAnswerId: null, sourceRefIds: [...draft.evidenceIds],
      supportTarget: structuredClone(context.target), parentQuestionId: null, questionClusterId: id,
      activityIds: [...selected.slot.activityIds], planSlotId: selected.slot.id, topicArea: selected.slot.topicArea,
      providerTimings: { preparedCacheHit: 1, preparedMainBankHit: 1, questionTtsMs: 0, questionTtsCacheHit: 1 },
    },
  };
  Object.assign(turn.metadata, { questionBankKey: bank.key, questionBankCandidateId: selected.candidateId,
    voiceSettings: { question: structuredClone(selected.voiceSettings) } });
  session.turns.push(turn); session.followUpCountByMainQuestion[id] = 0;
  runtime.checkpoint = { phase: 'question_prepared', at: now, turnId: id, answerId: null };
  if (turn.acknowledgement && turn.acknowledgementAudioUrl) runtime.opening = { id: randomUUID(), questionTurnId: id,
    text: turn.acknowledgement, audioUrl: turn.acknowledgementAudioUrl, interviewerId: turn.interviewerId };
  return session;
}
