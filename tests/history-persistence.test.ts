import { afterEach, expect, it, vi } from 'vitest';
import { createRound } from '../src/core/modes';
import { hasCompletedRound, loadHistory, recordRound } from '../src/storage/history';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function storage() {
  const values = new Map<string, string>(), events: string[] = [];
  const setItem = vi.fn((key: string, value: string) => { values.set(key, value); });
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem }, dispatchEvent: (event: Event) => { events.push(event.type); return true; } });
  return { values, setItem, events };
}
function result(id: string) {
  return { ...createRound('hard', 'endless'), sessionId: id, startedAt: 1, status: 'WON' as const, endReason: 'settled' as const, score: 123, step: 3, elapsedMs: 2000 };
}
it('keeps the first successful result, timestamp and rank when home or unload persists it again', () => {
  const local = storage(); vi.spyOn(Date, 'now').mockReturnValue(1000);
  const state = result('immutable'); expect(recordRound(state)).toBe(true);
  const first = structuredClone(loadHistory()), writes = local.setItem.mock.calls.length;
  vi.mocked(Date.now).mockReturnValue(9000);
  expect(recordRound({ ...state, score: 999, endReason: 'timeout' })).toBe(true);
  expect(recordRound(state, true)).toBe(true);
  expect(loadHistory()).toEqual(first); expect(local.setItem).toHaveBeenCalledTimes(writes);
});
it('returns a real write failure and can retry after storage recovers', () => {
  const local = storage(), state = result('retry');
  local.setItem.mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError'); });
  expect(recordRound(state)).toBe(false); expect(loadHistory()).toEqual({ recent: [], top: [] });
  expect(local.events).toEqual(['snood-storage-error']);
  vi.spyOn(Date, 'now').mockReturnValue(4000);
  expect(recordRound(state)).toBe(true);
  expect(loadHistory().recent[0]).toMatchObject({ id: 'retry', endedAt: 4000, result: 'SETTLED', score: 246 });
});
it('does not attempt a write for live games, campaign progress or empty abandonment', () => {
  const local = storage(), state = createRound('normal', 'endless'); state.sessionId = 'live';
  expect(recordRound(state)).toBe(false); expect(recordRound(state, true)).toBe(false);
  expect(recordRound({ ...result('campaign'), mode: 'campaign' })).toBe(false);
  expect(local.setItem).not.toHaveBeenCalled();
});
it('allows a resumed real result to replace an abandoned checkpoint but never the reverse', () => {
  storage(); const state = result('upgrade');
  expect(recordRound({ ...state, status: 'READY' }, true)).toBe(true);
  expect(loadHistory().top).toHaveLength(0);
  expect(recordRound(state)).toBe(true); expect(recordRound(state, true)).toBe(true);
  expect(loadHistory().recent).toHaveLength(1); expect(loadHistory().top[0].result).toBe('SETTLED');
});
it('recognizes a committed session after relaunch so a failed checkpoint deletion cannot replay it', () => {
  const local = storage(), state = result('closed-checkpoint');
  expect(recordRound(state)).toBe(true);
  const source = local.values.get('orbbound-history-v1')!;
  const read = vi.fn((key: string) => key === 'orbbound-history-v1' ? source : null);
  vi.stubGlobal('window', { localStorage: { getItem: read } });
  const checkpoint = { ...state, status: 'READY' as const };
  expect(hasCompletedRound(checkpoint)).toBe(true);
  expect(hasCompletedRound({ mode: 'endless', sessionId: 'still-active' })).toBe(false);
  expect(hasCompletedRound({ mode: 'campaign', sessionId: state.sessionId })).toBe(false);
});
it('keeps an abandoned checkpoint resumable when its discard did not complete', () => {
  storage(); const state = result('discard-failed');
  recordRound({ ...state, status: 'READY' }, true);
  expect(hasCompletedRound(state)).toBe(false);
});
