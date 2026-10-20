import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createRoundFeedback } from '../src/ui/v5-feedback';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture(reduced = false) {
  const classes = () => {
    const values = new Set<string>();
    return { add: (value: string) => values.add(value), remove: (value: string) => values.delete(value), contains: (value: string) => values.has(value) };
  };
  const board = { ownerDocument: { defaultView: globalThis }, classList: classes() } as unknown as HTMLElement;
  const output = { hidden: true, textContent: '', offsetWidth: 0, classList: classes() } as unknown as HTMLElement;
  return { board, output, feedback: createRoundFeedback(board, output, () => reduced) };
}

it('announces real streaks once, refreshes their display lifetime, and clears them on a new round', () => {
  const f = fixture();
  f.feedback.combo(1); expect(f.output.hidden).toBe(true);
  f.feedback.combo(2); expect(f.output.textContent).toBe('连击 2'); expect(f.output.hidden).toBe(false);
  vi.advanceTimersByTime(1000); f.feedback.combo(3);
  vi.advanceTimersByTime(250); expect(f.output.hidden).toBe(false);
  vi.advanceTimersByTime(1000); expect(f.output.hidden).toBe(true);
  f.feedback.combo(4); f.feedback.reset(); expect(f.output.hidden).toBe(true);
});

it('shows the floor wave for 280ms before opening the outcome and calls it exactly once', () => {
  const f = fixture(), complete = vi.fn();
  f.feedback.finish(true, complete);
  expect(f.board.classList.contains('v5-failure-wave')).toBe(true);
  vi.advanceTimersByTime(279); expect(complete).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(complete).toHaveBeenCalledOnce();
  expect(f.board.classList.contains('v5-failure-wave')).toBe(false);
  vi.advanceTimersByTime(1000); expect(complete).toHaveBeenCalledOnce();
});

it('cancels stale outcome callbacks on navigation and respects reduced motion', () => {
  const f = fixture(), stale = vi.fn(), fresh = vi.fn();
  f.feedback.finish(true, stale); f.feedback.reset();
  vi.advanceTimersByTime(500); expect(stale).not.toHaveBeenCalled();
  f.feedback.finish(true, stale); f.feedback.finish(false, fresh);
  expect(fresh).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(500); expect(stale).not.toHaveBeenCalled();
  const reduced = fixture(true), complete = vi.fn();
  reduced.feedback.finish(true, complete); expect(complete).toHaveBeenCalledOnce();
  expect(reduced.board.classList.contains('v5-failure-wave')).toBe(false);
});
