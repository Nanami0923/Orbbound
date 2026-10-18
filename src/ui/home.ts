import { loadProgress } from '../storage/campaign';
import { CAMPAIGN_LEVELS } from '../content/campaign';
import { loadGame } from '../storage/storage';
import { loadHistory, leaderboard, formatDuration } from '../storage/history';
import { homeDemoMarkup } from './home-demo';

export function buildHome(touch: boolean): void {
  document.querySelector('.hero-copy .eyebrow')?.remove();
  document.querySelector('.hero-notes')?.remove();
  document.querySelector('.hero-description')!.textContent = '同色连接 · 切断支撑 · 连锁坠落';
  document.querySelector('.home-card')!.innerHTML = `
    ${homeDemoMarkup(touch)}
    <div class="home-actions mobile-mode-cards">
      <div class="mode-card campaign"><button id="campaign-button" class="mode-main" type="button"><b class="mode-symbol">◇</b><span><strong>闯关模式</strong><small>固定棋盘 · 逐关解锁 · 星级挑战</small><small id="campaign-progress" class="mode-best"></small></span><b class="mode-action">选关 →</b></button></div>
      ${(['endless', 'timed'] as const).map(mode => `<div class="mode-card ${mode}">
        <button id="${mode === 'endless' ? 'start' : 'timed'}-button" class="mode-main" type="button">
          <b class="mode-symbol">${mode === 'endless' ? '∞' : '◷'}</b><span><strong>${mode === 'endless' ? '无尽模式' : '限时模式'}</strong><small data-mode-description="${mode}"></small><small class="mode-best" data-mode-best="${mode}"></small></span><b class="mode-action" data-mode-action="${mode}">开始 →</b>
        </button>
      </div>`).join('')}
      <div id="lan-entry-slot" class="mode-card lan-mode"></div>
    </div><p id="save-note" hidden></p>`;
  document.querySelector('.home-footer')!.innerHTML = `<div><button id="tutorial-button" class="text-button" type="button">? 玩法</button><button id="settings-button" class="text-button" type="button">⚙ 设置</button><button data-history class="text-button" type="button">◉ 记录</button></div>`;
  const demo = document.querySelector<HTMLElement>('.mechanism-demo')!;
  document.querySelector('.hero-copy')?.append(demo);
  demo.addEventListener('click', () => {
    for (const animation of demo.getAnimations({ subtree: true })) { animation.currentTime = 0; animation.play(); }
  });
}

export function updateHome(): void {
  const progress = loadProgress();
  const campaign = document.querySelector('#campaign-progress');
  if (campaign) campaign.textContent = `${Object.keys(progress).length} / ${CAMPAIGN_LEVELS.length} 关 · ${Object.values(progress).reduce((sum, record) => sum + record.stars, 0)} / ${CAMPAIGN_LEVELS.length * 3} 星${loadGame('campaign') ? ' · 有存档' : ''}`;
  const history = loadHistory();
  for (const mode of ['endless', 'timed'] as const) {
    const saved = loadGame(mode);
    const description = document.querySelector(`[data-mode-description="${mode}"]`);
    if (!description) continue;
    description.textContent = saved ? (mode === 'endless' ? `有存档 · ${saved.score.toLocaleString('zh-CN')} 分` : `有存档 · 剩余 ${formatDuration(Math.max(0, (saved.durationMs ?? 300000) - (saved.elapsedMs ?? 0)) + 999)}`) : mode === 'endless' ? '自由节奏 · 自动存档' : '5 / 10 分钟挑战';
    document.querySelector(`[data-mode-action="${mode}"]`)!.textContent = '选择 →';

    const best = document.querySelector<HTMLElement>(`[data-mode-best="${mode}"]`)!;
    best.textContent = mode === 'endless' ? `最高 ${(leaderboard(history, 'endless')[0]?.score ?? 0).toLocaleString('zh-CN')} 分` : '争分夺秒';
  }
}
