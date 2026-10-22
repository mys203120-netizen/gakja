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
function harness({ storedSidebarPreference = null, storageUnavailable = false, selectionRemovalBlocked=false, draftGate=null, studyGate=null, authGate=null, authLogoutFails=false, draftFails=false, studyFails=false, initialData } = {}) {
  const slots = [], effects = [], queued = [], requests = [], storageWrites = [],logoutSteps=[],navigations=[],seededIdentities=[],handoffs=[];
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
  vm.runInNewContext(code, { module, exports: module.exports, console, setTimeout, clearTimeout,CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}}, window:{dispatchEvent(event){logoutSteps.push('handoff');handoffs.push(event);return true;},location:{replace(path){logoutSteps.push('navigate');navigations.push(path);}}}, sessionStorage: { getItem: () => null,removeItem(key){logoutSteps.push('selection_remove');check(key==='gakja-target:harin','logout removes only the current fixture selection');if(selectionRemovalBlocked)throw new DOMException('Browser storage blocked','SecurityError');} }, localStorage: { getItem() { if (storageUnavailable) throw new Error('Storage unavailable'); return storedSidebarPreference; }, setItem(key, value) { if (storageUnavailable) throw new Error('Storage unavailable'); storageWrites.push([key, value]); } }, require(name) {if(name==='./owned-class-name'||name==='@/components/owned-class-name')return {ownedClassName:(value)=>value};
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) };
    if (name === 'next/link') return { __esModule: true, default: 'Link' };
    if (name === 'next/navigation') return { usePathname: () => '/my', useRouter: () => router };
    if (name === 'gsap') return { __esModule: true, default: {} };
    if (name === './use-record-pages') return { useRecordPages: () => ({ items: [], page: { nextCursor: null, hasMore: false }, loading: false, error: '', reload: async () => {}, more: async () => {} }) };
    if (name.endsWith('.module.css')) return styles;
    if (name === './shared') return { api, seedClientRequestIdentity:id=>seededIdentities.push(id), post: async(url,input) => {check(url==='/api/auth'&&input.action==='logout','logout callback only sends the auth logout mutation');logoutSteps.push('auth_logout');if(authGate)await authGate;if(authLogoutFails)throw Error('auth offline');return {ok:true};}, Logo: 'Logo', Spinner: 'Spinner', Alert: 'Alert', Modal: 'Modal', Badge: 'Badge', FloatingNotice:'FloatingNotice', targetName: () => '', targetMajor: () => '' };
    if(name==='@/lib/client/draft-save')return {flushPendingDrafts:async user=>{check(user==='harin','logout flush uses the current fixture owner');logoutSteps.push('drafts');if(draftGate)await draftGate;if(draftFails)throw Error('draft failed');}};
    if(name==='./study-session-provider')return {StudySessionProvider:'StudySessionProvider',finishStudySession:async reason=>{check(reason==='logout','study time ends for logout');logoutSteps.push('study_finish');if(studyGate)await studyGate;if(studyFails)throw Error('study failed');}};
    if (name === '@/lib/student-onboarding') return { studentOnboardingDestination: () => null };
    if (name === '@/lib/material-search') return { normalizeMaterialQuery: value => value.trim(), searchStudentMaterials: () => [] };
    if (name === '@/lib/app-navigation') return { STUDENT_NAVIGATION: [{ id: 'today', href: '/my', label: '오늘' }], MOBILE_STUDENT_NAVIGATION: [{ id: 'today', href: '/my', label: '오늘' }], mobileStudentActive: (path, href) => path === href, studentSection: () => 'today' };
    return new Proxy({}, { get: (_, key) => String(key) });
  } });
  const render = () => { cursor = 0; queued.length = 0; const tree = module.exports.AppShell({ children: 'Student screen', initialData }); while (queued.length) queued.shift()(); return tree; };
  const state = () => { const tree = render(), nodes = all(tree), sidebarToggle = nodes.find(node => node.props?.['aria-controls'] === 'desktop-navigation'); return { provider: nodes.find(node => node.type === 'AppContextProvider')?.props.value, alert: nodes.find(node => node.type === 'Alert')?.props.children, sidebarCollapsed: tree.props['data-sidebar-collapsed'],inert:tree.props.inert,ariaBusy:tree.props['aria-busy'], sidebarToggle: sidebarToggle.props,notice:nodes.find(node=>node.type==='FloatingNotice'),accountMenus:nodes.filter(node=>node.type==='AccountMenu') };  };
  return { requests, render, state, storageWrites, logoutSteps,navigations,seededIdentities,handoffs, strictReplay() { effects.forEach(effect => effect?.cleanup?.()); effects.forEach(effect => { if (effect) effect.cleanup = effect.effect(); }); }, dispose() { effects.forEach(effect => effect?.cleanup?.()); disposed = true; }, get disposedWrites() { return disposedWrites; } };
}

