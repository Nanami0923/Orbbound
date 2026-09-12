import { afterEach, expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({ default: { Scene: class {}, AUTO: 0, Scale: { FIT: 0, CENTER_BOTH: 0 }, Math: {
  DegToRad: (x: number) => x * Math.PI / 180,
  Clamp: (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x)),
} } }));
vi.mock('../src/game/input-mode', () => ({ usesButtonControls: () => false }));
import { PlayScene } from '../src/game/PlayScene';
import { createRound } from '../src/core/modes';
import { heldRotationDegrees } from '../src/game/rotation';

afterEach(() => vi.unstubAllGlobals());
function setup(mode: 'endless' | 'timed' = 'endless') {
  vi.stubGlobal('document', { querySelector: (selector: string) => ({ hidden: selector === '#modal-root' }) });
  const scene = new PlayScene();
  Object.assign(scene, { gameState: createRound('normal', mode), drawAim: vi.fn(), emitState: vi.fn(), launch: vi.fn() });
  const runtime = scene as unknown as {
    angle: number; phase: string; pointerActive: boolean;
    handleKeyDown(event: unknown): void; handleKeyUp(event: unknown): void;
    handlePointerMove(pointer: unknown): void;
  };
  return { scene, runtime };
}
const key = (code: string, repeat = false) => ({ code, repeat, preventDefault: vi.fn() });

it.each(['endless', 'timed'] as const)('desktop held keys accelerate through descent and stop on keyup in %s', mode => {
  const { scene, runtime } = setup(mode);
  runtime.handleKeyDown(key('ArrowRight'));
  scene.update(0, 200);
  runtime.handleKeyDown(key('ArrowRight', true));
  runtime.phase = 'RESOLVING';
  scene.update(0, 200);
  expect(runtime.angle).toBeCloseTo((1 + heldRotationDegrees(.4)) * Math.PI / 180);
  runtime.handleKeyUp(key('ArrowRight'));
  const angle = runtime.angle;
  scene.update(0, 200);
  expect(runtime.angle).toBe(angle);
});

it('Q/E quick turns ignore OS repeat and remain interruptible by the mouse during descent', () => {
  const { scene, runtime } = setup();
  runtime.handleKeyDown(key('KeyQ'));
  runtime.handleKeyDown(key('KeyQ', true));
  scene.update(0, 260);
  expect(runtime.angle).toBeCloseTo(-Math.PI / 6);
  runtime.handleKeyDown(key('KeyE'));
  runtime.phase = 'RESOLVING';
  runtime.handlePointerMove({ worldX: 320, worldY: 100, isDown: false });
  scene.update(0, 260);
  expect(runtime.angle).toBeCloseTo(0);
});

it('does not consume gameplay shortcuts while a dialog is open', () => {
  const { scene, runtime } = setup();
  vi.stubGlobal('document', { querySelector: () => ({ hidden: false }) });
  runtime.handleKeyDown(key('ArrowRight'));
  runtime.handleKeyDown(key('KeyE'));
  scene.update(0, 260);
  expect(runtime.angle).toBe(0);
});
