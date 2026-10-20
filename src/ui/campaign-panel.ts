import { CAMPAIGN_LEVELS, type CampaignLevel } from '../content/campaign';
import { ORB_ARTWORK_GEOMETRY, orbArtworkSvgElements } from '../content/orb-symbol-artwork';
import { getOrbTheme } from '../content/theme';
import type { GameState } from '../core/types';
import type { ColorId } from '../core/types';
import { isUnlocked, loadLegacyProgress, type CampaignProgress } from '../storage/campaign';
import { formatDuration } from '../storage/history';
import { pageCapacity, viewportHeight } from './viewport-shell';
import './campaign-v51.css';

export function levelRules(level: CampaignLevel): string {
  return `${level.targets ? `清除 ${level.targets.length} 个白圈目标` : '清空棋盘'} · ${level.timeLimitMs ? `${level.timeLimitMs / 1000} 秒` : `${level.maxShots} 发以内`} · ${level.descentEvery ? `每 ${level.descentEvery} 发下移` : '不下压'}`;
}
export function starRules(level: CampaignLevel): string {
  return level.timeLimitMs ? `一星：通关 · 二星：${level.silver / 1000} 秒内 · 三星：${level.gold / 1000} 秒内`
    : `一星：通关 · 二星：${level.silver} 发内 · 三星：${level.gold} 发内`;
}
export function campaignPageSize(): number { return pageCapacity(viewportHeight(), 250, 96, 8, 2); }

const escapeMarkup = (text: string) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const chapters = () => [...new Set(CAMPAIGN_LEVELS.map(level => level.chapter))];
const chapterNumber = (chapter: string) => chapters().indexOf(chapter) + 1;
const chapterLevels = (chapter: string) => CAMPAIGN_LEVELS.filter(level => level.chapter === chapter);
const chapterClearCount = (chapter: string, progress: CampaignProgress) => chapterLevels(chapter).filter(level => !!progress[String(level.id)]).length;

function continuationMarkup(saved: GameState | null): string {
  if (!saved) return '';
  const level = CAMPAIGN_LEVELS.find(candidate => candidate.id === saved.levelId);
  if (!level) return '';
  const chapterLabel = `第 ${chapterNumber(level.chapter)} 章「${escapeMarkup(level.chapter)}」`;
  return `<button id="campaign-resume" class="campaign-resume" type="button" aria-label="继续存档，第 ${level.id} 关，${chapterLabel}"><span>继续存档 · 第 ${level.id} 关</span><small>${chapterLabel}</small><b aria-hidden="true">→</b></button>`;
}

/** Android's first layer replaces the native select with a keyboard-safe in-app chapter list. */
export function campaignChaptersMarkup(progress: CampaignProgress, saved: GameState | null, selectedChapter = ''): string {
  const orderedChapters = chapters();
  const selected = orderedChapters.includes(selectedChapter) ? selectedChapter : orderedChapters[0] ?? '';
  const completed = CAMPAIGN_LEVELS.filter(level => !!progress[String(level.id)]).length;
  const stars = Object.values(progress).reduce((sum, record) => sum + record.stars, 0);
  const legacy = loadLegacyProgress();
  const chapterRows = orderedChapters.map((chapter, index) => {
    const count = chapterClearCount(chapter, progress), levelCount = chapterLevels(chapter).length;
    const current = chapter === selected;
    return `<li><button type="button" class="campaign-chapter-row${current ? ' is-current' : ''}" data-campaign-chapter="${escapeMarkup(chapter)}" ${current ? 'aria-current="page"' : ''} aria-label="第 ${index + 1} 章，${escapeMarkup(chapter)}，已通关 ${count} / ${levelCount}${current ? '，当前浏览章节' : ''}"><span class="campaign-chapter-number">${String(index + 1).padStart(2, '0')}</span><span class="campaign-chapter-copy"><strong>${escapeMarkup(chapter)}</strong><small>已通关 ${count} / ${levelCount}</small></span><span class="campaign-chapter-current" aria-hidden="true">${current ? '当前' : ''}</span><span class="campaign-chapter-arrow" aria-hidden="true">›</span></button></li>`;
  }).join('');
  return `<header class="campaign-nav-header"><h2>选择章节</h2><button class="modal-close campaign-close" type="button">关闭</button></header>
    <p class="campaign-summary">已通关 ${completed} / ${CAMPAIGN_LEVELS.length} 关 · 已获 ${stars} / ${CAMPAIGN_LEVELS.length * 3} 星${Object.keys(legacy).length ? ' · 旧版解锁已继承' : ''}</p>
    <ol class="campaign-chapter-list" aria-label="章节列表">${chapterRows}</ol>${continuationMarkup(saved)}`;
}

