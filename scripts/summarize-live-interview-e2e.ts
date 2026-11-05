import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { numericSummary } from './summarize-runtime-policy-cost';

type Data = Record<string, any>;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const measured = (values: unknown[]) => values.filter(finite);
const text = (value: unknown) => typeof value === 'string' ? value : '';
const normalizeSpeech = (value: string) => value.normalize('NFC').toLocaleLowerCase('ko-KR').replace(/[\p{P}\p{Z}\s]/gu, '');

/** A mechanical difference signal, not a language-aware STT correctness score. */
export function transcriptDifference(intended: string, transcript: string) {
  const expected = Array.from(normalizeSpeech(intended)), actual = Array.from(normalizeSpeech(transcript));
  let edits: number | null = null;
  if (expected.length <= 4000 && actual.length <= 4000) {
    let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
    for (let i = 1; i <= expected.length; i++) {
      const current = [i];
      for (let j = 1; j <= actual.length; j++) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + Number(expected[i - 1] !== actual[j - 1]));
      previous = current;
    }
    edits = previous[actual.length];
  }
  return { intended, transcript, exactEqual: intended === transcript,
    punctuationWhitespaceCaseNormalizedEqual: expected.join('') === actual.join(''),
    normalizedCharacterEdits: edits,
    normalizedCharacterErrorRatio: edits === null || !expected.length ? null : edits / expected.length,
    expectedNormalizedCharacters: expected.length, actualNormalizedCharacters: actual.length,
    note: 'Mechanical comparison only. Pronunciation aliases, acronyms and valid Korean spacing require manual review; no raw transcript is corrected.' };
}

function duplicateObservations(turns: Data[]) {
  const seen = new Map<string, Data>(), duplicates: Data[] = [], repeatedGreetings: Data[] = [];
  turns.forEach((turn, index) => {
    const question = text(turn.question).trim();
    const prior = seen.get(question);
    if (question && prior) {
      const requests = prior.coreDecision?.interpretation?.dialogueRequests ?? [];
      const explicitReplay = turn.turnId === prior.turnId || requests.includes('repeat_audio') || prior.scenario === 'repeat_audio_request';
      duplicates.push({ index: turn.index ?? index, priorIndex: prior.index, question,
        sameTurnId: turn.turnId === prior.turnId, sameCluster: turn.clusterId === prior.clusterId,
        previousAction: prior.coreDecision?.nextAction ?? null, currentKind: turn.questionKind ?? null,
        explicitReplay, classification: explicitReplay ? 'requested_or_same_turn_replay' : 'unrequested_repeat_suspect_requires_review' });
    }
    if (question) seen.set(question, turn);
    if (index > 0 && /안녕하세요|안녕하십니까|면접을\s*시작하/u.test(text(turn.acknowledgement) + ' ' + question)) repeatedGreetings.push({ index: turn.index ?? index, acknowledgement: turn.acknowledgement ?? null, question, interviewerId: turn.interviewerId ?? null });
  });
  return { exactQuestionDuplicates: duplicates, unrequestedExactRepeatSuspects: duplicates.filter(value => !value.explicitReplay), repeatedGreetingSuspects: repeatedGreetings,
    limitation: 'Exact repeats and greeting patterns are diagnostic signals, not semantic verdicts. Requested replay is counted separately.' };
}

