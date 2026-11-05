import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadInterviewContext } from './fixtures/runtime-context';
import { loadQuestionBank, loadQuestionBankByPinnedPlan, loadQuestionBankPreparationSummary, prepareQuestionBank, questionBankIdentity,
  type QuestionBankProviders } from '../server/data/prepared-question-bank';
import type { InterviewPlan } from '../server/interview-planner';
import type { QuestionDraft } from '../server/protocol';
import { speechAudioCacheId } from '../server/providers/clova-tts';
import { emptyReadScope } from '../server/repositories/analysis-read-ports';
import { createLocalAudioRepository } from '../server/repositories/local-audio-repository';
import { createLocalQuestionBankRepository } from '../server/repositories/local-question-bank-repository';
import type { QuestionBankRepository, QuestionBankRequest } from '../server/repositories/question-bank-ports';
import type { AudioReadRequest, AudioPublishRequest } from '../server/repositories/audio-ports';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture() {
  const context = await loadInterviewContext();
  context.student.pdfSha256 = 'a'.repeat(64); context.student.recordRevision = context.student.pdfSha256;
  const source = context.student.evidence[0]; source.text = '합성 탐구에서 자료를 비교하고 결과를 보고서로 정리했다.'; source.sourceRef.endOffset = source.text.length;
  const plan: InterviewPlan = { policyVersion: 'synthetic-repository-plan', durationSeconds: 720, mainQuestionTarget: 1, limitations: [], slots: [
    { id: 'synthetic-repository-slot', index: 1, label: '합성 과정', topicArea: 'academic_inquiry', evidenceIds: [source.id], activityIds: [source.activityId],
      primaryFunction: 'PROCESS', depth: 'D2', questionIntent: '합성 탐구의 수행 순서를 확인한다.', interviewerId: 'interviewer-1', interviewerRole: 'academic', schoolConnections: [] },
  ] };
  const environment = { OPENAI_QUESTION_MODEL: 'explicit-synthetic-repository-reviewer' };
  let generated = 0, synthesized = 0;
  const providers: QuestionBankProviders = {
    async generate(_context, _session, excluded) {
      generated++;
      const questionText = excluded.length ? '합성 탐구를 진행한 순서를 설명해 주세요.' : '합성 탐구에서 자료를 어떤 순서로 비교했나요?';
      return { acknowledgement: null, acknowledgementQuote: null, questionText, questionKind: 'main', parentMainQuestionId: null, evidenceIds: [source.id],
        evidenceQuotes: [{ evidenceId: source.id, quote: source.text }], primaryFunction: 'PROCESS', depth: 'D2', questionIntent: plan.slots[0].questionIntent,
        targetEvidence: ['합성 탐구의 수행 순서'], groundingRationale: '명시적 합성 검수 사례', validationStatus: 'approved', validationFailures: [],
        premiseValidation: { version: 'question-premise-v1', guidelineVersion: '2.3', status: 'approved', method: 'bounded_semantic_review', reviewModel: environment.OPENAI_QUESTION_MODEL,
          questionSha256: hash(questionText), coreIntentCount: 1, supportedPremises: [{ basis: 'record', sourceId: source.id, questionStartOffset: 0, questionEndOffset: 4, sourceStartOffset: 0, sourceEndOffset: 4 }], openChecks: [] } } as QuestionDraft;
    },
    async synthesize(text, voice) { synthesized++; return { audioUrl: `/api/audio/${speechAudioCacheId(text, voice)}`, bytes: Buffer.from(`explicit-synthetic-audio:${text}`) }; },
  };
  return { context, plan, environment, providers, counts: () => ({ generated, synthesized }) };
}
async function workspace(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'question-bank-repository-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('question-bank-repository-')); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('actual bank preparation, current and pinned readers use injected scoped repositories and preserve durable bytes', async t => {
  const root = await workspace(t), value = await fixture(), localBank = createLocalQuestionBankRepository(root), localAudio = createLocalAudioRepository(root);
  const bankCalls: Array<{ operation: string; request: QuestionBankRequest }> = [], audioReads: AudioReadRequest[] = [], audioWrites: AudioPublishRequest[] = [];
  const bankRepository: QuestionBankRepository = { ownerId: localBank.ownerId,
    async readReady(request) { bankCalls.push({ operation: 'readReady', request }); return localBank.readReady(request); },
    async readPartial(request) { bankCalls.push({ operation: 'readPartial', request }); return localBank.readPartial(request); },
    async writePartial(request) { bankCalls.push({ operation: 'writePartial', request }); await localBank.writePartial(request); },
    async publishReady(request) { bankCalls.push({ operation: 'publishReady', request }); await localBank.publishReady(request); },
    async removePartial(request) { bankCalls.push({ operation: 'removePartial', request }); await localBank.removePartial(request); },
  };
  const audioRepository = { ownerId: localAudio.ownerId,
    async read(request: AudioReadRequest) { audioReads.push(request); return localAudio.read(request); },
    async publish(request: AudioPublishRequest) { audioWrites.push(request); await localAudio.publish(request); },
  };
  const options = { ...value, root, concurrency: 1 as const, bankRepository, audioRepository };
  const bank = await prepareQuestionBank(value.context, options);
  assert.deepEqual(value.counts(), { generated: 2, synthesized: 2 });
  assert.equal(bankCalls.filter(call => call.operation === 'writePartial').length, 2);
  assert.equal(bankCalls.filter(call => call.operation === 'publishReady').length, 1);
  assert.equal(bankCalls.filter(call => call.operation === 'removePartial').length, 1);
  assert.deepEqual(await readFile(path.join(root, 'data/prepared/question-banks', `${bank.key}.json`)), Buffer.from(JSON.stringify(bank, null, 2)));
  for (const write of audioWrites) {
    assert.equal(write.publication, 'bank-atomic'); assert.equal(write.purpose, 'question-bank-preparation');
    assert.equal(write.scope.bankKey, bank.key); assert.equal(write.scope.studentId, value.context.student.studentId);
    assert.equal(write.scope.supportTargetId, value.context.school.interview!.id); assert.equal(write.scope.pdfSha256, value.context.student.pdfSha256);
    assert.deepEqual(await readFile(path.join(root, 'data/audio', `${write.id}.mp3`)), write.bytes);
  }
  assert.deepEqual(await loadQuestionBank(value.context, options), bank);
  assert.deepEqual(await loadQuestionBankByPinnedPlan(value.context, { ...value.plan, poolKey: bank.key, poolContentSha256: bank.contentSha256 }, options), bank);
  assert.ok(bankCalls.some(call => call.operation === 'readReady' && call.request.purpose === 'current'));
  assert.ok(bankCalls.some(call => call.operation === 'readReady' && call.request.purpose === 'pinned' && call.request.scope.bankContentSha256 === bank.contentSha256));
  assert.ok(audioReads.some(read => read.scope.bankContentSha256 === bank.contentSha256));
  assert.deepEqual(value.counts(), { generated: 2, synthesized: 2 });
  for (const scope of [{ ownerId: 'another-owner' }, { supportTargetId: 'another-target' }, { pdfSha256: 'wrong-pdf' }, { sourceRevision: 'unknown-extraction-revision' }, { bankKey: 'b'.repeat(64) }]) {
    await assert.rejects(loadQuestionBank(value.context, { ...options, scope }), /QUESTION_BANK_(?:READ_SCOPE|REPOSITORY_OWNER)_MISMATCH/u);
  }
  const filesBefore = await readdir(path.join(root, 'data/prepared/question-banks'));
  const pinned = { ...options, scope: { bankContentSha256: 'b'.repeat(64) } };
  assert.equal(await loadQuestionBank(value.context, pinned), null);
  await assert.rejects(loadQuestionBankPreparationSummary(value.context, pinned), /QUESTION_BANK_READ_SCOPE_MISMATCH/u);
  await assert.rejects(prepareQuestionBank(value.context, pinned), /QUESTION_BANK_READ_SCOPE_MISMATCH/u);
  assert.deepEqual(value.counts(), { generated: 2, synthesized: 2 });
  assert.deepEqual(await readdir(path.join(root, 'data/prepared/question-banks')), filesBefore);
  assert.equal(await loadQuestionBankByPinnedPlan(value.context, { ...value.plan, poolKey: 'c'.repeat(64), poolContentSha256: bank.contentSha256 }, options), null);
});

