import { CAMPAIGN_LEVELS, type CampaignLevel } from '../content/campaign';
import { isUnlocked, type CampaignProgress } from '../storage/campaign';
import { formatDuration } from '../storage/history';
import type { GameState } from '../core/types';
import { getOrbTheme } from '../content/theme';

export function levelRules(level: CampaignLevel): string {
  return `${level.targets ? `清除 ${level.targets.length} 个白圈目标` : '清空棋盘'} · ${level.timeLimitMs ? `${level.timeLimitMs / 1000} 秒` : `${level.maxShots} 发以内`} · ${level.descentEvery ? `每 ${level.descentEvery} 发下移` : '不下压'}`;
}
export function starRules(level: CampaignLevel): string {
  return level.timeLimitMs ? `一星：通关 · 二星：${level.silver / 1000} 秒内 · 三星：${level.gold / 1000} 秒内`
    : `一星：通关 · 二星：${level.silver} 发内 · 三星：${level.gold} 发内`;
}
export function campaignMarkup(progress: CampaignProgress, saved: GameState | null): string {
  return `<button class="modal-close" data-close-modal type="button">关闭</button><p class="eyebrow">CAMPAIGN / 01—12</p><h2>循着回响，逐关向前</h2><p>通关即可解锁下一关。重试不消耗体力；同一关保留相同的布局和供球规则。</p>
    ${saved ? `<button id="campaign-resume" class="primary-button">继续第 ${saved.levelId} 关 · 已用 ${saved.step} 发</button>` : ''}
    ${[...new Set(CAMPAIGN_LEVELS.map(level => level.chapter))].map((chapter, index) => `<section class="campaign-chapter"><h3>0${index + 1} / ${chapter}</h3><div class="campaign-grid">${CAMPAIGN_LEVELS.filter(level => level.chapter === chapter).map(level => {
      const unlocked = isUnlocked(level.id, progress), record = progress[String(level.id)];
      return `<button class="level-tile" data-level="${level.id}" ${unlocked ? '' : 'disabled'} aria-label="第 ${level.id} 关 ${level.name}，${unlocked ? `${record?.stars ?? 0} 星` : '未解锁'}"><span class="level-number">${String(level.id).padStart(2, '0')}</span><strong>${level.name}</strong><small>${level.timeLimitMs ? '限时清空' : level.targets ? '目标球' : level.descentEvery ? '空间挑战' : '限发清空'}</small><span class="level-stars">${unlocked ? '★'.repeat(record?.stars ?? 0) + '☆'.repeat(3 - (record?.stars ?? 0)) : '待解锁'}</span></button>`;
    }).join('')}</div></section>`).join('')}`;
}
export function levelMarkup(level: CampaignLevel, progress: CampaignProgress, saved: GameState | null): string {
  const record = progress[String(level.id)];
  // Compact preview uses the exact stagger and target positions of the playable board.
  const preview = level.layout.map((row, r) => [...row].map((color, c) => color === '.' ? '' : `<circle cx="${16 + c * 16 + r % 2 * 8}" cy="${12 + r * 14}" r="6.8" fill="${getOrbTheme(Number(color)).cssColor}" ${level.targets?.some(cell => cell.row === r && cell.col === c) ? 'stroke="white" stroke-width="2"' : ''}/>`).join('')).join('');
  return `<button class="modal-close" data-close-modal>关闭</button><p class="eyebrow">${level.chapter} / ${String(level.id).padStart(2, '0')}</p><h2>${level.name}</h2><svg class="level-preview" viewBox="0 0 248 ${24 + level.layout.length * 14}" role="img" aria-label="第 ${level.id} 关棋盘预览">${preview}</svg><p><strong>${levelRules(level)}</strong></p><p>${level.hint}</p><p class="campaign-star-rules">${starRules(level)}</p>${record ? `<p>最佳：${record.stars} 星 · ${record.shots} 发 · ${formatDuration(record.elapsedMs)}</p>` : ''}${saved ? `<p class="mode-note">开始后将替换第 ${saved.levelId} 关的进行中存档，已获星级保留。</p>` : ''}<div class="modal-footer"><button id="campaign-begin" class="primary-button">开始第 ${level.id} 关 →</button><button id="campaign-back" class="quiet-button">返回选关</button></div>`;
}
