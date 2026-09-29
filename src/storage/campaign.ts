import { CAMPAIGN_LEVELS } from '../content/campaign';
import { campaignStars } from '../core/campaign';
import type { GameState } from '../core/types';
import { readStorage, writeStorage } from './safe-storage';

export const LEGACY_PROGRESS_KEY = 'orbbound-campaign-progress-v1';
export const CAMPAIGN_PROGRESS_KEY = 'orbbound-campaign-progress-v2';
export interface LevelRecord { stars: number; shots: number; elapsedMs: number }
export type CampaignProgress = Record<string, LevelRecord>;
export function validProgress(value: unknown): value is CampaignProgress {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([id, record]) =>
    CAMPAIGN_LEVELS.some(level => String(level.id) === id) && record && typeof record === 'object'
    && Number.isInteger(record.stars) && record.stars >= 1 && record.stars <= 3
    && Number.isSafeInteger(record.shots) && record.shots > 0
    && Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
}
export function loadProgress(): CampaignProgress {
  try { const value = JSON.parse(readStorage(CAMPAIGN_PROGRESS_KEY) ?? '{}'); return validProgress(value) ? value : {}; }
  catch { return {}; }
}
export function loadLegacyProgress(): CampaignProgress {
  try { const value = JSON.parse(readStorage(LEGACY_PROGRESS_KEY) ?? '{}'); return validProgress(value) && Object.keys(value).every(id => Number(id) <= 12) ? value : {}; }
  catch { return {}; }
}
export function isUnlocked(id: number, progress = loadProgress()): boolean {
  return CAMPAIGN_LEVELS.some(level => level.id === id) && (id === 1 || !!progress[String(id - 1)] || (id <= 13 && Object.keys(loadLegacyProgress()).some(key => Number(key) >= id - 1)));
}
export function recordCampaign(state: GameState): void {
  const stars = campaignStars(state);
  if (!stars) return;
  const progress = loadProgress(), key = String(state.levelId), previous = progress[key];
  progress[key] = { stars: Math.max(stars, previous?.stars ?? 0), shots: Math.min(state.step, previous?.shots ?? Infinity),
    elapsedMs: Math.min(state.elapsedMs ?? 0, previous?.elapsedMs ?? Infinity) };
  writeStorage(CAMPAIGN_PROGRESS_KEY, JSON.stringify(progress));
}
