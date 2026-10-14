import type { GameState } from '../core/types';
import { scoreMultiplier, type GameMode } from '../core/modes';
import { LEGACY_RULES_VERSION, RULES_VERSION } from '../core/engine';
import { readStorage, writeStorage } from './safe-storage';

export interface RoundRecord {
  mode?: GameMode; durationMs?: number; rawScore?: number; multiplier?: number; rulesVersion?: string;
  id: string; score: number; difficulty: string; startedAt: number;
  endedAt: number; elapsedMs: number; shots: number; result: 'WON' | 'LOST' | 'ABANDONED' | 'TIMEOUT' | 'SETTLED';
}
export interface HistoryData { recent: RoundRecord[]; top: RoundRecord[] }
export type HistoryDifficulty = 'all' | 'easy' | 'normal' | 'hard';
export type HistoryRules = typeof LEGACY_RULES_VERSION | typeof RULES_VERSION;
const KEY = 'orbbound-history-v1';
let cachedRaw: string | null | undefined;
let cachedData: HistoryData | undefined;
export const rankingKey = (r: Pick<RoundRecord, 'mode' | 'durationMs'>): string => r.mode === 'timed' ? `timed-${r.durationMs}` : 'endless';
export const recordRules = (r: Pick<RoundRecord, 'rulesVersion'>): HistoryRules => r.rulesVersion === RULES_VERSION ? RULES_VERSION : LEGACY_RULES_VERSION;
export const rankingIdentity = (r: Pick<RoundRecord, 'mode' | 'durationMs' | 'rulesVersion'>): string => `${rankingKey(r)}:${recordRules(r)}`;
export const rulesLabel = (rules: string): string => rules === RULES_VERSION ? '新规则' : '旧规则';
export const compareRecords = (a: RoundRecord, b: RoundRecord): number => b.score - a.score || a.elapsedMs - b.elapsedMs || a.endedAt - b.endedAt;
function ranked(records: RoundRecord[]): RoundRecord[] {
  // Keep each difficulty's all-time ten. Their union also contains the overall
  // weighted ten, without losing filtered records when recent history rolls off.
  const buckets = new Map<string, RoundRecord[]>();
  for (const record of records) {
    if (record.result === 'ABANDONED') continue;
    const key = `${rankingIdentity(record)}:${record.difficulty}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(record); buckets.set(key, bucket);
  }
  return [...buckets.values()].flatMap(bucket => bucket.sort(compareRecords).slice(0, 10));
}
export function historyRecords(data: HistoryData, board: string, difficulty: HistoryDifficulty = 'all', rules: HistoryRules = RULES_VERSION): RoundRecord[] {
  return data.recent.filter(r => rankingKey(r) === board && recordRules(r) === rules && (difficulty === 'all' || r.difficulty === difficulty));
}
export function leaderboard(data: HistoryData, board: string, difficulty: HistoryDifficulty = 'all', rules: HistoryRules = RULES_VERSION): RoundRecord[] {
  return data.top.filter(r => rankingKey(r) === board && recordRules(r) === rules && (difficulty === 'all' || r.difficulty === difficulty))
    .sort(compareRecords).slice(0, 10);
}
export function roundStanding(data: HistoryData, state: GameState): { rank: number | null; best: number; difference: number; newRecord: boolean } {
  const rows = leaderboard(data, rankingKey(state), 'all', recordRules(state));
  const score = Math.round(state.score * scoreMultiplier(state.difficultyId));
  const previous = rows.filter(r => r.id !== state.sessionId);
  const best = Math.max(0, ...previous.map(r => r.score));
  const index = rows.findIndex(r => r.id === state.sessionId);
  return { rank: index < 0 ? null : index + 1, best, difference: score - best, newRecord: score > best };
}
export function mergeRecord(data: HistoryData, record: RoundRecord): HistoryData {
  const recent = [record, ...data.recent.filter(x => x.id !== record.id)]
    .sort((a, b) => b.endedAt - a.endedAt).slice(0, 500);
  const top = ranked([...data.top.filter(x => x.id !== record.id), record]);
  return { recent, top };
}
export function loadHistory(): HistoryData {
  try {
    const source = readStorage(KEY);
    if (source === cachedRaw && cachedData) return cachedData;
    const raw = JSON.parse(source ?? 'null');
    const valid = (x: RoundRecord) => x && typeof x.id === 'string' && ['easy','normal','hard'].includes(x.difficulty)
      && ['WON','LOST','ABANDONED','TIMEOUT','SETTLED'].includes(x.result)
      && (x.mode === undefined || x.mode === 'endless' || (x.mode === 'timed' && [300000,600000].includes(x.durationMs!)))
      && [x.score,x.startedAt,x.endedAt,x.elapsedMs,x.shots].every(n => Number.isFinite(n) && n >= 0)
      && x.startedAt <= 8_640_000_000_000_000 && x.endedAt <= 8_640_000_000_000_000
      && (x.rawScore === undefined || (Number.isFinite(x.rawScore) && x.rawScore >= 0))
      && (x.multiplier === undefined || [1,1.5,2].includes(x.multiplier))
      && (x.rulesVersion === undefined || [LEGACY_RULES_VERSION, RULES_VERSION].includes(x.rulesVersion));
    const migrate = (r: RoundRecord): RoundRecord => ({ ...(r.rawScore === undefined ? {...r, mode: r.mode ?? 'endless', rawScore:r.score,
      multiplier:scoreMultiplier(r.difficulty), score:Math.round(r.score*scoreMultiplier(r.difficulty))} : r), rulesVersion: recordRules(r) });
    const recent = Array.isArray(raw?.recent) ? raw.recent.filter(valid).slice(0,500).map(migrate) : [];
    const candidates: RoundRecord[] = [...recent, ...(Array.isArray(raw?.top) ? raw.top.filter(valid).map(migrate) : [])];
    cachedRaw = source;
    return cachedData = { recent, top: ranked([...new Map(candidates.map(r => [r.id,r])).values()]) };
  } catch { return { recent: [], top: [] }; }
}
export function recordRound(state: GameState, abandoned = false): void {
  if (state.mode === 'campaign') return;
  if (!abandoned && state.status === 'READY') return;
  if (!state.sessionId || (abandoned && state.step === 0)) return;
  const multiplier = scoreMultiplier(state.difficultyId);
  const record: RoundRecord = { id: state.sessionId, score: Math.round(state.score * multiplier), rawScore: state.score, multiplier,
    mode: state.mode ?? 'endless', durationMs: state.durationMs, difficulty: state.difficultyId, rulesVersion: state.rulesVersion,
    startedAt: state.startedAt ?? Date.now(), endedAt: Date.now(), elapsedMs: state.elapsedMs ?? 0,
    shots: state.step, result: abandoned ? 'ABANDONED' : state.endReason === 'timeout' ? 'TIMEOUT' : state.endReason === 'settled' ? 'SETTLED' : state.status === 'WON' ? 'WON' : 'LOST' };
  writeStorage(KEY, JSON.stringify(mergeRecord(loadHistory(), record)));
}
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2,'0')}:${(seconds % 60).toString().padStart(2,'0')}`;
}

