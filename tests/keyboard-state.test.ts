import { afterEach, expect, it, vi } from 'vitest';
import { bindViewportKeyboardState, createKeyboardStateStore, KEYBOARD_STATE_EVENT } from '../src/ui/keyboard-state';

afterEach(() => { vi.unstubAllGlobals(); });

function surfaces() {
  const viewport = Object.assign(new EventTarget(), { height: 800 });
  const target = Object.assign(new EventTarget(), { innerHeight: 800, innerWidth: 390, visualViewport: viewport });
  const doc = Object.assign(new EventTarget(), { activeElement: null as { tagName: string; type?: string } | null });
  vi.stubGlobal('window', target); vi.stubGlobal('document', doc);
  return { viewport, target, doc };
}

it('keeps native keyboard visibility when both viewport heights resize together', () => {
  const { target, viewport, doc } = surfaces();
  const store = createKeyboardStateStore();
  const dispose = bindViewportKeyboardState(store);
  doc.activeElement = { tagName: 'INPUT', type: 'text' };
  target.innerHeight = 480; viewport.height = 480;
  store.applyNative({ visible: true, height: 960, ready: true }, 3);
  target.dispatchEvent(new Event('resize'));
  expect(store.get()).toEqual({ visible: true, height: 320, source: 'native', ready: true });
  store.applyNative({ visible: false, height: 0 }, 3);
  viewport.dispatchEvent(new Event('resize'));
  expect(store.get().visible).toBe(false);
  dispose();
});

it('uses a focused text editor for the browser viewport fallback, not game sliders', () => {
  const { viewport, target, doc } = surfaces();
  const store = createKeyboardStateStore();
  const dispose = bindViewportKeyboardState(store);
  viewport.height = 480;
  viewport.dispatchEvent(new Event('resize'));
  expect(store.get().visible).toBe(false);
  doc.activeElement = { tagName: 'INPUT', type: 'range' };
  doc.dispatchEvent(new Event('focusin'));
  expect(store.get().visible).toBe(false);
  doc.activeElement = { tagName: 'INPUT', type: 'text' };
  doc.dispatchEvent(new Event('focusin'));
  expect(store.get()).toMatchObject({ visible: true, height: 320, source: 'viewport' });
  target.innerHeight = 480;
  target.dispatchEvent(new Event('resize'));
  expect(store.get().visible).toBe(true);
  doc.activeElement = null;
  doc.dispatchEvent(new Event('focusout'));
  expect(store.get().visible).toBe(false);
  dispose();
});

it('rejects invalid/not-ready native data and leaves the current fallback intact', () => {
  const store = createKeyboardStateStore(vi.fn());
  store.applyViewport(true, 200);
  expect(store.applyNative({ visible: false, height: 0, ready: false })).toBe(false);
  expect(store.applyNative({ visible: true, height: -10 })).toBe(false);
  expect(store.applyNative({ visible: true, height: 500 }, 0)).toBe(false);
  expect(store.get()).toMatchObject({ visible: true, height: 200, source: 'viewport' });
});

it('reports a floating native keyboard as visible even without a bottom occlusion', () => {
  const store = createKeyboardStateStore(vi.fn());
  store.applyNative({ visible: true, height: 0 }, 3);
  store.applyViewport(false, 0);
  expect(store.get()).toEqual({ visible: true, height: 0, source: 'native', ready: true });
});

it('does not mistake a width-changing rotation for an opened browser keyboard', () => {
  const { target, viewport, doc } = surfaces();
  const store = createKeyboardStateStore(vi.fn());
  const dispose = bindViewportKeyboardState(store);
  doc.activeElement = { tagName: 'INPUT', type: 'text' };
  doc.dispatchEvent(new Event('focusin'));
  target.innerWidth = 800; target.innerHeight = 390; viewport.height = 390;
  target.dispatchEvent(new Event('resize'));
  expect(store.get().visible).toBe(false);
  dispose();
});

it('deduplicates native updates and releases subscriptions', () => {
  const { target } = surfaces();
  const events = vi.fn(), subscriber = vi.fn();
  target.addEventListener(KEYBOARD_STATE_EVENT, events);
  const store = createKeyboardStateStore();
  const dispose = store.subscribe(subscriber);
  store.applyNative({ visible: true, height: 400 }, 2);
  store.applyNative({ visible: true, height: 400 }, 2);
  expect(events).toHaveBeenCalledOnce(); expect(subscriber).toHaveBeenCalledOnce();
  expect(Object.isFrozen(store.get())).toBe(true);
  dispose();
  store.applyNative({ visible: false, height: 400 }, 2);
  expect(subscriber).toHaveBeenCalledOnce(); expect(store.get().height).toBe(0);
});

it('stops viewport/focus updates after disposal', () => {
  const { doc, viewport } = surfaces();
  const store = createKeyboardStateStore(vi.fn());
  const dispose = bindViewportKeyboardState(store);
  const before = store.get();
  dispose();
  doc.activeElement = { tagName: 'TEXTAREA' }; viewport.height = 200;
  doc.dispatchEvent(new Event('focusin')); viewport.dispatchEvent(new Event('resize'));
  expect(store.get()).toBe(before);
});
