import test from 'node:test';
import assert from 'node:assert/strict';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewSession, RecordedTurn } from '../server/protocol';
import type { RuntimeQuestionStrategy } from '../server/data/question-strategy-catalog';
import { buildConversationLedger } from '../server/conversation-ledger';
import { runtimeCorePayload, singleCoreInputPayload, selectRuntimeStrategies, type RuntimePayloadScope } from '../server/providers/runtime-core-payload';

function fixture() {
  const source = { id: 'E1', activityId: 'A1', page: 3, text: '실험 자료를 비교하는 활동을 수행함.', sourceRef: { pdfSha256: 'a'.repeat(64), page: 3, startOffset: 12, endOffset: 36 } };
  const turn = (id: string, root: string, raw: string, kind = 'main') => ({ id, answerId: 'answer-' + id, parentMainQuestionId: root, questionKind: kind, questionText: id + '에서 확인한 행동은 무엇인가요?', rawTranscript: raw, transcriptStatus: 'finalized', evidenceIds: ['E1'], metadata: { questionIntent: id + '의 실제 행동 확인', targetEvidence: [id + '의 행동 한 가지'], primaryFunction: 'ROLE', depth: 'D2', activityIds: ['A1'] } }) as unknown as RecordedTurn;
  const cross = turn('old', 'old', '이전 묶음의 측정값은 12도였습니다.');
  const root = turn('root', 'root', '혼자 자료를 비교했습니다.');
  const declined = turn('declined', 'root', '모르겠습니다.', 'clarification');
  const corrected = turn('corrected', 'root', '정정하겠습니다. 팀원이 자료를 모았습니다.', 'follow_up');
  const current = turn('current', 'root', '제가 직접 측정한 것은 아닙니다. 비교만 했습니다.', 'follow_up');
  const session = { turns: [cross, root, declined, corrected, current], followUpCountByMainQuestion: {} } as unknown as InterviewSession;
  const context = { target: {}, student: { evidence: [source] }, school: { academicYear: 2027 } } as unknown as InterviewContext;
  const ledger = buildConversationLedger(session);
  const scope: RuntimePayloadScope = { current, root, ledger, anchors: [], strategies: [], operations: [], irOptions: { contradictionPairs: [] } };
  return { context, session, scope, source, cross, root, declined, corrected, current };
}

test('runtime projection retains every selected exact transcript once and all correction/decline source bindings', () => {
  const f = fixture(), payload = runtimeCorePayload(f.context, f.session, f.scope, { allowFollowUp: true, allowClarification: true, allowAudioReplay: true, remainingMs: 100000 });
  const serialized = JSON.stringify(payload);
  for (const turn of [f.cross, f.root, f.declined, f.corrected, f.current]) {
    assert.equal(serialized.split(turn.rawTranscript!).length - 1, 1, 'No original word is duplicated or replaced by a summary');
  }
  assert.equal(serialized.split(f.source.text).length - 1, 1);
  assert.equal(payload.answer.finalTranscript, f.current.rawTranscript);
  assert.ok(payload.memory.declinedTargets!.some(target => target.turnId === f.declined.id));
  assert.ok(payload.memory.correctionCandidates!.some(candidate => payload.memory.claimRefs!.some(claim => claim.id === candidate.correctionClaimId && claim.turnId === f.corrected.id)));
  const answers = new Map(f.session.turns.map(turn => [turn.id, turn.rawTranscript!]));
  for (const ref of payload.memory.claimRefs!) {
    const original = f.scope.ledger.claims.find(claim => claim.id === ref.id)!;
    assert.equal(answers.get(ref.turnId)!.slice(ref.start, ref.end), original.text);
    assert.equal(ref.answerId, f.session.turns.find(turn => turn.id === ref.turnId)!.answerId);
  }
  assert.deepEqual(payload.sourceEvidence[0].sourceRef, f.source.sourceRef);
});

test('single-core projection preserves actual words without injecting lexical fulfillment or correction judgments', () => {
  const f = fixture();
  const payload = runtimeCorePayload(f.context, f.session, f.scope, { allowFollowUp: true, allowClarification: true, allowAudioReplay: true, remainingMs: 100000, semanticAuthority: 'single_core' });
  assert.equal('personalActionWitness' in payload.turn_local_coverage, false);
  for (const field of ['declinedTargets', 'correctionCandidates', 'claimRefs', 'establishedTargets', 'unresolvedTargets']) assert.equal(field in payload.memory, false);
  assert.equal('allowedOperations' in payload, false);
  assert.equal('probes' in payload.actualAnswers!, false);
  assert.ok(payload.actualAnswers!.answers.every(answer => !('languageSignals' in answer)));
  assert.ok(payload.actualAnswers!.answers.every(answer => !('observation' in answer)), 'A lexical final_words/incomplete_fragment label is not a core completion verdict.');
  assert.ok(payload.memory.requestedTargets.every(target => !('fulfillment' in target)));
  const serialized = JSON.stringify(payload);
  for (const turn of f.session.turns) assert.equal(serialized.split(turn.rawTranscript!).length - 1, 1);
});

