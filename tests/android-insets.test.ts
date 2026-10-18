import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'web' }, registerPlugin: vi.fn() }));
import { bindSafeAreaVariables, bindAndroidInsets } from '../src/ui/android-insets';
import { createKeyboardStateStore, type NativeKeyboardState } from '../src/ui/keyboard-state';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('maps safe areas to SystemBars CSS variables without copying native pixel values', () => {
  const properties = new Map<string, string>();
  const root = { style: { setProperty: (key: string, value: string) => properties.set(key, value) } } as unknown as HTMLElement;
  bindSafeAreaVariables(root);
  expect(properties.size).toBe(4);
  expect(properties.get('--safe-area-bottom')).toBe('var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))');
});

function surfaces() {
  const diagnostics: unknown[] = [];
  const target = new EventTarget();
  target.addEventListener('orbbound-insets-diagnostic', event => diagnostics.push((event as CustomEvent).detail));
  vi.stubGlobal('window', Object.assign(target, { devicePixelRatio: 2 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  return { root: { style: { setProperty: vi.fn() } } as unknown as HTMLElement, diagnostics, target, store: createKeyboardStateStore() };
}

it('limits a failing bridge to three attempts and retries on foreground later', async () => {
  vi.useFakeTimers();
  const { root, diagnostics, store } = surfaces();
  const native = { addListener: vi.fn().mockRejectedValue(new Error('bridge offline')), getSafeArea: vi.fn(), getKeyboardState: vi.fn() };
  const dispose = bindAndroidInsets(native, root, store);
  await vi.runAllTimersAsync();
  expect(native.addListener).toHaveBeenCalledTimes(3);
  expect(diagnostics).toHaveLength(3);
  expect(root.style.setProperty).toHaveBeenCalledTimes(4);
  expect(native.getSafeArea).not.toHaveBeenCalled();
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.runAllTimersAsync();
  expect(native.addListener).toHaveBeenCalledTimes(6);
  dispose();
  document.dispatchEvent(new Event('visibilitychange'));
  expect(native.addListener).toHaveBeenCalledTimes(6);
});

it('keeps a single subscription when fetching fails and accepts a later valid event', async () => {
  vi.useFakeTimers();
  const { root, diagnostics, store } = surfaces();
  const remove = vi.fn().mockResolvedValue(undefined);
  let change: ((state: NativeKeyboardState) => void) | undefined;
  const native = {
    addListener: vi.fn(async (_name: string, listener: typeof change) => { change = listener; return { remove }; }),
    getSafeArea: vi.fn(),
    getKeyboardState: vi.fn().mockRejectedValue(new Error('not ready')),
  };
  const dispose = bindAndroidInsets(native, root, store);
  await vi.runAllTimersAsync();
  expect(native.addListener).toHaveBeenCalledOnce();
  expect(native.getKeyboardState).toHaveBeenCalledTimes(3);
  change?.({ visible: true, height: 600, ready: true });
  expect(store.get()).toEqual({ visible: true, height: 300, ready: true, source: 'native' });
  expect(root.style.setProperty).toHaveBeenCalledTimes(4);
  expect(native.getSafeArea).not.toHaveBeenCalled();
  expect(diagnostics.at(-1)).toMatchObject({ stage: 'recovered' });
  dispose();
  expect(remove).toHaveBeenCalledOnce();
});

it('removes a listener that resolves after the binding was disposed', async () => {
  const { root, store } = surfaces();
  let resolve: ((handle: { remove(): Promise<void> }) => void) | undefined;
  const remove = vi.fn().mockResolvedValue(undefined);
  const native = { addListener: vi.fn(() => new Promise<{ remove(): Promise<void> }>(done => { resolve = done; })), getSafeArea: vi.fn(), getKeyboardState: vi.fn() };
  const dispose = bindAndroidInsets(native, root, store);
  dispose(); resolve?.({ remove });
  await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
  expect(native.getKeyboardState).not.toHaveBeenCalled();
});

it('bounds a bridge that never responds and permits a later foreground retry', async () => {
  vi.useFakeTimers();
  const { root, store, diagnostics } = surfaces();
  const remove = vi.fn().mockResolvedValue(undefined);
  const native = {
    addListener: vi.fn(async () => ({ remove })),
    getSafeArea: vi.fn(),
    getKeyboardState: vi.fn(() => new Promise<NativeKeyboardState>(() => {})),
  };
  const dispose = bindAndroidInsets(native, root, store);
  await vi.runAllTimersAsync();
  expect(native.getKeyboardState).toHaveBeenCalledTimes(3);
  expect(diagnostics.at(-1)).toMatchObject({ stage: 'unavailable', attempt: 3 });
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.runAllTimersAsync();
  expect(native.getKeyboardState).toHaveBeenCalledTimes(6);
  dispose();
  expect(remove).toHaveBeenCalledOnce();
});

it('removes a subscription that resolves after its timeout', async () => {
  vi.useFakeTimers();
  const { root, store } = surfaces();
  let resolve: ((handle: { remove(): Promise<void> }) => void) | undefined;
  const remove = vi.fn().mockResolvedValue(undefined);
  const native = {
    addListener: vi.fn(() => new Promise<{ remove(): Promise<void> }>(done => { resolve = done; })),
    getSafeArea: vi.fn(), getKeyboardState: vi.fn(),
  };
  const dispose = bindAndroidInsets(native, root, store);
  await vi.advanceTimersByTimeAsync(2000);
  resolve?.({ remove });
  await Promise.resolve();
  expect(remove).toHaveBeenCalledOnce();
  dispose();
});
