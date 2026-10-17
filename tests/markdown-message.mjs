import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Render the production component with real Markdown parsing, without a browser,
// provider, raw-HTML plugin, or external requests.
const source=fs.readFileSync(new URL('../apps/web/src/components/markdown-message.tsx',import.meta.url),'utf8');
const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
function loadMarkdown(markdownRenderer=ReactMarkdown){
const module={exports:{}};
vm.runInNewContext(output,{module,exports:module.exports,require(name){
  if(name==='react')return React;
  if(name==='react/jsx-runtime')return jsx;
  if(name==='react-markdown')return{__esModule:true,default:markdownRenderer};
  if(name==='remark-gfm')return{__esModule:true,default:remarkGfm};
  if(name.endsWith('.css'))return{__esModule:true,default:{markdown:'markdown',tableScroll:'table-scroll',imageAlt:'image-alt'}};
  throw new Error(`Unexpected import: ${name}`);
}});
return module.exports;
}
const module={exports:loadMarkdown()};
const content='## 필요한 근거\n\n답변에는 **본인 역할**과 *배운 점*을 포함하세요.\n\n1. 탐구 동기\n2. 비교 조건\n\n- 시료 준비\n- 측정 기록\n\n[참고](https://example.com/reference)와 `측정값`을 확인하세요.\n\n```js\nconst result = "안전";\n```\n\n| 항목 | 근거 |\n| --- | --- |\n| 역할 | 준비 |\n\n> 기록을 먼저 확인하세요.\n\n<script>alert(1)</script>\n\n[위험 링크](javascript:alert(1))\n\n![그림 설명](https://example.com/tracking.png)';
const html=renderToStaticMarkup(React.createElement(module.exports.MarkdownMessage,{content}));
for(const token of ['<h2>필요한 근거</h2>','<strong>본인 역할</strong>','<em>배운 점</em>','<ol>','<ul>','href="https://example.com/reference"','<code>측정값</code>','<pre>','<table>','<blockquote>'])assert.ok(html.includes(token),`preserves Markdown: ${token}`);
assert.ok(!html.includes('<script>')&&!html.includes('javascript:')&&!html.includes('<img'),'HTML, executable URLs and remote-image embeds remain inactive');
assert.ok(html.includes('role="region" aria-label="답변 표" tabindex="0"'),'tables have an accessible local overflow region');
function render(content){return renderToStaticMarkup(React.createElement(module.exports.MarkdownMessage,{content}));}
for(const [content,expected] of [
  ['**「하천 수질 탐구에서 가장 어려웠던 점」**라면 먼저 기록을 보세요.','<strong>「하천 수질 탐구에서 가장 어려웠던 점」</strong>라면'],
  ['**『질문』**에는 근거를 넣어요.','<strong>『질문』</strong>에는'],
  ['**“내 역할”**은 무엇이었나요?','<strong>“내 역할”</strong>은'],
  ['**‘내 역할’**이라고 말했어요.','<strong>‘내 역할’</strong>이라고'],
  ['질문은 **「동기」**와 **「역할」**로 나뉘어요.','<strong>「동기」</strong>와 <strong>「역할」</strong>로'],
  ['**역할**: 측정 기록을 정리했어요.','<strong>역할</strong>:'],
  ['[**「질문」**이라면](https://example.com/question)','<strong>「질문」</strong>이라면'],
])assert.ok(render(content).includes(expected),`Korean emphasis: ${content}`);
for(const content of [
  '`**「질문」**라면`',
  '```md\n**「질문」**라면\n```',
  '\\*\\*「질문」\\*\\*라면',
  '\\**「질문」**라면',
  '&#42;&#42;「질문」&#42;&#42;라면',
  '**「질문』**라면',
])assert.ok(!render(content).includes('<strong>'),'code, escaped/entity literals and mismatched quotes are not repaired');
assert.ok(render('**「질문」**').includes('<strong>「질문」</strong>'),'standard quoted emphasis remains unchanged');
assert.ok(!render('**「질문」').includes('<strong>'),'incomplete streaming emphasis remains text');
const unsafe=render('**「질문」**이라면 <script>alert(1)</script> [위험](javascript:alert(1)) ![외부](https://example.com/track.png)');
assert.ok(unsafe.includes('<strong>「질문」</strong>이라면'),'Korean emphasis also works beside inactive unsafe content');
assert.ok(!unsafe.includes('<script')&&!unsafe.includes('javascript:')&&!unsafe.includes('<img'),'repair does not activate HTML, unsafe links or remote images');
console.log('Markdown: standard structure, 7 Korean emphasis cases, code/escape/streaming guards passed; unsafe HTML/URLs and embeds inactive');

