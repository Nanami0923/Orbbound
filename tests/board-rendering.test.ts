import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({ default: { Scene: class {}, AUTO: 0, Scale: { FIT: 0, CENTER_BOTH: 0 } } }));
import { BOARD_APPEARANCE, aimMarkers, boardGeometry, drawArena } from '../src/render/board-appearance';
import { clearBoardArtworkCache, orbArtwork, paintOrbArtwork } from '../src/render/board-artwork';
import { boardCanvasSize } from '../src/render/board-view';
import { drawLanBoard } from '../src/ui/lan-board';
import { PlayScene } from '../src/game/PlayScene';
import { createGameState } from '../src/core/engine';

function contextRecorder() {
  const operations: Array<[PropertyKey, ...unknown[]]> = [];
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  const context = new Proxy({}, {
    get: (_target, key) => {
      if (key === 'operations') return operations;
      if (!methods.has(key)) methods.set(key, (...args: unknown[]) => { operations.push([key, ...args]); return key === 'measureText' ? { width: 8 } : undefined; });
      return methods.get(key);
    },
    set: (_target, key, value) => { operations.push([key, value]); return true; },
  }) as CanvasRenderingContext2D;
  return { context, operations };
}
function canvases(classes = new Set<string>()) {
  const created: HTMLCanvasElement[] = [];
  const make = () => {
    const { context, operations } = contextRecorder();
    const canvas = { width: 640, height: 760, getContext: () => context, operations } as unknown as HTMLCanvasElement;
    created.push(canvas); return canvas;
  };
  vi.stubGlobal('document', {
    documentElement: { classList: { contains: (name: string) => classes.has(name) } },
    createElement: (tag: string) => { expect(tag).toBe('canvas'); return make(); },
  });
  return { make, created };
}
beforeEach(clearBoardArtworkCache);
afterEach(() => { clearBoardArtworkCache(); vi.unstubAllGlobals(); });

it('uses the exact same orb painting recipe for the Phaser texture and shared Canvas artwork', () => {
  const scene = new PlayScene(), cached = new Set<string>(), textures: ReturnType<typeof contextRecorder>[] = [];
  Object.assign(scene, { textures: { exists: (key: string) => cached.has(key), createCanvas: (key: string, width: number, height: number) => {
    expect([width, height]).toEqual([192, 192]); cached.add(key); const texture = contextRecorder(); textures.push(texture); return { context: texture.context, refresh: vi.fn() };
  } }, add: { image: () => ({ setDisplaySize: vi.fn() }), container: vi.fn() } });
  const createOrb = (scene as unknown as { createOrb(color: number, point: { x: number; y: number }): unknown }).createOrb.bind(scene);
  for (let color = 0; color < 6; color++) {
    createOrb(color, { x: 68, y: 86 }); createOrb(color, { x: 108, y: 86 });
    const direct = contextRecorder(); paintOrbArtwork(direct.context, color);
    expect(textures[color].operations.slice(1)).toEqual(direct.operations);
    expect(direct.operations).toContainEqual(['arc', 18, 32, 1.7, 0, Math.PI * 2]);
    expect(direct.operations).toContainEqual(['arc', 30, 32, 1.7, 0, Math.PI * 2]);
  }
  expect(textures).toHaveLength(6);
});

it('uses the shared V5 glyph paths for Phaser and Canvas and separates cached sprites by appearance', () => {
  const classes = new Set(['android-v5']), { created } = canvases(classes);
  const scene = new PlayScene(), textures = new Map<string, ReturnType<typeof contextRecorder>>();
  Object.assign(scene, { textures: { exists: (key: string) => textures.has(key), createCanvas: (key: string, width: number, height: number) => {
    expect([width, height]).toEqual([192, 192]); const texture = contextRecorder(); textures.set(key, texture);
    return { context: texture.context, refresh: vi.fn() };
  } }, add: { image: () => ({ setDisplaySize: vi.fn() }), container: vi.fn() } });
  const createOrb = (scene as unknown as { createOrb(color: number, point: { x: number; y: number }): unknown }).createOrb.bind(scene);
  for (let color = 0; color < 6; color++) {
    createOrb(color, { x: 68, y: 86 });
    const direct = contextRecorder(); paintOrbArtwork(direct.context, color);
    expect(textures.get(`orb-shared-v5-${color}`)?.operations.slice(1)).toEqual(direct.operations);
    expect(direct.operations.some(([name]) => name === 'moveTo')).toBe(true);
    expect(direct.operations.some(([name]) => name === 'fillText')).toBe(false);
    expect(direct.operations).toContainEqual(['arc', 18, 32, 1.7, 0, Math.PI * 2]);
    expect(direct.operations).toContainEqual(['arc', 30, 32, 1.7, 0, Math.PI * 2]);
  }

  const v5Sprite = orbArtwork(2); expect(v5Sprite).toBe(created[0]);
  classes.clear(); const legacySprite = orbArtwork(2);
  createOrb(2, { x: 68, y: 86 });
  expect(textures.has('orb-shared-legacy-2')).toBe(true);
  expect(legacySprite).not.toBe(v5Sprite);
  expect(orbArtwork(2)).toBe(legacySprite);
  classes.add('windows-v5'); expect(orbArtwork(2)).toBe(v5Sprite);
  createOrb(2, { x: 68, y: 86 });
  expect(textures.size).toBe(7);
});

