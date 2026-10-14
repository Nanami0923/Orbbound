import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'web' }, registerPlugin: vi.fn() }));
import { applySafeArea, bindAndroidInsets } from '../src/ui/android-insets';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('validates all edges before replacing the last valid CSS insets', () => {
  const properties = new Map<string, string>();
  const root = { style: { setProperty: (key: string, value: string) => properties.set(key, value) } } as unknown as HTMLElement;
  expect(applySafeArea(root, { top: 72, right: 30, bottom: 96, left: 30, ready: true }, 3)).toBe(true);
  expect(properties.get('--safe-area-bottom')).toBe('32px');
  const before = Array.from(properties);
  expect(applySafeArea(root, { top: 0, right: -1, bottom: 0, left: 0 }, 3)).toBe(false);
  expect(applySafeArea(root, { top: 0, right: 0, bottom: 0, left: 0, ready: false }, 3)).toBe(false);
  expect(applySafeArea(root, { top: 0, right: 0, bottom: 0, left: 0 }, 0)).toBe(false);
  expect(Array.from(properties)).toEqual(before);
});

function surfaces() {
  const diagnostics: unknown[] = [];
  const target = new EventTarget();
  target.addEventListener('orbbound-insets-diagnostic', event => diagnostics.push((event as CustomEvent).detail));
  vi.stubGlobal('window', Object.assign(target, { devicePixelRatio: 2 }));
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
  return { root: { style: { setProperty: vi.fn() } } as unknown as HTMLElement, diagnostics, target };
}

it('limits a failing bridge to three attempts and retries on foreground later', async () => {
  vi.useFakeTimers();
  const { root, diagnostics } = surfaces();
  const native = { addListener: vi.fn().mockRejectedValue(new Error('bridge offline')), getSafeArea: vi.fn() };
  const dispose = bindAndroidInsets(native, root);
  await vi.runAllTimersAsync();
  expect(native.addListener).toHaveBeenCalledTimes(3);
  expect(diagnostics).toHaveLength(3);
  expect(root.style.setProperty).not.toHaveBeenCalled();
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.runAllTimersAsync();
  expect(native.addListener).toHaveBeenCalledTimes(6);
  dispose();
  document.dispatchEvent(new Event('visibilitychange'));
  expect(native.addListener).toHaveBeenCalledTimes(6);
});

it('keeps a single subscription when fetching fails and accepts a later valid event', async () => {
  vi.useFakeTimers();
  const { root, diagnostics } = surfaces();
  const remove = vi.fn().mockResolvedValue(undefined);
  let change: ((insets: { top: number; right: number; bottom: number; left: number }) => void) | undefined;
  const native = {
    addListener: vi.fn(async (_name: string, listener: typeof change) => { change = listener; return { remove }; }),
    getSafeArea: vi.fn().mockRejectedValue(new Error('not ready')),
  };
  const dispose = bindAndroidInsets(native, root);
  await vi.runAllTimersAsync();
  expect(native.addListener).toHaveBeenCalledOnce();
  expect(native.getSafeArea).toHaveBeenCalledTimes(3);
  change?.({ top: 40, right: 20, bottom: 60, left: 20 });
  expect(root.style.setProperty).toHaveBeenCalledWith('--safe-area-bottom', '30px');
  expect(diagnostics.at(-1)).toMatchObject({ stage: 'recovered' });
  dispose();
  expect(remove).toHaveBeenCalledOnce();
});

it('removes a listener that resolves after the binding was disposed', async () => {
  const { root } = surfaces();
  let resolve: ((handle: { remove(): Promise<void> }) => void) | undefined;
  const remove = vi.fn().mockResolvedValue(undefined);
  const native = { addListener: vi.fn(() => new Promise<{ remove(): Promise<void> }>(done => { resolve = done; })), getSafeArea: vi.fn() };
  const dispose = bindAndroidInsets(native, root);
  dispose(); resolve?.({ remove });
  await Promise.resolve();
  expect(remove).toHaveBeenCalledOnce();
  expect(native.getSafeArea).not.toHaveBeenCalled();
});
