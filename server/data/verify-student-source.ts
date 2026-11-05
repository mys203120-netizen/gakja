import { createHash } from 'node:crypto';

type SourceSpan = { page: number; text: string; sourceRef: { startOffset: number; endOffset: number } };
export interface StudentSourceTextAudit {
  version: 'pdf-text-source-audit-v1';
  passed: boolean;
  expectedPageCount: number;
  actualPageCount: number;
  checkedPages: number;
  checkedSpans: number;
  fullDocumentTextCompared: boolean;
  failureCodes: string[];
  pages: Array<{ page: number; extractedTextSha256: string; checkedSpans: number; failedSpans: number }>;
}

/** Re-extract actual PDF bytes. Report hashes/ranges, never copy student text into diagnostics. */
export async function auditStudentSourceText(pdfBytes: Buffer, evidence: SourceSpan[], expectedPageCount: number): Promise<StudentSourceTextAudit> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({ data: new Uint8Array(pdfBytes), useSystemFonts: true, verbosity: 0 });
  const pdf = await loading.promise;
  try {
    const result: StudentSourceTextAudit = { version: 'pdf-text-source-audit-v1', passed: true, expectedPageCount, actualPageCount: pdf.numPages, checkedPages: 0, checkedSpans: 0, fullDocumentTextCompared: false, failureCodes: [], pages: [] };
    const fail = (code: string) => { result.passed = false; if (!result.failureCodes.includes(code)) result.failureCodes.push(code); };
    if (!Number.isInteger(expectedPageCount) || expectedPageCount < 1 || pdf.numPages !== expectedPageCount) { fail('PDF_PAGE_COUNT_MISMATCH'); return result; }
    let completePages = 0;
    for (const pageNumber of new Set(evidence.map(item => item.page))) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) { fail('PDF_SOURCE_PAGE_INVALID'); continue; }
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.filter(item => 'str' in item).map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').replace(/[ \t]+/gu, ' ');
      page.cleanup();
      const spans = evidence.filter(item => item.page === pageNumber);
      let failedSpans = 0;
      for (const item of spans) {
        const { startOffset, endOffset } = item.sourceRef;
        if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || startOffset < 0 || endOffset < startOffset || endOffset > text.length || text.slice(startOffset, endOffset) !== item.text) {
          fail('PDF_SOURCE_SPAN_MISMATCH'); failedSpans++;
        }
      }
      if (spans.some(item => item.sourceRef.startOffset === 0 && item.sourceRef.endOffset === text.length && item.text === text)) completePages++;
      result.checkedPages++; result.checkedSpans += spans.length;
      result.pages.push({ page: pageNumber, extractedTextSha256: createHash('sha256').update(text).digest('hex'), checkedSpans: spans.length, failedSpans });
    }
    result.fullDocumentTextCompared = result.passed && completePages === expectedPageCount;
    return result;
  } finally { await loading.destroy(); }
}

/** A matching PDF hash alone cannot validate changed cache text. */
export async function verifyStudentSourceText(pdfBytes: Buffer, evidence: SourceSpan[], expectedPageCount: number) {
  return (await auditStudentSourceText(pdfBytes, evidence, expectedPageCount)).passed;
}
