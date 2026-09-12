import { expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({default:{Scene:class {},AUTO:0,Scale:{FIT:0,CENTER_BOTH:0}}}));
import { PlayScene } from '../src/game/PlayScene';
import { createGameState } from '../src/core/engine';
import { cellKey } from '../src/core/grid';
import { createRound } from '../src/core/modes';

it('reuses unchanged board balls and only creates or destroys changed cells', () => {
  const scene = new PlayScene();
  const createOrb = vi.fn(() => {
    const data = new Map();
    const orb = { setData(k: string, v: unknown) { data.set(k,v); return orb; }, getData(k: string) { return data.get(k); },
      setPosition: vi.fn(() => orb), setScale: vi.fn(() => orb), setAlpha: vi.fn(() => orb), destroy: vi.fn() };
    return orb;
  });
  const state = createGameState('easy', 42);
  Object.assign(scene, {gameState:state, createOrb, boardGroup:{setY:vi.fn(),add:vi.fn()}});
  const runtime = scene as unknown as {renderBoard():void; boardBalls:Map<string,ReturnType<typeof createOrb>>};
  runtime.renderBoard();
  const count = createOrb.mock.calls.length;
  const first = runtime.boardBalls.get(cellKey({row:0,col:0}))!;
  runtime.renderBoard();
  expect(createOrb).toHaveBeenCalledTimes(count);
  expect(first.destroy).not.toHaveBeenCalled();
  state.board[0][0] = null;
  runtime.renderBoard();
  expect(first.destroy).toHaveBeenCalledOnce();
  expect(runtime.boardBalls.size).toBe(count - 1);
  state.board[0][0] = 0;
  runtime.renderBoard();
  expect(createOrb).toHaveBeenCalledTimes(count + 1);
  expect(runtime.boardBalls.size).toBe(count);
});

it('uses an 84-unit barrel when trajectory assistance is off', () => {
  const scene = new PlayScene();
  const lineBetween = vi.fn();
  Object.assign(scene, {phase:'READY',angle:0,settings:{aimAssist:false},input:{setDefaultCursor:vi.fn()},
    aimGraphics:{clear:vi.fn(),lineStyle:vi.fn(),lineBetween}});
  (scene as unknown as {drawAim():void}).drawAim();
  const [x,y,endX,endY] = lineBetween.mock.calls[0];
  expect(Math.hypot(endX-x,endY-y)).toBe(84);
});

it('keeps the cursor hidden through flight and resolution, and restores it on pause or game over', () => {
  const scene = new PlayScene();
  const setDefaultCursor = vi.fn();
  Object.assign(scene, {
    input: {setDefaultCursor}, settings: {aimAssist:false},
    aimGraphics: {clear:vi.fn(), lineStyle:vi.fn(), lineBetween:vi.fn()},
  });
  const runtime = scene as unknown as {phase:string; drawAim():void; settings:{aimAssist:boolean}};
  for (const phase of ['READY', 'FLYING', 'RESOLVING', 'PAUSED', 'FLYING', 'READY', 'WON', 'LOST']) {
    runtime.phase = phase;
    runtime.drawAim();
    expect(setDefaultCursor).toHaveBeenLastCalledWith(['READY','FLYING','RESOLVING'].includes(phase) ? 'none' : 'auto');
  }
  runtime.settings.aimAssist = true;
  runtime.phase = 'FLYING';
  runtime.drawAim();
  expect(setDefaultCursor).toHaveBeenLastCalledWith('auto');
});

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

it('does not pause timed mode when a menu or background lifecycle asks to pause', () => {
  const scene = new PlayScene();
  const pauseAll = vi.fn(), persistGame = vi.fn();
  Object.assign(scene, {gameState:createRound('normal','timed'),phase:'READY',persistGame,tweens:{pauseAll}});
  scene.pauseGame();
  expect(scene.isPaused).toBe(false); expect(pauseAll).not.toHaveBeenCalled(); expect(persistGame).toHaveBeenCalledOnce();
});

it('cancels a pending animation and finishes only once when the timed deadline passes', () => {
  const scene = new PlayScene();
  const state = createRound('normal','timed',300000,Date.now()-300001);
  state.nextDescentAt=Date.now()+1000;
  const killAll=vi.fn(), removeAllEvents=vi.fn(), destroy=vi.fn();
  Object.assign(scene,{ready:true,gameState:state,phase:'FLYING',tweens:{killAll},time:{removeAllEvents},
    transient:new Set([{destroy}]),renderBoard:vi.fn(),renderLauncher:vi.fn(),drawAim:vi.fn(),emitState:vi.fn()});
  scene.syncTimedClock(); scene.syncTimedClock();
  expect(scene.activeState.endReason).toBe('timeout');
  expect(killAll).toHaveBeenCalledOnce(); expect(removeAllEvents).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledOnce();
});

