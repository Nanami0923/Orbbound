import { afterEach, expect, it, vi } from 'vitest';
const shotFeedback = vi.hoisted(() => ({ events: [] as import('../src/core/types').GameEvent[] }));
vi.mock('phaser', () => ({ default: { Scene: class {}, AUTO: 0, Scale: { FIT: 0, CENTER_BOTH: 0 } } }));
vi.mock('../src/game/input-mode', () => ({ usesButtonControls: () => true }));
vi.mock('../src/core/engine', async original => {
  const module = await original<typeof import('../src/core/engine')>();
  return { ...module, resolveShot: (state: GameState) => ({ state: { ...state, currentColor: state.nextColor, nextColor: 2, step: state.step + 1 }, events: shotFeedback.events }) };
});
vi.mock('../src/core/physics', async original => {
  const module = await original<typeof import('../src/core/physics')>();
  return { ...module, traceShot: () => ({ points: [{ x: 320, y: 680 }, { x: 320, y: 200 }], landing: { row: 1, col: 1 }, bounced: false, reason: 'bubble' }) };
});
import { PlayScene } from '../src/game/PlayScene';
import { createRound } from '../src/core/modes';
import { createCampaign } from '../src/core/campaign';
import { DEFAULT_SETTINGS } from '../src/storage/storage';
import { BOARD_APPEARANCE, boardGeometry } from '../src/render/board-appearance';
import { cellToPoint } from '../src/core/grid';
import { V5_CLEAR_MOTION } from '../src/render/clear-motion';
import type { GameState, Point } from '../src/core/types';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture(mode: 'endless' | 'timed' | 'campaign') {
  shotFeedback.events = [];
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const events: Array<{ type: string; detail: { nextColor: number; previewNextColor: number; phase: string } }> = [], values = new Map<string, string>();
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), dispatchEvent: (event: CustomEvent) => { events.push(event); return true; }, localStorage: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
  } });
  const scene = new PlayScene(), tweens: Array<{ targets?: unknown; onComplete?: () => void; onUpdate?: () => void; duration?: number; delay?: number }> = [], callbacks: Array<() => void> = [], delays: number[] = [];
  const graphics = { clear: vi.fn().mockReturnThis(), fillStyle: vi.fn().mockReturnThis(), lineStyle: vi.fn().mockReturnThis(), fillCircle: vi.fn().mockReturnThis(), strokeCircle: vi.fn().mockReturnThis() };
  const createOrb = vi.fn((_color: number, point: Point) => {
    const data = new Map<string, unknown>();
    const orb: Record<string, any> = { x: point.x, y: point.y };
    orb.setScale = vi.fn(() => orb); orb.setRotation = vi.fn(() => orb); orb.setVisible = vi.fn(() => orb);
    orb.setPosition = vi.fn((x: number, y: number) => { orb.x = x; orb.y = y; return orb; });
    orb.setAlpha = vi.fn(() => orb); orb.destroy = vi.fn(); orb.add = vi.fn(() => orb);
    orb.setData = vi.fn((key: string, value: unknown) => { data.set(key, value); return orb; });
    orb.getData = vi.fn((key: string) => data.get(key));
    return orb;
  });
  const addedTexts: Array<{ args: unknown[]; object: Record<string, any> }> = [];
  const addedCircles: Array<{ args: unknown[]; object: Record<string, any> }> = [];
  const add = {
    text: vi.fn((...args: unknown[]) => {
      const object: Record<string, any> = {};
      object.setOrigin = vi.fn(() => object); object.setScale = vi.fn(() => object); object.destroy = vi.fn();
      addedTexts.push({ args, object }); return object;
    }),
    circle: vi.fn((...args: unknown[]) => {
      const object: Record<string, any> = {};
      object.setPosition = vi.fn(() => object); object.setScale = vi.fn(() => object); object.setAlpha = vi.fn(() => object); object.destroy = vi.fn();
      addedCircles.push({ args, object }); return object;
    }),
    graphics: vi.fn(() => graphics),
  };
  Object.assign(scene, { ready: true, renderBoard: vi.fn(), boardGroup: { x: 0, y: 0, setY: vi.fn() }, drawAim: vi.fn(), flashLanding: vi.fn(), launcherBase: graphics, createOrb, add,
    tweens: { killAll: vi.fn(), resumeAll: vi.fn(), pauseAll: vi.fn(), add: (config: typeof tweens[number]) => tweens.push(config) },
    time: { paused: false, removeAllEvents: vi.fn(), clearPendingEvents: vi.fn(), delayedCall: (ms: number, callback: () => void) => { delays.push(ms); callbacks.push(callback); } },
    statusText: { setText: vi.fn() }, audio: { blip: vi.fn(), setMix: vi.fn() },
  });
  const initial = mode === 'campaign' ? createCampaign(1) : createRound('normal', mode);
  initial.currentColor = 0; initial.nextColor = 1; scene.begin(initial);
  const stateEvents = () => events.filter(event => event.type === 'snood-state').map(event => event.detail);
  const comboEvents = () => events.filter(event => event.type === 'snood-combo').map(event => event.detail as unknown as { count: number; cleared: number });
  return { scene, tweens, callbacks, delays, createOrb, add, addedTexts, addedCircles, stateEvents, comboEvents };
}

