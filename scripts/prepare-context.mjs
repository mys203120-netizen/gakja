import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { interviewFiles } from '../interview-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pdfName = interviewFiles.studentPdf;
const cachePath = resolve(root, interviewFiles.preparedStudent);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const compact = (value) => value.normalize("NFKC").replace(/\s+/gu, "");

/** Full source preservation is separate from the historical, manually selected 17 excerpts. */
export async function prepareFullRecord(bytes, sourceFile = pdfName, workspace = root) {
  const identityFile = resolve(workspace, 'data/local/student-identity.json');
  let localIdentity;
  try { localIdentity = JSON.parse(await readFile(identityFile, 'utf8')); if (!/^STUDENT-[0-9a-f-]{36}$/u.test(localIdentity.studentId)) throw new Error('LOCAL_STUDENT_IDENTITY_INVALID'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    localIdentity = { studentId: `STUDENT-${randomUUID()}`, kind: 'server-owned-local-development-student', createdAt: new Date().toISOString() };
    await mkdir(dirname(identityFile), { recursive: true });
    await writeFile(identityFile, JSON.stringify(localIdentity, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  const pdfSha256 = hash(bytes), revision = `record-text-v2-${pdfSha256.slice(0, 24)}`;
  const directory = resolve(workspace, 'data/prepared/record-revisions', revision);
  const file = resolve(directory, 'source.json');
  try {
    const cached = JSON.parse(await readFile(file, 'utf8'));
    const { contentSha256, ...body } = cached;
    if (cached.schemaVersion === 'full-record-source-v1' && cached.pdfSha256 === pdfSha256 && cached.sourceFile === sourceFile && contentSha256 === hash(JSON.stringify(body))) {
      await mkdir(resolve(workspace, 'data/prepared'), { recursive: true });
      await writeFile(resolve(workspace, 'data/prepared/full-record-current.json'), JSON.stringify({ revision, path: `data/prepared/record-revisions/${revision}/source.json`, pdfSha256, contentSha256 }, null, 2), 'utf8');
      return cached;
    }
  } catch { /* An absent extraction is prepared from the current PDF below. */ }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  const document = await loadingTask.promise, pages = [], blocks = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber), content = await page.getTextContent();
      let text = ''; const items = [];
      for (const item of content.items.filter(value => 'str' in value)) {
        // Identical UTF-16 page-text convention to verify-student-source.ts. No NFKC rewrite.
        let part = (item.str + (item.hasEOL ? '\n' : ' ')).replace(/[ \t]+/gu, ' ');
        if (text.endsWith(' ') && part.startsWith(' ')) part = part.slice(1);
        const start = text.length; text += part;
        items.push({ start, end: text.length, text: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height, hasEOL: Boolean(item.hasEOL) });
      }
      const viewport = page.getViewport({ scale: 1 });
      const textStatus = compact(text).length >= 20 ? 'text_extracted' : 'ocr_review_required';
      pages.push({ page: pageNumber, width: viewport.width, height: viewport.height, text, textSha256: hash(text), textStatus, items });
      let start = 0;
      while (start < text.length) {
        let end = Math.min(text.length, start + 1500);
        if (end < text.length) { const boundary = text.lastIndexOf('\n', end); if (boundary > start + 500) end = boundary + 1; }
        const excerpt = text.slice(start, end), id = `SRC-${hash(`${pdfSha256}:${pageNumber}:${start}:${end}`).slice(0, 24)}`;
        blocks.push({ id, page: pageNumber, startOffset: start, endOffset: end, text: excerpt, textSha256: hash(excerpt), itemIndexes: items.flatMap((item, index) => item.end > start && item.start < end ? [index] : []), processingStatus: textStatus === 'text_extracted' ? 'pending_analysis' : 'requires_source_review' });
        start = end;
      }
      page.cleanup();
    }
    const body = { schemaVersion: 'full-record-source-v1', revision, recordRevision: pdfSha256, sourceDocumentId: `DOC-${pdfSha256.slice(0, 24)}`, studentId: localIdentity.studentId, sourceFile, pdfSha256, extraction: 'pdfjs-dist-text-items', coordinateSystem: 'PDF-points-bottom-left; offsets=UTF-16-in-canonical-page-text', createdAt: new Date().toISOString(), pageCount: document.numPages, pages, blocks,
      coverage: { expectedPages: document.numPages, extractedPages: pages.length, pagesRequiringOcrReview: pages.filter(page => page.textStatus !== 'text_extracted').map(page => page.page), sourceBlockCount: blocks.length, sourceTextCharacters: pages.reduce((sum, page) => sum + page.text.length, 0), fullPageExtraction: pages.length === document.numPages, independentSemanticOrOcrReview: false },
      limitations: ['전 페이지 텍스트·원문 좌표를 보존하나 OCR 의미 정확성·표 열의 의미 해석을 독립 검수한 것으로 표시하지 않습니다.', '원문 정본에는 개인정보가 포함될 수 있으며 모델 입력은 별도의 최소화 투영을 사용합니다.', '기존 17개 검수 발췌와 과거 회차를 변경하지 않는 새 원문 revision입니다.'] };
    const result = { ...body, contentSha256: hash(JSON.stringify(body)) };
    await mkdir(directory, { recursive: true });
    await writeFile(file, JSON.stringify(result, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await writeFile(resolve(workspace, 'data/prepared/full-record-current.json'), JSON.stringify({ revision, path: `data/prepared/record-revisions/${revision}/source.json`, pdfSha256, contentSha256: result.contentSha256 }, null, 2), { encoding: 'utf8', mode: 0o600 });
    return result;
  } finally { await loadingTask.destroy(); }
}

// Human-reviewed source ranges only. Titles describe the passage; no activity ranking,
// official knowledge verification, new experience, or inferred result is assigned.
const selections = [
  [2, 1, "자율활동", "화학물질 독서와 미세플라스틱 제거 탐구", "또한, 사제동행 독서 주제 활동에서", "더 큰 변화를 만들 수 있음을 깨닫게 됨."],
  [2, 1, "동아리활동", "비타민 C와 산·염기 탐구", "(사이언스텔링)(40시간)", "평소 주도적으로 실험 과정을 지휘하며 부원들과 협력하는 모습에서 탐구 수행 능력과 지도력을 보여줌."],
  [3, 1, "진로활동", "DNA 메틸화와 세포 리프로그래밍 자료 탐구", "수업에서 유전적 변이의 원인을 배우며", "친구들과 토론하며 비판적 사고를 확장함."],
  [3, 2, "자율활동", "에너지 바우처 정보 접근성 안내 활동", "'같이의 가치' 활동에서", "남다른 실천력이 돋보임."],
  [4, 2, "동아리활동", "비타민 C 분자의 3차원 모델링", "컴퓨터 동아리와의 협업을 통해", "자료를 바탕으로 비교 분석함."],
  [4, 2, "진로활동", "설문 불확실성 보완을 위한 전문가 인터뷰", "확률과 통계 수업 중 진행한 설문조사에서", "탐구적 끈기를 발휘함."],
  [4, 3, "자율활동", "바이오 플라스틱 분해 한계 분석", "[월간 평론]", "전과정 탄소배출 평가시스템 구축을 조리 있게 역설함."],
  [5, 3, "동아리활동", "전해질 전기전도도와 온도 영향 탐구", "전해질 전기전도도 측정 실험 후", "변수 확장적 사고력이 돋보임."],
  [5, 3, "동아리활동", "알긴산 하이드로겔 가교 원리 조사", "알긴산 나트륨과 염화칼슘의 반응 실험 후", "복합적 사고력이 돋보임."],
  [5, 3, "진로활동", "암모니아 크래킹과 저온 촉매 자료 탐구", "[포커스 발표]", "수소 경제 상용화 가능성을 모색하는 태도가 훌륭함."],
  [5, 3, "진로활동", "CNT·맥신 복합체 탐구 보고서", "[주제 탐구 학술회]", "최적 전극 제조 조건을 수치화하는 등 탐구력이 탁월함."],
  [15, 2, "교과세특 · 수학Ⅱ", "DNA 메틸화율의 미분·적분 해석", "'미적분의 활용 탐구하기' 활동에서", "융합적 탐구 역량을 보여줌."],
  [15, 2, "교과세특 · 확률과 통계", "친환경 에너지 설문과 유효 응답 처리", "확률과 통계:", "통계적 근거를 들어 제언함."],
  [16, 2, "교과세특 · 화학Ⅰ", "산화수·전기 음성도 자료 탐구", "화학Ⅰ:", "중요한 기준임을 도출함."],
  [22, 3, "교과세특 · 화학Ⅱ", "화학 평형과 착이온 색 변화 실험", "화학Ⅱ:", "주도적으로 설계함."],
  [22, 3, "교과세특 · 화학Ⅱ", "수전해 촉매와 소재 공학 자료 탐구", "평소 차세대 기술에 관심을 두고", "학술적 역량을 입증함."],
  [23, 1, "행동특성 및 종합의견", "학급 행사에서 의견 조율", "반장으로서 학년 초 마니또를 진행하며", "학생의 도움이 컸음."],
];

function locateRange(pageText, first, last) {
  let condensed = "";
  const positions = [];
  for (let i = 0; i < pageText.length; i++) {
    const character = pageText[i];
    if (/\s/u.test(character)) continue;
    const normalized = character.normalize("NFKC");
    for (const letter of normalized) { condensed += letter; positions.push(i); }
  }
  const start = condensed.indexOf(compact(first));
  const endStart = condensed.indexOf(compact(last), start);
  if (start < 0 || endStart < 0) throw new Error(`검수된 원문 구간을 찾지 못했습니다: ${first}`);
  const end = endStart + compact(last).length;
  return { start: positions[start], end: positions[end - 1] + 1 };
}

export async function prepareContext({ force = false } = {}) {
  const bytes = await readFile(resolve(root, pdfName));
  const sha256 = hash(bytes);
  const fullRecord = await prepareFullRecord(bytes);
  try {
    const existing = JSON.parse(await readFile(cachePath, "utf8"));
    if (!force && existing.schemaVersion === "verified-pdf-excerpts-v2" && existing.pdfSha256 === sha256 && existing.sourceFile === pdfName && existing.evidence.length === selections.length && existing.evidence.every(item => item.sourceRef.file === pdfName && item.sourceRef.pdfSha256 === sha256)) {
      return { cached: true, pageCount: existing.pageCount, evidenceCount: existing.evidence.length, fullRecordRevision: fullRecord.revision, fullRecordCoverage: fullRecord.coverage };
    }
  } catch { /* Missing or invalid cache is prepared below. */ }
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  const pdf = await loadingTask.promise;
  const needed = [...new Set(selections.map(([page]) => page))];
  const pages = new Map();
  for (const pageNumber of needed) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.filter((item) => "str" in item).map((item) => item.str + (item.hasEOL ? "\n" : " ")).join("").replace(/[ \t]+/gu, " ");
    pages.set(pageNumber, text);
    page.cleanup();
  }
  if (![...pages.values()].some((text) => compact(text).length > 100)) {
    throw new Error("윤지우 학생부 PDF에서 텍스트가 추출되지 않습니다. 검수된 추출 JSON이 필요합니다. OCR이나 샘플 학생으로 대체하지 않습니다.");
  }
  const evidence = selections.map(([page, grade, section, title, first, last], index) => {
    const pageText = pages.get(page);
    const range = locateRange(pageText, first, last);
    const id = `YJW-P${String(page).padStart(2, "0")}-E${String(index + 1).padStart(2, "0")}`;
    return {
      id, activityId: `YJW-ACT-${String(index + 1).padStart(2, "0")}`, page, grade, section, title,
      text: pageText.slice(range.start, range.end),
      sourceRef: { file: pdfName, pdfSha256: sha256, page, extraction: "pdfjs-dist-text-items", startOffset: range.start, endOffset: range.end },
      confirmationStatus: "confirmed_from_record", preparationPriority: null,
      scientificTruthVerification: "not_independently_verified",
    };
  });
  const output = {
    schemaVersion: "verified-pdf-excerpts-v2", studentName: "윤지우", sourceFile: pdfName,
    pdfSha256: sha256, pageCount: pdf.numPages, extractionStatus: "text_extractable",
    preparedAt: new Date().toISOString(), preparationMethod: "deterministic-human-reviewed-source-ranges",
    limitations: ["주민등록번호·주소·연락처·제3자 이름·원문 전체를 모델 입력에 포함하지 않습니다.", "발췌문은 학생부 기록의 근거이며 전문 과학 명제의 독립 검증 자료가 아닙니다.", "S/A/B/C/F 우선도와 승인된 학생부 분석 MD가 없어 활동 전략 추천은 사용하지 않습니다."],
    evidence,
  };
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(output, null, 2), "utf8");
  await loadingTask.destroy();
  return { cached: false, pageCount: output.pageCount, evidenceCount: evidence.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log("학생부 근거 준비:", JSON.stringify(await prepareContext({ force: process.argv.includes("--force") }))); }
  catch (error) { console.error(error instanceof Error ? error.message : "학생부 준비 실패"); process.exitCode = 1; }
}
