import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { tsImport } from 'tsx/esm/api';

const scope = await tsImport('../apps/web/src/lib/learning-target-scope.ts', import.meta.url);
const interviewScope = await tsImport('../apps/web/src/lib/school-interview-scope.ts', import.meta.url);
const planner = await tsImport('../apps/web/src/lib/planner-model.ts', import.meta.url);
const schedule = await tsImport('../apps/web/src/lib/schedule.ts', import.meta.url);
const calendarPresentation = await tsImport('../apps/web/src/lib/calendar-presentation.ts', import.meta.url);
const calendarSourcePresentation = await tsImport('../apps/web/src/lib/calendar-source-presentation.ts', import.meta.url);
const planSummary = await tsImport('../apps/web/src/lib/training-plan-summary.ts', import.meta.url);
const hooks = { values: [], index: 0,refs:[],refIndex:0 };
const browser={mobile:false,reducedMotion:false,scrollPadding:80,frames:new Map(),nextFrame:0};
let app;
const actionButton=({pending=false,pendingLabel,disabled,children,type='button',...props})=>({type:'button',props:{...props,type,disabled:disabled||pending,'aria-busy':pending||undefined,children:pending?[{type:'LoaderCircle',props:{size:16,'aria-hidden':true}},pendingLabel??children]:children}});
const shared = { InfoTip:'InfoTip',ActionButton:actionButton, api: async () => { throw new Error('No API calls in component regression.'); }, post: async () => ({}), Breadcrumb: 'Breadcrumb', PageTitle: 'PageTitle', Alert: 'Alert', Spinner: 'Spinner', Empty: 'Empty', Modal: 'Modal', LinkedRow: 'LinkedRow', targetName: target => target?.university || '지원처 미등록', targetMajor: target => target?.department || target?.major || '', dateLabel: value => String(value) };
function load(file) {
  const module = { exports: {} };
  const source = fs.readFileSync(new URL(`../apps/web/src/components/${file}`, import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, URLSearchParams, Date, Intl, Set,
    window:{matchMedia:query=>({matches:query.includes('reduced-motion')?browser.reducedMotion:browser.mobile}),getComputedStyle:()=>({scrollPaddingTop:browser.scrollPadding+'px'})},
    document:{scrollingElement:{},querySelector:()=>({getBoundingClientRect:()=>({bottom:64})})},
    requestAnimationFrame(callback){const id=++browser.nextFrame;browser.frames.set(id,callback);return id;},
    cancelAnimationFrame:id=>browser.frames.delete(id),
    require(name) {
      if (name === 'react') return { useRef(initial){const index=hooks.refIndex++;return hooks.refs[index]??={current:initial};}, useState(initial) { const index = hooks.index++; if (!(index in hooks.values)) hooks.values[index] = typeof initial === 'function' ? initial() : initial; return [hooks.values[index], value => { hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value; }]; }, useEffect() {} };
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => type===actionButton?actionButton(props):({ type, props }), jsxs: (type, props) => type===actionButton?actionButton(props):({ type, props }), Fragment: 'Fragment' };
      if (name === 'next/link') return { __esModule: true, default: 'Link' };
      if (name === 'next/navigation') return { useSearchParams: () => new URLSearchParams(), useRouter: () => ({replace(){}}) };
      if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
      if (name === './app-shell') return { useApp: () => app };
      if (name === './shared') return shared;
      if (name === '@/lib/learning-target-scope') return scope;
      if (name === '@/lib/school-interview-scope') return interviewScope;
      if (name === '@/lib/planner-model') return planner;
      if (name === '@/lib/schedule') return schedule;
      if (name === '@/lib/calendar-presentation') return calendarPresentation;
      if (name === '@/lib/calendar-source-presentation') return calendarSourcePresentation;
      if (name === '@/lib/training-plan-summary') return planSummary;
      if (name === '@/lib/interview-flow') return { interviewSetupHref: (kind, _params, updates) => `/interview/${kind}?targetId=${updates.targetId}` };
      if (name === './interview') return { InterviewSetup: 'InterviewSetup', InterviewSession: 'InterviewSession' };
      if (name === './school-registration') return { SchoolRegistration: 'SchoolRegistration' };
      if (name === './automatic-practice-plan') return { AutomaticPracticePlan: 'AutomaticPracticePlan' };
      if (name === './school-logo') return { SchoolLogo: 'SchoolLogo' };
      if (name.endsWith('.module.css')) return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
      if (name.endsWith('.css')) return {};
      throw new Error(`Unexpected import ${name}`);
    },
  });
  return module.exports;
}
const school = load('schools.tsx'), interviews = load('interview-pages.tsx'), calendar = load('dashboard-planner.tsx');
function nodes(tree) { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!tree || typeof tree !== 'object') return []; return [tree, ...nodes(tree.props?.children)]; }
function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(' '); if (tree && typeof tree === 'object') return text(tree.props?.children); return tree == null ? '' : String(tree); }
function render(callback, values) { if (values) {hooks.values = values;hooks.refs=[];} hooks.index = 0;hooks.refIndex=0; return callback(); }
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
const target = { id: 'uos', university: '서울시립대학교', admission_year: 2027, campus: '본교', department: '환경공학부', admission_type: '학생부종합Ⅰ', profile: { status: 'official_confirmed', format: 'document_individual', interviewer_count: { min: 2, max: 2 }, applicant_count: { min: 1, max: 1 }, interview_minutes: { min: 12, max: 12 }, source: { source_url: 'https://example.edu/admissions.pdf', checked_at: '2026-10-14' } } };
const other = { ...target, id: 'other', university: '다른대학교' };
app = { data: { targets: [target, other], interviews: [], package: {} }, targetId: target.id, setTargetId() {} };
let tree = render(() => school.SchoolPages({ slug: [target.id] }), [[], [target], '', false]);
const overviewNode = nodes(tree).find(node => node.type?.name === 'SchoolOverview');
tree = render(() => overviewNode.type(overviewNode.props), []);
const overviewNodes = nodes(tree), summaryNode = overviewNodes.find(node => node.type?.name === 'SchoolInterviewSummary');
check(overviewNodes.indexOf(summaryNode) < overviewNodes.findIndex(node => node.type?.name === 'SchoolTalent'), 'interview summary precedes talent content');
check(overviewNodes.indexOf(summaryNode) < overviewNodes.findIndex(node => node.type === 'details'), 'interview summary precedes folded details');
const pending = { interviewSchedules: [], interviewScheduleCoverage: { targets: [{ targetId: target.id, status: 'date_pending' }] } };
tree = render(() => summaryNode.type(summaryNode.props), [pending, false]);
check(text(tree).includes('12분') && text(tree).includes('2명') && text(tree).includes('서류 기반 개인 면접'), 'verified duration, panel and format appear in the first summary');
check(text(tree).includes('날짜 미정') && !text(tree).includes('면접 미실시'), 'pending date is not no interview');
check(nodes(tree).some(node => node.type === 'a' && node.props.href === target.profile.source.source_url), 'official overview source remains visible');
tree = render(() => summaryNode.type(summaryNode.props), [{ ...pending, interviewScheduleCoverage: { targets: [{ targetId: target.id, status: 'no_interview' }] } }, false]);
check(text(tree).includes('면접 미실시') && !text(tree).includes('날짜 미정') && !text(tree).includes('12분'), 'confirmed no-interview status does not present a fabricated interview duration');
tree = render(() => summaryNode.type(summaryNode.props), [{ interviewSchedules: [{ targetId: 'other', applicability: 'track_match', startDate: '2026-12-20', endDate: '2026-12-20' }], interviewScheduleCoverage: pending.interviewScheduleCoverage }, false]);
check(!text(tree).includes('12월 20일'), 'another target date never becomes this school summary');

