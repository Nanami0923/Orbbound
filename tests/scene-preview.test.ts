import { afterEach, expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({ default: { Scene: class {}, AUTO: 0, Scale: { FIT: 0, CENTER_BOTH: 0 } } }));
vi.mock('../src/game/input-mode', () => ({ usesButtonControls: () => true }));
vi.mock('../src/core/engine', async original => {
  const module = await original<typeof import('../src/core/engine')>();
  return { ...module, resolveShot: (state: GameState) => ({ state: { ...state, currentColor: state.nextColor, nextColor: 2, step: state.step + 1 }, events: [] }) };
});
vi.mock('../src/core/physics', async original => {
  const module = await original<typeof import('../src/core/physics')>();
  return { ...module, traceShot: () => ({ points: [{ x: 320, y: 680 }, { x: 320, y: 200 }], landing: { row: 1, col: 1 }, bounced: false, reason: 'bubble' }) };
});
import { PlayScene } from '../src/game/PlayScene';
import { createRound } from '../src/core/modes';
import { createCampaign } from '../src/core/campaign';
import { DEFAULT_SETTINGS } from '../src/storage/storage';
import type { GameState } from '../src/core/types';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture(mode: 'endless' | 'timed' | 'campaign') {
  vi.spyOn(Date, 'now').mockReturnValue(1000);
  const events: Array<{ type: string; detail: { nextColor: number; previewNextColor: number; phase: string } }> = [], values = new Map<string, string>();
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), dispatchEvent: (event: CustomEvent) => { events.push(event); return true; }, localStorage: {
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key),
  } });
  const scene = new PlayScene(), tweens: Array<{ onComplete?: () => void }> = [], callbacks: Array<() => void> = [];
  const graphics = { clear: vi.fn().mockReturnThis(), fillStyle: vi.fn().mockReturnThis(), lineStyle: vi.fn().mockReturnThis(), fillCircle: vi.fn().mockReturnThis(), strokeCircle: vi.fn().mockReturnThis() };
  const createOrb = vi.fn(() => ({ setScale: vi.fn(), setRotation: vi.fn(), setVisible: vi.fn(), setPosition: vi.fn(), destroy: vi.fn() }));
  Object.assign(scene, { ready: true, renderBoard: vi.fn(), boardGroup: { setY: vi.fn() }, drawAim: vi.fn(), flashLanding: vi.fn(), launcherBase: graphics, createOrb,
    tweens: { killAll: vi.fn(), resumeAll: vi.fn(), pauseAll: vi.fn(), add: (config: { onComplete?: () => void }) => tweens.push(config) },
    time: { paused: false, removeAllEvents: vi.fn(), clearPendingEvents: vi.fn(), delayedCall: (_ms: number, callback: () => void) => callbacks.push(callback) },
    statusText: { setText: vi.fn() }, audio: { blip: vi.fn(), setMix: vi.fn() },
  });
  const initial = mode === 'campaign' ? createCampaign(1) : createRound('normal', mode);
  initial.currentColor = 0; initial.nextColor = 1; scene.begin(initial);
  const stateEvents = () => events.filter(event => event.type === 'snood-state').map(event => event.detail);
  return { scene, tweens, callbacks, createOrb, stateEvents };
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
