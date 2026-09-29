import levels from './campaign-levels.json';
import type { Cell } from '../core/types';

export interface CampaignLevel {
  id: number;
  chapter: string;
  name: string;
  hint: string;
  layout: string[];
  seed: number;
  maxShots: number;
  silver: number;
  gold: number;
  timeLimitMs?: number;
  descentEvery?: number;
  targets?: Cell[];
}

export const CAMPAIGN_REVISION = 2;
export const CAMPAIGN_LEVELS: CampaignLevel[] = levels;
export function getLevel(id: number): CampaignLevel {
  const level = CAMPAIGN_LEVELS.find(level => level.id === id);
  if (!level) throw new Error('关卡不存在');
  return level;
}
