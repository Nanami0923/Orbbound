import { expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({ default: { Scene: class {}, AUTO: 0, Scale: { FIT: 0, CENTER_BOTH: 0 } } }));
vi.mock('../src/game/input-mode', () => ({ usesButtonControls: () => true }));
import { PlayScene } from '../src/game/PlayScene';
import { createRound } from '../src/core/modes';
import { heldRotationDegrees } from '../src/game/rotation';

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

it.each(['endless','timed'] as const)('starts gently and integrates the same held angle at 30, 60, and 120 FPS in %s', mode => {
  for (const fps of [30, 60, 120]) {
    const { scene, runtime } = setup();
    Object.assign(scene,{gameState:createRound('normal',mode)});
    scene.startRotation(1);
    expect(runtime.angle).toBeCloseTo(Math.PI / 180);
    for (let frame = 0; frame < fps; frame++) scene.update(0, 1000 / fps);
    expect(runtime.angle).toBeCloseTo((1 + heldRotationDegrees(1)) * Math.PI / 180);
  }
});

it('increases held speed smoothly up to its cap without a speed jump', () => {
  const velocity = (t:number) => (heldRotationDegrees(t+0.0001)-heldRotationDegrees(t))/0.0001;
  expect(velocity(0)).toBeCloseTo(12,3);
  expect(velocity(.3)).toBeLessThan(velocity(.6));
  expect(velocity(.6)).toBeLessThan(velocity(1.2));
  expect(velocity(1.2)).toBeLessThan(velocity(1.8));
  expect(velocity(1.8)).toBeCloseTo(96,3);
  expect(velocity(3)).toBeCloseTo(96,3);
  expect(velocity(1.7999)).toBeCloseTo(velocity(1.8),3);
  expect(heldRotationDegrees(-1)).toBe(0);
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

it('ignores rotation while paused or finished', () => {
  const { scene, runtime } = setup();
  for (const phase of ['PAUSED', 'WON', 'LOST']) {
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

 it.each(['endless', 'timed'] as const)('keeps held steering continuous through flight and descent in %s', mode => {
  const { scene, runtime } = setup();
  Object.assign(scene, { gameState: createRound('normal', mode) });
  scene.startRotation(1);
  for (const phase of ['READY', 'FLYING', 'RESOLVING', 'READY']) {
    runtime.phase = phase;
    scene.update(0, 150);
  }
  expect(runtime.angle).toBeCloseTo((1 + heldRotationDegrees(.6)) * Math.PI / 180);
 });
 it('animates a 30 degree quick turn, accepts repeated taps, and clamps at the boundary', () => {
  const { scene, runtime } = setup();
  scene.quickRotate(1);
  expect(runtime.angle).toBe(0);
  scene.update(0, 130);
  expect(runtime.angle).toBeCloseTo(15 * Math.PI / 180);
  scene.quickRotate(1);
  scene.update(0, 260);
  expect(runtime.angle).toBeCloseTo(60 * Math.PI / 180);
  runtime.phase = 'RESOLVING';
  scene.quickRotate(1);
  scene.update(0, 260);
  expect(runtime.angle).toBeCloseTo(78 * Math.PI / 180);
 });
 it('cancels quick turn on release of input focus or new manual steering', () => {
  const { scene, runtime } = setup();
  scene.quickRotate(1);
  scene.update(0, 130);
  scene.stopRotation();
  scene.update(0, 260);
  expect(runtime.angle).toBeCloseTo(15 * Math.PI / 180);
  scene.quickRotate(1);
  scene.startRotation(-1);
  scene.update(0, 100);
  expect(runtime.angle).toBeLessThan(15 * Math.PI / 180);
 });

it('direct aiming clamps and fine steering follows position then stops on release', () => {
  const {scene,runtime} = setup();
  scene.setAimDegrees(100); expect(runtime.angle).toBeCloseTo(78*Math.PI/180);
  scene.setAimDegrees(0); scene.setFineRotation(100);
  for(let i=0;i<10;i++) scene.update(0,100);
  expect(runtime.angle).toBeCloseTo(60*Math.PI/180);
  scene.stopRotation(); scene.update(0,100); expect(runtime.angle).toBeCloseTo(60*Math.PI/180);
  scene.setAimDegrees(0); scene.setFineRotation(-50); scene.update(0,100);
  expect(runtime.angle).toBeLessThan(0); expect(runtime.angle).toBeGreaterThan(-3*Math.PI/180);
  runtime.phase='PAUSED'; scene.update(0,100); runtime.phase='READY';
  const angle=runtime.angle; scene.update(0,100); expect(runtime.angle).toBe(angle);
});
