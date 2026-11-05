import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { interviewConfig } from '../interview.config';
import type { InterviewContext } from '../server/data/load-interview-context';
import { createSessionQuestionPlan, loadQuestionBank, loadQuestionBankByPinnedPlan, loadQuestionBankPreparationSummary, prepareQuestionBank, questionBankIdentity, selectNextPreparedMainQuestion, selectPreparedMainQuestion, QuestionPoolUnavailableError, type QuestionBankProviders } from '../server/data/prepared-question-bank';
import type { InterviewPlan } from '../server/interview-planner';
import type { InterviewSession, QuestionDraft } from '../server/protocol';
import { speechAudioCacheId } from '../server/providers/clova-tts';
import { activityFields, buildPreparedActivities, preparedActivitiesModel, savePreparedActivities } from '../server/data/prepared-activities';
import { syntheticReferenceCorpus, syntheticReferenceQuestion } from './fixtures/book-references';
import { INTERVIEWER_POLICY_VERSION, type InterviewerPolicyPack } from '../server/policy/interviewer-policy';
import type { QuestionStrategyCatalog, QuestionStrategyCard, QuestionStrategyRecord } from '../server/data/question-strategy-catalog';
import { createQuestionBlueprint, approveQuestionContract, assertQuestionContractIntegrity } from '../server/question-objective';
import { QuestionPreparationError } from '../server/providers/question-grounding';

// Explicit synthetic fixtures: no real model, speech API, PDF, browser or user session is used.
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const environment = { OPENAI_QUESTION_MODEL: 'synthetic-bank-model' };
function input() {
  const context = {
    target: interviewConfig.target, errors: [], student: { evidence: [
      { id: 'fixture-e1', activityId: 'fixture-a1', text: '용액 비교 탐구의 수행 과정을 정리했다.' },
      { id: 'fixture-e2', activityId: 'fixture-a2', text: '관찰 자료를 선택한 기준을 설명했다.' },
    ].map((source, index) => ({ ...source, title: '합성 원문', page: 1, grade: 1, section: '합성 사례', confirmationStatus: 'confirmed_from_record', sourceRef: { file: 'synthetic.pdf', pdfSha256: digest('synthetic'), page: 1, extraction: 'synthetic-fixture', startOffset: index * 100, endOffset: index * 100 + source.text.length } })) }, interviewOverview: { durationSeconds: 300 },
    manifest: { schemaVersion: 'synthetic-source-manifest', errors: [], rulesVersion: interviewConfig.rulesVersion, guidelineSourceVersions: { operatingGuidelines: '2.0', questionGuidelines: '2.3', evaluationGuidelines: '2.3' }, files: [{ role: 'synthetic', path: 'fixture-source', sha256: digest('fixture-source') }], recordIds: { fixture: 'fixture-record' }, evidenceIds: ['fixture-e1', 'fixture-e2'], sourceIntegrity: { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true, evidenceCount: 2 } },
  } as unknown as InterviewContext;
  const plan: InterviewPlan = { policyVersion: 'synthetic-bank-plan', durationSeconds: 300, mainQuestionTarget: 2, limitations: ['Synthetic fixtures only.'], slots: [
    { id: 'main-slot-1', index: 1, label: '합성 과정', topicArea: 'academic_inquiry', evidenceIds: ['fixture-e1'], activityIds: ['fixture-a1'], primaryFunction: 'PROCESS', depth: 'D2', questionIntent: '실제 수행 과정을 확인한다.', interviewerId: 'interviewer-1', interviewerRole: 'academic', schoolConnections: [] },
    { id: 'main-slot-2', index: 2, label: '합성 선택', topicArea: 'problem_solving', evidenceIds: ['fixture-e2'], activityIds: ['fixture-a2'], primaryFunction: 'CHOICE', depth: 'D2', questionIntent: '선택한 판단 기준을 확인한다.', interviewerId: 'interviewer-2', interviewerRole: 'community_talent', schoolConnections: [] },
  ] };
  return { context, plan };
}

test('changing realtime or factual-review models preserves the approved offline bank identity', () => {
  const { context, plan } = input();
  const original = questionBankIdentity(context, { plan, environment });
  const selected = questionBankIdentity(context, { plan, environment: { ...environment,
    OPENAI_REALTIME_MODEL: 'gpt-6.1-terra', OPENAI_REVIEW_MODEL: 'gpt-6-luna' } });
  assert.equal(selected.key, original.key);
  assert.equal(selected.questionModel, original.questionModel);
});
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'interview-question-bank-'));
  return { root, async close() { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('interview-question-bank-')); await rm(root, { recursive: true, force: true }); } };
}
function fakeProviders() {
  let generated = 0, synthesized = 0, active = 0, maxActive = 0;
  const controls = { failSlot: null as string | null, rejectSlot: null as string | null, rejectAll: false, invalidAudit: false, invalidAudio: false, duplicate: false, referenceTrace: null as 'missing' | 'wrong_catalog' | 'excluded' | 'unreviewed' | 'wrong_analysis' | 'wrong_use' | 'missing_use' | null };
  const providers: QuestionBankProviders = {
    async generate(context, session, excluded) {
      generated++; active++; maxActive = Math.max(maxActive, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 2));
        const slot = session.plan!.slots[session.turns.length];
        if (controls.failSlot === slot.id) throw new Error('synthetic interruption');
        // The ordinary provider has already exhausted its two independent attempts.
        if (controls.rejectAll || controls.rejectSlot === slot.id) throw new QuestionPreparationError(2, 'PREMISE_UNSUPPORTED');
        assert.ok(session.turns.every(turn => !turn.answerId && turn.rawTranscript === undefined));
        assert.equal(session.hasGreeted, true);
        const alternate = excluded.length > 0 && !controls.duplicate;
        const firstSourceSlot = slot.id === 'main-slot-1';
        const questionText = firstSourceSlot ? alternate ? '용액 비교 탐구를 진행한 순서는 무엇인가요?' : '용액 비교 탐구는 어떤 순서로 진행했나요?' : alternate ? '관찰 자료를 고를 때 어떤 기준을 고려했나요?' : '관찰 자료를 선택한 기준은 무엇인가요?';
        const source = context.student.evidence.find(item => item.id === slot.evidenceIds[0])!;
        const draft: QuestionDraft = { acknowledgement: null, acknowledgementQuote: null, questionText, questionKind: 'main', parentMainQuestionId: null, evidenceIds: slot.evidenceIds, evidenceQuotes: [{ evidenceId: source.id, quote: source.text }], primaryFunction: slot.primaryFunction, questionIntent: slot.questionIntent, targetEvidence: [firstSourceSlot ? '용액 비교 탐구의 수행 과정' : '관찰 자료를 선택한 기준'], depth: slot.depth, groundingRationale: '합성 원문에서 확인한 요구를 검증한다.', validationStatus: 'approved', validationFailures: [], premiseValidation: { version: 'question-premise-v1', guidelineVersion: '2.3', status: 'approved', method: 'bounded_semantic_review', reviewModel: environment.OPENAI_QUESTION_MODEL, questionSha256: controls.invalidAudit ? digest('wrong') : digest(questionText), coreIntentCount: 1, supportedPremises: [{ basis: 'record', sourceId: source.id, questionStartOffset: 0, questionEndOffset: 5, sourceStartOffset: 0, sourceEndOffset: 5 }], openChecks: [] } };
        if (context.questionReferences && controls.referenceTrace !== 'missing') draft.questionReferenceContext = {
          schemaVersion: context.questionReferences.schemaVersion,
          catalogSha256: controls.referenceTrace === 'wrong_catalog' ? digest('wrong reference') : context.questionReferences.digest,
          exampleIds: [controls.referenceTrace === 'excluded' ? 'synthetic-excluded-question' : controls.referenceTrace === 'unreviewed' ? 'synthetic-unreviewed-question' : 'synthetic-eligible-question'],
          purpose: 'wording_reference_only',
          analysisKey: controls.referenceTrace === 'wrong_analysis' ? digest('wrong analysis') : context.questionReferences.analysis?.key,
          ...(controls.referenceTrace === 'missing_use' ? {} : { referenceUses: [{ id: controls.referenceTrace === 'excluded' ? 'synthetic-excluded-question' : controls.referenceTrace === 'unreviewed' ? 'synthetic-unreviewed-question' : 'synthetic-eligible-question', usage: controls.referenceTrace === 'wrong_use' ? 'contextual_strategy' as const : 'direct_example' as const }] }),
        };
        return draft;
      } finally { active--; }
    },
    async synthesize(text, settings) { synthesized++; const id = speechAudioCacheId(text, settings); return { audioUrl: `/api/audio/${controls.invalidAudio ? digest('wrong audio') : id}`, bytes: Buffer.from(`explicit-synthetic-audio:${text}`) }; },
  };
  return { providers, controls, counts: () => ({ generated, synthesized, maxActive }) };
}

