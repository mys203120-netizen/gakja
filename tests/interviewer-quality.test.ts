import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { InterviewSession, RecordedTurn } from '../server/protocol';
import { buildInterviewerQuality } from '../server/interviewer-quality';
import { ledgerTargetKey } from '../server/conversation-ledger';
import { evaluateInterviewerQualityCli } from '../scripts/evaluate-interviewer-quality';

const sessionId = '11111111-1111-4111-8111-111111111111';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function turn(id: string, overrides: Partial<RecordedTurn> = {}): RecordedTurn {
  return { id, questionText: '판단을 확인하는 구체적인 요청은 무엇인가요?', questionKind: id === 'root' ? 'main' : 'follow_up', parentMainQuestionId: 'root', evidenceIds: ['source'], answerId: 'answer-' + id, rawTranscript: '실제 저장된 학생 답변', transcriptStatus: 'finalized', metadata: { primaryFunction: 'EVIDENCE', questionIntent: '판단의 근거를 확인한다.', targetEvidence: ['판단 근거 한 가지'], activityIds: ['activity'], parentQuestionId: id === 'root' ? null : 'root', answerTurnId: id === 'root' ? null : 'root' }, ...overrides } as RecordedTurn;
}
function session(turns: RecordedTurn[]): InterviewSession { return { id: sessionId, turns, followUpCountByMainQuestion: {}, metrics: { verification: { syntheticTest: true, scenario: 'quality-metric-fixture' } } } as InterviewSession; }

test('quality uses bound observed decisions and actual directives without guessing a professional validity score', () => {
  const main = turn('root'), follow = turn('follow');
  main.metadata.coreDecision = { sourceTurnId: main.id, sourceAnswerId: main.answerId, fulfillment: 'met', nextAction: 'FOLLOW_UP', actualDirective: 'follow_up_missing_target', providerTimings: { coreModelCalls: 1, coreMs: 1200 } };
  follow.metadata.coreDecision = { sourceTurnId: follow.id, sourceAnswerId: follow.answerId, fulfillment: 'partial', nextAction: 'FOLLOW_UP', actualDirective: 'next_main', decisionReasonCode: 'repeat_or_budget', providerTimings: { coreModelCalls: 1, coreMs: 800 } };
  follow.metadata.providerTimings = { coreModelCalls: 1, coreMs: 1200 }; // Previous answer's generation timing: do not count it twice.
  const unbound = turn('unbound');
  unbound.metadata.coreDecision = { sourceTurnId: 'wrong', sourceAnswerId: unbound.answerId, fulfillment: 'met', nextAction: 'FOLLOW_UP' };
  const report = buildInterviewerQuality(session([main, follow, unbound]));
  assert.equal(report.decisions.observed, 2);
  assert.equal(report.decisions.unobservedFinalizedAnswers, 1);
  assert.deepEqual(report.decisions.metToFollowUp, { count: 1, observed: 1, rate: 1 });
  assert.equal(report.decisions.actions.TRANSITION, 1);
  assert.equal(report.decisions.requestedActualActionMismatchCount, 1);
  assert.equal(report.decisions.transitionReasons.byReason.repeat_or_budget, 1);
  assert.equal(report.runtimeModelCalls.boundDecisionTotal, 2);
  assert.equal(report.runtimeModelCalls.legacyTurnTimingTotal, null);
  assert.equal(report.runtimeModelCalls.observedCoreDurationTotalMs, 2000);
  assert.equal('qualityScore' in report, false);
  assert.equal(report.providerCalls, 0);
});

test('unobserved playback, transition reasons and latency remain null while legacy timing samples stay separate', () => {
  const main = turn('root');
  main.metadata.providerTimings = { coreModelCalls: 0 };
  const report = buildInterviewerQuality(session([main]));
  assert.equal(report.questions.observedSpokenAnchorModes, null);
  assert.equal(report.questions.repeatedSpokenPrefixFingerprints, null);
  assert.equal(report.decisions.metToFollowUp.rate, null);
  assert.equal(report.decisions.transitionReasons.rate, null);
  assert.equal(report.runtimeModelCalls.boundDecisionTotal, null);
  assert.equal(report.runtimeModelCalls.legacyTurnTimingTotal, 0);
  assert.equal(report.latency.measured.submitToQuestionMs.p95Ms, null);
  assert.equal(report.session.syntheticTest, true);
});

