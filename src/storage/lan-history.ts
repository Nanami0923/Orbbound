import { readStorage, writeStorage } from './safe-storage';
import type { MatchResult } from '../lan/protocol';

export interface LanRecord {
  resultId: string; matchId: string; endedAt: number; difficultyId: string; durationMs: number;
  rulesHash: string; selfId: string; names: Record<string, string>; result: MatchResult;
  mode?: 'score' | 'battle';
  protocolVersion?: number;
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
  writeStorage(PENDING_KEY, JSON.stringify(loadPendingLanHistory().filter(r => r.matchId !== record.matchId)));
}

export interface PendingLanRecord {
  matchId: string; endedAt: number; selfId: string; name: string; score: number; completedWaves: number;
  mode: 'score' | 'battle'; playerCount: number; protocolVersion: number; reason: 'left-active' | 'left-spectating';
}
const PENDING_KEY = 'orbbound-lan-pending-v1';
export function loadPendingLanHistory(): PendingLanRecord[] {
  try {
    const raw: unknown = JSON.parse(readStorage(PENDING_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((r: PendingLanRecord) => r && typeof r.matchId === 'string' && typeof r.selfId === 'string'
      && typeof r.name === 'string' && Number.isFinite(r.endedAt) && Number.isSafeInteger(r.score) && r.score >= 0
      && Number.isSafeInteger(r.completedWaves) && r.completedWaves >= 0 && [2, 3, 4].includes(r.playerCount)
      && ['score', 'battle'].includes(r.mode) && ['left-active', 'left-spectating'].includes(r.reason)).slice(0, 100) : [];
  } catch { return []; }
}
export function savePendingLanRecord(record: PendingLanRecord): void {
  if (loadLanHistory().some(item => item.matchId === record.matchId)) return;
  writeStorage(PENDING_KEY, JSON.stringify([record, ...loadPendingLanHistory().filter(r => r.matchId !== record.matchId)].slice(0, 100)));
}

const RECENT_KEY = 'orbbound-lan-recent-v1';
export interface RecentLanAddress { address: string; port: number; name: string; connectedAt: number }
export function recentLanAddresses(): RecentLanAddress[] {
  try {
    const raw: unknown = JSON.parse(readStorage(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((r: RecentLanAddress) => r && typeof r.address === 'string' && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(r.address)
      && Number.isInteger(r.port) && r.port > 0 && r.port <= 65535 && typeof r.name === 'string' && Number.isFinite(r.connectedAt)).slice(0, 8) : [];
  } catch { return []; }
}
export function rememberLanAddress(address: string, port: number, name: string): void {
  writeStorage(RECENT_KEY, JSON.stringify([{ address, port, name: name.slice(0, 96), connectedAt: Date.now() },
    ...recentLanAddresses().filter(r => r.address !== address || r.port !== port)].slice(0, 8)));
}
