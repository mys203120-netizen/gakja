import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual component and its handlers without a browser, server or DB.
// Hook slots, dependency changes and cleanups run as a unit so an item-change effect
// cannot silently erase the feedback between the submit handler and the assertion.
const transpile = path => ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const load = (path, require = () => ({})) => {
  const module = { exports: {} };
  vm.runInNewContext(transpile(path), { module, exports: module.exports, require, Set });
  return module.exports;
};
const view = load('../apps/web/src/lib/quiz-session-view.ts');
const contracts = load('../packages/content-contracts/src/workflows.ts');
const componentSource = transpile('../apps/web/src/components/quiz-v3.tsx');
const copy = value => structuredClone(value);
const items = [0, 1].map(index => ({
  id: `choice-${index}`, question_id: `question-${index}`, practice_kind: 'concept',
  prompt: `합성 개념 질문 ${index + 1}`, kind: 'choice', activity_ids: [], source_ref_ids: [],
  options: [1, 2, 3, 4].map(n => ({ id: `option-${index}-${n}`, text: `합성 보기 ${index + 1}-${n}` })),
}));
const fixture = ({ total = 2, timed = false } = {}) => ({
  serverTime: new Date().toISOString(),
  session: { id: 'choice-session', student_id: 'synthetic-student', state: 'ready', mode: 'choice',
    current_index: 0, content_version: 1, items: copy(items.slice(0, total)), timed,
    deadline_at: null, metadata: { timed, drafts: {} } },
  responses: [], recordings: [], learning: { questions: [], memory_items: [], support_targets: [] },
});
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object'
  ? [tree, ...nodes(tree.props?.children), ...nodes(tree.props?.aside)] : [];
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object'
  ? text(value.props?.children) : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const depsEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness(initial = fixture(), storage = new Map()) {
  const state = { server: copy(initial), tree: null, dirty: true, slots: [], hook: 0, pendingEffects: [],
    timers: new Map(), timerId: 0, now: 0, calls: [], toasts: [], listeners: new Map(),
    storage, local: new Map(), modal: null, postAdapter: null, getAdapter: null, unmounted: false };
  class FakeElement {
    constructor(kind = 'body') { this.kind = kind; }
    closest(selector) {
      const editable = ['input', 'textarea', 'select', 'editable', 'textbox', 'combobox'].includes(this.kind);
      if (editable && /input|contenteditable|textbox|combobox/.test(selector)) return this;
      return null;
    }
    getBoundingClientRect() { return { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 }; }
    focus() { document.activeElement = this; }
  }
  const addListener = (name, listener) => {
    if (!state.listeners.has(name)) state.listeners.set(name, new Set());
    state.listeners.get(name).add(listener);
  };
  const removeListener = (name, listener) => state.listeners.get(name)?.delete(listener);
  const document = { activeElement: new FakeElement(), visibilityState: 'visible',
    querySelector: () => state.modal, addEventListener: addListener, removeEventListener: removeListener };
  const storageAPI = map => ({ getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) });
  const responseDTO = () => ({ ...copy(state.server), serverTime: new Date().toISOString() });
  const normalPost = async (_url, payload) => {
    const session = state.server.session;
    if (payload.action === 'start') {
      assert.equal(payload.itemIndex, session.current_index, 'next starts the server current item, not the reviewed item');
      assert.ok(!['completed', 'ended'].includes(session.state), 'a completed quiz must never receive start');
      session.state = 'active';
      session.deadline_at = session.timed ? new Date(Date.now() + 10_000).toISOString() : null;
      return responseDTO();
    }
    if (payload.action === 'pause') {
      assert.equal(payload.itemIndex, session.current_index, 'pause must not use the already submitted item index');
      if (session.state === 'active') session.state = 'paused';
      session.deadline_at = null;
      return responseDTO();
    }
    if (payload.action === 'answer') {
      if (payload.itemIndex < session.current_index) {
        const saved = state.server.responses.find(row => row.item_index === payload.itemIndex);
        assert.equal(saved?.selected_option_id, payload.selectedOptionId);
        return { ...responseDTO(), response: copy(saved) };
      }
      assert.equal(session.state, 'active');
      assert.equal(payload.itemIndex, session.current_index);
      const item = session.items[session.current_index];
      const saved = { id: `response-${session.current_index}`, item_index: session.current_index,
        memory_item_id: item.id, selected_option_id: payload.selectedOptionId, response: '',
        outcome: payload.selectedOptionId === item.options[1].id, timed_out: false, rating: 'good',
        data: { requestId: payload.requestId, prompt: item.prompt, correct_answer: item.options[1].text, assistance_recorded: true } };
      state.server.responses.push(saved);
      session.current_index++;
      session.state = session.current_index === session.items.length ? 'completed' : 'ready';
      session.deadline_at = null;
      return { ...responseDTO(), response: copy(saved) };
    }
    throw new Error(`Unexpected action ${payload.action}`);
  };
  const post = async (url, payload) => {
    state.calls.push({ method: 'POST', url, payload: copy(payload) });
    return state.postAdapter ? state.postAdapter(url, payload, normalPost) : normalPost(url, payload);
  };
  const api = async url => {
    state.calls.push({ method: 'GET', url });
    return state.getAdapter ? state.getAdapter(url, responseDTO) : responseDTO();
  };
  const app = { data: { user: { id: 'synthetic-student' }, targets: [] }, refresh: async () => {},
    toast: message => state.toasts.push(message), openResource() {} };
  const router = { push: path => state.calls.push({ navigate: path }) };
  const actionButton = ({ pending = false, pendingLabel, disabled, children, type = 'button', ...props }) => ({ type: 'button',
    props: { ...props, type, disabled: disabled || pending, 'aria-busy': pending || undefined, children: pending ? pendingLabel ?? children : children } });
  const react = {
    useState(initialValue) {
      const index = state.hook++;
      if (!(index in state.slots)) {
        const slot = { value: typeof initialValue === 'function' ? initialValue() : initialValue };
        slot.set = value => { const next = typeof value === 'function' ? value(slot.value) : value; if (!Object.is(next, slot.value)) { slot.value = next; state.dirty = true; } };
        state.slots[index] = slot;
      }
      return [state.slots[index].value, state.slots[index].set];
    },
    useRef(initialValue) { const index = state.hook++; return state.slots[index] ??= { current: initialValue }; },
    useCallback(callback, deps) {
      const index = state.hook++, previous = state.slots[index];
      if (!previous || !depsEqual(previous.deps, deps)) state.slots[index] = { callback, deps };
      return state.slots[index].callback;
    },
    useEffect(callback, deps) {
      const index = state.hook++, previous = state.slots[index];
      if (!previous || !depsEqual(previous.deps, deps)) {
        state.slots[index] = { deps, cleanup: previous?.cleanup };
        state.pendingEffects.push(() => { state.slots[index].cleanup?.(); state.slots[index].cleanup = callback(); });
      }
    },
  };
  const timer = (callback, ms, repeat) => { const id = ++state.timerId; state.timers.set(id, { callback, ms, at: state.now + ms, repeat }); return id; };
  let uuid = 0;
  const module = { exports: {} };
  vm.runInNewContext(componentSource, { module, exports: module.exports, console, Date, Set, JSON, Blob, FormData, URL, URLSearchParams, AbortController,
    requestAnimationFrame:callback=>{callback();return 1;},cancelAnimationFrame(){},Element: FakeElement, HTMLElement: FakeElement, document, performance: { now: () => state.now },
    crypto: { randomUUID: () => `choice-request-${++uuid}` },
    setTimeout: (callback, ms) => timer(callback, ms, false), clearTimeout: id => state.timers.delete(id),
    setInterval: (callback, ms) => timer(callback, ms, true), clearInterval: id => state.timers.delete(id),
    localStorage: storageAPI(state.local), sessionStorage: storageAPI(state.storage),
    window: { addEventListener: addListener, removeEventListener: removeListener },
    navigator: { sendBeacon(url, payload) { state.calls.push({ method: 'BEACON', url, payload }); return true; } },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => type === actionButton ? actionButton(props) : ({ type, props }), jsxs: (type, props) => type === actionButton ? actionButton(props) : ({ type, props }), Fragment: 'Fragment' };
      if (name === 'next/link') return { __esModule: true, default: 'Link' };
      if (name === 'next/navigation') return { useRouter: () => router, useSearchParams: () => new URLSearchParams() };
      if (name === 'lucide-react') return new Proxy({}, { get: (_, key) => String(key) });
      if (name === './app-shell') return { useApp: () => app };
      if (name === './shared') return { ActionButton: actionButton, api, post, PageTitle: 'PageTitle', Breadcrumb: 'Breadcrumb', Alert: 'Alert', Empty: 'Empty', Spinner: 'Spinner' };
      if (name === './practice-writing-help') return {PracticeWritingHelp:'PracticeWritingHelp'};
      if (name === '@/lib/client/recording-recovery') return {readRecordingRecovery:async()=>null,installRecordingExitGuard:()=>()=>{}};
      if (name === './learning-help') return { LearningHelp: 'LearningHelp' };
      if (name === './audio-level-dot') return { AudioLevelDot: 'AudioLevelDot' };
      if (name === './playful-flow') return { animateStudyReceipt() {} };
      if (name === '@/lib/client/speech-recorder') return { startSpeechCapture() { throw new Error('No microphone in choice tests'); } };
      if (name === '@/lib/recording-upload-client') return { uploadRecording() { throw new Error('No media upload in choice tests'); } };
      if (name === '@gakja/content-contracts/workflows') return contracts;
      if (name === '@/lib/quiz-session-view') return view;
      if (name === './quiz-session-ui.module.css') return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
      throw new Error(`Unexpected component import ${name}`);
    },
  });
  function render() {
    state.hook = 0;
    state.dirty = false;
    state.tree = module.exports.QuizSession({ id: 'choice-session' });
    for (const effect of state.pendingEffects.splice(0)) effect();
  }
  async function settle() {
    for (let turn = 0; turn < 24; turn++) {
      if (state.dirty) render();
      await new Promise(resolve => setImmediate(resolve));
      if (!state.dirty) { await Promise.resolve(); if (!state.dirty) return; }
    }
    throw new Error('Component did not settle; check effect dependency stability');
  }
  async function advance(ms) {
    const end = state.now + ms;
    for (let count = 0; count < 3000; count++) {
      const due = [...state.timers.entries()].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) { state.now = end; await settle(); return; }
      const [id, value] = due; state.now = value.at;
      if (value.repeat) value.at += value.ms; else state.timers.delete(id);
      await value.callback(); await settle();
    }
    throw new Error('Too many timer callbacks');
  }
  const button = label => nodes(state.tree).find(node => node.type === 'button' && (typeof label === 'string' ? text(node) === label : label.test(text(node))));
  async function click(label) {
    const selected = button(label);
    assert.ok(selected, `Visible button: ${label}; rendered ${text(state.tree)}`);
    assert.ok(!selected.props.disabled, `Enabled button: ${label}`);
    await selected.props.onClick(); await settle();
  }
  function dispatch(name, event = {}) { for (const listener of [...state.listeners.get(name) || []]) listener(event); }
  function key(extra = {}) {
    const event = { key: '1', target: new FakeElement(), defaultPrevented: false, repeat: false, isComposing: false,
      ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      preventDefault() { this.defaultPrevented = true; }, composedPath() { return [this.target]; }, ...extra };
    dispatch('keydown', event);
    return event;
  }
  async function begin() {
    await settle();
    await click(/^(퀴즈 시작|이어서 풀기)$/);
    await advance(1400);
    assert.equal(state.server.session.state, 'active');
  }
  return { state, document, FakeElement, settle, advance, button, click, key, begin, dispatch,
    review: () => nodes(state.tree).find(node => node.props?.['aria-label'] === '선택형 답변 확인'),
    calls: action => state.calls.filter(call => call.payload?.action === action),
    async unmount() { state.unmounted = true; for (const slot of state.slots) slot?.cleanup?.(); await Promise.resolve(); },
  };
}