function enableV5(platform = 'windows-v5'): void {
  vi.stubGlobal('document', { documentElement: { classList: { contains: (name: string) => name === platform } } });
}

it.each(['endless', 'timed', 'campaign'] as const)('holds the %s preview through periodic flight updates, pause and visual settings, then reloads it with the cannon', mode => {
  const f = fixture(mode); f.scene.launchFromButton();
  expect(f.scene.activeState.nextColor).toBe(2); expect(f.stateEvents().at(-1)).toMatchObject({ nextColor: 1, previewNextColor: 1, phase: 'FLYING' });
  f.scene.update(0, 1000); expect(f.stateEvents().at(-1)).toMatchObject({ nextColor: 2, previewNextColor: 1, phase: 'FLYING' });
  f.scene.pauseGame(); f.scene.setSettings({ ...DEFAULT_SETTINGS, aimAssist: false });
  expect(f.createOrb).toHaveBeenLastCalledWith(0, { x: 320, y: 708 });
  expect(f.stateEvents().at(-1)?.previewNextColor).toBe(1);
  f.scene.resumeGame(); f.tweens[0].onComplete!();
  expect(f.stateEvents().at(-1)?.previewNextColor).toBe(1);
  f.callbacks[0](); expect(f.createOrb).toHaveBeenLastCalledWith(1, { x: 320, y: 708 });
  expect(f.stateEvents().at(-1)?.previewNextColor).toBe(2);
  expect(f.stateEvents().some(event => event.phase === 'RESOLVING' && event.previewNextColor === 2)).toBe(true);
});

it('rebases the presented preview on a new round and ignores an old flight completion', () => {
  const f = fixture('endless'); f.scene.launchFromButton(); const stale = f.tweens[0].onComplete!;
  const fresh = createRound('easy', 'endless'); fresh.nextColor = 4; f.scene.begin(fresh);
  stale(); expect(f.scene.activeState).toBe(fresh); expect(f.stateEvents().at(-1)?.previewNextColor).toBe(4); expect(f.callbacks).toHaveLength(0);
});

it('updates the preview to the committed board when a deadline interrupts an unfinished flight', () => {
  const f = fixture('timed'); f.scene.launchFromButton(); f.scene.activeState.status = 'LOST'; f.scene.activeState.endReason = 'timeout';
  (f.scene as unknown as { finishImmediately(): void }).finishImmediately();
  expect(f.stateEvents().at(-1)).toMatchObject({ nextColor: 2, previewNextColor: 2, phase: 'LOST' });
});

function resolveFeedbackShot(f: ReturnType<typeof fixture>, events: import('../src/core/types').GameEvent[]) {
  shotFeedback.events = events;
  const flight = f.tweens.length;
  f.scene.launchFromButton();
  f.tweens[flight].onComplete!();
  f.callbacks.at(-1)!();
}
const clearFeedback: import('../src/core/types').GameEvent[] = [{ type: 'match', cells: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }] }];

it('announces one combo per clearing shot after arrival, merging same-shot matches and drops', () => {
  const f = fixture('endless');
  resolveFeedbackShot(f, [...clearFeedback, { type: 'drop', cells: [{ row: 1, col: 0 }] }]);
  expect(f.comboEvents()).toEqual([]);
  shotFeedback.events = clearFeedback;
  const flight = f.tweens.length; f.scene.launchFromButton();
  expect(f.comboEvents()).toEqual([]);
  f.tweens[flight].onComplete!();
  expect(f.comboEvents()).toEqual([{ count: 2, cleared: 3 }]);
});

it('preserves a combo through pause and resets it on a non-clearing shot', () => {
  const f = fixture('endless');
  resolveFeedbackShot(f, clearFeedback); resolveFeedbackShot(f, clearFeedback);
  f.scene.pauseGame(); f.scene.resumeGame();
  resolveFeedbackShot(f, clearFeedback);
  resolveFeedbackShot(f, []); resolveFeedbackShot(f, clearFeedback); resolveFeedbackShot(f, clearFeedback);
  expect(f.comboEvents().map(event => event.count)).toEqual([2, 3, 2]);
});