test('bank identity follows source bytes, actual plan, model and effective voices, not irrelevant or redundant env values', () => {
  const { context, plan } = input(), original = questionBankIdentity(context, { plan, environment }).key;
  assert.equal(questionBankIdentity(context, { plan, environment: { ...environment, CLOVA_SPEECH_DOMAIN_ID: 'irrelevant', CLOVA_VOICE_PRIMARY_SPEED: '0' } }).key, original);
  for (const changes of [{ CLOVA_VOICE_PRIMARY_SPEED: '-1' }, { CLOVA_VOICE_SECOND_SPEED: '-2' }, { CLOVA_VOICE_PITCH: '2' }, { CLOVA_VOICE_SPEAKER: 'different' }, { OPENAI_QUESTION_MODEL: 'different' }]) assert.notEqual(questionBankIdentity(context, { plan, environment: { ...environment, ...changes } }).key, original);
  const changedContext = structuredClone(context); changedContext.manifest.files[0].sha256 = digest('different source');
  assert.notEqual(questionBankIdentity(changedContext, { plan, environment }).key, original);
  const changedText = structuredClone(context); changedText.student.evidence[0].text += ' 변경';
  assert.notEqual(questionBankIdentity(changedText, { plan, environment }).key, original);
  const changedPlan = structuredClone(plan); changedPlan.slots[0].questionIntent = '동일 자료에서 다른 과정 요구를 확인한다.';
  assert.notEqual(questionBankIdentity(context, { plan: changedPlan, environment }).key, original);
  changedContext.manifest.sourceIntegrity.evidenceTextVerified = false;
  assert.throws(() => questionBankIdentity(changedContext, { plan, environment }));
});

test('an offline precision reviewer needs the exact pinned objective and utterance authority', async t => {
  for (const mode of ['missing', 'wrong_hash', 'wrong_objective', 'bound'] as const) await t.test(mode, async child => {
    const fixture = await temporary(); child.after(fixture.close);
    const { context, plan } = input(), fake = fakeProviders();
    const questions = ['용액 비교 탐구는 어떤 순서로 진행했나요?', '용액 비교 탐구를 진행한 순서는 무엇인가요?', '관찰 자료를 선택한 기준은 무엇인가요?', '관찰 자료를 고를 때 어떤 기준을 고려했나요?'];
    if (mode !== 'missing') context.targetAnalysis = { objectiveContractRevision: {
      version: 'independently-reviewed-objective-contract-v1', parentRevision: 'fixture-parent', parentContentSha256: digest('parent'),
      reviewArtifactSha256: digest('reviewed-artifact'), reviewModel: 'synthetic-precision-model', reviewedAt: new Date().toISOString(),
      changedObjectiveIds: ['main-slot-1', 'main-slot-2'], blockedObjectives: [],
      approvedQuestions: questions.map((question, index) => ({ objectiveId: mode === 'wrong_objective' ? 'another-objective' : index < 2 ? 'main-slot-1' : 'main-slot-2', questionSha256: digest(mode === 'wrong_hash' ? 'different-question' : question) })),
    } } as unknown as InterviewContext['targetAnalysis'];
    const providers: QuestionBankProviders = { ...fake.providers, async generate(...args) {
      const draft = await fake.providers.generate(...args); draft.premiseValidation!.reviewModel = 'synthetic-precision-model'; return draft;
    } };
    const options = { root: fixture.root, plan, environment, providers };
    if (mode === 'bound') { await prepareQuestionBank(context, options); assert.ok(await loadQuestionBank(context, options)); }
    else { await assert.rejects(prepareQuestionBank(context, options)); assert.equal(await loadQuestionBank(context, options), null); }
  });
});

