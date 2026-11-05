/** Source-root independent signed evaluation integration. Synthetic inputs only. */
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { InterviewSession } from '../server/protocol';
import type { InterviewContext } from '../server/data/load-interview-context';

const controlledAt = '2026-11-06T03:00:00.000Z';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function main() {
  const flags = new Map(process.argv.slice(2).map(value => { const match = /^--(source-root|output|natural|reopen-root|session-id|owner-id)=(.+)$/u.exec(value); if (!match) throw new Error('PR06D_INTEGRATION_FLAGS_INVALID'); return [match[1], match[2]]; }));
  assert.ok(flags.has('source-root') && flags.has('output'));
  const sourceRoot = path.resolve(flags.get('source-root')!), output = path.resolve(flags.get('output')!), natural = flags.get('natural') === 'true';
  const moduleFiles = ['tests/fixtures/evaluation-supply.ts', 'tests/fixtures/runtime-context.ts', 'tests/fixtures/reviewed-evaluation-knowledge.ts', 'tests/fixtures/evaluation-v4-compatibility.ts',
    'server/evaluation-job-store.ts', 'server/evaluation-worker.ts', 'server/evaluation-supply.ts', 'server/reviewed-evaluation-queue.ts', 'server/evaluation-revisions.ts', 'server/evaluation-history.ts', 'server/data/evaluation-scope-registry.ts', 'server/data/reviewed-evaluation-context.ts'];
  const hashes = async () => Object.fromEntries(await Promise.all(moduleFiles.map(async file => [file, sha(await readFile(path.join(sourceRoot, file)))])));
  const sourceSha256 = await hashes(), fixtureSha256 = sha(await readFile(new URL(import.meta.url)));
  const originalDate = Date, originalFetch = globalThis.fetch, nativeCrypto = createRequire(import.meta.url)('node:crypto');
  const originalUUID = nativeCrypto.randomUUID; let uuidCounter = 0, networkCalls = 0;
  if (!natural) {
    class ControlledDate extends originalDate { constructor(value: string | number = controlledAt) { super(value); } static now() { return originalDate.parse(controlledAt); } }
    globalThis.Date = ControlledDate as DateConstructor;
    nativeCrypto.randomUUID = () => `06000000-0000-4000-8000-${String(++uuidCounter).padStart(12, '0')}`;
    syncBuiltinESMExports();
  }
  globalThis.fetch = async () => { networkCalls++; throw new Error('PR06D_REAL_NETWORK_FORBIDDEN'); };
  const load = (file: string) => import(pathToFileURL(path.join(sourceRoot, file)).href);
  const fixture = await load('tests/fixtures/evaluation-supply.ts') as typeof import('../tests/fixtures/evaluation-supply');
  const supply = await load('server/evaluation-supply.ts') as typeof import('../server/evaluation-supply');
  const registryApi = await load('server/data/evaluation-scope-registry.ts') as typeof import('../server/data/evaluation-scope-registry');
  const jobApi = await load('server/evaluation-job-store.ts') as typeof import('../server/evaluation-job-store');
  const sessionApi = await load('server/storage/local-session-store.ts') as typeof import('../server/storage/local-session-store');
  const worker = await load('server/evaluation-worker.ts') as typeof import('../server/evaluation-worker');
  const revisions = await load('server/evaluation-revisions.ts') as typeof import('../server/evaluation-revisions');
  const queue = await load('server/reviewed-evaluation-queue.ts') as typeof import('../server/reviewed-evaluation-queue');
  const history = await load('server/evaluation-history.ts') as typeof import('../server/evaluation-history');
  const inputApi = await load('server/providers/evaluation-input.ts') as typeof import('../server/providers/evaluation-input');
  const turnsApi = await load('server/providers/evaluation-turns.ts') as typeof import('../server/providers/evaluation-turns');
  const runtime = await load('server/session-runtime.ts') as typeof import('../server/session-runtime');
  const knowledge = await load('server/data/approved-knowledge.ts') as typeof import('../server/data/approved-knowledge');
  const model = await load('server/providers/openai.ts') as typeof import('../server/providers/openai');
  const v4 = await load('tests/fixtures/evaluation-v4-compatibility.ts') as typeof import('../tests/fixtures/evaluation-v4-compatibility');
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 6)]), type: 'pkcs8', format: 'der' });
  const trustedPublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const signed = <T extends object>(payload: T) => ({ ...payload, signature: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64') });
  const previousKey = process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY; process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY = trustedPublicKey;
  const issuedAt = () => new Date(Date.now() - 1000).toISOString(), expiresAt = () => new Date(Date.now() + 60_000).toISOString();
  const cases: Array<{ id: string; observations: unknown; files: unknown }> = [];
  const tempRoots: string[] = [];
  const snapshotFiles = async (root: string) => {
    const files: Array<{ file: string; bytes: number; sha256: string; text: string }> = [];
    const visit = async (directory: string) => { let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await visit(file); else if (entry.isFile()) { const bytes = await readFile(file); files.push({ file: path.relative(root, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes), text: bytes.toString('utf8') }); } } };
    await visit(path.join(root, 'data')); return files;
  };
  async function rejection(action: () => unknown | Promise<unknown>) { try { await action(); throw new Error('PR06D_EXPECTED_REJECTION'); } catch (error) { const item = error as Error & { code?: string }; if (item.message === 'PR06D_EXPECTED_REJECTION') throw error; return { name: item.name, code: item.code ?? null, message: item.message }; } }
  async function setup(options: { followUp?: boolean; publish?: boolean } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pr06d-signed-')); tempRoots.push(root);
    const value = await fixture.evaluationSupplyFixture({ followUp: options.followUp }), registry = fixture.reviewedSupplyRegistry(value);
    value.context.evaluationScopeRegistry = registry; fixture.pinSupplySnapshot(value.context, value.session);
    const proposal = supply.prepareEndedSessionReview(value.context, value.session, registry), bundle = fixture.supplyRecordBundle(value.session, options.followUp ? [value.turn] : value.session.turns);
    const receiptPayload = { version: 'authenticated-session-evaluation-review-v1', actorId: fixture.supplyReviewer, action: 'approve_session_evaluation',
      proposalSha256: proposal.contentSha256, bundleSha256: bundle.contentSha256, sessionId: value.session.id,
      sessionQuestionAnswerSha256: knowledge.knowledgeSessionQuestionAnswerHash(value.session), contextSnapshotSha256: value.session.runtime!.contextSnapshotSha256, issuedAt: issuedAt(), expiresAt: expiresAt() };
    const receipt = signed(receiptPayload);
    const registryReceipt = (digest: string) => signed({ version: 'authenticated-bank-scope-review-v1', actorId: fixture.supplyReviewer, registrySha256: digest, action: 'publish_scopes', issuedAt: issuedAt(), expiresAt: expiresAt() });
    if (options.publish !== false) await registryApi.publishBankScopeReview(registry, value.context, value.bank, registryReceipt(registry.contentSha256), null, root, trustedPublicKey);
    const sessions = new sessionApi.LocalSessionStore(path.join(root, 'data/sessions')), jobs = new jobApi.EvaluationJobStore(path.join(root, 'data/evaluation-jobs'));
    await sessions.saveContext(value.context, value.session.runtime!.owner.id); await sessions.save(value.session);
    const originalFile = path.join(root, 'data/sessions', `${value.session.id}.json`), originalBytes = await readFile(originalFile), originalContext = JSON.stringify(value.context), originalSession = JSON.stringify(value.session);
    const args = { ...value, root, proposal, bundle, receipt, trustedPublicKey, currentRegistry: registry, enqueue: true, model: 'pr06d-explicit-synthetic-model' };
    const readOptions = { root, session: value.session, ownerId: value.session.runtime!.owner.id, jobs, sessions, trustedPublicKey };
    const unchanged = async () => { assert.deepEqual(await readFile(originalFile), originalBytes); assert.equal(JSON.stringify(value.context), originalContext); assert.equal(JSON.stringify(value.session), originalSession); return { originalSessionFileSha256: sha(originalBytes), contextJsonSha256: sha(originalContext), frozenInputSha256: history.evaluationFrozenInputHash(value.session), sessionJsonSha256: sha(originalSession) }; };
    const withdraw = async () => { const { contentSha256: ignored, ...body } = structuredClone(registry); void ignored; body.entries[0].review = { status: 'withdrawn', authority: 'explicit_reviewed_input', approverId: fixture.supplyReviewer, reviewedAt: new Date().toISOString(), reason: 'PR06D explicit synthetic withdrawal.' }; const withdrawn = registryApi.sealBankScopeRegistry(body); await registryApi.publishBankScopeReview(withdrawn, value.context, value.bank, registryReceipt(withdrawn.contentSha256), registry.contentSha256, root, trustedPublicKey); return withdrawn; };
    return { ...value, root, registry, proposal, bundle, receipt, receiptPayload, registryReceipt, sessions, jobs, args, readOptions, unchanged, withdraw };
  }
  async function record(id: string, value: Awaited<ReturnType<typeof setup>>, observations: unknown) { cases.push({ id, observations: { data: observations, preserved: await value.unchanged(), contractBytes: {
    registryJsonSha256: sha(JSON.stringify(value.registry)), registryContentSha256: value.registry.contentSha256,
    proposalJsonSha256: sha(JSON.stringify(value.proposal)), proposalContentSha256: value.proposal.contentSha256,
    bundleJsonSha256: sha(JSON.stringify(value.bundle)), bundleContentSha256: value.bundle.contentSha256,
    receiptJsonSha256: sha(JSON.stringify(value.receipt)), receiptSignaturePreimage: JSON.stringify(value.receiptPayload),
    receiptSignaturePreimageUtf8Sha256: sha(JSON.stringify(value.receiptPayload)), signatureBase64: value.receipt.signature,
  } }, files: await snapshotFiles(value.root) }); }
  function outputFor(session: InterviewSession) { return { summary: 'PR06D 실제 gate를 통과한 합성 평가', languageClassifications: [], answers: turnsApi.buildEvaluationUnits(session).scoredUnits.map(unit => { const axis = { anchor: 4, quote: unit.answerAttempts[0].rawTranscript, rationale: '확정된 합성 답변 안에서 실제 요구만 판단한다.' }; return { turnId: unit.turn.id, status: 'SATISFIED', deferredReason: null, axes: { I: axis, A: axis, S: axis, R: axis, C: axis }, verifiedCoreError: false, verifiedCoreErrorEvidence: null, strengths: [], improvements: [], conflictNeedsReview: [], deliveryCoaching: [], strategyCoaching: [] }; }) }; }
  async function evaluate(value: Awaited<ReturnType<typeof setup>>, during?: () => Promise<unknown>) {
    let providerCalls = 0; const submittedInputs: unknown[] = [];
    const result = await worker.runEvaluationWorkerOnce({ jobs: value.jobs, sessions: value.sessions, workerId: 'pr06d-synthetic-worker',
      evaluate: (context, session, options) => model.evaluateSession(context, session, { ...options, requestEvaluation: async request => { providerCalls++; const input = JSON.parse(request.input); submittedInputs.push(input); if (during) await during(); const output = outputFor(session); output.answers = output.answers.filter(answer => input.answers.some((item: { id: string }) => item.id === answer.turnId)); return output; } }) });
    return { result, providerCalls, submittedInputs };
  }
  try {
    if (flags.has('reopen-root')) {
      const root = path.resolve(flags.get('reopen-root')!); assert.ok(path.basename(root).startsWith('pr06d-signed-'));
      const sessions = new sessionApi.LocalSessionStore(path.join(root, 'data/sessions')), jobs = new jobApi.EvaluationJobStore(path.join(root, 'data/evaluation-jobs'));
      const session = await sessions.load(flags.get('session-id')!, flags.get('owner-id')!); assert.ok(session);
      const filesBefore = await snapshotFiles(root), view = await revisions.loadReviewedEvaluationRevision({ root, session, ownerId: flags.get('owner-id')!, sessions, jobs, trustedPublicKey }); assert.equal(view?.status, 'completed');
      const job = (await jobs.get(view.jobId))!, snapshot = await jobs.snapshot(job), result = await jobs.result(job); assert.deepEqual(await snapshotFiles(root), filesBefore); assert.equal(networkCalls, 0);
      await writeFile(output, JSON.stringify({ pid: process.pid, view, job, snapshot, result, dataFilesSha256: sha(JSON.stringify(filesBefore)), realProviderCalls: networkCalls })); return;
    }
    if (natural) {
      const value = await setup(); await record('natural-input-observation', value, { createdAt: new Date().toISOString(), sessionId: value.session.id, turnId: value.turn.id, answerId: value.turn.answerId, registrySha256: value.registry.contentSha256, receipt: value.receipt, proposalSha256: value.proposal.contentSha256 });
    } else {
      for (const missing of ['A', 'B'] as const) {
        const value = await setup({ publish: missing !== 'A' });
        const error = missing === 'A' ? await rejection(() => supply.supplyReviewedSessionEvaluation({ ...value.args, currentRegistry: undefined })) : await rejection(() => supply.supplyReviewedSessionEvaluation({ ...value.args, receipt: null }));
        const job = await value.jobs.enqueue(value.session, inputApi.evaluationSessionSourceFingerprint(value.context, value.session, 'pr06d-unapproved'), inputApi.EVALUATION_PIPELINE_VERSION, Date.now(), 'pr06d-unapproved');
        const worked = await evaluate(value); assert.equal(worked.providerCalls, 0); assert.equal(worked.result.job?.status, 'review_required'); assert.equal(worked.result.job?.id, job.id);
        await record(`missing-${missing}-never-model`, value, { error, worked });
      }
      {
        const value = await setup(), supplied = await supply.supplyReviewedSessionEvaluation(value.args), repeated = await supply.supplyReviewedSessionEvaluation(value.args);
        assert.equal(repeated.jobId, supplied.jobId); const pending = await revisions.loadReviewedEvaluationRevision(value.readOptions); assert.equal(pending?.status, 'pending');
        const worked = await evaluate(value); assert.equal(worked.providerCalls, 1); assert.equal(worked.result.job?.status, 'completed');
        const completed = await revisions.loadReviewedEvaluationRevision(value.readOptions); assert.equal(completed?.status, 'completed');
        const reopenOutput = path.join(value.root, 'reopened.json');
        await promisify(execFile)(process.execPath, ['--import', pathToFileURL(path.join(sourceRoot, 'node_modules/tsx/dist/loader.mjs')).href, fileURLToPath(import.meta.url), `--source-root=${sourceRoot}`, `--output=${reopenOutput}`, `--reopen-root=${value.root}`, `--session-id=${value.session.id}`, `--owner-id=${value.session.runtime!.owner.id}`], { cwd: os.tmpdir(), maxBuffer: 1024 * 1024 });
        const reopened = JSON.parse(await readFile(reopenOutput, 'utf8')), childProcessWasDifferent = reopened.pid !== process.pid; assert.equal(childProcessWasDifferent, true); delete reopened.pid; assert.deepEqual(reopened.view, completed); assert.equal(reopened.dataFilesSha256, sha(JSON.stringify(await snapshotFiles(value.root))));
        const tamperErrors = [];
        for (const kind of ['snapshot', 'result'] as const) { const file = path.join(value.jobs.directory, `${supplied.jobId}.${kind}.json`), bytes = await readFile(file), changed = JSON.parse(bytes.toString()); if (kind === 'snapshot') changed.session.turns[0].rawTranscript += ' tampered'; else changed.evaluation.summary += ' tampered'; await writeFile(file, JSON.stringify(changed)); const error = await rejection(() => revisions.loadReviewedEvaluationRevision(value.readOptions)); await writeFile(file, bytes); tamperErrors.push({ kind, error }); }
        await record('signed-A-B-real-worker-revision-duplicate', value, { supplied, repeated, pending, worked, completed, reopened, childProcessWasDifferent, tamperErrors });
      }
      for (const when of ['before-provider', 'during-provider', 'after-complete'] as const) {
        const value = await setup(), supplied = await supply.supplyReviewedSessionEvaluation(value.args);
        if (when === 'before-provider') await value.withdraw(); const worked = await evaluate(value, when === 'during-provider' ? value.withdraw : undefined);
        assert.equal(worked.providerCalls, when === 'before-provider' ? 0 : 1); assert.equal(worked.result.job?.status, when === 'after-complete' ? 'completed' : 'review_required');
        if (when === 'after-complete') await value.withdraw(); const view = await revisions.loadReviewedEvaluationRevision(value.readOptions); assert.equal(view?.status, 'review_required'); assert.equal(view?.evaluation, undefined);
        await record(`revocation-${when}`, value, { supplied, worked, view, result: await value.jobs.result(worked.result.job!) });
      }
      {
        const value = await setup(), errors = [];
        for (const field of ['session', 'owner', 'context', 'answer', 'signature'] as const) { const args = structuredClone(value.args); if (field === 'session') args.receipt.sessionId += '-wrong'; if (field === 'owner') args.session.runtime!.owner.id += '-wrong'; if (field === 'context') args.receipt.contextSnapshotSha256 = 'f'.repeat(64); if (field === 'answer') args.session.turns[0].rawTranscript += ' 다른 답변'; if (field === 'signature') args.receipt.signature = Buffer.alloc(64).toString('base64'); errors.push({ field, error: await rejection(() => supply.supplyReviewedSessionEvaluation(args)) }); }
        assert.equal((await readdir(value.jobs.directory).catch(() => [])).length, 0); await record('receipt-exact-identity-rejections', value, errors);
      }
      {
        const value = await setup(), stale = await rejection(() => registryApi.publishBankScopeReview(value.registry, value.context, value.bank, value.registryReceipt(value.registry.contentSha256), 'f'.repeat(64), value.root, trustedPublicKey));
        const supplied = await supply.supplyReviewedSessionEvaluation(value.args), worked = await evaluate(value); assert.equal(worked.result.job?.status, 'completed'); await record('stale-A-CAS-preserves-authority', value, { stale, supplied, worked });
      }
      {
        const value = await setup(), supplied = await supply.supplyReviewedSessionEvaluation(value.args), first = await revisions.loadReviewedEvaluationRevision(value.readOptions);
        const second = await queue.enqueueReviewedKnowledgeEvaluation(supplied.context, value.session, { jobs: value.jobs, sessions: value.sessions, model: 'pr06d-second-model' });
        const error = await rejection(() => revisions.appendReviewedEvaluationRevision({ root: value.root, originalSession: value.session, job: second.job, receiptSha256: supplied.receiptSha256, receiptIssuedAt: value.receipt.issuedAt, originalContextSnapshotSha256: second.originalContextSnapshotSha256, reviewedContextSnapshotSha256: second.contextSnapshotSha256, sessionFrozenInputSha256: history.evaluationFrozenInputHash(value.session), jobs: value.jobs, sessions: value.sessions, trustedPublicKey }));
        const latest = await revisions.loadReviewedEvaluationRevision(value.readOptions); assert.equal(first?.jobId, latest?.jobId); assert.match(error.message, /ORDER_CONFLICT/u); await record('equal-order-revision-conflict-closed', value, { first, second, error, latest });
      }
      {
        const value = await setup(), first = await supply.supplyReviewedSessionEvaluation(value.args), receipt = signed({ ...value.receiptPayload, issuedAt: new Date(Date.now() - 500).toISOString() });
        const fresh = await supply.supplyReviewedSessionEvaluation({ ...value.args, receipt }), duplicate = await supply.supplyReviewedSessionEvaluation({ ...value.args, receipt });
        assert.notEqual(first.jobId, fresh.jobId); assert.equal(fresh.jobId, duplicate.jobId); const view = await revisions.loadReviewedEvaluationRevision(value.readOptions); assert.equal(view?.jobId, fresh.jobId); await record('new-signed-receipt-new-job-exact-retry-reuse', value, { first, fresh, duplicate, view });
      }
      {
        const value = await setup({ followUp: true }), supplied = await supply.supplyReviewedSessionEvaluation(value.args), worked = await evaluate(value);
        assert.equal(worked.result.job?.status, 'completed'); const result = await value.jobs.result(worked.result.job!); const evaluation = result!.evaluation as { answers: Array<{ turnId: string; score: number | null }>; sessionScore: number | null; partialReport: boolean };
        assert.equal(evaluation.answers.length, 2); assert.equal(evaluation.answers[1].score, null); assert.equal(evaluation.sessionScore, null); assert.equal(evaluation.partialReport, true); assert.equal((worked.submittedInputs[0] as { answers: unknown[] }).answers.length, 1);
        await record('held-F-retained-null-no-reweight', value, { supplied, worked, result });
      }
      for (const fault of ['link-EIO', 'partial-write-ENOSPC', 'unlink-EACCES'] as const) {
        const value = await setup(), fs = createRequire(import.meta.url)('node:fs/promises'), original = { link: fs.link, writeFile: fs.writeFile, unlink: fs.unlink }; const events: unknown[] = []; let injected = false;
        for (const operation of ['link', 'writeFile', 'unlink'] as const) fs[operation] = async (...args: unknown[]) => {
          const file = String(args[0]), relative = path.relative(path.join(value.root, 'data/evaluation-revisions'), file);
          const owned = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative), matches = fault === 'link-EIO' ? operation === 'link' : fault === 'partial-write-ENOSPC' ? operation === 'writeFile' : operation === 'unlink';
          if (owned && matches && !injected) { injected = true; const code = fault.split('-').at(-1)!; if (operation === 'writeFile') await original.writeFile(file, Buffer.from(String(args[1])).subarray(0, 9), args[2]); events.push({ operation, file: relative.replaceAll('\\', '/'), code, actualPrefixBytes: operation === 'writeFile' ? 9 : 0 }); throw Object.assign(new Error('Explicit synthetic revision fault.'), { code }); }
          return original[operation](...args);
        }; syncBuiltinESMExports();
        let error; try { error = await rejection(() => supply.supplyReviewedSessionEvaluation(value.args)); } finally { Object.assign(fs, original); syncBuiltinESMExports(); }
        assert.equal(injected, true); const failedFiles = await snapshotFiles(value.root), beforeRetry = await revisions.loadReviewedEvaluationRevision(value.readOptions); assert.equal(beforeRetry?.status ?? null, fault === 'unlink-EACCES' ? 'pending' : null);
        const retry = await supply.supplyReviewedSessionEvaluation(value.args), repeated = await supply.supplyReviewedSessionEvaluation(value.args); assert.equal(retry.jobId, repeated.jobId); const view = await revisions.loadReviewedEvaluationRevision(value.readOptions); assert.equal(view?.status, 'pending');
        await record(`revision-publication-${fault}-retry`, value, { error, events, failedFiles, beforeRetry, retry, repeated, view });
      }
      {
        const root = await mkdtemp(path.join(os.tmpdir(), 'pr06d-signed-')); tempRoots.push(root);
        const { context, session } = v4.evaluationV4CompatibilityFixture();
        context.manifest = { schemaVersion: 'synthetic-v4', rulesVersion: 'synthetic-v4', files: [], recordIds: {}, evidenceIds: ['v4-record-1'] } as unknown as InterviewContext['manifest'];
        session.sourceManifest = context.manifest; session.runtime = runtime.createSessionRuntime(context, { id: 'pr06d-v4-owner', mode: 'local-development' }, controlledAt); session.runtime.evaluationInputFrozenAt = controlledAt; session.runtime.acceptedEndRequest = { elapsedMs: session.elapsedMs, metrics: {} };
        const jobs = new jobApi.EvaluationJobStore(path.join(root, 'data/evaluation-jobs')), sessions = new sessionApi.LocalSessionStore(path.join(root, 'data/sessions')), version = inputApi.HISTORICAL_REVIEWED_KNOWLEDGE_PIPELINE_VERSION, model = v4.V4_COMPATIBILITY_MODEL;
        const source = inputApi.historicalEvaluationSourceFingerprint(context, session, version, model), id = jobApi.evaluationJobId(session.id, session.runtime.owner.id, source, version);
        session.runtime.evaluationJob = { id, pipelineVersion: version, sourceSha256: source, model }; await sessions.saveContext(context, session.runtime.owner.id); await sessions.save(session);
        const job = await jobs.enqueue(session, source, version, Date.now(), model), claimed = (await jobs.claim(job.id, 'pr06d-v4-worker'))!;
        const evaluation = { summary: 'Explicit synthetic original v4 completed result.', answers: [{ turnId: session.turns[0].id, score: 95 }], sessionScore: null, evaluationPipeline: { version, model } }; await jobs.complete(job.id, claimed.lease!.token, evaluation);
        const before = await snapshotFiles(root), read = await history.loadHistoricalCompletedEvaluation(session, context, session.runtime.owner.id, jobs); assert.deepEqual(read!.evaluation, evaluation); assert.deepEqual(await snapshotFiles(root), before);
        const changed = structuredClone(session); changed.turns[0].rawTranscript += ' changed'; const wrongInput = await rejection(() => history.loadHistoricalCompletedEvaluation(changed, context, session.runtime!.owner.id, jobs));
        const resultFile = path.join(jobs.directory, `${job.id}.result.json`), bytes = await readFile(resultFile), altered = JSON.parse(bytes.toString()); altered.evaluation.summary += ' tampered'; await writeFile(resultFile, JSON.stringify(altered)); const wrongResult = await rejection(() => history.loadHistoricalCompletedEvaluation(session, context, session.runtime!.owner.id, jobs)); await writeFile(resultFile, bytes);
        cases.push({ id: 'v4-verified-history-read-only-and-tamper-rejection', observations: { read, wrongInput, wrongResult, sourceSha256: source, contextSha256: runtime.snapshotHash(context) }, files: await snapshotFiles(root) });
      }
    }
    assert.equal(networkCalls, 0); assert.deepEqual(await hashes(), sourceSha256);
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify({ version: 'pr06d-actual-signed-supply-worker-revision-history-v1', sourceSha256, fixtureSha256, controlledClock: natural ? null : controlledAt, controlledPublicSigningKey: trustedPublicKey, controlledUUID: !natural, dependencyReuse: true, freshInstall: false, privateDataUsed: false, realProviderCalls: networkCalls, modelBoundaryOnlySynthetic: true, cases }, null, 2) + '\n');
    console.log(JSON.stringify({ output, cases: cases.length, realProviderCalls: networkCalls }));
  } finally {
    globalThis.Date = originalDate; nativeCrypto.randomUUID = originalUUID; globalThis.fetch = originalFetch; syncBuiltinESMExports(); if (previousKey === undefined) delete process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY; else process.env.EVALUATION_SCOPE_REVIEW_PUBLIC_KEY = previousKey;
    for (const root of tempRoots) { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('pr06d-signed-')); await rm(root, { recursive: true, force: true }); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
