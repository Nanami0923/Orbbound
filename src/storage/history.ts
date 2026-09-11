import type { GameState } from '../core/types';

export interface RoundRecord {
  id: string; score: number; difficulty: string; startedAt: number;
  endedAt: number; elapsedMs: number; shots: number; result: 'WON' | 'LOST' | 'ABANDONED';
}
export interface HistoryData { recent: RoundRecord[]; top: RoundRecord[] }
const KEY = 'orbbound-history-v1';
export function mergeRecord(data: HistoryData, record: RoundRecord): HistoryData {
  const recent = [record, ...data.recent.filter(x => x.id !== record.id)]
    .sort((a, b) => b.endedAt - a.endedAt).slice(0, 500);
  const top = [...data.top.filter(x => x.id !== record.id), ...(record.result === 'ABANDONED' ? [] : [record])]
    .sort((a, b) => b.score - a.score || a.elapsedMs - b.elapsedMs || a.endedAt - b.endedAt).slice(0, 10);
  return { recent, top };
}
export function loadHistory(): HistoryData {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    const valid = (x: RoundRecord) => x && typeof x.id === 'string' && ['easy','normal','hard'].includes(x.difficulty)
      && ['WON','LOST','ABANDONED'].includes(x.result)
      && [x.score,x.startedAt,x.endedAt,x.elapsedMs,x.shots].every(n => Number.isFinite(n) && n >= 0);
    return { recent: Array.isArray(raw?.recent) ? raw.recent.filter(valid).slice(0,500) : [],
      top: Array.isArray(raw?.top) ? raw.top.filter(valid).slice(0,10) : [] };
  } catch { return { recent: [], top: [] }; }
}
export function recordRound(state: GameState, abandoned = false): void {
  if (!state.sessionId || (abandoned && state.step === 0)) return;
  const record: RoundRecord = { id: state.sessionId, score: state.score, difficulty: state.difficultyId,
    startedAt: state.startedAt ?? Date.now(), endedAt: Date.now(), elapsedMs: state.elapsedMs ?? 0,
    shots: state.step, result: abandoned ? 'ABANDONED' : state.status === 'WON' ? 'WON' : 'LOST' };
  try { localStorage.setItem(KEY, JSON.stringify(mergeRecord(loadHistory(), record))); }
  catch { window.dispatchEvent(new CustomEvent('snood-storage-error')); }
}
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60).toString().padStart(2,'0')}:${(seconds % 60).toString().padStart(2,'0')}`;
}

