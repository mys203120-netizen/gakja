import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import * as ReactDOM from 'react-dom';
import { tsImport } from 'tsx/esm/api';

// Exercise the real bootstrap query contract and actual history/dashboard
// components with overview-only records. This test never writes to a database,
// starts a server, reads credentials, or makes a provider request.
const scope = await tsImport('../apps/web/src/lib/learning-target-scope.ts', import.meta.url);
const automatic = await tsImport('../apps/web/src/lib/automatic-practice.ts', import.meta.url);
const deadlines = await tsImport('../apps/web/src/lib/dashboard-deadlines.ts', import.meta.url);
const agenda = await tsImport('../apps/web/src/lib/dashboard-agenda.ts', import.meta.url);
const schedule = await tsImport('../apps/web/src/lib/schedule.ts', import.meta.url);
const journey = await tsImport('../apps/web/src/lib/learning-journey.ts', import.meta.url);
const flow = await tsImport('../apps/web/src/lib/learning-flow-view.ts', import.meta.url);
const studyLinks = await tsImport('../apps/web/src/lib/study-record-links.ts', import.meta.url);
const target = { id: 'owned-school', university: '서울시립대학교', department: '환경공학부', admission_year: 2027, campus: '본교', admission_type: '학생부종합Ⅰ' };
const question = { id: 'q-frozen', prompt: '저장 당시 진행하던 질문', activity_ids: ['a-frozen'], source_type: 'personal' };
const activity = { id: 'a-frozen', title: '저장 당시 하천 조사', source_ref_ids: ['source-frozen'] };
const own = { id: 'session-own', student_id: 'student', target_id: target.id, kind: 'video', state: 'active', content_version: 5, created_at: '2026-10-12', updated_at: '2026-10-15', data: { context: { target: { ...target }, targetId: target.id, activities: [activity] }, index: 1, questionCount: 4, currentQuestion: question, trainingPurpose:'diagnostic',trainingPlanId:'training-plan-own' } };
const previous = { ...own, id: 'session-previous', data: { ...own.data, context: { target: { ...target, department: '이전 학과' }, targetId: target.id, activities: [] }, currentQuestion: { ...question, id: 'q-previous', prompt: '이전 지원 정보의 질문' } } };
const completed = { ...own, id: 'session-completed', state: 'completed', data: { ...own.data, currentQuestion: null,trainingPurpose:'focus' } };
const cancelled = { ...completed, id: 'session-cancelled', state: 'cancelled' };
const threads = [{ id: 'thread-own', student_id: 'student', target_id: target.id, content_version: 5, title: '하천 조사 질문', created_at: '2026-10-12', updated_at: '2026-10-15', archived_at: null, deleted_at: null }];
const calls = [];
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
const dataModule = { exports: {} };
vm.runInNewContext(compile(fs.readFileSync(new URL('../apps/web/src/lib/data.ts', import.meta.url), 'utf8')), { module: dataModule, exports: dataModule.exports, require(name) {if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value)=>value};
  if (name === 'server-only') return {};
  if (name === './school-directory') return { enrichSchoolTarget: value => value };
  if (name === './admin-training') return {adminTrainingSummary(){throw new Error('Student bootstrap must not read administrative training summaries.');}};
  if (name === './student-read-model') return {readStudentModel:async(_student,_kind,_scope,build)=>build()};
  if (name === './planner-model') return {koreaToday:()=> '2026-10-15'};
  if (name === './db') return { ApiError: Error, async query(sql, parameters) {
    calls.push({ sql, parameters });
    if(sql.includes('as unread_notifications'))return [{answers:3,interviews:4,memory:2,confirmations:1,unread_notifications:0}];
    if (sql.includes('from chat_threads')) throw new Error('History cannot be fetched while loading the shell.');
    if (sql.includes('from interview_sessions')) return structuredClone([previous,own]);
    if (sql.includes('from support_targets')) return [{ id: target.id, student_id: 'student', data: { ...target } }];
    return [];
  } };
  throw new Error('Unexpected bootstrap import: ' + name);
} });
const data = await dataModule.exports.bootstrap({ id: 'student', name: '하린', role: 'student' });
const interviewQuery = calls.find(call => call.sql.includes('from interview_sessions')&&!call.sql.includes('as unread_notifications'));
check(!calls.some(call=>call.sql.includes('from chat_threads')||call.sql.includes('from interview_reports')||/select \* from user_answers/.test(call.sql)), 'the shell never reads history bodies or report JSON');
check(!interviewQuery.sql.includes('select *') && /where student_id=\$1/.test(interviewQuery.sql), 'interview projection keeps the owning student boundary');
check(interviewQuery.sql.includes("state='active'")&&interviewQuery.sql.includes('distinct on(target_id,kind)'), 'active resume is selected independently from recent history pagination');
check(interviewQuery.sql.includes("'target',data->'context'->'target'") && interviewQuery.sql.includes("'targetId',data->'context'->'targetId'"), 'frozen target identity is selected from the saved session');
check(interviewQuery.sql.includes("'trainingPurpose',data->'trainingPurpose'") && interviewQuery.sql.includes("'trainingPlanId',data->'trainingPlanId'"), 'the student-owned overview retains the purpose and plan identity required for unified training');
check(interviewQuery.sql.includes("jsonb_typeof(data->'questionQueue')='array'"), 'legacy missing/non-array question queues do not throw an array-length error');
check(interviewQuery.sql.includes("'currentQuestion',case when state='active'") && interviewQuery.sql.includes('jsonb_extract_path'), 'only the active queue position is projected as a dashboard preview');
check(!/questions|answerScripts|studentContext|feedback|draft/.test(interviewQuery.sql), 'bootstrap SQL excludes answer resources, feedback, drafts, and AI processing facts');
check(interviewQuery.sql.includes("current_question->'activity_ids' ? (value->>'id')"), 'only activities linked to the current question are projected');
check(calls.every(call => call.parameters?.[0] === 'student'), 'every student bootstrap query remains student scoped');
check(data.interviews.length===2&&data.threads.length===0&&data.reports.length===0&&data.answers.length===0,'shell contains active resume and no history bodies');
check(data.summary.interviews===4&&data.summary.memory===2,'full-history counts are represented by compact summary fields');
check(data.interviews.find(row=>row.id==='session-own').data.trainingPurpose==='diagnostic'&&data.interviews.find(row=>row.id==='session-own').data.trainingPlanId==='training-plan-own', 'own-session training metadata survives the compact bootstrap result');
check(!data.interviews[1].data.questionQueue, 'render fixtures contain no full thread context or interview queue');

