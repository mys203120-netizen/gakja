import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from 'typescript';

// Run the real AppShell hooks with deferred bootstrap responses. UI dependencies
// stay inert; this regression makes no browser, database or provider requests.
const code = ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/app-shell.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const fixture = marker => ({ user: { id: 'harin', name: '하린' }, marker, targets: [{ id: 'uos', university: '서울시립대학교' }], preferences: {}, notifications: [], learning: {}, interviews: [], documents: [] });
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
function all(value) { return Array.isArray(value) ? value.flatMap(all) : value && typeof value === 'object' ? [value, ...all(value.props?.children)] : []; }
function harness() {
  const slots = [], effects = [], queued = [], requests = [];
  let cursor = 0, disposed = false, disposedWrites = 0;
  const hooks = {
    createContext: () => ({ Provider: 'AppContextProvider' }), useContext: () => null,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { if (disposed) disposedWrites++; slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useCallback(callback, dependencies) {
      const index = cursor++, old = slots[index];
      if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) slots[index] = { callback, dependencies };
      return slots[index].callback;
    },
    useEffect(effect, dependencies) {
      const index = cursor++, old = effects[index];
      if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) queued.push(() => {
        old?.cleanup?.(); effects[index] = { effect, dependencies, cleanup: effect() };
      });
    },
  };
  const api = url => new Promise((resolve, reject) => { check(url === '/api/bootstrap', 'shell only requests bootstrap'); requests.push({ resolve, reject }); });
  const styles = { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
  const module = { exports: {} }, router = { replace() {}, push() {}, refresh() {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, setTimeout, clearTimeout, sessionStorage: { getItem: () => null }, require(name) {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (name === 'next/link') return { __esModule: true, default: 'Link' };
    if (name === 'next/navigation') return { usePathname: () => '/my', useRouter: () => router };
    if (name === 'gsap') return { __esModule: true, default: {} };
    if (name.endsWith('.module.css')) return styles;
    if (name === './shared') return { api, post: () => { throw new Error('Unexpected mutation'); }, Logo: 'Logo', Spinner: 'Spinner', Alert: 'Alert', Modal: 'Modal', Badge: 'Badge', targetName: () => '', targetMajor: () => '' };
    if (name === '@/lib/student-onboarding') return { studentOnboardingDestination: () => null };
    if (name === '@/lib/material-search') return { normalizeMaterialQuery: value => value.trim(), searchStudentMaterials: () => [] };
    if (name === '@/lib/app-navigation') return { STUDENT_NAVIGATION: [{ id: 'today', href: '/my', label: '오늘' }], studentSection: () => 'today' };
    return new Proxy({}, { get: (_, key) => String(key) });
  } });
  const render = () => { cursor = 0; queued.length = 0; const tree = module.exports.AppShell({ children: 'Student screen' }); while (queued.length) queued.shift()(); return tree; };
  const state = () => { const tree = render(), nodes = all(tree); return { provider: nodes.find(node => node.type === 'AppContextProvider')?.props.value, alert: nodes.find(node => node.type === 'Alert')?.props.children }; };
  return { requests, render, state, strictReplay() { effects.forEach(effect => effect?.cleanup?.()); effects.forEach(effect => { if (effect) effect.cleanup = effect.effect(); }); }, dispose() { effects.forEach(effect => effect?.cleanup?.()); disposed = true; }, get disposedWrites() { return disposedWrites; } };
}

// StrictMode setup -> cleanup -> setup starts two requests. Its abandoned first
// bootstrap may reject after the second one establishes the cache's identity.
{
  const h = harness(); h.render(); h.strictReplay();
  check(h.requests.length === 2, 'StrictMode replay makes both actual refresh calls');
  h.requests[1].resolve(fixture('strict latest')); await flush();
  h.requests[0].reject(new DOMException('계정 정보가 변경됐어요. 다시 불러와 주세요.', 'AbortError')); await flush();
  const state = h.state();
  check(!state.alert, 'an abandoned StrictMode bootstrap cannot block the successful screen');
  check(state.provider?.data.marker === 'strict latest', 'StrictMode keeps the latest successful student data');
  check(state.provider.learningRevision === 1, 'only the successful latest bootstrap advances learning revision'); h.dispose();
}

// Two explicit refreshes may settle in reverse order while the shell is mounted.
{
  const h = harness(); h.render(); h.requests[0].resolve(fixture('initial')); await flush();
  const refresh = h.state().provider.refresh;
  const older = refresh(), newer = refresh();
  h.requests[2].resolve(fixture('newest')); await newer;
  h.requests[1].reject(new Error('older request failed')); await older;
  const state = h.state();
  check(!state.alert && state.provider?.data.marker === 'newest', 'older failure cannot replace a newer success with a full-screen error');
  check(state.provider.learningRevision === 2, 'ignored stale failure does not change learning revision'); h.dispose();
}

// A newer failure must remain actionable; a late old success cannot dismiss it.
{
  const h = harness(); h.render(); h.requests[0].resolve(fixture('initial')); await flush();
  const refresh = h.state().provider.refresh;
  const older = refresh(), newer = refresh();
  h.requests[2].reject(new Error('latest request failed')); await newer;
  h.requests[1].resolve(fixture('stale success')); await older;
  const state = h.state();
  check(state.alert === 'latest request failed', 'late old success cannot hide the latest refresh failure');
  check(!state.provider, 'latest failure remains the visible retry screen'); h.dispose();
}

// Cleanup also invalidates a request that has no replacement mount.
{
  const h = harness(); h.render(); h.dispose(); h.requests[0].resolve(fixture('after unmount')); await flush();
  check(h.disposedWrites === 0, 'a bootstrap completing after unmount never updates shell state');
}
console.log(`AppShell refresh ordering: ${checks} checks passed; StrictMode replay, latest-success/older-failure, latest-failure/older-success and unmount guards exercised against actual component hooks; external calls: 0.`);
