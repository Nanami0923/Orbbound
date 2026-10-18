import { EventEmitter } from 'node:events';
import type Phaser from 'phaser';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('phaser', () => ({default:{Scene:class {},AUTO:0,Scale:{FIT:0,CENTER_BOTH:0}}}));
import { installPerformanceRuntime, type PerformanceReport } from '../src/game/runtime';
import { DEFAULT_SETTINGS } from '../src/storage/storage';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(cached?: unknown) {
  let clock = 0, steps = 0, elapsed = 0, idle = false;
  vi.spyOn(performance,'now').mockImplementation(() => clock);
  const target = Object.assign(new EventTarget(),{devicePixelRatio:1,localStorage:{getItem:()=>null},__orbboundPerformanceCapabilities:cached});
  vi.stubGlobal('window',target);
  vi.stubGlobal('document',Object.assign(new EventTarget(),{querySelector:()=>({getBoundingClientRect:()=>({width:640})})}));
  const events = new EventEmitter();
  const camera = {setZoom:vi.fn(function(){return camera;}),centerOn:vi.fn(()=>camera),preRender:vi.fn()};
  const current = {ready:true,get performanceIdle(){return idle;},cameras:{main:camera}};
  const scale = {setGameSize:vi.fn()};
  const original = {events,scale,scene:{getScene:()=>current,getScenes:()=>[current]},step:(_time:number,delta:number)=>{
    events.emit('prestep'); steps++; elapsed += delta; clock += 0.5; events.emit('postrender');
  }};
  const game = original as unknown as Phaser.Game;
  const reports: PerformanceReport[] = [];
  target.addEventListener('snood-performance',event=>reports.push((event as CustomEvent<PerformanceReport>).detail));
  installPerformanceRuntime(game);
  return {game,events,scale,camera,target,reports,get steps(){return steps;},get elapsed(){return elapsed;},set idle(value:boolean){idle=value;},
    frame(time:number){clock=time;game.step(time,1000/60);},settings(value:Partial<typeof DEFAULT_SETTINGS>){target.dispatchEvent(new CustomEvent('snood-performance-settings',{detail:{...DEFAULT_SETTINGS,...value}}));}};
}

it.each([144,165,240])('counts real Game.step and postrender at 120fps on %iHz',hz=>{
  const f=fixture(); f.settings({frameRate:120});
  for(let i=0;i<=hz*6;i++)f.frame(i*1000/hz);
  expect(f.steps).toBeGreaterThanOrEqual(719); expect(f.steps).toBeLessThanOrEqual(721);
  expect(f.reports.length).toBeGreaterThanOrEqual(5);
  for(const report of f.reports.slice(1)){
    expect(report.updateFps).toBeGreaterThanOrEqual(119);expect(report.updateFps).toBeLessThanOrEqual(121);
    expect(report.renderFps).toBe(report.updateFps);expect(report.targetFps).toBe(120);
  }
  f.events.emit('destroy');
});

it('reduces static READY rendering, keeps elapsed time, and wakes on the next pointer callback',()=>{
  const f=fixture(); f.idle=true;
  for(let i=0;i<=240;i++)f.frame(i*1000/120);
  const before=f.steps;
  for(let i=241;i<=360;i++)f.frame(i*1000/120);
  expect(f.steps-before).toBe(10);expect(f.elapsed).toBeGreaterThan(2900);
  f.target.dispatchEvent(new Event('pointerdown'));f.frame(3000+1000/120);
  expect(f.steps).toBe(before+11); f.events.emit('destroy');
});

it('continuous high-rate pointer movement cannot bypass the chosen frame cap',()=>{
  const f=fixture();f.settings({frameRate:60});
  for(let i=0;i<=240*3;i++){f.target.dispatchEvent(new Event('pointermove'));f.frame(i*1000/240);}
  expect(f.steps).toBe(181);expect(f.reports.at(-1)?.renderFps).toBe(60);
  f.events.emit('destroy');
});

it('does not bill modal time after an explicit scene resume reset',()=>{
  const f=fixture();f.frame(0);f.frame(1000/120);const elapsed=f.elapsed;
  f.target.dispatchEvent(new Event('snood-performance-reset'));f.frame(700);
  expect(f.elapsed).toBe(elapsed);f.events.emit('destroy');
});

it('retains a visible long-task time budget while producing no catch-up render burst',()=>{
  const f=fixture();f.frame(0);f.frame(2000);expect(f.elapsed).toBe(2000);
  const before=f.steps;f.frame(2001);expect(f.steps).toBe(before);f.events.emit('destroy');
});

it('switches quality on the existing game and camera while preserving world coordinates',()=>{
  const f=fixture();
  for(const multiplier of [1,1.5,2] as const){
    f.settings({quality:multiplier});
    expect(f.scale.setGameSize).toHaveBeenLastCalledWith(640*multiplier,760*multiplier);
    expect(f.camera.setZoom).toHaveBeenLastCalledWith(multiplier);
    expect(f.camera.centerOn).toHaveBeenLastCalledWith(320,380);
    expect(f.camera.preRender).toHaveBeenCalled();
    // Same displayed fractional position maps through viewport/zoom to the same world point.
    expect((0.75*640*multiplier-320*multiplier)/multiplier+320).toBe(480);
  }
  f.events.emit('destroy');
});

it('reports native energy state without automatically downgrading the selected frame cap',()=>{
  const f=fixture();
  f.target.dispatchEvent(new CustomEvent('orbbound-performance-capabilities',{detail:{refreshRate:120,powerSave:true,thermalStatus:null}}));
  for(let i=0;i<=240;i++)f.frame(i*1000/120);
  expect(f.reports.at(-1)?.targetFps).toBe(60);expect(f.reports.at(-1)?.requested).toBe(60);
  expect(f.reports.at(-1)?.reason).toBe('系统省电模式');
  f.events.emit('destroy');
});

it('applies cached native capabilities received before asynchronous engine boot',()=>{
  const f=fixture({refreshRate:60,supportedRefreshRates:[60,120]});
  for(let i=0;i<=240;i++)f.frame(i*1000/120);
  expect(f.steps).toBe(121);expect(f.reports.at(-1)?.targetFps).toBe(60);
  f.events.emit('destroy');
});

it.each([120,144,165,240])('defaults to 60 real updates on %iHz and distinguishes unknown display information', hz => {
  const f=fixture();
  for(let i=0;i<=hz*3;i++)f.frame(i*1000/hz);
  expect(f.steps).toBe(181);
  expect(f.reports.at(-1)).toMatchObject({requested:60,targetFps:60,renderFps:60,displayHz:null});
  f.events.emit('destroy');
});

it('keeps a manual 120 target under slow RAF callbacks instead of permanently downgrading it',()=>{
  const f=fixture(); f.settings({frameRate:120});
  for(let i=0;i<=90;i++)f.frame(i*1000/30);
  expect(f.reports.at(-1)).toMatchObject({requested:120,targetFps:120,renderFps:30,observedRafHz:30});
  expect(f.reports.at(-1)?.displayHz).toBeNull();
  f.events.emit('destroy');
});