let app = { data, target, targetId: target.id, learningRevision: 0, toast() {} };
let values = [], cursor = 0, queuedEffects = [];
const requests = [];
const shared = { api: async url => { requests.push(url); return { threads: [{ ...threads[0], id: 'archived-own', title: '보관한 질문', archived_at: '2026-10-14' }] }; }, post: async () => ({}), PageTitle: 'PageTitle', LinkedRow: 'LinkedRow', Alert: 'Alert', Empty: 'Empty', Modal: 'Modal', Breadcrumb: 'Breadcrumb', Badge: 'Badge', Spinner: 'Spinner', dateLabel: String, targetName: item => item?.university || '', targetMajor: item => item?.department || item?.major || '' };
function loadComponent(name) {
  const module = { exports: {} };
  vm.runInNewContext(compile(fs.readFileSync(new URL('../apps/web/src/components/' + name, import.meta.url), 'utf8')), { module, exports: module.exports, Date, Intl, Set, URLSearchParams, document: { body: { nodeType: 1 } }, require(id) {if(id==='./owned-class-name'||id==='@/components/owned-class-name')return {ownedClassName:(value)=>value};
    if (id === 'react') return { useState(initial) { const key = cursor++; if (!(key in values)) values[key] = typeof initial === 'function' ? initial() : initial; return [values[key], next => { values[key] = typeof next === 'function' ? next(values[key]) : next; }]; }, useEffect(callback) { queuedEffects.push(callback); }, useLayoutEffect() {}, useId: () => 'overview-menu', useCallback: callback => callback, useRef: current => ({ current }) };
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
    if (id === 'react-dom') return ReactDOM;
    if (id === 'next/link') return { __esModule: true, default: 'Link' };
    if (id === 'next/navigation') return { useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push() {} }) };
    if(id==='./use-record-pages')return {useRecordPages:kind=>({items:kind==='interviews'?[previous,own,completed,cancelled]:[],page:{hasMore:false},loading:false,error:'',more(){}}),useRecordDetail:()=>({item:null,loading:false,error:''})};
    if (id === './app-shell') return { useApp: () => app };
    if (id === './sliding-choice') return {MotionSwitch:'MotionSwitch',SlidingChoice:'SlidingChoice'};
    if (id === './shared') return shared;
    if (id === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
    if (id.endsWith('.module.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
    if (id === '@/lib/learning-target-scope') return scope;
    if (id === '@/lib/automatic-practice') return automatic;
    if (id === '@/lib/dashboard-deadlines') return deadlines;
    if (id === '@/lib/dashboard-agenda') return agenda;
    if (id === '@/lib/schedule') return schedule;
    if (id === '@/lib/learning-journey') return journey;
    if (id === '@/lib/learning-flow-view') return flow;
    if (id === '@/lib/planner-model') return { koreaToday: () => '2026-10-15' };
    if (id === '@gakja/content-contracts/workflows') return { learningTargetIdentityMatches: (a, b) => JSON.stringify(a) === JSON.stringify(b) };
    if (id === '@/lib/interview-flow') return { interviewSetupHref: kind => '/interview/' + kind };
    if (id === './interview') return { InterviewSetup: 'InterviewSetup', InterviewSession: 'InterviewSession' };
    if (id === './dashboard-planner') return { DashboardPlanner: 'DashboardPlanner' };
    if (id === './department-news') return { DepartmentNews: 'DepartmentNews' };
    if (id === '@/lib/learning-growth') return { growthContextResolver() {} };
    if (id === '@/lib/material-learning-flow') return { materialComparisonVersions() {} };
    if (id === '@/lib/learning-navigation') return { learningRetryHref() {} };
    if (id === '@/lib/study-record-links') return studyLinks;
    if (['./record-media', './speech-growth', './comparison-observation', './markdown-message', './comparison-wipe', './practice', './study-session-provider','./settings-select'].includes(id)) return new Proxy({}, { get: (_, key) => String(key) });
    throw new Error('Unexpected component import: ' + id);
  } });
  return module.exports;
}
function render(callback, initial) { if (initial) values = initial; cursor = 0; queuedEffects = []; return callback(); }
function nodes(tree) { return Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children ?? tree.children)] : []; }
function text(tree) { return Array.isArray(tree) ? tree.map(text).join(' ') : tree && typeof tree === 'object' ? text(tree.props?.children) : tree == null ? '' : String(tree); }
function openedHistoryMenu(historyTree) {
  // Render the actual child and activate its trigger. Real ReactDOM creates the
  // portal record; browser positioning/focus effects remain outside this test.
  const child = nodes(historyTree).find(node => typeof node.type === 'function' && node.props.thread);
  const saved = { values, cursor, queuedEffects };
  try {
    let menu = render(() => child.type(child.props), []);
    nodes(menu).find(node => node.type === 'button' && node.props['aria-haspopup'] === 'menu').props.onClick();
    menu = render(() => child.type(child.props));
    check(nodes(menu).some(node => node.props?.role === 'menu'), 'the actual history trigger opens its menu portal');
    return menu;
  } finally { ({ values, cursor, queuedEffects } = saved); }
}
const interviews = loadComponent('interview-pages.tsx');
let tree = render(() => interviews.InterviewPages({}), []);
const primary = nodes(tree).find(node => node.type === 'section' && node.props.className.includes('resumeSection'));
const resume = nodes(primary).find(node => node.type === 'LinkedRow');
check(resume.props.href === '/interview/session-own?kind=video', 'the actual interview component resumes the owned current-school session');
check(resume.props.subtitle.includes('문항 2/4'), 'questionCount preserves queue progress without transporting question bodies');
const previousGroup = nodes(tree).find(node => node.type === 'details' && text(node).includes('다른 지원처'));
check(nodes(previousGroup).some(node => node.type === 'LinkedRow' && node.props.title.includes('이전 학과')), 'a changed target with the same ID stays in frozen historical context');
check(!nodes(tree).some(node => node.type === 'LinkedRow' && /completed|cancelled/.test(node.props.href)), 'completed and cancelled sessions are absent from resume choices');
tree = render(() => interviews.InterviewPages({ slug: ['session-own'] }), []);
check(tree.type === 'InterviewSession' && tree.props.kind === 'video', 'opening an overview row still routes to the existing full detail component');