function renderFriendly(content){return renderToStaticMarkup(React.createElement(module.exports.MarkdownMessage,{content,humanizeLearningStatuses:true}));}
const statuses='needs_confirmation / student_says_different / cannot_confirm / confirmed_from_record / confirmed_by_student';
assert.ok(render(statuses).includes('needs_confirmation'),'the opt-in flag preserves default Markdown output for other screens');
for(const [token,label] of [['needs_confirmation','확인 필요'],['student_says_different','기록과 다름'],['cannot_confirm','확인 어려움'],['confirmed_from_record','학생부에서 확인'],['confirmed_by_student','내가 확인함']]){
  assert.ok(renderFriendly(`현재 상태는 ${token}이므로 확인해 주세요.`).includes(`${label}이므로`),'plain prose displays the user-facing state');
  assert.ok(renderFriendly(`상태는 \`${token}\`입니다.`).includes(`<code>${label}</code>`),'a single status in inline code is only relabelled at display time');
}
const literalSource='**상태**: needs_confirmation\n\n1. `student_says_different`\n2. cannot_confirm\n\n[원문](https://example.com/needs_confirmation?state=cannot_confirm)\n\nhttps://example.com/student_says_different\n\n```json\n{"status":"needs_confirmation"}\n```\n\n`state.needs_confirmation` · prefix_needs_confirmation · needs_confirmation_suffix · x/cannot_confirm · @cannot_confirm';
const sourceBefore=literalSource, friendly=renderFriendly(literalSource);
assert.equal(literalSource,sourceBefore,'display translation never changes the passed source string');
for(const expected of ['<strong>상태</strong>: 확인 필요','<ol>','<code>기록과 다름</code>','확인 어려움','href="https://example.com/needs_confirmation?state=cannot_confirm"','https://example.com/student_says_different','&quot;status&quot;:&quot;needs_confirmation&quot;','state.needs_confirmation','prefix_needs_confirmation','needs_confirmation_suffix','x/cannot_confirm','@cannot_confirm'])assert.ok(friendly.includes(expected),`retains structure and non-status literals: ${expected}`);
assert.ok(renderFriendly('`needs_confirmation + cannot_confirm`').includes('<code>needs_confirmation + cannot_confirm</code>'),'inline code expressions are not edited');
assert.ok(!renderFriendly('needs_confirmati').includes('확인 필요'),'partial streaming tokens are not prematurely translated');
const friendlyUnsafe=renderFriendly('needs_confirmation <script>alert(1)</script> [위험](javascript:alert(1)) ![그림](https://example.com/track.png)');
assert.ok(friendlyUnsafe.includes('확인 필요')&&!friendlyUnsafe.includes('<script')&&!friendlyUnsafe.includes('javascript:')&&!friendlyUnsafe.includes('<img'),'the display plugin does not activate HTML, active URLs or remote embeds');
console.log('Learning status display: all 5 labels, opt-in default, AST/code/URL/identifier/streaming guards passed; original source unchanged');

// SSR still exercises the real parser and exposes the renderer configuration.
// It does not simulate client memo bailouts; the memo wrapper is checked directly.
assert.equal(module.exports.MarkdownMessage.$$typeof,Symbol.for('react.memo'),'history messages retain the React memo boundary');
const receivedProps=[];
const observed=loadMarkdown(props=>{
  receivedProps.push(props);
  return React.createElement(ReactMarkdown,props);
});
for(const props of [
  {content:'첫 답변 **근거**'},
  {content:'다음 답변 **비교**'},
  {content:'상태 needs_confirmation',humanizeLearningStatuses:true},
  {content:'상태 confirmed_by_student',humanizeLearningStatuses:true},
])renderToStaticMarkup(React.createElement(observed.MarkdownMessage,props));
assert.equal(receivedProps.length,4,'all changed inputs remain renderable with the real Markdown parser');
assert.equal(receivedProps[0].remarkPlugins,receivedProps[1].remarkPlugins,'default parsing plugins keep one stable configuration');
assert.equal(receivedProps[2].remarkPlugins,receivedProps[3].remarkPlugins,'humanized parsing plugins keep one stable configuration');
assert.notEqual(receivedProps[0].remarkPlugins,receivedProps[2].remarkPlugins,'status translation stays opt-in');
for(const props of receivedProps)assert.equal(props.components,receivedProps[0].components,'table/link/image renderers remain stable across content and display-mode changes');
console.log('Streaming render stability: React memo boundary, stable real-parser plugin lists and stable element renderers passed');