const ownSession = { id: 'own', target_id: target.id, state: 'active', kind: 'chat', data: { context: { target: { ...target } }, questionQueue: ['q'] } };
const oldSession = { ...ownSession, id: 'old', target_id: other.id, data: { context: { target: other }, questionQueue: ['q'] } };
app.data.interviews = [oldSession, ownSession];
tree = render(() => interviews.InterviewPages({}), []);
let primary = nodes(tree).find(node => node.type === 'section' && node.props.className.includes('resumeSection'));
check(nodes(primary).some(node => node.type === 'LinkedRow' && node.props.href.includes('/own?')), 'selected target session is the primary resume action despite other session ordering');
check(!nodes(primary).some(node => node.type === 'LinkedRow' && node.props.href.includes('/old?')), 'another school session is absent from the primary resume group');
let history = nodes(tree).find(node => node.type === 'details' && text(node).includes('다른 지원처'));
check(!history.props.open && nodes(history).some(node => node.props?.title?.includes('다른대학교')), 'other target history is initially folded and keeps its frozen school label');
app.targetId = other.id;
tree = render(() => interviews.InterviewPages({}), []);
primary = nodes(tree).find(node => node.type === 'section' && node.props.className.includes('resumeSection'));
check(nodes(primary).some(node => node.type === 'LinkedRow' && node.props.href.includes('/old?')), 'changing the selected target changes the primary resume action');

