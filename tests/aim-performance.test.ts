import {expect,it,vi} from 'vitest';
vi.mock('phaser',()=>({default:{Scene:class {},AUTO:0,Scale:{FIT:0,CENTER_BOTH:0}}}));
vi.mock('../src/core/physics',async importOriginal=>{const mod=await importOriginal<typeof import('../src/core/physics')>();return {...mod,traceShot:vi.fn(mod.traceShot)};});
import {PlayScene} from '../src/game/PlayScene';
import {traceShot} from '../src/core/physics';
import {BOARD_GEOMETRY} from '../src/content/game-config';
it('coalesces many slider changes into one draw per frame and retains the latest angle',()=>{
 const scene=new PlayScene();const draw=vi.fn();Object.assign(scene,{drawAim:draw,emitState:vi.fn()});
 for(let i=0;i<50;i++)scene.setAimDegrees(i);
 expect(draw).not.toHaveBeenCalled();scene.update(0,16);expect(draw).toHaveBeenCalledOnce();
 scene.update(0,16);expect(draw).toHaveBeenCalledOnce();
 expect((scene as unknown as {angle:number}).angle).toBeCloseTo(49*Math.PI/180);
});
it('reuses prediction until board, stagger or angle changes',()=>{
 vi.mocked(traceShot).mockClear();const scene=new PlayScene();
 const runtime=scene as unknown as {getShotTrace():unknown;gameState:{board:unknown[];rowOffset:number}};
 const first=runtime.getShotTrace();expect(runtime.getShotTrace()).toBe(first);expect(traceShot).toHaveBeenCalledOnce();
 scene.setAimDegrees(12);runtime.getShotTrace();expect(traceShot).toHaveBeenCalledTimes(2);
 runtime.gameState.board=[...runtime.gameState.board];runtime.getShotTrace();expect(traceShot).toHaveBeenCalledTimes(3);
 runtime.gameState.rowOffset=1;runtime.getShotTrace();expect(traceShot).toHaveBeenCalledTimes(4);
});
it('keeps fine steering held through a second-finger shot and blocks shots during flight',()=>{
 const scene=new PlayScene();const launch=vi.fn(()=>Object.assign(scene,{phase:'FLYING'}));
 Object.assign(scene,{drawAim:vi.fn(),emitState:vi.fn(),launch});scene.setFineRotation(100);
 scene.launchFromButton();scene.update(0,100);scene.launchFromButton();
 expect(launch).toHaveBeenCalledOnce();expect((scene as unknown as {angle:number}).angle).toBeCloseTo(6*Math.PI/180);
});
it('rotates the barrel while leaving the loaded symbol upright',()=>{
 const scene=new PlayScene();const barrel={setRotation:vi.fn()},orb={setRotation:vi.fn()};
 Object.assign(scene,{barrel,launcherOrb:orb,angle:.7,settings:{aimAssist:false},input:{setDefaultCursor:vi.fn()},aimGraphics:{clear:vi.fn()}});
 (scene as unknown as {drawAim():void}).drawAim();expect(barrel.setRotation).toHaveBeenCalledWith(.7);expect(orb.setRotation).not.toHaveBeenCalled();
});

it('starts the projectile along the rotating barrel axis',()=>{
 const scene=new PlayScene();scene.setAimDegrees(60);
 const trace=(scene as unknown as {getShotTrace():{points:Array<{x:number;y:number}>}}).getShotTrace();
 const origin=trace.points[0];
 expect((origin.x-BOARD_GEOMETRY.launcherX)/(BOARD_GEOMETRY.launcherY-origin.y)).toBeCloseTo(Math.tan(Math.PI/3));
});
