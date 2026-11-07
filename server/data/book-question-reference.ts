import type { AnalysisReadOptions } from '../repositories/analysis-read-ports';
import { readDependency, throwIfShadowReadFailure } from '../repositories/artifact-read';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { interviewReferenceFiles } from '../../interview-files.mjs';
import { loadQuestionReferenceAnalysis, QUESTION_REFERENCE_ANALYSIS_POLICY, type QuestionReferenceAnalysisCoverage, type QuestionReferenceAnalysisRow, type QuestionReferenceReviewedRow } from './question-reference-analysis';
import { extractAdditionalBookQuestionCandidates } from './book-question-recall';
import { applyQuestionReferenceAdjudications, type QuestionReferenceAdjudicationSummary } from './question-reference-adjudication';

export const BOOK_QUESTION_CORPUS_VERSION = 'book-question-reference-v1';
export const BOOK_QUESTION_SELECTION_POLICY = 'whole-source-semantic-reference-retrieval-v2';
export type BookQuestionReferenceUsage = 'direct_example' | 'compound_strategy' | 'contextual_strategy';
type Provenance = 'reported_past_question' | 'book_example';
type DocumentKind = 'preparation' | 'university';
type Exclusion = 'multiple_demands' | 'passage_or_figure_required' | 'administrative_content' | 'sensitive_personal_question' | 'institutional_trivia' | 'rapport_or_unobserved_setting' | 'incomplete_or_ambiguous_question' | 'question_too_long';
type SourceFile = { path: string; sha256: string; lineCount: number; documentKind: DocumentKind };
export interface BookQuestionSource {
  path: string; sha256: string; pdfPage: number | null; startLine: number; endLine: number;
  startOffset: number; endOffset: number; section: string; universityLabel?: string;
}
export interface BookQuestionReference {
  id: string; questionText: string; rawText: string; provenance: Provenance;
  questionKind: 'main' | 'follow_up' | 'unspecified'; primaryFunctions: string[];
  source: BookQuestionSource; eligibility: 'eligible' | 'excluded' | 'pending'; exclusions: Exclusion[];
  runtimeApproved: boolean;
  /** Every candidate has an analysis state; no manually enumerated ID whitelist is consulted. */
  analysis?: QuestionReferenceAnalysisRow;
  screeningFlags?: Exclusion[];
}
interface FigureReference { sourcePath: string; sourceLine: number; path: string; sha256: string | null; exists: boolean }
export interface BookQuestionCorpus {
  schemaVersion: typeof BOOK_QUESTION_CORPUS_VERSION; policyVersion: typeof BOOK_QUESTION_SELECTION_POLICY;
  runtimeReviewVersion: string;
  analysis?: { key: string; policyVersion: string; model: string; sourceFingerprint: string; contentSha256: string; coverage: QuestionReferenceAnalysisCoverage; adjudicationSummary?: QuestionReferenceAdjudicationSummary };
  generatedAt: string; digest: string; sourceHashes: SourceFile[]; figuresDirectory: string;
  figures: FigureReference[]; questions: BookQuestionReference[];
  counts: { scannedLines: number; detectedQuestions: number; eligibleQuestions: number; runtimeApprovedQuestions: number; excludedQuestions: number; reportedPastQuestions: number; bookExamples: number; uniqueFigureFiles: number; missingFigureFiles: number; excludedByReason: Record<string, number>; screeningFlagsByReason?: Partial<Record<Exclusion, number>>; analyzedQuestions?: number; pendingAnalysisQuestions?: number; directExamples?: number; compoundStrategies?: number; contextualStrategies?: number; restrictedQuestions?: number; unresolvedQuestions?: number };
  interpretation: 'QUESTION_PATTERNS_ONLY_NOT_STUDENT_FACTS_OR_CURRENT_ADMISSION_POLICY';
}
export interface BookQuestionExample {
  id: string; questionText?: string; provenance: Provenance;
  questionKind: BookQuestionReference['questionKind']; primaryFunctions: string[];
  usage?: BookQuestionReferenceUsage;
  depth?: string;
  domain?: string;
  strategies?: string[];
  /** A compound source contributes one exact request span, never its entire multi-task question. */
  atomicDemand?: { quote: string; primaryFunction: string; depth: string };
  dependencies?: QuestionReferenceReviewedRow['dependencies'];
  restrictions?: QuestionReferenceReviewedRow['restrictions'];
  source: Pick<BookQuestionSource, 'path' | 'sha256' | 'pdfPage' | 'startLine' | 'endLine'>;
}
type CorpusOptions = { root?: string; sourcePaths?: [string, string]; figuresDirectory?: string; readOptions?: AnalysisReadOptions };
type QuestionSection = { provenance: Provenance; kind: BookQuestionReference['questionKind']; passageRequired: boolean };
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const normalized = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
const compact = (value: string) => value.replace(/\s+/gu, '');
const administrative = /면접\s*(?:일정|시간|위원|평가\s*비율|방법|전형)|(?:전형|평가)\s*(?:반영\s*비율|단계별\s*배점)|입학처|모집\s*인원|전형료|입실\s*시간|주소\s*[:：]|전화\s*[:：]/u;
const ending = /[?？]\s*$|(?:알려|(?:설명|말|말씀|이야기|서술|제시|비교|답변|답|소개|제기)\s*(?:해|하)).{0,14}(?:주세요|보세요|주십시오|보시오|보십시오|하시오|주시오|시오|세요|십시오|바랍니다|주겠습니까|주실래요)[.!。]?\s*$/u;
const sensitive = /부모님|부모의\s*직업|가족의\s*(?:직업|소득)|종교|신앙|교회|기독교|예수|목회|신학|세례|출신\s*지역|정치\s*성향|경제\s*형편/u;
const dependency = /제시문|다음(?:의)?\s*(?:글|그림|도표|그래프|자료)|(?:위|아래)(?:의)?\s*(?:그림|도표|그래프|표)|\[자료\s*\d|그림\s*\d|<자료|〈자료|위의\s*상황/u;
const questionLabels = /^(?:학과|학과명|모집단위|평가\s*(?:요소|항목)|유형|분류|구분|전공\s*적합성|전공\s*관심도|인성|학업\s*(?:의지|태도)|종합적\s*사고력|논리적\s*표현력|(?:학업|진로|공동체|학습|전공|탐구|의사소통)\s*역량|기출\s*문항(?:\s*예시)?|질문\s*예시|주요\s*면접\s*질문|서류\s*기반\s*면접)$/u;

function linesOf(text: string) {
  return [...text.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/gu)].filter(match => match[0].length > 0).map((match, index) => ({ text: match[1], start: match.index!, end: match.index! + match[1].length, number: index + 1 }));
}
function functionsFor(text: string) {
  const rules: Array<[string, RegExp]> = [
    ['MOTIVE', /계기|동기|지원한?\s*이유|지원하게|관심을\s*갖/u],
    ['ROLE', /역할|본인[이의]?\s*(?:직접|행동|기여)|맡았|기여한/u],
    ['PROCESS', /과정|절차|방법|단계|어떻게|해결했/u],
    ['CHOICE', /선택|선정|기준|결정|왜/u],
    ['EVIDENCE', /근거|검증|뒷받침|신뢰|판단한|어떻게\s*확인/u],
    ['RESULT', /결과|얻었|알게\s*된|배운|느낀|성과/u],
    ['CONCEPT', /원리|개념|의미|정의|무엇인(?:가|지)|무엇을\s*뜻/u],
    ['LIMIT', /한계|오차|불확실|주의|제약|어려움/u],
    ['ALTERNATIVE', /대안|개선|보완|다시\s*한다면|다르게/u],
    ['TRANSFER', /적용|활용|다른\s*상황/u],
    ['CONNECTION', /연결|관련|연계|영향/u],
    ['VALUE', /가치|중요|우선|윤리|원칙/u],
    ['VERIFY_CLAIM', /근거|주장|정확|모순/u],
    ['CLARIFY_CONTENT', /구체|자세|실제|예를\s*들/u],
  ];
  const values = rules.filter(([, pattern]) => pattern.test(text)).map(([key]) => key);
  return values.length ? values : ['FACT'];
}
function exclusionReasons(text: string): Exclusion[] {
  const reasons: Exclusion[] = [];
  if (administrative.test(text) || /https?:\/\/|\d{2,3}\)\s*\d{3,4}-\d{4}|\d+(?:\.\d+)?\s*%|\|/u.test(text)) reasons.push('administrative_content');
  if (sensitive.test(text)) reasons.push('sensitive_personal_question');
  if (dependency.test(text) || /(?:그림|그래프|도표).{0,18}(?:보고|보면서|참고|그려|표현)/u.test(text)) reasons.push('passage_or_figure_required');
  const demandEndings = text.match(/[?？]|(?:설명|말|말씀|이야기|서술|제시|비교|답변|답|소개|제기)\s*(?:해|하)\s*(?:주세요|보세요|주십시오|보시오|보십시오|하시오|주시오|시오|세요|십시오|바랍니다)[.!。]?/gu) ?? [];
  const compoundDemand = /(?:무엇이?었?으며|어떻게\s*했으며|선정했으며)|(?:또한|그리고|아울러|또\s).{0,70}(?:설명|말해|무엇|왜|어떻게)|(?:무엇|어떤).{0,50}(?:이며|이고|있었으며|있으며).{0,60}(?:무엇|어떤|왜|어떻게|생각)|(?:이유|동기|계기|과정|방법|역할|원리)(?:와|과|\s*및)\s*(?:결과|이유|과정|역할|참고한\s*문헌)|(?:노력|계기)(?:와|과).{0,40}(?:계기|과정|느낀)|어떻게.{0,40}(?:고|며)[,，]?.{0,30}어떻게|어떤\s*것이\s*있으며.{0,40}(?:생각|의견)|(?:설명하고|정의하고|제시하고|소개하고|말하고|이야기하고).{0,90}(?:설명|말해|무엇|왜|어떻게|느낀|방향)|(?:책과|책의\s*내용과).{0,30}(?:배우|배운|성장한|느낀)|그\s*이유(?:도|는)?/u;
  if (demandEndings.length > 1 || compoundDemand.test(text) || /어떤.{0,45}(?:하였고|했고|였고).{0,45}(?:의미|어떤)/u.test(text)) reasons.push('multiple_demands');
  if (/(?:본교|우리\s*대학|대학교).{0,30}(?:인재상|교훈|교육\s*목표|교육\s*철학).{0,30}(?:말해|알고|설명)|인재상에.{0,18}(?:설명|말해)/u.test(text)) reasons.push('institutional_trivia');
  if (/(?:오시는?\s*데|오는데).{0,20}(?:멀|힘들|어려)|오래\s*기다리|아침.{0,12}(?:먹|드셨)|어제.{0,12}꿈/u.test(text)) reasons.push('rapport_or_unobserved_setting');
  if (text.length < 8 || !ending.test(text) || /(?:답변\s*예시|예시\s*답변|관련\s*학과|면접\s*키워드)/u.test(text) || /^(?:설명|말씀|이야기|말|답변|제시)해\s*(?:주세요|보세요)[.!。]?$/u.test(text)) reasons.push('incomplete_or_ambiguous_question');
  if (text.length > 360) reasons.push('question_too_long');
  return [...new Set(reasons)];
}

