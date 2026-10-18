import { expect, it } from 'vitest';
import { PresentationClock } from '../src/lan/presentation-clock';

const sample = { matchId: 'first', epoch: 1, phase: 'playing', time: 1500, end: 10000, sampledAt: 100 };

it('uses the absolute logical origin and stays monotonic when a delayed update is behind the display', () => {
  const clock = new PresentationClock();
  expect(clock.sample(sample, 100)).toBe(1500);
  expect(clock.sample(sample, 117)).toBe(1517);
  expect(clock.sample({ ...sample, time: 1508, sampledAt: 120 }, 120)).toBe(1517);
  expect(clock.sample({ ...sample, time: 1508, sampledAt: 120 }, 140)).toBe(1528);
  expect(clock.sample(sample, 10000)).toBe(2700);
});

it('freezes at the authoritative boundary and resets extrapolation for an epoch or match change', () => {
  const clock = new PresentationClock();
  expect(clock.sample(sample, 130)).toBe(1530);
  expect(clock.sample({ ...sample, phase: 'paused', epoch: 2 }, 140)).toBe(1500);
  expect(clock.sample({ ...sample, phase: 'paused', epoch: 2 }, 4000)).toBe(1500);
  expect(clock.sample({ ...sample, epoch: 3, sampledAt: 4000 }, 4017)).toBe(1517);
  expect(clock.sample({ ...sample, matchId: 'second', time: 0, sampledAt: 5000 }, 5017)).toBe(17);
});

it('caps terminal animation time without advancing the final authoritative value', () => {
  const clock = new PresentationClock(), ended = { ...sample, phase: 'finished', time: 1700 };
  expect(clock.sample(ended, 200)).toBe(1700);
  expect(clock.sample(ended, 700)).toBe(2200);
  expect(clock.sample(ended, 5000)).toBe(3700);
  expect(ended.time).toBe(1700);
});
