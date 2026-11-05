import { createHash } from 'node:crypto';
import type { BookQuestionReference } from './book-question-reference';

type DocumentKind = 'preparation' | 'university';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const normalize = (value: string) => value.normalize('NFC').replace(/\s+/gu, ' ').trim();
const terminal = /(?:[?？]|(?:알려|밝혀|얘기|설명|말|말씀|이야기|서술|제시|비교|답변|답|소개|제기|논하|논의|평가|생각).{0,35}(?:주십시오|보십시오|주세요|보세요|보시오|하시오|주시오|시오|세요|십시오|바랍니다|겠습니까))[.!。]?\s*(?:[（(][^()（）\n]{1,40}[)）])?\s*$/u;
const answerHeading = /(?:답변\s*예시|답안\s*예시|예시\s*답변|예시\s*답안|모범\s*답안|학생\s*답변|학생\s*답안)/u;
const recordHeading = /^(?:학생부\s*기록(?:\s*내용)?|교과\s*세특(?:\s*(?:기록\s*내용|예시))?|교과세부능력\s*및\s*특기사항\s*(?:기록|예시))$/u;
const questionHeading = /(?:면접\s*(?:기출\s*)?(?:질문|문항|문제)|기출\s*문항|추가\s*질문|유사\s*질문|질문\s*예시|문제\s*사례)/u;
const structuralHeading = /^(?:관련\s*학과|면접\s*키워드|출제\s*항목|전공명|평가영역|평가자료|평가\s*요소|평가\s*항목|면접\s*문항|학교생활기록부|전공\s*적합성|전공\s*이해도|발전\s*가능성|미래\s*비전\s*검증|의사표현능력\s*검증|지원\s*동기\s*및\s*자기소개|전체\s*전공|학업\s*역량|학과|학과명|모집단위|예시|출처\s*[:：].*|\d{1,3}|[A-Z]전공)$/u;

/**
 * Recall candidates outside the explicit-section parser. This is candidate discovery,
 * not semantic approval: prose questions and FAQ material still require offline analysis.
 * Supplied answers and student-record passages are never promoted by this fallback.
 */
