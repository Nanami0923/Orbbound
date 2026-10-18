import { afterEach, expect, it, vi } from 'vitest';
import { scheduleLanFinish } from '../src/ui/lan-panel';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function clock() {
  vi.useFakeTimers();
  let now = 0;
  vi.stubGlobal('performance', { now: () => now });
  return (value: number) => { now = value; };
}

it('reaches the result without another session render when the first wake-up is early', () => {
  const time = clock(), result = vi.fn();
  scheduleLanFinish(2000, result);
  time(1999.75); vi.advanceTimersByTime(2000);
  expect(result).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
  time(2000.75); vi.advanceTimersByTime(1);
  expect(result).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(5000); expect(result).toHaveBeenCalledOnce();
});

it('rounds fractional waits up and retains a one-millisecond wake-up until the deadline', () => {
  const time = clock(), result = vi.fn(), timer = vi.spyOn(globalThis, 'setTimeout');
  time(10); scheduleLanFinish(12.4, result);
  expect(timer).toHaveBeenLastCalledWith(expect.any(Function), 3);
  time(12.3); vi.advanceTimersByTime(3);
  expect(timer).toHaveBeenLastCalledWith(expect.any(Function), 1); expect(result).not.toHaveBeenCalled();
  time(12.4); vi.advanceTimersByTime(1);
  expect(result).toHaveBeenCalledOnce();
});

it.each([false, true])('cancels a pending finish when leaving or replacing a result (afterEarlyWake=%s)', early => {
  const time = clock(), result = vi.fn(), cancel = scheduleLanFinish(2000, result);
  if (early) { time(1999.75); vi.advanceTimersByTime(2000); }
  cancel(); cancel(); expect(vi.getTimerCount()).toBe(0);
  time(10000); vi.advanceTimersByTime(10000); expect(result).not.toHaveBeenCalled();
});

it('completes an elapsed deadline immediately without leaving a timer behind', () => {
  const time = clock(), result = vi.fn();
  time(2000); const cancel = scheduleLanFinish(2000, result);
  expect(result).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  cancel(); vi.advanceTimersByTime(5000); expect(result).toHaveBeenCalledOnce();
});
