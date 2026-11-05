import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { interviewReferenceFiles } from '../interview-files.mjs';
import { extractBookQuestions, loadBookQuestionReferences, prepareBookQuestionReferences, selectBookQuestionExamples } from '../server/data/book-question-reference';
import { reviewSyntheticReference, syntheticReferenceCorpus } from './fixtures/book-references';

const fenced = (body: string) => `\`\`\`text\n${body}\n\`\`\``;
const preparation = `# 합성 참고서\n#### PDF 페이지 12\n${fenced(`학생부 기록 내용\n다른 지원자는 실험조장을 맡았다.\n면접 질문\n어떤 기준으로 실험 변인을 선택했나요?\n답변 예시 1\n저는 실험조장을 맡았습니다. 왜 제가 맡았을까요?\n추가 질문\n관찰 결과를 어떻게 확인했나요?\n[학생 답안]\n합성 답안의 원인은 무엇인가요?\n관련 학과\n합성학과`)}\n`;
const university = `# 합성 대학별 참고서\n### 1 합성대학교\n#### PDF 페이지 99\n${fenced(`1. 면접 개요\n면접 시간: 8분\n평가 항목: 배점 20%\n2. 면접 기출 문항\n학과\n기출 문항\n화학과\n학업 역량\n· 관찰 결과를 비교한 기준은 무엇인가요?\n· 본인이 맡은 역할은 무엇인가요? 그 결과는 무엇인가요?\n· 다음 제시문을 읽고 근거를 설명해 보세요.\n· 부모님의 종교는 무엇인가요?\n· 아침은 먹고 오셨나요?\n· 전공 탐색 역량 | 20% 질문에 설명해 보세요.\n3. 면접 문항 예시\n|합성학과| 관찰한 수치의 신뢰도를 어떻게 확인했나요?\n[학업 역량] 그 방법의 한계는 무엇인가요?`)}\n`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'interview-question-reference-'));
  for (const relative of [interviewReferenceFiles.bookContentMd, interviewReferenceFiles.bookUniversityMd]) await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  const figures = path.join(root, interviewReferenceFiles.bookFiguresDirectory);
  await mkdir(figures, { recursive: true });
  await writeFile(path.join(figures, 'fixture.png'), 'synthetic-image-bytes');
  await writeFile(path.join(root, interviewReferenceFiles.bookContentMd), preparation + `\n![합성 그림](<${path.join(figures, 'fixture.png').replace(/\\/gu, '/')}>)`);
  await writeFile(path.join(root, interviewReferenceFiles.bookUniversityMd), university);
  return { root, async close() { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('interview-question-reference-')); await rm(root, { recursive: true, force: true }); } };
}

test('explicit question sections exclude example answers, university administration and activity narratives', () => {
  const questions = extractBookQuestions(preparation, 'synthetic-content.md', 'preparation');
  assert.equal(questions.length, 2);
  assert.ok(questions.every(question => question.provenance === 'book_example'));
  assert.equal(questions[0].questionKind, 'main');
  assert.equal(questions[1].questionKind, 'follow_up');
  assert.ok(questions.every(question => !/실험조장|합성 답안/u.test(question.questionText)));
  for (const question of questions) {
    assert.equal(preparation.slice(question.source.startOffset, question.source.endOffset), question.rawText);
    assert.equal(question.source.pdfPage, 12);
    assert.equal(question.source.startLine, preparation.slice(0, question.source.startOffset).split('\n').length);
    assert.equal(question.source.sha256.length, 64);
    assert.deepEqual(Object.keys(question.source).sort(), ['path', 'sha256', 'pdfPage', 'startLine', 'endLine', 'startOffset', 'endOffset', 'section'].sort());
  }
});

test('reported past and explicitly book examples retain distinct provenance while screening preserves candidates for semantic review', () => {
  const questions = extractBookQuestions(university, 'synthetic-university.md', 'university');
  assert.equal(questions.length, 8);
  const byText = (text: string) => questions.find(question => question.questionText.includes(text))!;
  assert.equal(byText('비교한 기준').provenance, 'reported_past_question');
  assert.equal(byText('수치의 신뢰도').provenance, 'book_example');
  assert.equal(byText('수치의 신뢰도').questionText, '관찰한 수치의 신뢰도를 어떻게 확인했나요?');
  assert.equal(byText('방법의 한계').questionText, '그 방법의 한계는 무엇인가요?');
  assert.deepEqual(byText('맡은 역할').exclusions, ['multiple_demands']);
  assert.ok(byText('제시문').exclusions.includes('passage_or_figure_required'));
  assert.ok(byText('부모님').exclusions.includes('sensitive_personal_question'));
  assert.ok(byText('아침').exclusions.includes('rapport_or_unobserved_setting'));
  assert.ok(questions.some(question => question.questionText.includes('질문에 설명')));
  assert.ok(questions.every(question => !question.questionText.includes('면접 시간')));
  for (const question of questions) assert.equal(university.slice(question.source.startOffset, question.source.endOffset), question.rawText);
});

