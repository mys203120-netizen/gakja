const scopeSelector = '.app-shell, .auth-page, .native-modal, .modal';
const nativeSelector = 'input, textarea, select, option, optgroup, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="listbox"], [role="option"], [role="menu"], pre, [data-native-scroll]';
const boundarySelector = '.sidebar, .native-modal, .modal, dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';
const overflowPattern = /^(auto|scroll)$/;
const lockedPattern = /^(hidden|clip)$/;
const epsilon = 0.5;

type ScrollStep = { element: Element; top: number };
type TouchGesture = { id: number; target: Element; startX: number; startY: number; lastY: number; axis: 'x' | 'y' | null };

/** Scoped native scroll decoration and directional nested scrolling. No keyboard
 * interception: focus, caret movement and explicit scrollbar dragging stay native. */
export function installNestedScrollBehavior(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const visibilityTimers = new Map<Element, number>();
  let touch: TouchGesture | null = null;

  const isElement = (value: unknown): value is Element => value instanceof win.Element;
  const inScope = (element: Element) => Boolean(element.closest(scopeSelector));
  const eventElements = (event: Event) => {
    const path = event.composedPath?.() || [];
    return [event.target, ...path].filter(isElement);
  };
  const targetFor = (event: Event) => {
    const elements = eventElements(event);
    if (elements.some(element => element.closest(nativeSelector))) return null;
    const target = elements[0];
    return target && inScope(target) ? target : null;
  };
  const selectionActive = () => doc.getSelection()?.isCollapsed === false;
  const verticalRange = (element: Element) => Math.max(0, element.scrollHeight - element.clientHeight);
  const styleFor = (element: Element) => win.getComputedStyle(element);
  const rootLocked = () => [doc.documentElement, doc.body].some(element => {
    if (!element) return false;
    const style = styleFor(element);
    return lockedPattern.test(style.overflowY || style.overflow);
  });

  function scrollChain(target: Element): Element[] {
    const chain: Element[] = [];
    let bounded = false;
    for (let element: Element | null = target; element && element !== doc.body && element !== doc.documentElement; element = element.parentElement) {
      const style = styleFor(element);
      if (overflowPattern.test(style.overflowY || style.overflow) && verticalRange(element) > epsilon) chain.push(element);
      if (element.matches(boundarySelector) || style.position === 'fixed') { bounded = true; break; }
    }
    const root = doc.scrollingElement;
    if (!bounded && !rootLocked() && root && verticalRange(root) > epsilon) chain.push(root);
    return chain;
  }

  function planScroll(target: Element, delta: number): ScrollStep[] {
    const chain = scrollChain(target);
    // A lone scroller keeps browser inertia and native boundary handling. In
    // full-height chat, history/messages therefore work without an outer page.
    if (chain.length < 2) return [];
    const ordered = delta > 0 ? [...chain].reverse() : chain;
    const steps: ScrollStep[] = [];
    let remaining = delta;
    for (const element of ordered) {
      const range = verticalRange(element), top = Math.max(0, Math.min(range, element.scrollTop));
      const available = remaining > 0 ? range - top : top;
      const amount = Math.sign(remaining) * Math.min(Math.abs(remaining), available);
      if (Math.abs(amount) > epsilon) { steps.push({ element, top: top + amount }); remaining -= amount; }
      if (Math.abs(remaining) <= epsilon) break;
    }
    return steps;
  }

  function applySteps(event: Event, steps: ScrollStep[]) {
    if (!event.cancelable || !steps.length) return;
    event.preventDefault();
    if (!event.defaultPrevented) return;
    for (const { element, top } of steps) {
      // Explicit instant scrolling avoids queuing smooth animations for every
      // wheel/touch sample under the app's global scroll-behavior declaration.
      if (element === doc.scrollingElement) win!.scrollTo({ top, behavior: 'instant' });
      else element.scrollTo({ top, behavior: 'instant' });
    }
  }

  function showScrollbar(event: Event) {
    const root=event.target===doc||event.target===doc.scrollingElement||event.target===doc.body||event.target===doc.documentElement;
    const element = root?doc.scrollingElement:event.target;
    if (!isElement(element) || (!root&&!inScope(element))) return;
    if (element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth) return;
    const rootStyle=(element as HTMLElement).style;
    if(root&&typeof rootStyle?.setProperty==='function'){
      const viewport=win!.innerHeight,range=Math.max(1,element.scrollHeight-element.clientHeight);
      const height=Math.max(28,viewport*viewport/element.scrollHeight);
      rootStyle.setProperty('--document-thumb-height',`${height}px`);
      rootStyle.setProperty('--document-thumb-top',`${Math.max(0,Math.min(1,element.scrollTop/range))*(viewport-height)}px`);
    }
    const previous = visibilityTimers.get(element);
    if (previous !== undefined) win!.clearTimeout(previous);
    element.setAttribute('data-scroll-decorated', 'true');
    element.setAttribute('data-scroll-visible', 'true');
    visibilityTimers.set(element, win!.setTimeout(() => {
      element.removeAttribute('data-scroll-visible');
      visibilityTimers.delete(element);
    }, 900));
  }

  function wheel(event: WheelEvent) {
    if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || selectionActive()) return;
    if (!Number.isFinite(event.deltaY) || !event.deltaY || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const target = targetFor(event);
    if (!target) return;
    const lineHeight = Number.parseFloat(styleFor(target).lineHeight) || 16;
    const unit = event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? win!.innerHeight : 1;
    applySteps(event, planScroll(target, event.deltaY * unit));
  }

  function touchStart(event: TouchEvent) {
    touch = null;
    if (event.touches.length !== 1 || event.defaultPrevented || selectionActive()) return;
    const target = targetFor(event), point = event.touches[0];
    if (target) touch = { id: point.identifier, target, startX: point.clientX, startY: point.clientY, lastY: point.clientY, axis: null };
  }
  function touchMove(event: TouchEvent) {
    if (!touch) return;
    if (event.touches.length !== 1 || event.defaultPrevented || !event.cancelable || selectionActive() || !touch.target.isConnected) { touch = null; return; }
    const point = event.touches[0];
    if (point.identifier !== touch.id) { touch = null; return; }
    const dx = point.clientX - touch.startX, dy = point.clientY - touch.startY, delta = touch.lastY - point.clientY;
    touch.lastY = point.clientY;
    if (!touch.axis && Math.max(Math.abs(dx), Math.abs(dy)) >= 8) touch.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
    if (touch.axis !== 'y' || !delta) return;
    applySteps(event, planScroll(touch.target, delta));
  }
  const touchEnd = () => { touch = null; };

  doc.addEventListener('scroll', showScrollbar, { capture: true, passive: true });
  doc.addEventListener('wheel', wheel, { capture: true, passive: false });
  doc.addEventListener('touchstart', touchStart, { capture: true, passive: true });
  doc.addEventListener('touchmove', touchMove, { capture: true, passive: false });
  doc.addEventListener('touchend', touchEnd, { capture: true, passive: true });
  doc.addEventListener('touchcancel', touchEnd, { capture: true, passive: true });
  return () => {
    doc.removeEventListener('scroll', showScrollbar, true);
    doc.removeEventListener('wheel', wheel, true);
    doc.removeEventListener('touchstart', touchStart, true);
    doc.removeEventListener('touchmove', touchMove, true);
    doc.removeEventListener('touchend', touchEnd, true);
    doc.removeEventListener('touchcancel', touchEnd, true);
    touch = null;
    for (const [element, timer] of visibilityTimers) { win!.clearTimeout(timer); element.removeAttribute('data-scroll-visible'); element.removeAttribute('data-scroll-decorated'); }
    visibilityTimers.clear();
  };
}