test('an empty resumed placeholder does not hide an unchanged precision-reviewed donor under a new contract revision', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders();
  const hashBody = <T extends object>(body: T) => ({ ...body, contentSha256: digest(JSON.stringify(body)) });
  const common = hashBody({ revision: digest('synthetic-common'), activities: [] }), evidence = structuredClone(context.student.evidence);
  const questions = ['용액 비교 탐구는 어떤 순서로 진행했나요?', '용액 비교 탐구를 진행한 순서는 무엇인가요?', '관찰 자료를 선택한 기준은 무엇인가요?', '관찰 자료를 고를 때 어떤 기준을 고려했나요?'];
  const previous = hashBody({ revision: `target-${digest('old-target')}`, objectives: plan.slots.map(slot => ({ id: slot.id, questionIntent: slot.questionIntent, primaryFunction: slot.primaryFunction, depth: slot.depth })),
    objectiveContractRevision: { version: 'independently-reviewed-objective-contract-v1', parentRevision: `target-${digest('earlier-target')}`, parentContentSha256: digest('earlier-target'), reviewArtifactSha256: digest('old-precision-review'), reviewModel: 'synthetic-precision-model', reviewedAt: '2026-11-03T00:00:00.000Z', changedObjectiveIds: plan.slots.map(slot => slot.id), approvedQuestions: questions.map((question, index) => ({ objectiveId: index < 2 ? 'main-slot-1' : 'main-slot-2', questionSha256: digest(question) })), blockedObjectives: [] } });
  context.targetAnalysis = previous as unknown as InterviewContext['targetAnalysis'];
  const providers: QuestionBankProviders = { ...fake.providers, async generate(...args) { const draft = await fake.providers.generate(...args); draft.premiseValidation!.reviewModel = 'synthetic-precision-model'; return draft; } };
  const options = { root: fixture.root, plan, environment, providers };
  const oldBank = await prepareQuestionBank(context, options), before = fake.counts();
  const oldPath = path.join(fixture.root, 'data/prepared/question-banks', oldBank.key + '.json'), originalBytes = await readFile(oldPath);
  const current = hashBody({ ...Object.fromEntries(Object.entries(previous).filter(([key]) => key !== 'contentSha256')), revision: `target-${digest('new-target')}`,
    objectiveContractRevision: { ...previous.objectiveContractRevision, parentRevision: previous.revision, parentContentSha256: previous.contentSha256, reviewModel: 'synthetic-new-reviewer', reviewArtifactSha256: digest('new-unrelated-review'), changedObjectiveIds: ['unrelated-purpose'], approvedQuestions: [] } });
  const base = path.join(fixture.root, 'data/prepared/student-analysis-revisions', common.revision), previousPath = path.join(base, previous.revision, 'analysis.json'), currentPath = path.join(base, current.revision, 'analysis.json');
  await mkdir(path.dirname(previousPath), { recursive: true }); await mkdir(path.dirname(currentPath), { recursive: true });
  await writeFile(previousPath, JSON.stringify({ common, target: previous, evidence })); await writeFile(currentPath, JSON.stringify({ common, target: current, evidence }));
  const updated = structuredClone(context); updated.targetAnalysis = current as unknown as InterviewContext['targetAnalysis']; updated.studentAnalysis = common as unknown as InterviewContext['studentAnalysis'];
  updated.manifest.files.push({ role: 'fullStudentAnalysis', path: path.relative(fixture.root, currentPath), sha256: digest(await readFile(currentPath, 'utf8')) });
  const identity = questionBankIdentity(updated, options);
  const { contentSha256: _oldDigest, completedAt: _oldCompletion, ...oldBody } = oldBank; void _oldDigest; void _oldCompletion;
  const placeholderTime = '2026-11-04T00:00:00.000Z';
  const partial = { ...oldBody, ...identity, status: 'preparing', slots: identity.plan.slots.map(slot => ({ slotId: slot.id, mainIndex: slot.index, candidates: [], attemptedAt: placeholderTime })) };
  await writeFile(path.join(fixture.root, 'data/prepared/question-banks', identity.key + '.partial.json'), JSON.stringify(partial));
  const reused = await prepareQuestionBank(updated, { ...options, reuseFromBankKey: oldBank.key, maxNewCandidates: 0 });
  assert.notEqual(reused.key, oldBank.key);
  assert.deepEqual(fake.counts(), before, 'no generation or synthesis is spent to reapprove unchanged old speech');
  assert.ok(reused.slots.every(slot => slot.attemptedAt === placeholderTime), 'the original attempted checkpoint observations are retained');
  assert.deepEqual(reused.slots.flatMap(slot => slot.candidates.map(candidate => [candidate.questionSha256, candidate.speechHash, candidate.audioSha256])), oldBank.slots.flatMap(slot => slot.candidates.map(candidate => [candidate.questionSha256, candidate.speechHash, candidate.audioSha256])));
  assert.ok(await loadQuestionBank(updated, { ...options }));
  assert.deepEqual(await readFile(oldPath), originalBytes);
  const pinned = createSessionQuestionPlan(updated, reused, { sessionSeed: 'separate-load-snapshot' });
  const changedAncestor = JSON.parse(await readFile(previousPath, 'utf8'));
  changedAncestor.evidence[0].text = '첫 로딩 뒤 파일에서 바뀐 합성 원문';
  await writeFile(previousPath, JSON.stringify(changedAncestor));
  assert.equal(await loadQuestionBank(updated, options), null, 'a second ordinary load must read the changed ancestor again');
  assert.equal(await loadQuestionBankByPinnedPlan(updated, pinned, fixture), null, 'a separate pinned-plan load also owns a fresh scope');
});

function attachReferences(context: InterviewContext, version = 'first') {
  // Source-bound, explicitly synthetic classifications exercise reference trace binding.
  const eligible = syntheticReferenceQuestion('관찰 자료를 실제로 비교한 과정은 무엇인가요?', { id: 'synthetic-eligible-question', primaryFunctions: ['PROCESS'] });
  const excluded = syntheticReferenceQuestion('개인의 종교에 대해 말씀해 주세요.', { id: 'synthetic-excluded-question', restrictions: ['sensitive_personal'] });
  const unreviewed = syntheticReferenceQuestion('아직 분석하지 않은 자료의 내용은 무엇인가요?', { id: 'synthetic-unreviewed-question', reviewed: false });
  unreviewed.runtimeApproved = true; // An arbitrary old approval flag cannot authorize this source.
  const corpus = syntheticReferenceCorpus([eligible, excluded, unreviewed], version);
  context.questionReferences = corpus;
  context.manifest.questionReferenceCatalog = { schemaVersion: corpus.schemaVersion, policyVersion: corpus.policyVersion, digest: corpus.digest, sourceHashes: corpus.sourceHashes, figuresDirectory: corpus.figuresDirectory, eligibleQuestions: 1, excludedQuestions: 2, runtimeApprovedQuestions: 1, purpose: 'wording_reference_only' };
}

test('question-only catalog changes invalidate the bank without changing student evidence identity', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders(), options = { ...fixture, plan, environment, providers: fake.providers };
  const original = questionBankIdentity(context, options);
  attachReferences(context);
  const first = questionBankIdentity(context, options), bank = await prepareQuestionBank(context, options);
  assert.equal(first.sourceFingerprint, original.sourceFingerprint);
  assert.notEqual(first.key, original.key);
  assert.equal(bank.questionReferenceDigest, context.questionReferences!.digest);
  assert.ok(await loadQuestionBank(context, options));
  assert.ok(bank.slots.every(slot => slot.candidates.every(candidate => candidate.draft.evidenceIds.every(id => id.startsWith('fixture-e')))));
  attachReferences(context, 'updated');
  assert.equal(await loadQuestionBank(context, options), null);
  assert.equal(questionBankIdentity(context, options).sourceFingerprint, original.sourceFingerprint);
  context.questionReferences!.digest = digest('mismatched-memory-copy');
  assert.throws(() => questionBankIdentity(context, options), /참고 자료/u);
  attachReferences(context);
  context.questionReferences!.counts.runtimeApprovedQuestions = 0;
  assert.throws(() => questionBankIdentity(context, options), /검수된 질문 참고 자료/u);
});

test('missing, mismatched, unreviewed and incorrectly declared reference uses cannot publish a bank', async t => {
  for (const invalid of ['missing', 'wrong_catalog', 'excluded', 'unreviewed', 'wrong_analysis', 'wrong_use', 'missing_use'] as const) await t.test(invalid, async child => {
    const fixture = await temporary(); child.after(fixture.close);
    const { context, plan } = input(), fake = fakeProviders(); attachReferences(context); fake.controls.referenceTrace = invalid;
    const options = { ...fixture, plan, environment, providers: fake.providers };
    await assert.rejects(prepareQuestionBank(context, options));
    assert.equal(await loadQuestionBank(context, options), null);
  });
});

