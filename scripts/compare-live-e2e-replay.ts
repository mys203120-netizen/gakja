import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { replayHash } from './live-e2e-replay';
import { numericSummary } from './summarize-runtime-policy-cost';
import { transcriptDifference } from './summarize-live-interview-e2e';

type Data = Record<string, any>;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const stats = (values: unknown[]) => numericSummary(values.filter(finite));
const readyMs = (turn: Data) => turn.response?.events?.find((event: Data) => event.type === 'turn_ready')?.afterSubmitMs ?? turn.response?.submitToNextReadyMs ?? null;
const attempts = (turn: Data) => [turn.firstFailedResponse, turn.response].filter(Boolean);
const interaction = (report: Data, row: Data) => {
  const next = report.finalSession?.turns?.find((turn: Data) => turn.id === row.next?.turnId);
  const clarificationMode = next?.metadata?.clarificationMode ?? row.coreDecision?.clarificationMode ?? null;
  return { clarificationMode, interactionAction: row.coreDecision?.execution?.action ??
    (clarificationMode === 'repeat_audio' ? 'REPLAY' : row.coreDecision?.nextAction ?? null) };
};

export function compareReplayRun(before: Data, after: Data) {
  if (!after.replay || after.replay.sourceSessionId !== before.sessionId) throw new Error('REPLAY_SESSION_PAIR_MISMATCH');
  const rows = after.turns.filter((turn: Data) => turn.capture?.exactReplayInput).map((turn: Data) => {
    const proof = turn.capture.exactReplayInput, original = before.turns.find((row: Data) => row.index === proof.sourceIndex);
    if (!original || replayHash(original.syntheticStudent.text) !== proof.answerSha256 || proof.answerSha256 !== proof.baselineAnswerSha256 || !proof.pcmHashEqualToFrozenBaseline) throw new Error('REPLAY_INPUT_NOT_IDENTICAL');
    return { sourceIndex: original.index, scenario: original.scenario, intendedAnswer: original.syntheticStudent.text,
      exactAnswerSha256: proof.answerSha256, pcmSha256: proof.pcmSha256,
      sameReconstructedPcm: proof.pcmHashEqualToFrozenBaseline, sameOriginalPcmBytes: proof.pcmBytesEqual,
      before: { question: original.question, kind: original.questionKind, rawTranscript: original.capture.rawTranscript,
        ...interaction(before, original),
        action: original.coreDecision?.nextAction ?? null, fulfillment: original.coreDecision?.fulfillment ?? null,
        failure: original.coreDecision?.failureDetail ?? null, nextQuestion: original.next?.question ?? null,
        nextKind: original.next?.kind ?? null, acknowledgement: original.next?.acknowledgement ?? null,
        responseStatus: original.response?.status, sttMs: original.capture.sttFinalizeMs,
        submitToReadyMs: readyMs(original), nextAttemptMs: attempts(original).map((attempt: Data) => attempt.nextMs),
        failureAttempts: attempts(original).filter((attempt: Data) => attempt.status !== 200).length,
        transcriptDifference: transcriptDifference(original.syntheticStudent.text, original.capture.rawTranscript) },
      after: { question: turn.question, kind: turn.questionKind, rawTranscript: turn.capture.rawTranscript,
        ...interaction(after, turn),
        action: turn.coreDecision?.nextAction ?? null, fulfillment: turn.coreDecision?.fulfillment ?? null,
        failure: turn.coreDecision?.failureDetail ?? null, nextQuestion: turn.next?.question ?? null,
        nextKind: turn.next?.kind ?? null, acknowledgement: turn.next?.acknowledgement ?? null,
        responseStatus: turn.response?.status, sttMs: turn.capture.sttFinalizeMs,
        submitToReadyMs: readyMs(turn), nextAttemptMs: attempts(turn).map((attempt: Data) => attempt.nextMs),
        failureAttempts: attempts(turn).filter((attempt: Data) => attempt.status !== 200).length,
        followUpsBefore: turn.followUpsBefore, followUpsAfter: turn.followUpsAfter,
        answerIdPreserved: turn.answerIdPreserved, transcriptPreserved: turn.transcriptPreserved,
        providerTimings: turn.coreDecision?.providerTimings ?? null,
        transcriptDifference: transcriptDifference(turn.syntheticStudent.text, turn.capture.rawTranscript) },
      questionSurfaceChanged: original.question !== turn.question, questionKindChanged: original.questionKind !== turn.questionKind,
    };
  });
  const pairedReady = rows.filter((row: Data) => finite(row.before.submitToReadyMs) && finite(row.after.submitToReadyMs));
  return { sourceSessionId: before.sessionId, replaySessionId: after.sessionId, completedAt: after.completedAt ?? null,
    engineSourceSha256: after.engineSourceSha256 ?? null,
    engineSourceUnchanged: after.engineSourceUnchanged ?? null,
    exactAnswerAndReconstructedPcmInputs: rows.length, originalAnswerCount: before.turns.length,
    allOriginalAnswersReplayed: rows.length === before.turns.length,
    unusedSourceIndices: after.replay.unusedSourceIndices ?? [], divergence: after.replay.divergence ?? null,
    newStudentGenerationCalls: after.replay.newStudentGenerationCalls,
    timings: { beforeSttMs: stats(rows.map((row: Data) => row.before.sttMs)), afterSttMs: stats(rows.map((row: Data) => row.after.sttMs)),
      beforeNextAllAttemptsMs: stats(rows.flatMap((row: Data) => row.before.nextAttemptMs)), afterNextAllAttemptsMs: stats(rows.flatMap((row: Data) => row.after.nextAttemptMs)),
      sameSuccessCohortBeforeSubmitToReadyMs: stats(pairedReady.map((row: Data) => row.before.submitToReadyMs)),
      sameSuccessCohortAfterSubmitToReadyMs: stats(pairedReady.map((row: Data) => row.after.submitToReadyMs)),
      previouslyBlockedNowReady: rows.filter((row: Data) => !finite(row.before.submitToReadyMs) && finite(row.after.submitToReadyMs)).map((row: Data) => ({ sourceIndex: row.sourceIndex, afterMs: row.after.submitToReadyMs })),
    },
    failures: { beforeAttempts: rows.reduce((n: number, row: Data) => n + row.before.failureAttempts, 0), afterAttempts: rows.reduce((n: number, row: Data) => n + row.after.failureAttempts, 0),
      beforeBlockedAnswers: rows.filter((row: Data) => row.before.responseStatus !== 200).length,
      afterBlockedAnswers: rows.filter((row: Data) => row.after.responseStatus !== 200).length,
      afterRunFailures: after.failures ?? [] },
    stored: { evaluationStatus: after.finalSession?.evaluationStatus ?? null, evaluationNotRequested: after.evaluationNotRequested ?? false,
      productionUsageSummary: after.finalSession?.providerUsageLedger?.summary ?? null, logPath: after.logPath },
    rows,
  };
}

