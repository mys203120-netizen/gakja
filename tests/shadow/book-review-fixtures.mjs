import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { syntheticJpeg, syntheticPng } from './media-fixtures.ts';

// These inputs are authored synthetic data, including the explicit synthetic
// review outputs. They prove persistence/reader gates, never human or session
// approval. All domain construction below is loaded from the caller's exact C
// checkout; no candidate codec, path rewriter, or alternate approval gate runs.
const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const moduleAt = (codeRoot, relative) => import(pathToFileURL(path.join(codeRoot, relative)).href);
async function save(root, reference, bytes) {
  const file = path.resolve(root, reference), relative = path.relative(path.resolve(root), file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PR07D_FIXTURE_PATH_INVALID');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: 'wx' });
}
const artifact = (artifactId, role, reference, objectKind, extra = {}) => ({ artifactId, role, reference,
  selection: 'dependency', objectKind, scope: 'common', required: true, availability: 'present',
  source: { rootId: 'fixture', relativePath: reference }, classification: 'dependency', dependencies: [], ...extra });
const dependency = artifactId => ({ artifactId, required: true });

export async function buildShadowBookFixture({ codeRoot, root }) {
  const { interviewReferenceFiles: refs } = await moduleAt(codeRoot, 'interview-files.mjs');
  const books = await moduleAt(codeRoot, 'server/data/book-question-reference.ts');
  const reviews = await moduleAt(codeRoot, 'server/data/question-reference-analysis.ts');
  const strategies = await moduleAt(codeRoot, 'server/data/question-strategy-catalog.ts');
  const adjudication = await moduleAt(codeRoot, 'server/data/question-reference-adjudication.ts');
  const pngRef = path.posix.join(refs.bookFiguresDirectory, 'public-shadow-pixels.png');
  const jpegRef = path.posix.join(refs.bookFiguresDirectory, 'public-shadow-pixels.jpg');
  const fenced = body => '```text\n' + body + '\n```';
  // New prose and question wording; no original book examples are copied.
  const content = '# 공개 합성 질문 자료\n#### PDF 페이지 1\n' + fenced('면접 질문\n합성 센서를 보정할 때 어떤 순서로 진행했나요?') +
    `\n![합성 단색 PNG](<${pngRef}>)\n![합성 단색 JPEG](<${jpegRef}>)\n`;
  const university = '# 공개 합성 대학별 자료\n### 1 합성대학교\n#### PDF 페이지 2\n' +
    fenced('2. 면접 기출 문항\n학과\n기출 문항\n합성학과\n· 합성 표본을 관찰할 때 어떤 순서로 진행했나요?') + '\n';
  await save(root, refs.bookContentMd, content); await save(root, refs.bookUniversityMd, university);
  await save(root, pngRef, syntheticPng()); await save(root, jpegRef, syntheticJpeg());
  await save(root, adjudication.QUESTION_REFERENCE_ADJUDICATION_FILE, json({
    schemaVersion: adjudication.QUESTION_REFERENCE_ADJUDICATION_SCHEMA,
    policyVersion: adjudication.QUESTION_REFERENCE_ADJUDICATION_POLICY, entries: [],
  }));
  const raw = await books.prepareBookQuestionReferences({ root });
  if (!raw.questions.length) throw new Error('PR07D_SYNTHETIC_BOOK_EMPTY');
  let syntheticReviewCalls = 0, syntheticStrategyCalls = 0;
  const analysis = await reviews.analyzeQuestionReferences(raw, { root, requestBatch: async (_request, questions) => {
    syntheticReviewCalls++;
    return { items: questions.map(question => ({ questionId: question.id, category: 'direct_example',
      primaryFunctions: ['PROCESS'], depth: 'D2', strategies: ['process'], domain: 'stem',
      demands: [{ quote: question.questionText, primaryFunction: 'PROCESS', depth: 'D2' }],
      dependencies: { passage: false, figure: false, priorAnswer: false, institution: false },
      restrictions: ['student_fact_binding_required'], rationale: '명시적 합성 원문의 단일 수행 순서 요구를 검수한다.' })) };
  } });
  const prepared = await books.prepareBookQuestionReferences({ root });
  const corpus = await books.loadBookQuestionReferences(root);
  if (!corpus || corpus.digest !== prepared.digest || !analysis.coverage.complete || corpus.figures.length !== 2 ||
      corpus.figures.some(figure => !figure.exists || !figure.sha256)) throw new Error('PR07D_SYNTHETIC_BOOK_GATE_REJECTED');
  const catalog = await strategies.prepareQuestionStrategyCatalog(corpus, { root, runLive: true,
    requestBatch: async (_request, items) => { syntheticStrategyCalls++; return { items: items.map(item => ({
      questionId: item.questionId, operations: ['process'], trigger: 'method', requiredClaimSlots: ['actual_action'],
      expectedEvidence: 'one_step', anchorMode: 'none', directness: 'direct',
      relation: { kind: 'unknown', targetQuestionId: null, condition: 'none', supportQuote: null },
    })) }; } });
  const loadedStrategies = await strategies.loadQuestionStrategyCatalog(corpus, { root });
  if (!catalog.coverage.complete || !catalog.cards.length || loadedStrategies?.contentSha256 !== catalog.contentSha256)
    throw new Error('PR07D_SYNTHETIC_STRATEGY_GATE_REJECTED');
  const analysisBase = path.join('data', 'prepared', 'question-reference-analysis', analysis.key);
  const strategyBase = path.join('data', 'prepared', 'question-strategies', catalog.key);
  const artifacts = [
    artifact('book-source-1', 'book-source', refs.bookContentMd, 'source-markdown'),
    artifact('book-source-2', 'book-source', refs.bookUniversityMd, 'source-markdown'),
    artifact('book-png', 'book-figure', pngRef, 'source-image', { mediaType: 'image/png' }),
    artifact('book-jpeg', 'book-figure', jpegRef, 'source-image', { mediaType: 'image/jpeg' }),
    artifact('book-adjudications', 'book-adjudications', adjudication.QUESTION_REFERENCE_ADJUDICATION_FILE, 'review-bundle'),
    artifact('book-analysis-snapshot', 'book-analysis-snapshot', analysisBase + '.json', 'review-bundle', { dependencies: ['book-source-1', 'book-source-2'].map(dependency) }),
    artifact('book-analysis-journal', 'book-analysis-journal', analysisBase + '.jsonl', 'review-journal', { dependencies: ['book-source-1', 'book-source-2'].map(dependency) }),
    artifact('book-corpus', 'book-corpus', refs.preparedQuestionReferences, 'source-json', { dependencies:
      ['book-source-1', 'book-source-2', 'book-png', 'book-jpeg', 'book-adjudications', 'book-analysis-snapshot', 'book-analysis-journal'].map(dependency) }),
    artifact('strategy-snapshot', 'strategy-snapshot', strategyBase + '.json', 'review-bundle', { dependencies: [dependency('book-corpus')] }),
    artifact('strategy-journal', 'strategy-journal', strategyBase + '.jsonl', 'review-journal', { dependencies: [dependency('book-corpus')] }),
  ];
  return { corpus, analysis, catalog, artifacts, syntheticReviewCalls, syntheticStrategyCalls, paidProviderCalls: 0,
    classification: 'public-authored-synthetic-book-and-explicit-synthetic-classifications; no human or evaluation approval' };
}

export async function buildShadowReviewChainFixture({ codeRoot, root, context, source, wire }) {
  const analysis = await moduleAt(codeRoot, 'server/data/full-student-analysis.ts');
  const authorityModule = await moduleAt(codeRoot, 'server/data/question-review-authority.ts');
  const reviewedAt = '2026-11-07T00:00:00.000Z';
  const proposalRef = 'data/prepared/student-analysis-proposals/public-shadow-parent.json';
  const reviewRef = 'artifacts/public-shadow-source-review.json';
  const proposal = json({ codecVersion: analysis.STUDENT_ANALYSIS_CODEC_VERSION, sourceContentSha256: source.contentSha256,
    model: 'explicit-synthetic-parent-proposal', status: 'completed', input: wire });
  const sourceReviewBytes = json({ classification: 'explicit-synthetic-source-review-not-human-approval',
    sourceContentSha256: source.contentSha256, reviewedAt, reviewedSourceIds: source.blocks.map(block => block.id) });
  await save(root, proposalRef, proposal); await save(root, reviewRef, sourceReviewBytes);
  const sourceReview = { version: 'bounded-academic-source-review-v1', reviewer: 'codex-source-review',
    parentProposalPath: proposalRef, parentProposalSha256: hash(proposal), parentAnalysisRevision: 'explicit-synthetic-parent',
    artifactPath: reviewRef, artifactSha256: hash(sourceReviewBytes), reviewedAt, scope: 'explicit_visually_reviewed_academic_rows_only' };
  const materialized = analysis.materializeFullStudentAnalysis(context, source, wire,
    { model: 'explicit-synthetic-source-review-model', generatedAt: reviewedAt, sourceReview });
  const base = await analysis.saveFullStudentAnalysis(materialized, source, root);
  const objective = materialized.target.objectives.find(row => row.primaryFunction === 'PROCESS') ?? materialized.target.objectives[0];
  if (!objective || !objective.targetEvidence.length) throw new Error('PR07D_REVIEW_FIXTURE_OBJECTIVE_MISSING');
  const questionText = '합성 기록에 나온 수행의 순서를 설명해 주세요.', questionSha256 = hash(questionText);
  const correction = { objectiveId: objective.id, previousQuestionIntent: objective.questionIntent,
    previousTargetEvidence: objective.targetEvidence, questionIntent: objective.questionIntent,
    targetEvidence: [objective.targetEvidence[0]], reviewedQuestionSha256: questionSha256 };
  const contractReviewRef = 'artifacts/public-shadow-question-contract-review.json';
  const contractBytes = json({ classification: 'explicit-synthetic-question-contract-review-not-human-or-session-approval',
    reviewedAt, corrections: [correction] });
  await save(root, contractReviewRef, contractBytes);
  const reviewModel = 'explicit-synthetic-independent-review';
  const reviewed = await analysis.publishReviewedObjectiveContracts(context, [correction],
    { artifactSha256: hash(contractBytes), model: reviewModel, reviewedAt }, root, { activate: false, baseRevisionPath: base.revisionPath });
  const unrelated = reviewed.target.objectives.find(row => row.id !== objective.id);
  if (!unrelated || !unrelated.targetEvidence.length) throw new Error('PR07D_REVIEW_FIXTURE_SECOND_OBJECTIVE_MISSING');
  const unrelatedRef = 'artifacts/public-shadow-unrelated-contract-review.json';
  const unrelatedCorrection = { objectiveId: unrelated.id, previousQuestionIntent: unrelated.questionIntent,
    previousTargetEvidence: unrelated.targetEvidence, questionIntent: unrelated.questionIntent,
    targetEvidence: [unrelated.targetEvidence[0]], reviewedQuestionSha256: hash('별도의 합성 목적 질문') };
  const unrelatedBytes = json({ classification: 'explicit-synthetic-unrelated-review-not-human-or-session-approval',
    reviewedAt, corrections: [unrelatedCorrection] });
  await save(root, unrelatedRef, unrelatedBytes);
  const parent = await analysis.publishReviewedObjectiveContracts(context, [unrelatedCorrection],
    { artifactSha256: hash(unrelatedBytes), model: 'explicit-synthetic-unrelated-review', reviewedAt }, root,
    { activate: false, baseRevisionPath: reviewed.revisionPath });
  const entity = materialized.common.activities[0], evidence = materialized.evidence.find(row => row.originEntityId === entity?.id);
  if (!entity || !evidence) throw new Error('PR07D_REVIEW_FIXTURE_ENTITY_MISSING');
  const extension = { originKind: 'record_gap', entityIds: [entity.id], evidenceIds: [evidence.id], primaryFunction: 'ROLE', depth: 'D1',
    questionIntent: '합성 공동 기록에서 개인 수행 여부를 열린 질문으로 확인', targetEvidence: ['개인 수행 범위의 존재와 내용'],
    semanticKey: 'public-synthetic-open-role-gap', selectionBasis: '공동 기록과 미확인 개인 수행을 분리한다.',
    unknowns: ['개인이 직접 수행한 범위'], forbiddenPremises: ['공동 활동을 모두 학생 개인이 수행했다고 단정'] };
  const extensionRef = 'artifacts/public-shadow-objective-source-review.json';
  const extensionBody = { version: 'bounded-record-source-purpose-review-v1', reviewerId: 'explicit-synthetic-source-purpose-review',
    reviewedAt, sourcePdfSha256: source.pdfSha256, commonContentSha256: parent.common.contentSha256,
    parentTargetContentSha256: parent.target.contentSha256, parentAnalysisPath: parent.revisionPath, extensions: [extension],
    classification: 'explicit-synthetic-source-purpose-review-not-human-or-session-approval' };
  const extensionBytes = json(extensionBody); await save(root, extensionRef, extensionBytes);
  const child = await analysis.stageReviewedObjectiveExtensions(context, [extension], { artifactPath: extensionRef,
    artifactSha256: hash(extensionBytes), reviewerId: extensionBody.reviewerId, reviewedAt }, root, parent.revisionPath);
  await analysis.loadStagedFullStudentAnalysisSnapshot(context, child.revisionPath, root);
  const reviewContext = { ...context, studentAnalysis: child.common, targetAnalysis: child.target,
    manifest: { ...context.manifest, files: [...context.manifest.files.filter(row => row.role !== 'fullStudentAnalysis'),
      { role: 'fullStudentAnalysis', path: child.revisionPath, sha256: hash(await readFile(path.resolve(root, child.revisionPath))) }] } };
  const authority = await authorityModule.resolveQuestionReviewAuthority(reviewContext, objective.id, questionSha256, reviewModel, root);
  if (authority?.kind !== 'unchanged_objective_ancestor_review' || authority.chain.length !== 2)
    throw new Error('PR07D_SYNTHETIC_REVIEW_ANCESTRY_GATE_REJECTED');
  const analysisArtifact = (id, value, dependencies) => artifact(id, 'analysis-document', value.revisionPath, 'analysis-json', {
    selection: 'staged', scope: 'target', sourceRevision: source.revision, legacyId: value.target?.revision ?? materialized.target.revision,
    dependencies: dependencies.map(dependency), aliases: [
      { role: 'analysis-document', reference: value.revisionPath, selection: 'review-parent' },
      { role: 'review-parent-envelope', reference: value.revisionPath, selection: 'dependency' },
    ],
  });
  const artifacts = [
    artifact('review-proposal', 'review:parent-proposal', proposalRef, 'review-bundle', { scope: 'target', sourceRevision: source.revision }),
    artifact('review-source', 'review:analysis-source-review', reviewRef, 'review-bundle', { scope: 'target', sourceRevision: source.revision }),
    artifact('review-contract', 'review:question-contract-review', contractReviewRef, 'review-bundle', { scope: 'target', sourceRevision: source.revision }),
    artifact('review-unrelated-contract', 'review:question-contract-review', unrelatedRef, 'review-bundle', { scope: 'target', sourceRevision: source.revision }),
    artifact('review-extension', 'review:objective-source-review', extensionRef, 'review-bundle', { scope: 'target', sourceRevision: source.revision,
      dependencies: [dependency('review-parent')] }),
    analysisArtifact('review-base', base, ['source', 'review-proposal', 'review-source']),
    analysisArtifact('review-approved-parent', reviewed, ['review-base', 'review-contract']),
    analysisArtifact('review-parent', parent, ['review-approved-parent', 'review-unrelated-contract']),
    analysisArtifact('review-child', child, ['review-parent', 'review-extension']),
  ];
  for (const [id, value] of [['review-base', base], ['review-approved-parent', reviewed], ['review-parent', parent], ['review-child', child]]) artifacts.push(
    artifact(id + '-qa', 'analysis-qa', value.manifestPath, 'review-bundle', { scope: 'target', sourceRevision: source.revision,
      dependencies: [dependency(id)] }));
  return { base, reviewed, parent, child, reviewContext, objectiveId: objective.id, questionSha256, questionText, reviewModel, authority, artifacts,
    approvedEvaluationCount: 0, paidProviderCalls: 0, classification: 'public explicit-synthetic source/review ancestry; no production activation or real approval' };
}