/** Android's second layer shows one naturally-sized row per level, with no grid paging. */
export function campaignLevelsMarkup(progress: CampaignProgress, saved: GameState | null, chapter: string): string {
  const orderedChapters = chapters();
  const selected = orderedChapters.includes(chapter) ? chapter : orderedChapters[0] ?? '';
  const index = chapterNumber(selected), levels = chapterLevels(selected);
  const cleared = chapterClearCount(selected, progress);
  const rows = levels.map(level => {
    const unlocked = isUnlocked(level.id, progress), record = progress[String(level.id)];
    const accessible = unlocked ? record ? `已通关 ${record.stars} 星` : '尚未通关，可进入详情' : '锁定，待解锁';
    const state = !unlocked ? '<span class="campaign-level-state is-locked">待解锁</span>'
      : record ? `<span class="campaign-level-stars" aria-label="${record.stars} 星">${'★'.repeat(record.stars)}${'☆'.repeat(3 - record.stars)}</span>`
        : '<span class="campaign-level-state is-open">进入详情 <span aria-hidden="true">›</span></span>';
    return `<li><button type="button" class="campaign-level-row" data-level="${level.id}" ${unlocked ? '' : 'disabled aria-disabled="true"'} aria-label="第 ${level.id} 关 ${escapeMarkup(level.name)}，${accessible}"><span class="campaign-level-number">${String(level.id).padStart(2, '0')}</span><span class="campaign-level-name">${escapeMarkup(level.name)}</span>${state}</button></li>`;
  }).join('');
  return `<header class="campaign-nav-header"><button id="campaign-to-chapters" class="campaign-nav-back" type="button" aria-label="返回章节选择">‹ <span>章节</span></button><h2>${escapeMarkup(selected)}</h2><button class="modal-close campaign-close" type="button">关闭</button></header>
    <p class="campaign-summary">第 ${index} 章 · 已通关 ${cleared} / ${levels.length}</p>${continuationMarkup(saved)}
    <ol class="campaign-level-list" aria-label="${escapeMarkup(selected)}关卡列表">${rows}</ol>`;
}

export function campaignMarkup(progress: CampaignProgress, saved: GameState | null, page = 0, chapter = ''): string {
  const orderedChapters = chapters();
  const selected = orderedChapters.includes(chapter) ? chapter : orderedChapters[0] ?? '';
  const levels = chapterLevels(selected), size = campaignPageSize();
  const current = Math.max(0, Math.min(page, Math.ceil(levels.length / size) - 1));
  const legacy = loadLegacyProgress();
  return `<button class="modal-close" data-close-modal type="button">关闭</button><h2>选择关卡</h2><div class="campaign-picker-toolbar"><label>章节<select id="campaign-chapter" aria-label="选择章节">${orderedChapters.map((value,index) => `<option value="${escapeMarkup(value)}" ${value === selected ? 'selected' : ''}>${index + 1} · ${escapeMarkup(value)}</option>`).join('')}</select></label>${saved ? `<button id="campaign-resume" class="quiet-button">继续第 ${saved.levelId} 关</button>` : ''}</div>
    <p class="mode-note">通关解锁下一关 · ${Object.keys(progress).length} / ${CAMPAIGN_LEVELS.length} 关${Object.keys(legacy).length ? ' · 旧版解锁已继承' : ''}</p>
    <div class="campaign-grid">${levels.slice(current * size,(current + 1) * size).map(level => {
      const unlocked = isUnlocked(level.id, progress), record = progress[String(level.id)];
      return `<button class="level-tile" data-level="${level.id}" ${unlocked ? '' : 'disabled'} aria-label="第 ${level.id} 关 ${escapeMarkup(level.name)}，${unlocked ? `${record?.stars ?? 0} 星` : '未解锁'}"><span class="level-number">${String(level.id).padStart(2,'0')}</span><strong>${escapeMarkup(level.name)}</strong><span class="level-stars">${unlocked ? '★'.repeat(record?.stars ?? 0) + '☆'.repeat(3 - (record?.stars ?? 0)) : '待解锁'}</span></button>`;
    }).join('')}</div><nav class="page-navigation"><button id="campaign-prev" class="quiet-button" aria-label="上一页" ${current === 0 ? 'disabled' : ''}>‹</button><span>${current + 1} / ${Math.ceil(levels.length / size)}</span><button id="campaign-next" class="quiet-button" aria-label="下一页" ${(current + 1) * size >= levels.length ? 'disabled' : ''}>›</button></nav>`;
}