// Server-authenticated data renders the real student screen immediately. It is
// an initial value only; explicit refreshes still own ordering and invalidation.
{
  const initialData={...fixture('server initial'),targets:[{id:'first'},{id:'saved'}],preferences:{selectedTargetId:'saved'}};
  const h=harness({initialData}),first=h.render();
  check(all(first).some(node=>node.type==='AppContextProvider'),'SSR bootstrap renders the provider on its very first render without a shell spinner');
  check(h.requests.length===0,'server bootstrap prevents the duplicate mount-time /api/bootstrap request');
  check(h.seededIdentities.join(',')==='harin','the verified server owner seeds only this client shell initializer');
  check(h.state().provider.data===initialData&&h.state().provider.targetId==='saved','initial content and selected support target are available together');
  check(h.state().provider.learningRevision===0,'an SSR seed is not recorded as an extra completed client refresh');
  h.strictReplay();
  check(h.requests.length===0,'StrictMode effect replay does not fetch bootstrap for a seeded shell');
  const refresh=h.state().provider.refresh,older=refresh(),newer=refresh();
  check(h.requests.length===2,'explicit refresh remains available after the SSR initializer');
  h.requests[1].resolve({...initialData,marker:'freshest server state'});await newer;
  h.requests[0].resolve({...initialData,marker:'stale refresh'});await older;
  check(h.state().provider.data.marker==='freshest server state','reverse refresh completion cannot overwrite seeded-shell data');
  check(h.state().provider.learningRevision===1,'only the latest explicit refresh advances a seeded shell revision');
  check(h.state().provider.targetId==='saved','successful refresh preserves a still-valid selected target');
  for(let pass=0;pass<5;pass++)h.state();
  check(h.requests.length===2&&h.seededIdentities.length===1,'ordinary rerenders neither loop bootstrap nor reseed cache ownership');h.dispose();
}
{
  const initialData={...fixture('server fallback'),preferences:{selectedTargetId:'removed'}};
  const h=harness({initialData});h.render();
  check(h.state().provider.targetId==='uos','an invalid stored target falls back to the first owned support target on the first render');
  const pending=h.state().provider.refresh;const flight=pending();h.dispose();h.requests[0].resolve(fixture('after seeded unmount'));await flight;
  check(h.disposedWrites===0,'a seeded shell also ignores refresh completion after unmount');
}

// Exercise the actual async student layout: authorization precedes bootstrap,
// and React keys force actor changes to create a new client shell/cache boundary.
{
  const layoutCode=ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/app/(student)/layout.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}},calls=[];let actor=null;
  vm.runInNewContext(layoutCode,{module,exports:module.exports,require(name){
    if(name==='@/components/owned-class-name')return {ownedClassName:value=>value};
    if(name==='react')return {Suspense:'Suspense'};
    if(name==='react/jsx-runtime')return {jsx:(type,props,key)=>({type,props,key})};
    if(name==='next/navigation')return {redirect:path=>{throw Object.assign(Error('redirect'),{path});}};
    if(name==='@/lib/auth')return {getUser:async()=>actor};
    if(name==='@/components/app-shell')return {AppShell:'AppShell'};
    if(name==='@/lib/data')return {bootstrap:async user=>{calls.push(user.id);return {...fixture(user.id),user};}};
    throw Error(name);
  }});
  const render=async()=>{const suspense=module.exports.default({children:'Student page'});return suspense.props.children.type(suspense.props.children.props);};
  await assert.rejects(render(),error=>error.path==='/login');checks++;
  actor={id:'admin-fixture',role:'admin'};await assert.rejects(render(),error=>error.path==='/admin');checks++;
  check(calls.length===0,'anonymous and non-student requests never load a student bootstrap');
  actor={id:'student-one',role:'student'};const first=await render();
  actor={id:'student-two',role:'student'};const second=await render();
  check(first.type==='AppShell'&&first.key==='student-one'&&second.key==='student-two','each authenticated actor gets its own keyed shell instance');
  check(first.props.initialData.user.id==='student-one'&&second.props.initialData.user.id==='student-two','SSR payloads remain bound to the user authorized for that request');
  check(calls.join(',')==='student-one,student-two','the server layout performs its own bootstrap for each authorized render');
}

