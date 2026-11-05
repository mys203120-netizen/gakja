/**
 * TEST ONLY: static same-state visual fixture.
 * Reuses the running app's rendered shell, CSS, assets and real card/drawer components.
 * All scripts are stripped; no hydration, provider/API calls, microphone or camera access.
 * Never imported by the app and never served through a production route.
 * Run: npx tsx tests/visual/reference-preview.tsx
 * Preview: /?mode=ready|processing|interviewer|candidate&energy=0|1
 */
import http from 'node:http';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Check } from 'lucide-react';
import { QuestionCard } from '../../components/interview/QuestionCard';
import { ConversationDrawer } from '../../components/interview/ConversationDrawer';
import type { ConversationMessage, PreparedTurn } from '../../hooks/useInterviewSession';

const modes = ['ready', 'processing', 'interviewer', 'candidate'] as const;
export type FixtureMode = typeof modes[number];
type FixtureOptions = { mode?: FixtureMode; energy?: 0 | 1 };

const appOrigin = 'http://127.0.0.1:3000';
const port = 3012;
const questionText = '탐구 과정에서 예상과 다른 결과를 만났을 때 어떻게 해결했는지 말씀해 주세요.';
const acknowledgement = '네, 말씀하신 탐구 과정에 대한 설명 잘 들었습니다.';
const turn: PreparedTurn = {
  id: 'visual-fixture-q2', questionText, questionKind: 'main',
  parentMainQuestionId: 'visual-fixture-q2', mainIndex: 2, mainCount: 4,
  followUpIndex: 0, evidenceIds: [], questionAudioUrl: '', acknowledgement,
  acknowledgementAudioUrl: null, interviewerId: 'visual-fixture-interviewer',
};
const time = Date.parse('2026-11-01T12:00:00+09:00');
const messages: ConversationMessage[] = [
  { id: 'visual-answer-1', role: 'candidate', kind: 'answer', text: '실험 조건을 다시 확인하고, 한 번에 하나의 변인만 바꾸어 결과를 비교했습니다.', time },
  { id: 'visual-ack-2', role: 'interviewer', kind: 'acknowledgement', text: acknowledgement, time: time + 1000 },
  { id: 'visual-question-2', role: 'interviewer', kind: 'question', text: questionText, time: time + 2000 },
];