async function main() {
  const args = process.argv.slice(2), output = args.find(arg => arg.startsWith('--out='))?.slice(6) ?? 'artifacts/live-interview-e2e-replay-comparison';
  const jsonOnly = args.includes('--json-only');
  if (!/^artifacts\/[a-zA-Z0-9-]+$/u.test(output)) throw new Error('COMPARISON_OUTPUT_PATH_INVALID');
  for (const file of [output + '.json', ...(jsonOnly ? [] : [output + '.md'])]) {
    if (await access(file).then(() => true, () => false)) throw new Error('COMPARISON_OUTPUT_ALREADY_EXISTS');
  }
  const files = args.filter(arg => !arg.startsWith('--'));
  if (!files.length) throw new Error('REPLAY_OUTPUTS_REQUIRED');
  const runs = [];
  for (const source of files) {
    const bytes = await readFile(source), after = JSON.parse(bytes.toString());
    if (!after.completedAt) throw new Error('REPLAY_RUN_NOT_COMPLETE');
    const baselineBytes = await readFile(after.replay.sourcePath);
    if (replayHash(baselineBytes) !== after.replay.sourceSha256) throw new Error('REPLAY_BASELINE_FILE_CHANGED');
    runs.push({ replaySourceFile: source, replaySourceSha256: replayHash(bytes), ...compareReplayRun(JSON.parse(baselineBytes.toString()), after) });
  }
  const sourceFingerprints = runs.map(run => run.engineSourceSha256 ? replayHash(JSON.stringify(run.engineSourceSha256)) : null);
  const result = { version: 'live-e2e-same-answer-replay-comparison-v1', generatedAt: new Date().toISOString(),
    engineSourceHashesRecordedForAllRuns: sourceFingerprints.every(Boolean),
    engineSourceHashesIdenticalAcrossRuns: sourceFingerprints.every(Boolean) && new Set(sourceFingerprints).size === 1, runs,
    engineSourceUnchangedDuringAllRuns: runs.every(run => run.engineSourceUnchanged === true),
    limits: ['Actual same-bank checkpoint restoration then live HTTP/WS/STT/core/review/TTS; not a fresh start endpoint or full timed human browser interview.',
      'Historical PCM hashes were not recorded. Original cached synthesis and recorded padding were reconstructed and frozen before replay, and all replay waveform hashes were checked against that manifest.',
      'Question wording/kinds may change after the fix. Each row records that divergence; no answer is forced onto a different Q0 and unmatched/new clusters stop without invented answers.',
      'Timing comparisons use matched replayed answers; successful-time comparisons require success in both runs. Failed/missing questions are not zero-latency successes.',
      'Cache history, service load, changed questions and small samples prevent a causal latency/SLA claim. Synthetic observations are not human microphone or browser playback measurements.'] };
  const seconds = (value: unknown) => finite(value) ? (value / 1000).toFixed(2) + '초' : '준비 실패/미관측';
  let md = '# 동일 답변·동일 재구성 음성 E2E 비교\n\n실제 은행 승인 질문을 복원한 체크포인트부터 HTTP/WS·음성·코어·검수·저장을 실행했습니다. 브라우저 재생과 면접 시계는 모의 관찰입니다.\n\n';
  for (const run of runs) {
    md += `## ${run.replaySessionId}\n\n기존 회차 ${run.sourceSessionId}. 동일 입력 ${run.exactAnswerAndReconstructedPcmInputs}/${run.originalAnswerCount}개, 사용하지 않은 원답변 ${JSON.stringify(run.unusedSourceIndices)}.\n\n`;
    md += `실패 요청 ${run.failures.beforeAttempts} → ${run.failures.afterAttempts}회, 최종 준비 실패 답변 ${run.failures.beforeBlockedAnswers} → ${run.failures.afterBlockedAnswers}개. 같은 성공 표본의 제출→준비 평균 ${seconds(run.timings.sameSuccessCohortBeforeSubmitToReadyMs.mean)} → ${seconds(run.timings.sameSuccessCohortAfterSubmitToReadyMs.mean)}.\n\n`;
    md += '| 원 턴 | 상황 | 기존 다음 질문/종류 | 변경 후 다음 질문/종류 | 기존 제출→준비 | 변경 후 제출→준비 |\n|---:|---|---|---|---:|---:|\n';
    for (const row of run.rows) md += `| ${row.sourceIndex} | ${row.scenario} | ${(row.before.nextQuestion ?? '준비 실패').replace(/\|/gu, '/')} / ${row.before.nextKind ?? '-'} | ${(row.after.nextQuestion ?? '준비 실패').replace(/\|/gu, '/')} / ${row.after.nextKind ?? '-'} | ${seconds(row.before.submitToReadyMs)} | ${seconds(row.after.submitToReadyMs)} |\n`;
    md += `\n진행 분기: ${JSON.stringify(run.divergence)}. 평가: ${run.stored.evaluationStatus ?? '미관측'}. 상세 전사 원문과 원장·실패는 JSON에 보존했습니다.\n\n`;
  }
  md += '## 해석 한계\n\n' + result.limits.map(limit => '- ' + limit).join('\n') + '\n';
  await writeFile(output + '.json', JSON.stringify(result, null, 2), { mode: 0o600 });
  if (!jsonOnly) await writeFile(output + '.md', md, { mode: 0o600 });
  console.log(JSON.stringify({ output, runs: runs.length, pairedAnswers: runs.reduce((n, run) => n + run.exactAnswerAndReconstructedPcmInputs, 0) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error instanceof Error ? error.message : 'COMPARISON_FAILED'); process.exitCode = 1; });