it('cannot replay a stale combo after starting another round', () => {
  const f = fixture('endless');
  resolveFeedbackShot(f, clearFeedback);
  shotFeedback.events = clearFeedback;
  const flight = f.tweens.length; f.scene.launchFromButton();
  const stale = f.tweens[flight].onComplete!;
  f.scene.begin(createRound('easy', 'endless')); stale();
  resolveFeedbackShot(f, clearFeedback);
  expect(f.comboEvents()).toEqual([]);
});

it('starts patterned V5 clones together and lets their 1050 ms tail outlive the old firing lock', () => {
  enableV5();
  const f = fixture('endless');
  const scene = f.scene as unknown as {
    boardBalls: Map<string, any>; boardGroup: { x: number; y: number; add: ReturnType<typeof vi.fn> };
    animateResolution(previous: GameState, events: import('../src/core/types').GameEvent[]): void;
    transient: Set<{ destroy: () => void }>; v5Particles: Set<unknown>; phase: string;
  };
  const previous = f.scene.activeState;
  const match = Array.from({ length: 6 }, (_, index) => ({ row: Math.floor(index / 5), col: index % 5 }));
  const drop = { row: 2, col: 0 };
  const sourceOrbs = new Map<string, any>();
  for (const [index, cell] of [...match, drop].entries()) {
    // The final match cell represents the newly fired ball, which has no board sprite yet.
    if (index === 5) { previous.board[cell.row][cell.col] = null; continue; }
    previous.board[cell.row][cell.col] = (index % 6) as any;
    const source: Record<string, any> = { x: 90 + index, y: 140 + index };
    source.getData = vi.fn((key: string) => key === 'colorId' ? index % 6 : false);
    source.setVisible = vi.fn(); source.setAlpha = vi.fn(); source.destroy = vi.fn();
    sourceOrbs.set(`${cell.row}:${cell.col}`, source);
  }
  previous.currentColor = 4;
  const originalOrb = sourceOrbs.get('0:0');
  scene.boardBalls = sourceOrbs;
  scene.boardGroup.x = 7; scene.boardGroup.y = 11; scene.boardGroup.add = vi.fn();
  scene.phase = 'RESOLVING';
  const firstCloneIndex = f.createOrb.mock.calls.length;
  scene.animateResolution(previous, [
    { type: 'match', cells: match, points: 60 },
    { type: 'drop', cells: [drop], points: 20 },
  ]);

  expect(f.createOrb).toHaveBeenCalledWith(4, cellToPoint(match[5], boardGeometry(previous)));
  expect(originalOrb.setVisible).toHaveBeenCalledWith(false);
  expect(scene.boardGroup.add).not.toHaveBeenCalled();
  expect(f.tweens[0].duration).toBe(V5_CLEAR_MOTION.fallMs);
  expect(f.delays.at(-1)).toBe(BOARD_APPEARANCE.removal.fallMs + 90 + 6 * BOARD_APPEARANCE.removal.delay + 20);
  expect(f.addedCircles.length).toBeLessThanOrEqual(V5_CLEAR_MOTION.maxParticles);
  const animatedCopy = f.createOrb.mock.results.at(-1)!.value;
  const clones = f.createOrb.mock.results.slice(firstCloneIndex).map(result => result.value);
  const origins = f.createOrb.mock.calls.slice(firstCloneIndex).map(([, point]) => point);
  const driver = f.tweens[0].targets as { progress: number };
  f.tweens[0].onUpdate!();
  for (const [index, clone] of clones.entries()) expect(clone.setPosition).toHaveBeenCalledWith(origins[index].x, origins[index].y);
  driver.progress = 16 / V5_CLEAR_MOTION.fallMs;
  f.tweens[0].onUpdate!();
  expect(clones[0].setPosition.mock.calls.at(-1)![1]).toBeLessThan(origins[0].y); // Match scatters upward.
  expect(animatedCopy.setPosition.mock.calls.at(-1)![1]).toBeGreaterThan(origins.at(-1)!.y); // Drop falls immediately.
  expect(animatedCopy.setPosition).toHaveBeenCalled();
  expect(scene.transient.has(animatedCopy)).toBe(true);
  f.scene.pauseGame();
  expect(f.scene.isPaused).toBe(true);
  expect((scene as any).time.paused).toBe(true);
  expect((scene as any).tweens.pauseAll).toHaveBeenCalledOnce();
  f.scene.resumeGame();
  expect(f.scene.isPaused).toBe(false);
  expect((scene as any).time.paused).toBe(false);
  expect((scene as any).tweens.resumeAll).toHaveBeenCalled();
  for (const cell of [...match, drop]) previous.board[cell.row][cell.col] = null;
  delete (f.scene as any).renderBoard;
  f.callbacks.at(-1)!();
  expect(scene.phase).toBe('READY');
  expect(scene.transient.has(animatedCopy)).toBe(true); // The board unlock does not destroy its longer cosmetic tail.
  expect(originalOrb.destroy).toHaveBeenCalledOnce();
  expect(animatedCopy.destroy).not.toHaveBeenCalled();
  f.tweens[0].onComplete!();
  expect(animatedCopy.destroy).toHaveBeenCalledOnce();
  expect(scene.transient.has(animatedCopy)).toBe(false);
  expect(scene.v5Particles.size).toBe(0);
});

