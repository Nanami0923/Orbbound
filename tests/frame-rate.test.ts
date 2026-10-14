import { afterEach, describe, expect, it, vi } from 'vitest';
import { FrameBudget, FrameRateGovernor, chooseQuality, cleanCapabilities } from '../src/game/frame-rate';
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

it('caps to the current display and explicit setting, and immediately honors energy/thermal constraints', () => {
  const governor = new FrameRateGovernor(); governor.setCapabilities({displayHz:90,supportedRefreshRates:[60,90,120]});
  expect(governor.target).toBe(90);
  governor.setRequested(60); expect(governor.target).toBe(60);
  governor.setRequested('auto'); expect(governor.target).toBe(90);
  governor.setCapabilities({powerSave:true}); expect(governor.target).toBe(30);
  governor.setCapabilities({powerSave:false,thermalStatus:2}); governor.setRequested('auto'); expect(governor.target).toBe(60);
  governor.setCapabilities({thermalStatus:3}); expect(governor.target).toBe(30);
});

it('requires sustained bad windows to drop and sustained headroom plus recovery cooldown to rise', () => {
  const governor = new FrameRateGovernor();
  governor.assess(10, 120, false); expect(governor.target).toBe(120);
  governor.assess(10, 120, false); expect(governor.target).toBe(90);
  for (let i = 0; i < 13; i++) governor.assess(1, 90, false);
  expect(governor.target).toBe(90); governor.assess(1, 90, false); expect(governor.target).toBe(120);
  for (let i = 0; i < 10; i++) governor.assess(100, 10, true);
  expect(governor.target).toBe(120);
});

it('detects the actual RAF ceiling independently from native supported modes', () => {
  const governor = new FrameRateGovernor(); governor.setCapabilities({displayHz:120,supportedRefreshRates:[60,120]});
  governor.observeDisplay(Array(80).fill(1000 / 60)); expect(governor.target).toBe(60);
  governor.observeDisplay(Array(80).fill(1000 / 144)); expect(governor.ceiling).toBe(120);
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
  expect(loadSettings()).toMatchObject({frameRate:'auto',quality:'auto',reducedMotion:false,showPerformance:false});
});
