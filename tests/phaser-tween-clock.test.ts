import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import type Phaser from 'phaser';
import {afterEach,expect,it,vi} from 'vitest';
import {rebaseTweenClock} from '../src/game/tween-clock';

// Exercise the installed Phaser implementation, not a replacement tween mock.
const require=createRequire(import.meta.url);
const TweenManager=require('phaser/src/tweens/TweenManager') as new(scene:unknown)=>Phaser.Tweens.TweenManager & { start(): void };
afterEach(()=>vi.restoreAllMocks());

it.each([200,2000])('a %ims slept menu does not advance the real Phaser tween on resume',menuMs=>{
  let now=10_000;vi.spyOn(Date,'now').mockImplementation(()=>now);
  const manager=new TweenManager({sys:{events:new EventEmitter()}});
  manager.start();
  const target={x:0};manager.add({targets:target,x:100,duration:1000,ease:'Linear'});
  now+=10;manager.update();now+=100;manager.update();
  const before=target.x;expect(before).toBeGreaterThan(0);
  manager.pauseAll();now+=menuMs;rebaseTweenClock(manager);manager.resumeAll();
  now+=10;manager.update();
  expect(target.x-before).toBeCloseTo(1);expect(target.x).toBeLessThan(30);
});

it('a new tween after a slept scene receives only its new active-frame elapsed time',()=>{
  let now=10_000;vi.spyOn(Date,'now').mockImplementation(()=>now);
  const manager=new TweenManager({sys:{events:new EventEmitter()}});manager.start();now+=100;manager.update();
  manager.pauseAll();now+=2000;manager.killAll();rebaseTweenClock(manager);manager.resumeAll();
  const target={x:0};manager.add({targets:target,x:100,duration:1000,ease:'Linear'});
  now+=10;manager.update();now+=10;manager.update();
  expect(target.x).toBeCloseTo(1);
});
