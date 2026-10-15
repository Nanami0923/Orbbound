import { readStorage, writeStorage } from './safe-storage';
import type { MatchResult } from '../lan/protocol';

export interface LanRecord {
  resultId: string; matchId: string; endedAt: number; difficultyId: string; durationMs: number;
  rulesHash: string; selfId: string; names: Record<string, string>; result: MatchResult;
}
const KEY = 'orbbound-lan-history-v1';
export function loadLanHistory(): LanRecord[] {
  try {
    const raw: unknown = JSON.parse(readStorage(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((r: LanRecord) => r && typeof r.resultId === 'string' && r.result?.resultId === r.resultId
      && typeof r.selfId === 'string' && r.result.players?.[r.selfId] && Number.isFinite(r.endedAt)).slice(0, 100) : [];
  } catch { return []; }
}
export function saveLanRecord(record: LanRecord): void {
  writeStorage(KEY, JSON.stringify([record, ...loadLanHistory().filter(r => r.resultId !== record.resultId)].slice(0, 100)));
}
