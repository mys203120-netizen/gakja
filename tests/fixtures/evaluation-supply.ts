/** Explicit portable fixtures: no private files, actual approvals or provider calls. */
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { InterviewContext } from '../../server/data/load-interview-context';
import type { PreparedQuestionBank } from '../../server/data/prepared-question-bank';
import type { InterviewSession, QuestionDraft, RecordedTurn } from '../../server/protocol';
import { approveQuestionContract, createQuestionBlueprint } from '../../server/question-objective';
import { createSessionRuntime, snapshotHash } from '../../server/session-runtime';
import { compileEvaluationScopePolicy } from '../../server/policy/evaluation-scope-policy';
import { prepareBankScopeReview, sealBankScopeRegistry } from '../../server/data/evaluation-scope-registry';
import { APPROVED_KNOWLEDGE_VERSION, knowledgeHash, type ApprovedKnowledgePacket, type DemandKnowledgeBinding } from '../../server/data/approved-knowledge';
import { loadInterviewContext } from './runtime-context';
import { knowledgeSpan, recordScopeBinding, reviewedKnowledgeBundle, sealKnowledge, syntheticKnowledgeApproval } from './reviewed-evaluation-knowledge';

export const supplyReviewer = syntheticKnowledgeApproval.approverId;
export function pinSupplySnapshot(context: InterviewContext, session: InterviewSession) {
  context.evaluationScopePolicy = compileEvaluationScopePolicy(context);
  session.runtime!.contextSnapshotSha256 = snapshotHash(context);
}
export function appendSupplyTurn(context: InterviewContext, session: InterviewSession, options: { followUp?: boolean; scientific?: boolean } = {}) {
  const id = randomUUID(), root = session.turns[0]?.id ?? id, source = context.student.evidence[0];
  const questionText = options.scientific ? '1기압에서 순수한 물의 끓는점은 얼마인가요?' : options.followUp ? '그때 직접 선택한 비교 기준은 무엇인가요?' : '그 활동에서 본인이 직접 한 일이 있다면 한 가지 말씀해 주세요.';
  const draft: QuestionDraft = {
    acknowledgement: null, acknowledgementQuote: null, questionText,
    questionKind: options.followUp ? 'follow_up' : 'main', parentMainQuestionId: options.followUp ? root : null,
    evidenceIds: [source.id], evidenceQuotes: [{ evidenceId: source.id, quote: source.text, sourceStartOffset: 0, sourceEndOffset: source.text.length }],
    primaryFunction: options.scientific ? 'CONCEPT' : options.followUp ? 'CHOICE' : 'ROLE', depth: 'D2',
    questionIntent: options.scientific ? '명시된 조건에서 순수한 물의 끓는점을 확인한다.' : options.followUp ? '자료 비교에서 직접 선택한 기준 한 가지를 확인한다.' : '공동 활동을 개인 성과로 단정하지 않고 본인의 실제 행동을 확인한다.',
    targetEvidence: [options.scientific ? '1기압에서 순수한 물의 끓는점' : options.followUp ? '직접 선택한 비교 기준 한 가지' : '해당 활동에서 본인이 직접 한 행동 한 가지'],
    groundingRationale: '실제 사용 승인이 아닌 명시적인 합성 질문 검수 fixture', validationStatus: 'approved', validationFailures: [],
    premiseValidation: { version: 'question-premise-v1', guidelineVersion: '2.3', method: 'bounded_semantic_review', status: 'approved',
      reviewModel: 'explicit-synthetic-reviewer', questionSha256: knowledgeHash(questionText), coreIntentCount: 1, supportedPremises: [],
      openChecks: [{ questionStartOffset: 0, questionEndOffset: questionText.length, kind: 'open_check' }] },
  };
  const previous = session.turns.at(-1);
  draft.questionBlueprint = createQuestionBlueprint(draft, context, session, { questionId: id,
    ...(options.followUp && previous?.answerId ? { answerRefs: [{ turnId: previous.id, answerId: previous.answerId, start: 0, end: previous.rawTranscript!.length }], subordinationRationale: '실제 답변의 자료 선택에서 비교 기준 한 가지만 후속 확인한다.' } : {}) });
  draft.approvedQuestion = approveQuestionContract(draft, draft.questionBlueprint);
  const turn: RecordedTurn = {
    id, questionText, questionKind: options.followUp ? 'follow_up' : 'main', parentMainQuestionId: options.followUp ? root : id,
    mainIndex: 1, mainCount: 1, followUpIndex: options.followUp ? 1 : 0, evidenceIds: [source.id],
    questionAudioUrl: '/api/audio/synthetic-supply.mp3', acknowledgement: null, acknowledgementAudioUrl: null, interviewerId: 'interviewer-1',
    answerId: randomUUID(), rawTranscript: options.scientific ? '1기압에서 순수한 물은 섭씨 100도에서 끓습니다. 그리고 자료를 정리했습니다.' : '제가 직접 자료를 선택하고 비교 기준을 정리했습니다.', transcriptStatus: 'finalized',
    metadata: { ...draft, rulesVersion: context.manifest.rulesVersion, generatedAt: session.createdAt, answerTurnId: options.followUp ? root : null,
      sourceRefIds: [source.id], activityIds: [source.activityId], supportTarget: context.target, questionClusterId: options.followUp ? root : id,
      parentQuestionId: options.followUp ? root : null, nonEvaluative: false },
  };
  session.turns.push(turn);
  session.questionPresentations!.push({ turnId: id, rootTurnId: turn.parentMainQuestionId, questionKind: turn.questionKind,
    clockId: 'synthetic-supply-clock', startedAtMs: session.turns.length * 1000, completedAtMs: session.turns.length * 1000 + 500 });
  return { turn, draft };
}

