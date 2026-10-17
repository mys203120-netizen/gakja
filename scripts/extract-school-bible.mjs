import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function extractSchoolBible(text, sourceHash) {
  const lines = text.split(/\r?\n/); const starts = [];
  lines.forEach((line, index) => { if (/^### \d+ /.test(line)) starts.push(index); });
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length;
    const section = lines.slice(start, end);
    const university = section[0].replace(/^### \d+ /, '').replace(/†/g, '').trim();
    const pageLabel = section.find(line => line.startsWith('책의 인쇄 쪽수:')) || '';
    const blocks = []; const commonQuestions = []; let pdfPage = null; let inText = false; let collecting = false; let stopped = false; let current = [];
    for (let offset = 1; offset < section.length; offset++) {
      const line = section[offset];
      if (/^#### PDF 페이지 \d+/.test(line)) pdfPage = Number(line.match(/\d+/)[0]);
      if (line === '```text') { inText = true; continue; }
      if (line === '```') { inText = false; if (current.length) { blocks.push({ pdfPage, lineStart: current[0].line, lineEnd: current.at(-1).line, text: current.map(item => item.text).join('\n') }); current = []; } continue; }
      if (!inText) continue;
      const bullet = line.match(/^\s*[·•●-]\s*(.+)$/);
      if (stopped && bullet && commonQuestions.length < 6) {
        const prompt = bullet[1].trim();
        const standalone = /지원\s*(?:동기|한 이유)|우리\s*(?:학교|대학).*?(?:하고 싶은|지원|입학)|전공을\s*(?:선택|지원)|갈등.*(?:해결|대처)|협업.*(?:중요|생각)|리더십.*생각|진로.*(?:계획|목표)/.test(prompt);
        const personalOrMissingStimulus = /생기부|학생부|실험|수상|읽은|독서|지각|결석|봉사|동아리|교회|목회|제시문|자료 [A-Z가-힣]|그림|도표|위의|다음의|지원자.*(?:한|했던)|성적|생활기록|○|□|내용이 나오|계약학과|[가-힣]{2,}학과/.test(prompt);
        if (standalone && !personalOrMissingStimulus && prompt.length >= 15 && prompt.length <= 220 && /[?？]$|(?:나요|세요|시오|가요|까|인가|하라|한다)[.]?$/.test(prompt) && !commonQuestions.some(q => q.prompt === prompt)) commonQuestions.push({ prompt, pdfPage, line: start + offset + 1 });
      }
      if (stopped) continue;
      if (/^\s*1[.)]\s*면접\s*개요/.test(line)) collecting = true;
      if (collecting && /^\s*(?:[2-9][.)]\s*|[ⅠⅡⅢⅣⅤ]\.?\s*)(?:면접\s*)?(?:기출|예상|출제|문항|질문|제시문|면접\s*사례)/.test(line)) { stopped = true; continue; }
      if (collecting && line.trim() && !/^\d{3}$/.test(line.trim()) && !/^성공적인 대입을 위한 면접 바이블$/.test(line)) current.push({ line: start + offset + 1, text: line });
    }
    // Keep only quoted overview evidence; missing extraction never becomes invented guidance.
    return { id: `bible_${createHash('sha256').update(university).digest('hex').slice(0, 16)}`, university, status: 'historical_reference', version: 1, overview: blocks,
      source: { document: '2027_면접바이블_대학별정리_v1.0.md', sha256: sourceHash, editionLabel: '2027 면접바이블 제공본', pageLabel, lineStart: start + 1, lineEnd: end, checkedAt: null },
      evaluationWeights: null, questionDistribution: null, commonQuestions, matchingStatus: 'school_reference', format: 'reference', officialConfirmed: false };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = resolve('2027_면접바이블_대학별정리_v1.0.md'); const bytes = readFileSync(source); const hash = createHash('sha256').update(bytes).digest('hex');
  const catalog = extractSchoolBible(bytes.toString('utf8'), hash);
  if (catalog.length !== 88) throw new Error(`Expected 88 schools, got ${catalog.length}`);
  const output = resolve('apps/web/src/data/school-bible.json'); mkdirSync(resolve('apps/web/src/data'), { recursive: true });
  writeFileSync(output, JSON.stringify({ sourceHash: hash, schools: catalog }, null, 2) + '\n');
  console.log(JSON.stringify({ schools: catalog.length, withOverview: catalog.filter(school => school.overview.length).length, sourceHash: hash, output }));
}
