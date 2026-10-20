import { loadProgress } from '../storage/campaign';
import { CAMPAIGN_LEVELS } from '../content/campaign';
import { loadGame } from '../storage/storage';
import { loadHistory, leaderboard, formatDuration } from '../storage/history';
import { homeDemoMarkup, homeDemoShouldPause } from './home-demo';

export function buildHome(touch: boolean): void {
  const root = document.documentElement;
  const androidV5 = root.classList.contains('android-v5');
  const autoLoop = root.classList.contains('windows-v5') || androidV5;
  document.querySelector('.hero-copy .eyebrow')?.remove();
  document.querySelector('.hero-notes')?.remove();
  document.querySelector('.hero-description')!.textContent = '同色连接 · 切断支撑 · 连锁坠落';
  document.querySelector('.home-card')!.innerHTML = `
    ${homeDemoMarkup(touch, autoLoop)}
    <div class="home-actions mobile-mode-cards">
      <div class="mode-card campaign"><button id="campaign-button" class="mode-main" type="button"><b class="mode-symbol">◇</b><span><strong>闯关模式</strong>${androidV5 ? '' : '<small>固定棋盘 · 逐关解锁 · 星级挑战</small>'}<small id="campaign-progress" class="mode-best"></small></span><b class="mode-action">选关 →</b></button></div>
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
  if (autoLoop) bindHomeDemoPlayback(demo);
  else demo.addEventListener('click', () => {
      for (const animation of demo.getAnimations({ subtree: true })) { animation.currentTime = 0; animation.play(); }
    });
}

function bindHomeDemoPlayback(demo: HTMLElement): void {
  const root = document.documentElement;
  const home = document.querySelector<HTMLElement>('#home-screen');
  const modal = document.querySelector<HTMLElement>('#modal-root');
  const update = () => {
    const paused = homeDemoShouldPause({
      pageHidden: document.hidden,
      homeHidden: !!home?.hidden,
      modalOpen: modal ? !modal.hidden : false,
      appInactive: root.classList.contains('app-inactive'),
      modalClass: root.classList.contains('modal-open'),
    });
    demo.classList.toggle('demo-paused', paused);
  };
  update();
  document.addEventListener('visibilitychange', update);
  if (typeof MutationObserver === 'undefined') return;
  const rootObserver = new MutationObserver(update), screenObserver = new MutationObserver(update);
  rootObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
  if (home) screenObserver.observe(home, { attributes: true, attributeFilter: ['hidden'] });
  if (modal) screenObserver.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
}

export function updateHome(): void {
  const androidV5 = document.documentElement.classList.contains('android-v5');
  const progress = loadProgress();
  const campaignSave = loadGame('campaign');
  const campaign = document.querySelector('#campaign-progress');
  if (campaign) campaign.textContent = androidV5
    ? `${Object.keys(progress).length}/${CAMPAIGN_LEVELS.length} 关 · ${Object.values(progress).reduce((sum, record) => sum + record.stars, 0)}/${CAMPAIGN_LEVELS.length * 3} 星${campaignSave?.levelId ? ` · 存档第 ${campaignSave.levelId} 关` : ''}`
    : `${Object.keys(progress).length} / ${CAMPAIGN_LEVELS.length} 关 · ${Object.values(progress).reduce((sum, record) => sum + record.stars, 0)} / ${CAMPAIGN_LEVELS.length * 3} 星${campaignSave ? ' · 有存档' : ''}`;
  const history = loadHistory();
  for (const mode of ['endless', 'timed'] as const) {
    const saved = loadGame(mode);
    const description = document.querySelector(`[data-mode-description="${mode}"]`);
    if (!description) continue;
    description.textContent = androidV5
      ? saved ? (mode === 'endless' ? `继续 · ${saved.score.toLocaleString('zh-CN')} 分` : `存档 · 剩余 ${formatDuration(Math.max(0, (saved.durationMs ?? 300000) - (saved.elapsedMs ?? 0)) + 999)}`) : mode === 'endless' ? '' : '5 / 10 分钟'
      : saved ? (mode === 'endless' ? `有存档 · ${saved.score.toLocaleString('zh-CN')} 分` : `有存档 · 剩余 ${formatDuration(Math.max(0, (saved.durationMs ?? 300000) - (saved.elapsedMs ?? 0)) + 999)}`) : mode === 'endless' ? '自由节奏 · 自动存档' : '5 / 10 分钟挑战';
    document.querySelector(`[data-mode-action="${mode}"]`)!.textContent = '选择 →';

    const best = document.querySelector<HTMLElement>(`[data-mode-best="${mode}"]`)!;
    const bestScore = leaderboard(history, 'endless')[0]?.score ?? 0;
    best.textContent = mode === 'endless'
      ? androidV5 ? bestScore > 0 ? `最高 ${bestScore.toLocaleString('zh-CN')} 分` : '暂无纪录' : `最高 ${bestScore.toLocaleString('zh-CN')} 分`
      : androidV5 ? '' : '争分夺秒';
  }
}
