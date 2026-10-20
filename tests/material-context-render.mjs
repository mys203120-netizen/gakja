import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { tsImport } from 'tsx/esm/api';

// Exercise the actual workspace components and route links using frozen fixture
// snapshots. No requests, database writes, provider calls or browser mocks.
const material = await tsImport('../apps/web/src/lib/material-learning-flow.ts', import.meta.url);
const growth = await tsImport('../apps/web/src/lib/learning-growth.ts', import.meta.url);
const navigation = await tsImport('../apps/web/src/lib/learning-navigation.ts', import.meta.url);
const studyLinks = await tsImport('../apps/web/src/lib/study-record-links.ts', import.meta.url);
let query = new URLSearchParams(), workflows = { versions: [] };
let renderStates = [], stateCursor = 0;
const app = { targetId: 'uos', data: {
  user: { id: 'student' }, package: { active_version: 6 }, answers: [], documents: [],
  learning: { activities: [{ id: 'a1', title: '물 조사', source_ref_ids: [] }], source_refs: [], memory_items: [], answer_scripts: [],
    questions: [{ id: 'q1', prompt: '역할은?', verification_status: 'approved', support_target_ids: ['uos'], activity_ids: ['a1'] }] },
} };
function load(file, exports) {
  const source = fs.readFileSync(new URL('../apps/web/src/components/' + file, import.meta.url), 'utf8') + '\nexport {' + exports.join(',') + '};';
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, URLSearchParams, Intl, require(name) {
    if (name === 'react') return { useState: initial => [stateCursor < renderStates.length ? renderStates[stateCursor++] : typeof initial === 'function' ? initial() : initial, () => {}], useRef: initial => ({ current: initial }), useEffect() {}, useCallback: fn => fn };
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
    if (name === 'next/link') return { __esModule: true, default: 'Link' };
    if (name === 'next/navigation') return { useSearchParams: () => query, useRouter: () => ({}) };
    if (name === './app-shell') return { useApp: () => app };
    if (name === './practice') return { useLearningWorkflows: () => ({ workflows, loading: false, error: '', reload() {} }) };
    if (name === './shared') return new Proxy({}, { get: (_, key) => key === 'dateLabel' ? String : String(key) });
    if (name === '@/lib/material-learning-flow') return material;
    if (name === '@/lib/learning-growth') return growth;
    if (name === '@/lib/learning-navigation') return navigation;
    if (name === '@/lib/study-record-links') return studyLinks;
    if (name === '@/lib/document-delivery-client') return { loadDocumentOriginal: async () => { throw new Error('Document downloads are outside this frozen render fixture.'); } };
    if (name === '@/lib/planner-model') return { koreaToday: () => '2026-10-15' };
    if (name.endsWith('.module.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
    if (name.startsWith('./') || name === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
    throw new Error('Unexpected import ' + name);
  } });
  return module.exports;
}
const materials = load('materials.tsx', ['ActivityDetail', 'QuestionDetail', 'AnswerEditor']);
const records = load('records.tsx', ['AnswerComparisons', 'StudyAnswer', 'StudyReport']);
function nodes(value) { return Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children)] : []; }
function label(value) { return Array.isArray(value) ? value.map(label).join(' ') : value && typeof value === 'object' ? label(value.props?.children) : String(value ?? ''); }
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function link(tree, text) { return nodes(tree).find(node => node.type === 'Link' && label(node).includes(text)); }
function context(href, key, id) {
  const url = new URL(href, 'http://localhost');
  check(url.searchParams.get(key) === id, 'material handoff keeps the exact entity');
  check(url.searchParams.get('targetId') === 'uos', 'material handoff keeps the selected school');
  check(url.searchParams.get('sourceType') === 'personal' && url.searchParams.get('sourceVersion') === '6', 'material handoff keeps its approved personal publication');
}
let tree = materials.Materials({ slug: ['briefings', 'news', 'article'] });
let crumbs = nodes(tree).find(node => node.type === 'Breadcrumb').props.items;
check(crumbs.map(item => item.label).join('/') === '자료/시사/기사', 'news breadcrumbs belong to the material resource section rather than personal textbooks');
tree = materials.Materials({ slug: ['answers', 'q1'] });
crumbs = nodes(tree).find(node => node.type === 'Breadcrumb').props.items;
check(crumbs.map(item => item.label).join('/') === '자료/내 교재/답변 초안/상세', 'prepared scripts have an explicit material child hierarchy');
tree = materials.ActivityDetail({ id: 'a1' });
context(link(tree, '각자ON에서 정리').props.href, 'activityId', 'a1');
tree = materials.QuestionDetail({ id: 'q1' });
context(link(tree, '각자ON에서 답변 설계').props.href, 'questionId', 'q1');
context(link(tree, '내 답변의 변화').props.href, 'questionId', 'q1');
check(label(link(tree, '답변 초안 작성')).includes('답변 초안'), 'authored scripts are labelled drafts instead of actual spoken answers');
tree = materials.AnswerEditor({ id: 'q1' });
context(link(tree, '각자ON에서 다듬기').props.href, 'questionId', 'q1');
context(link(tree, '답변 비교').props.href, 'questionId', 'q1');