it('retains arena, orb, cannon and settled-board artwork across angle-only frames', () => {
  const { make, created } = canvases(), canvas = make(), state = createGameState('normal', 42);
  drawLanBoard(canvas, state, 0); const initial = created.length;
  drawLanBoard(canvas, state, .5); drawLanBoard(canvas, state, -.5);
  expect(created).toHaveLength(initial);
  const next = { ...state, board: state.board.map(row => [...row]) }; drawLanBoard(canvas, next, .5);
  expect(created.length).toBe(initial);
  const layers = created.filter(item => (item as unknown as { operations: Array<[string, ...unknown[]]> }).operations.some(([name]) => name === 'clearRect'));
  expect(layers).toHaveLength(1);
  expect((layers[0] as unknown as { operations: Array<[string, ...unknown[]]> }).operations.filter(([name]) => name === 'clearRect')).toHaveLength(2);
  canvas.width = 960; canvas.height = 1140; drawLanBoard(canvas, next, .5);
  expect(created.length).toBe(initial + 1);
});

it('keeps read-only observation free of the local angle and leaves source state immutable', () => {
  const { make } = canvases(), canvas = make(), state = createGameState('normal', 42), before = structuredClone(state);
  drawLanBoard(canvas, state, undefined, undefined, 0, { role: 'observation' });
  const operations = (canvas as unknown as { operations: Array<[string, ...unknown[]]> }).operations;
  expect(operations.some(([name]) => name === 'rotate')).toBe(false);
  expect(operations.some(([name]) => name === 'drawImage')).toBe(true);
  expect(state).toEqual(before);
});

it('shares the single-player rounded arena and preserves physics geometry', () => {
  const calls: unknown[][] = [], graphics = new Proxy({}, { get: (_target, method) => (...args: unknown[]) => { calls.push([method, ...args]); return graphics; } });
  drawArena(graphics as Parameters<typeof drawArena>[0]);
  expect(calls).toContainEqual(['fillRoundedRect', 26, 48, 588, 592, 24]);
  const state = createGameState('normal', 42); state.rowOffset = 1; state.ceilingRow = 2;
  expect(boardGeometry(state)).toMatchObject({ radius: 18, rowStep: 31.2, floor: 635, rowOffset: 1, ceilingRow: 2, top: 120.4 });
});

it('samples uniform aim dots across a wall reflection with the shared landing and physical radius', () => {
  const geometry = boardGeometry(createGameState('normal', 42));
  const result = aimMarkers({ points: [{ x: 100, y: 100 }, { x: 58, y: 58 }, { x: 100, y: 16 }], landing: { row: 0, col: 0 }, bounced: true, reason: 'bubble' }, geometry);
  expect(result.bounce).toEqual({ x: 58, y: 58 }); expect(result.dots.length).toBeGreaterThan(3);
  expect(BOARD_APPEARANCE.loadedScale).toBe(.93);
});

it('uses a shared logical quality budget for main/observation and a smaller thumbnail budget', () => {
  expect(boardCanvasSize('main', 320, 380, 3, 'auto')).toEqual({ width: 960, height: 1140 });
  expect(boardCanvasSize('observation', 320, 380, 3, 'auto')).toEqual(boardCanvasSize('main', 320, 380, 3, 'auto'));
  expect(boardCanvasSize('thumbnail', 28, 33.25, 3, 'auto')).toEqual({ width: 56, height: 67 });
  expect(boardCanvasSize('main', 320, 380, 3, 1)).toEqual({ width: 640, height: 760 });
  expect(boardCanvasSize('main', 640, 760, 3, 'auto', true)).toEqual({ width: 960, height: 1140 });
  expect(boardCanvasSize('main', 640, 760, 3, 2, true)).toEqual({ width: 1280, height: 1520 });
});
