import { afterEach, expect, it, vi } from 'vitest';
import { createCampaign } from '../src/core/campaign';
import { getLevel } from '../src/content/campaign';
import { campaignChaptersMarkup, campaignLevelsMarkup, levelMarkup } from '../src/ui/campaign-panel';
import type { CampaignProgress } from '../src/storage/campaign';

afterEach(() => { vi.unstubAllGlobals(); });

function storage() {
  const values = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal('window', { localStorage });
  vi.stubGlobal('localStorage', localStorage);
}

const progress: CampaignProgress = {
  '6': { stars: 1, shots: 30, elapsedMs: 60_000 },
  '7': { stars: 2, shots: 24, elapsedMs: 48_000 },
};

it('renders chapter progress and labels a saved level by its actual chapter when browsing elsewhere', () => {
  storage();
  const markup = campaignChaptersMarkup(progress, createCampaign(7), '进阶起点');
  expect([...markup.matchAll(/data-campaign-chapter=/g)]).toHaveLength(5);
  expect(markup).toContain('已通关 2 / 30 关 · 已获 3 / 90 星');
  expect(markup).toContain('data-campaign-chapter="进阶起点" aria-current="page"');
  expect(markup).toContain('继续存档 · 第 7 关');
  expect(markup).toContain('第 2 章「路径拆解」');
  expect(markup).not.toContain('<select');
});

it('renders each chapter as six ordered single-column rows with real stars and unlock state', () => {
  storage();
  const markup = campaignLevelsMarkup(progress, null, '路径拆解');
  expect([...markup.matchAll(/data-level="(\d+)"/g)].map(match => Number(match[1]))).toEqual([7, 8, 9, 10, 11, 12]);
  expect(markup).toContain('aria-label="第 7 关 交错阵列，已通关 2 星"');
  expect(markup).toContain('★★☆');
  const level8 = markup.match(/<button[^>]*data-level="8"[^>]*>/)?.[0] ?? '';
  const level9 = markup.match(/<button[^>]*data-level="9"[^>]*>/)?.[0] ?? '';
  expect(level8).not.toContain('disabled');
  expect(level9).toContain('disabled');
  expect(markup).toContain('待解锁');
  expect(markup).not.toContain('campaign-grid');
  expect(markup).not.toContain('page-navigation');
});

it('uses the shared symbol paths and preserves the separate white target ring in detail preview', () => {
  storage();
  const markup = levelMarkup(getLevel(9), progress, null, { android: true });
  expect(markup).toContain('class="campaign-detail-scroll"');
  expect(markup).toContain('<path d=');
  expect(markup).not.toContain('<text');
  expect([...markup.matchAll(/class="level-target-ring"/g)]).toHaveLength(4);
  expect(markup).toContain('aria-label="第 9 关棋盘预览，球面图案表示颜色，白圈为目标"');
});
