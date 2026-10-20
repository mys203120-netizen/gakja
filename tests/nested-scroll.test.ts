import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { installNestedScrollBehavior } from '../apps/web/src/lib/client/nested-scroll';

class FakeElement {
  parentElement: FakeElement | null = null;
  attrs = new Map<string, string>();
  classes = new Set<string>();
  style: Record<string, string> = { overflow: 'visible', overflowY: '', position: 'static', lineHeight: '20px' };
  scrollTop = 0;
  scrollHeight = 100;
  clientHeight = 100;
  scrollWidth = 100;
  clientWidth = 100;
  isConnected = true;
  calls: Array<{ top: number; behavior: string }> = [];
  constructor(public owner: ReturnType<typeof dom> | null, public tag = 'div') {}
  matches(selector: string): boolean {
    return selector.split(',').some(raw => {
      const part = raw.trim();
      if (part.startsWith('.')) return this.classes.has(part.slice(1));
      if (part === 'dialog[open]') return this.tag === 'dialog' && this.attrs.has('open');
      if (part.startsWith('[contenteditable]')) return this.attrs.has('contenteditable') && this.attrs.get('contenteditable') !== 'false';
      if (part === '[data-native-scroll]') return this.attrs.has('data-native-scroll');
      const role = /\[role="([^"]+)"\]/.exec(part)?.[1];
      if (role) return this.attrs.get('role') === role && (!part.includes('[aria-modal="true"]') || this.attrs.get('aria-modal') === 'true');
      return this.tag === part;
    });
  }
  closest(selector: string): FakeElement | null { for (let node: FakeElement | null = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  setAttribute(key: string, value: string) { this.attrs.set(key, value); }
  removeAttribute(key: string) { this.attrs.delete(key); }
  scrollTo(options: { top: number; behavior: string }) {
    this.calls.push(options);
    this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, options.top));
    this.owner!.emit('scroll', { target: this });
  }
}

function dom() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  const registrations: Array<{ name: string; options: any }> = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let now = 0, nextTimer = 0, selection = false;
  const root = new FakeElement(null, 'html'), body = new FakeElement(null, 'body');
  body.parentElement = root;
  const win = {
    Element: FakeElement, innerHeight: 800,
    getComputedStyle: (element: FakeElement) => ({ ...element.style, overflowY: element.style.overflowY || element.style.overflow }),
    scrollTo: (options: { top: number; behavior: string }) => root.scrollTo(options),
    setTimeout: (callback: () => void, ms: number) => { const id = ++nextTimer; timers.set(id, { at: now + ms, callback }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  };
  const doc = { defaultView: win, documentElement: root, body, scrollingElement: root,
    getSelection: () => ({ isCollapsed: !selection }),
    addEventListener(name: string, callback: (event: any) => void, options: any) {
      if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(callback); registrations.push({ name, options });
    },
    removeEventListener(name: string, callback: (event: any) => void) { listeners.get(name)?.delete(callback); },
  };
  const environment = {
    doc, root, body, win, listeners, registrations, timers,
    node(parent: FakeElement = body, { tag = 'div', className = '', range = 0, top = 0, overflow = range ? 'auto' : 'visible', position = 'static', role = '', modal = false } = {}) {
      const element = new FakeElement(environment, tag); element.parentElement = parent;
      if (className) className.split(' ').forEach(name => element.classes.add(name));
      element.scrollHeight = 100 + range; element.scrollTop = top; element.style.overflowY = overflow; element.style.position = position;
      if (role) element.attrs.set('role', role); if (modal) element.attrs.set('aria-modal', 'true');
      return element;
    },
    emit(name: string, values: Record<string, any> = {}) {
      const event = { type: name, target: body, defaultPrevented: false, cancelable: true, deltaX: 0, deltaY: 100, deltaMode: 0,
        ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
        preventDefault() { if (this.cancelable) this.defaultPrevented = true; },
        composedPath() { const path: FakeElement[] = []; for (let current: FakeElement | null = this.target as FakeElement; current; current = current.parentElement) path.push(current); return path; }, ...values };
      for (const callback of listeners.get(name) || []) callback(event);
      return event;
    },
    advance(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } },
    select(value: boolean) { selection = value; },
    install() { return installNestedScrollBehavior(doc as unknown as Document); },
  };
  root.owner = body.owner = environment;
  root.scrollHeight = 1100;
  return environment;
}

function ordinary() {
  const d = dom(), app = d.node(d.body, { className: 'app-shell' }), inner = d.node(app, { range: 500 });
  const dispose = d.install();
  return { ...d, app, inner, dispose };
}

test('downward scroll exhausts outer ranges and sends only residual delta inward', () => {
  const d = ordinary(); d.root.scrollTop = 950;
  const panel = d.node(d.app, { range: 100, top: 80 }), inner = d.node(panel, { range: 500, top: 10 });
  const event = d.emit('wheel', { target: inner, deltaY: 100 });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual([d.root.scrollTop, panel.scrollTop, inner.scrollTop], [1000, 100, 40]);
  assert.equal(d.root.calls[0].behavior, 'instant');
  assert.equal(inner.attrs.get('data-scroll-visible'), 'true');
  assert.equal(d.root.attrs.has('data-scroll-visible'), true);
});