export async function runQuizChoiceInteractionChecks() {
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks++; };
  const reviewFixture = ({ last = false } = {}) => {
    const value = fixture({ total: last ? 1 : 2 });
    value.session.current_index = 1;
    value.session.state = last ? 'completed' : 'ready';
    value.responses = [{ id: 'saved-review-0', item_index: 0, memory_item_id: items[0].id, selected_option_id: items[0].options[0].id,
      response: '', outcome: false, rating: 'again', timed_out: false,
      data: { requestId: 'saved-request', prompt: items[0].prompt, correct_answer: items[0].options[1].text, assistance_recorded: true } }];
    return value;
  };

  {
    const h = harness(); await h.begin();
    await h.click(/합성 보기 1-1/);
    check(!!h.review(), 'untimed answer remains in an explicit review section after item-change effects');
    check(text(h.review()).includes(items[0].prompt) && text(h.review()).includes(items[0].options[1].text), 'review shows the answered question and reviewed correct choice');
    check(h.calls('answer').length === 1 && h.state.server.session.current_index === 1, 'answer is saved once while the server moves to the next item');
    check(![...h.state.timers.values()].some(timer => timer.ms === 650), 'untimed answer does not schedule timed auto-next');
    const beforeStart = h.calls('start').length;
    await h.advance(30_000); h.key(); await h.settle();
    check(!!h.review() && h.calls('start').length === beforeStart && h.calls('answer').length === 1, 'elapsed time and number keys cannot dismiss review or submit another answer');
    h.document.visibilityState = 'hidden'; h.dispatch('visibilitychange'); h.dispatch('pagehide'); await h.settle();
    check(h.calls('pause').length === 0 && !h.state.calls.some(call => call.method === 'BEACON'), 'review does not pause an obsolete already answered item');
    h.document.visibilityState = 'visible';
    await h.click('다음 문제');
    check(!h.review() && h.state.server.session.state === 'active' && h.calls('start').at(-1).payload.itemIndex === 1, 'manual next starts exactly the current second item');
    await h.click(/합성 보기 2-2/);
    check(!!h.review() && text(h.review()).includes(items[1].prompt) && !!h.button('결과 보기'), 'last answer is reviewed before the completed results');
    const startCount = h.calls('start').length;
    await h.click('결과 보기');
    check(!h.review() && h.calls('start').length === startCount && text(h.state.tree).includes('2문항의 답을 남겼어요.'), 'results acknowledgement never starts past the last item');
    const reopened = harness(h.state.server, new Map(h.state.storage)); await reopened.settle();
    check(!reopened.review() && text(reopened.state.tree).includes('2문항의 답을 남겼어요.'), 'acknowledged completed results survive reload');
  }

  for (const last of [false, true]) {
    const h = harness(reviewFixture({ last })); await h.settle();
    check(!!h.review() && text(h.review()).includes(items[0].prompt), `${last ? 'last' : 'intermediate'} saved answer review restores on initial GET`);
    check(h.calls('answer').length === 0 && h.calls('start').length === 0, 'restoring review makes no answer or start write');
    check(!!h.button(last ? '결과 보기' : '다음 문제'), 'restored review has the correct explicit continuation');
  }

  for (const total of [1, 2]) {
    const h = harness(fixture({ total })); await h.begin();
    h.state.postAdapter = async (url, payload, normal) => { const result = await normal(url, payload); if (payload.action === 'answer') throw new Error('answer response lost'); return result; };
    await h.click(/합성 보기 1-2/);
    check(!!h.review() && text(h.review()).includes(items[0].prompt), 'committed answer recovered by request receipt still opens its review');
    check(h.calls('answer').length === 1 && h.state.server.responses.length === 1 && h.state.toasts.includes('저장된 답변을 다시 불러왔어요.'), 'ambiguous submission recovers without duplicate write');
    check(!!h.button(total === 1 ? '결과 보기' : '다음 문제'), 'recovered final and intermediate answers have the correct explicit continuation');
  }

  for (const committed of [false, true]) {
    const h = harness(reviewFixture()); await h.settle();
    h.state.postAdapter = async (url, payload, normal) => { if (committed) await normal(url, payload); throw new Error('next request interrupted'); };
    await h.click('다음 문제');
    check(!!h.review() && !!h.button('다음 문제'), `${committed ? 'committed but lost' : 'uncommitted'} next failure retains retryable review`);
    check(!h.state.storage.has('gakja-quiz:choice-session:reviewed'), 'failed next does not acknowledge unseen next-question transition');
    h.state.postAdapter = null; await h.click('다음 문제');
    check(!h.review() && h.state.server.session.state === 'active' && h.calls('start').every(call => call.payload.itemIndex === 1), 'retry idempotently starts the same next item');
    check(h.calls('answer').length === 0, 'next retry never resubmits the reviewed answer');
  }

  {
    const h = harness(); await h.settle();
    h.key(); await h.settle();
    check(h.calls('answer').length === 0, 'ready screen does not accept answer shortcuts');
    await h.click('퀴즈 시작'); h.key(); await h.settle();
    check(h.calls('answer').length === 0 && h.calls('start').length === 0, 'countdown does not submit an answer before start');
    await h.advance(1400);
    const pause = nodes(h.state.tree).find(node => node.type === 'button' && node.props?.['aria-label'] === '일시정지');
    assert.ok(pause); await pause.props.onClick(); await h.settle();
    h.key(); await h.settle();
    check(h.state.server.session.state === 'paused' && h.calls('answer').length === 0, 'paused screen does not accept answer shortcuts');
    await h.click('이어서 풀기'); await h.advance(1400);
    h.key({ key: '4' }); await h.settle();
    check(h.calls('answer').length === 1 && h.calls('answer')[0].payload.selectedOptionId === items[0].options[3].id, 'resume restores valid number shortcuts');
  }

  {
    const h = harness(); await h.begin();
    let failed = false;
    h.state.postAdapter = async (url, payload, normal) => { if (payload.action === 'answer' && !failed) { failed = true; throw new Error('offline before commit'); } return normal(url, payload); };
    h.state.getAdapter = () => { throw new Error('offline recovery read'); };
    await h.click(/합성 보기 1-2/);
    check(!h.review() && h.state.server.responses.length === 0, 'unconfirmed answer does not manufacture feedback or advance');
    h.state.getAdapter = null; await h.click(/합성 보기 1-2/);
    check(h.calls('answer')[0].payload.requestId === h.calls('answer')[1].payload.requestId, 'unchanged failed answer retry preserves request identity');
    check(!!h.review() && h.state.server.responses.length === 1, 'successful retry enters review once');
  }

  {
    const h = harness(); await h.begin();
    for (const flags of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }]) {
      const event = h.key(flags); await h.settle();
      check(h.calls('answer').length === 0, `number shortcut ignores ${Object.keys(flags)[0]}`);
      if (!flags.defaultPrevented) check(!event.defaultPrevented, 'ignored browser shortcut is not prevented');
    }
    for (const kind of ['input', 'textarea', 'select', 'editable', 'textbox', 'combobox']) {
      h.key({ target: new h.FakeElement(kind) }); await h.settle();
      check(h.calls('answer').length === 0, `typing into ${kind} does not answer the quiz`);
    }
    h.document.activeElement = new h.FakeElement('input'); h.key(); await h.settle();
    check(h.calls('answer').length === 0, 'active editable element protects retargeted keyboard events');
    h.document.activeElement = new h.FakeElement();
    h.key({ composedPath: () => [new h.FakeElement('editable'), new h.FakeElement()] }); await h.settle();
    check(h.calls('answer').length === 0, 'shadow composed path protects editable keyboard events');
    h.state.modal = new h.FakeElement('dialog'); h.key(); await h.settle();
    check(h.calls('answer').length === 0, 'an open modal blocks background quiz shortcuts');
    h.state.modal = null;
    h.key({ key: 'Enter' }); await h.settle();
    check(h.calls('answer').length === 0, 'Enter does not act as an implicit answer or next shortcut');
    const event = h.key(); await h.settle();
    check(event.defaultPrevented && h.calls('answer').length === 1 && h.calls('answer')[0].payload.selectedOptionId === items[0].options[0].id, 'plain number key still selects the expected option');
  }

  {
    const h = harness(); await h.begin(); const gate = deferred();
    h.state.postAdapter = async (url, payload, normal) => { await gate.promise; return normal(url, payload); };
    h.key(); h.key(); await h.settle();
    check(h.calls('answer').length === 1, 'in-flight submission blocks a second key before a React rerender');
    h.key({ key: '2' }); await h.settle();
    check(h.calls('answer').length === 1, 'busy render blocks further number keys');
    gate.resolve(); await h.settle();
    check(!!h.review(), 'one deferred answer resolves into one review');
  }

  {
    const h = harness(fixture({ timed: true })); await h.begin();
    await h.click(/합성 보기 1-2/);
    check(!h.review() && [...h.state.timers.values()].some(timer => timer.ms === 650), 'timed quiz keeps its existing short automatic transition');
    h.key({ key: '2' }); await h.settle();
    check(h.calls('answer').length === 1, 'feedback interval blocks another numeric answer');
    await h.advance(650);
    check(h.calls('start').at(-1).payload.itemIndex === 1 && h.state.server.session.state === 'active', 'timed quiz automatically starts the next item');
  }
  console.log(`Choice interaction: ${checks} rendered-handler checks passed; no browser, DB, provider or device calls.`);
}
