import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Settings } from '../storage/storage';
import { normalizeFrameRate } from '../game/frame-rate';

export interface DisplayInfo {
  refreshRate: number;
  refreshRateKnown?: boolean;
  supportedRefreshRates?: number[];
  powerSave?: boolean;
  thermalStatus?: number | null;
  supportsHaptics?: boolean;
}
interface NativeServices {
  getDisplayInfo(): Promise<DisplayInfo>;
  requestRefreshRate(options:{refreshRate:number}): Promise<DisplayInfo>;
  exportBackup(options:{text:string;fileName:string}): Promise<{cancelled:boolean}>;
  importBackup(): Promise<{cancelled:boolean;text?:string}>;
  addListener(name:'displayInfoChanged', listener:(info:DisplayInfo)=>void): Promise<PluginListenerHandle>;
}
const native = registerPlugin<NativeServices>('GameFeedback');
let lastDisplayInfo:DisplayInfo | undefined;
export const isAndroid = () => Capacitor.getPlatform() === 'android';
/** Only native device information can establish whether a vibration motor is available. */
export function getHapticsCapability(): boolean | undefined {
  return isAndroid() && typeof lastDisplayInfo?.supportsHaptics === 'boolean' ? lastDisplayInfo.supportsHaptics : undefined;
}
export function applyDisplayInfo(info: DisplayInfo, force = false): void {
  if (!force && lastDisplayInfo && JSON.stringify(lastDisplayInfo) === JSON.stringify(info)) return;
  lastDisplayInfo = info;
  if (typeof window === 'undefined') return;
  const detail = {
    displayHz:info.refreshRateKnown !== false && Number.isFinite(info.refreshRate) ? info.refreshRate : undefined,
    refreshRateKnown:info.refreshRateKnown !== false && Number.isFinite(info.refreshRate) && info.refreshRate >= 24 && info.refreshRate <= 500,
    supportedRefreshRates:info.supportedRefreshRates,
    powerSave:info.powerSave === true,
    thermalStatus:typeof info.thermalStatus === 'number' ? info.thermalStatus : undefined,
    supportsHaptics:getHapticsCapability(),
  };
  (window as unknown as {__orbboundPerformanceCapabilities:unknown}).__orbboundPerformanceCapabilities = detail;
  window.dispatchEvent(new CustomEvent('orbbound-performance-capabilities', {detail}));
}
export function replayDisplayInfo():void { if (lastDisplayInfo) applyDisplayInfo(lastDisplayInfo, true); }
if (typeof window !== 'undefined') window.addEventListener('orbbound-performance-request', replayDisplayInfo);
let desiredRefreshRate = 0, appliedRefreshRate = 0;
let refreshInFlight: Promise<void> | undefined;
function boundedDisplayRequest(request: Promise<DisplayInfo>): Promise<DisplayInfo> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('显示能力查询超时')), 2500);
    request.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
export function refreshPlatformPerformance(settings:Settings, force = false): Promise<void> {
  if (!isAndroid()) return Promise.resolve();
  desiredRefreshRate = normalizeFrameRate(settings.frameRate);
  if (force) appliedRefreshRate = 0;
  if (refreshInFlight) return refreshInFlight;
  if (appliedRefreshRate === desiredRefreshRate) return Promise.resolve();
  refreshInFlight = (async () => {
    while (appliedRefreshRate !== desiredRefreshRate) {
      const refreshRate = desiredRefreshRate;
      try { applyDisplayInfo(await boundedDisplayRequest(native.requestRefreshRate({refreshRate}))); }
      catch { try { applyDisplayInfo(await boundedDisplayRequest(native.getDisplayInfo())); } catch { /* RAF sampling remains available. */ } }
      appliedRefreshRate = refreshRate;
    }
  })().finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}
export function bindAndroidServices(settings:()=>Settings): void {
  if (!isAndroid()) return;
  void native.addListener('displayInfoChanged', applyDisplayInfo).catch(() => {});
  void refreshPlatformPerformance(settings());
  window.addEventListener('orbbound-host-foreground', () => { void refreshPlatformPerformance(settings(), true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshPlatformPerformance(settings(), true); });
}
export const exportAndroidBackup = (text:string) => native.exportBackup({text,fileName:`Orbbound-${new Date().toISOString().slice(0,10)}.json`});
export const importAndroidBackup = () => native.importBackup();
