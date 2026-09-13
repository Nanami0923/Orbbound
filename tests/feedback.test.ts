import {afterEach,expect,it,vi} from 'vitest';
const pulse=vi.hoisted(()=>vi.fn(()=>Promise.resolve()));
vi.mock('@capacitor/core',()=>({Capacitor:{isNativePlatform:()=>true},registerPlugin:()=>({pulse})}));
import {haptic} from '../src/game/feedback';
import {DEFAULT_SETTINGS} from '../src/storage/storage';
afterEach(()=>{vi.unstubAllGlobals();pulse.mockClear();});
it('keeps vibration optional and controls shooting and matching independently',()=>{
 haptic('shoot',DEFAULT_SETTINGS);haptic('match',DEFAULT_SETTINGS);expect(pulse).not.toHaveBeenCalled();
 const settings={...DEFAULT_SETTINGS,hapticShoot:true};haptic('shoot',settings);haptic('match',settings);
 expect(pulse).toHaveBeenCalledOnce();expect(pulse).toHaveBeenCalledWith({duration:12});
});
it('never vibrates in the background',()=>{
 vi.stubGlobal('document',{hidden:true});haptic('match',{...DEFAULT_SETTINGS,hapticMatch:true});expect(pulse).not.toHaveBeenCalled();
});