test('only a complete primary plus alternate bank is published and loading/selection uses zero providers', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders(), options = { ...fixture, plan, environment, providers: fake.providers };
  const bank = await prepareQuestionBank(context, options);
  assert.equal(bank.slots.length, 2); assert.ok(bank.slots.every(row => row.candidates.length === 2));
  assert.deepEqual(fake.counts(), { generated: 4, synthesized: 4, maxActive: 2 });
  assert.ok((await readdir(path.join(fixture.root, 'data/prepared/question-banks'))).every(file => !file.endsWith('.partial.json') && !file.endsWith('.tmp')));
  const loaded = await loadQuestionBank(context, options); assert.ok(loaded);
  const session = { plan, target: context.target, turns: [] } as unknown as InterviewSession;
  const selected = selectPreparedMainQuestion(loaded, session, 1)!;
  assert.equal(selected.variant, 0); assert.notEqual(selected.draft, loaded.slots[0].candidates[0].draft);
  assert.equal(selectPreparedMainQuestion(loaded, session, 1, { alternateIndex: 1 })!.variant, 1);
  assert.equal(selectPreparedMainQuestion(loaded, { ...session, target: { wrong: true } }, 1), null);
  assert.equal(selectPreparedMainQuestion(loaded, { ...session, plan: { ...plan, durationSeconds: 600 } }, 1), null);
  assert.deepEqual(fake.counts(), { generated: 4, synthesized: 4, maxActive: 2 });
});

test('new objective pools prepare one reviewed candidate per purpose and bind a separate session order without providers', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders();
  plan.purpose = 'candidate_pool'; plan.scheduling = 'time_based';
  plan.slots.forEach((slot, index) => { slot.semanticKey = `synthetic-purpose-${index}`; });
  const options = { ...fixture, plan, environment, providers: fake.providers };
  const bank = await prepareQuestionBank(context, options);
  assert.ok(bank.slots.every(row => row.candidates.length === 1));
  assert.equal(fake.counts().generated, 2);
  const session = { id: 'new-round', target: context.target, turns: [], plan: createSessionQuestionPlan(context, bank, { sessionSeed: 'new-round' }) } as unknown as InterviewSession;
  const before = fake.counts(), selected = selectNextPreparedMainQuestion(bank, session)!;
  assert.ok(selected); assert.equal(selected.slot.index, 1);
  assert.equal(selected.draft.selectionTrace!.bankCandidateId, selected.candidateId);
  assert.equal(selected.draft.selectionTrace!.exposureStatus, 'not_published');
  assert.equal(session.plan!.poolKey, bank.key);
  assert.deepEqual(fake.counts(), before);
  assert.ok(await loadQuestionBankByPinnedPlan(context, session.plan!, fixture));
  const wrongSnapshot = structuredClone(context); wrongSnapshot.student.evidence[0].text += ' changed';
  assert.equal(await loadQuestionBankByPinnedPlan(wrongSnapshot, session.plan!, fixture), null);
});

test('a twice-rejected pool objective is quarantined while the next independent approved objective remains usable', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders();
  plan.purpose = 'candidate_pool'; plan.scheduling = 'time_based';
  fake.controls.rejectSlot = plan.slots[0].id;
  const progress: Array<{ status: string; slotId: string; failureCode?: string }> = [];
  const options = { ...fixture, plan, environment, providers: fake.providers, onProgress: (event: { status: string; slotId: string; failureCode?: string }) => { progress.push(event); } };
  const bank = await prepareQuestionBank(context, options);
  assert.equal(bank.status, 'ready');
  assert.deepEqual(bank.plan, plan, 'the complete source plan is preserved, including its rejected objective');
  assert.equal(bank.slots.length, 2);
  assert.deepEqual(bank.slots.map(row => row.candidates.length), [0, 1]);
  const rejected = bank.slots[0].quarantine!;
  assert.equal(rejected.status, 'quarantined');
  assert.equal(rejected.objectiveId, plan.slots[0].id);
  assert.equal(rejected.slotId, plan.slots[0].id);
  assert.equal(rejected.failureCode, 'PREMISE_UNSUPPORTED');
  assert.equal(rejected.validationAttempts, 2);
  assert.equal(rejected.objectiveSha256.length, 64);
  assert.equal(new Date(rejected.quarantinedAt).toISOString(), rejected.quarantinedAt);
  assert.deepEqual(progress.map(event => [event.status, event.slotId]), [['quarantined', 'main-slot-1'], ['approved', 'main-slot-2']]);
  assert.equal(fake.counts().generated, 2); assert.equal(fake.counts().synthesized, 1);
  const summary = await loadQuestionBankPreparationSummary(context, options);
  assert.deepEqual([summary.status, summary.attemptedObjectives, summary.approvedObjectives, summary.availableApprovedCount, summary.quarantinedObjectives, summary.pendingObjectives], ['ready', 2, 1, 1, 1, 0]);
  const session = { id: 'one-approved-round', target: context.target, turns: [], plan: createSessionQuestionPlan(context, bank, { sessionSeed: 'one-approved-round' }) } as unknown as InterviewSession;
  assert.equal(session.plan!.slots.length, 1);
  assert.equal(session.plan!.scheduling, 'time_based');
  assert.equal(session.plan!.slots[0].candidateSlotId, 'main-slot-2');
  const before = fake.counts(), selected = selectNextPreparedMainQuestion(bank, session)!;
  assert.ok(selected); assert.equal(selected.slot.id, 'main-slot-2'); assert.equal(selected.slot.index, 1);
  assert.equal(selected.draft.primaryFunction, 'CHOICE', 'skipping a rejected first objective must not regenerate its function');
  assert.ok(await loadQuestionBankByPinnedPlan(context, session.plan!, fixture));
  assert.deepEqual((await prepareQuestionBank(context, options)).slots[0].quarantine, rejected);
  assert.deepEqual(fake.counts(), before, 'same-revision quarantined objectives are not silently retried');
});

test('an all-rejected pool stays unavailable, preserves every failure, and retries only after an explicit plan revision', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders();
  plan.purpose = 'candidate_pool'; plan.scheduling = 'time_based'; fake.controls.rejectAll = true;
  const options = { ...fixture, plan, environment, providers: fake.providers };
  await assert.rejects(prepareQuestionBank(context, options), error => error instanceof QuestionPoolUnavailableError && error.code === 'NO_APPROVED_QUESTION_CANDIDATES');
  assert.equal(await loadQuestionBank(context, options), null);
  let summary = await loadQuestionBankPreparationSummary(context, options);
  assert.deepEqual([summary.status, summary.attemptedObjectives, summary.availableApprovedCount, summary.quarantinedObjectives, summary.pendingObjectives], ['preparing', 2, 0, 2, 0]);
  assert.equal(summary.quarantines.length, 2);
  const before = fake.counts(); fake.controls.rejectAll = false;
  await assert.rejects(prepareQuestionBank(context, options), QuestionPoolUnavailableError);
  assert.deepEqual(fake.counts(), before, 'a repeated command does not make rejected objectives disappear or retry forever');
  const oldKey = questionBankIdentity(context, options).key;
  plan.policyVersion += '-explicit-reanalysis-revision-2';
  const ready = await prepareQuestionBank(context, options);
  assert.notEqual(ready.key, oldKey);
  summary = await loadQuestionBankPreparationSummary(context, options);
  assert.deepEqual([summary.status, summary.availableApprovedCount, summary.quarantinedObjectives], ['ready', 2, 0]);
  assert.equal(fake.counts().generated - before.generated, 2);
});

