import type { GameState } from '../core/types';

const SAVE_KEY = 'orbbound-save-v1';
const TIMED_KEY = 'orbbound-timed-active-v2';
const SETTINGS_KEY = 'orbbound-settings-v1';
const HIGH_SCORE_KEY = 'orbbound-high-score-v1';

export interface Settings {
  sound: boolean;
  aimAssist: boolean;
  reducedMotion: boolean;
  independentLaunch: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sound: true,
  aimAssist: true,
  reducedMotion: false,
  independentLaunch: false,
};

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function loadSettings(): Settings {
  if (!storageAvailable()) return { ...DEFAULT_SETTINGS };
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS };
    const record = value as Partial<Settings>;
    return {
      sound: record.sound !== false,
      aimAssist: record.aimAssist !== false,
      reducedMotion: record.reducedMotion === true,
      independentLaunch: false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  if (!storageAvailable()) return;
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function saveGame(state: GameState): void {
  if (!storageAvailable() || state.status !== 'READY') return;
  try { window.localStorage.setItem(state.mode === 'timed' ? TIMED_KEY : SAVE_KEY, JSON.stringify(state)); }
  catch { window.dispatchEvent(new CustomEvent('snood-storage-error')); }
}

export function loadGame(mode: 'endless' | 'timed' = 'endless'): GameState | null {
  if (!storageAvailable()) return null;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(mode === 'timed' ? TIMED_KEY : SAVE_KEY) ?? 'null');
    if (!isGameState(value)) return null;
    return value;
  } catch {
    return null;
  }
}

export function hasLegacySave(): boolean {
  try { return JSON.parse(window.localStorage.getItem(SAVE_KEY) ?? 'null')?.rulesVersion === 'classic-v1'; }
  catch { return false; }
}

export function clearGame(mode: 'endless' | 'timed' = 'endless'): void {
  if (storageAvailable()) window.localStorage.removeItem(mode === 'timed' ? TIMED_KEY : SAVE_KEY);
}

export function getHighScore(): number {
  if (!storageAvailable()) return 0;
  const value = Number(window.localStorage.getItem(HIGH_SCORE_KEY) ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function setHighScore(score: number): void {
  if (!storageAvailable()) return;
  if (score > getHighScore()) window.localStorage.setItem(HIGH_SCORE_KEY, String(Math.floor(score)));
}

function isGameState(value: unknown): value is GameState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<GameState>;
  if (candidate.mode !== undefined && !['endless', 'timed'].includes(candidate.mode)) return false;
  if (candidate.mode === 'timed' && (![300000,600000].includes(candidate.durationMs!)
    || !Number.isFinite(candidate.deadlineAt) || !Number.isFinite(candidate.nextDescentAt))) return false;
  if (candidate.schemaVersion !== 1 || candidate.rulesVersion !== 'classic-v2') return false;
  if (candidate.rowOffset !== 0 && candidate.rowOffset !== 1) return false;
  if (!Array.isArray(candidate.board) || candidate.board.length !== 19) return false;
  if (!candidate.board.every((row) => Array.isArray(row) && row.length === 14 && row.every((cell) => cell === null || (typeof cell === 'number' && cell >= 0 && cell <= 5)))) return false;
  return candidate.status === 'READY'
    && typeof candidate.difficultyId === 'string'
    && typeof candidate.seed === 'number'
    && typeof candidate.rngState === 'number'
    && typeof candidate.score === 'number'
    && typeof candidate.danger === 'number'
    && typeof candidate.step === 'number'
    && typeof candidate.currentColor === 'number'
    && typeof candidate.nextColor === 'number';
}

