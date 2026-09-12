import { expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({ default: { Scene: class {}, AUTO: 0, Scale: { FIT: 0, CENTER_BOTH: 0 } } }));
vi.mock('../src/game/input-mode', () => ({ usesButtonControls: () => true }));
import { PlayScene } from '../src/game/PlayScene';

function setup() {
  const scene = new PlayScene();
  Object.assign(scene, { drawAim: vi.fn(), launch: vi.fn() });
  const runtime = scene as unknown as {
    angle: number; phase: string; pointerActive: boolean; launch: ReturnType<typeof vi.fn>;
    handlePointerDown(pointer: unknown): void; handlePointerMove(pointer: unknown): void; handlePointerUp(): void;
  };
  return { scene, runtime };
}

it('rotates counterclockwise and clockwise in one-degree steps, clamped to playable angles', () => {
  const { scene, runtime } = setup();
  scene.rotateLauncher(-1);
  expect(runtime.angle).toBeCloseTo(-Math.PI / 180);
  scene.rotateLauncher(1);
  expect(runtime.angle).toBeCloseTo(0);
  for (let i = 0; i < 200; i++) scene.rotateLauncher(1);
  expect(runtime.angle).toBeCloseTo(78 * Math.PI / 180);
  for (let i = 0; i < 300; i++) scene.rotateLauncher(-1);
  expect(runtime.angle).toBeCloseTo(-78 * Math.PI / 180);
});

it('ignores rotation while paused, resolving, flying, or finished', () => {
  const { scene, runtime } = setup();
  for (const phase of ['PAUSED', 'FLYING', 'RESOLVING', 'WON', 'LOST']) {
    runtime.phase = phase;
    scene.rotateLauncher(1);
    expect(runtime.angle).toBe(0);
  }
});

it('mobile board touches cannot aim or fire, including an existing pointer gesture', () => {
  const { runtime } = setup();
  runtime.handlePointerDown({ worldX: 100, worldY: 100 });
  runtime.handlePointerMove({ isDown: true, worldX: 600, worldY: 100 });
  runtime.pointerActive = true;
  runtime.handlePointerUp();
  expect(runtime.angle).toBe(0);
  expect(runtime.pointerActive).toBe(false);
  expect(runtime.launch).not.toHaveBeenCalled();
});
