import { expect, it } from 'vitest';
import { countdownProgress } from '../src/game/countdown';
import { advanceTimed, createRound, freezeTimed, resetDescent, resumeTimed } from '../src/core/modes';

it('keeps shot and time progress independent between descents', () => {
  expect(countdownProgress('normal',0,30000,30000)).toEqual({remainingShots:10,shotPercent:100,timePercent:100});
  expect(countdownProgress('normal',40,24000,30000)).toEqual({remainingShots:6,shotPercent:60,timePercent:80});
  expect(countdownProgress('normal',40,15000,30000)).toEqual({remainingShots:6,shotPercent:60,timePercent:50});
  expect(countdownProgress('normal',90,-10,30000)).toEqual({remainingShots:1,shotPercent:10,timePercent:0});
});
it('uses the fixed cycle interval and restores both full bars after descent', () => {
  const state=createRound('normal','timed',300000,1000);
  state.danger=40;
  const middle=advanceTimed(state,16000);
  expect(middle.descentIntervalMs).toBe(30000);
  expect(countdownProgress('normal',middle.danger,middle.nextDescentAt!-16000,middle.descentIntervalMs!).timePercent).toBe(50);
  const dropped=advanceTimed(middle,31000);
  expect(dropped.descentIntervalMs).toBe(28500);
  expect(countdownProgress('normal',dropped.danger,dropped.nextDescentAt!-31000,dropped.descentIntervalMs!)).toEqual({remainingShots:10,shotPercent:100,timePercent:100});
  resetDescent(dropped,35000);
  expect(dropped.nextDescentAt!-35000).toBe(dropped.descentIntervalMs);
});
it('preserves the time-bar proportion through save and resume', () => {
  const state=createRound('hard','timed',600000,1000);
  state.danger=24;
  const saved=freezeTimed(state,7000);
  const resumed=resumeTimed(saved,1000000);
  expect(countdownProgress('hard',saved.danger,saved.nextDescentAt!-saved.timedSavedAt!,saved.descentIntervalMs!))
    .toEqual(countdownProgress('hard',resumed.danger,resumed.nextDescentAt!-1000000,resumed.descentIntervalMs!));
});
it('extends every difficulty at both ends of the game without changing shot counts', () => {
  for (const [id,initial,final,shots] of [['easy',36000,18000,13],['normal',30000,15000,10],['hard',24000,12000,9]] as const) {
    const state=createRound(id,'timed',300000,1000);
    expect(state.descentIntervalMs).toBe(initial);
    expect(countdownProgress(id,0,initial,initial).remainingShots).toBe(shots);
    state.elapsedMs=300000; resetDescent(state,301000);
    expect(state.descentIntervalMs).toBe(final);
  }
});
