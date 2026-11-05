import { createHash } from 'node:crypto';
import { BOOK_QUESTION_CORPUS_VERSION, BOOK_QUESTION_SELECTION_POLICY, bookQuestionReferenceUsage, extractBookQuestions, type BookQuestionCorpus, type BookQuestionReference } from '../../server/data/book-question-reference';
import { finalizeQuestionReferenceBatch, QUESTION_REFERENCE_ANALYSIS_POLICY, questionReferenceAnalysisCoverage, type QuestionReferenceReviewedRow } from '../../server/data/question-reference-analysis';

// Explicit source-bound synthetic classifications. No model, real book approval, or API is used.
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Demand = { quote: string; primaryFunction: QuestionReferenceReviewedRow['primaryFunctions'][number]; depth: QuestionReferenceReviewedRow['depth'] };
export type SyntheticReferenceReview = Partial<Pick<QuestionReferenceReviewedRow, 'category' | 'primaryFunctions' | 'depth' | 'strategies' | 'domain' | 'dependencies' | 'restrictions' | 'rationale'>> & { demands?: Demand[] };

export function reviewSyntheticReference(question: BookQuestionReference, options: SyntheticReferenceReview = {}): BookQuestionReference {
  const primaryFunctions = options.primaryFunctions ?? ['FACT'];
  const depth = options.depth ?? 'D2';
  const [analysis] = finalizeQuestionReferenceBatch({ items: [{
    questionId: question.id, category: options.category ?? 'direct_example', primaryFunctions, depth,
    strategies: options.strategies ?? ['factual_recall'], domain: options.domain ?? 'general',
    demands: options.demands ?? [{ quote: question.questionText, primaryFunction: primaryFunctions[0], depth }],
    dependencies: options.dependencies ?? { passage: false, figure: false, priorAnswer: false, institution: false },
    restrictions: options.restrictions ?? ['student_fact_binding_required'], rationale: options.rationale ?? '명시적 합성 질문 분석 결과',
  }] }, [question]);
  return { ...structuredClone(question), analysis, primaryFunctions: [...analysis.primaryFunctions], runtimeApproved: true };
}

export function syntheticReferenceQuestion(text: string, options: SyntheticReferenceReview & { id?: string; sourcePath?: string; reviewed?: boolean } = {}): BookQuestionReference {
  const sourcePath = options.sourcePath ?? 'synthetic-book.md';
  const document = `# 합성 면접 자료\n#### PDF 페이지 1\n\`\`\`text\n면접 질문\n${text}\n\`\`\``;
  const question = extractBookQuestions(document, sourcePath, 'preparation')[0];
  if (!question) throw new Error('Synthetic fixture must contain an explicit question');
  if (options.id) question.id = options.id;
  return options.reviewed === false ? question : reviewSyntheticReference(question, options);
}

export function syntheticReferenceCorpus(questions: BookQuestionReference[], version = 'first'): BookQuestionCorpus {
  const digest = hash(`synthetic-corpus:${version}:${JSON.stringify(questions)}`);
  const rows = questions.map(question => question.analysis ?? { questionId: question.id, status: 'pending' as const, sourceSha256: question.source.sha256, questionSha256: hash(question.rawText), failureCode: 'NOT_REVIEWED' as const });
  const coverage = questionReferenceAnalysisCoverage({ questions, sourceHashes: [] }, rows);
  const uses = questions.map(bookQuestionReferenceUsage);
  return {
    schemaVersion: BOOK_QUESTION_CORPUS_VERSION, policyVersion: BOOK_QUESTION_SELECTION_POLICY, runtimeReviewVersion: QUESTION_REFERENCE_ANALYSIS_POLICY,
    generatedAt: '2026-11-02T00:00:00.000Z', digest,
    sourceHashes: [...new Map(questions.map(question => [question.source.path, { path: question.source.path, sha256: question.source.sha256, lineCount: question.source.endLine, documentKind: 'preparation' as const }])).values()],
    figuresDirectory: '.local/book-analysis/figures', figures: [], questions,
    analysis: { key: hash(`synthetic-analysis:${digest}`), policyVersion: QUESTION_REFERENCE_ANALYSIS_POLICY, model: 'synthetic-reference-analysis', sourceFingerprint: hash(`sources:${digest}`), contentSha256: hash(JSON.stringify(rows)), coverage },
    counts: { scannedLines: questions.length, detectedQuestions: questions.length, eligibleQuestions: uses.filter(Boolean).length, excludedQuestions: uses.filter(use => !use).length, runtimeApprovedQuestions: uses.filter(Boolean).length, reportedPastQuestions: questions.filter(question => question.provenance === 'reported_past_question').length, bookExamples: questions.filter(question => question.provenance === 'book_example').length, uniqueFigureFiles: 0, missingFigureFiles: 0, excludedByReason: {}, analyzedQuestions: coverage.reviewed, pendingAnalysisQuestions: coverage.pending },
    interpretation: 'QUESTION_PATTERNS_ONLY_NOT_STUDENT_FACTS_OR_CURRENT_ADMISSION_POLICY',
  };
}
