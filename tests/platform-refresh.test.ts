import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/storage/storage';

const native = vi.hoisted(() => ({ requestRefreshRate: vi.fn(), getDisplayInfo: vi.fn(), addListener:vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => 'android' }, registerPlugin: () => native }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });

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

it('requests default 60 at startup and reapplies it after foreground restoration',async()=>{
 const target=Object.assign(new EventTarget(),{localStorage:{getItem:()=>null}});
 vi.stubGlobal('window',target);vi.stubGlobal('document',Object.assign(new EventTarget(),{hidden:false}));
 native.addListener.mockResolvedValue({remove:vi.fn()});native.requestRefreshRate.mockResolvedValue({refreshRate:60});
 const {bindAndroidServices,refreshPlatformPerformance}=await import('../src/ui/platform-services');
 bindAndroidServices(()=>({...DEFAULT_SETTINGS}));await refreshPlatformPerformance(DEFAULT_SETTINGS);
 expect(native.requestRefreshRate).toHaveBeenCalledWith({refreshRate:60});
 target.dispatchEvent(new Event('orbbound-host-foreground'));await refreshPlatformPerformance(DEFAULT_SETTINGS);
 expect(native.requestRefreshRate).toHaveBeenCalledTimes(2);expect(native.requestRefreshRate).toHaveBeenLastCalledWith({refreshRate:60});
});

it('never turns an escaped legacy auto preference into a 120Hz native request',async()=>{
 vi.stubGlobal('window',new EventTarget());native.requestRefreshRate.mockResolvedValue({refreshRate:60});
 const {refreshPlatformPerformance}=await import('../src/ui/platform-services');
 await refreshPlatformPerformance({...DEFAULT_SETTINGS,frameRate:'auto' as never});
 expect(native.requestRefreshRate).toHaveBeenCalledExactlyOnceWith({refreshRate:60});
});

it('marks an unconfirmed native 60Hz fallback as unknown',async()=>{
 const target=Object.assign(new EventTarget(),{__orbboundPerformanceCapabilities:undefined as unknown});vi.stubGlobal('window',target);
 const {applyDisplayInfo}=await import('../src/ui/platform-services');
 applyDisplayInfo({refreshRate:60,refreshRateKnown:false});
 expect(target.__orbboundPerformanceCapabilities).toMatchObject({displayHz:undefined,refreshRateKnown:false});
});

it('bounds both refresh-rate and fallback queries when the native bridge never responds',async()=>{
 vi.useFakeTimers();vi.stubGlobal('window',new EventTarget());
 native.requestRefreshRate.mockImplementation(()=>new Promise(()=>{}));native.getDisplayInfo.mockImplementation(()=>new Promise(()=>{}));
 const {refreshPlatformPerformance}=await import('../src/ui/platform-services');
 const request=refreshPlatformPerformance(DEFAULT_SETTINGS);await vi.advanceTimersByTimeAsync(5001);
 await expect(request).resolves.toBeUndefined();expect(native.getDisplayInfo).toHaveBeenCalledOnce();
});
