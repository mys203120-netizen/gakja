import test from 'node:test';
import assert from 'node:assert/strict';
import type { InterviewSession, RecordedTurn } from '../server/protocol';
import type { InterviewContext } from '../server/data/load-interview-context';
import { buildEvaluationClusterInputs, buildEvaluationObservationSummary, evaluationPolicyProjection,
  evaluationSessionSourceFingerprint, type EvaluationClusterCheckpoint } from '../server/providers/evaluation-input';
import { evaluateSession } from '../server/providers/openai';
import { calculateSpeechMetrics } from '../lib/interview/speech-metrics';
import { reviewedRecordEvaluationFixture } from './fixtures/reviewed-evaluation-knowledge';

function turn(id: string, kind: RecordedTurn['questionKind'] = 'main', root = id, original?: string): RecordedTurn {
  return { id, questionKind: kind, parentMainQuestionId: root, questionText: '본인이 직접 한 일을 설명해 주세요.',
    evidenceIds: ['source-1'], answerId: 'answer-' + id, rawTranscript: '온도를 먼저 측정했습니다.', transcriptStatus: 'finalized',
    metadata: { questionIntent: '본인의 실제 행동 확인', primaryFunction: 'ROLE', targetEvidence: ['본인이 한 일'], depth: 'D1', activityIds: ['activity-1'],
      ...(kind === 'clarification' ? { clarificationOfTurnId: original, nonEvaluative: true } : {}) },
    metrics: { speech: { durationMs: 2000, speakingMs: 1000 } },
  } as RecordedTurn;
}
function session(turns = [turn('q0')]) {
  return { id: 'synthetic-explicit-evaluation-input', status: 'ending', evaluationStatus: 'pending', turns, elapsedMs: 2000,
    questionPresentations: turns.map(item => ({ turnId: item.id, rootTurnId: item.parentMainQuestionId, questionKind: item.questionKind,
      clockId: 'synthetic-clock', startedAtMs: 100, completedAtMs: 200 })),
    metrics: {}, followUpCountByMainQuestion: {},
  } as InterviewSession;
}
const context = {
  target: { university: '합성 대학', department: '합성 학과', academicYear: 2027, admissionTrack: '합성 서류 전형' },
  school: { schoolReferenceId: 'synthetic-school', officialInterviewCriteria: { elements: [{ name: '탐구' }] } },
  evaluationGuidelines: '합성 평가 지침: 실제 요구에 대한 원문 답변을 다섯 축으로 평가한다.',
  student: { evidence: [{ id: 'source-1', activityId: 'activity-1', page: 2, text: '탐구에서 온도를 측정함.',
    scientificTruthVerification: 'not_independently_verified', sourceRef: { pdfSha256: 'a'.repeat(64), page: 2, startOffset: 0, endOffset: 15 } }] },
} as unknown as InterviewContext;
function modelResult(input: ReturnType<typeof buildEvaluationClusterInputs>[number]) {
  return {
    summary: '실제 측정 행동을 확인했습니다.', languageClassifications: [],
    answers: input.answers.map(answer => {
      const quote = answer.answerAttempts.find(attempt => attempt.finalized && attempt.rawTranscript)?.rawTranscript ?? null;
      const axis = { anchor: 2, quote, rationale: '현재 질문이 요구한 본인의 측정 행동을 명시했다.' };
      return { turnId: answer.id, status: 'PARTIAL', deferredReason: null,
        axes: { I: { ...axis }, A: { ...axis }, S: { ...axis }, R: { ...axis }, C: { ...axis } },
        verifiedCoreError: false, verifiedCoreErrorEvidence: null,
        strengths: [], improvements: [], conflictNeedsReview: [], deliveryCoaching: [], strategyCoaching: [] };
    }),
  };
}

test('evaluation allowlist keeps unchanged answer attempts and removes raw telemetry, runtime metadata and private event backups', () => {
  const value = session([turn('q0'), turn('c1', 'clarification', 'q0', 'q0'), turn('f1', 'follow_up', 'q0'), turn('q1')]);
  const marker = 'MUST_NOT_LEAK_MODEL_INPUT';
  value.metrics = { vision: { records: Array.from({ length: 1000 }, (_, i) => ({ turnId: 'q0', phase: 'listening', durationMs: 1,
    gazeValidFrameCount: 1, gazeOffFrameCount: 0, faceLandmarks: marker.repeat(100), sequence: i })) }, clientEventsBackup: marker.repeat(10000) };
  Object.assign(value.turns[0].metadata, { coreDecision: { rawProviderTrace: marker }, clientTimings: { arbitrary: marker } });
  const before = JSON.stringify(value);
  const clusters = buildEvaluationClusterInputs(context, value), serialized = JSON.stringify(clusters);
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0].answers.map(answer => answer.id), ['q0', 'f1']);
  assert.deepEqual(clusters[0].answers[0].answerAttempts.map(attempt => attempt.sourceTurnId), ['q0', 'c1']);
  assert.equal(clusters[0].answers[0].answerAttempts[1].rawTranscript, value.turns[1].rawTranscript);
  assert.equal(serialized.includes(marker), false);
  assert.equal(serialized.includes('clientEventsBackup'), false);
  assert.equal(serialized.includes('faceLandmarks'), false);
  assert.equal(serialized.includes('coreDecision'), false);
  assert.equal(serialized.includes('records'), false);
  assert.ok(serialized.length < 20000);
  assert.equal(JSON.stringify(value), before);
  const observed = buildEvaluationObservationSummary(value);
  assert.equal(observed.sessionMetrics, null);
  assert.equal((observed.answers[0].vision as { summary: { gazeOffFrameRatio: number } }).summary.gazeOffFrameRatio, 0);
  assert.equal(observed.answers[1].unavailable.vision, true);
});