test('spoken statistics require actual starts, keep source text private and exclude clarification from duplicate objective counts', () => {
  const first = turn('root'), follow = turn('follow'), clarification = turn('clarification', { questionKind: 'clarification' });
  for (const row of [follow, clarification]) row.metadata.questionRealization = { policyVersion: 'synthetic-ir', operation: 'evidence_verification', anchorMode: 'none', anchorId: 'anchor', templateId: 'template-1', family: 'evidence.request-1', strategyId: null, semanticReview: 'not_independently_reviewed', semanticObjectiveId: 'same-objective' };
  const last = turn('last'); last.metadata.questionRealization = structuredClone(follow.metadata.questionRealization);
  const input = session([first, follow, clarification, last]);
  input.questionPresentations = [first, follow].map((row, index) => ({ turnId: row.id, rootTurnId: row.parentMainQuestionId, questionKind: row.questionKind, startedAtMs: index * 100, completedAtMs: index * 100 + 50 }));
  const report = buildInterviewerQuality(input);
  assert.equal(report.session.actualQuestionStarts, 2);
  assert.equal(report.questions.observedSpokenAnchorModes?.byMode.none, 1);
  assert.equal(report.questions.repeatedSemanticObjectivesWithinCluster.length, 1);
  assert.equal(report.questions.repeatedSemanticObjectivesWithinCluster[0].occurrences, 2);
  assert.equal(report.questions.repeatedSpokenPrefixFingerprints?.[0].count, 2);
  assert.equal(JSON.stringify(report).includes(first.questionText), false);
  assert.equal(JSON.stringify(report).includes(first.rawTranscript!), false);
});

test('internal proof verification checks earlier same-cluster source revision and contract integrity problems are explicit', () => {
  const main = turn('root'), follow = turn('follow');
  const sourceId = 'ANSWER_TURN:root:answer-root', sourceSha256 = sha(main.rawTranscript!);
  const anchorId = 'QA-' + sha(sourceId + ':' + sourceSha256 + ':0:' + main.rawTranscript!.length).slice(0, 20);
  follow.metadata.questionRealization = { policyVersion: 'synthetic-ir', operation: 'evidence_verification', anchorMode: 'none', anchorId, templateId: 'template', family: 'family', strategyId: null, semanticReview: 'not_independently_reviewed', anchorProof: [{ anchorId, sourceId, sourceSha256, sourceStartOffset: 0, sourceEndOffset: main.rawTranscript!.length, questionStartOffset: null, questionEndOffset: null }] };
  let report = buildInterviewerQuality(session([main, follow]));
  assert.equal(report.integrity.internalAnchorProofsObserved, 1);
  assert.equal(report.integrity.issueCounts.IR_CONTRACT_MISSING, 1);
  assert.equal(report.integrity.issueCounts.INTERNAL_ANSWER_PROOF_INVALID, undefined);
  main.rawTranscript += ' 원문 수정';
  report = buildInterviewerQuality(session([main, follow]));
  assert.equal(report.integrity.issueCounts.INTERNAL_ANSWER_PROOF_INVALID, 1);
});

function naturalProofFixture() {
  const main = turn('root'), follow = turn('follow');
  follow.metadata.targetEvidence = ['자료 비교에 실제로 사용한 기준 한 가지'];
  const sourceId = `ANSWER_TURN:${main.id}:${main.answerId}`, sourceSha256 = sha(main.rawTranscript!);
  const anchorId = 'PROBE-' + sha(main.id + ':' + follow.metadata.targetEvidence[0].normalize('NFC').replace(/\s+/gu, '')).slice(0, 24);
  follow.metadata.questionRealization = { policyVersion: 'answer-grounded-question-v3', operation: 'choice', anchorMode: 'none', anchorId, templateId: 'answer-grounded-question-v3.generated', family: 'answer_grounded', strategyId: null, semanticReview: 'independently_reviewed', semanticObjectiveId: anchorId,
    anchorProof: [{ anchorId, sourceId, sourceSha256, sourceStartOffset: 0, sourceEndOffset: main.rawTranscript!.length, questionStartOffset: null, questionEndOffset: null }] };
  return { main, follow };
}

test('v3 natural answer proofs use their exact target-derived PROBE identity while legacy QA proofs keep their own format', () => {
  const { main, follow } = naturalProofFixture();
  const report = buildInterviewerQuality(session([main, follow]));
  assert.equal(report.integrity.internalAnchorProofsObserved, 1);
  assert.equal(report.integrity.issueCounts.INTERNAL_ANSWER_PROOF_INVALID, undefined);
  assert.equal(report.integrity.issueCounts.IR_CONTRACT_MISSING, 1, 'Source-proof validation does not fabricate a missing approval contract');
  follow.metadata.questionRealization!.policyVersion = 'legacy-ir';
  assert.equal(buildInterviewerQuality(session([main, follow])).integrity.issueCounts.INTERNAL_ANSWER_PROOF_INVALID, 1);
});