type ElementRange = { start: number; openEnd: number; end: number };
const tagPattern = /<\/?([a-z][a-z0-9:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;

/** Find a real element using balanced same-name tags; nested divs/sections are preserved. */
export function elementRange(html: string, predicate: (openingTag: string) => boolean): ElementRange {
  const tokens = [...html.matchAll(new RegExp(tagPattern.source, 'gi'))];
  const index = tokens.findIndex(token => !token[0].startsWith('</') && predicate(token[0]));
  if (index < 0) throw new Error('시각 테스트 대상 요소를 앱 HTML에서 찾지 못했습니다.');
  const first = tokens[index];
  let depth = 0;
  for (let cursor = index; cursor < tokens.length; cursor++) {
    const token = tokens[cursor];
    if (token[1].toLowerCase() !== first[1].toLowerCase()) continue;
    if (token[0].startsWith('</')) depth--;
    else if (!token[0].endsWith('/>')) depth++;
    if (depth === 0) return { start: first.index!, openEnd: first.index! + first[0].length, end: token.index! + token[0].length };
  }
  throw new Error('앱 HTML의 시각 테스트 대상 태그가 닫히지 않았습니다.');
}

const hasClass = (className: string) => (tag: string) => (tag.match(/\bclass="([^"]*)"/)?.[1] ?? '').split(/\s+/).includes(className);
function replaceElement(html: string, predicate: (tag: string) => boolean, replacement: string) {
  const range = elementRange(html, predicate);
  return html.slice(0, range.start) + replacement + html.slice(range.end);
}

export function fixtureHtml(source: string, { mode = 'candidate', energy = 0 }: FixtureOptions = {}) {
  let html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/\s*>/gi, '');
  html = html.replace(/<link\b(?=[^>]*(?:as="script"|rel="modulepreload"))[^>]*>/gi, '');
  if (mode !== 'ready') {
    html = replaceElement(html, hasClass('question-card'), renderToStaticMarkup(createElement(QuestionCard, {
      turn, phase: 'listening', preparation: null, loadingError: '', refresh: () => {}, micReady: false, cameraReady: false,
    })));
    const center = createElement('div', { className: 'center-copy' },
      createElement('div', { className: `phase-label${mode === 'candidate' ? ' candidate-label' : ''}` }, mode === 'processing' ? '다음 질문을 준비하고 있어요' : mode === 'interviewer' ? '질문을 듣는 중' : '답변 중'),
      createElement('div', { className: 'answer-action' },
        createElement('button', { className: 'primary-button', type: 'button' }, '다 말했어요 ', createElement(Check, { size: 17 })),
        createElement('span', null, createElement('kbd', null, 'Space'), ' 로도 제출할 수 있어요'),
      ),
    );
    html = replaceElement(html, hasClass('center-copy'), renderToStaticMarkup(center));
    html = html.replace(/\bclass="center-stage\s+is-ready"/, 'class="center-stage"');
  }
  // Ready mode deliberately keeps the actual ready card and center-copy from the app response.
  html = replaceElement(html, hasClass('conversation-drawer'), renderToStaticMarkup(createElement(ConversationDrawer, { open: true, messages: mode === 'ready' ? [] : messages, phase: mode === 'ready' ? 'idle' : 'listening', onClose: () => {} })));
  html = html.replace(/\bclass="interview-shell(?:\s+[^"]*)?"/, 'class="interview-shell drawer-open"');
  if (/<[^>]*\bclass="[^"]*\bconversation-toggle-wrap\b/.test(html)) html = replaceElement(html, hasClass('conversation-toggle-wrap'), '');
  const visualizer = elementRange(html, tag => /\bdata-visualizer="amoeba"/.test(tag));
  let blob = html.slice(visualizer.start, visualizer.end)
    .replace(/\bdata-state="[^"]*"/g, `data-state="${mode}"`)
    .replace(/\bdata-mode="[^"]*"/g, `data-mode="${mode}"`)
    .replace(/(<div\b[^>]*\bclass=")([^"]*)("[^>]*\bdata-active=")(?:true|false)(")/g,
      (_match, before: string, classes: string, between: string, after: string) => `${before}${classes}${between}${classes.includes(mode)}${after}`);
  const openingEnd = blob.indexOf('>'), openingTag = blob.slice(0, openingEnd);
  const energyTag = /\bstyle="/.test(openingTag)
    ? openingTag.replace(/\bstyle="([^"]*)"/, (_match, value: string) => `style="${/--energy\s*:/.test(value) ? value.replace(/--energy\s*:\s*[^;]*/g, `--energy:${energy}`) : `${value};--energy:${energy}`}"`)
    : `${openingTag} style="--energy:${energy}"`;
  blob = energyTag + blob.slice(openingEnd);
  html = html.slice(0, visualizer.start) + blob + html.slice(visualizer.end);
  // The shell/layout/asset classes remain the actual app's classes. No fixture CSS overrides.
  html = html.replace(/\b(href|src)="(\/(?!\/)[^"]*)"/g, (_match, attribute: string, path: string) => `${attribute}="${appOrigin}${path}"`);
  if (/<script\b/i.test(html)) throw new Error('시각 테스트 HTML에 실행 스크립트가 남아 있습니다.');
  return html;
}

const server = http.createServer(async (request, response) => {
  const headers = { 'Cache-Control': 'no-store', 'X-Visual-Fixture': 'test-only-static-no-services', 'X-Content-Type-Options': 'nosniff' };
  if (!['127.0.0.1:3012', 'localhost:3012'].includes(request.headers.host ?? '')) { response.writeHead(403, headers); response.end(); return; }
  if (request.method !== 'GET') { response.writeHead(405, headers); response.end(); return; }
  if (request.url === '/health') { response.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify({ testOnly: true, static: true, appOrigin })); return; }
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname !== '/') { response.writeHead(404, headers); response.end(); return; }
  const mode = url.searchParams.get('mode') ?? 'candidate', energy = url.searchParams.get('energy') ?? '0';
  if (!modes.includes(mode as FixtureMode) || !['0', '1'].includes(energy)) { response.writeHead(400, headers); response.end('mode=ready|processing|interviewer|candidate; energy=0|1'); return; }
  try {
    const source = await fetch(`${appOrigin}/interview`, { signal: AbortSignal.timeout(15000) });
    if (!source.ok) throw new Error(`원본 앱 응답: ${source.status}`);
    const html = fixtureHtml(await source.text(), { mode: mode as FixtureMode, energy: Number(energy) as 0 | 1 });
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline' ${appOrigin}; font-src ${appOrigin}; img-src data: ${appOrigin}; script-src 'none'; connect-src 'none'; media-src 'none'; base-uri 'none'; frame-ancestors 'none'` });
    response.end(html);
  } catch (error) {
    response.writeHead(503, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`TEST-ONLY fixture unavailable: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
});
server.listen(port, '127.0.0.1', () => console.log(`TEST ONLY static visual fixture: http://127.0.0.1:${port}/ (actual app CSS/components; no services/devices/hydration)`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
