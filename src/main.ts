import Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { usesButtonControls } from './game/input-mode';
import { createGameState, DANGER_MAX, getDifficulty, shotsUntilDescent } from './core/engine';
import { PHASER_CONFIG, PlayScene } from './game/PlayScene';
import { getOrbTheme } from './content/theme';
import { clearGame, getHighScore, hasLegacySave, loadGame, loadSettings, saveGame, saveSettings, setHighScore, type Settings } from './storage/storage';
import './style.css';
import { loadHistory, recordRound, formatDuration } from './storage/history';

interface SceneStateDetail {
  phase: 'READY' | 'FLYING' | 'RESOLVING' | 'PAUSED' | 'WON' | 'LOST';
  status: 'READY' | 'WON' | 'LOST';
  score: number;
  danger: number;
  currentColor: number;
  nextColor: number;
  difficultyId: string;
  step: number;
  elapsedMs: number;
}

const homeScreen = document.querySelector<HTMLElement>('#home-screen');
const gameScreen = document.querySelector<HTMLElement>('#game-screen');
const modalRoot = document.querySelector<HTMLElement>('#modal-root');
const toast = document.querySelector<HTMLElement>('#toast');
const continueButton = document.querySelector<HTMLButtonElement>('#continue-button');
const launchButton = document.querySelector<HTMLButtonElement>('#launch-button');
const scoreValue = document.querySelector<HTMLElement>('#score-value');
const dangerValue = document.querySelector<HTMLElement>('#danger-value');
const dangerFill = document.querySelector<HTMLElement>('#danger-fill');

const difficultyLabel = document.querySelector<HTMLElement>('#difficulty-label');
const gameStatusLabel = document.querySelector<HTMLElement>('#game-status-label');
const pauseButton = document.querySelector<HTMLButtonElement>('#pause-button');
const nextOrbPreview = document.querySelector<HTMLElement>('#next-orb-preview');
const homeHighScore = document.querySelector<HTMLElement>('#home-high-score');

let settings: Settings = loadSettings();
let selectedDifficulty = 'normal';
let game: Phaser.Game | null = null;
let toastTimer: number | undefined;
let resumeAfterModal = false;

function syncMobileLayout(): void {
  document.documentElement.classList.toggle('mobile-ui', usesButtonControls());
}
syncMobileLayout();
window.addEventListener('resize', syncMobileLayout);

function getScene(): PlayScene | null {
  if (!game) return null;
  const scene = game.scene.getScene('PlayScene');
  return scene instanceof PlayScene ? scene : null;
}

function ensureGame(): void {
  if (game) return;
  game = new Phaser.Game(PHASER_CONFIG);
}

function showHome(): void {
  getScene()?.persistGame();
  game?.loop.sleep();
  if (gameScreen) gameScreen.hidden = true;
  if (homeScreen) homeScreen.hidden = false;
  updateHomeState();
}

function showGame(): void {
  if (homeScreen) homeScreen.hidden = true;
  if (gameScreen) gameScreen.hidden = false;
}

function startRound(state: Parameters<PlayScene['begin']>[0] | null, difficulty = selectedDifficulty): void {
  showGame();
  ensureGame();
  if (game && !game.loop.running) game.loop.wake();
  const beginWhenReady = () => {
    const scene = getScene();
    if (!scene?.ready) {
      window.setTimeout(beginWhenReady, 30);
      return;
    }
    scene.setSettings(settings);
    scene.begin(state ?? createGameState(difficulty));
  };
  beginWhenReady();
}

function updateHomeState(): void {
  const saved = loadGame();
  const note = document.querySelector<HTMLElement>('#save-note');
  if (note) { note.hidden = !hasLegacySave(); note.textContent = '旧版未完成对局使用旧网格规则，无法继续；历史记录和设置不受影响。'; }
  const description = document.querySelector<HTMLElement>('#difficulty-description');
  const config = getDifficulty(selectedDifficulty);
  if (description) description.textContent = `${config.colors} 种颜色 · 开局 ${config.initialRows} 行 · 首次下降前 ${shotsUntilDescent(config.id,0)} 次发射`;
  if (continueButton) continueButton.disabled = !saved;
  if (homeHighScore) homeHighScore.textContent = `最高分 ${formatScore(getHighScore())}`;
  document.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((button) => {
    button.classList.toggle('active', button.dataset.difficulty === selectedDifficulty);
  });
}