const today = planner.koreaToday();
const classNodes = (tree, className) => nodes(tree).filter(node => typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(className));
const agendaOf = tree => classNodes(tree, 'planner-day-agenda')[0];
const eventRows = tree => classNodes(tree, 'calendar-event');
const eventSchoolLinks = tree => eventRows(tree).flatMap(row => nodes(row).filter(node => node.type === 'a' && /^\/schools\//.test(node.props.href)).map(node => node.props.href)).sort();
const calendarDay = (tree, day) => nodes(tree).find(node => node.type === 'button' && node.props['aria-label']?.startsWith(day));
const official = (school, overrides = {}) => ({
  id: `official:${school.id}`, schoolReferenceId: `school:${school.id}`, university: school.university,
  targetId: school.id, admissionYear: 2027, campus: '본교', trackLabel: school.admission_type,
  departmentLabel: school.department, matchedDepartment: school.department, departmentCount: 1,
  startDate: today, endDate: today, sourceUrl: `https://admissions.example.test/${school.id}/calendar`,
  sourceLabel: '입학처', checkedAt: `${today}T00:00:00+09:00`, applicability: 'track_match', schoolHref: `/schools/${school.id}`,
  ...overrides,
});
app.targetId = target.id;
app.data.targets = [{ ...target, interview_date: today }, { ...other, interview_date: today }];
const props = { plans: [], tasks: [], onPlans() {}, loaded: true };
tree = render(() => calendar.DashboardPlanner(props), []);
let agenda = agendaOf(tree);
check(text(agenda).includes(target.university) && text(agenda).includes(other.university) && eventRows(agenda).length === 2, 'calendar agenda immediately includes every registered school');
check(text(tree).includes('지원 학교 전체') && !classNodes(tree, 'otherCalendar').length && !text(tree).includes('전체 지원처 달력 보기'), 'calendar scope is explicit without hiding other schools behind an extra action');
const legend = classNodes(tree, 'calendar-legend')[0];
check(nodes(legend).filter(node => node.type === 'span' && text(node).trim() === '면접').length === 1 && !text(legend).includes('내 면접') && !text(legend).includes('학교 면접'), 'calendar has one interview category alongside plans and assignments');
const beforeSwitch = eventSchoolLinks(agenda);
app.targetId = other.id;
tree = render(() => calendar.DashboardPlanner(props), []);
check(JSON.stringify(eventSchoolLinks(agendaOf(tree))) === JSON.stringify(beforeSwitch), 'changing the selected learning school never removes another registered school from the calendar');
// A matched public date and an allocated personal time describe one interview.
app.targetId = target.id;
const timedTarget = { ...target, schedule: { personal_date: today, personal_at: `${today}T10:30:00+09:00`, period_start: today, period_end: today } };
app.data.targets = [timedTarget];
const exactSchedule = official(target);
tree = render(() => calendar.DashboardPlanner({ ...props, interviewSchedules: [exactSchedule] }), []);
agenda = agendaOf(tree);
check(eventRows(agenda).length === 1 && text(agenda).includes('10:30'), 'same-target exact public date and personal appointment merge into one row with its actual time');
check(nodes(agenda).some(node => node.type === 'a' && node.props.href === exactSchedule.sourceUrl), 'merged interview retains its official source link');
check(!text(tree).includes('내 면접') && !text(tree).includes('학교 면접'), 'interview presentation no longer divides personal and school interviews');

// Existing cached payloads must not revive the reference publisher or an outbound link.
const referenceUrl = 'https://www.acon.io.kr/susi/calendar';
const legacySource = official(target, { sourceUrl: referenceUrl, sourceLabel: '아컨', note: `아컨 ${referenceUrl} ${today} 입학처 확인` });
const legacyCoverage = { source: { url: referenceUrl, title: '아컨 2027학년도 일정', admissionYear: 2027, checkedAt: `${today}T00:00:00+09:00` }, registeredSchools: 88, matchedSchools: 88, availableSchools: 80, totalInterviewEntries: 1, stale: true, lastRefreshFailed: false, targets: [] };
tree = render(() => calendar.DashboardPlanner({ ...props, interviewSchedules: [legacySource], interviewScheduleCoverage: legacyCoverage }), []);
check(eventRows(agendaOf(tree)).length === 1 && text(agendaOf(tree)).includes('10:30'), 'cached reference attribution removal preserves the personal interview and allocated time');
check(!/아컨|acon\.io\.kr/i.test(text(tree)), 'student calendar removes reference publisher metadata from cached notes and status text');
check(!nodes(tree).some(node => typeof node.props?.href === 'string' && calendarSourcePresentation.isReferenceCalendarUrl(node.props.href)), 'student calendar never renders a reference publisher link, including stale-source fallback');
check(!nodes(tree).some(node => node.type === 'a' && !node.props.href), 'removing source links does not leave an empty anchor');
check(text(tree).includes('확인') && text(tree).includes('입학처'), 'verification and admissions guidance remain visible when publisher attribution is removed');

// An allocated date narrows an applicable range without losing the public evidence.
const rangeStart = planner.shiftPlanDay(today, -1), rangeEnd = planner.shiftPlanDay(today, 1);
app.data.targets = [{ ...timedTarget, schedule: { ...timedTarget.schedule, period_start: rangeStart, period_end: rangeEnd } }];
tree = render(() => calendar.DashboardPlanner({ ...props, interviewSchedules: [official(target, { startDate: rangeStart, endDate: rangeEnd })] }), []);
agenda = agendaOf(tree);
check(eventRows(agenda).length === 1 && text(agenda).includes('10:30'), 'personal appointment within an exact applicable range becomes one dated interview');
check(calendarDay(tree, today)?.props['aria-label'].includes('일정 1개') && !calendarDay(tree, rangeStart)?.props['aria-label'].includes('일정 1개') && !calendarDay(tree, rangeEnd)?.props['aria-label'].includes('일정 1개'), 'matched public range does not paint extra appointment days once a personal date is known');
check(text(agenda).includes(schedule.scheduleDateLabel(rangeStart)) && text(agenda).includes(schedule.scheduleDateLabel(rangeEnd)), 'merged range interview preserves the original school period as context');

tree = render(() => calendar.DashboardPlanner({ ...props, interviewSchedules: [official(target, { startDate: rangeStart, endDate: rangeEnd, format: 'video_submission' })] }), []);
check(calendarDay(tree, rangeEnd)?.props['aria-label'].includes('일정 1개') && text(tree).includes('동영상 면접 제출'), 'video submission period remains a period instead of borrowing an unrelated personal appointment');

// Equal dates do not make different applications interchangeable.
const alternate = { ...target, id: 'uos-alternate', admission_type: '학생부종합Ⅱ' };
app.data.targets = [target, other, alternate];
tree = render(() => calendar.DashboardPlanner({ ...props, interviewSchedules: [official(target), official(other), official(alternate)] }), []);
agenda = agendaOf(tree);
check(eventRows(agenda).length === 3 && eventSchoolLinks(agenda).length === 3, 'same-day interviews at different schools or in different tracks remain separate events');
check(eventSchoolLinks(agenda).includes(`/schools/${alternate.id}`) && text(agenda).includes(alternate.admission_type), 'same-school alternate track retains its own registered target and label');

const upcomingTargets = Array.from({ length: 4 }, (_, index) => ({ ...target, id: `upcoming-${index}`, university: `검증대학교 ${index + 1}` }));
app.data.targets = upcomingTargets;
tree = render(() => calendar.DashboardPlanner({ ...props, interviewSchedules: upcomingTargets.map(item => official(item, { startDate: rangeEnd, endDate: rangeEnd })) }), []);
check(eventRows(classNodes(tree, 'calendar-upcoming')[0]).length === 4 && !text(tree).includes('개 더 보기'), 'all upcoming registered-school interviews remain visible beyond the previous three-event cutoff');

// Undated decisions stay visible for the whole application calendar.
const coverage = { source: { url: 'https://admissions.example.test/calendar', title: 'Synthetic calendar fixture', admissionYear: 2027, checkedAt: `${today}T00:00:00+09:00` }, registeredSchools: 88, matchedSchools: 88, availableSchools: 80, totalInterviewEntries: 1,
  targets: [{ targetId: target.id, university: target.university, status: 'date_pending', entryCount: 0, unresolvedCount: 0, officialSources: [{ url: 'https://admissions.example.test/pending', title: 'Pending fixture' }] }, { targetId: other.id, university: other.university, status: 'no_interview', entryCount: 0, unresolvedCount: 0, officialSources: [{ url: 'https://admissions.example.test/no-interview', title: 'No-interview fixture' }] }] };
app.data.targets = [target, other].map(item => ({ ...item, schedule: { period_start: today, period_end: today } }));
tree = render(() => calendar.DashboardPlanner({ ...props, interviewScheduleCoverage: coverage }), []);
const statuses = nodes(tree).find(node => node.props?.['aria-label'] === '지원 전형의 면접 상태');
check(text(statuses).includes(target.university) && text(statuses).includes('날짜 미정') && text(statuses).includes(other.university) && text(statuses).includes('면접 미실시'), 'pending and no-interview statuses for all registered schools appear together with distinct meanings');
check(eventRows(tree).length === 0, 'official non-dated decisions never revive a stale legacy school period as a fictional interview');
app.targetId = other.id;
tree = render(() => calendar.DashboardPlanner({ ...props, interviewScheduleCoverage: coverage }), []);
check(text(tree).includes(target.university) && text(tree).includes('날짜 미정') && text(tree).includes(other.university) && text(tree).includes('면접 미실시'), 'changing the selected school preserves every registered school calendar status');
// Date-cell labels must carry the useful information without requiring a click.
const chips = day => classNodes(day, 'calendar-interview-item');
const fixedDay = '2026-11-02';
function calendarAt(targets, schedules = [], day = fixedDay) {
  app.data.targets = targets;
  return render(() => calendar.DashboardPlanner({ ...props, interviewSchedules: schedules }), [day.slice(0, 7), day, false, null, '', false]);
}
const timed = { ...target, school_reference_id: 'school:uos', school_logo_url: '/school-logos/uos.svg', schedule: { personal_date: fixedDay, personal_at: `${fixedDay}T10:30:00+09:00` } };
const untimed = { ...other, school_reference_id: 'school:other', schedule: { personal_date: fixedDay } };
tree = calendarAt([timed, untimed]);
let dayCell = calendarDay(tree, fixedDay), dayChips = chips(dayCell);
check(dayChips.length === 2 && text(dayCell).includes(target.university) && text(dayCell).includes(other.university), 'date cell shows the full names of every registered school on that day');
check(text(dayChips[0]).includes('10:30') && text(dayChips[1]).includes('시간 미정') && !text(dayChips[1]).includes('00:00'), 'date cell distinguishes a confirmed clock time from an unknown time');
check(dayCell.props['aria-label'].includes(`${target.university} 10:30`) && dayCell.props['aria-label'].includes(`${other.university} 시간 미정`), 'date selection accessible name announces schools and times');
check(nodes(dayCell).filter(node => node.type === 'button').length === 1 && !nodes(dayCell).some(node => node.type === 'a'), 'date cell labels introduce no nested interactive controls');
check(dayCell.props['aria-controls'] === 'planner-selected-day' && nodes(tree).some(node => node.props?.id === dayCell.props['aria-controls']), 'date selection is linked to its detailed agenda');
check(nodes(dayChips[0]).some(node => node.type === 'SchoolLogo' && node.props.school.school_logo_url === timed.school_logo_url), 'date cell reuses the registered school logo');
const initialColors = Object.fromEntries(dayChips.map(chip => [chip.props['data-school'], chip.props.style]));
check(initialColors['school:uos']['--calendar-school-bg'] !== initialColors['school:other']['--calendar-school-bg'], 'different registered schools use different date-cell backgrounds');
app.targetId = untimed.id;
tree = calendarAt([untimed, timed]);
check(chips(calendarDay(tree, fixedDay)).every(chip => JSON.stringify(chip.props.style) === JSON.stringify(initialColors[chip.props['data-school']])), 'school colors are unchanged when target selection or target order changes');
const legends = nodes(tree).find(node => node.props?.['aria-label'] === '학교별 일정 색상');
check(text(legends).includes(target.university) && text(legends).includes(other.university) && nodes(legends).filter(node => node.type === 'SchoolLogo').length === 2, 'school color key labels every registered school with its logo');

const midnight = { ...timed, schedule: { personal_at: `${fixedDay}T00:00:00+09:00` } };
tree = calendarAt([midnight]);
check(text(chips(calendarDay(tree, fixedDay))[0]).includes('00:00'), 'a real midnight appointment is displayed as 00:00');
const utcBoundary = { ...timed, schedule: { personal_at: '2026-11-01T23:30:00Z' } };
tree = calendarAt([utcBoundary]);
check(text(calendarDay(tree, fixedDay)).includes('08:30') && !chips(calendarDay(tree, '2026-11-01')).length, 'absolute UTC timestamp appears in the correct Korean date cell and clock time');

const periodStart = '2026-11-01', periodEnd = '2026-11-03';
tree = calendarAt([target], [official(target, { startDate: periodStart, endDate: periodEnd })]);
check([periodStart, fixedDay, periodEnd].every(day => text(calendarDay(tree, day)).includes(target.university) && text(calendarDay(tree, day)).includes('시간 미정') && text(calendarDay(tree, day)).includes('면접 기간')), 'public multi-day interview remains a visibly identified period on every applicable date');
tree = calendarAt([timed], [official(timed, { startDate: periodStart, endDate: periodEnd, format: 'video_submission' })]);
check([periodStart, fixedDay, periodEnd].every(day => chips(calendarDay(tree, day)).some(chip => text(chip).includes('제출기간'))), 'video submission is labelled as a submission period throughout the date range');
check(chips(calendarDay(tree, fixedDay)).some(chip => text(chip).includes('제출기간') && !text(chip).includes('10:30')), 'video submission chip does not inherit a separate allocated interview time');

tree = calendarAt([timed], [official(timed, { startDate: fixedDay, endDate: fixedDay, applicability: 'school_reference' })]);
dayCell = calendarDay(tree, fixedDay); dayChips = chips(dayCell);
const referenceChip = dayChips.find(chip => text(chip).includes('참고 일정'));
check(Boolean(referenceChip) && text(referenceChip).includes('시간 미정'), 'unmatched school reference schedule has a visible reference qualifier inside its date chip');
check(referenceChip?.props.title.includes('지원 전형 확인 필요') && dayCell.props['aria-label'].includes('지원 전형 확인 필요'), 'school reference warning is exposed through both the chip title and date accessible name');
check(dayChips.length === 2 && dayChips.some(chip => text(chip).includes('10:30') && !text(chip).includes('참고 일정')), 'an unmatched reference date stays separate from the confirmed personal appointment');
tree = calendarAt([timed], [official(timed, { startDate: fixedDay, endDate: fixedDay })]);
dayCell = calendarDay(tree, fixedDay);
check(chips(dayCell).length === 1 && !text(dayCell).includes('참고 일정') && !dayCell.props['aria-label'].includes('지원 전형 확인 필요'), 'a verified matching track is not mislabeled as an unverified school reference');

const alternateTimed = { ...timed, id: 'uos-alternate', admission_type: '학생부종합Ⅱ', schedule: { personal_at: `${fixedDay}T14:00:00+09:00` } };
tree = calendarAt([timed, untimed, alternateTimed]);
dayCell = calendarDay(tree, fixedDay); dayChips = chips(dayCell);
check(dayChips.length === 3 && dayCell.props['aria-label'].includes('면접 3개'), 'three same-day appointments all appear inside the date cell');
const sameSchool = dayChips.filter(chip => chip.props['data-school'] === 'school:uos');
check(sameSchool.length === 2 && JSON.stringify(sameSchool[0].props.style) === JSON.stringify(sameSchool[1].props.style), 'the same school uses one consistent color across different application tracks');
check(sameSchool.some(chip => text(chip).includes(timed.admission_type) && text(chip).includes('10:30')) && sameSchool.some(chip => text(chip).includes(alternateTimed.admission_type) && text(chip).includes('14:00')), 'same-school appointments retain their own track and time labels');

const orderLate = { ...target, id: 'order-late', school_reference_id: 'school:order-late', university: '늦은대학교', schedule: { personal_at: `${fixedDay}T11:30:00+09:00` } };
const orderUnknown = { ...other, id: 'order-unknown', school_reference_id: 'school:order-unknown', university: '미정대학교', schedule: { personal_date: fixedDay } };
const orderEarly = { ...target, id: 'order-early', school_reference_id: 'school:order-early', university: '이른대학교', schedule: { personal_at: `${fixedDay}T10:00:00+09:00` } };
tree = calendarAt([orderLate, orderUnknown, orderEarly]);
check(JSON.stringify(chips(calendarDay(tree, fixedDay)).map(chip => text(classNodes(chip, 'calendar-chip-time')[0]).trim())) === JSON.stringify(['10:00', '11:30', '시간 미정']), 'same-day date chips display known times chronologically with unknown times last regardless of registration order');
const futureOrderDay = planner.shiftPlanDay(today, 2);
const orderedFutureTargets = [orderLate, orderUnknown, orderEarly].map(item => ({ ...item, schedule: item.schedule.personal_at ? { personal_at: item.schedule.personal_at.replace(fixedDay, futureOrderDay) } : { personal_date: futureOrderDay } }));
tree = calendarAt(orderedFutureTargets, [], today);
const upcomingOrderRows = eventRows(classNodes(tree, 'calendar-upcoming')[0]);
const upcomingOrderLinks = upcomingOrderRows.map(row => nodes(row).find(node => node.type === 'a' && /^\/schools\//.test(node.props.href))?.props.href);
check(JSON.stringify(upcomingOrderLinks) === JSON.stringify([orderEarly, orderLate, orderUnknown].map(item => `/schools/${item.id}`)), 'upcoming interviews on one date show earlier appointments first and unknown times last');
// The integrated calendar cannot self-check or rewrite an automatic training task.
const automaticPlan={id:'training-plan',date:today,title:'활동 설명 훈련',revision:1,completed:false,targetAvailable:true,href:'/my',target:{targetId:target.id,automaticPractice:{minutes:25,hybrid:{kind:'focus'}}}};
const manualPlan={id:'manual-plan',date:today,title:'내 준비물 확인',revision:1,completed:false,targetAvailable:true};
tree=render(()=>calendar.DashboardPlanner({...props,hybrid:true,plans:[automaticPlan,manualPlan]}),[]);
const trainingRow=eventRows(agendaOf(tree)).find(row=>text(row).includes(automaticPlan.title));
const manualRow=eventRows(agendaOf(tree)).find(row=>text(row).includes(manualPlan.title));
check(!nodes(tree).some(node=>node.type==='AutomaticPracticePlan'),'integrated calendar does not show the legacy time planner');
check(!classNodes(trainingRow,'plan-check').length&&!classNodes(trainingRow,'plan-edit').length,'automatic training cannot be marked complete or rewritten in the calendar');
check(text(trainingRow).includes('예정')&&!text(trainingRow).includes('직접 체크')&&!text(trainingRow).includes('완료한 답변으로 반영돼요'),'automatic task has concise real pending state without repeated guidance');
check(classNodes(manualRow,'plan-check').length===1&&classNodes(manualRow,'plan-edit').length===1,'personal plan completion and editing remain available');
// A busy training day has a compact month summary; its full agenda remains available on selection.
const busyPlans=Array.from({length:8},(_,index)=>({...automaticPlan,id:'busy-'+index,title:'세부 훈련 '+index,completed:index<2,target:{...automaticPlan.target,automaticPractice:{minutes:15,hybrid:{kind:index===7?'break':'focus'}}}}));
tree=render(()=>calendar.DashboardPlanner({...props,hybrid:true,plans:busyPlans,interviewSchedules:[official(target),official(other)]}),[]);
const busyDay=calendarDay(tree,today),summaryCell=classNodes(busyDay,'calendar-day-summary')[0];
check(text(summaryCell).replace(/\s/g,'').includes('105분')&&text(summaryCell).replace(/\s/g,'').includes('2/7완료'),'month summary totals planned minutes while submitted progress excludes a break');
check(classNodes(busyDay,'calendar-task-item').length===0&&classNodes(busyDay,'calendar-interview-item').length===1,'month cell never stacks all training tasks and shows at most one interview chip');
check(classNodes(busyDay,'calendar-more-events').some(node=>text(node).replace(/\s/g,'').includes('면접+1')),'additional same-day interviews remain discoverable');
check(busyPlans.filter(plan=>plan.target.automaticPractice.hybrid.kind!=='break').every(plan=>eventRows(agendaOf(tree)).some(row=>text(row).includes(plan.title))),'all individual learning tasks remain in the selected-day agenda');
const weeklyOutline=classNodes(tree,'hybrid-week-plan')[0],weeklyText=text(weeklyOutline).replace(/\s/g,'');
check(weeklyText.includes('집중보완')&&weeklyText.includes('7회·105분'),'weekly outline groups learning into category, count and minutes');
check(!weeklyText.includes('세부훈련')&&!weeklyText.includes('휴식'),'weekly outline omits full question prompts and all break entries');
check(busyDay.props['aria-label'].includes('계획 105분')&&busyDay.props['aria-label'].includes('훈련 2/7 완료')&&busyDay.props['aria-label'].includes('면접 2개')&&!busyDay.props['aria-label'].includes('세부 훈련'),'hybrid date accessible label summarizes time, submitted progress and interview count rather than every prompt');
const breakRow=eventRows(agendaOf(tree)).find(row=>text(row).includes('세부 훈련 7'));
check(!breakRow,'legacy automatic break entries never appear in the calendar agenda');
const longTitle='긴 탐구 질문과 근거를 연결해 설명해 주세요. '.repeat(8),future=planner.shiftPlanDay(today,1);
const statePlans=[{...automaticPlan,id:'progress',target:{...automaticPlan.target,automaticPractice:{...automaticPlan.target.automaticPractice,startedAt:today+'T09:00:00+09:00'}}},{...automaticPlan,id:'completed',performedAt:today+'T09:00:00+09:00'},{...automaticPlan,id:'long',title:longTitle,date:future}];
tree=render(()=>calendar.DashboardPlanner({...props,hybrid:true,plans:statePlans}),[]);
check(eventRows(agendaOf(tree)).some(row=>text(row).includes('진행 중'))&&eventRows(agendaOf(tree)).some(row=>classNodes(row,'plan-training-meta').some(meta=>text(meta).includes('완료'))),'started current-day work and submitted work retain distinct real states');
tree=render(()=>calendar.DashboardPlanner({...props,hybrid:true,plans:statePlans}),[future.slice(0,7),future,false,null,'',false]);
const longRow=eventRows(agendaOf(tree)).find(row=>text(row).includes(longTitle));
check(classNodes(longRow,'calendar-plan-question').length===1&&text(longRow).includes('예정')&&!text(longRow).includes('오늘 훈련'),'long future title remains fully available in a disclosure without today-only wording');
// Date clicks reveal the existing detailed agenda on mobile, without moving the calendar during load or month browsing.
browser.mobile=true;
tree=calendarAt([timed]);
const scrollCalls=[],selectedDetail=nodes(tree).find(node=>node.props?.id==='planner-selected-day');
selectedDetail.props.ref.current={style:{},scrollIntoView:options=>scrollCalls.push(options)};
check(browser.frames.size===0,'initial calendar render never auto-scrolls');
nodes(tree).find(node=>node.props?.['aria-label']==='다음 달').props.onClick();
check(browser.frames.size===0,'browsing another month never auto-scrolls');
calendarDay(tree,fixedDay).props.onClick();
for(const callback of browser.frames.values())callback();browser.frames.clear();
check(scrollCalls.length===1&&scrollCalls[0].behavior==='smooth'&&scrollCalls[0].block==='start','explicit mobile date click smoothly reveals the existing detailed agenda, even for the current day');
check(selectedDetail.props.ref.current.style.scrollMarginTop==='0px','root scroll padding already clears the header without doubling the agenda offset');
browser.reducedMotion=true;
browser.scrollPadding=0;
calendarDay(tree,fixedDay).props.onClick();
for(const callback of browser.frames.values())callback();browser.frames.clear();
check(scrollCalls[1].behavior==='auto','date selection respects reduced motion');
check(selectedDetail.props.ref.current.style.scrollMarginTop==='80px','without document scroll padding the agenda adds the fixed header offset itself');
browser.mobile=false;
calendarDay(tree,fixedDay).props.onClick();
check(browser.frames.size===0&&scrollCalls.length===2,'desktop date selection retains the existing side-by-side calendar position');
console.log(`${checks} school/interview/calendar component checks passed`);
