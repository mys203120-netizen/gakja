import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as icons from 'lucide-react';
import { renderToStaticMarkup } from 'react-dom/server';
import {createPortal} from 'react-dom';
import { tsImport } from 'tsx/esm/api';

// Exercise the actual auth component without a browser, account, or network call.
// The SSR contract protects credentials while client JavaScript is still loading.
const rules = await tsImport('../apps/web/src/lib/social-auth-rules.ts', import.meta.url);
const source = ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/auth-screen.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const link = ({ href, children, ...props }) => React.createElement('a', { href, ...props }, children);
const nothing = () => {};
const gsap = {
  matchMedia: () => ({ add: nothing, revert: nothing }),
  context: callback => { callback(); return { revert: nothing }; },
  to: nothing, from: nothing, fromTo: nothing, set: nothing, killTweensOf: nothing,
};

const introModule={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../apps/web/src/components/login-intro-sheet.tsx',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,{
 module:introModule,exports:introModule.exports,require(name){
  if(name==='react')return React;
  if(name==='react-dom')return {createPortal};
  if(name==='react/jsx-runtime')return jsx;
  if(name==='lucide-react')return icons;
  if(name.endsWith('.module.css'))return {default:new Proxy({},{get:(_,key)=>String(key)})};
  throw new Error(name);
 }
});

function loadAuth({ hooks = React, post = async () => { throw new Error('Unexpected auth write'); }, router = {}, fetch = async () => { throw new Error('Unexpected auth read'); } } = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, {
    module, exports: module.exports, Date, URLSearchParams, fetch,
    window: { location: { search: '', assign: () => { throw new Error('Unexpected external navigation'); } }, matchMedia: () => ({ matches: true }) },
    document: { hidden: false },
    require(name) {
      if (name === './login-intro-sheet') return introModule.exports;
      if (name === 'react') return hooks;
      if (name === 'react/jsx-runtime') return jsx;
      if (name === 'next/link') return { default: link };
      if (name === 'next/navigation') return { useRouter: () => router };
      if (name === 'lucide-react') return icons;
      if (name === 'gsap') return { default: gsap };
      if (name === '@/lib/social-auth-rules') return rules;
      if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      if (name === './shared') return {
        post,
        Logo: ({ size }) => React.createElement('svg', { width: size, height: size, 'aria-hidden': true }),
        Alert: ({ children }) => React.createElement('div', { role: 'alert' }, children),
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return module.exports.AuthScreen;
}

for (const mode of ['login', 'invite', 'reset-password']) {
  test(`${mode}: initial server HTML uses POST and disables submission until hydration`, () => {
    const AuthScreen = loadAuth();
    const html = renderToStaticMarkup(React.createElement(AuthScreen, { mode }));
    const form = html.match(/<form\b[^>]*>/)?.[0] || '';
    const submit = (html.match(/<button\b[^>]*>/g) || []).find(tag => /class="[^"]*\bauth-submit\b/.test(tag)) || '';
    assert.match(form, /\bmethod="post"/i, 'native fallback must never submit credential fields using GET');
    assert.match(form, /\baria-busy="true"/, 'the server-rendered form communicates that it is not ready');
    assert.match(submit, /\bdisabled(?:="")?(?:\s|>)/, 'a visible form cannot submit before its event handler is attached');
    assert.ok(!/\baction="[^\"]*\?/.test(form), 'the form action must not place credentials into a query');
    if (mode === 'login') assert.match(html, /name="password"/);
    assert.match(html, /name="email"/);
  });
}

function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.props?.children)];
}
function harness(mode, { canSetPassword = false, post = async () => ({ message: '확인 메일을 보냈어요.' }), router = {} } = {}) {
  const state = [], effects = []; let index = 0;
  const hooks = {
    useState(initial) {
      const slot = index++;
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial;
      return [state[slot], next => { state[slot] = typeof next === 'function' ? next(state[slot]) : next; }];
    },
    useRef(initial) {
      const slot = index++;
      if (!(slot in state)) state[slot] = { current: initial };
      return state[slot];
    },
    useEffect(callback) { effects.push(callback); },
  };
  const AuthScreen = loadAuth({ hooks, post, router, fetch: async () => ({ json: async () => ({ canSetPassword, providers: {} }) }) });
  function render() { index = 0; return AuthScreen({ mode }); }
  async function hydrate() {
    // Flush only the effects registered by the first render, then allow the
    // local auth-state read to resolve. No positional hook values are assumed.
    for (const effect of effects.splice(0)) effect();
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    return render();
  }
  return { render, hydrate };
}
const formOf = tree => nodes(tree).find(node => node.type === 'form');
const submitOf = tree => nodes(tree).find(node => node.type === 'button' && node.props.className?.split(' ').includes('auth-submit'));

test('a premature submit is prevented without calling the auth API', async () => {
  let writes = 0, prevented = false;
  const view = harness('login', { post: async () => { writes++; return {}; } });
  const tree = view.render();
  await formOf(tree).props.onSubmit({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(writes, 0);
  assert.equal(submitOf(tree).props.disabled, true);
});

test('hydrated login still sends one JSON auth request and blocks a second in-flight submit', async () => {
  const writes = [], paths = []; let complete;
  const response = new Promise(resolve => { complete = resolve; });
  const view = harness('login', { post: (url, body) => { writes.push({ url, body }); return response; }, router: { push: path => paths.push(path), refresh: nothing } });
  view.render();
  let tree = await view.hydrate();
  assert.equal(submitOf(tree).props.disabled, false);
  assert.equal(formOf(tree).props['aria-busy'], false);
  nodes(tree).find(node => node.type === 'input' && node.props.name === 'email').props.onChange({ target: { value: 'hydration-fixture@example.invalid' } });
  nodes(tree).find(node => node.type === 'input' && node.props.name === 'password').props.onChange({ target: { value: 'synthetic-only-password' } });
  tree = view.render();
  const pending = formOf(tree).props.onSubmit({ preventDefault: nothing });
  tree = view.render();
  assert.equal(submitOf(tree).props.disabled, true);
  await formOf(tree).props.onSubmit({ preventDefault: nothing });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url, '/api/auth');
  assert.equal(writes[0].body.action, 'login');
  assert.equal(writes[0].body.email, 'hydration-fixture@example.invalid');
  assert.equal(writes[0].body.password, 'synthetic-only-password');
  complete({ user: { role: 'student' } });
  await pending;
  assert.deepEqual(paths, ['/my']);
  assert.equal(submitOf(view.render()).props.disabled, false);
});

test('reset and invite keep their existing capability checks after hydration', async () => {
  for (const [mode, canSetPassword, disabled] of [['reset-password', false, false], ['invite', false, true], ['invite', true, false]]) {
    const view = harness(mode, { canSetPassword });
    view.render();
    const tree = await view.hydrate();
    assert.equal(submitOf(tree).props.disabled, disabled, `${mode}: canSetPassword=${canSetPassword}`);
    assert.equal(formOf(tree).props.method, 'post');
  }
});

test('intro is discoverable only on login and never opens before user interaction',()=>{
 for(const mode of ['login','signup','invite','reset-password']){
  const html=renderToStaticMarkup(React.createElement(loadAuth(),{mode}));
  assert.equal(html.includes('각자ON 둘러보기'),mode==='login');
  assert.doesNotMatch(html,/<dialog/);
  if(mode==='login'){assert.match(html,/aria-haspopup="dialog"/);assert.match(html,/aria-expanded="false"/);}
 }
});