test('local bank writer preserves wx/temp/rename cleanup, original ready bytes on rename failure and null read failures', async t => {
  const root = await workspace(t), value = await fixture();
  const bank = await prepareQuestionBank(value.context, { ...value, root, concurrency: 1 });
  const repository = createLocalQuestionBankRepository(root), scope = { ...emptyReadScope(repository.ownerId), bankKey: bank.key, bankContentSha256: bank.contentSha256, sourceFingerprint: bank.sourceFingerprint };
  const request = { scope, purpose: 'preparation' as const }, file = path.join(root, 'data/prepared/question-banks', `${bank.key}.json`), before = await readFile(file);
  const events: string[] = [], failure = Object.assign(new Error('synthetic rename failure'), { code: 'EBUSY' });
  const faulty = createLocalQuestionBankRepository(root, { io: { mkdir, readFile, unlink: async (...args) => { events.push('unlink'); return unlink(...args); },
    writeFile: async (...args) => { events.push('write'); assert.deepEqual(args[2], { mode: 0o600, flag: 'wx' }); return writeFile(...args); },
    rename: async () => { events.push('rename'); throw failure; } } });
  await assert.rejects(faulty.publishReady({ ...request, value: { ...bank, completedAt: '2026-11-06T01:02:03.000Z' } }), error => error === failure);
  assert.deepEqual(events, ['write', 'rename', 'unlink']);
  assert.deepEqual(await readFile(file), before);
  assert.ok((await readdir(path.dirname(file))).every(name => !name.endsWith('.tmp')));
  await assert.rejects(repository.readReady({ ...request, scope: { ...scope, bankKey: '../escape' } }), /식별자/u);
  await assert.rejects(repository.readReady({ ...request, scope: { ...scope, ownerId: 'another-owner' } }), /QUESTION_BANK_REPOSITORY_OWNER_MISMATCH/u);
  await writeFile(file, 'synthetic damaged JSON');
  assert.equal(await repository.readReady(request), null);
  await unlink(file);
  assert.equal(await repository.readReady(request), null);
  await repository.removePartial(request);
  assert.equal(questionBankIdentity(value.context, value).key, bank.key);
});
