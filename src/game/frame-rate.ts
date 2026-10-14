export const FRAME_RATES = [30, 60, 90, 120] as const;
export type FrameRate = typeof FRAME_RATES[number];
export type FrameRateSetting = 'auto' | FrameRate;
export type RenderQuality = 1 | 1.5 | 2;
export type RenderQualitySetting = 'auto' | RenderQuality;
export const validFrameRate = (value: unknown): value is FrameRateSetting => value === 'auto' || FRAME_RATES.includes(value as FrameRate);
export const validRenderQuality = (value: unknown): value is RenderQualitySetting => value === 'auto' || [1, 1.5, 2].includes(value as number);

export interface PerformanceCapabilities {
  displayHz?: number;
  refreshRate?: number;
  supportedRefreshRates?: number[];
  powerSave?: boolean;
  thermalStatus?: number | null;
}
export function cleanCapabilities(value: unknown): PerformanceCapabilities {
  if (!value || typeof value !== 'object') return {};
  const record = value as PerformanceCapabilities;
  const hz = record.displayHz ?? record.refreshRate;
  const result: PerformanceCapabilities = {};
  if (typeof hz === 'number' && Number.isFinite(hz) && hz >= 24 && hz <= 500) result.displayHz = hz;
  if (Array.isArray(record.supportedRefreshRates)) result.supportedRefreshRates = record.supportedRefreshRates.filter(hz => typeof hz === 'number' && Number.isFinite(hz) && hz >= 24 && hz <= 500);
  if (typeof record.powerSave === 'boolean') result.powerSave = record.powerSave;
  if (record.thermalStatus === null || (typeof record.thermalStatus === 'number' && Number.isInteger(record.thermalStatus) && record.thermalStatus >= 0 && record.thermalStatus <= 6)) result.thermalStatus = record.thermalStatus;
  return result;
}

export const percentile = (values: number[], fraction: number): number => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
};

/** Keeps scheduling remainder, but passes elapsed wall time exactly once to simulation. */
export class FrameBudget {
  private previousRaf: number | null = null;
  private previousStep: number | null = null;
  private remainder = 0;
  private immediate = true;
  public wake(): void { this.immediate = true; }
  public reset(): void { this.previousRaf = null; this.previousStep = null; this.remainder = 0; this.immediate = true; }
  public next(time: number, rate: number): number | null {
    if (!Number.isFinite(time)) return null;
    if (this.previousRaf === null || this.previousStep === null || time < this.previousRaf) {
      this.previousRaf = time; this.previousStep = time; this.remainder = 0; this.immediate = false;
      return 0;
    }
    if (time - this.previousRaf > 1000) {
      // A visible long task still consumes decision time. Explicit pause/resume resets do not.
      const delta = time - this.previousStep;
      this.previousRaf = time; this.previousStep = time; this.remainder = 0; this.immediate = false;
      return delta;
    }
    this.remainder += Math.max(0, time - this.previousRaf);
    this.previousRaf = time;
    const interval = 1000 / Math.max(1, rate);
    if (!this.immediate && this.remainder + 0.001 < interval) return null;
    // Modulo prevents a long stall from producing a burst of catch-up renders.
    this.remainder = this.immediate ? 0 : Math.max(0, this.remainder - Math.max(1, Math.floor((this.remainder + 0.001) / interval)) * interval);
    const delta = Math.max(0, time - this.previousStep);
    this.previousStep = time; this.immediate = false;
    return delta;
  }
}

/** Automatic maximum, display/energy caps and measured sustained-load hysteresis. */
export class FrameRateGovernor {
  public requested: FrameRateSetting = 'auto';
  public target: FrameRate = 120;
  public capabilities: PerformanceCapabilities = {};
  public observedHz: number | null = null;
  private badWindows = 0;
  private goodWindows = 0;
  private recoveryWindows = 0;
  public setRequested(value: FrameRateSetting): void { this.requested = value; this.recoveryWindows = 0; this.reconcile(true); }
  public setCapabilities(value: unknown): void { this.capabilities = { ...this.capabilities, ...cleanCapabilities(value) }; this.reconcile(); }
  public get displayHz(): number { return Math.min(this.capabilities.displayHz ?? 500, this.observedHz ?? this.capabilities.displayHz ?? 120); }
  public get ceiling(): FrameRate {
    let cap = Math.min(this.requested === 'auto' ? 120 : this.requested, this.displayHz * 1.04);
    if (this.capabilities.powerSave || (this.capabilities.thermalStatus ?? 0) >= 3) cap = Math.min(cap, 30);
    else if ((this.capabilities.thermalStatus ?? 0) >= 2) cap = Math.min(cap, 60);
    return [...FRAME_RATES].reverse().find(rate => rate <= cap) ?? 30;
  }
  public get reason(): string {
    if (this.capabilities.powerSave) return '省电模式';
    if ((this.capabilities.thermalStatus ?? 0) >= 3) return '温度保护';
    if ((this.capabilities.thermalStatus ?? 0) >= 2) return '温度较高';
    if (this.target < this.ceiling) return '负载自适应';
    if (this.ceiling < (this.requested === 'auto' ? 120 : this.requested)) return '屏幕或回调上限';
    return this.requested === 'auto' ? '自动' : '手动上限';
  }
  private reconcile(reset = false): void {
    if (reset || this.target > this.ceiling) { this.target = this.ceiling; this.badWindows = 0; this.goodWindows = 0; }
  }
  public observeDisplay(intervals: number[]): void {
    if (intervals.length < 20) return;
    const ms = percentile(intervals.filter(ms => ms > 1 && ms < 100), 0.25);
    if (!ms) return;
    const hz = 1000 / ms;
    const known = [30, 60, 90, 120, 144, 165, 240, 360];
    const nearest = known.reduce((a, b) => Math.abs(b - hz) < Math.abs(a - hz) ? b : a);
    this.observedHz = Math.abs(nearest - hz) / nearest < 0.08 ? nearest : hz;
    this.reconcile();
  }
  public assess(costP95: number, updateFps: number, idle: boolean): void {
    this.reconcile();
    if (idle || !Number.isFinite(costP95) || updateFps <= 0) { this.badWindows = 0; this.goodWindows = 0; return; }
    const overBudget = costP95 > 1000 / this.target * 0.85 || updateFps < this.target * 0.8;
    this.badWindows = overBudget ? this.badWindows + 1 : 0;
    if (this.badWindows >= 2 && this.target > 30) {
      this.target = FRAME_RATES[FRAME_RATES.indexOf(this.target) - 1];
      this.badWindows = 0; this.goodWindows = 0; this.recoveryWindows = 8;
      return;
    }
    if (this.recoveryWindows > 0) { this.recoveryWindows--; return; }
    const next = FRAME_RATES[FRAME_RATES.indexOf(this.target) + 1];
    const headroom = next && next <= this.ceiling && costP95 < 1000 / next * 0.6 && updateFps >= this.target * 0.9;
    this.goodWindows = headroom ? this.goodWindows + 1 : 0;
    if (this.goodWindows >= 6 && next) { this.target = next; this.goodWindows = 0; }
  }
}

export function chooseQuality(setting: RenderQualitySetting, cssWidth: number, devicePixelRatio: number, constrained = false): RenderQuality {
  if (setting !== 'auto') return setting;
  const needed = Math.max(1, cssWidth * Math.min(3, Math.max(1, devicePixelRatio)) / 640);
  const quality = needed <= 1.15 ? 1 : needed <= 1.65 ? 1.5 : 2;
  return constrained ? Math.min(quality, 1.5) as RenderQuality : quality;
}