test('upward scroll exhausts the inner range before moving its parents', () => {
  const d = ordinary(); d.root.scrollTop = 50;
  const panel = d.node(d.app, { range: 100, top: 20 }), inner = d.node(panel, { range: 500, top: 10 });
  d.emit('wheel', { target: inner, deltaY: -50 });
  assert.deepEqual([inner.scrollTop, panel.scrollTop, d.root.scrollTop], [0, 0, 30]);
});

test('ordinary page without nested overflow and full-height chat remain native', () => {
  const d = ordinary();
  assert.equal(d.emit('wheel', { target: d.app }).defaultPrevented, false);
  d.root.scrollHeight = d.root.clientHeight;
  assert.equal(d.emit('wheel', { target: d.inner }).defaultPrevented, false);
  assert.equal(d.inner.calls.length, 0);
});

test('fixed panels and the sidebar cannot hand scrolling to the page', () => {
  for (const options of [{ position: 'fixed' }, { className: 'sidebar' }]) {
    const d = ordinary(), panel = d.node(d.app, { range: 100, top: 90, ...options }), inner = d.node(panel, { range: 500 });
    d.emit('wheel', { target: inner, deltaY: 50 });
    assert.deepEqual([d.root.scrollTop, panel.scrollTop, inner.scrollTop], [0, 100, 40]);
  }
});

test('body/html overflow locks exclude root even when its layout still has a scroll range', () => {
  for (const [where, overflow] of [['body', 'hidden'], ['root', 'clip']] as const) {
    const d = ordinary(); d[where].style.overflow = overflow;
    assert.equal(d.emit('wheel', { target: d.inner }).defaultPrevented, false);
    assert.equal(d.root.calls.length, 0);
  }
});

test('modal and aria-modal lists only reorder inside their own scroll boundary', () => {
  for (const options of [{ className: 'native-modal' }, { className: 'modal' }, { role: 'dialog', modal: true }, { role: 'alertdialog', modal: true }]) {
    const d = ordinary(), modal = d.node(options.className ? d.body : d.app, { range: 100, top: 90, ...options }), list = d.node(modal, { range: 300 });
    const event = d.emit('wheel', { target: list, deltaY: 70 });
    assert.equal(event.defaultPrevented, true);
    assert.deepEqual([d.root.scrollTop, modal.scrollTop, list.scrollTop], [0, 100, 60]);
  }
});

test('inputs, select/listbox/menu, editable content and code keep native wheel behavior', () => {
  const d = ordinary();
  for (const tag of ['input', 'textarea', 'select', 'option', 'optgroup', 'pre']) {
    const target = d.node(d.inner, { tag });
    assert.equal(d.emit('wheel', { target }).defaultPrevented, false, tag);
  }
  for (const role of ['textbox', 'combobox', 'listbox', 'option', 'menu']) {
    const target = d.node(d.inner, { role });
    assert.equal(d.emit('wheel', { target }).defaultPrevented, false, role);
  }
  const editable = d.node(d.inner); editable.attrs.set('contenteditable', '');
  assert.equal(d.emit('wheel', { target: d.node(editable) }).defaultPrevented, false);
  const native = d.node(d.inner); native.attrs.set('data-native-scroll', '');
  assert.equal(d.emit('wheel', { target: native }).defaultPrevented, false);
  assert.equal(d.root.calls.length, 0);
});

test('retargeted editable shadow events, text selection and out-of-scope pages remain native', () => {
  const d = ordinary(), input = d.node(d.inner, { tag: 'input' });
  assert.equal(d.emit('wheel', { target: d.inner, composedPath: () => [input, d.inner] }).defaultPrevented, false);
  d.select(true);
  assert.equal(d.emit('wheel', { target: d.inner }).defaultPrevented, false);
  d.select(false);
  const outside = d.node(d.body, { range: 500 });
  assert.equal(d.emit('wheel', { target: outside }).defaultPrevented, false);
});