export async function evaluationSupplyFixture(options: { scientific?: boolean; followUp?: boolean } = {}) {
  const context = await loadInterviewContext();
  context.target = { ...context.target, university: '합성대학교', department: '합성학과', track: '합성전형', studentName: '합성학생' } as unknown as InterviewContext['target'];
  context.manifest.target = context.target;
  const now = '2026-11-06T00:00:00.000Z';
  const session: InterviewSession = {
    id: randomUUID(), createdAt: now, updatedAt: now, status: 'ending', evaluationStatus: 'pending', target: context.target,
    sourceManifest: context.manifest, durationSeconds: 600, elapsedMs: 5000, turns: [], questionPresentations: [], followUpCountByMainQuestion: {},
    runtime: createSessionRuntime(context, { id: 'synthetic-supply-owner', mode: 'local-development' }, now),
  };
  const { turn, draft } = appendSupplyTurn(context, session, { scientific: options.scientific });
  if (options.followUp) appendSupplyTurn(context, session, { followUp: true });
  const candidateId = knowledgeHash('synthetic-exact-candidate:' + turn.id), slotId = 'synthetic-supply-slot';
  const bank = {
    schemaVersion: 'prepared-q0-objective-pool-v2', status: 'ready', key: knowledgeHash('synthetic-bank:' + turn.id),
    contentSha256: knowledgeHash('synthetic-bank-content:' + turn.id), sourceFingerprint: knowledgeHash('synthetic-bank-source:' + turn.id),
    slots: [{ slotId, mainIndex: 1, candidates: [{ id: candidateId, slotId, mainIndex: 1, variant: 0, createdAt: now, draft, questionSha256: knowledgeHash(draft.questionText), questionAudioUrl: turn.questionAudioUrl }] }],
    plan: { slots: [{ id: slotId }] },
  } as unknown as PreparedQuestionBank;
  session.plan = { poolKey: bank.key, poolContentSha256: bank.contentSha256 } as InterviewSession['plan'];
  turn.metadata.selectionTrace = { policyVersion: 'synthetic-selection', bankKey: bank.key, bankCandidateId: candidateId,
    objectiveId: slotId, semanticKey: 'synthetic-personal-action', mode: 'mock', reasonCodes: [], exposureStatus: 'not_published', publicationRevision: null, historySessionIds: [] };
  session.runtime!.endRequestedAt = now; session.runtime!.evaluationInputFrozenAt = now;
  session.runtime!.acceptedEndRequest = { elapsedMs: session.elapsedMs, metrics: {} };
  pinSupplySnapshot(context, session);
  return { context, session, bank, turn };
}

