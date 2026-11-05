import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import type { InterviewContext, StudentEvidence } from '../server/data/load-interview-context';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../server/protocol';
import { runStrategyRealtimeCore } from '../server/providers/realtime-strategy-core';
import { buildQuestionPremiseReviewInput, finalizeQuestionPremiseReview } from '../server/providers/question-premises';
import { createQuestionBlueprint, approveQuestionContract } from '../server/question-objective';
function fixture(raw = '자료의 작성 시점과 조사 대상을 비교했습니다.', primary: 'PROCESS' | 'EVIDENCE' = 'PROCESS') {
  const source: StudentEvidence = { id: 'E01', activityId: 'A01', page: 3, grade: 2, section: '세특', title: '자료 조사', text: '자료를 선택해 비교하는 탐구를 진행함.', sourceRef: { file: 'synthetic-student.pdf', pdfSha256: 'a'.repeat(64), page: 3, extraction: 'synthetic-test', startOffset: 10, endOffset: 33 }, confirmationStatus: 'confirmed_from_record', preparationPriority: null, scientificTruthVerification: 'not_independently_verified' };
  const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText: primary === 'PROCESS' ? '자료를 비교한 과정은 무엇인가요?' : '자료를 보고 내린 판단의 근거는 무엇인가요?', questionKind: 'main', parentMainQuestionId: null, evidenceIds: ['E01'], evidenceQuotes: [{ evidenceId: 'E01', quote: source.text }], primaryFunction: primary, questionIntent: primary === 'PROCESS' ? '실제 자료 비교 과정 확인' : '실제 판단 근거 확인', targetEvidence: [primary === 'PROCESS' ? '실제로 거친 한 단계' : '판단 근거 한 가지'], depth: 'D2', groundingRationale: '기록된 자료 비교의 한 가지 목적을 확인한다.', validationStatus: 'approved', validationFailures: [] };
  const audit = finalizeQuestionPremiseReview({ verdict: 'allowed', completeAssertionCoverage: true, coreIntentCount: 1, intentMatches: true, clarificationPreservesIntent: true, premises: [{ questionSpan: '자료를', basis: 'record', sourceId: 'E01', supportQuote: source.text, supported: true }] }, buildQuestionPremiseReviewInput(draft, [source]), 'explicit-synthetic-offline-review');
  draft.premiseValidation = audit;
  const context = { questionReferences: null, questionStrategies: null, errors: [], student: { evidence: [source] }, school: { sources: [] }, interviewOverview: null, manifest: { rulesVersion: 'target-first-test', sourceIntegrity: { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true, evidenceCount: 1 }, files: [{ role: 'studentPdf', path: 'synthetic-student.pdf', sha256: source.sourceRef.pdfSha256 }] } } as unknown as InterviewContext;
  const session = { id: 'target-first-synthetic-session', sourceManifest: structuredClone(context.manifest), followUpCountByMainQuestion: {}, elapsedMs: 0, durationSeconds: 720, turns: [] } as unknown as InterviewSession;
  const blueprint = createQuestionBlueprint(draft, context, session, { questionId: 'q0' });
  draft.questionBlueprint = blueprint;
  draft.approvedQuestion = approveQuestionContract(draft, blueprint);
  const turn = { id: 'q0', answerId: 'answer0', parentMainQuestionId: 'q0', mainIndex: 1, mainCount: 5, questionText: draft.questionText, questionKind: 'main', followUpIndex: 0, evidenceIds: ['E01'], rawTranscript: raw, transcriptStatus: 'finalized', metadata: { ...draft, rulesVersion: 'target-first-test', questionClusterId: 'q0', activityIds: ['A01'] } } as unknown as RecordedTurn;
  session.turns.push(turn);
  return { context, session, turn };
}

if (!process.argv.includes('--run-live')) {
  process.stdout.write('Explicit synthetic provider smoke only: npx tsx scripts/verify-engine-upgrade.ts --run-live\n');
} else {
  dotenv.config({ path: '.env.local', quiet: true });
  const f = fixture('그냥 자료를 비교했습니다.');
  const started = performance.now();
  const result = await runStrategyRealtimeCore(f.context, f.session, { allowFollowUp: true, allowClarification: true });
  const report = { observedAt: new Date().toISOString(), provenance: { syntheticTest: true, syntheticStudent: true, realCoreProvider: true, realFinalReview: (result.providerTimings.premiseReviewAttempts ?? 0) > 0, microphoneUsed: false, browserPlaybackMeasured: false, sourceQuestionReview: 'synthetic-fixture-only' },
    engineVersion: result.engineVersion, origin: result.origin, nextAction: result.nextAction, failureCode: result.failureCode ?? null, failureStage: result.failureStage ?? null, failureDetail: result.failureDetail ?? null, candidateQuestion: result.candidateQuestion ?? null,
    interpretation: result.interpretation ?? null, question: result.draft?.questionText ?? null, requestedMeaning: result.draft?.targetEvidence ?? null,
    review: result.draft?.approvedQuestion?.validation ?? null, providerTimings: result.providerTimings, elapsedMs: performance.now() - started,
    model: process.env.OPENAI_QUESTION_MODEL || 'gpt-6-luna', scope: 'One synthetic turn with real provider; not a real interview, STT or voice quality evaluation.' };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/engine-upgrade-provider-smoke.json', JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ origin: report.origin, action: report.nextAction, failure: report.failureCode, stage: report.failureStage, timings: report.providerTimings, artifact: 'artifacts/engine-upgrade-provider-smoke.json' }) + '\n');
  if (result.origin === 'fallback') process.exitCode = 1;
}
