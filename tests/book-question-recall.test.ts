import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAdditionalBookQuestionCandidates } from '../server/data/book-question-recall';
import { extractBookQuestions } from '../server/data/book-question-reference';

const fenced = (body: string) => `\`\`\`text\n${body}\n\`\`\``;
const path = 'synthetic-recall.md';

test('recall finds unlabeled questions and inline alternatives with exact unrewritten source spans', () => {
  const source = `## 합성\n#### PDF 페이지 29\n${fenced('다음은 대학에서 서류 기반 면접 문제로 나왔던 유형들을 모아놓은 것이다.\n활동의 목적은 무엇인가?\n○○ 활동 준비 과정에서\n본인이 맡은 역할은 무엇인가?\n유사질문 : 왜 이 학과에 지원했나요? / 이루고 싶은 꿈은 무엇인가요?\n유사질문 : 관심 분야는 무엇인가요? 대학에서 하고 싶은 것은 무엇인가요?')}`;
  const found = extractAdditionalBookQuestionCandidates(source, path, 'preparation', []);
  assert.equal(found.length, 6);
  assert.equal(found[0].questionText, '활동의 목적은 무엇인가?');
  assert.equal(found[1].questionText, '○○ 활동 준비 과정에서 본인이 맡은 역할은 무엇인가?');
  for (const question of found) {
    assert.equal(source.slice(question.source.startOffset, question.source.endOffset), question.rawText);
    assert.equal(question.source.startLine, source.slice(0, question.source.startOffset).split('\n').length);
    assert.equal(question.source.pdfPage, 29);
    assert.equal(question.runtimeApproved, false);
    assert.equal(question.source.sha256.length, 64);
    assert.ok(!question.rawText.includes('유사질문'));
  }
});

test('answers and student-record narratives remain blocked across PDF fences until a question marker', () => {
  const source = `## 합성\n#### PDF 페이지 1\n${fenced('면접 질문\n그 선택의 기준은 무엇인가요?\n※ 개선된 답변 예시\n저는 왜 선택했을까요?')}\n#### PDF 페이지 2\n${fenced('제가 세운 기준은 무엇일까요?\n추가 질문\n그 기준의 한계는 무엇인가요?\n학생부 기록 내용\n본인은 어떤 활동을 했을까?\n면접 질문\n본인이 맡은 일은 무엇인가요?')}`;
  const found = extractAdditionalBookQuestionCandidates(source, path, 'preparation', []);
  assert.deepEqual(found.map(item => item.questionText), ['그 선택의 기준은 무엇인가요?', '그 기준의 한계는 무엇인가요?', '본인이 맡은 일은 무엇인가요?']);
  assert.equal(found[1].questionKind, 'follow_up');
});

test('recall never duplicates or cuts a candidate already covered by the explicit parser', () => {
  const source = `## 합성\n${fenced('면접 질문\n본인의 역할은 무엇인가요?\n추가 질문\n한계에 대한 본인의 생각을 밝혀보세요.')}`;
  const existing = extractBookQuestions(source, path, 'preparation');
  const found = extractAdditionalBookQuestionCandidates(source, path, 'preparation', existing);
  assert.ok(found.some(item => item.questionText.includes('밝혀보세요')));
  for (const question of found) for (const old of existing) assert.ok(question.source.endOffset <= old.source.startOffset || question.source.startOffset >= old.source.endOffset);
});

test('university documents alone do not establish past-question provenance', () => {
  const source = `### 1 합성대학교\n${fenced('지원한 이유는 무엇인가요?\n2. 면접 기출 문항: 학생부종합전형\n어떤 노력을 했나요?\n3. 면접 문항 예시\n그 경험에서 얻은 것은 무엇인가요?')}`;
  const found = extractAdditionalBookQuestionCandidates(source, path, 'university', []);
  assert.deepEqual(found.map(item => item.provenance), ['book_example', 'reported_past_question', 'book_example']);
});

test('OCR request spacing, department suffixes and newer Korean request endings survive recall', () => {
  const source = fenced('본인의 생각을 밝혀 보세요.\n낯설게 하는 방식에 대한 생각을 얘기해 보세요.\n치매 어르신을 돌본 경험은 어땠나요? (간호학과)\n어떤 원리인지 설명 해 보십시오.');
  const found = extractAdditionalBookQuestionCandidates(source, path, 'preparation', []);
  assert.equal(found.length, 4);
  assert.ok(found[2].rawText.endsWith('(간호학과)'));
});

test('instruction tails and table row labels do not become part of a question', () => {
  const source = fenced('다음은 서류 기반 면접 문제로 나왔던 유형들이다.\n변을 준비해 보자.\n활동의 동기를 설명할 수 있는가?\n2. 면접 기출 문항\n출제 항목\n전공명\n면접 문항\n지원 동기 및 자기소개\n전체 전공\n자기소개와 지원 동기를 말해보세요.');
  const found = extractAdditionalBookQuestionCandidates(source, path, 'university', []);
  assert.deepEqual(found.map(item => item.questionText), ['활동의 동기를 설명할 수 있는가?', '자기소개와 지원 동기를 말해보세요.']);
});

test('a slash inside a subject term is not an alternatives delimiter', () => {
  const source = fenced('유사질문 : 이론/원리의 한계는 무엇인가요? / 그 판단의 근거는 무엇인가요?');
  const found = extractAdditionalBookQuestionCandidates(source, path, 'preparation', []);
  assert.deepEqual(found.map(item => item.questionText), ['이론/원리의 한계는 무엇인가요?', '그 판단의 근거는 무엇인가요?']);
});
