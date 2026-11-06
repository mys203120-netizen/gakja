import { Worker } from 'node:worker_threads';

export class PdfStructureError extends Error {
  constructor(readonly code: 'PDF_FORMAT_INVALID' | 'PDF_ENCRYPTION_UNSUPPORTED' | 'PDF_PAGE_LIMIT' | 'PDF_PARSE_TIMEOUT' | 'PDF_WORKER_FAILED' | 'PDF_VALIDATION_BUSY') {
    super(code); this.name = 'PdfStructureError';
  }
}
export const pdfStructureLimits = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxPages: 256, timeoutMs: 5_000, maxConcurrentWorkers: 2, workerV8HeapMb: 128 });
let activeWorkers = 0;
/** Full bytes stay unchanged. Only container/xref/page-tree/unencrypted opening
 * is checked. A valid structure is not source QA, OCR or analysis approval.
 * ResourceLimits cap the worker V8 heap, not the whole process/native RSS. */
export async function validatePdfStructure(bytes: Buffer, options: { maxPages?: number; timeoutMs?: number } = {}): Promise<number> {
  const maxPages = options.maxPages ?? 256, timeoutMs = options.timeoutMs ?? 5_000;
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.length > 16 * 1024 * 1024 ||
    !/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/u.test(bytes.subarray(0, 9).toString('ascii')) ||
    !bytes.subarray(Math.max(0, bytes.length - 1024)).includes(Buffer.from('%%EOF')) ||
    !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 256 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) {
    throw new PdfStructureError('PDF_FORMAT_INVALID');
  }
  // Reserve before copying any PDF bytes or spawning a worker. This bound is
  // process-wide, including multiple reader instances sharing one Node process.
  if (activeWorkers >= pdfStructureLimits.maxConcurrentWorkers) throw new PdfStructureError('PDF_VALIDATION_BUSY');
  activeWorkers++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const data = Uint8Array.from(bytes);
    worker = new Worker(new URL('./pdf-structure-worker.mjs', import.meta.url), { workerData: { bytes: data.buffer, maxPages },
      transferList: [data.buffer], execArgv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    worker.stdout.resume(); worker.stderr.resume();
    return await new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => reject(new PdfStructureError('PDF_PARSE_TIMEOUT')), timeoutMs);
      worker!.once('message', (message: { valid?: boolean; pages?: number; reason?: PdfStructureError['code'] }) => {
        if (message.valid === true && Number.isInteger(message.pages) && message.pages! > 0 && message.pages! <= maxPages) resolve(message.pages!);
        else reject(new PdfStructureError(['PDF_ENCRYPTION_UNSUPPORTED', 'PDF_PAGE_LIMIT'].includes(message.reason ?? '') ? message.reason! : 'PDF_FORMAT_INVALID'));
      });
      worker!.once('error', () => reject(new PdfStructureError('PDF_WORKER_FAILED')));
      worker!.once('exit', () => reject(new PdfStructureError('PDF_WORKER_FAILED')));
    });
  } finally {
    clearTimeout(timer);
    try { await worker?.terminate(); } finally { activeWorkers--; }
  }
}
