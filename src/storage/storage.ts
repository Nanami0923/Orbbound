import type { GameState } from '../core/types';
import { freezeTimed } from '../core/modes';

const SAVE_KEY = 'orbbound-save-v1';
const TIMED_KEY = 'orbbound-timed-active-v2';
const SETTINGS_KEY = 'orbbound-settings-v1';
const HIGH_SCORE_KEY = 'orbbound-high-score-v1';

export interface Settings {
  volume: number;
  musicVolume: number;
  sensitivity: number;
  centerSnap: boolean;
  hapticShoot: boolean;
  hapticMatch: boolean;
  controlOffset: number;
  fireSize: number;
  aimAssist: boolean;
  controlsSwapped: boolean;
  independentLaunch: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  volume: 50,
  musicVolume: 50,
  sensitivity: 100,
  centerSnap: true,
  hapticShoot: false,
  hapticMatch: false,
  controlOffset: 0,
  fireSize: 96,
  aimAssist: true,
  controlsSwapped: false,
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
    const record = value as Partial<Settings> & { sound?: boolean };
    const number = (value: unknown, fallback: number, min: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
    const oldVolume = number(record.volume, record.sound === false ? 0 : 50, 0, 100);
    return {
      musicVolume: number(record.musicVolume, oldVolume, 0, 100),
      sensitivity: number(record.sensitivity, 100, 50, 150),
      centerSnap: record.centerSnap !== false,
      hapticShoot: record.hapticShoot === true,
      hapticMatch: record.hapticMatch === true,
      controlOffset: number(record.controlOffset, 0, 0, 48),
      fireSize: number(record.fireSize, 96, 76, 120),
      volume: oldVolume,
      aimAssist: record.aimAssist !== false,
      controlsSwapped: record.controlsSwapped === true,
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
  try { window.localStorage.setItem(state.mode === 'timed' ? TIMED_KEY : SAVE_KEY, JSON.stringify(freezeTimed(state))); }
  catch { window.dispatchEvent(new CustomEvent('snood-storage-error')); }
}

export function loadGame(mode: 'endless' | 'timed' = 'endless'): GameState | null {
  if (!storageAvailable()) return null;
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(mode === 'timed' ? TIMED_KEY : SAVE_KEY) ?? 'null');
    if (!isGameState(value)) return null;
    // Upgrade the last 2.0 checkpoint without consuming time while the app was closed.
    if (value.mode === 'timed' && value.timedSavedAt === undefined) {
      return freezeTimed(value, value.deadlineAt! - value.durationMs! + (value.elapsedMs ?? 0));
    }
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
  if (candidate.timedSavedAt !== undefined && !Number.isFinite(candidate.timedSavedAt)) return false;
  if (candidate.descentIntervalMs !== undefined && (!Number.isFinite(candidate.descentIntervalMs) || candidate.descentIntervalMs <= 0)) return false;
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