function runSummary(data: Data, sourceFile: string, sourceSha256: string) {
  const turns: Data[] = Array.isArray(data.turns) ? data.turns : [];
  const submissions = turns.filter(turn => turn.response && turn.capture);
  const saved: Data = data.finalSession ?? {};
  const storedTurns: Data[] = Array.isArray(saved.turns) ? saved.turns : [];
  const attempts = submissions.flatMap(turn => [
    ...(turn.firstFailedResponse ? [{ index: turn.index, retry: false, response: turn.firstFailedResponse, decision: turn.firstFailedDecision }] : []),
    { index: turn.index, retry: Boolean(turn.explicitRetryCount), response: turn.response, decision: turn.coreDecision },
  ]);
  const timeline = submissions.map(turn => {
    const core = turn.coreDecision?.providerTimings ?? {};
    const nextEvent = turn.response.events?.find((event: Data) => event.type === 'turn_ready');
    const stt = turn.capture.sttFinalizeMs;
    const next = turn.response.nextMs;
    const submit = nextEvent?.afterSubmitMs ?? turn.response.submitToNextReadyMs;
    return { index: turn.index, scenario: turn.scenario ?? null, question: turn.question,
      questionKind: turn.questionKind, clusterId: turn.clusterId, transcript: turn.capture.rawTranscript,
      action: turn.coreDecision?.nextAction ?? null, fulfillment: turn.coreDecision?.fulfillment ?? null,
      status: turn.response.status, failure: turn.coreDecision?.failureDetail ?? turn.coreDecision?.failureCode ?? turn.response.error ?? null,
      explicitRetryCount: turn.explicitRetryCount ?? 0,
      firstFailedStatus: turn.firstFailedResponse?.status ?? null,
      sttFinalizeMs: finite(stt) ? stt : null,
      nextRequestToResponseCompleteMs: finite(next) ? next : null,
      submitToTurnReadyEventMs: finite(submit) ? submit : null,
      submitToResponseCompleteMs: finite(turn.response.submitToNextReadyMs) ? turn.response.submitToNextReadyMs : null,
      coreMs: finite(core.coreMs) ? core.coreMs : null,
      reviewMs: finite(core.premiseReviewMs) ? core.premiseReviewMs : null,
      coreAndReviewMs: finite(core.realtimeTurnMs) ? core.realtimeTurnMs : null,
      nextQuestion: turn.next?.question ?? null, nextKind: turn.next?.kind ?? null,
      acknowledgement: turn.next?.acknowledgement ?? turn.closing?.text ?? null,
      followUpsBefore: turn.followUpsBefore ?? null, followUpsAfter: turn.followUpsAfter ?? null,
      answerIdPreserved: turn.answerIdPreserved ?? null, transcriptPreserved: turn.transcriptPreserved ?? null };
  });
  const allUsage = attempts.flatMap(attempt => Array.isArray(attempt.decision?.providerUsage) ? attempt.decision.providerUsage : []);
  const usageStats = (stage: string) => {
    const entries = allUsage.filter((entry: Data) => entry.stage === stage);
    return { callsObserved: entries.length,
      completeUsageCalls: entries.filter((entry: Data) => entry.observation?.validity === 'complete').length,
      inputTokens: numericSummary(measured(entries.map((entry: Data) => entry.observation?.usage?.input_tokens))),
      outputTokens: numericSummary(measured(entries.map((entry: Data) => entry.observation?.usage?.output_tokens))) };
  };
  const differences = submissions.filter(turn => typeof turn.syntheticStudent?.text === 'string' && typeof turn.capture?.rawTranscript === 'string')
    .map(turn => ({ index: turn.index, scenario: turn.scenario, ...transcriptDifference(turn.syntheticStudent.text, turn.capture.rawTranscript) }));
  const fCounts = Object.entries(saved.followUpCountByMainQuestion ?? {}).map(([clusterId, count]) => ({ clusterId, count: finite(count) ? count : null }));
  const observedFollowUps = [...new Map(turns.filter(turn => turn.questionKind === 'follow_up').map(turn => [turn.turnId, turn])).values()];
  const requestKinds = ['repeat_audio', 'explain_question', 'cannot_recall', 'correction'];
  const dialogueRequests = requestKinds.map(kind => ({ kind, turns: submissions.filter(turn => turn.coreDecision?.interpretation?.dialogueRequests?.includes(kind)).map(turn => ({ index: turn.index, action: turn.coreDecision.nextAction, followUpsBefore: turn.followUpsBefore ?? null, followUpsAfter: turn.followUpsAfter ?? null })) }));
  const audio = storedTurns.map(turn => ({ turnId: turn.id, questionKind: turn.questionKind,
    questionCharacters: text(turn.questionText).length,
    questionTtsMs: turn.metadata?.providerTimings?.questionTtsMs,
    questionTtsCacheHit: turn.metadata?.providerTimings?.questionTtsCacheHit,
    acknowledgementTtsMs: turn.metadata?.providerTimings?.acknowledgementTtsMs,
    acknowledgementTtsCacheHit: turn.metadata?.providerTimings?.acknowledgementTtsCacheHit }));
  const naturalReason = data.naturalEnding?.reason ?? null;
  const remainingMs = data.naturalEnding?.remainingMs ?? null;
  const ledger = saved.providerUsageLedger;
  const studentCosts = submissions.filter(turn => turn.syntheticStudent?.usage).map(turn => turn.syntheticStudent?.cost?.usd);
  return {
    sourceFile, sourceSha256, sourceCompleted: typeof data.completedAt === 'string', startedAt: data.startedAt ?? null,
    completedAt: data.completedAt ?? null, scenario: data.scenario ?? null, sessionId: data.sessionId ?? null,
    bankContentSha256: data.bankContentSha256 ?? null, bankApprovedCandidates: data.bankApprovedCandidates ?? null,
    bankPlannedSlots: data.bankPlannedSlots ?? null, durationSeconds: data.durationSeconds ?? null,
    runtimePolicy: data.runtimePolicy ?? null, provenance: data.provenance ?? null,
    observations: { rowsStarted: turns.length, submissions: submissions.length,
      httpAttempts: attempts.length, explicitRetries: submissions.reduce((sum, turn) => sum + (turn.explicitRetryCount ?? 0), 0),
      httpFailures: attempts.filter(attempt => attempt.response.status !== 200).map(attempt => ({ index: attempt.index, retry: attempt.retry, status: attempt.response.status, error: attempt.response.error ?? null })),
      runFailures: data.failures ?? [], endedThroughApi: data.endedThroughApi ?? null,
      mainQuestionsObserved: new Set(turns.filter(turn => turn.questionKind === 'main').map(turn => turn.turnId)).size,
      evaluatedFollowUpsObserved: observedFollowUps.length,
      storedFollowUpCounts: fCounts, followUpCapViolations: fCounts.filter(value => value.count !== null && value.count > 2),
      clarificationTurnsObserved: turns.filter(turn => turn.questionKind === 'clarification').length,
      observedHealthySilenceTurns: submissions.filter(turn => turn.capture.knownSyntheticSilence === true && turn.capture.rawTranscript === '' && turn.capture.pcmBytes > 0 && turn.answerObservation?.classification === 'silence_observed')
        .map(turn => ({ index: turn.index, capturedDurationMs: turn.capture.audioDurationMs, action: turn.coreDecision?.nextAction ?? null, nextKind: turn.next?.kind ?? null, status: turn.response.status })),
      dialogueRequests,
      answerIdPreservation: { observed: submissions.filter(turn => typeof turn.answerIdPreserved === 'boolean').length, failed: submissions.filter(turn => turn.answerIdPreserved === false).map(turn => turn.index) },
      transcriptPreservation: { observed: submissions.filter(turn => typeof turn.transcriptPreserved === 'boolean').length, failed: submissions.filter(turn => turn.transcriptPreserved === false).map(turn => turn.index) },
      ...duplicateObservations(turns) },
    latencyMs: { sttFinalize: numericSummary(measured(timeline.map(row => row.sttFinalizeMs))),
      nextRequestToResponseComplete: numericSummary(measured(timeline.map(row => row.nextRequestToResponseCompleteMs))),
      nextRequestToResponseCompleteAllAttempts: numericSummary(measured(attempts.map(attempt => attempt.response.nextMs))),
      submitToTurnReadyEvent: numericSummary(measured(timeline.map(row => row.submitToTurnReadyEventMs))),
      core: numericSummary(measured(attempts.map(attempt => attempt.decision?.providerTimings?.coreMs))),
      reviewAllAttempts: numericSummary(measured(attempts.map(attempt => attempt.decision?.providerTimings?.premiseReviewMs))),
      reviewWithProviderCall: numericSummary(measured(attempts.filter(attempt => attempt.decision?.providerUsage?.some((entry: Data) => entry.stage === 'review')).map(attempt => attempt.decision?.providerTimings?.premiseReviewMs))),
      coreAndReview: numericSummary(measured(attempts.map(attempt => attempt.decision?.providerTimings?.realtimeTurnMs))) },
    providerTokens: { core: usageStats('core'), review: usageStats('review') },
    interviewerAudio: { source: 'finalSession.turns[].metadata.providerTimings; these describe preparation of each question, not the response to that same question',
      recordedQuestionTimings: audio.length,
      questionTtsAllMs: numericSummary(measured(audio.map(row => row.questionTtsMs))),
      newQuestionTtsMs: numericSummary(measured(audio.filter(row => row.questionTtsCacheHit === 0).map(row => row.questionTtsMs))),
      cacheQuestionTtsMs: numericSummary(measured(audio.filter(row => row.questionTtsCacheHit === 1).map(row => row.questionTtsMs))),
      newQuestionSynthesisRequestsObserved: audio.filter(row => row.questionTtsCacheHit === 0).length,
      reusedQuestionSynthesisRequestsObserved: audio.filter(row => row.questionTtsCacheHit === 1).length,
      newQuestionCharactersObserved: audio.filter(row => row.questionTtsCacheHit === 0).reduce((sum, row) => sum + row.questionCharacters, 0),
      scope: 'Question audio timings only. Opening/closing/preparation amortization and failed synthesis charges may be absent.', rows: audio },
    transcription: { comparedTurns: differences.length,
      exactDifferenceTurns: differences.filter(row => !row.exactEqual).length,
      normalizedDifferenceTurns: differences.filter(row => !row.punctuationWhitespaceCaseNormalizedEqual).length,
      rows: differences },
    ending: { naturalReason, remainingMs, earlyCandidateExhaustionObserved: naturalReason === 'candidate_exhausted' && finite(remainingMs) && remainingMs > 0,
      simulatedInterviewElapsedMs: data.simulatedInterviewElapsedMs ?? null, wallMs: data.wallMs ?? null,
      finalStatus: saved.status ?? null, evaluationStatus: saved.evaluationStatus ?? null,
      evaluationError: saved.evaluationError ?? null,
      deliveredInBrowser: false },
    costs: { serverLedgerAvailable: Boolean(ledger), productionLlmLedgerSummary: ledger?.summary ?? null,
      productionLlmStageCosts: ['core', 'review', 'evaluation'].map(stage => {
        const entries: Data[] = ledger?.entries?.filter((entry: Data) => entry.stage === stage) ?? [];
        const known = entries.filter(entry => finite(entry.cost?.usd));
        return { stage, calls: entries.length, unknownCalls: entries.length - known.length,
          knownSubtotalUsd: known.reduce((sum, entry) => sum + entry.cost.usd, 0),
          totalUsd: known.length === entries.length && ledger ? known.reduce((sum, entry) => sum + entry.cost.usd, 0) : null };
      }),
      testHarnessStudentLlmUsd: studentCosts.length && studentCosts.every(finite) ? studentCosts.reduce((sum: number, value: number) => sum + value, 0) : null,
      testHarnessStudentLlmCalls: studentCosts.length,
      syntheticAnswerTtsProviderRequests: submissions.filter(turn => turn.capture?.answerVoiceTiming?.cache === 'provider').length,
      clientPcmDurationMsObserved: submissions.reduce((sum, turn) => sum + (finite(turn.capture?.pcmBytes) ? turn.capture.pcmBytes / 32 : 0), 0),
      clovaInvoiceCostMeasured: false,
      note: 'Production LLM is the server ledger, excluding synthetic student generation. User-provided CLOVA rates cannot settle invoices without monthly usage, server padding and rounding evidence.' },
    httpAttemptTimeline: attempts.map(attempt => ({ index: attempt.index, retry: attempt.retry, status: attempt.response.status,
      nextMs: finite(attempt.response.nextMs) ? attempt.response.nextMs : null,
      failure: attempt.decision?.failureDetail ?? attempt.response.error ?? null })),
    timeline,
  };
}

