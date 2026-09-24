import { loadGame } from '../storage/storage';
import { loadHistory, rankingKey, formatDuration } from '../storage/history';

export function buildHome(touch: boolean): void {
  document.querySelector('.hero-copy .eyebrow')?.remove();
  document.querySelector('.hero-notes')?.remove();
  document.querySelector('.hero-description')!.textContent = '同色连接 · 切断支撑 · 连锁坠落';
  document.querySelector('.home-card')!.innerHTML = `
    <button class="mechanism-demo" type="button" aria-label="${touch ? '轻触' : '点击'}重播：中心向左发射展示同色消除，向右发射展示消除后掉落">
      <svg viewBox="0 0 320 200" aria-hidden="true">
        <g class="demo-orbits" fill="none" stroke="currentColor"><path d="M-30 120 Q150 -80 350 95"/><path d="M-10 160 Q160 20 340 155"/></g>
        <path class="demo-route-left" d="M160 165L108 68"/><path class="demo-route-right" d="M160 165L212 40"/>
        <g class="demo-match-left" fill="#63d7bd"><circle cx="80" cy="40" r="14"/><circle cx="108" cy="40" r="14"/><g fill="#182239" font-size="13" text-anchor="middle"><text x="80" y="45">◆</text><text x="108" y="45">◆</text></g></g>
        <g class="demo-match-right" fill="#f6c85f"><circle cx="240" cy="40" r="14"/><circle cx="268" cy="40" r="14"/><g fill="#182239" font-size="13" text-anchor="middle"><text x="240" y="45">✦</text><text x="268" y="45">✦</text></g></g>
        <g class="demo-falling"><circle cx="254" cy="64.249" r="14" fill="#ff777b"/><text x="254" y="69.249" fill="#182239" font-size="13" text-anchor="middle">●</text></g>
        <circle cx="160" cy="165" r="20" fill="#172238" stroke="#64718d" stroke-opacity=".6"/>
        <g class="demo-shot demo-shot-left"><circle cx="160" cy="165" r="14" fill="#63d7bd"/><text x="160" y="170" fill="#182239" font-size="13" text-anchor="middle">◆</text></g>
        <g class="demo-shot demo-shot-right"><circle cx="160" cy="165" r="14" fill="#f6c85f"/><text x="160" y="170" fill="#182239" font-size="13" text-anchor="middle">✦</text></g>
        <g fill="#a7b4c9" font-size="10" text-anchor="middle"><text x="87" y="190">同色消除</text><text x="260" y="190">消除后掉落</text></g>
      </svg><span>从中心出发，${touch ? '轻触' : '点击'}重播</span>
    </button>
    <div class="home-actions mobile-mode-cards">
      ${(['endless', 'timed'] as const).map(mode => `<div class="mode-card ${mode}">
        <button id="${mode === 'endless' ? 'start' : 'timed'}-button" class="mode-main" type="button">
          <b class="mode-symbol">${mode === 'endless' ? '∞' : '◷'}</b><span><strong>${mode === 'endless' ? '无尽模式' : '限时模式'}</strong><small data-mode-description="${mode}"></small><small class="mode-best" data-mode-best="${mode}"></small></span><b class="mode-action" data-mode-action="${mode}">开始 →</b>
        </button><button class="mode-new text-button" data-new-mode="${mode}" type="button" hidden>新游戏</button>
      </div>`).join('')}
    </div><p id="save-note" hidden></p>`;
  document.querySelector('.home-footer')!.innerHTML = `<div><button id="tutorial-button" class="text-button" type="button">? 玩法</button><button id="settings-button" class="text-button" type="button">⚙ 设置</button><button data-history class="text-button" type="button">◉ 记录</button></div>`;
  const demo = document.querySelector<HTMLElement>('.mechanism-demo')!;
  demo.addEventListener('click', () => {
    for (const animation of demo.getAnimations({ subtree: true })) { animation.currentTime = 0; animation.play(); }
  });
}

export function updateHome(): void {
  const history = loadHistory();
  for (const mode of ['endless', 'timed'] as const) {
    const saved = loadGame(mode);
    const description = document.querySelector(`[data-mode-description="${mode}"]`);
    if (!description) continue;
    description.textContent = saved ? (mode === 'endless' ? `已存档 · ${saved.score.toLocaleString('zh-CN')} 分` : `已存档 · 剩余 ${formatDuration(Math.max(0, (saved.durationMs ?? 300000) - (saved.elapsedMs ?? 0)) + 999)}`) : mode === 'endless' ? '自由节奏 · 自动存档' : '5 / 10 分钟 · 争分夺秒';
    document.querySelector(`[data-mode-action="${mode}"]`)!.textContent = saved ? '继续 →' : '开始 →';
    const newButton = document.querySelector<HTMLButtonElement>(`[data-new-mode="${mode}"]`)!;
    newButton.hidden = !saved;
    const best = document.querySelector<HTMLElement>(`[data-mode-best="${mode}"]`)!;
    const entries = history.top.filter(row => mode === 'endless' ? rankingKey(row) === 'endless' : rankingKey(row).startsWith('timed-'));
    best.textContent = mode === 'endless' ? `最高 ${Math.max(0, ...entries.map(row => row.score)).toLocaleString('zh-CN')}` : [300000, 600000].map(duration => `${duration / 60000} 分钟最高 ${Math.max(0, ...entries.filter(row => rankingKey(row) === `timed-${duration}`).map(row => row.score)).toLocaleString('zh-CN')}`).join(' · ');
  }
}