test('horizontal gestures, browser zoom/modifiers and uncancelable wheel are untouched', () => {
  const d = ordinary();
  for (const flags of [{ deltaX: 120 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { cancelable: false }, { defaultPrevented: true }, { deltaY: Number.NaN }]) {
    const event = d.emit('wheel', { target: d.inner, ...flags });
    assert.equal(event.defaultPrevented, Boolean((flags as any).defaultPrevented));
  }
  assert.equal(d.root.calls.length, 0);
});

test('line and page wheel delta modes are converted before scroll distribution', () => {
  const d = ordinary(); d.root.scrollHeight = 5100;
  d.emit('wheel', { target: d.inner, deltaY: 2, deltaMode: 1 });
  assert.equal(d.root.scrollTop, 40);
  d.emit('wheel', { target: d.inner, deltaY: 1, deltaMode: 2 });
  assert.equal(d.root.scrollTop, 840);
});

test('actual inner and document scrolling reveal a scrollbar, renewed for 900ms before fading', () => {
  const d = ordinary();
  assert.equal(d.inner.attrs.has('data-scroll-visible'), false);
  assert.equal(d.registrations.find(row => row.name === 'scroll')?.options.capture, true);
  d.emit('scroll', { target: d.inner });
  assert.equal(d.inner.attrs.get('data-scroll-visible'), 'true');
  d.advance(899); assert.equal(d.inner.attrs.has('data-scroll-visible'), true);
  d.emit('scroll', { target: d.inner }); d.advance(899);
  assert.equal(d.inner.attrs.has('data-scroll-visible'), true);
  d.advance(1); assert.equal(d.inner.attrs.has('data-scroll-visible'), false);
  d.emit('scroll', { target: d.root }); d.emit('scroll', { target: d.app });
  assert.equal(d.root.attrs.has('data-scroll-visible'), true);
  assert.equal(d.root.attrs.get('data-scroll-decorated'),'true');
  d.advance(900);assert.equal(d.root.attrs.has('data-scroll-visible'),false);
  assert.equal(d.root.attrs.get('data-scroll-decorated'),'true','decoration survives so the registered thumb colour can fade');
  assert.equal(d.app.attrs.has('data-scroll-visible'), false);
  const outside = d.node(d.body, { range: 100 }); d.emit('scroll', { target: outside });
  assert.equal(outside.attrs.has('data-scroll-visible'), false);
});

test('single-finger vertical touch uses the same down/up order and horizontal touch stays native', () => {
  const d = ordinary(); d.root.scrollTop = 950;
  const point = (x: number, y: number) => ({ identifier: 3, clientX: x, clientY: y });
  d.emit('touchstart', { target: d.inner, touches: [point(100, 100)] });
  assert.equal(d.emit('touchmove', { target: d.inner, touches: [point(102, 20)] }).defaultPrevented, true);
  assert.deepEqual([d.root.scrollTop, d.inner.scrollTop], [1000, 30]);
  d.emit('touchmove', { target: d.inner, touches: [point(102, 70)] });
  assert.deepEqual([d.inner.scrollTop, d.root.scrollTop], [0, 980]);
  d.emit('touchend');
  d.emit('touchstart', { target: d.inner, touches: [point(100, 100)] });
  assert.equal(d.emit('touchmove', { target: d.inner, touches: [point(20, 95)] }).defaultPrevented, false);
  assert.equal(d.emit('touchmove', { target: d.inner, touches: [point(15, 20)] }).defaultPrevented, false, 'horizontal gesture remains locked to native scrolling');
});

test('pinch, touch cancellation and native input gestures never resume as managed touch', () => {
  const d = ordinary(), point = { identifier: 1, clientX: 0, clientY: 100 }, moved = { ...point, clientY: 0 };
  d.emit('touchstart', { target: d.inner, touches: [point] });
  assert.equal(d.emit('touchmove', { target: d.inner, touches: [point, { ...point, identifier: 2 }] }).defaultPrevented, false);
  assert.equal(d.emit('touchmove', { target: d.inner, touches: [moved] }).defaultPrevented, false);
  d.emit('touchstart', { target: d.inner, touches: [point] }); d.emit('touchcancel');
  assert.equal(d.emit('touchmove', { target: d.inner, touches: [moved] }).defaultPrevented, false);
  const input = d.node(d.inner, { tag: 'textarea' });
  d.emit('touchstart', { target: input, touches: [point] });
  assert.equal(d.emit('touchmove', { target: input, touches: [moved] }).defaultPrevented, false);
  assert.equal(d.root.calls.length, 0);
});

test('cleanup restores attributes, clears timers and removes all listeners without key handlers', () => {
  const d = ordinary(); d.emit('scroll', { target: d.inner });
  assert.ok(d.timers.size);
  assert.equal(d.registrations.some(row => row.name.startsWith('key')), false);
  d.dispose();
  assert.equal(d.timers.size, 0);
  assert.equal(d.inner.attrs.has('data-scroll-visible'), false);
  assert.ok([...d.listeners.values()].every(list => !list.size));
});

test('ScrollBehavior component installs the real effect and returns its cleanup', () => {
  const d = dom(), effects: Array<() => () => void> = [], module = { exports: {} as any };
  const source = fs.readFileSync(new URL('../apps/web/src/components/scroll-behavior.tsx', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, document: d.doc,
    require(name: string) { if (name === 'react') return { useEffect: (effect: () => () => void) => effects.push(effect) }; if (name === '@/lib/client/nested-scroll') return { installNestedScrollBehavior }; throw new Error(name); },
  });
  assert.equal(module.exports.ScrollBehavior(), null);
  assert.equal(effects.length, 1);
  const cleanup = effects[0]();
  assert.equal(d.listeners.get('wheel')?.size, 1);
  cleanup(); assert.equal(d.listeners.get('wheel')?.size, 0);
});
