import type { GameState } from '../core/types';
import { scoreMultiplier, type GameMode } from '../core/modes';

export interface RoundRecord {
  mode?: GameMode; durationMs?: number; rawScore?: number; multiplier?: number;
  id: string; score: number; difficulty: string; startedAt: number;
  endedAt: number; elapsedMs: number; shots: number; result: 'WON' | 'LOST' | 'ABANDONED' | 'TIMEOUT' | 'SETTLED';
}
export interface HistoryData { recent: RoundRecord[]; top: RoundRecord[] }
const KEY = 'orbbound-history-v1';
let cachedRaw: string | null | undefined;
let cachedData: HistoryData | undefined;
export const rankingKey = (r: Pick<RoundRecord, 'mode' | 'durationMs'>): string => r.mode === 'timed' ? `timed-${r.durationMs}` : 'endless';
function ranked(records: RoundRecord[]): RoundRecord[] {
  return ['endless', 'timed-300000', 'timed-600000'].flatMap(key => records.filter(r => rankingKey(r) === key && r.result !== 'ABANDONED')
    .sort((a,b) => b.score-a.score || a.elapsedMs-b.elapsedMs || a.endedAt-b.endedAt).slice(0,10));
}
export function mergeRecord(data: HistoryData, record: RoundRecord): HistoryData {
  const recent = [record, ...data.recent.filter(x => x.id !== record.id)]
    .sort((a, b) => b.endedAt - a.endedAt).slice(0, 500);
  const top = ranked([...data.top.filter(x => x.id !== record.id), record]);
  return { recent, top };
}
export function loadHistory(): HistoryData {
  try {
    const source = localStorage.getItem(KEY);
    if (source === cachedRaw && cachedData) return cachedData;
    const raw = JSON.parse(source ?? 'null');
    const valid = (x: RoundRecord) => x && typeof x.id === 'string' && ['easy','normal','hard'].includes(x.difficulty)
      && ['WON','LOST','ABANDONED','TIMEOUT','SETTLED'].includes(x.result)
      && (x.mode === undefined || x.mode === 'endless' || (x.mode === 'timed' && [300000,600000].includes(x.durationMs!)))
      && [x.score,x.startedAt,x.endedAt,x.elapsedMs,x.shots].every(n => Number.isFinite(n) && n >= 0)
      && x.startedAt <= 8_640_000_000_000_000 && x.endedAt <= 8_640_000_000_000_000
      && (x.rawScore === undefined || (Number.isFinite(x.rawScore) && x.rawScore >= 0))
      && (x.multiplier === undefined || [1,1.5,2].includes(x.multiplier));
    const migrate = (r: RoundRecord): RoundRecord => r.rawScore === undefined ? {...r, mode: r.mode ?? 'endless', rawScore:r.score,
      multiplier:scoreMultiplier(r.difficulty), score:Math.round(r.score*scoreMultiplier(r.difficulty))} : r;
    const recent = Array.isArray(raw?.recent) ? raw.recent.filter(valid).slice(0,500).map(migrate) : [];
    const candidates: RoundRecord[] = [...recent, ...(Array.isArray(raw?.top) ? raw.top.filter(valid).map(migrate) : [])];
    cachedRaw = source;
    return cachedData = { recent, top: ranked([...new Map(candidates.map(r => [r.id,r])).values()]) };
  } catch { return { recent: [], top: [] }; }
}
export function recordRound(state: GameState, abandoned = false): void {
  if (!abandoned && state.status === 'READY') return;
  if (!state.sessionId || (abandoned && state.step === 0)) return;
  const multiplier = scoreMultiplier(state.difficultyId);
  const record: RoundRecord = { id: state.sessionId, score: Math.round(state.score * multiplier), rawScore: state.score, multiplier,
    mode: state.mode ?? 'endless', durationMs: state.durationMs, difficulty: state.difficultyId,
    startedAt: state.startedAt ?? Date.now(), endedAt: Date.now(), elapsedMs: state.elapsedMs ?? 0,
    shots: state.step, result: abandoned ? 'ABANDONED' : state.endReason === 'timeout' ? 'TIMEOUT' : state.endReason === 'settled' ? 'SETTLED' : state.status === 'WON' ? 'WON' : 'LOST' };
  try { localStorage.setItem(KEY, JSON.stringify(mergeRecord(loadHistory(), record))); }
  catch { window.dispatchEvent(new CustomEvent('snood-storage-error')); }
}
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2,'0')}:${(seconds % 60).toString().padStart(2,'0')}`;
}

