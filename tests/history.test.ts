import { describe, it, expect } from 'vitest';
import { mergeRecord, formatDuration, type RoundRecord } from '../src/storage/history';
const make = (i: number): RoundRecord => ({ id: String(i), score: i, difficulty: 'normal', startedAt: 1, endedAt: i, elapsedMs: 1000, shots: 3, result: 'LOST' });
describe('local history', () => {
  it('bounds history and preserves all-time top ten', () => {
    let data = { recent: [] as RoundRecord[], top: [] as RoundRecord[] };
    for (let i = 600; i >= 0; i--) data = mergeRecord(data, make(i));
    expect(data.recent).toHaveLength(500); expect(data.top).toHaveLength(10);
    expect(data.top[0].score).toBe(600);
  });
  it('deduplicates and excludes abandoned rounds from ranking', () => {
    const a = make(1); let data = mergeRecord({recent:[],top:[]}, a);
    data = mergeRecord(data, a); expect(data.recent).toHaveLength(1);
    data = mergeRecord(data, {...make(2), result:'ABANDONED'});
    expect(data.top).toHaveLength(1); expect(data.recent).toHaveLength(2);
  });
  it('formats active duration', () => { expect(formatDuration(125000)).toBe('02:05'); });
});

