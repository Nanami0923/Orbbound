import Phaser from 'phaser';
import { GAME_HEIGHT, GAME_WIDTH } from '../content/game-config';
import { loadSettings, type Settings } from '../storage/storage';
import { PHASER_CONFIG, type PlayScene } from './PlayScene';
import { chooseQuality, FrameBudget, FrameRateGovernor, percentile, type RenderQuality } from './frame-rate';

export interface PerformanceReport {
  requested: Settings['frameRate'];
  targetFps: number;
  updateFps: number;
  renderFps: number;
  displayHz: number | null;
  observedRafHz: number | null;
  quality: RenderQuality;
  idle: boolean;
  frameP95Ms: number;
  workP95Ms: number;
  reason: string;
}

/** Installed before Phaser binds Game.step: limit=0 uses RAF, this budget selects real renders. */
export function installPerformanceRuntime(game: Phaser.Game): void {
  const budget = new FrameBudget(), governor = new FrameRateGovernor();
  const abort = new AbortController();
  let settings = loadSettings(), quality: RenderQuality = 2, lastActivity = performance.now();
  let rafPrevious = 0, reportStarted = performance.now(), updates = 0, renders = 0, activeFrames = 0;
  let rawIntervals: number[] = [], frameIntervals: number[] = [], costs: number[] = [], previousUpdate = 0;
  let lastIdle = false, resizeTimer = 0;
  governor.setRequested(settings.frameRate);
  const scene = () => game.scene.getScene('PlayScene') as PlayScene | undefined;
  // Wake a sleeping READY budget once; continuous pointer events must still honor the active cap.
  const wake = () => { lastActivity = performance.now(); if (lastIdle) budget.wake(); };
  const applyQuality = () => {
    const cssWidth = document.querySelector('#game-container')?.getBoundingClientRect().width || GAME_WIDTH;
    const constrained = governor.capabilities.powerSave === true || (governor.capabilities.thermalStatus ?? 0) >= 2;
    const next = chooseQuality(settings.quality, cssWidth, window.devicePixelRatio || 1, constrained);
    if (next === quality) return;
    quality = next;
    game.scale.setGameSize(GAME_WIDTH * quality, GAME_HEIGHT * quality);
    for (const item of game.scene.getScenes(false)) {
      const camera = item.cameras.main;
      camera.setZoom(quality).centerOn(GAME_WIDTH / 2, GAME_HEIGHT / 2);
      // Native pointer events can arrive before the next render; publish the new inverse transform now.
      camera.preRender();
    }
    (game as unknown as { orbboundQuality?: number }).orbboundQuality = quality;
    budget.wake();
  };
  (game as unknown as { orbboundQuality?: number }).orbboundQuality = quality;
  const updateSettings = (event: Event) => {
    settings = (event as CustomEvent<Settings>).detail;
    governor.setRequested(settings.frameRate); applyQuality(); wake();
  };
  window.addEventListener('snood-performance-settings', updateSettings, { signal: abort.signal });
  window.addEventListener('orbbound-performance-capabilities', event => {
    governor.setCapabilities((event as CustomEvent).detail); applyQuality(); wake();
  }, { signal: abort.signal });
  window.addEventListener('snood-performance-active', wake, { signal: abort.signal });
  window.addEventListener('snood-round-start', () => { reset(); wake(); }, { signal: abort.signal });
  window.addEventListener('snood-performance-reset', () => { reset(); wake(); }, { signal: abort.signal });
  for (const name of ['pointerdown', 'pointermove', 'keydown'] as const) window.addEventListener(name, wake, { passive: true, signal: abort.signal });
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(applyQuality, 120); wake(); }, { signal: abort.signal });
  const reset = () => {
    budget.reset(); rafPrevious = 0; previousUpdate = 0;
    reportStarted = performance.now(); updates = 0; renders = 0; activeFrames = 0;
    rawIntervals = []; frameIntervals = []; costs = [];
  };
  document.addEventListener('visibilitychange', reset, { signal: abort.signal });
  game.events.on('resume', reset);
  game.events.on('prestep', () => { updates++; });
  game.events.on('postrender', () => { renders++; });
  const originalStep = game.step.bind(game);
  game.step = (time: number, _phaserDelta: number) => {
    if (rafPrevious && time - rafPrevious > 0 && time - rafPrevious < 250) rawIntervals.push(time - rafPrevious);
    rafPrevious = time;
    const current = scene();
    const idle = !!current?.ready && current.performanceIdle && performance.now() - lastActivity >= 650;
    if (idle !== lastIdle) { lastIdle = idle; budget.wake(); }
    const delta = budget.next(time, idle ? 10 : governor.target);
    if (delta !== null) {
      if (previousUpdate) frameIntervals.push(time - previousUpdate);
      previousUpdate = time;
      const started = performance.now();
      originalStep(time, delta);
      costs.push(performance.now() - started);
      if (!idle) activeFrames++;
    }
    if (time - reportStarted < 1000) return;
    const seconds = (time - reportStarted) / 1000;
    governor.observeDisplay(rawIntervals);
    governor.assess(percentile(costs, 0.95), updates / seconds, activeFrames < updates * 0.8);
    applyQuality();
    const report: PerformanceReport = { requested: governor.requested, targetFps: governor.target,
      updateFps: Math.round(updates / seconds), renderFps: Math.round(renders / seconds), displayHz: governor.displayHz,
      observedRafHz: governor.observedHz,
      quality, idle, frameP95Ms: Math.round(percentile(frameIntervals, 0.95) * 10) / 10,
      workP95Ms: Math.round(percentile(costs, 0.95) * 10) / 10, reason: idle ? '静止省电' : governor.reason };
    window.dispatchEvent(new CustomEvent('snood-performance', { detail: report }));
    reportStarted = time; updates = 0; renders = 0; activeFrames = 0;
    rawIntervals = []; frameIntervals = []; costs = [];
  };
  applyQuality();
  const cached = (window as unknown as { __orbboundPerformanceCapabilities?: unknown }).__orbboundPerformanceCapabilities;
  if (cached) { governor.setCapabilities(cached); applyQuality(); }
  window.dispatchEvent(new Event('orbbound-performance-request'));
  game.events.once('destroy', () => { abort.abort(); clearTimeout(resizeTimer); game.events.off('resume', reset); });
}

export function createGame(): Phaser.Game {
  return new Phaser.Game({ ...PHASER_CONFIG, callbacks: { postBoot: installPerformanceRuntime } });
}