it('keeps the real firing lock identical for the same board balls in legacy, V5 and reduced-motion V5', () => {
  const match = [{ row: 0, col: 0 }, { row: 0, col: 1 }];
  const drop = [{ row: 1, col: 0 }, { row: 1, col: 1 }];
  const sourceBalls = new Map<string, any>();
  for (const [index, cell] of [...match, ...drop].entries()) {
    const color = index % 3;
    const source: Record<string, any> = { x: 110 + index, y: 150 + index };
    source.getData = vi.fn((key: string) => key === 'colorId' ? color : false);
    source.setVisible = vi.fn(); source.setAlpha = vi.fn();
    sourceBalls.set(`${cell.row}:${cell.col}`, source);
  }
  const run = (platform: 'legacy' | 'windows-v5', reducedMotion = false) => {
    if (platform === 'legacy') vi.stubGlobal('document', { documentElement: { classList: { contains: () => false } } });
    else enableV5(platform);
    const f = fixture('endless');
    const state = f.scene.activeState;
    for (const [index, cell] of [...match, ...drop].entries()) state.board[cell.row][cell.col] = index % 3;
    const scene = f.scene as unknown as {
      boardBalls: Map<string, any>; phase: string; transient: Set<unknown>;
      animateResolution(previous: GameState, events: import('../src/core/types').GameEvent[]): void;
    };
    scene.boardBalls = sourceBalls;
    scene.phase = 'RESOLVING';
    Object.assign(f.scene, { settings: { ...DEFAULT_SETTINGS, reducedMotion } });
    scene.animateResolution(state, [{ type: 'match', cells: match }, { type: 'drop', cells: drop }]);
    const lockMs = f.delays.at(-1)!;
    f.callbacks.at(-1)!();
    return { lockMs, ready: f.scene.isReady, liveTransientsAtUnlock: scene.transient.size };
  };

  const legacy = run('legacy');
  const v5 = run('windows-v5');
  const reduced = run('windows-v5', true);
  const expectedOldWait = BOARD_APPEARANCE.removal.fallMs + 90 + 3 * BOARD_APPEARANCE.removal.delay + 20;
  expect([legacy.lockMs, v5.lockMs, reduced.lockMs]).toEqual([expectedOldWait, expectedOldWait, expectedOldWait]);
  expect([legacy.ready, v5.ready, reduced.ready]).toEqual([true, true, true]);
  expect(v5.liveTransientsAtUnlock).toBeGreaterThan(0);
  expect(reduced.liveTransientsAtUnlock).toBe(0);
});

it('caps concurrent landing and clear particles at 54 and disposes each burst', () => {
  enableV5();
  const f = fixture('endless');
  const runtime = f.scene as unknown as {
    boardBalls: Map<string, unknown>; v5Particles: Set<unknown>;
    flashLanding(cell: { row: number; col: number }, color: number): void;
    animateResolution(previous: GameState, events: import('../src/core/types').GameEvent[]): void;
  };
  const previous = f.scene.activeState;
  delete (f.scene as any).flashLanding;
  const cells = Array.from({ length: 36 }, (_, index) => ({ row: Math.floor(index / 9), col: index % 9 }));
  for (const cell of cells) previous.board[cell.row][cell.col] = 1;
  runtime.boardBalls = new Map();
  runtime.flashLanding({ row: 0, col: 0 }, 0xdf827e);
  runtime.animateResolution(previous, [{ type: 'match', cells }]);
  expect(f.addedCircles).toHaveLength(V5_CLEAR_MOTION.maxParticles);
  expect(runtime.v5Particles.size).toBe(V5_CLEAR_MOTION.maxParticles);
  f.tweens[0].onComplete!();
  expect(runtime.v5Particles.size).toBeLessThan(V5_CLEAR_MOTION.maxParticles);
  f.tweens[1].onComplete!();
  expect(runtime.v5Particles.size).toBe(0);
});