test('every normative MD article is stage-accounted and selected exact paragraphs exclude reference examples', () => {
  const guidelines = '# 합성 정본\n### 제1조 (목적)\n실제 목적.\n# 별표\nREFERENCE_EXAMPLE_SHOULD_STAY_OFFLINE\n### 제16조 (산식)\n서버 산식.\n### 제42조 (매체)\n실제 관찰.\n';
  const result = evaluationPolicyProjection(guidelines);
  assert.deepEqual(result.trace.modelArticles, [1, 42]);
  assert.deepEqual(result.trace.articles.map(article => article.article), [1, 16, 42]);
  assert.equal(result.instructions.includes('REFERENCE_EXAMPLE'), false);
  assert.equal(result.instructions.includes('서버 산식'), false);
  assert.ok(result.instructions.includes('실제 목적.'));
  assert.ok(result.instructions.includes('실제 관찰.'));
  for (const article of result.trace.articles) assert.ok(guidelines.slice(article.start, article.end).startsWith('### 제'));
  assert.throws(() => evaluationPolicyProjection('### 제46조 (새 규칙)\n새 규칙'), /UNMAPPED/u);
  assert.throws(() => evaluationPolicyProjection('### 제1조 (가)\n가\n### 제1조 (나)\n나'), /DUPLICATED/u);
});

test('actual speech rate field names and units survive the allowlist while insufficient measurement stays null', () => {
  const value = session(), rawTranscript = '온도를 먼저 측정하고 같은 간격으로 여러 번 기록했습니다.';
  value.turns[0].rawTranscript = rawTranscript;
  const metrics = calculateSpeechMetrics({ rawTranscript, durationMs: 10000, speakingMs: 5000, firstSpeechMs: 400 });
  value.turns[0].metrics = { speech: metrics };
  const speech = buildEvaluationClusterInputs(context, value)[0].observations.answers[0].speech as Record<string, unknown>;
  for (const key of ['cpm', 'speakingCpm', 'eojeolPerMinute', 'hangulSyllablesPerMinuteApprox', 'characterCount', 'eojeolCount', 'hangulSyllableCount'] as const) {
    assert.equal(speech[key], metrics[key]);
  }
  assert.equal(metrics.speakingCpm, metrics.cpm! * 2);
  assert.equal((speech.units as Record<string, string>).cpm, 'Unicode_letters_and_numbers_per_total_minute');
  value.turns[0].metrics = { speech: calculateSpeechMetrics({ rawTranscript, durationMs: 1000, speakingMs: null, firstSpeechMs: null }) };
  const brief = buildEvaluationClusterInputs(context, value)[0].observations.answers[0].speech as Record<string, unknown>;
  assert.equal(brief.cpm, null); assert.equal(brief.speakingCpm, null); assert.equal(brief.eojeolPerMinute, null);
});

test('MD article 28 restrictions against globalizing one error and claiming repeated weakness are model-active exact source', () => {
  const guidelines = '### 제28조 (회차별 종합 리포트)\n② 단일 개념 오답을 전반적 역량으로 일반화하지 않는다.\n③ 한 답변을 반복되는 약점으로 판정하지 않는다.\n④ 표본이 부족하면 분석 표본 부족으로 표시한다.\n### 제33조 (출력 구분)\n뷰 영역.\n';
  const result = evaluationPolicyProjection(guidelines);
  assert.deepEqual(result.trace.modelArticles, [28]);
  assert.equal(result.instructions, guidelines.slice(0, guidelines.indexOf('### 제33조')));
});

test('evaluation source identity ignores lifecycle and runtime traces but changes with actual answers, contracts, policy or observed delivery', () => {
  const value = session(), original = evaluationSessionSourceFingerprint(context, value);
  value.status = 'completed'; value.evaluationStatus = 'completed'; value.metrics = { clientEventsBackup: ['unrelated'] };
  Object.assign(value.turns[0].metadata, { clientTimings: { at: 100 }, coreDecision: { classification: 'other' } });
  assert.equal(evaluationSessionSourceFingerprint(context, value), original);
  value.turns[0].rawTranscript += ' 다시 측정했습니다.';
  assert.notEqual(evaluationSessionSourceFingerprint(context, value), original);
  assert.notEqual(evaluationSessionSourceFingerprint({ ...context, evaluationGuidelines: '다른 정책' }, session()), original);
  const contractChanged = session(); contractChanged.turns[0].metadata.targetEvidence = ['다른 실제 계약'];
  assert.notEqual(evaluationSessionSourceFingerprint(context, contractChanged), original);
});

