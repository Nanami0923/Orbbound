import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameBudget, FrameRateGovernor, chooseQuality, cleanCapabilities, normalizeFrameRate, validFrameRate } from '../src/game/frame-rate';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../src/storage/storage';

afterEach(() => vi.unstubAllGlobals());

describe('render budgeting with scheduling remainder', () => {
  it.each([144, 165, 240])('renders 120 updates per second on %iHz without losing simulation time', hz => {
    const budget = new FrameBudget();
    let frames = 0, elapsed = 0;
    for (let i = 0; i <= hz * 10; i++) {
      const delta = budget.next(i * 1000 / hz, 120);
      if (delta !== null) { frames++; elapsed += delta; }
    }
    expect(frames).toBeGreaterThanOrEqual(1200); expect(frames).toBeLessThanOrEqual(1201);
    expect(elapsed).toBeCloseTo(10_000, 4);
  });
  it.each([30, 60, 90, 120])('maintains %i cap and one-time elapsed deltas', rate => {
    const budget = new FrameBudget(); let count = 0, total = 0;
    for (let i = 0; i <= 2400; i++) { const delta = budget.next(i * 1000 / 240, rate); if (delta !== null) { count++; total += delta; } }
    expect(count).toBe(rate * 10 + 1); expect(total).toBeCloseTo(10_000);
  });
  it('wakes a static board on the next callback and never catches up a burst after interruption', () => {
    const budget = new FrameBudget(); budget.next(0, 10);
    expect(budget.next(8, 10)).toBeNull(); budget.wake(); expect(budget.next(16, 120)).toBe(16);
    expect(budget.next(5000, 120)).toBe(4984); expect(budget.next(5001, 120)).toBeNull();
    budget.reset(); expect(budget.next(8000, 120)).toBe(0);
  });
});

it('sanitizes optional native capabilities instead of claiming unsupported refresh rates', () => {
  expect(cleanCapabilities({ refreshRate: 144, supportedRefreshRates: [60, 144, '240', -1], powerSave: true, thermalStatus: 3 })).toEqual({displayHz:144,supportedRefreshRates:[60,144],powerSave:true,thermalStatus:3});
  expect(cleanCapabilities({ displayHz: Infinity, thermalStatus: -1, powerSave: 'true' })).toEqual({});
});

it('starts at 60 and caps only to a known native display without rewriting the requested rate', () => {
  const governor = new FrameRateGovernor();
  expect(governor.requested).toBe(60); expect(governor.target).toBe(60); expect(governor.displayHz).toBeNull();
  governor.setRequested(120); governor.setCapabilities({displayHz:90,supportedRefreshRates:[60,90,120]});
  expect(governor.target).toBe(90); expect(governor.requested).toBe(120);
  governor.setCapabilities({displayHz:50}); expect(governor.target).toBe(50);
  governor.setCapabilities({displayHz:144}); expect(governor.target).toBe(120);
  governor.setCapabilities({powerSave:true,thermalStatus:3}); expect(governor.target).toBe(120);
  governor.setRequested(60); expect(governor.target).toBe(60);
});

it('never changes a fixed cap in response to sustained load or recovery headroom', () => {
  const governor = new FrameRateGovernor();
  for (const rate of [30,60,90,120] as const) {
    governor.setRequested(rate);
    for (let i = 0; i < 30; i++) governor.assess(100, 10, false);
    expect(governor.target).toBe(rate);
    for (let i = 0; i < 30; i++) governor.assess(1, rate, false);
    expect(governor.target).toBe(rate);
  }
});

it('records RAF observations without treating slow callbacks or an unknown fallback as a hardware ceiling', () => {
  const governor = new FrameRateGovernor(); governor.setRequested(120);
  governor.setCapabilities({displayHz:120,supportedRefreshRates:[60,120]});
  governor.observeDisplay(Array(80).fill(1000 / 30));
  expect(governor.observedHz).toBe(30); expect(governor.target).toBe(120);
  governor.setCapabilities({refreshRate:60,refreshRateKnown:false});
  expect(governor.displayHz).toBeNull(); expect(governor.ceiling).toBe(120);
  governor.setCapabilities({displayHz:90});
  expect(governor.target).toBe(90); expect(governor.capabilities.refreshRateKnown).toBe(true);
});

it.each([30,60,90,120])('preserves a legitimate fixed preference %i', rate => {
  expect(validFrameRate(rate)).toBe(true); expect(normalizeFrameRate(rate)).toBe(rate);
});
it.each(['auto',undefined,null,0,240,'120',NaN,Infinity,{},[]])('recovers legacy or invalid local preference %j to 60', value => {
  expect(validFrameRate(value)).toBe(false); expect(normalizeFrameRate(value)).toBe(60);
});

it('chooses backing pixels by visible width and preserves explicit quality', () => {
  expect(chooseQuality('auto',320,2)).toBe(1);
  expect(chooseQuality('auto',480,2)).toBe(1.5);
  expect(chooseQuality('auto',640,2)).toBe(2);
  expect(chooseQuality('auto',640,2,true)).toBe(1.5);
  expect(chooseQuality(2,320,1,true)).toBe(2);
});

it('round trips valid performance settings and defaults corrupted settings safely', () => {
  let value = '';
  vi.stubGlobal('window',{localStorage:{getItem:()=>value || null,setItem:(_key:string, next:string)=>{value=next;}}});
  saveSettings({...DEFAULT_SETTINGS,frameRate:90,quality:1.5,reducedMotion:true,showPerformance:true});
  expect(loadSettings()).toMatchObject({frameRate:90,quality:1.5,reducedMotion:true,showPerformance:true});
  value=JSON.stringify({frameRate:240,quality:4,reducedMotion:'true',showPerformance:1});
  expect(loadSettings()).toMatchObject({frameRate:60,quality:'auto',reducedMotion:false,showPerformance:false});
});

it.each(['auto',undefined,null,240,'120'])('migrates local frameRate %j without resetting other valid preferences', frameRate => {
  const raw = JSON.stringify({frameRate,musicVolume:17,quality:1.5,immersiveMode:true});
  vi.stubGlobal('window',{localStorage:{getItem:()=>raw}});
  expect(loadSettings()).toMatchObject({frameRate:60,musicVolume:17,quality:1.5,immersiveMode:true});
});

it.each([30,60,90,120] as const)('loads an existing fixed rate %i unchanged', frameRate => {
  vi.stubGlobal('window',{localStorage:{getItem:()=>JSON.stringify({frameRate})}});
  expect(loadSettings().frameRate).toBe(frameRate);
});

it('serializes normalized frame rates without mutating the caller or changing auto quality', () => {
  let raw = '';
  vi.stubGlobal('window',{localStorage:{setItem:(_key:string,value:string)=>{raw=value;}}});
  const settings = {...DEFAULT_SETTINGS,frameRate:'auto' as never}; saveSettings(settings);
  expect(JSON.parse(raw)).toMatchObject({frameRate:60,quality:'auto'});
  expect(settings.frameRate).toBe('auto');
});