interface LevelMarkupOptions { android?: boolean }
export function levelMarkup(level: CampaignLevel, progress: CampaignProgress, saved: GameState | null, options: LevelMarkupOptions = {}): string {
  const record = progress[String(level.id)];
  // Reuse the canonical board artwork; target rings remain a separate white marker outside each sphere.
  const art = ORB_ARTWORK_GEOMETRY, scale = 0.43;
  const preview = level.layout.map((row, r) => [...row].map((rawColor, c) => {
    if (rawColor === '.') return '';
    const theme = getOrbTheme(Number(rawColor) as ColorId);
    const x = 16 + c * 16 + r % 2 * 8, y = 12 + r * 14, tx = x - art.center * scale, ty = y - art.center * scale;
    const target = level.targets?.some(cell => cell.row === r && cell.col === c);
    return `<g transform="translate(${tx} ${ty}) scale(${scale})">${target ? `<circle class="level-target-ring" cx="${art.center}" cy="${art.center}" r="20.5" fill="none" stroke="white" stroke-width="3.2"/>` : ''}${orbArtworkSvgElements(theme.id, theme.cssColor, theme.ink)}</g>`;
  }).join('')).join('');
  const previewSvg = `<svg class="level-preview" viewBox="0 0 248 ${24 + level.layout.length * 14}" role="img" aria-label="第 ${level.id} 关棋盘预览，球面图案表示颜色，白圈为目标">${preview}</svg>`;
  const savedLevel = saved ? CAMPAIGN_LEVELS.find(candidate => candidate.id === saved.levelId) : undefined;
  const replacement = savedLevel ? `<p class="mode-note">开始后将替换第 ${savedLevel.id} 关（第 ${chapterNumber(savedLevel.chapter)} 章「${escapeMarkup(savedLevel.chapter)}」）的进行中存档，已获星级保留。</p>` : '';
  const detail = `${previewSvg}<p><strong>${levelRules(level)}</strong></p><p>${escapeMarkup(level.hint)}</p><p class="campaign-star-rules">${starRules(level)}</p>${record ? `<p class="campaign-record">最高星级：${record.stars} 星<br>最少发数：${record.shots} 发 · 最快操作时间：${formatDuration(record.elapsedMs)}<small>各项纪录分别保留，可能来自不同对局。</small></p>` : ''}${replacement}`;
  if (options.android) {
    return `<header class="campaign-nav-header"><button id="campaign-detail-back" class="campaign-nav-back" type="button" aria-label="返回关卡列表">‹ <span>关卡</span></button><h2>${escapeMarkup(level.name)}</h2><button class="modal-close campaign-close" type="button">关闭</button></header>
      <section class="campaign-detail-scroll" aria-label="第 ${level.id} 关详情"><p class="eyebrow">第 ${level.id} 关 · ${escapeMarkup(level.chapter)}</p>${detail}</section>
      <div class="modal-footer"><button id="campaign-begin" class="primary-button" type="button">开始第 ${level.id} 关 →</button><button id="campaign-back" class="quiet-button" type="button">返回选关</button></div>`;
  }
  return `<button class="modal-close" data-close-modal type="button">关闭</button><p class="eyebrow">${escapeMarkup(level.chapter)} / ${String(level.id).padStart(2, '0')}</p><h2>${escapeMarkup(level.name)}</h2>${detail}<div class="modal-footer"><button id="campaign-begin" class="primary-button" type="button">开始第 ${level.id} 关 →</button><button id="campaign-back" class="quiet-button" type="button">返回选关</button></div>`;
}
