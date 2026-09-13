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
 const param=()=>({value:1,cancelAndHoldAtTime:vi.fn(),cancelScheduledValues:vi.fn(),setTargetAtTime:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),exponentialRampToValueAtTime:vi.fn()});
 const gains:any[]=[],oscillators:any[]=[];
 const compressor={threshold:param(),knee:param(),ratio:param(),attack:param(),release:param(),connect:vi.fn()};
 const ctx={currentTime:0,state:'running',destination:{},createDynamicsCompressor:()=>compressor,
 createWaveShaper:vi.fn(()=>({curve:null as Float32Array|null,connect:vi.fn()})),
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
 const original=oscillators[0];audio.setScene('play');expect(original.stop).toHaveBeenLastCalledWith(.085);
 expect(gains[2].gain.cancelScheduledValues).toHaveBeenCalledWith(0);
 vi.advanceTimersByTime(100);expect(oscillators.length).toBe(2);
 const count=oscillators.length;audio.setScene('play');vi.advanceTimersByTime(100);expect(oscillators.length).toBe(count);
 audio.setForeground(false);audio.setScene('menu');audio.unlock();vi.advanceTimersByTime(3000);expect(oscillators.length).toBe(count);
 ctx.currentTime=10;audio.setForeground(true);expect(vi.getTimerCount()).toBe(1);
 expect(oscillators.at(-1).start).toHaveBeenCalledWith(10.04);audio.setForeground(false);
});

it('cancels future notes at zero and holds playing envelopes before fading',()=>{
 const {audio,ctx,gains}=audioFixture();
 expect(gains[2].gain.value).toBe(0);
 audio.setScene('play');expect(gains[2].gain.setValueAtTime).toHaveBeenLastCalledWith(0,0);
 vi.advanceTimersByTime(100);ctx.currentTime=.15;audio.setScene('menu');
 expect(gains[3].gain.cancelAndHoldAtTime).toHaveBeenCalledWith(.15);
 audio.setForeground(false);
});
it('does not schedule volume automation when unrelated settings change',()=>{
 const {audio,gains}=audioFixture();
 for(let i=0;i<100;i++)audio.setMix(50,50);
 expect(gains[0].gain.setTargetAtTime).not.toHaveBeenCalled();
 expect(gains[1].gain.setTargetAtTime).not.toHaveBeenCalled();audio.setForeground(false);
});
it('caps overlapping sounds and gives result sounds priority',()=>{
 const {audio,oscillators}=audioFixture();audio.blip('match');const match=oscillators.at(-1);
 audio.blip('drop');expect(match.stop.mock.lastCall[0]).toBeCloseTo(.03);
 audio.blip('win');audio.setScene('play');
 audio.blip('win');const result=oscillators.at(-1);audio.setScene('menu');
 expect(result.stop).toHaveBeenCalledTimes(1);
 const count=oscillators.length;audio.blip('shoot');expect(oscillators.length).toBe(count);
 audio.stopEffects();for(let i=0;i<100;i++)audio.blip('shoot');expect(oscillators.length).toBeLessThanOrEqual(9);
 audio.setForeground(false);
});
it('bounds the final output curve and starts music without a blip',()=>{
 const {audio,ctx,oscillators}=audioFixture();expect(oscillators.length).toBe(1);
 const curve=ctx.createWaveShaper.mock.results[0].value.curve!;
 expect(curve[2048]).toBe(0);expect(Math.max(...curve)).toBeLessThan(1);expect(Math.min(...curve)).toBeGreaterThan(-1);
 for(let i=1;i<curve.length;i++)expect(curve[i]).toBeGreaterThanOrEqual(curve[i-1]);
 audio.setForeground(false);
});