test('passage-question sections cannot become standalone questions by losing the passage on a later line', () => {
  const source = `### 1 합성대학교\n#### PDF 페이지 1\n${fenced('2. 면접 기출 문항(제시문 면접)\n· 판단한 이유는 무엇인가요?\n기출 문항 예시\n다음 제시문을 읽고 답변을 준비해 주세요.\n· 어떤 결론이 타당한가요?')}`;
  const questions = extractBookQuestions(source, 'synthetic.md', 'university');
  assert.equal(questions.length, 2);
  assert.ok(questions.every(question => question.exclusions.includes('passage_or_figure_required')));
  assert.equal(questions[1].provenance, 'book_example');
});

test('compound requests retain their original source text for later single-demand decomposition', () => {
  const source = fenced('면접 질문\n주제를 선정한 이유와 참고한 문헌은 무엇인지 구체적으로 설명해 주세요.\n추가 질문\n원리 및 과정에 대해 설명해 주세요.\n어떤 근거가 있었으며, 그것에 대해 본인은 어떻게 생각하는지 알려주세요.\n피드백을 어떻게 받아들이고, 이를 통해 어떻게 성장하나요?');
  const questions = extractBookQuestions(source, 'synthetic.md', 'preparation');
  assert.equal(questions.length, 4);
  assert.ok(questions.every(question => question.exclusions.includes('multiple_demands')));
});

test('year/report headings, OCR request spacing and numbered subquestions keep exact source boundaries', () => {
  const source = `### 1 합성대학교\n#### PDF 페이지 99\n${fenced('2. 면접 기출 문항\n1 ) 2026학년도 개방형 기출 문항\n전공과 관련하여 흥미 있었던 주제는 무엇인가요?\n1 ) 선행학습 영향평가 결과보고서 사례\n어떤 노력을 하였고, 이 활동이 어떤 의미가 있었는지 말해보세요.\n5-1. 평가에 대해 이의를 제기해 보십시오.\n5-2. 공감적 통찰이 무엇이라고 생각합니까?\n3. 원리를 설명 해 보세요.\n4. 그 판단의 근거를 말해 보세요.')}`;
  const questions = extractBookQuestions(source, 'synthetic.md', 'university');
  assert.equal(questions.length, 6);
  assert.ok(questions.every(question => !/학년도|결과보고서|^\d/u.test(question.questionText)));
  assert.ok(questions.find(question => question.questionText.startsWith('어떤 노력'))!.exclusions.includes('multiple_demands'));
  assert.equal(questions.find(question => question.questionText.startsWith('평가에'))!.questionText, '평가에 대해 이의를 제기해 보십시오.');
  assert.ok(questions.some(question => question.questionText === '원리를 설명 해 보세요.'));
  for (const question of questions) assert.equal(source.slice(question.source.startOffset, question.source.endOffset), question.rawText);
});