test('a failed later cluster resumes from source-bound validated checkpoints without paying again for completed clusters', async () => {
  const reviewed = reviewedRecordEvaluationFixture(context, session([turn('q0'), turn('c1', 'clarification', 'q0', 'q0'), turn('f1', 'follow_up', 'q0'), turn('q1')]));
  const value = reviewed.session, approvedContext = reviewed.context;
  const checkpoints: EvaluationClusterCheckpoint[] = [], calls: string[] = [];
  await assert.rejects(evaluateSession(approvedContext, value, {
    requestEvaluation: async request => {
      const input = JSON.parse(request.input) as ReturnType<typeof buildEvaluationClusterInputs>[number]; calls.push(input.clusterId);
      if (input.clusterId === 'q1') throw new Error('synthetic transport failure');
      return modelResult(input);
    }, onClusterComplete: checkpoint => { checkpoints.push(checkpoint); },
  }), /transport/u);
  assert.deepEqual(calls, ['q0', 'q1']); assert.equal(checkpoints.length, 1);
  calls.length = 0;
  const result = await evaluateSession(approvedContext, value, { resumeClusters: checkpoints,
    requestEvaluation: async request => { const input = JSON.parse(request.input); calls.push(input.clusterId); return modelResult(input); },
  });
  assert.deepEqual(calls, ['q1']);
  assert.ok('evaluationPipeline' in result);
  assert.equal(result.evaluationPipeline.reusedClusters, 1);
  assert.equal(result.answers.length, 3);
  assert.equal(result.answers[0].quoteSources.I?.sourceTurnId, 'q0');
  assert.deepEqual(result.clusterScores[0].members.map(member => member.weight), [0.7, 0.3]);
});

test('changed source text never reuses a checkpoint and fabricated scoring quotes fail before durable checkpointing', async () => {
  let reviewed = reviewedRecordEvaluationFixture(context, session());
  const checkpoints: EvaluationClusterCheckpoint[] = [];
  await evaluateSession(reviewed.context, reviewed.session, { requestEvaluation: async request => modelResult(JSON.parse(request.input)), onClusterComplete: checkpoint => { checkpoints.push(checkpoint); } });
  reviewed.session.turns[0].rawTranscript = '온도를 다시 측정했습니다.';
  // The changed actual answer gets a new explicit synthetic review. An old
  // approval must remain stale; the purpose here is checkpoint invalidation.
  reviewed = reviewedRecordEvaluationFixture(context, reviewed.session);
  let calls = 0;
  await evaluateSession(reviewed.context, reviewed.session, { resumeClusters: checkpoints, requestEvaluation: async request => { calls++; return modelResult(JSON.parse(request.input)); } });
  assert.equal(calls, 1);
  const saved: EvaluationClusterCheckpoint[] = [];
  await assert.rejects(evaluateSession(reviewed.context, reviewed.session, { requestEvaluation: async request => {
    const output = modelResult(JSON.parse(request.input)); output.answers[0].axes.I.quote = '원문에 없는 발화'; return output;
  }, onClusterComplete: checkpoint => { saved.push(checkpoint); } }), /QUOTE_NOT_FOUND/u);
  assert.equal(saved.length, 0);
});

test('whole-request budget includes policy and schema and rejects oversized input before any provider call without truncating source', async () => {
  const reviewed = reviewedRecordEvaluationFixture(context, session()), value = reviewed.session, approvedContext = reviewed.context;
  const before = JSON.stringify(value); let calls = 0;
  await assert.rejects(evaluateSession({ ...approvedContext, evaluationGuidelines: '한'.repeat(50000) }, value, {
    requestEvaluation: async request => { calls++; return modelResult(JSON.parse(request.input)); },
  }), /REQUEST_VISIBLE_INPUT_BUDGET_EXCEEDED/u);
  assert.equal(calls, 0); assert.equal(JSON.stringify(value), before);
  const measurements: Array<{ totalVisibleInputBytes: number; blocks: Record<string, { utf8Bytes: number }> }> = [];
  await evaluateSession(approvedContext, value, { requestEvaluation: async request => modelResult(JSON.parse(request.input)), onInputMeasured: result => measurements.push(result) });
  assert.ok(measurements[0].blocks.instructions.utf8Bytes > 0);
  assert.ok(measurements[0].blocks.schema.utf8Bytes > 0);
  assert.equal(measurements[0].totalVisibleInputBytes, Object.values(measurements[0].blocks).reduce((sum, block) => sum + block.utf8Bytes, 0));
});
