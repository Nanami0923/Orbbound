import {afterEach,expect,it,vi} from 'vitest';
import windowsManifest from '../electron/windows-package.json';
import appManifest from '../package.json';
import { readFileSync } from 'node:fs';
vi.mock('@capacitor/core',()=>({Capacitor:{isNativePlatform:()=>true},registerPlugin:()=>({pulse:vi.fn()})}));
import {usesButtonControls} from '../src/game/input-mode';
import {PlayScene} from '../src/game/PlayScene';
vi.mock('phaser',()=>({default:{Scene:class {},AUTO:0,Scale:{FIT:0,CENTER_BOTH:0}}}));
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('each platform version matches its native package metadata',()=>{
 expect(readFileSync('android/app/build.gradle','utf8')).toContain(`versionName "${appManifest.version}"`);
 expect(readFileSync('windows/app.manifest','utf8')).toContain(`version="${windowsManifest.version}.0"`);
});
it('Windows always retains desktop input even on a narrow touch display',()=>{
 vi.stubEnv('MODE','windows');vi.stubGlobal('window',{matchMedia:()=>({matches:true})});
 expect(usesButtonControls()).toBe(false);
});
it('Windows V5 reserves an inner gutter for both countdown tracks without capping their real fill',()=>{
 const css=readFileSync('src/ui/windows-v5.css','utf8');
 expect(css).toContain('html.desktop-ui.windows-v5 .game-screen .game-header');
 expect(css).toContain('padding-right: clamp(12px, 1.5vw, 20px);');
 expect(css).toMatch(/html\.windows-v5 \.danger-meter \{[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*box-sizing: border-box;/s);
 expect(css).toMatch(/html\.windows-v5 #descent-time-row \.danger-meter \{[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*box-sizing: border-box;/s);
 expect(css).not.toMatch(/#danger-fill\s*\{[^}]*max-width\s*:\s*(?:90|95)%/s);
});
it('explicit development previews use the requested platform rather than the viewport width',()=>{
 vi.stubEnv('MODE','development');vi.stubEnv('DEV',true);
 vi.stubGlobal('window',{location:{search:'?platform=windows'},matchMedia:()=>({matches:true})});
 expect(usesButtonControls()).toBe(false);
 vi.stubGlobal('window',{location:{search:'?platform=android'},matchMedia:()=>({matches:false})});
 expect(usesButtonControls()).toBe(true);
});
it('Windows removes the independent current-color copy and retains the loaded cannon ball',()=>{
 vi.stubEnv('MODE','windows');const scene=new PlayScene();
 Object.assign(scene.activeState,{currentColor:0,nextColor:1});
 const createOrb=vi.fn(()=>({setScale:vi.fn(),setRotation:vi.fn()}));
 const graphics={clear:vi.fn().mockReturnThis(),fillStyle:vi.fn().mockReturnThis(),fillCircle:vi.fn().mockReturnThis(),lineStyle:vi.fn().mockReturnThis(),strokeCircle:vi.fn().mockReturnThis()};
 Object.assign(scene,{createOrb,launcherBase:graphics,settings:{aimAssist:false}});
 (scene as unknown as {renderLauncher():void}).renderLauncher();
 expect(createOrb).toHaveBeenCalledExactlyOnceWith(scene.activeState.currentColor,{x:320,y:708});
 expect(readFileSync('index.html','utf8')).toContain('id="next-orb-preview"');
});
