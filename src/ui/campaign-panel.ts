import { CAMPAIGN_LEVELS, type CampaignLevel } from '../content/campaign';
import { isUnlocked, loadLegacyProgress, type CampaignProgress } from '../storage/campaign';
import { formatDuration } from '../storage/history';
import type { GameState } from '../core/types';
import { getOrbTheme } from '../content/theme';
import { pageCapacity, viewportHeight } from './viewport-shell';

export function levelRules(level: CampaignLevel): string {
  return `${level.targets ? `清除 ${level.targets.length} 个白圈目标` : '清空棋盘'} · ${level.timeLimitMs ? `${level.timeLimitMs / 1000} 秒` : `${level.maxShots} 发以内`} · ${level.descentEvery ? `每 ${level.descentEvery} 发下移` : '不下压'}`;
}
export function starRules(level: CampaignLevel): string {
  return level.timeLimitMs ? `一星：通关 · 二星：${level.silver / 1000} 秒内 · 三星：${level.gold / 1000} 秒内`
    : `一星：通关 · 二星：${level.silver} 发内 · 三星：${level.gold} 发内`;
}
export function campaignPageSize(): number { return pageCapacity(viewportHeight(), 250, 96, 8, 2); }
export function campaignMarkup(progress: CampaignProgress, saved: GameState | null, page = 0, chapter = ''): string {
  const chapters = [...new Set(CAMPAIGN_LEVELS.map(level => level.chapter))];
  const selected = chapters.includes(chapter) ? chapter : chapters[0];
  const levels = CAMPAIGN_LEVELS.filter(level => level.chapter === selected), size = campaignPageSize();
  const current = Math.max(0, Math.min(page, Math.ceil(levels.length / size) - 1));
  const legacy = loadLegacyProgress();
  return `<button class="modal-close" data-close-modal type="button">关闭</button><h2>选择关卡</h2><div class="campaign-picker-toolbar"><label>章节<select id="campaign-chapter" aria-label="选择章节">${chapters.map((value,index) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${index + 1} · ${value}</option>`).join('')}</select></label>${saved ? `<button id="campaign-resume" class="quiet-button">继续第 ${saved.levelId} 关</button>` : ''}</div>
    <p class="mode-note">通关解锁下一关 · ${Object.keys(progress).length} / 30 关${Object.keys(legacy).length ? ' · 旧版解锁已继承' : ''}</p>
    <div class="campaign-grid">${levels.slice(current * size,(current + 1) * size).map(level => {
      const unlocked = isUnlocked(level.id, progress), record = progress[String(level.id)];
      return `<button class="level-tile" data-level="${level.id}" ${unlocked ? '' : 'disabled'} aria-label="第 ${level.id} 关 ${level.name}，${unlocked ? `${record?.stars ?? 0} 星` : '未解锁'}"><span class="level-number">${String(level.id).padStart(2,'0')}</span><strong>${level.name}</strong><span class="level-stars">${unlocked ? '★'.repeat(record?.stars ?? 0) + '☆'.repeat(3 - (record?.stars ?? 0)) : '待解锁'}</span></button>`;
    }).join('')}</div><nav class="page-navigation"><button id="campaign-prev" class="quiet-button" aria-label="上一页" ${current === 0 ? 'disabled' : ''}>‹</button><span>${current + 1} / ${Math.ceil(levels.length / size)}</span><button id="campaign-next" class="quiet-button" aria-label="下一页" ${(current + 1) * size >= levels.length ? 'disabled' : ''}>›</button></nav>`;
}
export function levelMarkup(level: CampaignLevel, progress: CampaignProgress, saved: GameState | null): string {
  const record = progress[String(level.id)];
  // Compact preview uses the exact stagger and target positions of the playable board.
  const preview = level.layout.map((row, r) => [...row].map((color, c) => {
    if (color === '.') return '';
    const theme = getOrbTheme(Number(color)), x = 16 + c * 16 + r % 2 * 8, y = 12 + r * 14;
    return `<g><circle cx="${x}" cy="${y}" r="6.8" fill="${theme.cssColor}" ${level.targets?.some(cell => cell.row === r && cell.col === c) ? 'stroke="white" stroke-width="2"' : ''}/><text x="${x}" y="${y}" fill="${theme.ink}" font-size="8" font-weight="700" text-anchor="middle" dominant-baseline="central">${theme.symbol}</text></g>`;
  }).join('')).join('');
  return `<button class="modal-close" data-close-modal>关闭</button><p class="eyebrow">${level.chapter} / ${String(level.id).padStart(2, '0')}</p><h2>${level.name}</h2><svg class="level-preview" viewBox="0 0 248 ${24 + level.layout.length * 14}" role="img" aria-label="第 ${level.id} 关棋盘预览，颜色与符号对应球类型，白圈为目标">${preview}</svg><p><strong>${levelRules(level)}</strong></p><p>${level.hint}</p><p class="campaign-star-rules">${starRules(level)}</p>${record ? `<p class="campaign-record">最高星级：${record.stars} 星<br>最少发数：${record.shots} 发 · 最快操作时间：${formatDuration(record.elapsedMs)}<small>各项纪录分别保留，可能来自不同对局。</small></p>` : ''}${saved ? `<p class="mode-note">开始后将替换第 ${saved.levelId} 关的进行中存档，已获星级保留。</p>` : ''}<div class="modal-footer"><button id="campaign-begin" class="primary-button">开始第 ${level.id} 关 →</button><button id="campaign-back" class="quiet-button">返回选关</button></div>`;
}