/** Scan explicit question fields only. A question mark elsewhere in prose or an answer does not qualify. */
export function extractBookQuestions(text: string, sourcePath: string, documentKind: DocumentKind): BookQuestionReference[] {
  const sourceSha = digest(text), questions: BookQuestionReference[] = [];
  let page: number | null = null, section = '', universityLabel: string | undefined, inText = false, passageContext = false;
  let mode: QuestionSection | null = null;
  let pending: { start: number; end: number; startLine: number; endLine: number } | null = null;
  const flush = () => {
    if (!pending || !mode) { pending = null; return; }
    const rawText = text.slice(pending.start, pending.end), questionText = normalized(rawText);
    if (questionText && (ending.test(questionText) || /[?？]/u.test(questionText))) {
      const exclusions = exclusionReasons(questionText);
      if (mode.passageRequired && !exclusions.includes('passage_or_figure_required')) exclusions.push('passage_or_figure_required');
      const id = `BOOKQ-${digest(`${sourcePath}:${pending.start}:${rawText}`).slice(0, 20)}`;
      questions.push({ id, questionText, rawText, provenance: mode.provenance, questionKind: mode.kind, primaryFunctions: functionsFor(questionText), source: { path: sourcePath, sha256: sourceSha, pdfPage: page, startLine: pending.startLine, endLine: pending.endLine, startOffset: pending.start, endOffset: pending.end, section, ...(universityLabel ? { universityLabel } : {}) }, eligibility: exclusions.length ? 'excluded' : 'eligible', exclusions, runtimeApproved: false });
    }
    pending = null;
  };
  for (const line of linesOf(text)) {
    const trimmed = line.text.trim(), squashed = compact(trimmed);
    const pageMatch = /^####\s+PDF\s+페이지\s+(\d+)/u.exec(trimmed);
    if (pageMatch) { flush(); page = Number(pageMatch[1]); continue; }
    if (/^#{1,3}\s/u.test(trimmed)) {
      flush(); section = trimmed.replace(/^#+\s*/u, ''); mode = null; passageContext = false;
      if (documentKind === 'university') universityLabel = /^###\s+\d+\s+(.+)/u.exec(trimmed)?.[1]?.trim();
      continue;
    }
    if (/^```/u.test(trimmed)) { flush(); inText = /^```text/u.test(trimmed) ? true : false; continue; }
    if (!inText) continue;
    if (!trimmed) { flush(); continue; }
    if (/^[\[【(]?(?:답변예시|예시답변|예시답안|모범답안|학생답안|학생답변|해설|관련학과|면접키워드|학생부기록내용|교과세특기록내용)(?:\d+)?[\]】)]?[:：]?$/u.test(squashed)) { flush(); mode = null; continue; }
    if (/^(?:\d+[.)])?.*(?:면접개요|면접방법|평가내용|평가방법|전형별.*세부정보|참고문헌|면접일정|평가시간|준비시간)$/u.test(squashed) || /^(?:입학처|출처\s*[:：])/u.test(trimmed)) { flush(); mode = null; continue; }
    const explicit = squashed.length < 80 && !/[?？]/u.test(trimmed) && /^(?:\d+[.)])?(?:\d{4}학년도)?(?:개방형)?(?:면접질문|추가질문|질문예시|주요면접질문|면접기출문항|기출문항(?:예시)?|면접문항예시|전형별면접기출문항예시|학생부종합전형면접문항예시)(?:\([^)]*\))?$/u.test(squashed);
    if (explicit) {
      flush();
      // A bare table heading inherits the explicitly labelled example section across PDF pages.
      const preceding = mode as QuestionSection | null;
      const provenance: Provenance = documentKind === 'preparation' || /예시/u.test(squashed) ? 'book_example' : /^기출문항$/u.test(squashed) && preceding?.provenance === 'book_example' ? 'book_example' : 'reported_past_question';
      passageContext = /제시문/u.test(squashed) || /^기출문항(?:예시)?$/u.test(squashed) && passageContext;
      mode = { provenance, kind: /추가질문/u.test(squashed) ? 'follow_up' : documentKind === 'preparation' ? 'main' : 'unspecified', passageRequired: passageContext };
      continue;
    }
    if (!mode) continue;
    if (/^(?:\d+[.)])?(?:선행학습영향평가결과보고서사례|대학안내자료사례)$/u.test(squashed)) { flush(); mode = { ...mode, provenance: 'book_example' }; continue; }
    if (/^(?:[❖◆▶]\s*)?(?:다음|아래|위).{0,15}(?:제시문|글).{0,20}(?:읽고|답변)|^[❖◆]\s*제시문\s*\d|^자료\s*\d+$|^다음(?:은|의)?.{0,15}(?:자료|기사|글|제시문)/u.test(trimmed)) { flush(); passageContext = true; mode = { ...mode, passageRequired: true }; continue; }
    if (questionLabels.test(trimmed) || /^\d{1,3}$/u.test(trimmed) || /성공적인\s*대입을\s*위한\s*면접\s*바이블|^서울\s*지역$|^비서울\s*지역$/u.test(trimmed) || /(?:학과|학부|전공|계열)$/u.test(trimmed) && !ending.test(trimmed)) { flush(); continue; }
    if (administrative.test(trimmed)) { flush(); mode = null; continue; }
    const bullet = /^(?:[·•▪◦●▶-]\s*|\d+(?:-\d+)?\s*[.)]\s+)/u.exec(trimmed)?.[0] ?? '';
    if (bullet) flush();
    const label = /^(?:\|[^|\r\n]{1,40}\|\s*|\[(?:학업|진로|공동체|전공|탐구)\s*역량\]\s*)/u.exec(trimmed.slice(bullet.length))?.[0] ?? '';
    const body = trimmed.slice(bullet.length + label.length);
    if (!body) continue;
    if (dependency.test(body)) { passageContext = true; mode = { ...mode, passageRequired: true }; }
    const start = line.start + line.text.indexOf(trimmed) + bullet.length + label.length;
    if (!pending) pending = { start, end: line.end, startLine: line.number, endLine: line.number };
    else { pending.end = line.end; pending.endLine = line.number; }
    if (ending.test(body)) flush();
  }
  flush();
  return questions;
}