export function summarizeLiveInterviewE2e(inputs: Array<{ data: Data; sourceFile: string; sourceSha256: string }>, excludedControls: Data[] = []) {
  if (!inputs.length) throw new Error('INPUT_ARTIFACT_REQUIRED');
  const sessionIds = inputs.map(input => input.data.sessionId).filter(Boolean);
  if (new Set(sessionIds).size !== sessionIds.length) throw new Error('DUPLICATE_SESSION_INPUT');
  const runs = inputs.map(input => runSummary(input.data, input.sourceFile, input.sourceSha256));
  const allTimeline = runs.flatMap(run => run.timeline);
  return { version: 'live-interview-e2e-observed-summary-v1', generatedAt: new Date().toISOString(), runs, excludedControls,
    aggregate: { sessions: runs.length, submissions: allTimeline.length,
      latencyMs: { sttFinalize: numericSummary(measured(allTimeline.map(row => row.sttFinalizeMs))),
        nextRequestToResponseCompleteAllAttempts: numericSummary(measured(runs.flatMap(run => run.httpAttemptTimeline.map(attempt => attempt.nextMs)))),
        submitToTurnReadyEvent: numericSummary(measured(allTimeline.map(row => row.submitToTurnReadyEventMs))) },
      allSourcesCompleted: runs.every(run => run.sourceCompleted),
      earlyCandidateExhaustionSessions: runs.filter(run => run.ending.earlyCandidateExhaustionObserved).map(run => run.sessionId) },
    limits: ['Synthetic candidate answers are test inputs, not new facts about the actual student.',
      'Real HTTP/WebSocket/STT/core/review/TTS is observed only where provenance and per-turn evidence say so. Browser playback and human microphone usability are not observed.',
      'Question presentation uses simulated client timing. Wall time includes candidate generation/synthesis and is not a real timed human interview.',
      'Mechanical text differences and duplicate/greeting signals require semantic review; they do not automatically prove an engine defect.',
      'Core/review timings come from coreDecision on the submitted answer. Question TTS timings come from finalSession question preparation, avoiding a one-turn attribution error.',
      'Missing metrics stay unknown. Small samples do not establish P95, SLA, general quality or invoice-level total cost.'],
  };
}