test('question references resolve to exact questions and legacy IR injection remains an explicit option', () => {
  const f = fixture();
  const natural = runtimeCorePayload(f.context, f.session, f.scope, { allowFollowUp: true, allowClarification: true, allowAudioReplay: false, remainingMs: 1 });
  const questions = new Set([natural.question.turnId, natural.rootQuestion.turnId, ...natural.alreadyAsked.map(question => question.turnId)]);
  for (const answer of natural.actualAnswers!.answers) assert.ok(questions.has(answer.questionRef));
  assert.equal('anchors' in natural.answer, false);
  assert.equal('availableContradictionPairs' in natural, false);
  const legacy = runtimeCorePayload(f.context, f.session, f.scope, { allowFollowUp: true, allowClarification: true, allowAudioReplay: false, remainingMs: 1, legacyIrProjection: true });
  assert.deepEqual(legacy.answer.anchors, []);
  assert.equal(legacy.actualAnswers?.currentTurnId, f.current.id);
  assert.equal(legacy.actualAnswers?.answers.at(-1)?.answerId, f.current.answerId);
  assert.deepEqual(legacy.availableContradictionPairs, []);
});

test('small strategy presentation preserves a retrieved correction option without creating facts or requiring a probe', () => {
  const strategies = ['process', 'own_action', 'choice_basis', 'comparison', 'limit', 'alternative', 'transfer', 'contradiction'].map((operation, index) => ({ id: 'S' + index, operation })) as unknown as RuntimeQuestionStrategy[];
  const ordinary = selectRuntimeStrategies(strategies);
  assert.equal(ordinary.length, 5);
  const correction = selectRuntimeStrategies(strategies, { hasCorrection: true });
  assert.equal(correction.length, 5); assert.ok(correction.some(card => card.operation === 'contradiction'));
  assert.ok(correction.every(card => strategies.includes(card)));
  assert.deepEqual(selectRuntimeStrategies(strategies, { remainingFollowUps: 0 }), []);
});

test('single-core strategy references retain method wording without turning card requirements into unheard answer demands', () => {
  const f = fixture();
  f.scope.strategies = [{ id: 'S-REFERENCE', operation: 'process', surface: '어떤 방법을 사용했나요?',
    trigger: 'UNSPOKEN_TRIGGER_REQUIREMENT', requiredClaimSlots: ['UNSPOKEN_REQUIRED_SLOT'], expectedEvidence: ['UNSPOKEN_EXPECTED_EVIDENCE'],
    applicabilityConditions: ['UNSPOKEN_APPLICABILITY_REQUIREMENT'] } as unknown as RuntimeQuestionStrategy];
  const payload = singleCoreInputPayload(f.context, f.session, f.scope, { allowFollowUp: true, allowClarification: true, allowAudioReplay: true, remainingMs: 100000 });
  assert.deepEqual(payload.strategyCandidates, [{ id: 'S-REFERENCE', operation: 'process', surface: '어떤 방법을 사용했나요?' }]);
  assert.equal(JSON.stringify(payload).includes('UNSPOKEN_'), false);
  assert.equal(payload.answer.transcriptText, f.current.rawTranscript);
});

test('compact spoken input removes repeated instructions and prompt-only provenance while retaining every exact word', () => {
  const f=fixture(),payload=singleCoreInputPayload(f.context,f.session,f.scope,{allowFollowUp:true,allowClarification:true,allowAudioReplay:true,remainingMs:100000});
  assert.equal(payload.payloadVersion,'spoken-question-single-core-input-v6');
  assert.equal('readingPolicy' in payload.answer,false);assert.equal('transcriptStatusMeaning' in payload.answer,false);
  assert.equal('interpretationPolicy' in payload.actualAnswers!,false);
  assert.equal('strategyReferencePolicy' in payload,false);assert.equal('referencePolicy' in payload,false);
  assert.equal('sourceRef' in payload.sourceEvidence[0],false);
  const serialized=JSON.stringify(payload);
  for(const turn of f.session.turns)assert.equal(serialized.split(turn.rawTranscript!).length-1,1);
  assert.equal(serialized.split(f.source.text).length-1,1);
  assert.equal(f.source.sourceRef.pdfSha256,'a'.repeat(64),'Stored provenance is unchanged.');
  const latest=payload.actualAnswers!.answers.at(-1)!;
  assert.ok('transcriptRef' in latest);assert.equal(latest.transcriptRef,'answer.transcriptText');
});