test('v3 PROBE identity never bypasses answer revision, bounds, parent, cluster or meaning identity checks', async context => {
  const mutations: Array<[string, (value: ReturnType<typeof naturalProofFixture>) => void]> = [
    ['proof id', ({ follow }) => { follow.metadata.questionRealization!.anchorProof![0].anchorId = 'PROBE-forged'; }],
    ['missing proof', ({ follow }) => { follow.metadata.questionRealization!.anchorProof = []; }],
    ['realization id', ({ follow }) => { follow.metadata.questionRealization!.anchorId = 'PROBE-forged'; }],
    ['semantic id', ({ follow }) => { follow.metadata.questionRealization!.semanticObjectiveId = 'PROBE-forged'; }],
    ['target meaning', ({ follow }) => { follow.metadata.targetEvidence[0] = '묻지 않은 다른 확인 목적'; }],
    ['answer revision', ({ main }) => { main.rawTranscript += ' 정정된 원문'; }],
    ['answer range', ({ main, follow }) => { follow.metadata.questionRealization!.anchorProof![0].sourceEndOffset = main.rawTranscript!.length + 1; }],
    ['answer state', ({ main }) => { main.transcriptStatus = 'paused'; }],
    ['answer cluster', ({ main }) => { main.parentMainQuestionId = 'another-root'; }],
    ['current answer linkage', ({ follow }) => { follow.metadata.answerTurnId = 'another-answer'; }],
    ['review status', ({ follow }) => { follow.metadata.questionRealization!.semanticReview = 'not_independently_reviewed'; }],
  ];
  for (const [name, mutate] of mutations) await context.test(name, () => {
    const value = naturalProofFixture(); mutate(value);
    assert.equal(buildInterviewerQuality(session([value.main, value.follow])).integrity.issueCounts.INTERNAL_ANSWER_PROOF_INVALID, 1);
  });
});

test('natural rephrasing and exact replay preserve the actual evaluative demand without a new probe identity', () => {
  const { main, follow } = naturalProofFixture();
  const rephrase = turn('rephrase', { questionKind: 'clarification', metadata: { ...follow.metadata, parentQuestionId: follow.id, answerTurnId: follow.id, clarificationOfTurnId: follow.id, clarificationMode: 'rephrase', nonEvaluative: true, questionRealization: structuredClone(follow.metadata.questionRealization) } });
  // A rephrasing request has its own source-bound answer and preserves the F demand.
  follow.rawTranscript = '질문이 어떤 뜻인가요?';
  const proof = rephrase.metadata.questionRealization!.anchorProof![0];
  proof.sourceId = `ANSWER_TURN:${follow.id}:${follow.answerId}`; proof.sourceSha256 = sha(follow.rawTranscript); proof.sourceEndOffset = follow.rawTranscript.length;
  rephrase.metadata.questionRealization!.semanticObjectiveId = ledgerTargetKey(follow);
  assert.equal(buildInterviewerQuality(session([main, follow, rephrase])).integrity.issues.some(issue => issue.turnId === 'rephrase' && issue.code === 'INTERNAL_ANSWER_PROOF_INVALID'), false);
  const replay = turn('replay', { questionKind: 'clarification', questionText: follow.questionText, metadata: { ...follow.metadata, parentQuestionId: follow.id, answerTurnId: follow.id, clarificationOfTurnId: follow.id, clarificationMode: 'repeat_audio', nonEvaluative: true, questionRealization: structuredClone(follow.metadata.questionRealization) } });
  assert.equal(buildInterviewerQuality(session([main, follow, replay])).integrity.issues.some(issue => issue.turnId === 'replay' && issue.code === 'INTERNAL_ANSWER_PROOF_INVALID'), false);
  rephrase.metadata.targetEvidence = ['새로운 평가 요구'];
  assert.equal(buildInterviewerQuality(session([main, follow, rephrase])).integrity.issues.some(issue => issue.turnId === 'rephrase' && issue.code === 'INTERNAL_ANSWER_PROOF_INVALID'), true);
});

