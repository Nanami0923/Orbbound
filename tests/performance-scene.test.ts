import {afterEach,expect,it,vi} from 'vitest';
vi.mock('phaser',()=>({default:{Scene:class {},AUTO:0,Scale:{FIT:0,CENTER_BOTH:0}}}));
vi.mock('../src/game/input-mode',()=>({usesButtonControls:()=>false}));
import {PlayScene} from '../src/game/PlayScene';
import {DEFAULT_SETTINGS} from '../src/storage/storage';
import {createRound} from '../src/core/modes';
import {createCampaign} from '../src/core/campaign';
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

function setup(){
  vi.stubGlobal('document',{querySelector:(selector:string)=>({hidden:selector==='#modal-root'})});
  const scene=new PlayScene();Object.assign(scene,{gameState:createRound('normal','endless'),drawAim:vi.fn(),emitState:vi.fn()});
  return {scene,runtime:scene as unknown as {angle:number;handleKeyDown(e:unknown):void;handleKeyUp(e:unknown):void}};
}
const key=(code:string)=>({code,repeat:false,preventDefault:vi.fn()});

it('resumes the still-held direction when the latest direction is released, and blur clears both',()=>{
  const {scene,runtime}=setup();
  runtime.handleKeyDown(key('ArrowLeft'));runtime.handleKeyDown(key('ArrowRight'));runtime.handleKeyUp(key('ArrowRight'));
  const before=runtime.angle;scene.update(0,100);expect(runtime.angle).toBeLessThan(before);
  scene.stopRotation();const stopped=runtime.angle;runtime.handleKeyUp(key('ArrowLeft'));scene.update(0,100);
  expect(runtime.angle).toBe(stopped);
});

it('bounds a stalled steering frame without removing elapsed gameplay time',()=>{
  const {scene,runtime}=setup();scene.startRotation(1);scene.update(0,5000);
  expect(runtime.angle*180/Math.PI).toBeLessThan(10);expect(scene.activeState.elapsedMs).toBe(5000);
  scene.update(0,NaN);expect(Number.isFinite(runtime.angle)).toBe(true);expect(scene.activeState.elapsedMs).toBe(5000);
});

it('retains the same resolution/descent firing lock with reduced motion',()=>{
  const {scene}=setup();const callbacks:Array<{delay:number;fn:()=>void}>=[];const tween=vi.fn();
  const cells=[{row:0,col:0},{row:0,col:1}];const orb={setAlpha:vi.fn(),y:0};
  Object.assign(scene,{settings:{...DEFAULT_SETTINGS,reducedMotion:true},phase:'RESOLVING',boardBalls:new Map(cells.map(c=>[`${c.row}:${c.col}`,orb])),
    time:{delayedCall:(delay:number,fn:()=>void)=>callbacks.push({delay,fn})},tweens:{add:tween},
    boardGroup:{setY:vi.fn()},renderBoard:vi.fn(),renderLauncher:vi.fn(),audio:{blip:vi.fn()},statusText:{setText:vi.fn()}});
  const runtime=scene as unknown as {animateResolution(previous:unknown,events:unknown[]):void;phase:string};
  runtime.animateResolution(scene.activeState,[{type:'drop',cells},{type:'board-drop'}]);
  expect(tween).not.toHaveBeenCalled();expect(runtime.phase).toBe('RESOLVING');
  callbacks[0].fn();expect(runtime.phase).toBe('RESOLVING');expect(callbacks[1].delay).toBe(360);
  callbacks[1].fn();expect(scene.isReady).toBe(true);
});

it('settles campaign decision time between static frames before pause and excludes menu time',()=>{
  let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now);
  const {scene}=setup();Object.assign(scene,{gameState:createCampaign(18),decisionClockAt:1000,
    tweens:{pauseAll:vi.fn(),resumeAll:vi.fn()},time:{paused:false},persistGame:vi.fn(),statusText:{setText:vi.fn()}});
  now=1090;scene.pauseGame();expect(scene.activeState.elapsedMs).toBe(90);
  now=5000;scene.resumeGame();now=5010;scene.update(0,2000);
  expect(scene.activeState.elapsedMs).toBe(100);
});

it('settles the final idle decision interval before testing a campaign shot deadline',()=>{
  let now=1000;vi.spyOn(Date,'now').mockImplementation(()=>now);
  const {scene}=setup();const finish=vi.fn(()=>Object.assign(scene,{phase:'LOST'}));
  Object.assign(scene,{gameState:{...createCampaign(18),elapsedMs:149950},decisionClockAt:1000,finishImmediately:finish});
  now=1090;scene.launchFromButton();
  expect(scene.activeState.elapsedMs).toBe(150000);expect(scene.activeState.endReason).toBe('timeout');expect(finish).toHaveBeenCalledOnce();
});