function formatScore(score: number): string {
  return String(Math.max(0, Math.floor(score))).padStart(5, '0');
}

function updateGameState(detail: SceneStateDetail): void {
  if (scoreValue) scoreValue.textContent = formatScore(detail.score);
  const remaining = shotsUntilDescent(detail.difficultyId, detail.danger);
  if (dangerValue) {
    dangerValue.textContent = detail.status !== 'READY' ? '本局结束' : remaining === 1 ? '下一发后下降' : `再发射 ${remaining} 次`;
    dangerValue.style.color = remaining <= 2 ? 'var(--coral)' : 'var(--cream)';
  }
  if (dangerFill) {
    const progress = Math.max(0, Math.min(100, detail.danger / DANGER_MAX * 100));
    dangerFill.style.width = `${progress}%`;
    dangerFill.parentElement?.setAttribute('aria-valuenow', String(progress));
    dangerFill.parentElement?.setAttribute('aria-valuetext', dangerValue?.textContent ?? '');
  }
  if (difficultyLabel) difficultyLabel.textContent = `${getDifficulty(detail.difficultyId).label} · 已发射 ${detail.step} 次`;
  if (gameStatusLabel) gameStatusLabel.textContent = statusLabel(detail.phase, detail.status);
  if (pauseButton) pauseButton.textContent = detail.phase === 'PAUSED' ? '▶' : 'Ⅱ';
  const mobilePause = document.querySelector('#mobile-pause-button');
  if (mobilePause) mobilePause.textContent = detail.phase === 'PAUSED' ? '▶' : 'Ⅱ';
  if (nextOrbPreview) updateOrbPreview(nextOrbPreview, detail.nextColor);
  const current = document.querySelector<HTMLElement>('#current-orb-preview');
  if (current) updateOrbPreview(current, detail.currentColor);
  const clock = document.querySelector<HTMLElement>('#round-clock');
  if (clock) clock.textContent = formatDuration(detail.elapsedMs);
  if (launchButton) launchButton.disabled = detail.phase !== 'READY';
}

function statusLabel(phase: SceneStateDetail['phase'], status: SceneStateDetail['status']): string {
  if (phase === 'PAUSED') return '已暂停';
  if (status === 'WON') return '棋盘清空';
  if (status === 'LOST') return '触底';
  if (phase === 'FLYING') return '飞行中';
  if (phase === 'RESOLVING') return '结算中';
  return '选择角度';
}

function updateOrbPreview(element: HTMLElement, colorId: number): void {
  const orb = getOrbTheme(colorId);
  element.dataset.symbol = orb.symbol;
  element.style.backgroundColor = orb.cssColor;
  element.style.setProperty('--orb-ink', orb.ink);
}

function showToast(message: string): void {
  if (!toast) return;
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2200);
}

function openModal(content: string, className = ''): void {
  if (!modalRoot) return;
  if (modalRoot.hidden) {
    resumeAfterModal = !gameScreen?.hidden && !!getScene() && !getScene()!.isPaused;
    getScene()?.pauseGame();
  }
  modalRoot.innerHTML = `<div class="modal-card ${className}" role="dialog" aria-modal="true">${content}</div>`;
  modalRoot.hidden = false;
  modalRoot.querySelectorAll<HTMLElement>('[data-close-modal]').forEach(button => button.addEventListener('click', closeModal));
  modalRoot.onclick = handleModalBackdrop;
}

function handleModalBackdrop(event: MouseEvent): void {
  if (event.target === modalRoot) closeModal();
}

