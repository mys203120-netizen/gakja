import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { interviewConfig } from '../interview.config';
import { loadInterviewContextAt } from '../server/data/load-interview-context';
import { auditStudentSourceText, verifyStudentSourceText } from '../server/data/verify-student-source';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'interview-sources-'));
  for (const [role, relative] of Object.entries(interviewConfig.files)) {
    if (role === 'sourceManifest') continue;
    const target = path.resolve(root, relative);
    assert.ok(!path.relative(root, target).startsWith('..'));
    await mkdir(path.dirname(target), { recursive: true }); await copyFile(relative, target);
  }
  const cachePath = path.join(root, interviewConfig.files.preparedStudent);
  const changeCache = async (change: (cache: any) => void) => { const cache = JSON.parse(await readFile(cachePath, 'utf8')); change(cache); await writeFile(cachePath, JSON.stringify(cache)); };
  return { root, changeCache, async close() { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('interview-sources-')); await rm(root, { recursive: true, force: true }); } };
}

test('current sources use one shared path contract and the manifest verifies actual PDF excerpts and every file hash', async context => {
  const setup = await fixture(); context.after(setup.close);
  const loaded = await loadInterviewContextAt(setup.root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.fullMdPolicyOriginals?.documents.length, 12);
  assert.equal(loaded.manifest.fullMdPolicyOriginals?.contentSha256, loaded.fullMdPolicyOriginals?.contentSha256);
  assert.deepEqual(loaded.manifest.guidelineSourceVersions, { operatingGuidelines: '2.0', questionGuidelines: '2.3', evaluationGuidelines: '2.3' });
  assert.deepEqual(loaded.manifest.sourceIntegrity, { pdfHashVerified: true, evidenceReferencesVerified: true, evidenceTextVerified: true, evidenceCount: 17 });
  for (const entry of loaded.manifest.files) assert.equal(entry.sha256, createHash('sha256').update(await readFile(path.join(setup.root, entry.path))).digest('hex'));
  assert.deepEqual(JSON.parse(await readFile(path.join(setup.root, interviewConfig.files.sourceManifest), 'utf8')), loaded.manifest);
});

test('missing files, wrong guide version and a changed PDF fail closed rather than using an old source location', async context => {
  const setup = await fixture(); context.after(setup.close);
  await writeFile(path.join(setup.root, interviewConfig.files.questionGuidelines), '# Legacy question rules v2.1');
  await writeFile(path.join(setup.root, interviewConfig.files.studentPdf), 'changed PDF');
  const loaded = await loadInterviewContextAt(setup.root);
  assert.ok(loaded.errors.some(error => error.includes('정본 버전 불일치')));
  assert.equal(loaded.manifest.sourceIntegrity.pdfHashVerified, false);
  assert.equal(loaded.manifest.sourceIntegrity.evidenceTextVerified, false);
  await rm(path.join(setup.root, interviewConfig.files.evaluationGuidelines));
  assert.ok((await loadInterviewContextAt(setup.root)).errors.some(error => error.includes('필수 자료 없음')));
});

test('matching PDF hash cannot conceal altered cache text, swapped source files or invalid source offsets', async context => {
  for (const [name, change] of [
    ['text', (cache: any) => { cache.evidence[0].text = '실제 원문에 없는 변경된 학생 경험'; }],
    ['file', (cache: any) => { cache.evidence[0].sourceRef.file = 'different.pdf'; }],
    ['offset', (cache: any) => { cache.evidence[0].sourceRef.endOffset = cache.evidence[0].sourceRef.startOffset; }],
    ['page-count', (cache: any) => { cache.pageCount = 99; }],
  ] as const) await context.test(name, async subcontext => {
    const setup = await fixture(); subcontext.after(setup.close); await setup.changeCache(change);
    const loaded = await loadInterviewContextAt(setup.root);
    assert.equal(loaded.manifest.sourceIntegrity.pdfHashVerified, true);
    assert.ok(loaded.errors.length > 0);
    assert.equal(loaded.manifest.sourceIntegrity.evidenceTextVerified, false);
  });
});

test('same-version question and evaluation guides cannot be swapped by their cross-reference headers', async context => {
  const setup = await fixture(); context.after(setup.close);
  await copyFile(path.join(setup.root, interviewConfig.files.evaluationGuidelines), path.join(setup.root, interviewConfig.files.questionGuidelines));
  const loaded = await loadInterviewContextAt(setup.root);
  assert.ok(loaded.errors.some(error => error.includes('questionGuidelines') && error.includes('문서 역할')));
});

test('an offset past the actual page end is rejected even when slice would return the exact page text', async () => {
  const pdfBytes = await readFile(interviewConfig.files.studentPdf);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true, verbosity: 0 });
  const pdf = await loading.promise;
  try {
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.filter(item => 'str' in item).map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').replace(/[ \t]+/gu, ' ');
    page.cleanup();
    assert.ok(text.length > 0);
    const evidence = [{ page: 1, text, sourceRef: { startOffset: 0, endOffset: text.length + 1 } }];
    assert.equal(await verifyStudentSourceText(pdfBytes, evidence, pdf.numPages), false);
  } finally { await loading.destroy(); }
});

test('full-document PDF audit distinguishes complete source coverage from a valid partial excerpt', async () => {
  const pointer = JSON.parse(await readFile('data/prepared/full-record-current.json', 'utf8'));
  const source = JSON.parse(await readFile(pointer.path, 'utf8')) as { pageCount: number; pages: Array<{ page: number; text: string }> };
  const bytes = await readFile(interviewConfig.files.studentPdf);
  const spans = source.pages.map(page => ({ page: page.page, text: page.text, sourceRef: { startOffset: 0, endOffset: page.text.length } }));
  const complete = await auditStudentSourceText(bytes, spans, source.pageCount);
  assert.equal(complete.passed, true);
  assert.equal(complete.checkedPages, source.pageCount);
  assert.equal(complete.fullDocumentTextCompared, true);
  const partial = await auditStudentSourceText(bytes, spans.slice(0, 1), source.pageCount);
  assert.equal(partial.passed, true); assert.equal(partial.fullDocumentTextCompared, false);
  const invalid = await auditStudentSourceText(bytes, [{ ...spans[0], sourceRef: { startOffset: -spans[0].text.length, endOffset: spans[0].text.length } }], source.pageCount);
  assert.equal(invalid.passed, false);
  assert.deepEqual(invalid.failureCodes, ['PDF_SOURCE_SPAN_MISMATCH']);
  assert.equal(JSON.stringify(complete).includes(source.pages[0].text), false, 'diagnostics contain hashes and counts, not private source text');
});
