import {afterEach,expect,it,vi} from 'vitest';
import {loadSettings,DEFAULT_SETTINGS} from '../src/storage/storage';
import {GameAudio,MUSIC} from '../src/game/audio';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('migrates the old volume to both channels, clamps new controls and preserves mute',()=>{
 let saved={sound:false,reducedMotion:true} as Record<string,unknown>;
 vi.stubGlobal('window',{localStorage:{getItem:()=>JSON.stringify(saved)}});
 expect(loadSettings()).toEqual({...DEFAULT_SETTINGS,volume:0,musicVolume:0});
 saved={volume:200,controlsSwapped:true};expect(loadSettings().volume).toBe(100);expect(loadSettings().musicVolume).toBe(100);
 saved={volume:20,musicVolume:0,sensitivity:900,fireSize:500,controlOffset:-20};
 expect(loadSettings()).toMatchObject({volume:20,musicVolume:0,sensitivity:150,fireSize:120,controlOffset:0});
});
function audioFixture() {
 vi.useFakeTimers();
 const param=()=>({value:0,cancelScheduledValues:vi.fn(),setTargetAtTime:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),exponentialRampToValueAtTime:vi.fn()});
 const gains:any[]=[],oscillators:any[]=[];
 const compressor={threshold:param(),knee:param(),ratio:param(),attack:param(),release:param(),connect:vi.fn()};
 const ctx={currentTime:0,state:'running',destination:{},createDynamicsCompressor:()=>compressor,
 createGain:()=>{const node={gain:param(),connect:vi.fn(function(this:unknown){return this;}),disconnect:vi.fn()};gains.push(node);return node;},
 createOscillator:()=>{const osc={type:'sine',frequency:param(),connect:vi.fn(function(this:unknown){return this;}),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn()};oscillators.push(osc);return osc;},
 resume:vi.fn(()=>Promise.resolve()),suspend:vi.fn(()=>Promise.resolve())};
 vi.stubGlobal('window',{AudioContext:class {constructor(){return ctx;}}});
 const audio=new GameAudio(DEFAULT_SETTINGS);audio.unlock();
 return {audio,ctx,gains,oscillators};
}
it('independently mutes music and effects without creating duplicate schedulers',()=>{
 const {audio,ctx,gains,oscillators}=audioFixture();audio.unlock();expect(vi.getTimerCount()).toBe(1);
 audio.setMix(100,0);expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1.6,0,.025);
 expect(gains[1].gain.setTargetAtTime).toHaveBeenLastCalledWith(0,0,.08);
 const count=oscillators.length;audio.blip('shoot');expect(oscillators.length).toBe(count+1);
 audio.setMix(0,60);audio.blip('match');expect(oscillators.length).toBe(count+1);
 audio.setForeground(false);expect(ctx.suspend).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it('changes melodies and tempo, retires queued voices and never restarts in background',()=>{
 const {audio,ctx,gains,oscillators}=audioFixture();
 expect(MUSIC.play.step).toBeLessThan(MUSIC.menu.step);expect(MUSIC.play.notes).not.toEqual(MUSIC.menu.notes);
 const original=oscillators[0];audio.setScene('play');expect(original.stop).toHaveBeenLastCalledWith(.09);
 expect(gains[2].gain.cancelScheduledValues).toHaveBeenCalledWith(0);
 vi.advanceTimersByTime(100);expect(oscillators.length).toBe(2);
 const count=oscillators.length;audio.setScene('play');vi.advanceTimersByTime(100);expect(oscillators.length).toBe(count);
 audio.setForeground(false);audio.setScene('menu');audio.unlock();vi.advanceTimersByTime(3000);expect(oscillators.length).toBe(count);
 ctx.currentTime=10;audio.setForeground(true);expect(vi.getTimerCount()).toBe(1);
 expect(oscillators.at(-1).start).toHaveBeenCalledWith(10.04);audio.setForeground(false);
});
