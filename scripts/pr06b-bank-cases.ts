/** Independent actual bank implementations, controlled synthetic inputs and
 * native filesystem observations. Never imports the new repository as a model. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { InterviewContext } from '../server/data/load-interview-context';
import type { InterviewPlan } from '../server/interview-planner';
import type { InterviewSession, QuestionDraft } from '../server/protocol';
import type { PreparedQuestionBank, QuestionBankProviders } from '../server/data/prepared-question-bank';

const flags = new Map(process.argv.slice(2).map(argument => { const match = /^--(source-root|output)=(.+)$/u.exec(argument); if (!match) throw new Error('PR06B_BANK_FLAGS_INVALID'); return [match[1], match[2]]; }));
if (!flags.has('source-root') || !flags.has('output')) throw new Error('PR06B_BANK_ROOT_OUTPUT_REQUIRED');
const sourceRoot = path.resolve(flags.get('source-root')!), output = path.resolve(flags.get('output')!);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex'), jsonSha = (value: unknown) => sha(JSON.stringify(value));
const sourceFile = path.join(sourceRoot, 'server/data/prepared-question-bank.ts'), sourceSha256 = sha(await readFile(sourceFile));
const api = await import(pathToFileURL(sourceFile).href) as typeof import('../server/data/prepared-question-bank');
const voices = await import(pathToFileURL(path.join(sourceRoot, 'server/providers/clova-tts.ts')).href) as typeof import('../server/providers/clova-tts');
const { interviewConfig } = await import(pathToFileURL(path.join(sourceRoot, 'interview.config.ts')).href) as typeof import('../interview.config');
const clock = '2026-11-06T01:02:03.000Z', NativeDate = Date;
class ControlledDate extends NativeDate { constructor(value?: string | number) { super(value === undefined ? clock : value); } static now() { return NativeDate.parse(clock); } }
const nativeFs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
const io = { mkdir: nativeFs.mkdir, writeFile: nativeFs.writeFile, rename: nativeFs.rename, unlink: nativeFs.unlink };
const base = path.join(path.dirname(output), 'bank-case-roots'); await mkdir(base, { recursive: true });
const sourceText = '합성 탐구에서 자료를 비교하고 결과를 보고서로 정리했다.';
const target = { ...interviewConfig.target, studentName: '명시적 합성 학생' };
const context = { target, errors: [], student: { studentId: 'explicit-synthetic-bank-student', studentName: target.studentName, evidence: [{
  id: 'explicit-synthetic-evidence', activityId: 'explicit-synthetic-activity', text: sourceText, title: '합성 탐구', page: 1, grade: 1, section: '합성 사례',
  confirmationStatus: 'confirmed_from_record', preparationPriority: null, scientificTruthVerification: 'not_independently_verified',
  sourceRef: { file: 'explicit-synthetic.pdf', pdfSha256: sha('explicit-synthetic-pdf'), page: 1, extraction: 'explicit-synthetic-fixture', startOffset: 0, endOffset: sourceText.length },
} ] }, school: { interview: { id: 'explicit-synthetic-track' }, sources: [] }, interviewOverview: { durationSeconds: 720 }, manifest: {
  schemaVersion: 'explicit-synthetic-bank-manifest', errors: [], rulesVersion: interviewConfig.rulesVersion,
  guidelineSourceVersions: { operatingGuidelines: '2.0', questionGuidelines: '2.3', evaluationGuidelines: '2.3' },
  files: [{ role: 'synthetic', path: 'explicit-synthetic-source', sha256: sha(sourceText) }], recordIds: { studentId: 'explicit-synthetic-bank-student' }, evidenceIds: ['explicit-synthetic-evidence'],
  sourceIntegrity: { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true, evidenceCount: 1 },
} } as unknown as InterviewContext;
const plan: InterviewPlan = { policyVersion: 'explicit-synthetic-bank-plan', durationSeconds: 720, mainQuestionTarget: 1, limitations: ['Synthetic controlled input only.'], slots: [{
  id: 'explicit-synthetic-slot', index: 1, label: '합성 과정', topicArea: 'academic_inquiry', evidenceIds: ['explicit-synthetic-evidence'], activityIds: ['explicit-synthetic-activity'],
  primaryFunction: 'PROCESS', depth: 'D2', questionIntent: '합성 탐구의 수행 순서를 확인한다.', interviewerId: 'interviewer-1', interviewerRole: 'academic', schoolConnections: [],
}] };
const environment = { OPENAI_QUESTION_MODEL: 'explicit-synthetic-bank-reviewer' };
const fixtureSha256 = jsonSha({ context, plan, environment, sourceText, clock });
function providers() {
  let generated = 0, synthesized = 0, failGenerateAt = 0;
  const provider: QuestionBankProviders = {
    async generate(_context, _session, excluded) {
      generated++; if (generated === failGenerateAt) throw Object.assign(new Error('EXPLICIT_SYNTHETIC_TRANSPORT_FAILURE'), { code: 'EAI_AGAIN' });
      const questionText = excluded.length ? '합성 탐구를 진행한 순서를 설명해 주세요.' : '합성 탐구에서 자료를 어떤 순서로 비교했나요?';
      return { acknowledgement: null, acknowledgementQuote: null, questionText, questionKind: 'main', parentMainQuestionId: null, evidenceIds: ['explicit-synthetic-evidence'], evidenceQuotes: [{ evidenceId: 'explicit-synthetic-evidence', quote: sourceText }],
        primaryFunction: 'PROCESS', depth: 'D2', questionIntent: plan.slots[0].questionIntent, targetEvidence: ['합성 탐구의 수행 순서'], groundingRationale: '명시적 합성 독립 검수 사례', validationStatus: 'approved', validationFailures: [],
        premiseValidation: { version: 'question-premise-v1', guidelineVersion: '2.3', status: 'approved', method: 'bounded_semantic_review', reviewModel: environment.OPENAI_QUESTION_MODEL,
          questionSha256: sha(questionText), coreIntentCount: 1, supportedPremises: [{ basis: 'record', sourceId: 'explicit-synthetic-evidence', questionStartOffset: 0, questionEndOffset: 4, sourceStartOffset: 0, sourceEndOffset: 4 }], openChecks: [] } } as QuestionDraft;
    },
    async synthesize(text, voice) { synthesized++; return { audioUrl: `/api/audio/${voices.speechAudioCacheId(text, voice)}`, bytes: Buffer.from(`explicit-synthetic-audio:${text}`) }; },
  };
  return { provider, counts: () => ({ generated, synthesized }), failAt: (value: number) => { failGenerateAt = value; } };
}
async function inventory(root: string): Promise<Array<{ path: string; bytes: number; sha256: string }>> {
  const rows: Array<{ path: string; bytes: number; sha256: string }> = [];
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) await visit(file); else { const bytes = await readFile(file); rows.push({ path: path.relative(root, file).replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes) }); } }
  }
  await visit(root); return rows.sort((left, right) => left.path.localeCompare(right.path));
}
type BankEvent = { operation: string; path: string; destination?: string; bytes?: number; sha256?: string; mode?: number; flag?: string; outcome: string };
type Fault = { target: 'audio' | 'partial' | 'ready'; operation: 'writeFile' | 'rename'; code: 'ENOSPC' | 'EPERM'; delivered: boolean };
const cases: Array<Record<string, unknown>> = [];
for (const id of ['prepare-current-pinned-selection', 'ready-cache-hit', 'pinned-survives-current-change', 'pinned-missing-no-fallback', 'pinned-corrupt-no-fallback', 'bank-hash-corrupt', 'audio-corrupt-repair', 'budget-checkpoint-resume', 'transport-checkpoint-resume', 'same-bank-concurrent-sharing',
  'audio-write-ENOSPC', 'audio-rename-EPERM', 'partial-write-ENOSPC', 'partial-rename-EPERM', 'ready-write-ENOSPC', 'ready-rename-EPERM', 'ready-replacement-EPERM', 'missing-current']) {
  const root = await mkdtemp(path.join(base, 'owned-')), events: BankEvent[] = [], ids = new Map<string, string>(), fake = providers();
  const options = { root, plan, environment, providers: fake.provider, concurrency: 1 as const };
  const identity = api.questionBankIdentity(context, options), readyFile = path.join(root, 'data/prepared/question-banks', `${identity.key}.json`);
  let fault: Fault | null = null, networkCalls = 0;
  const filePath = (value: string) => {
    const relative = path.relative(root, path.resolve(value)); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    return relative.replaceAll('\\', '/').replace(/\.([a-f0-9-]+)\.tmp$/iu, (_match, uuid: string) => {
      assert.match(uuid, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu);
      if (!ids.has(uuid)) ids.set(uuid, `<uuid-${ids.size + 1}>`); return `.${ids.get(uuid)}.tmp`;
    });
  };
  const targetFor = (value: string) => value.includes('.mp3.') ? 'audio' : value.includes('.partial.json.') ? 'partial' : value.includes('.json.') ? 'ready' : null;
  const observe = async (operation: keyof typeof io, args: unknown[]) => {
    const file = typeof args[0] === 'string' ? path.resolve(args[0]) : '', relative = path.relative(root, file);
    if (!file || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PR06B_BANK_WRITE_OUTSIDE_OWNED_ROOT');
    const settings = (operation === 'writeFile' ? args[2] : args[1]) as { mode?: number; flag?: string } | undefined;
    const event: BankEvent = { operation, path: filePath(file), outcome: 'pending', ...(operation === 'rename' ? { destination: filePath(String(args[1])) } : {}),
      ...(operation === 'writeFile' ? { bytes: Buffer.byteLength(args[1] as string | Buffer), sha256: sha(args[1] as string | Buffer) } : {}),
      ...(settings && typeof settings === 'object' ? { mode: settings.mode, flag: settings.flag } : {}) };
    if (operation === 'writeFile' && file.endsWith('.tmp')) { assert.equal(settings?.mode, 0o600); assert.equal(settings?.flag, 'wx'); }
    if (operation === 'rename') { assert.equal(event.path.replace(/\.<uuid-\d+>\.tmp$/u, ''), event.destination); }
    events.push(event);
    try {
      if (fault && !fault.delivered && fault.operation === operation && fault.target === targetFor(file)) { fault.delivered = true; throw Object.assign(new Error('EXPLICIT_SYNTHETIC_STORAGE_FAILURE'), { code: fault.code }); }
      const result = await (io[operation] as (...values: unknown[]) => Promise<unknown>)(...args); event.outcome = 'ok'; return result;
    } catch (error) { event.outcome = (error as NodeJS.ErrnoException).code ?? (error as Error).name; throw error; }
  };
  nativeFs.mkdir = ((...args: unknown[]) => observe('mkdir', args)) as typeof nativeFs.mkdir;
  nativeFs.writeFile = ((...args: unknown[]) => observe('writeFile', args)) as typeof nativeFs.writeFile;
  nativeFs.rename = ((...args: unknown[]) => observe('rename', args)) as typeof nativeFs.rename;
  nativeFs.unlink = ((...args: unknown[]) => observe('unlink', args)) as typeof nativeFs.unlink;
  globalThis.Date = ControlledDate as DateConstructor;
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => { networkCalls++; throw new Error('PR06B_BANK_NETWORK_BLOCKED'); }; syncBuiltinESMExports();
  const summarize = (bank: PreparedQuestionBank | null) => bank === null ? null : ({ key: bank.key, contentSha256: bank.contentSha256, orderedJsonSha256: jsonSha(bank),
    orderedCandidates: bank.slots.flatMap(slot => slot.candidates.map(candidate => ({ id: candidate.id, slotId: candidate.slotId, variant: candidate.variant, draftSha256: jsonSha(candidate.draft), questionSha256: candidate.questionSha256, speechHash: candidate.speechHash, audioSha256: candidate.audioSha256 }))) });
  const capture = async (job: () => Promise<unknown>) => { try { return { status: 'returned', value: await job() }; } catch (error) { const value = error as Error & { code?: string }; return { status: 'rejected', name: value.name, code: value.code ?? null, messageSha256: sha(value.message.replaceAll(root, '<owned-root>')) }; } };
  let observations: Record<string, unknown> = {};
  try {
    if (id === 'missing-current') observations = { current: await api.loadQuestionBank(context, options), summary: await api.loadQuestionBankPreparationSummary(context, options) };
    else if (id === 'same-bank-concurrent-sharing') { const [one, two] = await Promise.all([api.prepareQuestionBank(context, options), api.prepareQuestionBank(context, options)]); observations = { one: summarize(one), two: summarize(two), sameResolvedObject: one === two }; }
    else if (id === 'budget-checkpoint-resume' || id === 'transport-checkpoint-resume') {
      if (id === 'transport-checkpoint-resume') fake.failAt(2);
      const first = await capture(() => api.prepareQuestionBank(context, { ...options, ...(id === 'budget-checkpoint-resume' ? { maxNewCandidates: 1 } : {}) }));
      observations = { first, firstCounts: fake.counts(), firstFiles: await inventory(root), currentBeforeResume: await api.loadQuestionBank(context, options), summaryBeforeResume: await api.loadQuestionBankPreparationSummary(context, options), resumed: summarize(await api.prepareQuestionBank(context, options)) };
    } else if (/^(audio|partial|ready)-(write|rename)-(ENOSPC|EPERM)$/u.test(id)) {
      const [targetKind, operation, code] = id.split('-'); fault = { target: targetKind as Fault['target'], operation: operation === 'write' ? 'writeFile' : 'rename', code: code as Fault['code'], delivered: false };
      const first = await capture(() => api.prepareQuestionBank(context, options));
      const firstFiles = await inventory(root), firstCounts = fake.counts(), currentBeforeResume = await api.loadQuestionBank(context, options);
      observations = { first, firstFiles, firstCounts, currentBeforeResume, faultDelivered: fault.delivered, resumed: summarize(await api.prepareQuestionBank(context, options)) };
    } else {
      const bank = await api.prepareQuestionBank(context, options), pinned = { ...plan, poolKey: bank.key, poolContentSha256: bank.contentSha256 };
      if (id === 'prepare-current-pinned-selection') observations = { bank: summarize(bank), current: summarize(await api.loadQuestionBank(context, options)), pinned: summarize(await api.loadQuestionBankByPinnedPlan(context, pinned, { root })), selectionSha256: jsonSha(api.selectPreparedMainQuestion(bank, { plan, turns: [], target: context.target }, 1)), alternateSelectionSha256: jsonSha(api.selectPreparedMainQuestion(bank, { plan, turns: [], target: context.target }, 1, { alternateIndex: 1 })) };
      if (id === 'ready-cache-hit') { const before = fake.counts(), writesBefore = events.length; const loaded = await api.prepareQuestionBank(context, options); observations = { bank: summarize(loaded), callsBefore: before, callsAfter: fake.counts(), writesDuringHit: events.length - writesBefore }; }
      if (id.startsWith('pinned-')) {
        const changedOptions = { ...options, environment: { OPENAI_QUESTION_MODEL: 'explicit-synthetic-next-bank-reviewer' }, providers: { ...fake.provider, async generate(ctx: InterviewContext, session: InterviewSession, excluded: string[]) { const draft = await fake.provider.generate(ctx, session, excluded); draft.premiseValidation!.reviewModel = 'explicit-synthetic-next-bank-reviewer'; return draft; } } };
        const changed = await api.prepareQuestionBank(context, changedOptions);
        if (id === 'pinned-missing-no-fallback') await io.unlink(readyFile);
        if (id === 'pinned-corrupt-no-fallback') await io.writeFile(readyFile, 'explicit synthetic damaged bank JSON');
        observations = { current: summarize(await api.loadQuestionBank(context, changedOptions)), pinned: summarize(await api.loadQuestionBankByPinnedPlan(context, pinned, { root })), changedKey: changed.key, originalKey: bank.key };
      }
      if (id === 'bank-hash-corrupt') { await io.writeFile(readyFile, JSON.stringify({ ...bank, completedAt: '2026-11-06T09:00:00.000Z' }, null, 2)); observations = { current: await api.loadQuestionBank(context, options), pinned: await api.loadQuestionBankByPinnedPlan(context, pinned, { root }) }; }
      if (id === 'audio-corrupt-repair' || id === 'ready-replacement-EPERM') {
        const originalReadySha256 = sha(await readFile(readyFile)); await io.writeFile(path.join(root, 'data/audio', `${bank.slots[0].candidates[0].speechHash}.mp3`), 'explicit synthetic damaged audio');
        if (id === 'ready-replacement-EPERM') fault = { target: 'ready', operation: 'rename', code: 'EPERM', delivered: false };
        const before = fake.counts(), rejectedBank = await api.loadQuestionBank(context, options), rebuilt = await capture(async () => summarize(await api.prepareQuestionBank(context, options)));
        observations = { rejectedBank, rebuilt, callsBefore: before, callsAfter: fake.counts(), originalReadySha256, readySha256AfterAttempt: sha(await readFile(readyFile)), currentAfterAttempt: summarize(await api.loadQuestionBank(context, options)), faultDelivered: fault?.delivered ?? false };
      }
    }
    assert.equal(networkCalls, 0); assert.ok((await inventory(root)).every(row => !row.path.endsWith('.tmp')), 'writer cleans only its own temporary files');
    cases.push({ id, identity: { key: identity.key, sourceFingerprint: identity.sourceFingerprint, planSha256: jsonSha(identity.plan), voicesSha256: jsonSha(identity.voices) }, observations, providerCounts: fake.counts(), networkCalls, events, files: await inventory(root) });
  } finally { Object.assign(nativeFs, io); globalThis.Date = NativeDate; globalThis.fetch = originalFetch; syncBuiltinESMExports(); }
}
assert.equal(sha(await readFile(sourceFile)), sourceSha256);
const report = { version: 'pr06b-independent-bank-cases-v1', sourceSha256, fixtureSha256, controlledClock: clock, privateDataUsed: false, realProviderCalls: 0,
  independentSourceModule: true, temporaryObservation: 'UUIDv4 validated per file; only UUID spelling replaced in ordered events; domain/file/audio bytes remain exact', cases };
await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, sourceSha256, fixtureSha256, cases: cases.length, realProviderCalls: 0 }));