test('source, figure and cache-byte validation use no external providers and fail closed on changes', async t => {
  const temporary = await fixture(); t.after(temporary.close);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error('external calls forbidden in deterministic reference preparation'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const corpus = await prepareBookQuestionReferences(temporary);
  assert.equal(corpus.counts.uniqueFigureFiles, 1);
  assert.equal(corpus.counts.missingFigureFiles, 0);
  assert.equal(corpus.figures[0].sha256?.length, 64);
  assert.equal((await loadBookQuestionReferences(temporary.root))?.digest, corpus.digest);
  const savedPath = path.join(temporary.root, interviewReferenceFiles.preparedQuestionReferences);
  const saved = await readFile(savedPath, 'utf8');
  await writeFile(savedPath, saved.replace('관찰 결과를', '다른 자료를'));
  assert.equal(await loadBookQuestionReferences(temporary.root), null);
  await writeFile(savedPath, saved);
  const sourcePath = path.join(temporary.root, interviewReferenceFiles.bookUniversityMd);
  await writeFile(sourcePath, university + '\n수정');
  assert.equal(await loadBookQuestionReferences(temporary.root), null);
  await writeFile(sourcePath, university);
  await writeFile(path.join(temporary.root, interviewReferenceFiles.bookFiguresDirectory, 'fixture.png'), 'changed-image');
  assert.equal(await loadBookQuestionReferences(temporary.root), null);
  assert.notEqual((await prepareBookQuestionReferences(temporary)).digest, corpus.digest);
});

test('identical preparation reuses the artifact and rebuilding identical bytes preserves content identity', async t => {
  const temporary = await fixture(); t.after(temporary.close);
  const original = await prepareBookQuestionReferences(temporary);
  const repeated = await prepareBookQuestionReferences(temporary);
  assert.equal(repeated.generatedAt, original.generatedAt);
  assert.equal(repeated.digest, original.digest);
  const cachePath = path.resolve(temporary.root, interviewReferenceFiles.preparedQuestionReferences);
  assert.ok(cachePath.startsWith(`${path.resolve(temporary.root)}${path.sep}`));
  await rm(cachePath);
  const rebuilt = await prepareBookQuestionReferences(temporary);
  assert.equal(rebuilt.digest, original.digest);
  const universityPath = path.join(temporary.root, interviewReferenceFiles.bookUniversityMd);
  await writeFile(universityPath, university + '\n원문 변경');
  assert.notEqual((await prepareBookQuestionReferences(temporary)).digest, original.digest);
});

test('legacy or escaped figure paths are rejected; absent images are recorded without inventing passage content', async t => {
  const temporary = await fixture(); t.after(temporary.close);
  const file = path.join(temporary.root, interviewReferenceFiles.bookContentMd);
  await writeFile(file, preparation + '\n![그림](<C:/old-project/.local/book-analysis/figures/fixture.png>)');
  await assert.rejects(prepareBookQuestionReferences(temporary), /현재 figures 폴더/u);
  await writeFile(file, preparation + `\n![그림](<${interviewReferenceFiles.bookFiguresDirectory}/missing.png>)`);
  const corpus = await prepareBookQuestionReferences(temporary);
  assert.equal(corpus.counts.missingFigureFiles, 1);
  assert.equal(corpus.figures[0].exists, false);
  assert.equal(corpus.figures[0].sha256, null);
});

test('runtime samples are a bounded question-only projection with citations and explicit provenance', async t => {
  const temporary = await fixture(); t.after(temporary.close);
  const corpus = await prepareBookQuestionReferences(temporary);
  assert.ok(corpus.questions.every(question => !question.runtimeApproved));
  assert.deepEqual(selectBookQuestionExamples(corpus, { primaryFunction: 'CHOICE' }), []);
  // The review is explicitly synthetic, source-bound, and never saved to the verified source cache.
  corpus.questions = corpus.questions.map(question => question.questionText.includes('실험 변인')
    ? reviewSyntheticReference(question, { primaryFunctions: ['CHOICE'] }) : question);
  const examples = selectBookQuestionExamples(corpus, { primaryFunction: 'CHOICE', topicText: '실험 변인 기준', limit: 3 });
  assert.ok(examples.length > 0 && examples.length <= 3);
  assert.equal(examples[0].usage, 'direct_example');
  assert.ok(examples[0].questionText);
  assert.match(examples[0].questionText, /실험 변인/u);
  assert.ok(examples.every(example => Object.keys(example.source).sort().join(',') === ['path', 'sha256', 'pdfPage', 'startLine', 'endLine'].sort().join(',')));
  const payload = JSON.stringify(examples);
  assert.doesNotMatch(payload, /합성대학교|면접 시간|20%|실험조장|학생답안|rawText|universityLabel/u);
  assert.deepEqual(selectBookQuestionExamples(null, { primaryFunction: 'CHOICE' }), []);
  assert.deepEqual(selectBookQuestionExamples(corpus, { primaryFunction: 'CHOICE', limit: 0 }), []);
  const reviewedIds = new Set(corpus.questions.filter(question => question.analysis?.status === 'reviewed').map(question => question.id));
  for (const functionName of ['CHOICE', 'PROCESS', 'EVIDENCE', 'ROLE', 'LIMIT']) assert.ok(selectBookQuestionExamples(corpus, { primaryFunction: functionName, limit: 100 }).every(example => reviewedIds.has(example.id)));
  const duplicated = structuredClone(corpus);
  duplicated.questions.push(reviewSyntheticReference(extractBookQuestions(preparation, 'synthetic-duplicate.md', 'preparation')[0], { primaryFunctions: ['CHOICE'] }));
  const deduplicated = selectBookQuestionExamples(duplicated, { primaryFunction: 'CHOICE', limit: 8 });
  assert.equal(deduplicated.length, new Set(deduplicated.map(example => example.questionText)).size);
});

test('a manually changed runtime flag cannot replace source-bound semantic review', () => {
  const questions = extractBookQuestions(preparation, 'synthetic-content.md', 'preparation');
  for (const question of questions) question.runtimeApproved = true;
  const corpus = syntheticReferenceCorpus(questions);
  assert.equal(corpus.analysis?.coverage.reviewed, 0);
  assert.deepEqual(selectBookQuestionExamples(corpus, { primaryFunction: 'CHOICE' }), []);
});
