import {afterEach,expect,it,vi} from 'vitest';
import {loadSettings,DEFAULT_SETTINGS} from '../src/storage/storage';
import {GameAudio} from '../src/game/audio';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('migrates mute and clamps saved volume while ignoring removed animation settings',()=>{
 let saved={sound:false,reducedMotion:true} as Record<string,unknown>;
 vi.stubGlobal('window',{localStorage:{getItem:()=>JSON.stringify(saved)}});
 expect(loadSettings()).toEqual({...DEFAULT_SETTINGS,volume:0});
 saved={volume:200,controlsSwapped:true};expect(loadSettings().volume).toBe(100);expect(loadSettings().controlsSwapped).toBe(true);
 saved={volume:-20};expect(loadSettings().volume).toBe(0);
});
it('starts a single music scheduler, controls master volume, and suspends in background',()=>{
 vi.useFakeTimers();
 const param=()=>({value:0,setTargetAtTime:vi.fn(),setValueAtTime:vi.fn(),linearRampToValueAtTime:vi.fn(),exponentialRampToValueAtTime:vi.fn()});
 const gains:Array<{gain:ReturnType<typeof param>}> = [];
 const ctx={currentTime:0,state:'running',destination:{},
 createGain:()=>{const node={gain:param(),connect:vi.fn(),disconnect:vi.fn()};gains.push(node);return node;},
 createOscillator:()=>({type:'sine',frequency:param(),connect:vi.fn(function(this:unknown){return this;}),disconnect:vi.fn(),start:vi.fn(),stop:vi.fn()}),
 resume:vi.fn(()=>Promise.resolve()),suspend:vi.fn(()=>Promise.resolve())};
 vi.stubGlobal('window',{AudioContext:class {constructor(){return ctx;}}});
 const audio=new GameAudio(DEFAULT_SETTINGS);audio.unlock();audio.unlock();
 expect(vi.getTimerCount()).toBe(1);expect(gains[0].gain.value).toBe(.5);
 audio.setVolume(0);expect(gains[0].gain.setTargetAtTime).toHaveBeenCalledWith(0,0,.02);
 audio.setForeground(false);expect(vi.getTimerCount()).toBe(0);expect(ctx.suspend).toHaveBeenCalledOnce();
 audio.setForeground(true);expect(vi.getTimerCount()).toBe(1);audio.setForeground(false);
});