function closeModal(): void {
  if (!modalRoot) return;
  modalRoot.hidden = true;
  modalRoot.innerHTML = '';
  modalRoot.onclick = null;
  if (resumeAfterModal && !gameScreen?.hidden) getScene()?.resumeGame();
  resumeAfterModal = false;
}

function showHistory(top = true, page = 0): void {
  const data = loadHistory();
  const all = top ? data.top : data.recent;
  const rows = all.slice(page * 20, page * 20 + 20);
  openModal(`<button class="modal-close" data-close-modal type="button">关闭</button>
    <p class="eyebrow">PERSONAL / LOCAL</p><h2>${top ? '个人前十' : '历史记录'}</h2>
    <p>完成的对局参与排名；同分时用时短者优先。保存最近 500 局，前十独立保留。用时不含暂停。</p>
    <div class="history-tabs"><button id="history-top" class="quiet-button">前十排行榜</button><button id="history-recent" class="quiet-button">最近对局</button></div>
    <div class="history-scroll"><table><thead><tr><th>#</th><th>开始时间</th><th>分数</th><th>难度 / 结果</th><th>用时 / 发射</th></tr></thead><tbody>
    ${rows.map((r,i) => `<tr><td>${page*20+i+1}</td><td>${new Date(r.startedAt).toLocaleString('zh-CN',{hour12:false})}</td><td>${r.score}</td><td>${getDifficulty(r.difficulty).label} / ${r.result === 'WON' ? '胜利' : r.result === 'LOST' ? '触底' : '重开'}</td><td>${formatDuration(r.elapsedMs)} / ${r.shots}</td></tr>`).join('') || '<tr><td colspan="5">暂无记录，完成一局后会自动保存在这里。</td></tr>'}
    </tbody></table></div><div class="history-tabs"><button id="history-prev" class="quiet-button" ${page === 0 ? 'disabled' : ''}>上一页</button><span>${page+1} / ${Math.max(1,Math.ceil(all.length/20))}</span><button id="history-next" class="quiet-button" ${(page+1)*20 >= all.length ? 'disabled' : ''}>下一页</button></div>`, 'history-card');
  document.querySelector('#history-top')?.addEventListener('click', () => showHistory(true));
  document.querySelector('#history-recent')?.addEventListener('click', () => showHistory(false));
  document.querySelector('#history-prev')?.addEventListener('click', () => showHistory(top,page-1));
  document.querySelector('#history-next')?.addEventListener('click', () => showHistory(top,page+1));
}

function showTutorial(): void {
  openModal(`
    <button class="modal-close" data-close-modal type="button">关闭</button>
    <p class="eyebrow">FIELD GUIDE / 01</p>
    <h2>三步读懂棋盘</h2>
    <p>你不需要追赶时间，真正的节奏来自每一次选择：落在哪里、先断哪一片、要不要承担下一次下降。</p>
    <div class="tutorial-steps">
      <div class="tutorial-step"><b>01</b><div><strong>调整炮口方向</strong><span>手机版使用底部 ↶ / ↷ 调整方向，可长按连续转动；中间按钮发射。电脑版使用鼠标或方向键瞄准。</span></div></div>
      <div class="tutorial-step"><b>02</b><div><strong>三个同类连在一起</strong><span>命中后，同色连通区域达到 3 枚就会消失；每枚 10 分。</span></div></div>
      <div class="tutorial-step"><b>03</b><div><strong>让悬空小球掉落</strong><span>消除支撑后，不再与顶部相连的小球会掉落，不分颜色，每枚 20 分。顶部显示还可发射几次，归零后棋盘下降一行。</span></div></div>
    </div>
    <div class="modal-footer"><button class="primary-button" data-close-modal type="button"><span>知道了，开始</span><b>↗</b></button></div>
  `);
}