const dashboard = loadComponent('dashboard.tsx');
const scopeKey = JSON.stringify([data.user.id, target.id, scope.learningScopeIdentity(target), data.package?.id, data.package?.active_version]);
const loading = { scope: scopeKey, learning: false, planner: false, study: false, knowledge: false, quiz: false, schools: false };
tree = render(() => dashboard.Dashboard(), [{ assignments: [], answerRevisions: [], confirmations: [] }, {}, [], [], {}, { commonQuestions: [] }, '', true, true, true, 'briefing', [], undefined, [], loading]);
check(text(tree).includes(question.prompt), 'actual dashboard uses the compact frozen currentQuestion rather than a replacement question');
check(text(tree).includes(activity.title), 'actual dashboard retains the current activity label from compact resources');
check(nodes(tree).some(node => node.type === 'Link' && node.props.href === '/interview/session-own?kind=video'), 'dashboard resume remains attached to the same interview detail');

const history = loadComponent('chat-history.tsx');
tree = render(() => history.ChatHistory({ threads, onChange() {} }), []);
check(nodes(tree).some(node => node.type === 'Link' && node.props.href === '/on/thread-own' && text(node) === threads[0].title), 'actual chat history opens metadata-only threads');
let menu = openedHistoryMenu(tree);
check(nodes(menu).some(node => node.type === 'button' && text(node).includes('이름 바꾸기')) && nodes(menu).some(node => node.type === 'button' && text(node).includes('보관')) && nodes(menu).some(node => node.type === 'button' && text(node).includes('삭제')), 'rename, archive and delete controls remain available with summary records');
nodes(tree).find(node => node.type === 'SlidingChoice').props.onChange('archived');
render(() => history.ChatHistory({ threads, onChange() {} }));
await Promise.all(queuedEffects.map(callback => callback()));
await new Promise(resolve => setImmediate(resolve));
tree = render(() => history.ChatHistory({ threads, onChange() {} }));
check(requests.includes('/api/chat?view=archived') && text(tree).includes('보관한 질문'), 'archived threads still load from their existing owned history endpoint');
menu = openedHistoryMenu(tree);
check(nodes(menu).some(node => node.type === 'button' && text(node).includes('보관 해제')), 'archive restoration remains available');

const records = loadComponent('records.tsx');
tree=render(()=>{const route=records.RecordsPages({slug:['history']});return typeof route.type==='function'?route.type(route.props):route;},[]);
const retainedRows = nodes(tree).filter(node => node.type === 'LinkedRow' && node.props.href.startsWith('/interview/'));
check(retainedRows.length === 4, 'actual records history retains all completed, cancelled, previous and active interview links');
check(retainedRows.some(node => text(node.props.end) === '완료') && retainedRows.some(node => text(node.props.end) === '취소'), 'history completion and cancellation states survive overview compaction');
check(retainedRows.some(node=>node.props.title==='첫 진단')&&retainedRows.some(node=>node.props.title==='집중 보완'), 'records use the saved training purpose instead of falling back to separate input-mode titles');
console.log(`${checks} bootstrap overview/query and actual component checks passed.`);