test('CLI reads a selected UUID without changing logs and exports only an explicitly requested new workspace JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interviewer-quality-test-'));
  try {
    const input = session([turn('root')]);
    await mkdir(join(root, 'data/sessions'), { recursive: true });
    await mkdir(join(root, 'data/conversation-logs'), { recursive: true });
    const original = JSON.stringify(input);
    await writeFile(join(root, 'data/sessions', sessionId + '.json'), original);
    await writeFile(join(root, 'data/conversation-logs', sessionId + '.jsonl'), JSON.stringify({ sessionId, seq: 1, type: 'session.created' }) + '\nmalformed\n');
    const output = JSON.parse(await evaluateInterviewerQualityCli(['--session', sessionId], root));
    assert.equal(output.log.observedEvents, 1); assert.equal(output.log.malformedLines, 1);
    assert.equal(await readFile(join(root, 'data/sessions', sessionId + '.json'), 'utf8'), original);
    await evaluateInterviewerQualityCli(['--latest', '--include-synthetic', '--out', 'artifacts/quality.json'], root);
    assert.equal(JSON.parse(await readFile(join(root, 'artifacts/quality.json'), 'utf8')).session.id, sessionId);
    await assert.rejects(() => evaluateInterviewerQualityCli(['--session', '../outside'], root), /ID_INVALID/);
    await assert.rejects(() => evaluateInterviewerQualityCli(['--session', sessionId, '--out', '../outside.json'], root), /OUTSIDE_WORKSPACE/);
    await assert.rejects(() => evaluateInterviewerQualityCli(['--session', sessionId, '--out', 'data/sessions/new.json'], root), /OUTPUT_PATH_INVALID/);
    await assert.rejects(() => evaluateInterviewerQualityCli(['--session', sessionId, '--out', 'artifacts/quality.json'], root), /EEXIST/);
  } finally {
    assert.equal(dirname(root), resolve(tmpdir())); assert.ok(basename(root).startsWith('interviewer-quality-test-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI rejects junction or symlink output parents instead of writing outside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interviewer-quality-link-test-'));
  const external = await mkdtemp(join(tmpdir(), 'interviewer-quality-link-test-'));
  try {
    await mkdir(join(root, 'data/sessions'), { recursive: true });
    await writeFile(join(root, 'data/sessions', sessionId + '.json'), JSON.stringify(session([turn('root')])));
    await symlink(external, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => evaluateInterviewerQualityCli(['--session', sessionId, '--out', 'linked/quality.json'], root), /LINK_OR_PATH_INVALID/);
  } finally {
    for (const directory of [root, external]) { assert.equal(dirname(directory), resolve(tmpdir())); assert.ok(basename(directory).startsWith('interviewer-quality-link-test-')); await rm(directory, { recursive: true, force: true }); }
  }
});

test('latest quality defaults to the latest user session and opts into newer synthetic runs only explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interviewer-quality-test-'));
  const userId = '22222222-2222-4222-8222-222222222222';
  try {
    await mkdir(join(root, 'data/sessions'), { recursive: true });
    const user = session([turn('root')]); user.id = userId; user.metrics = {};
    const userPath = join(root, 'data/sessions', userId + '.json');
    await writeFile(userPath, JSON.stringify(user)); await utimes(userPath, new Date(1000), new Date(1000));
    for (const flag of ['syntheticTest', 'syntheticProvider', 'syntheticVoice', 'syntheticClientObservation']) {
      const synthetic = session([turn('root')]); synthetic.metrics = { verification: { syntheticTest: false, [flag]: true, scenario: 'newer-verification' } };
      const syntheticPath = join(root, 'data/sessions', sessionId + '.json');
      await writeFile(syntheticPath, JSON.stringify(synthetic)); await utimes(syntheticPath, new Date(2000), new Date(2000));
      assert.equal(JSON.parse(await evaluateInterviewerQualityCli(['--latest'], root)).session.id, userId, flag);
      const included = JSON.parse(await evaluateInterviewerQualityCli(['--latest', '--include-synthetic'], root));
      assert.equal(included.session.id, sessionId); assert.equal(included.session.syntheticTest, true);
      assert.equal(JSON.parse(await evaluateInterviewerQualityCli(['--session', sessionId], root)).session.syntheticTest, true);
    }
    await assert.rejects(() => evaluateInterviewerQualityCli(['--session', userId, '--include-synthetic'], root), /REQUIRES_LATEST/);
    await rm(userPath);
    await assert.rejects(() => evaluateInterviewerQualityCli(['--latest'], root), /SESSION_ID_INVALID/);
  } finally {
    assert.equal(dirname(root), resolve(tmpdir())); assert.ok(basename(root).startsWith('interviewer-quality-test-'));
    await rm(root, { recursive: true, force: true });
  }
});