const base = { question_id: 'q1', question: '역할은?', target_id: 'uos', target_snapshot: { university: '서울시립대학교', department: '환경공학부', admission_year: 2027 }, content_version: 6, source_type: 'personal', script: '제가 측정했습니다.', source_status: 'saved', practice_kind: 'personal', revision: 1, created_at: '2026-10-15T10:00:00Z' };
workflows = { versions: [
  { ...base, id: 'owned-before' }, { ...base, id: 'owned-after', created_at: '2026-10-15T10:01:00Z' },
  { ...base, id: 'other-school', target_id: 'other' }, { ...base, id: 'other-book', content_version: 5 },
  { ...base, id: 'unknown-school', target_id: null }, { ...base, id: 'common', source_type: 'common', common_revision: 6 },
] };
query = new URLSearchParams('questionId=q1&targetId=uos&sourceType=personal&sourceVersion=6');
tree = records.AnswerComparisons({});
const picks = nodes(tree).filter(node => node.type === 'select' && node.props['aria-label']?.endsWith('저장 시점'));
check(picks.length === 2, 'the actual comparison component renders two answer pickers for this publication');
for (const pick of picks) check(nodes(pick).filter(node => node.type === 'option').map(node => node.props.value).join(',') === 'owned-before,owned-after', 'the actual picker excludes unrelated schools, old books, common sources and unknown provenance');
query.set('sourceVersion', '8'); tree = records.AnswerComparisons({});
check(nodes(tree).some(node => node.type === 'Empty' && node.props.title === '선택한 학습 맥락에 저장한 답변이 없어요'), 'missing scoped history shows an honest empty state instead of borrowing a different book');
check(!nodes(tree).some(node => node.type === 'select'), 'no unrelated answer selector is rendered when the requested publication has no answers');

// Preparation cards link to one observed question, experience or student-record activity.
// Render the actual destination component to verify all three activityId shapes.
workflows={versions:[
 {...base,id:'readiness-q-before',experience_card:{id:'owned-experience'}},
 {...base,id:'readiness-q-after',created_at:'2026-10-15T10:01:00Z',experience_card:{id:'owned-experience'}},
 {...base,id:'readiness-other-question',question_id:'q2'},
 {...base,id:'readiness-other-school',target_id:'other'},
]};
for(const activityId of ['question:q1','experience:owned-experience','a1']){
 query=new URLSearchParams({activityId,targetId:'uos'});tree=records.AnswerComparisons({});
 const destinationPicks=nodes(tree).filter(node=>node.type==='select'&&node.props['aria-label']?.endsWith('저장 시점'));
 check(destinationPicks.length===2,`preparation ${activityId} destination renders the matching submitted answers`);
 for(const pick of destinationPicks)check(nodes(pick).filter(node=>node.type==='option').map(node=>node.props.value).join(',')==='readiness-q-before,readiness-q-after',`preparation ${activityId} destination excludes unrelated questions and schools`);
}

const savedCommon={questionId:'common_motivation',memoryItemId:'common:memory',target_id:'saved-school',source_type:'general_practice',common_revision:3,contentVersion:6,response:'제가 직접 답한 내용입니다.'};
tree=records.StudyAnswer({event:{kind:'quiz_response',created_at:'2026-10-15T10:00:00Z',data:savedCommon}});
let savedHref=new URL(link(tree,'이 질문의 답변 비교').props.href,'http://localhost');
check(app.targetId==='uos'&&savedHref.searchParams.get('targetId')==='saved-school','actual study-history comparison uses the event school even while a different school is selected');
check(savedHref.searchParams.get('sourceType')==='common'&&savedHref.searchParams.get('sourceVersion')==='3','actual study-history comparison preserves reviewed common revision rather than unrelated personal publication');
tree=records.StudyAnswer({event:{kind:'interview_answer',source_id:'saved-turn',created_at:'2026-10-15T10:00:00Z',data:{...savedCommon,targetId:'saved-school',commonRevision:3}}});
savedHref=new URL(link(tree,'이 질문의 답변 비교').props.href,'http://localhost');
check(savedHref.searchParams.get('turnId')==='saved-turn','actual interview-history comparison anchors the saved turn');
tree=records.StudyAnswer({event:{kind:'quiz_response',created_at:'2026-10-15T10:00:00Z',data:{questionId:'legacy-question',response:'이전 답변'}}});
check(link(tree,'이 질문의 답변 비교').props.href==='/records/comparisons/legacy-question','legacy history does not invent the currently selected target or publication');
renderStates=[{session:{id:'study-old',started_at:'2026-10-15T10:00:00Z',state:'finalized',report:{weakPoints:[savedCommon]}},sourceFacts:[]},''];stateCursor=0;
tree=records.StudyReport({id:'study-old'});renderStates=[];stateCursor=0;
savedHref=new URL(nodes(tree).find(node=>node.type==='LinkedRow').props.href,'http://localhost');
check(savedHref.searchParams.get('memoryItemId')==='common:memory'&&savedHref.searchParams.get('targetId')==='saved-school','actual frozen study-report retry preserves its memory item and original school');
check(savedHref.searchParams.get('sourceType')==='common'&&savedHref.searchParams.get('sourceVersion')==='3','actual weak-point retry preserves its reviewed common source');
console.log(`Material handoff and actual comparison render: ${checks} checks passed; external calls: 0.`);