function showSettings(): void {
  openModal(`
    <button class="modal-close" data-close-modal type="button">关闭</button>
    <p class="eyebrow">PREFERENCES / 02</p>
    <h2>让节奏适合你</h2>
    <p>设置会保存在这台设备上。音效采用本地合成，不需要额外下载素材。</p>
    <div class="setting-row"><div><strong>音效</strong><small>发射、消除、棋盘下降和结算提示</small></div><label class="switch"><input id="setting-sound" type="checkbox" ${settings.sound ? 'checked' : ''} /><span></span></label></div>
    <div class="setting-row"><div><strong>瞄准辅助</strong><small>显示反弹轨迹与预计落点</small></div><label class="switch"><input id="setting-aim" type="checkbox" ${settings.aimAssist ? 'checked' : ''} /><span></span></label></div>
    <div class="setting-row"><div><strong>减少动态效果</strong><small>缩短动画，关闭大幅反馈</small></div><label class="switch"><input id="setting-motion" type="checkbox" ${settings.reducedMotion ? 'checked' : ''} /><span></span></label></div>
    <div class="modal-footer"><button class="primary-button" data-close-modal type="button"><span>保存设置</span><b>✓</b></button></div>
  `);
  const fields: Array<[keyof Settings, string]> = [
    ['sound', 'setting-sound'],
    ['aimAssist', 'setting-aim'],
    ['reducedMotion', 'setting-motion'],
  ];
  for (const [key, id] of fields) {
    modalRoot?.querySelector<HTMLInputElement>(`#${id}`)?.addEventListener('change', (event) => {
      settings = { ...settings, [key]: (event.target as HTMLInputElement).checked };
      saveSettings(settings);
      getScene()?.setSettings(settings);
      gameScreen?.classList.toggle('independent-launch', settings.independentLaunch);
    });
  }
}

function showResult(state: { status: 'WON' | 'LOST'; score: number; step: number }): void {
  const won = state.status === 'WON';
  setHighScore(state.score);
  clearGame();
  openModal(`
    <button class="modal-close" data-close-modal type="button">关闭</button>
    <div class="result-mark">${won ? '✦' : '!'}</div>
    <p class="eyebrow">${won ? 'BOARD CLEARED' : 'ONE MORE TRY'}</p>
    <h2>${won ? '全部清空，胜利！' : '棋盘触底了。'}</h2>
    <p>${won ? '你把整片星群都放回了夜空。下一局可以试试更激进的反弹。' : '留意剩余发射次数，消掉上方支撑，让更多小球一起掉落。'}</p>
    <div class="result-score">${formatScore(state.score)}</div>
    <div class="result-meta">${state.step} 次发射 · ${won ? '本局胜利' : '本局结束'}</div>
    <div class="modal-footer"><button id="result-retry" class="primary-button" type="button"><span>${won ? '再开一局' : '再试一次'}</span><b>↗</b></button><button id="result-home" class="quiet-button" type="button">返回首页</button></div>
  `, `result-card${won ? '' : ' lost'}`);
  modalRoot?.querySelector<HTMLButtonElement>('#result-retry')?.addEventListener('click', () => {
    closeModal();
    startRound(null, selectedDifficulty);
  });
  modalRoot?.querySelector<HTMLButtonElement>('#result-home')?.addEventListener('click', () => {
    closeModal();
    showHome();
  });
}

document.querySelector<HTMLButtonElement>('#start-button')?.addEventListener('click', () => {
  const previous = loadGame();
  if (previous) recordRound(previous, true);
  clearGame();
  startRound(null, selectedDifficulty);
});

continueButton?.addEventListener('click', () => {
  const saved = loadGame();
  if (!saved) {
    showToast('没有找到可继续的完整回合');
    updateHomeState();
    return;
  }
  selectedDifficulty = saved.difficultyId;
  startRound(saved, saved.difficultyId);
});

document.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((button) => {
  button.addEventListener('click', () => {
    selectedDifficulty = button.dataset.difficulty ?? 'normal';
    updateHomeState();
  });
});