// New students see icons and names. Only a stored explicit collapse hides labels.
for (const [storedSidebarPreference, expected] of [[null, 'false'], ['true', 'true'], ['false', 'false'], ['invalid', 'false']]) {
  const h = harness({ storedSidebarPreference });
  check(h.render().props['data-sidebar-collapsed'] === 'false', 'navigation renders expanded before browser preferences load');
  const state = h.state();
  check(state.sidebarCollapsed === expected, `stored preference ${storedSidebarPreference} restores the intended navigation size`);
  check(state.sidebarToggle['aria-expanded'] === (expected === 'false'), 'navigation toggle reflects the visible label state');
  state.sidebarToggle.onClick();
  check(h.state().sidebarCollapsed === (expected === 'false' ? 'true' : 'false'), 'students can still toggle navigation');
  check(h.storageWrites.at(-1)?.[0] === 'gakja-sidebar-collapsed' && h.storageWrites.at(-1)?.[1] === (expected === 'false' ? 'true' : 'false'), 'the explicit navigation choice persists');
  h.dispose();
}
{
  const h = harness({ storageUnavailable: true }); h.render();
  check(h.state().sidebarCollapsed === 'false', 'unavailable browser storage keeps menu names visible');
  h.state().sidebarToggle.onClick();
  check(h.state().sidebarCollapsed === 'true', 'navigation still toggles when saving browser preferences fails'); h.dispose();
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

// Exercise the real callback passed by AppShell to both actual account-menu positions.
// Private browser storage is optional; authenticated logout success must still navigate.
for(const compact of [false,true]){
 let release,releaseStudy,releaseAuth;const gate=new Promise(resolve=>{release=resolve;}),studyGate=new Promise(resolve=>{releaseStudy=resolve;}),authGate=new Promise(resolve=>{releaseAuth=resolve;});
 const h=harness({selectionRemovalBlocked:true,draftGate:gate,studyGate,authGate});h.render();h.requests[0].resolve(fixture('logout-fixture'));await flush();
 const menu=h.state().accountMenus.find(node=>Boolean(node.props.compact)===compact);check(!!menu,`${compact?'mobile':'desktop'} account menu receives the AppShell logout binding`);
 check(!h.state().inert&&!h.state().ariaBusy,'ordinary learning remains interactive before logout');
 const leaving=menu.props.onLogout();check(h.state().inert===true&&h.state().ariaBusy===true,'logout immediately makes the complete learning shell inert');await flush();
 check(h.logoutSteps.join(',')==='drafts'&&h.navigations.length===0,'authentication remains available until pending drafts settle');
 check(h.state().inert===true,'the shell is locked while draft writers are pending');
 release();await flush();check(h.logoutSteps.at(-1)==='study_finish'&&h.state().inert===true&&h.state().ariaBusy===true,'the lock remains after writers finish while study-session completion is pending');
 releaseStudy();await flush();check(h.logoutSteps.at(-1)==='auth_logout'&&h.state().inert===true&&h.state().ariaBusy===true,'the lock remains after study completion while authentication logout is pending');
 releaseAuth();await leaving;
 check(h.state().inert===true&&h.state().ariaBusy===true,'successful auth keeps the entire shell inert until full document replacement');
 check(h.logoutSteps.join(',')==='drafts,study_finish,auth_logout,selection_remove,handoff,navigate','the actual menu callback saves, closes authentication and navigates despite blocked optional storage');
 check(h.handoffs.length===1&&h.handoffs[0].type==='gakja:logout-ready'&&h.handoffs[0].detail.userId==='harin','only the authenticated fixture owner receives a final navigation handoff');
 check(h.navigations.length===1&&h.navigations[0]==='/login','successful logout replaces the document with login exactly once');
 check(h.state().provider.data.marker==='logout-fixture','the old shell stays visually stable until document replacement rather than clearing its content');h.dispose();
}
{
 let releaseAuth;const authGate=new Promise(resolve=>{releaseAuth=resolve;});
 const h=harness({authLogoutFails:true,authGate});h.render();h.requests[0].resolve(fixture('logout-failure'));await flush();
 const leaving=h.state().accountMenus[0].props.onLogout(),failed=assert.rejects(leaving,/auth offline/);await flush();
 check(h.state().inert===true&&h.state().ariaBusy===true,'a pending auth response holds the shell lock even when the preceding draft writer has returned');
 releaseAuth();await failed;check(!h.state().inert&&!h.state().ariaBusy,'authentication failure unlocks the original learning screen for an explicit retry');
 check(h.navigations.length===0&&!h.logoutSteps.includes('selection_remove'),'auth failure propagates to the menu retry UI without replacing the document or clearing selection');h.dispose();
}
for(const stage of ['draft','study','auth']){
 const h=harness({draftFails:stage==='draft',studyFails:stage==='study',authLogoutFails:stage==='auth'});h.render();h.requests[0].resolve(fixture('failure-'+stage));await flush();
 await assert.rejects(h.state().accountMenus[0].props.onLogout(),/failed|offline/);check(h.handoffs.length===0&&h.navigations.length===0,stage+' failure never authorizes learning guards to leave');check(!h.state().inert,stage+' failure restores the interactive learning screen');h.dispose();
}
// A second identical save is another receipt: its React key must remount the notice
// so the prior instance's cleanup cannot dismiss the new acknowledgement early.
{
 const h=harness();h.render();h.requests[0].resolve(fixture('toast-fixture'));await flush();
 const toast=h.state().provider.toast;toast('설정을 저장했어요.');const first=h.state().notice;
 toast('설정을 저장했어요.');const second=h.state().notice;
 check(first?.type==='FloatingNotice'&&second?.type==='FloatingNotice','both settings saves render the shared transient receipt');
 check(first.props.children===second.props.children&&second.key>first.key,'same-message saves increment the receipt nonce instead of reusing an expiring notice');
 second.props.onDismiss();check(!h.state().notice,'dismissal removes the receipt without changing the learning page');
 toast('설정을 저장했어요.');check(h.state().notice.key>second.key,'a repeated save after dismissal also receives a fresh receipt identity');h.dispose();
}
console.log(`AppShell: ${checks} checks passed; expanded navigation defaults and saved choices, StrictMode replay, refresh response ordering and unmount guards exercised against actual component hooks; external calls: 0.`);