export function supplyRecordBundle(session: InterviewSession, turns = session.turns) {
  return reviewedKnowledgeBundle([], turns.filter(turn => turn.questionKind !== 'clarification').map(turn => recordScopeBinding(session, turn)));
}
export function reviewedSupplyRegistry(value: Awaited<ReturnType<typeof evaluationSupplyFixture>>) {
  const proposed = prepareBankScopeReview(value.context, value.bank, { ownerId: value.session.runtime!.owner.id });
  const { contentSha256: ignored, ...body } = structuredClone(proposed); void ignored;
  for (const row of body.entries) {
    row.scope = value.turn.metadata.primaryFunction === 'CONCEPT' ? 'objective_accuracy_core' : 'record_consistency_only';
    row.assessableCriteria = ['실제 질문에서 요구한 수행 내용과 확정 답변의 일관성'];
    row.excludedCriteria = ['승인 범위 밖 과학적 정오와 실제로 말하지 않은 경험'];
    if (row.scope === 'objective_accuracy_core') {
      const bundle = supplyObjectiveBundle(value.session);
      body.packets = [...bundle.packets]; row.packetRefs = [...bundle.bindings[0].packetRefs];
      row.evidenceExpectations = ['실제 확정 답변의 핵심 주장 및 압력과 혼합물 조건을 검수한다.'];
    }
    row.review = { status: 'approved', authority: 'explicit_reviewed_input', approverId: supplyReviewer,
      reviewedAt: '2026-11-06T00:00:00.000Z', reason: '정확한 합성 문항 요구와 원문에 한정한 사전 범위를 검수했다.' };
  }
  return sealBankScopeRegistry(body);
}
export function supplyObjectiveBundle(session: InterviewSession) {
  const turn = session.turns[0], text = '합성 검수 출처: 순수한 물은 1기압에서 섭씨 100도에서 끓는다.';
  const packet: ApprovedKnowledgePacket = sealKnowledge({ version: APPROVED_KNOWLEDGE_VERSION, id: 'synthetic-supply-packet', revision: 'synthetic-v1', approval: syntheticKnowledgeApproval,
    source: { id: 'synthetic-source', version: 'synthetic-v1', locator: 'explicit-synthetic-only:p1', text, textSha256: knowledgeHash(text) }, sourceSpan: knowledgeSpan(text),
    assumptions: [{ id: 'pressure', text: '압력은 1기압이다.' }], excludedScopes: [{ id: 'mixture', text: '혼합물은 제외한다.' }] });
  const { contentSha256: ignored, ...record } = recordScopeBinding(session, turn); void ignored;
  const claimEnd = turn.rawTranscript!.indexOf(' 그리고');
  const binding: DemandKnowledgeBinding = sealKnowledge({ ...record, scope: 'objective_accuracy_core' as const, claimCoverage: 'all_core_claims_reviewed' as const,
    packetRefs: [{ id: packet.id, revision: packet.revision, contentSha256: packet.contentSha256 }],
    claimReviews: [{ sourceTurnId: turn.id, answerId: turn.answerId!, answerSha256: knowledgeHash(turn.rawTranscript!), claim: knowledgeSpan(turn.rawTranscript!, 0, claimEnd),
      packetId: packet.id, packetSha256: packet.contentSha256, sourceSpanSha256: packet.sourceSpan.sha256,
      assumptionReviews: [{ id: 'pressure', satisfied: true, reason: '명시적인 합성 입력의 1기압 조건을 검토했다.' }],
      excludedScopeReviews: [{ id: 'mixture', applies: false, reason: '합성 요구와 실제 주장은 순수한 물의 경우다.' }],
      relation: 'supported' as const, isCoreToDemand: true, rationale: '실제 주장 구간과 승인 출처를 명시적으로 연결한 합성 검수다.' }] });
  return reviewedKnowledgeBundle([packet], [binding]);
}
export function mutateSupplyBinding(bundle: ReturnType<typeof supplyRecordBundle>, mutate: (binding: DemandKnowledgeBinding) => void) {
  const bindings = structuredClone(bundle.bindings);
  mutate(bindings[0]);
  return reviewedKnowledgeBundle([...bundle.packets], bindings.map(({ contentSha256: ignored, ...body }) => { void ignored; return sealKnowledge(body); }));
}
export function supplySigner() {
  const keys = generateKeyPairSync('ed25519');
  return { trustedPublicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    receipt: (payload: Record<string, unknown>) => ({ ...payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), keys.privateKey).toString('base64') }) };
}
export function signSupplyReceipt(payload: Record<string, unknown>) {
  const signer = supplySigner(); return { trustedPublicKey: signer.trustedPublicKey, receipt: signer.receipt(payload) };
}
