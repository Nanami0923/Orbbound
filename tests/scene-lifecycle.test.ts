import { expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({default:{Scene:class {},AUTO:0,Scale:{FIT:0,CENTER_BOTH:0}}}));
import { PlayScene } from '../src/game/PlayScene';
import { createGameState } from '../src/core/engine';

it('resumes the animation manager and clock when starting easy mode from a paused scene', () => {
  const scene = new PlayScene();
  const tweens = {paused:true,killAll:vi.fn(),resumeAll(){this.paused=false;}};
  const clock = {paused:true,removeAllEvents:vi.fn()};
  Object.assign(scene,{tweens,time:clock,statusText:{setText:vi.fn()},renderBoard:vi.fn(),renderLauncher:vi.fn(),drawAim:vi.fn(),emitState:vi.fn()});
  scene.begin(createGameState('easy',42));
  expect(tweens.paused).toBe(false); expect(clock.paused).toBe(false);
  expect(tweens.killAll).toHaveBeenCalledOnce();
  expect(clock.removeAllEvents).toHaveBeenCalledOnce();
});

it('keeps input locked until the descent tween completes', () => {
  const scene = new PlayScene();
  const callbacks: Array<() => void> = [];
  const boardGroup = {setY:vi.fn()};
  let finish: (() => void) | undefined;
  Object.assign(scene, {
    gameState: createGameState('easy',42), phase:'RESOLVING', boardGroup,
    time:{delayedCall:(_delay:number, callback:()=>void) => callbacks.push(callback)},
    tweens:{add:(config:{onComplete?:()=>void}) => {finish=config.onComplete;}},
    audio:{blip:vi.fn()},renderBoard:vi.fn(),renderLauncher:vi.fn(),drawAim:vi.fn(),emitState:vi.fn(),
    statusText:{setText:vi.fn()},
  });
  const runtime = scene as unknown as {animateResolution(state:unknown,events:unknown[]):void; phase:string};
  runtime.animateResolution(createGameState('easy',42),[{type:'board-drop'}]);
  callbacks[0]();
  expect(runtime.phase).toBe('RESOLVING');
  expect(finish).toBeTypeOf('function');
  finish!();
  expect(runtime.phase).toBe('READY');
});

