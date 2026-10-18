export const FRAME_RATES = [30, 60, 90, 120] as const;
export type FrameRate = typeof FRAME_RATES[number];
export type FrameRateSetting = FrameRate;
export type RenderQuality = 1 | 1.5 | 2;
export type RenderQualitySetting = 'auto' | RenderQuality;
export const validFrameRate = (value: unknown): value is FrameRateSetting => FRAME_RATES.includes(value as FrameRate);
/** Local legacy/corrupt preferences recover safely; backup validation remains strict. */
export const normalizeFrameRate = (value: unknown): FrameRate => validFrameRate(value) ? value : 60;
export const validRenderQuality = (value: unknown): value is RenderQualitySetting => value === 'auto' || [1, 1.5, 2].includes(value as number);

export interface PerformanceCapabilities {
  displayHz?: number;
  refreshRate?: number;
  refreshRateKnown?: boolean;
  supportedRefreshRates?: number[];
  powerSave?: boolean;
  thermalStatus?: number | null;
}
export function cleanCapabilities(value: unknown): PerformanceCapabilities {
  if (!value || typeof value !== 'object') return {};
  const record = value as PerformanceCapabilities;
  const hz = record.displayHz ?? record.refreshRate;
  const result: PerformanceCapabilities = {};
  if (typeof record.refreshRateKnown === 'boolean') result.refreshRateKnown = record.refreshRateKnown;
  if (record.refreshRateKnown !== false && typeof hz === 'number' && Number.isFinite(hz) && hz >= 24 && hz <= 500) result.displayHz = hz;
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

/** Fixed user cap, limited only by a known native display rate. RAF estimates are diagnostic. */
export class FrameRateGovernor {
  public requested: FrameRateSetting = 60;
  public capabilities: PerformanceCapabilities = {};
  public observedHz: number | null = null;
  public setRequested(value: FrameRateSetting): void { this.requested = normalizeFrameRate(value); }
  public setCapabilities(value: unknown): void {
    const next = cleanCapabilities(value);
    this.capabilities = { ...this.capabilities, ...next };
    if (next.refreshRateKnown === false) delete this.capabilities.displayHz;
    else if (next.displayHz !== undefined) this.capabilities.refreshRateKnown = true;
  }
  public get displayHz(): number | null { return this.capabilities.displayHz ?? null; }
  public get ceiling(): number { return Math.min(this.requested, this.displayHz ?? this.requested); }
  public get target(): number { return this.ceiling; }
  public get reason(): string {
    if (this.target < this.requested) return '原生显示上限';
    if (this.capabilities.powerSave) return '系统省电模式';
    if ((this.capabilities.thermalStatus ?? 0) >= 3) return '系统温度较高';
    if ((this.capabilities.thermalStatus ?? 0) >= 2) return '温度较高';
    return '手动上限';
  }
  public observeDisplay(intervals: number[]): void {
    if (intervals.length < 20) return;
    const ms = percentile(intervals.filter(ms => ms > 1 && ms < 100), 0.25);
    if (!ms) return;
    const hz = 1000 / ms;
    const known = [30, 60, 90, 120, 144, 165, 240, 360];
    const nearest = known.reduce((a, b) => Math.abs(b - hz) < Math.abs(a - hz) ? b : a);
    this.observedHz = Math.abs(nearest - hz) / nearest < 0.08 ? nearest : hz;
  }
  /** Kept for existing render adapters; measured load never changes the user's fixed cap. */
  public assess(_costP95: number, _updateFps: number, _idle: boolean): void {}
}

export function chooseQuality(setting: RenderQualitySetting, cssWidth: number, devicePixelRatio: number, constrained = false): RenderQuality {
  if (setting !== 'auto') return setting;
  const needed = Math.max(1, cssWidth * Math.min(3, Math.max(1, devicePixelRatio)) / 640);
  const quality = needed <= 1.15 ? 1 : needed <= 1.65 ? 1.5 : 2;
  return constrained ? Math.min(quality, 1.5) as RenderQuality : quality;
}