test('a quarantined objective consumes the command budget once and resumes without hiding pending work as ready', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders();
  plan.purpose = 'candidate_pool'; plan.scheduling = 'time_based'; fake.controls.rejectSlot = 'main-slot-1';
  const options = { ...fixture, plan, environment, providers: fake.providers, maxNewCandidates: 1 };
  await assert.rejects(prepareQuestionBank(context, options), error => error instanceof Error && error.name === 'QuestionPreparationBudgetError');
  assert.equal(await loadQuestionBank(context, options), null);
  const summary = await loadQuestionBankPreparationSummary(context, options);
  assert.deepEqual([summary.status, summary.attemptedObjectives, summary.availableApprovedCount, summary.quarantinedObjectives, summary.pendingObjectives], ['preparing', 1, 0, 1, 1]);
  assert.equal(fake.counts().generated, 1); assert.equal(fake.counts().synthesized, 0);
  const ready = await prepareQuestionBank(context, options);
  assert.equal(ready.status, 'ready');
  assert.equal(fake.counts().generated, 2); assert.equal(fake.counts().synthesized, 1);
});

test('transport interruption after a quarantined objective keeps a resumable partial instead of quarantining the transport failure', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders();
  plan.purpose = 'candidate_pool'; plan.scheduling = 'time_based'; fake.controls.rejectSlot = 'main-slot-1'; fake.controls.failSlot = 'main-slot-2';
  const options = { ...fixture, plan, environment, providers: fake.providers };
  await assert.rejects(prepareQuestionBank(context, options), /synthetic interruption/);
  assert.equal(await loadQuestionBank(context, options), null);
  const summary = await loadQuestionBankPreparationSummary(context, options);
  assert.deepEqual([summary.status, summary.attemptedObjectives, summary.quarantinedObjectives, summary.pendingObjectives], ['preparing', 2, 1, 1]);
  fake.controls.failSlot = null;
  const before = fake.counts(), ready = await prepareQuestionBank(context, options);
  assert.equal(ready.status, 'ready');
  assert.equal(fake.counts().generated - before.generated, 1);
  assert.equal(ready.slots[1].quarantine, undefined);
});

test('legacy fixed plans keep strict all-candidate publication even when the ordinary provider exhausts two reviews', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders(); fake.controls.rejectSlot = 'main-slot-1';
  const options = { ...fixture, plan, environment, providers: fake.providers };
  await assert.rejects(prepareQuestionBank(context, options), QuestionPreparationError);
  assert.equal(await loadQuestionBank(context, options), null);
  assert.equal((await loadQuestionBankPreparationSummary(context, options)).quarantinedObjectives, 0);
});

test('only a known exhausted two-attempt generation rejection can quarantine a pool objective', async t => {
  for (const failure of [new QuestionPreparationError(1, 'PREMISE_UNSUPPORTED'), new QuestionPreparationError(3, 'PREMISE_UNSUPPORTED'), new QuestionPreparationError(2), new QuestionPreparationError(2, 'NETWORK_FAILURE' as 'PREMISE_UNSUPPORTED')]) await t.test(`${failure.attemptCount}:${failure.lastValidationCode ?? 'missing-code'}`, async child => {
    const fixture = await temporary(); child.after(fixture.close);
    const { context, plan } = input(), fake = fakeProviders(); plan.purpose = 'candidate_pool'; plan.scheduling = 'time_based';
    const providers = { ...fake.providers, generate: async () => { throw failure; } };
    const options = { ...fixture, plan, environment, providers };
    await assert.rejects(prepareQuestionBank(context, options), error => error === failure);
    assert.equal(await loadQuestionBank(context, options), null);
    assert.equal((await loadQuestionBankPreparationSummary(context, options)).quarantinedObjectives, 0);
  });
});

test('a missing or forged quarantine cannot authorize an empty ready row even with a recomputed bank hash', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders();
  plan.purpose = 'candidate_pool'; plan.scheduling = 'time_based'; fake.controls.rejectSlot = 'main-slot-1';
  const options = { ...fixture, plan, environment, providers: fake.providers }, bank = await prepareQuestionBank(context, options);
  const file = path.join(fixture.root, 'data/prepared/question-banks', `${bank.key}.json`);
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, stable(entry)])) : value;
  const edits = [
    (changed: typeof bank) => { delete changed.slots[0].quarantine; },
    (changed: typeof bank) => { changed.slots[0].quarantine!.objectiveId = 'wrong-objective'; },
    (changed: typeof bank) => { changed.slots[0].quarantine!.objectiveSha256 = digest('different goal'); },
    (changed: typeof bank) => { changed.slots[0].quarantine!.failureCode = 'NETWORK_FAILURE' as 'PREMISE_UNSUPPORTED'; },
    (changed: typeof bank) => { changed.slots[0].quarantine!.validationAttempts = 1 as 2; },
    (changed: typeof bank) => { changed.slots[0].quarantine!.quarantinedAt = 'invalid'; },
  ];
  const sessionPlan = createSessionQuestionPlan(context, bank, { sessionSeed: 'tamper-check' });
  for (const edit of edits) {
    const changed = structuredClone(bank); edit(changed);
    const { contentSha256: oldHash, ...body } = changed; assert.ok(oldHash);
    changed.contentSha256 = digest(JSON.stringify(stable(body)));
    await writeFile(file, JSON.stringify(changed));
    assert.equal(await loadQuestionBank(context, options), null);
    assert.equal(await loadQuestionBankByPinnedPlan(context, { ...sessionPlan, poolContentSha256: changed.contentSha256 }, fixture), null);
  }
});

test('a bounded live preparation budget persists approved candidates and resumes without replaying their provider work', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders();
  plan.purpose = 'candidate_pool'; plan.scheduling = 'time_based';
  const options = { ...fixture, plan, environment, providers: fake.providers, maxNewCandidates: 1 };
  await assert.rejects(prepareQuestionBank(context, options), error => error instanceof Error && error.name === 'QuestionPreparationBudgetError');
  assert.equal(await loadQuestionBank(context, options), null);
  assert.equal(fake.counts().generated, 1); assert.equal(fake.counts().synthesized, 1);
  const ready = await prepareQuestionBank(context, options);
  assert.equal(ready.status, 'ready');
  assert.equal(fake.counts().generated, 2); assert.equal(fake.counts().synthesized, 2);
});

test('an interrupted partial bank is unavailable at runtime and resumes only the exact verified durable candidates', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders(), options = { ...fixture, plan, environment, providers: fake.providers };
  fake.controls.failSlot = 'main-slot-2';
  await assert.rejects(prepareQuestionBank(context, options), /synthetic interruption/);
  assert.equal(await loadQuestionBank(context, options), null);
  assert.ok((await readdir(path.join(fixture.root, 'data/prepared/question-banks'))).some(file => file.endsWith('.partial.json')));
  const before = fake.counts(); fake.controls.failSlot = null;
  const bank = await prepareQuestionBank(context, options);
  assert.ok(bank.slots.every(row => row.candidates.length === 2));
  assert.equal(fake.counts().generated - before.generated, 2);
  assert.equal(fake.counts().synthesized - before.synthesized, 2);
});