export function extractAdditionalBookQuestionCandidates(
  text: string,
  sourcePath: string,
  documentKind: DocumentKind,
  existing: readonly BookQuestionReference[],
): BookQuestionReference[] {
  const lines = [...text.matchAll(/([^\r\n]*)(?:\r\n|\r|\n|$)/gu)]
    .filter(match => match[0].length > 0)
    .map((match, index) => ({ text: match[1], start: match.index!, end: match.index! + match[1].length, number: index + 1 }));
  const sourceSha = sha256(text), additional: BookQuestionReference[] = [];
  let inText = false, blocked = false, page: number | null = null, section = '', universityLabel: string | undefined;
  let provenance: BookQuestionReference['provenance'] = 'book_example';
  let kind: BookQuestionReference['questionKind'] = 'unspecified';
  let questionContext = false;
  let pending: { start: number; end: number; startLine: number; endLine: number } | null = null;

  const emit = (start: number, end: number, startLine: number, endLine: number) => {
    while (start < end && /\s/u.test(text[start])) start++;
    while (end > start && /\s/u.test(text[end - 1])) end--;
    if (end <= start || [...existing, ...additional].some(question => question.source.startOffset < end && question.source.endOffset > start)) return;
    const rawText = text.slice(start, end), questionText = normalize(rawText);
    if (!terminal.test(questionText)) return;
    additional.push({
      id: `BOOKQ-${sha256(`${sourcePath}:${start}:${rawText}`).slice(0, 20)}`,
      questionText, rawText, provenance, questionKind: kind, primaryFunctions: ['FACT'],
      source: { path: sourcePath, sha256: sourceSha, pdfPage: page, startLine, endLine, startOffset: start, endOffset: end, section, ...(universityLabel ? { universityLabel } : {}) },
      eligibility: 'eligible', exclusions: [], runtimeApproved: false,
    });
  };
  for (const line of lines) {
    const trimmed = line.text.trim(), compact = trimmed.replace(/\s/gu, '');
    const pageMatch = /^####\s+PDF\s+페이지\s+(\d+)/u.exec(trimmed);
    if (pageMatch) { pending = null; page = Number(pageMatch[1]); continue; }
    if (/^#{1,3}\s/u.test(trimmed)) {
      pending = null; blocked = false; questionContext = false; provenance = 'book_example'; kind = 'unspecified';
      section = trimmed.replace(/^#+\s*/u, '');
      if (documentKind === 'university') universityLabel = /^###\s+\d+\s+(.+)/u.exec(trimmed)?.[1]?.trim();
      continue;
    }
    if (/^```/u.test(trimmed)) { inText = /^```text/u.test(trimmed); pending = null; continue; }
    if (!inText) continue;
    if (!trimmed) { pending = null; continue; }

    // Inline alternatives are independent source spans, not one invented compound prompt.
    const inline = /(?:유사\s*질문|질문\s*예시)\s*[:：]\s*/u.exec(trimmed);
    if (inline) {
      blocked = false; questionContext = true; kind = 'unspecified'; provenance = 'book_example'; pending = null;
      const base = line.start + line.text.indexOf(trimmed) + inline.index + inline[0].length;
      const tail = text.slice(base, line.end);
      const parts: Array<{ text: string; start: number }> = [];
      let partStart = 0;
      for (const delimiter of tail.matchAll(/\s+[\/／]\s+/gu)) {
        parts.push({ text: tail.slice(partStart, delimiter.index!), start: partStart });
        partStart = delimiter.index! + delimiter[0].length;
      }
      parts.push({ text: tail.slice(partStart), start: partStart });
      for (const entry of parts) {
        const part = entry.text, start = base + entry.start;
        // Preserve two unseparated complete alternatives as distinct spans when punctuation separates them.
        let offset = 0;
        for (const ended of part.matchAll(/[^?？]+[?？](?:\s*[（(][^()（）\n]{1,40}[)）])?/gu)) {
          emit(start + ended.index!, start + ended.index! + ended[0].length, line.number, line.number);
          offset = ended.index! + ended[0].length;
        }
        if (part.slice(offset).trim()) emit(start + offset, start + part.length, line.number, line.number);
      }
      continue;
    }
    if (trimmed.length < 100 && answerHeading.test(trimmed) && !terminal.test(trimmed)) { blocked = true; pending = null; questionContext = false; continue; }
    if (recordHeading.test(trimmed)) { blocked = true; pending = null; questionContext = false; continue; }
    const heading = trimmed.length < 140 && questionHeading.test(trimmed) && !terminal.test(trimmed);
    if (heading) {
      blocked = false; pending = null; questionContext = true;
      kind = /추가\s*질문/u.test(trimmed) ? 'follow_up' : /면접\s*질문/u.test(trimmed) ? 'main' : 'unspecified';
      provenance = /기출/u.test(trimmed) && !/예시|사례/u.test(trimmed) ? 'reported_past_question' : 'book_example';
      continue;
    }
    if (blocked) continue;
    if (structuralHeading.test(trimmed) || /^[\[【(]?(?:학업|진로|공동체|전공|탐구)\s*역량[\]】)]?$/u.test(trimmed)) { pending = null; continue; }
    if (/(?:준비해|생각해|정리해|살펴|알아)\s*보자[.!。]?$/u.test(trimmed)) { pending = null; continue; }
    if (existing.some(question => line.start < question.source.endOffset && line.end > question.source.startOffset)) { pending = null; continue; }

    const bullet = /^(?:[·•▪◦●▶-]\s*|\d+(?:-\d+)?\s*[.)]\s+)/u.exec(trimmed)?.[0] ?? '';
    if (bullet) pending = null;
    const body = trimmed.slice(bullet.length);
    const start = line.start + line.text.indexOf(trimmed) + bullet.length;
    if (!pending) pending = { start, end: line.end, startLine: line.number, endLine: line.number };
    else { pending.end = line.end; pending.endLine = line.number; }
    if (terminal.test(body)) {
      emit(pending.start, pending.end, pending.startLine, pending.endLine);
      pending = null;
    } else if (!questionContext && /[.!。]\s*$/u.test(body)) {
      // A completed narrative paragraph is not the premise of the next unrelated question.
      pending = null;
    }
    if (/^(?:\d+[.)]\s*)?(?:면접\s*개요|평가\s*요소|전형\s*안내)$/u.test(trimmed) || compact.startsWith('성공적인대입을위한면접바이블')) pending = null;
  }
  return additional;
}
