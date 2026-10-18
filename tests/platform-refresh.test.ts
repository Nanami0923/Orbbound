import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/storage/storage';

const native = vi.hoisted(() => ({ requestRefreshRate: vi.fn(), getDisplayInfo: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' }, registerPlugin: () => native }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });

it('coalesces native refresh requests and ignores an unchanged rate during audio previews', async () => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: { getItem: () => null } }));
  const complete: Array<() => void> = [];
  native.requestRefreshRate.mockImplementation(({ refreshRate }: { refreshRate: number }) => new Promise(resolve => complete.push(() => resolve({ refreshRate }))));
  const { refreshPlatformPerformance } = await import('../src/ui/platform-services');
  const first = refreshPlatformPerformance({ ...DEFAULT_SETTINGS, frameRate: 60 });
  const second = refreshPlatformPerformance({ ...DEFAULT_SETTINGS, frameRate: 120 });
  const latest = refreshPlatformPerformance({ ...DEFAULT_SETTINGS, frameRate: 30 });
  expect(native.requestRefreshRate).toHaveBeenCalledTimes(1);
  complete[0](); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(native.requestRefreshRate).toHaveBeenLastCalledWith({ refreshRate: 30 });
  complete[1](); await Promise.all([first, second, latest]);
  for (let volume = 0; volume <= 100; volume++) await refreshPlatformPerformance({ ...DEFAULT_SETTINGS, frameRate: 30, volume });
  expect(native.requestRefreshRate).toHaveBeenCalledTimes(2);
});