test('bad premise hashes, wrong voice/audio hashes and duplicate alternatives never publish a runtime bank', async t => {
  for (const invalid of ['invalidAudit', 'invalidAudio', 'duplicate'] as const) await t.test(invalid, async child => {
    const fixture = await temporary(); child.after(fixture.close);
    const { context, plan } = input(), fake = fakeProviders(); fake.controls[invalid] = true;
    const options = { ...fixture, plan, environment, providers: fake.providers };
    await assert.rejects(prepareQuestionBank(context, options));
    assert.equal(await loadQuestionBank(context, options), null);
  });
});

test('changed speech bytes invalidate a complete bank and preparation repairs only that candidate', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders(), options = { ...fixture, plan, environment, providers: fake.providers };
  const bank = await prepareQuestionBank(context, options), broken = bank.slots[1].candidates[1];
  await writeFile(path.join(fixture.root, 'data/audio', `${broken.speechHash}.mp3`), 'damaged bytes');
  assert.equal(await loadQuestionBank(context, options), null);
  const before = fake.counts(); const repaired = await prepareQuestionBank(context, options);
  assert.equal(fake.counts().generated - before.generated, 1);
  assert.equal(fake.counts().synthesized - before.synthesized, 1);
  assert.equal(digest((await readFile(path.join(fixture.root, 'data/audio', `${broken.speechHash}.mp3`))).toString()), repaired.slots[1].candidates[1].audioSha256);
});

test('a changed verified activity extraction invalidates old questions even when the PDF and plan stay the same', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders(), options = { ...fixture, plan, environment, providers: fake.providers };
  const extraction = { units: context.student.evidence.map(source => ({ sourceId: source.id, ...Object.fromEntries(activityFields.map(field => [field, []])), recordedContext: [source.text] })) };
  const first = buildPreparedActivities(context, extraction, { model: preparedActivitiesModel(), generatedAt: '2026-11-02T00:00:00.000Z' });
  await savePreparedActivities(first, context, fixture.root);
  const bank = await prepareQuestionBank(context, options);
  assert.equal(bank.activitiesContentSha256, first.contentSha256);
  const second = buildPreparedActivities(context, extraction, { model: preparedActivitiesModel(), generatedAt: '2026-11-02T00:00:01.000Z' });
  await savePreparedActivities(second, context, fixture.root);
  assert.equal(await loadQuestionBank(context, options), null);
  const before = fake.counts(), rebuilt = await prepareQuestionBank(context, options);
  assert.equal(rebuilt.activitiesContentSha256, second.contentSha256);
  assert.equal(fake.counts().generated - before.generated, 4);
});

function modernInput() {
  const setup = input(), context = setup.context;
  const questions = [
    syntheticReferenceQuestion('자료를 비교한 과정은 무엇인가요?', { id: 'modern-process-question', sourcePath: 'modern-process-book.md', primaryFunctions: ['PROCESS'], strategies: ['process'] }),
    syntheticReferenceQuestion('자료를 선택한 기준은 무엇인가요?', { id: 'modern-choice-question', sourcePath: 'modern-choice-book.md', primaryFunctions: ['CHOICE'], strategies: ['choice_basis'] }),
  ];
  const corpus = syntheticReferenceCorpus(questions, 'modern-bank-contracts');
  context.questionReferences = corpus;
  context.manifest.questionReferenceCatalog = { schemaVersion: corpus.schemaVersion, policyVersion: corpus.policyVersion, digest: corpus.digest, sourceHashes: corpus.sourceHashes, figuresDirectory: corpus.figuresDirectory, eligibleQuestions: 2, excludedQuestions: 0, runtimeApprovedQuestions: 2, analysis: corpus.analysis, purpose: 'wording_reference_only' };
  const records: QuestionStrategyRecord[] = questions.map((question, index) => ({ questionId: question.id, questionSha256: digest(question.rawText), sourceSha256: question.source.sha256, status: 'ready', profile: { questionId: question.id, operations: [index === 0 ? 'process' : 'choice_basis'], trigger: index === 0 ? 'method' : 'choice', requiredClaimSlots: ['actual_answer'], expectedEvidence: index === 0 ? 'one_step' : 'reason', anchorMode: 'none', directness: 'direct', relation: { kind: 'unknown', targetQuestionId: null, condition: 'none', supportQuote: null } }, relation: { kind: 'unknown', targetQuestionId: null, condition: 'none', evidenceRef: null } }));
  const cards: QuestionStrategyCard[] = questions.map((question, index) => ({ id: `modern-card-${index}`, questionId: question.id, operation: index === 0 ? 'process' : 'choice_basis', primaryFunctions: [index === 0 ? 'PROCESS' : 'CHOICE'], depth: 'D2', assessmentTarget: index === 0 ? '실제 수행 과정' : '실제 선택 기준', trigger: index === 0 ? 'method' : 'choice', triggerDescription: '실제 답변에서 해당 확인 지점을 살펴보는 합성 전략', requiredClaimSlots: ['actual_answer'], notApplicableWhen: [], expectedEvidence: [index === 0 ? '실제로 수행한 한 단계' : '선택의 기준 한 가지'], prohibitedPresuppositions: ['책의 학생 사실을 현재 학생 사실로 사용하지 않는다.'], surface: { anchorMode: 'none', directness: 'direct', cognitiveDemandCount: 1 }, sourceBindings: [{ questionId: question.id, path: question.source.path, sha256: question.source.sha256, questionSha256: digest(question.rawText), startOffset: question.source.startOffset, endOffset: question.source.endOffset }], relations: [{ kind: 'unknown', targetQuestionId: null, condition: 'none', evidenceRef: null }] }));
  const catalogBody: Omit<QuestionStrategyCatalog, 'contentSha256'> = { schemaVersion: 'question-strategy-catalog-v1', policyVersion: 'source-bound-abstract-strategies-v1', key: digest('modern-strategy-key'), corpusDigest: corpus.digest, analysisKey: corpus.analysis!.key, sourceFingerprint: digest(JSON.stringify(corpus.sourceHashes)), model: 'explicit-synthetic-strategy-extractor', generatedAt: '2026-11-03T00:00:00.000Z', records, cards, coverage: { total: 2, ready: 2, restricted: 0, pending: 0, complete: true, sourceBound: true, relationCounts: { answer_conditioned: 0, same_activity_deeper: 0, related_concept: 0, topic_transition: 0, unknown: 2 } }, interpretation: 'STRATEGY_AND_SURFACE_REFERENCE_NOT_STUDENT_FACTS' };
  context.questionStrategies = { ...catalogBody, contentSha256: digest(JSON.stringify(catalogBody)) };
  const policyBody: Omit<InterviewerPolicyPack, 'contentSha256'> = { version: INTERVIEWER_POLICY_VERSION, sourceFiles: [{ role: 'question', path: 'synthetic-question-guideline.md', version: '2.3', sha256: digest('explicit synthetic policy source') }], rules: [{ id: 'SYNTHETIC_TARGET_FIRST', requirement: 'required', precedence: 100, source: { role: 'question', path: 'synthetic-question-guideline.md', version: '2.3', sha256: digest('explicit synthetic policy source'), clause: '합성 제1조', startLine: 1, endLine: 1, quote: '합성 정책은 실제 사용자·모델 자료가 아니다.' }, instruction: '원문 근거에서 단일 확인 대상을 정한다.', guards: ['QuestionBlueprint'], regressions: ['prepared-question-bank.test.ts'] }], userOverrides: [] };
  context.interviewerPolicy = { ...policyBody, contentSha256: digest(JSON.stringify(policyBody)) };
  syncModernManifest(context);
  return setup;
}

