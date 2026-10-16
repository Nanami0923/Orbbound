import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loadLanHistory, loadPendingLanHistory, saveLanRecord, savePendingLanRecord } from '../src/storage/lan-history';
import { createMatch, finishMatch } from '../src/lan/authority';

let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('window', { localStorage: { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) }, dispatchEvent: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
const pending = { matchId: 'pending-match', selfId: 'guest', endedAt: 100, name: '球友', score: 120, completedWaves: 0,
  mode: 'score' as const, playerCount: 4, protocolVersion: 3, reason: 'left-spectating' as const };

it('keeps confirmed progress without inventing a final result after leaving observation', () => {
  savePendingLanRecord(pending); savePendingLanRecord({ ...pending, endedAt: 200 });
  expect(loadPendingLanHistory()).toEqual([{ ...pending, endedAt: 200 }]);
  expect(loadLanHistory()).toEqual([]); expect(loadPendingLanHistory()[0]).not.toHaveProperty('result');
});
it('replaces pending progress with an authoritative result and retains old two-player records', () => {
  savePendingLanRecord(pending);
  const snapshot = finishMatch(createMatch({ matchId: pending.matchId, difficultyId: 'normal', durationMs: 180000, seed: 42, playerIds: ['host', 'guest'] }), 'interrupted', 180000);
  const record = { resultId: snapshot.result!.resultId, matchId: snapshot.matchId, endedAt: 300, difficultyId: 'normal', durationMs: 180000,
    rulesHash: snapshot.rulesHash, selfId: 'guest', names: { host: '房主', guest: '球友' }, result: snapshot.result! };
  saveLanRecord(record); savePendingLanRecord(pending);
  expect(loadPendingLanHistory()).toEqual([]); expect(loadLanHistory()).toHaveLength(1);
  const legacy = { ...record.result } as unknown as Record<string, unknown>;
  delete legacy.winnerIds; delete legacy.ranking; delete legacy.terminationReason;
  values.set('orbbound-lan-history-v1', JSON.stringify([{ ...record, result: legacy }]));
  expect(loadLanHistory()[0].result.winnerId).toBeNull();
});
