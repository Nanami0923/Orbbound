import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Settings } from '../storage/storage';

export interface DisplayInfo {
  refreshRate: number;
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
export function applyDisplayInfo(info: DisplayInfo): void {
  lastDisplayInfo = info;
  if (typeof window === 'undefined') return;
  const detail = {
    displayHz:Number.isFinite(info.refreshRate) ? info.refreshRate : undefined,
    supportedRefreshRates:info.supportedRefreshRates,
    powerSave:info.powerSave === true,
    thermalStatus:typeof info.thermalStatus === 'number' ? info.thermalStatus : undefined,
    supportsHaptics:getHapticsCapability(),
  };
  (window as unknown as {__orbboundPerformanceCapabilities:unknown}).__orbboundPerformanceCapabilities = detail;
  window.dispatchEvent(new CustomEvent('orbbound-performance-capabilities', {detail}));
}
export function replayDisplayInfo():void { if (lastDisplayInfo) applyDisplayInfo(lastDisplayInfo); }
if (typeof window !== 'undefined') window.addEventListener('orbbound-performance-request', replayDisplayInfo);
export async function refreshPlatformPerformance(settings:Settings): Promise<void> {
  if (!isAndroid()) return;
  try {
    const refreshRate = settings.frameRate === 'auto' ? 120 : settings.frameRate;
    applyDisplayInfo(await native.requestRefreshRate({refreshRate}));
  } catch {
    try { applyDisplayInfo(await native.getDisplayInfo()); } catch { /* RAF sampling remains available. */ }
  }
}
export function bindAndroidServices(settings:()=>Settings): void {
  if (!isAndroid()) return;
  void native.addListener('displayInfoChanged', applyDisplayInfo).catch(() => {});
  void refreshPlatformPerformance(settings());
  window.addEventListener('orbbound-host-foreground', () => { void refreshPlatformPerformance(settings()); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshPlatformPerformance(settings()); });
}
export const exportAndroidBackup = (text:string) => native.exportBackup({text,fileName:`Orbbound-${new Date().toISOString().slice(0,10)}.json`});
export const importAndroidBackup = () => native.importBackup();