function syncModernManifest(context: InterviewContext) {
  if (context.interviewerPolicy) context.manifest.interviewerPolicy = { version: context.interviewerPolicy.version, contentSha256: context.interviewerPolicy.contentSha256, sourceFiles: context.interviewerPolicy.sourceFiles };
  if (context.questionStrategies) context.manifest.questionStrategyCatalog = { version: context.questionStrategies.schemaVersion, key: context.questionStrategies.key, contentSha256: context.questionStrategies.contentSha256, coverage: context.questionStrategies.coverage };
}

type ModernTamper = 'missing_contract' | 'contract_hash' | 'spoken_after_approval' | 'wrong_policy' | 'wrong_catalog' | 'unknown_candidate' | 'unknown_selected' | 'selection_outside_candidates' | 'wrong_question_provenance' | 'blueprint_strategy_mismatch';
function modernProviders(tamper?: ModernTamper, providedCandidatesOnly = false) {
  const fake = fakeProviders();
  const providers: QuestionBankProviders = { ...fake.providers, async generate(context, session, excluded) {
    const draft = await fake.providers.generate(context, session, excluded);
    const catalog = context.questionStrategies!, card = catalog.cards.find(item => item.primaryFunctions.includes(draft.primaryFunction))!;
    const offered = providedCandidatesOnly ? catalog.cards : [card], sourceQuestionIds = [...new Set(offered.map(item => item.questionId))];
    draft.questionReferenceContext = { schemaVersion: context.questionReferences!.schemaVersion, catalogSha256: context.questionReferences!.digest, exampleIds: sourceQuestionIds, purpose: 'wording_reference_only', analysisKey: context.questionReferences!.analysis!.key, referenceUses: sourceQuestionIds.map(id => ({ id, usage: 'direct_example' })) };
    draft.strategyTrace = { catalogDigest: catalog.contentSha256, candidateCardIds: offered.map(item => item.id), selectedCardId: providedCandidatesOnly ? null : card.id, sourceQuestionIds, policyVersion: 'explicit-synthetic-target-first', selectionReason: providedCandidatesOnly ? '합성 전략 후보를 제공했으며 선택하지 않은 카드를 선택했다고 기록하지 않는다.' : '합성 질문 목적과 같은 기능의 참고 전략을 사용한다.' };
    const blueprint = createQuestionBlueprint(draft, context, session, { strategyIds: offered.map(item => item.id) });
    draft.questionBlueprint = blueprint;
    draft.approvedQuestion = approveQuestionContract(draft, blueprint, { policyDigest: context.interviewerPolicy!.contentSha256, strategyCatalogDigest: catalog.contentSha256 });
    if (tamper === 'missing_contract') delete draft.approvedQuestion;
    if (tamper === 'contract_hash') draft.approvedQuestion = { ...draft.approvedQuestion!, contentSha256: digest('forged contract') };
    if (tamper === 'spoken_after_approval') { draft.questionText = draft.questionText.replace('무엇인가요', '어떤 내용인가요').replace('진행했나요', '수행했나요'); draft.premiseValidation = { ...draft.premiseValidation!, questionSha256: digest(draft.questionText) }; }
    if (tamper === 'wrong_policy') draft.approvedQuestion = { ...draft.approvedQuestion!, policyDigest: digest('different policy') };
    if (tamper === 'wrong_catalog') draft.strategyTrace.catalogDigest = digest('different catalog');
    if (tamper === 'unknown_candidate') draft.strategyTrace.candidateCardIds = ['nonexistent-card'];
    if (tamper === 'unknown_selected') draft.strategyTrace.selectedCardId = 'nonexistent-card';
    if (tamper === 'selection_outside_candidates') draft.strategyTrace.candidateCardIds = catalog.cards.filter(item => item.id !== card.id).map(item => item.id);
    if (tamper === 'wrong_question_provenance') draft.strategyTrace.sourceQuestionIds = ['nonexistent-book-question'];
    if (tamper === 'blueprint_strategy_mismatch') {
      const changed = { ...structuredClone(blueprint), strategyIds: catalog.cards.filter(item => item.id !== card.id).map(item => item.id) };
      draft.questionBlueprint = changed;
      draft.approvedQuestion = approveQuestionContract(draft, changed, { policyDigest: context.interviewerPolicy!.contentSha256, strategyCatalogDigest: catalog.contentSha256 });
    }
    return draft;
  } };
  return { ...fake, providers };
}

test('target-first policy, full strategy catalog and immutable question contracts survive bank publication and a zero-provider cache load', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = modernInput(), fake = modernProviders();
  const options = { ...fixture, plan, environment, providers: fake.providers };
  const bank = await prepareQuestionBank(context, options);
  assert.equal(bank.slots.flatMap(slot => slot.candidates).length, 4);
  for (const candidate of bank.slots.flatMap(slot => slot.candidates)) {
    const draft = candidate.draft;
    assert.doesNotThrow(() => assertQuestionContractIntegrity(draft, draft.approvedQuestion!));
    assert.equal(draft.approvedQuestion!.validation.independentSemanticReview, true);
    assert.equal(draft.approvedQuestion!.policyDigest, context.interviewerPolicy!.contentSha256);
    assert.equal(draft.approvedQuestion!.strategyCatalogDigest, context.questionStrategies!.contentSha256);
    assert.deepEqual(draft.questionBlueprint!.strategyIds, [draft.strategyTrace!.selectedCardId]);
    assert.deepEqual(draft.questionReferenceContext!.exampleIds, draft.strategyTrace!.sourceQuestionIds);
    assert.ok(draft.evidenceIds.every(id => id.startsWith('fixture-e')));
  }
  const before = fake.counts(), cached = await loadQuestionBank(context, options);
  assert.ok(cached); assert.deepEqual(fake.counts(), before);
  const session = { plan, target: context.target, turns: [] } as unknown as InterviewSession;
  const selected = selectPreparedMainQuestion(cached!, session, 1)!;
  assert.doesNotThrow(() => assertQuestionContractIntegrity(selected.draft, selected.draft.approvedQuestion!));
  assert.notEqual(selected.draft, cached!.slots[0].candidates[0].draft);
});