function configured(options: CorpusOptions = {}) {
  return { root: path.resolve(options.root ?? process.cwd()), sourcePaths: options.sourcePaths ?? [interviewReferenceFiles.bookContentMd, interviewReferenceFiles.bookUniversityMd] as [string, string], figuresDirectory: options.figuresDirectory ?? interviewReferenceFiles.bookFiguresDirectory, readOptions: options.readOptions };
}
/** Old absolute links are document provenance only, never filesystem read paths. */
function isRelocatedFigureLink(value: string, relative: string) {
  if (/[\u0000-\u001f\u007f%?#<>"|*]/u.test(value) || value.includes('//') || value.split('/').some(part => part === '.' || part === '..')) return false;
  if (!/^(?:[A-Za-z]:\/|\/)/u.test(value) || /^(?:[A-Za-z]:\/|\/)/u.test(relative)) return false;
  if (/^[A-Za-z]:\//u.test(value) && value.slice(2).includes(':')) return false;
  return value.endsWith(`/${relative}`);
}
async function preservedFigureBindings(settings: ReturnType<typeof configured>, sources: SourceFile[]): Promise<BookQuestionCorpus | null> {
  try {
    const corpus = JSON.parse((await readDependency(settings.root, interviewReferenceFiles.preparedQuestionReferences, 'book-corpus', settings.readOptions))!.bytes.toString('utf8')) as BookQuestionCorpus;
    if (corpus.schemaVersion !== BOOK_QUESTION_CORPUS_VERSION || corpus.policyVersion !== BOOK_QUESTION_SELECTION_POLICY ||
      corpus.figuresDirectory !== settings.figuresDirectory || !Array.isArray(corpus.figures) ||
      JSON.stringify(corpus.sourceHashes) !== JSON.stringify(sources) || contentDigest(corpus) !== corpus.digest) return null;
    return corpus;
  } catch (error) { throwIfShadowReadFailure(error,settings.readOptions);return null; }
}
async function sourceInputs(options: CorpusOptions = {}) {
  const settings = configured(options);
  const files = await Promise.all(settings.sourcePaths.map(async (sourcePath, index) => {
    const text = (await readDependency(settings.root, sourcePath, 'book-source', settings.readOptions))!.bytes.toString('utf8');
    return { text, source: { path: sourcePath, sha256: digest(text), lineCount: linesOf(text).length, documentKind: index === 0 ? 'preparation' as const : 'university' as const } };
  }));
  let preservedBindings: Promise<BookQuestionCorpus | null> | undefined;
  const figures: FigureReference[] = [];
  for (const file of files) for (const line of linesOf(file.text)) for (const match of line.text.matchAll(/!\[[^\]]*\]\(<?([^)>]+)>?\)/gu)) {
    const value = match[1].replace(/\\/gu, '/');
    const filename = value.split('/').at(-1)!;
    const relative = path.posix.join(settings.figuresDirectory.replace(/\\/gu, '/'), filename);
    const resolved = path.resolve(settings.root, relative), figureRoot = path.resolve(settings.root, settings.figuresDirectory);
    if (path.dirname(resolved) !== figureRoot || !/\.(?:png|jpg|jpeg|webp)$/iu.test(filename)) throw new Error('참고 그림의 파일 경로가 유효하지 않습니다.');
    const canonical = resolved.replace(/\\/gu, '/');
    const relocated = value !== canonical && value !== relative;
    const invalidLink = () => new Error(`참고 그림 경로를 현재 figures 폴더로 갱신해야 합니다: ${file.source.path}:${line.number}`);
    if (relocated && !isRelocatedFigureLink(value, relative)) throw invalidLink();
    const bytes = await readDependency(settings.root, relative, 'book-figure', settings.readOptions, true).then(file=>file?.bytes??null).catch(error=>{throwIfShadowReadFailure(error,settings.readOptions);return null;});
    const figure = { sourcePath: file.source.path, sourceLine: line.number, path: relative, sha256: bytes ? digest(bytes) : null, exists: Boolean(bytes) };
    // A relocated link needs the exact preserved source and image binding. The
    // normal verifiedCache path still validates the entire semantic corpus.
    if (relocated) {
      const preserved = await (preservedBindings ??= preservedFigureBindings(settings, files.map(file => file.source)));
      if (!bytes || !preserved?.figures.some(previous => JSON.stringify(previous) === JSON.stringify(figure))) throw invalidLink();
    }
    figures.push(figure);
  }
  return { ...settings, files, figures };
}

function catalogBody(inputs: Awaited<ReturnType<typeof sourceInputs>>, generatedAt: string): Omit<BookQuestionCorpus, 'digest'> {
  const questions = inputs.files.flatMap(file => {
    const explicit = extractBookQuestions(file.text, file.source.path, file.source.documentKind);
    return [...explicit, ...extractAdditionalBookQuestionCandidates(file.text, file.source.path, file.source.documentKind, explicit)].sort((a, b) => a.source.startOffset - b.source.startOffset);
  });
  const excludedByReason: Partial<Record<Exclusion, number>> = {};
  for (const question of questions) for (const reason of question.exclusions) excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
  return { schemaVersion: BOOK_QUESTION_CORPUS_VERSION, policyVersion: BOOK_QUESTION_SELECTION_POLICY, runtimeReviewVersion: QUESTION_REFERENCE_ANALYSIS_POLICY, generatedAt, sourceHashes: inputs.files.map(file => file.source), figuresDirectory: inputs.figuresDirectory, figures: inputs.figures, questions,
    counts: { scannedLines: inputs.files.reduce((sum, file) => sum + file.source.lineCount, 0), detectedQuestions: questions.length, eligibleQuestions: questions.filter(question => question.eligibility === 'eligible').length, runtimeApprovedQuestions: questions.filter(question => question.runtimeApproved).length, excludedQuestions: questions.filter(question => question.eligibility === 'excluded').length, reportedPastQuestions: questions.filter(question => question.provenance === 'reported_past_question').length, bookExamples: questions.filter(question => question.provenance === 'book_example').length, uniqueFigureFiles: new Set(inputs.figures.map(figure => figure.path)).size, missingFigureFiles: new Set(inputs.figures.filter(figure => !figure.exists).map(figure => figure.path)).size, excludedByReason },
    interpretation: 'QUESTION_PATTERNS_ONLY_NOT_STUDENT_FACTS_OR_CURRENT_ADMISSION_POLICY' as const };
}

export async function prepareBookQuestionReferences(options: CorpusOptions = {}): Promise<BookQuestionCorpus> {
  const inputs = await sourceInputs(options);
  const body = await analyzedCatalogBody(inputs, new Date().toISOString());
  const existing = await verifiedCache(inputs, body);
  if (existing) return existing;
  if (!body.questions.length) throw new Error('질문 후보 자료를 확인할 수 없습니다.');
  const corpus: BookQuestionCorpus = { ...body, digest: contentDigest(body) };
  const file = path.resolve(inputs.root, interviewReferenceFiles.preparedQuestionReferences), temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(temporary, JSON.stringify(corpus, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(() => {}); }
  return corpus;
}

// Preparation time is metadata. Identical source bytes and selection rules have one stable bank identity.
function contentDigest(value: Omit<BookQuestionCorpus, 'digest'> | BookQuestionCorpus) {
  return digest(JSON.stringify({ ...value, generatedAt: undefined, digest: undefined }));
}
async function verifiedCache(inputs: Awaited<ReturnType<typeof sourceInputs>>, expected?: Omit<BookQuestionCorpus, 'digest'>): Promise<BookQuestionCorpus | null> {
  try {
    const corpus = JSON.parse((await readDependency(inputs.root, interviewReferenceFiles.preparedQuestionReferences, 'book-corpus', inputs.readOptions))!.bytes.toString('utf8')) as BookQuestionCorpus;
    if (corpus.schemaVersion !== BOOK_QUESTION_CORPUS_VERSION || corpus.policyVersion !== BOOK_QUESTION_SELECTION_POLICY || !Number.isFinite(Date.parse(corpus.generatedAt))) return null;
    const body = expected ?? await analyzedCatalogBody(inputs, corpus.generatedAt);
    return contentDigest(body) === corpus.digest && contentDigest(corpus) === corpus.digest ? corpus : null;
  } catch (error) { throwIfShadowReadFailure(error,inputs.readOptions);return null; }
}

/** Semantic review, not an arbitrary ID list or a keyword screen, determines how a source can be used. */
export function bookQuestionReferenceUsage(question: BookQuestionReference): BookQuestionReferenceUsage | null {
  const review = question.analysis;
  if (!review || review.status !== 'reviewed' || review.questionId !== question.id || review.sourceSha256 !== question.source.sha256 || review.questionSha256 !== digest(question.rawText)) return null;
  if (review.restrictions.includes('sensitive_personal') || review.restrictions.includes('not_a_question')) return null;
  if (!['direct_example', 'compound_strategy', 'contextual_strategy'].includes(review.category)) return null;
  if (review.dependencies.passage || review.dependencies.figure || review.dependencies.priorAnswer || review.dependencies.institution || review.restrictions.some(restriction => ['missing_context', 'institution_specific', 'passage_required', 'figure_required'].includes(restriction))) return 'contextual_strategy';
  return review.category as BookQuestionReferenceUsage;
}

async function analyzedCatalogBody(inputs: Awaited<ReturnType<typeof sourceInputs>>, generatedAt: string): Promise<Omit<BookQuestionCorpus, 'digest'>> {
  const body = catalogBody(inputs, generatedAt);
  const raw: BookQuestionCorpus = { ...body, digest: contentDigest(body) };
  const modelAnalysis = await loadQuestionReferenceAnalysis(raw, { root: inputs.root, readOptions: inputs.readOptions });
  if (!modelAnalysis) {
    body.questions = body.questions.map(question => ({ ...question, eligibility: 'pending', screeningFlags: [...question.exclusions] }));
    body.counts = { ...body.counts, screeningFlagsByReason: body.counts.excludedByReason, excludedByReason: {}, eligibleQuestions: 0, excludedQuestions: 0, analyzedQuestions: 0, pendingAnalysisQuestions: body.questions.length };
    return body;
  }
  const analysis = await applyQuestionReferenceAdjudications(raw, modelAnalysis, { root: inputs.root, readOptions: inputs.readOptions });
  const rows = new Map(analysis.rows.map(row => [row.questionId, row]));
  body.questions = body.questions.map(question => {
    const analyzed = { ...question, screeningFlags: [...question.exclusions], analysis: rows.get(question.id) };
    const usage = bookQuestionReferenceUsage(analyzed);
    const review = analyzed.analysis;
    return { ...analyzed, primaryFunctions: review?.status === 'reviewed' ? [...review.primaryFunctions] : question.primaryFunctions, eligibility: usage ? 'eligible' as const : review?.status === 'reviewed' ? 'excluded' as const : 'pending' as const, exclusions: [], runtimeApproved: Boolean(usage) };
  });
  body.analysis = { key: analysis.key, policyVersion: analysis.policyVersion, model: analysis.model, sourceFingerprint: analysis.sourceFingerprint, contentSha256: analysis.contentSha256, coverage: analysis.coverage, ...(analysis.adjudicationSummary ? { adjudicationSummary: analysis.adjudicationSummary } : {}) };
  const uses = body.questions.map(bookQuestionReferenceUsage);
  const excludedByReason: Record<string, number> = {};
  for (const question of body.questions) if (question.eligibility === 'excluded' && question.analysis?.status === 'reviewed') {
    const reason = question.analysis.restrictions.includes('sensitive_personal') ? 'sensitive_personal' : question.analysis.category;
    excludedByReason[reason] = (excludedByReason[reason] ?? 0) + 1;
  }
  body.counts = { ...body.counts, screeningFlagsByReason: body.counts.excludedByReason, excludedByReason, eligibleQuestions: uses.filter(Boolean).length, excludedQuestions: body.questions.filter(question => question.eligibility === 'excluded').length, runtimeApprovedQuestions: uses.filter(Boolean).length,
    analyzedQuestions: analysis.coverage.reviewed, pendingAnalysisQuestions: analysis.coverage.pending,
    directExamples: uses.filter(usage => usage === 'direct_example').length, compoundStrategies: uses.filter(usage => usage === 'compound_strategy').length, contextualStrategies: uses.filter(usage => usage === 'contextual_strategy').length,
    restrictedQuestions: body.questions.filter(question => question.analysis?.status === 'reviewed' && question.analysis.restrictions.includes('sensitive_personal')).length,
    unresolvedQuestions: analysis.rows.filter(row => row.status === 'reviewed' && ['review_required', 'malformed'].includes(row.category)).length,
  };
  return body;
}

/** Rebuild the source projection locally before accepting the cache. No provider calls. */
export async function loadBookQuestionReferences(root = process.cwd(), readOptions: AnalysisReadOptions = {}): Promise<BookQuestionCorpus | null> {
  try { return await verifiedCache(await sourceInputs({ root, readOptions })); } catch (error) { throwIfShadowReadFailure(error,readOptions);return null; }
}

/** Return questions only; administrative source prose, figures, answers and university labels never enter the runtime prompt. */
export function selectBookQuestionExamples(corpus: BookQuestionCorpus | null | undefined, input: { primaryFunction: string; depth?: string; topicText?: string; limit?: number; seed?: string; recentIds?: readonly string[] }): BookQuestionExample[] {
  if (!corpus || corpus.schemaVersion !== BOOK_QUESTION_CORPUS_VERSION) return [];
  const limit = Math.max(0, Math.min(8, Math.floor(input.limit ?? 3)));
  const topic = normalized(input.topicText ?? '').toLowerCase();
  const words = [...new Set(topic.match(/[가-힣a-z]{2,}/gu) ?? [])];
  const grams = new Set<string>();
  for (const word of words) for (let index = 0; index + 2 <= word.length; index++) grams.add(word.slice(index, index + Math.min(3, word.length - index)));
  const recent = new Set(input.recentIds ?? []);
  const recentTexts = new Set(corpus.questions.filter(question => recent.has(question.id)).map(question => compact(question.questionText)));
  const seen = new Set<string>();
  const candidates = corpus.questions.flatMap(question => {
    const usage = bookQuestionReferenceUsage(question), review = question.analysis;
    if (!usage || review?.status !== 'reviewed' || !(review.primaryFunctions as readonly string[]).includes(input.primaryFunction)) return [];
    const text = normalized(question.questionText).toLowerCase();
    const topicScore = words.reduce((score, word) => score + (text.includes(word) ? 3 : 0), 0) + [...grams].reduce((score, gram) => score + Number(text.includes(gram)), 0);
    const demand = review.demandSpans.find(span => span.primaryFunction === input.primaryFunction);
    const referenceDepth = demand?.depth ?? review.depth;
    const depthDistance = input.depth ? Math.abs(Number(input.depth.slice(1)) - Number(referenceDepth.slice(1))) : 0;
    return [{ question, review, usage, demand, referenceDepth, recent: recent.has(question.id) || recentTexts.has(compact(question.questionText)), score: topicScore + (usage === 'direct_example' ? 2 : 0) - depthDistance * 4, rank: digest(`${input.seed ?? 'reference-selection'}:${question.id}`) }];
  });
  const available = candidates.filter(candidate => !candidate.recent);
  return (available.length >= limit ? available : candidates)
    .sort((a, b) => Number(a.recent) - Number(b.recent) || b.score - a.score || a.rank.localeCompare(b.rank))
    .filter(({ question }) => { const key = compact(question.questionText); if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, limit)
    .map(({ question, review, usage, demand, referenceDepth }) => ({ id: question.id, ...(usage === 'direct_example' ? { questionText: question.questionText } : {}), provenance: question.provenance, questionKind: question.questionKind, primaryFunctions: [...review.primaryFunctions], usage, depth: referenceDepth, domain: review.domain, strategies: [...review.strategies], dependencies: { ...review.dependencies }, restrictions: [...review.restrictions],
      ...(usage === 'compound_strategy' && demand ? { atomicDemand: { quote: demand.quote, primaryFunction: input.primaryFunction, depth: demand.depth } } : {}),
      source: { path: question.source.path, sha256: question.source.sha256, pdfPage: question.source.pdfPage, startLine: question.source.startLine, endLine: question.source.endLine } }));
}