type Summary = ReturnType<typeof summarizeLiveInterviewE2e>;
const cell = (value: unknown) => text(value === null || value === undefined ? '미측정' : String(value)).replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ');
const seconds = (value: number | null) => value === null ? '미측정' : (value / 1000).toFixed(2);
function markdown(summary: Summary) {
  const lines = ['# 실제 음성 파이프라인 모의 면접 E2E 관측 결과', '',
    `생성: ${new Date(summary.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST. 합성 지원자와 모의 재생 이벤트를 사용한 테스트이며 사람의 브라우저 면접 결과가 아닙니다.`, '',
    '| 시나리오 | 제출 | STT 확정 평균/중앙값 | next 평균/중앙값 | 제출→다음 준비 평균/중앙값 | 평가 |', '|---|---:|---:|---:|---:|---|'];
  for (const run of summary.runs) lines.push(`| ${cell(run.scenario)} | ${run.observations.submissions} | ${seconds(run.latencyMs.sttFinalize.mean)} / ${seconds(run.latencyMs.sttFinalize.median)}초 | ${seconds(run.latencyMs.nextRequestToResponseCompleteAllAttempts.mean)} / ${seconds(run.latencyMs.nextRequestToResponseCompleteAllAttempts.median)}초 | ${seconds(run.latencyMs.submitToTurnReadyEvent.mean)} / ${seconds(run.latencyMs.submitToTurnReadyEvent.median)}초 | ${cell(run.ending.evaluationStatus)} |`);
  if (summary.excludedControls.length) lines.push('', '집계에서 제외한 진단 대조 실행: ', ...summary.excludedControls.map(control => `- ${cell(control.sourceFile)}: ${cell(control.reason)}`));
  for (const run of summary.runs) {
    lines.push('', `## ${cell(run.scenario)} — ${cell(run.sessionId)}`, '',
      `원자료: ${run.sourceFile}. 완료 표시: ${run.sourceCompleted}. 승인 Q0 ${run.bankApprovedCandidates ?? '미측정'}개 / 계획 슬롯 ${run.bankPlannedSlots ?? '미측정'}개.`, '',
      `관측 주질문 ${run.observations.mainQuestionsObserved}개, 평가 F ${run.observations.evaluatedFollowUpsObserved}개, 재진술 ${run.observations.clarificationTurnsObserved}개. F 상한 초과 관측 ${run.observations.followUpCapViolations.length}건.`, '',
      `HTTP 시도 ${run.observations.httpAttempts}회 중 실패 ${run.observations.httpFailures.length}회, 명시 재시도 ${run.observations.explicitRetries}회. 확인된 건강한 연결의 무음 제출 ${run.observations.observedHealthySilenceTurns.length}회. next 통계에는 실패·재시도 요청을 포함하고, 제출→준비는 성공한 turn_ready까지의 실제 관측 시간을 사용합니다.`, '',
      `질문 완전 반복 ${run.observations.exactQuestionDuplicates.length}건(명시 재청취·같은 턴 재생 포함), 재요청이 확인되지 않은 반복 후보 ${run.observations.unrequestedExactRepeatSuspects.length}건, 재인사 후보 ${run.observations.repeatedGreetingSuspects.length}건. 자동 합격 판정이 아닌 진단 신호입니다.`, '',
      `의도 답변과 STT를 비교한 ${run.transcription.comparedTurns}개 중 문장부호·공백·대소문자 정규화 후 차이가 있는 답변은 ${run.transcription.normalizedDifferenceTurns}개입니다. 약어의 발음 표기는 별도 검토가 필요합니다.`, '',
      `코어 입력 ${run.providerTokens.core.inputTokens.minimum ?? '미측정'}~${run.providerTokens.core.inputTokens.maximum ?? '미측정'}토큰, 검수 입력 ${run.providerTokens.review.inputTokens.minimum ?? '미측정'}~${run.providerTokens.review.inputTokens.maximum ?? '미측정'}토큰. 코어 평균 ${seconds(run.latencyMs.core.mean)}초, 실제 검수 호출 평균 ${seconds(run.latencyMs.reviewWithProviderCall.mean)}초, 신규 질문 TTS 평균 ${seconds(run.interviewerAudio.newQuestionTtsMs.mean)}초.`, '',
      `자연 종료 사유: ${cell(run.ending.naturalReason)}, 남은 시간 ${seconds(finite(run.ending.remainingMs) ? run.ending.remainingMs : null)}초. 조기 질문 소진 관측: ${run.ending.earlyCandidateExhaustionObserved}. 최종 상태: ${cell(run.ending.finalStatus)}, 평가: ${cell(run.ending.evaluationStatus)}.`, '',
      `서버 LLM 원장 총액: ${cell(run.costs.productionLlmLedgerSummary?.totalUsd)} USD, 미확인 호출: ${cell(run.costs.productionLlmLedgerSummary?.unknownCalls)}. 합성 지원자 생성 LLM ${cell(run.costs.testHarnessStudentLlmUsd)} USD는 테스트 비용으로 별도입니다. CLOVA 청구액은 확정하지 않습니다.`, '',
      '| 턴 | 상황 | 실제 질문 | STT 확정 답변 | 진행 | 실제 다음 질문·마무리 | 제출→준비 |', '|---:|---|---|---|---|---|---:|');
    for (const row of run.timeline) lines.push(`| ${row.index} | ${cell(row.scenario)} | ${cell(row.question)} | ${cell(row.transcript)} | ${cell(row.action)} / ${cell(row.fulfillment)} | ${cell(row.nextQuestion ?? row.acknowledgement)} | ${seconds(row.submitToTurnReadyEventMs)}초 |`);
    lines.push('', '실패·보존·중복·전사 차이의 상세 근거는 함께 생성한 JSON에 남깁니다. 이 표만으로 자연스러움이나 과학적 정오를 자동 판정하지 않습니다.');
  }
  lines.push('', '## 검증 한계', '', ...summary.limits.map(value => '- ' + value), '');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2), inputPaths = args.filter(value => !value.startsWith('--'));
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  const output = args.find(value => value.startsWith('--out='))?.slice('--out='.length) ?? `artifacts/live-interview-e2e-summary-${stamp}`;
  if (!inputPaths.length) throw new Error('USAGE: tsx scripts/summarize-live-interview-e2e.ts artifact1.json [artifact2.json] [--out=artifacts/report-prefix]');
  const prefix = path.resolve(output.replace(/\.(?:md|json)$/u, ''));
  const inputs = await Promise.all(inputPaths.map(async inputPath => {
    const source = await readFile(inputPath, 'utf8');
    if ([prefix + '.json', prefix + '.md'].includes(path.resolve(inputPath))) throw new Error('OUTPUT_MUST_NOT_OVERWRITE_INPUT');
    return { data: JSON.parse(source), sourceFile: path.relative(process.cwd(), path.resolve(inputPath)).split(path.sep).join('/'), sourceSha256: createHash('sha256').update(source).digest('hex') };
  }));
  const excludedControls = await Promise.all(args.filter(value => value.startsWith('--excluded-control=')).map(async value => {
    const excludedPath = value.slice('--excluded-control='.length), source = await readFile(excludedPath, 'utf8'), data = JSON.parse(source);
    return { sourceFile: path.relative(process.cwd(), path.resolve(excludedPath)).split(path.sep).join('/'), sourceSha256: createHash('sha256').update(source).digest('hex'),
      scenario: data.scenario ?? null, sessionId: data.sessionId ?? null,
      knownSyntheticSilenceTurns: (data.turns ?? []).filter((turn: Data) => turn.capture?.knownSyntheticSilence === true && turn.capture?.rawTranscript === '').length,
      reason: '호출자가 진단 대조 실행으로 제외했습니다. 이 실행을 건강한 연결의 실제 무음 제출 검증으로 계산하지 않습니다.' };
  }));
  const summary = summarizeLiveInterviewE2e(inputs, excludedControls);
  await mkdir(path.dirname(prefix), { recursive: true });
  await writeFile(prefix + '.json', JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  await writeFile(prefix + '.md', markdown(summary), { mode: 0o600 });
  console.log(JSON.stringify({ json: prefix + '.json', markdown: prefix + '.md', completedInputs: summary.aggregate.allSourcesCompleted, submissions: summary.aggregate.submissions }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
