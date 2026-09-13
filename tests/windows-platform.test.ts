import {afterEach,expect,it,vi} from 'vitest';
vi.mock('@capacitor/core',()=>({Capacitor:{isNativePlatform:()=>true},registerPlugin:()=>({pulse:vi.fn()})}));
import {usesButtonControls} from '../src/game/input-mode';
import {PlayScene} from '../src/game/PlayScene';
vi.mock('phaser',()=>({default:{Scene:class {},AUTO:0,Scale:{FIT:0,CENTER_BOTH:0}}}));
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('Windows always retains desktop input even on a narrow touch display',()=>{
 vi.stubEnv('MODE','windows');vi.stubGlobal('window',{matchMedia:()=>({matches:true})});
 expect(usesButtonControls()).toBe(false);
});
it('Windows keeps the side orb as current color with the new rotating launcher',()=>{
 vi.stubEnv('MODE','windows');const scene=new PlayScene();
 const createOrb=vi.fn(()=>({setScale:vi.fn(),setRotation:vi.fn()}));
 const graphics={clear:vi.fn(),fillStyle:vi.fn(),fillCircle:vi.fn(),lineStyle:vi.fn(),strokeCircle:vi.fn()};
 Object.assign(scene,{createOrb,launcherBase:graphics,settings:{aimAssist:false}});
 (scene as unknown as {renderLauncher():void}).renderLauncher();
 expect(createOrb).toHaveBeenNthCalledWith(1,scene.activeState.currentColor,{x:478,y:698});
 expect(createOrb).toHaveBeenCalledTimes(2);
});
