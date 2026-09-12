import { expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({ default: { Scene: class {}, AUTO: 0, Scale: { FIT: 0, CENTER_BOTH: 0 } } }));
vi.mock('../src/game/input-mode', () => ({ usesButtonControls: () => true }));
import { PlayScene } from '../src/game/PlayScene';

function setup() {
  const scene = new PlayScene();
  Object.assign(scene, { drawAim: vi.fn(), launch: vi.fn(), emitState: vi.fn() });
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

it('starts immediately and integrates the same held angle at 30, 60, and 120 FPS', () => {
  for (const fps of [30, 60, 120]) {
    const { scene, runtime } = setup();
    scene.startRotation(1);
    expect(runtime.angle).toBeCloseTo(Math.PI / 180);
    for (let frame = 0; frame < fps; frame++) scene.update(0, 1000 / fps);
    expect(runtime.angle).toBeCloseTo(49 * Math.PI / 180);
  }
});

it('stops on release and resets acceleration when the direction changes', () => {
  const { scene, runtime } = setup();
  scene.startRotation(1);
  scene.update(0, 200);
  scene.stopRotation();
  const angle = runtime.angle;
  scene.update(0, 200);
  expect(runtime.angle).toBe(angle);
  scene.startRotation(-1);
  scene.update(0, 200);
  expect(runtime.angle).toBeCloseTo(0);
});

it('drops a held rotation when the scene becomes paused and does not resume it', () => {
  const { scene, runtime } = setup();
  scene.startRotation(1);
  runtime.phase = 'PAUSED';
  scene.update(0, 1000);
  runtime.phase = 'READY';
  scene.update(0, 1000);
  expect(runtime.angle).toBeCloseTo(Math.PI / 180);
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