document.querySelector<HTMLButtonElement>('#tutorial-button')?.addEventListener('click', showTutorial);
document.querySelector<HTMLButtonElement>('#settings-button')?.addEventListener('click', showSettings);
document.querySelector<HTMLButtonElement>('#game-settings-button')?.addEventListener('click', showSettings);
document.querySelector<HTMLButtonElement>('#pause-button')?.addEventListener('click', () => getScene()?.togglePause());
launchButton?.addEventListener('click', () => getScene()?.launchFromButton());
document.querySelector('#mobile-fire')?.addEventListener('click', () => getScene()?.launchFromButton());
document.querySelector('#mobile-pause-button')?.addEventListener('click', () => getScene()?.togglePause());
document.querySelector('#mobile-help-button')?.addEventListener('click', showTutorial);
document.querySelector('#mobile-menu-button')?.addEventListener('click', () => {
  openModal(`<button class="modal-close" data-close-modal type="button">继续游戏</button><h2>游戏菜单</h2>
    <div class="mobile-menu-actions"><button id="menu-settings" class="quiet-button">设置</button><button id="menu-history" class="quiet-button">历史与排行</button><button id="menu-restart" class="quiet-button">重新开始</button><button id="menu-home" class="quiet-button">返回首页</button></div>`);
  document.querySelector('#menu-settings')?.addEventListener('click', showSettings);
  document.querySelector('#menu-history')?.addEventListener('click', () => showHistory());
  document.querySelector('#menu-restart')?.addEventListener('click', () => { closeModal(); getScene()?.restartGame(); });
  document.querySelector('#menu-home')?.addEventListener('click', () => { resumeAfterModal = false; closeModal(); showHome(); });
});

function stopRotation(): void { getScene()?.stopRotation(); }
for (const [id, direction] of [['rotate-left', -1], ['rotate-right', 1]] as const) {
  const button = document.getElementById(id)!;
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault(); stopRotation(); button.setPointerCapture(event.pointerId);
    getScene()?.startRotation(direction);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, stopRotation);
  button.addEventListener('click', (event) => { if (event.detail === 0) getScene()?.rotateLauncher(direction); });
}
window.addEventListener('blur', stopRotation);
document.addEventListener('visibilitychange', stopRotation);
document.querySelector<HTMLButtonElement>('#restart-button')?.addEventListener('click', () => {
  getScene()?.restartGame();
  showToast('新回合已开始');
});
document.querySelector<HTMLButtonElement>('#back-home-button')?.addEventListener('click', () => {
  getScene()?.pauseGame();
  showHome();
});

window.addEventListener('snood-state', (event) => {
  updateGameState((event as CustomEvent<SceneStateDetail>).detail);
});
window.addEventListener('snood-save-request', (event) => {
  saveGame((event as CustomEvent<Parameters<PlayScene['begin']>[0]>).detail);
  updateHomeState();
});
window.addEventListener('snood-clear-save', () => {
  clearGame();
  updateHomeState();
});
window.addEventListener('snood-finished', (event) => {
  const state = (event as CustomEvent<{ status: 'WON' | 'LOST'; score: number; step: number }>).detail;
  showResult(state);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    getScene()?.pauseGame();
    getScene()?.persistGame();
  }
});

if (Capacitor.isNativePlatform()) {
  void App.addListener('appStateChange', ({ isActive }) => {
    if (!isActive) {
      getScene()?.pauseGame();
      getScene()?.persistGame();
    }
  });
  void App.addListener('backButton', () => {
    if (modalRoot && !modalRoot.hidden) {
      closeModal();
    } else if (gameScreen && !gameScreen.hidden) {
      getScene()?.pauseGame();
      showHome();
    } else {
      void App.minimizeApp();
    }
  });
}

window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'r' && !gameScreen?.hidden && modalRoot?.hidden) {
    getScene()?.restartGame();
    showToast('新回合已开始');
  }
});

updateHomeState();
document.querySelectorAll('[data-history]').forEach(button => button.addEventListener('click', () => showHistory()));
window.addEventListener('snood-storage-error', () => showToast('本地记录未能保存，请检查可用磁盘空间'));
window.addEventListener('beforeunload', () => getScene()?.persistGame());
window.addEventListener('snood-settings-applied', () => gameScreen?.classList.toggle('independent-launch', settings.independentLaunch));