it('caps Android Phaser particle objects at 30 across concurrent landing and clear bursts', () => {
  enableV5('android-v5');
  const f = fixture('endless');
  const runtime = f.scene as unknown as {
    boardBalls: Map<string, unknown>; v5Particles: Set<unknown>;
    flashLanding(cell: { row: number; col: number }, color: number): void;
    animateResolution(previous: GameState, events: import('../src/core/types').GameEvent[]): void;
  };
  const previous = f.scene.activeState;
  delete (f.scene as any).flashLanding;
  const cells = Array.from({ length: 36 }, (_, index) => ({ row: Math.floor(index / 9), col: index % 9 }));
  for (const cell of cells) previous.board[cell.row][cell.col] = 1;
  runtime.boardBalls = new Map();
  runtime.flashLanding({ row: 0, col: 0 }, 0xdf827e);
  runtime.animateResolution(previous, [{ type: 'match', cells }]);
  expect(f.addedCircles).toHaveLength(V5_CLEAR_MOTION.androidMaxParticles);
  expect(runtime.v5Particles.size).toBe(V5_CLEAR_MOTION.androidMaxParticles);
  f.tweens[0].onComplete!(); f.tweens[1].onComplete!();
  expect(runtime.v5Particles.size).toBe(0);
});

it('shows the V5 score and caption for a 1250 ms total, and the transient keeps idle rendering awake', () => {
  enableV5();
  const f = fixture('endless');
  const scene = f.scene as unknown as {
    showV5ScorePopup(points: number, label: string): void;
    transient: Set<{ destroy: () => void }>;
    performanceIdle: boolean;
  };
  scene.showV5ScorePopup(120, '同色消除 4');
  expect(f.addedTexts.map(({ args }) => args.slice(0, 4))).toEqual([
    [320, 560, '+120', expect.any(Object)],
    [320, 584, '同色消除 4', expect.any(Object)],
  ]);
  expect(f.tweens[0].duration).toBe(90);
  f.tweens[0].onComplete!();
  expect(f.tweens.slice(1).map(tween => (tween.delay ?? 0) + (tween.duration ?? 0))).toEqual([1160, 1160]);
  expect(scene.transient.size).toBe(2);
  expect(scene.performanceIdle).toBe(false);
  f.tweens[1].onComplete!(); f.tweens[2].onComplete!();
  expect(scene.transient.size).toBe(0);
  expect(f.addedTexts.every(({ object }) => object.destroy.mock.calls.length <= 1)).toBe(true);
});

it('keeps V5 removal static and particle-free with reduced motion while preserving the visual firing lock', () => {
  enableV5();
  const f = fixture('endless');
  const source = { x: 120, y: 160, getData: () => 0, setAlpha: vi.fn(), setVisible: vi.fn() };
  const scene = f.scene as unknown as { boardBalls: Map<string, any>; animateResolution(previous: GameState, events: import('../src/core/types').GameEvent[]): void };
  const previous = f.scene.activeState;
  previous.board[0][0] = 0;
  scene.boardBalls = new Map([['0:0', source]]);
  Object.assign(f.scene, { renderLauncher: vi.fn(), drawAim: vi.fn() });
  f.scene.setSettings({ ...DEFAULT_SETTINGS, reducedMotion: true });
  scene.animateResolution(previous, [{ type: 'match', cells: [{ row: 0, col: 0 }], points: 10 }]);
  expect(source.setAlpha).toHaveBeenCalledWith(0);
  expect(f.createOrb).toHaveBeenCalledTimes(1); // The launcher only; no removal copy is created.
  expect(f.addedCircles).toHaveLength(0);
  expect(f.tweens).toHaveLength(0);
  expect(f.delays.at(-1)).toBe(BOARD_APPEARANCE.removal.matchMs + 20);
});

it('destroys active V5 transient visuals when a new round starts', () => {
  enableV5();
  const f = fixture('endless');
  const scene = f.scene as unknown as { showV5ScorePopup(points: number, label: string): void; transient: Set<{ destroy: () => void }> };
  scene.showV5ScorePopup(30, '消除 3');
  const oldVisuals = [...scene.transient];
  expect(oldVisuals).toHaveLength(2);
  f.scene.begin(createRound('easy', 'endless'));
  expect(scene.transient.size).toBe(0);
  expect(oldVisuals.every(visual => (visual as any).destroy.mock.calls.length === 1)).toBe(true);
  f.tweens[0].onComplete!();
  expect(f.tweens).toHaveLength(1); // The stale popup does not start its fade on the new round.
});
