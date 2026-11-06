import { parentPort, workerData } from 'node:worker_threads';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// No text extraction, OCR, rendering, URLs, user password or source-content QA.
// The parent drains isolated worker output and accepts only this small result.
let loading;
try {
  const bytes = new Uint8Array(workerData.bytes);
  loading = getDocument({ data: bytes, useSystemFonts: false, disableFontFace: true,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    stopAtErrors: true, maxImageSize: 0, verbosity: 0 });
  const document = await loading.promise;
  const metadata = await document.getMetadata();
  if (!metadata.info || !Object.hasOwn(metadata.info, 'EncryptFilterName')) throw new Error();
  if (metadata.info?.EncryptFilterName != null) {
    parentPort.postMessage({ valid: false, reason: 'PDF_ENCRYPTION_UNSUPPORTED' });
  } else if (!Number.isInteger(document.numPages) || document.numPages < 1 || document.numPages > workerData.maxPages) {
    parentPort.postMessage({ valid: false, reason: 'PDF_PAGE_LIMIT' });
  } else {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber), viewport = page.getViewport({ scale: 1 });
      if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || viewport.width <= 0 || viewport.height <= 0) throw new Error();
      page.cleanup();
    }
    parentPort.postMessage({ valid: true, pages: document.numPages });
  }
} catch (error) {
  parentPort.postMessage({ valid: false, reason: error?.name === 'PasswordException' ? 'PDF_ENCRYPTION_UNSUPPORTED' : 'PDF_FORMAT_INVALID' });
} finally {
  await loading?.destroy().catch(() => {});
}