test('policy and strategy content changes invalidate Q0 caches independently of unchanged PDF bytes and plan', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = modernInput(), fake = modernProviders(), options = { ...fixture, plan, environment, providers: fake.providers };
  await prepareQuestionBank(context, options);
  const original = questionBankIdentity(context, options);
  const policyChanged = structuredClone(context);
  policyChanged.interviewerPolicy!.rules[0].instruction += ' 실제 질문의 요구를 고정한다.';
  const { contentSha256: oldPolicyHash, ...policyBody } = policyChanged.interviewerPolicy!;
  assert.ok(oldPolicyHash);
  policyChanged.interviewerPolicy!.contentSha256 = digest(JSON.stringify(policyBody)); syncModernManifest(policyChanged);
  assert.notEqual(questionBankIdentity(policyChanged, options).key, original.key);
  assert.equal(questionBankIdentity(policyChanged, options).sourceFingerprint, original.sourceFingerprint);
  assert.equal(await loadQuestionBank(policyChanged, options), null);
  const strategyChanged = structuredClone(context);
  strategyChanged.questionStrategies!.cards[0].surface.anchorMode = 'short_context';
  strategyChanged.questionStrategies!.records[0].profile!.anchorMode = 'short_context';
  const { contentSha256: oldStrategyHash, ...strategyBody } = strategyChanged.questionStrategies!;
  assert.ok(oldStrategyHash);
  strategyChanged.questionStrategies!.contentSha256 = digest(JSON.stringify(strategyBody)); syncModernManifest(strategyChanged);
  assert.notEqual(questionBankIdentity(strategyChanged, options).key, original.key);
  assert.equal(questionBankIdentity(strategyChanged, options).sourceFingerprint, original.sourceFingerprint);
  assert.equal(await loadQuestionBank(strategyChanged, options), null);
});

test('Q0 can retain several offered strategy references without inventing a model-selected card', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = modernInput(), fake = modernProviders(undefined, true), options = { ...fixture, plan, environment, providers: fake.providers };
  const bank = await prepareQuestionBank(context, options);
  for (const candidate of bank.slots.flatMap(slot => slot.candidates)) {
    assert.equal(candidate.draft.strategyTrace!.selectedCardId, null);
    assert.equal(candidate.draft.strategyTrace!.candidateCardIds.length, 2);
    assert.deepEqual(candidate.draft.questionBlueprint!.strategyIds, candidate.draft.strategyTrace!.candidateCardIds);
    assert.deepEqual(candidate.draft.questionReferenceContext!.exampleIds, candidate.draft.strategyTrace!.sourceQuestionIds);
  }
  const before = fake.counts(); assert.ok(await loadQuestionBank(context, options)); assert.deepEqual(fake.counts(), before);
});

test('forged target-first contracts, changed spoken text and false strategy provenance cannot publish Q0 candidates', async t => {
  for (const tamper of ['missing_contract', 'contract_hash', 'spoken_after_approval', 'wrong_policy', 'wrong_catalog', 'unknown_candidate', 'unknown_selected', 'selection_outside_candidates', 'wrong_question_provenance', 'blueprint_strategy_mismatch'] as const) await t.test(tamper, async child => {
    const fixture = await temporary(); child.after(fixture.close);
    const { context, plan } = modernInput(), fake = modernProviders(tamper), options = { ...fixture, plan, environment, providers: fake.providers };
    await assert.rejects(prepareQuestionBank(context, options));
    assert.equal(await loadQuestionBank(context, options), null);
  });
});

test('a manifest-declared policy or strategy catalog must be present, complete and matching before providers run', async t => {
  for (const broken of ['policy_missing', 'policy_mismatch', 'catalog_missing', 'catalog_mismatch', 'catalog_incomplete'] as const) await t.test(broken, async child => {
    const fixture = await temporary(); child.after(fixture.close);
    const { context, plan } = modernInput(), fake = modernProviders(), options = { ...fixture, plan, environment, providers: fake.providers };
    if (broken === 'policy_missing') context.interviewerPolicy = null;
    if (broken === 'policy_mismatch') context.manifest.interviewerPolicy!.contentSha256 = digest('mismatched policy manifest');
    if (broken === 'catalog_missing') context.questionStrategies = null;
    if (broken === 'catalog_mismatch') context.manifest.questionStrategyCatalog!.contentSha256 = digest('mismatched strategy manifest');
    if (broken === 'catalog_incomplete') { context.questionStrategies!.coverage.complete = false; context.questionStrategies!.coverage.pending = 1; context.questionStrategies!.coverage.ready = 1; syncModernManifest(context); }
    await assert.rejects(prepareQuestionBank(context, options));
    assert.deepEqual(fake.counts(), { generated: 0, synthesized: 0, maxActive: 0 });
  });
});

test('an explicit new bank revision revalidates and reuses unchanged objective audio without mutating its donor', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders();
  const old = await prepareQuestionBank(context, { ...fixture, plan, environment, providers: fake.providers });
  const before = fake.counts(), oldFile = path.join(fixture.root, 'data/prepared/question-banks', `${old.key}.json`), originalBytes = await readFile(oldFile, 'utf8');
  const next = structuredClone(context);
  next.manifest.files[0].sha256 = digest('new verified source-envelope revision, same exact evidence');
  const current = await prepareQuestionBank(next, { ...fixture, plan, environment, providers: fake.providers, reuseFromBankKey: old.key, maxNewCandidates: 0 });
  assert.notEqual(current.key, old.key);
  assert.deepEqual(fake.counts(), before, 'unchanged exact source/semantic/voice validators permit reuse, not generation');
  assert.equal(await readFile(oldFile, 'utf8'), originalBytes);
  assert.ok(await loadQuestionBank(next, { ...fixture, plan, environment }));
  const wrongVoice = { ...environment, CLOVA_VOICE_PITCH: '2' };
  await assert.rejects(prepareQuestionBank(next, { ...fixture, plan, environment: wrongVoice, providers: fake.providers, reuseFromBankKey: old.key, maxNewCandidates: 0 }));
});

test('a new independent contract rejection quarantines its exact objective without fabricating two generation attempts', async t => {
  const fixture = await temporary(); t.after(fixture.close);
  const { context, plan } = input(), fake = fakeProviders();
  const pool = { ...plan, purpose: 'candidate_pool' as const };
  const old = await prepareQuestionBank(context, { ...fixture, plan: pool, environment, providers: fake.providers });
  const before = fake.counts();
  const changed = structuredClone(context);
  changed.manifest.recordIds.targetAnalysisContentSha256 = digest('new exact independently reviewed contract revision');
  changed.targetAnalysis = { objectiveContractRevision: { version: 'independently-reviewed-objective-contract-v1', parentRevision: 'synthetic-parent', parentContentSha256: digest('parent'), reviewArtifactSha256: digest('explicit rejected independent review'), reviewModel: 'synthetic-review', reviewedAt: new Date().toISOString(), changedObjectiveIds: [], blockedObjectives: [{ objectiveId: pool.slots[0].id, failureCode: 'PREMISE_UNSUPPORTED' }] } } as unknown as NonNullable<InterviewContext['targetAnalysis']>;
  const bank = await prepareQuestionBank(changed, { ...fixture, plan: pool, environment, providers: fake.providers, reuseFromBankKey: old.key, maxNewCandidates: 0 });
  assert.deepEqual(bank.slots.map(slot => slot.candidates.length), [0, 1]);
  assert.equal(bank.slots[0].quarantine?.validationAttempts, 1);
  assert.equal(bank.slots[0].quarantine?.independentReaudit?.reviewArtifactSha256, digest('explicit rejected independent review'));
  assert.deepEqual(fake.counts(), before);
  assert.ok(await loadQuestionBank(changed, { ...fixture, plan: pool, environment }));
});
