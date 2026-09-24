import { bindDesktopBridge } from './ui/desktop-bridge';
import './ui/android-insets';
import { shortcutAction, shortcutLabel, type ShortcutAction } from './game/shortcuts';
import { bindImmersiveControl } from './game/immersive-control';
import { historyMarkup } from './ui/history-panel';
import type Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { usesButtonControls } from './game/input-mode';
import { countdownProgress } from './game/countdown';
import { DANGER_MAX, getDifficulty, shotsUntilDescent } from './core/engine';
import { createRound, scoreMultiplier, weightedScore, type GameMode } from './core/modes';
import type { GameState } from './core/types';
import type { PlayScene } from './game/PlayScene';
import { getOrbTheme } from './content/theme';
import { clearGame, hasLegacySave, loadGame, loadSettings, saveGame, saveSettings, setHighScore, type Settings } from './storage/storage';
import './style.css';
import { buildHome, updateHome } from './ui/home';
import { gameAudio } from './game/audio';
import { bindFireButton } from './game/fire-control';
import { bindSteeringControl } from './game/steering-control';
import { directAimDegrees } from './game/rotation';
import { settingsMarkup, bindSettingsPanel, settingsBack } from './ui/settings-panel';
import { formatHeadings } from './ui/typography';
import { loadHistory, recordRound, formatDuration, rankingKey } from './storage/history';

interface SceneStateDetail {
  musicPressure: number;
  endReason?: GameState['endReason'];
  mode: GameMode;
  durationMs?: number;
  descentRemainingMs: number;
  descentIntervalMs: number;
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

buildHome(usesButtonControls());
if (!usesButtonControls()) {
  document.querySelector('.mobile-launch-row')?.remove();
  document.querySelector('.current-card')?.remove();
  document.querySelector('#pause-button')?.remove();
  document.querySelector('.legend-card')?.remove();
  const buttons: Record<string, [ShortcutAction, string]> = {
    'settle-button': ['settle', '结算本局'], 'restart-button': ['restart', '重新开始'],
    'game-settings-button': ['settings', '游戏设置'], 'back-home-button': ['save', '存档并返回'],
  };
  for (const [id, [action, label]] of Object.entries(buttons)) document.querySelector(`#${id}`)!.innerHTML = `${label}<kbd data-shortcut="${action}"></kbd>`;
  document.querySelector('.sidebar-actions [data-history]')!.innerHTML = '历史与排行<kbd data-shortcut="history"></kbd>';
  document.querySelector('.sidebar-actions')!.insertAdjacentHTML('beforeend', '<button id="game-help-button" class="side-button" type="button">玩法提示<kbd data-shortcut="help"></kbd></button>');
}
const homeScreen = document.querySelector<HTMLElement>('#home-screen');
const gameScreen = document.querySelector<HTMLElement>('#game-screen');
const modalRoot = document.querySelector<HTMLElement>('#modal-root');
const toast = document.querySelector<HTMLElement>('#toast');
const continueButton = document.querySelector<HTMLButtonElement>('#continue-button');
const timedContinueButton = document.querySelector<HTMLButtonElement>('#timed-continue-button');
const launchButton = document.querySelector<HTMLButtonElement>('#launch-button');
const scoreValue = document.querySelector<HTMLElement>('#score-value');
const dangerValue = document.querySelector<HTMLElement>('#danger-value');
const dangerFill = document.querySelector<HTMLElement>('#danger-fill');
const descentTimeRow = document.querySelector<HTMLElement>('#descent-time-row');
const descentTimeValue = document.querySelector<HTMLElement>('#descent-time-value');
const descentTimeFill = document.querySelector<HTMLElement>('#descent-time-fill');
const descentCaption = document.querySelector<HTMLElement>('#descent-caption');
const shotCountdownLabel = document.querySelector<HTMLElement>('#shot-countdown-label');

const difficultyLabel = document.querySelector<HTMLElement>('#difficulty-label');
const gameStatusLabel = document.querySelector<HTMLElement>('#game-status-label');
const pauseButton = document.querySelector<HTMLButtonElement>('#pause-button');
const nextOrbPreview = document.querySelector<HTMLElement>('#next-orb-preview');
const homeHighScore = document.querySelector<HTMLElement>('#home-high-score');

const versionPill = document.querySelector('.version-pill');
if (versionPill) versionPill.textContent = `${import.meta.env.VITE_APP_VERSION} / ${import.meta.env.MODE === 'windows' ? 'WINDOWS' : Capacitor.isNativePlatform() ? 'ANDROID' : 'LOCAL'}`;

const sideOrbLabel = document.querySelector('#side-orb-label');
if (sideOrbLabel && import.meta.env.MODE === 'windows') sideOrbLabel.textContent = '下一球';

let settings: Settings = loadSettings();
gameAudio.setMix(settings.volume, settings.musicVolume);
gameAudio.setAdaptiveMusic(settings.adaptiveMusic);
gameAudio.unlock();
document.addEventListener('pointerdown', () => gameAudio.unlock());
document.addEventListener('keydown', () => gameAudio.unlock());
document.addEventListener('visibilitychange', () => { gameAudio.setForeground(!document.hidden); document.documentElement.classList.toggle('app-inactive', document.hidden); });
let selectedDifficulty = 'normal';
let selectedMode: GameMode = 'endless';
let selectedDuration = 300000;
let game: Phaser.Game | null = null;
let toastTimer: number | undefined;
let resumeAfterModal = false;
let disposeModal: (() => void) | null = null;
let roundRequest = 0;

function syncMobileLayout(): void {
  if (usesButtonControls()) {
    const preview = document.querySelector('.next-card');
    const target = document.querySelector(settings.immersiveMode ? '.board-heading' : '.mobile-fire-group');
    if (preview && target && preview.parentElement !== target) target.append(preview);
  }
  document.documentElement.classList.toggle('immersive-mode', usesButtonControls() && settings.immersiveMode);
  document.querySelectorAll<HTMLElement>('[data-shortcut]').forEach(label => { label.textContent = shortcutLabel(settings.shortcuts[label.dataset.shortcut as ShortcutAction]); });
  document.documentElement.classList.toggle("desktop-ui", !usesButtonControls());
  document.documentElement.classList.toggle('mobile-ui', usesButtonControls());
  document.documentElement.classList.toggle('controls-swapped', settings.controlsSwapped);
  document.documentElement.style.setProperty('--fire-width', `${settings.fireSize}px`);
  // Leave enough room for the system gesture area on short phones.
  const offset = Math.min(settings.controlOffset, Math.max(0, (window.innerHeight - 640) * 0.24));
  document.documentElement.style.setProperty('--control-offset', `${offset}px`);
}
syncMobileLayout();
window.addEventListener('resize', () => { stopRotation(); syncMobileLayout(); });

function getScene(): PlayScene | null {
  if (!game) return null;
  const scene = game.scene.getScene('PlayScene');
  return scene as PlayScene | null;
}

let runtime: Promise<typeof import('./game/runtime')> | null = null;
function loadRuntime() { return runtime ??= import('./game/runtime').catch(error => { runtime = null; throw error; }); }
async function ensureGame(): Promise<void> {
  if (game) return;
  const module = await loadRuntime();
  if (!game) game = module.createGame();
}

function showHome(): void {
  roundRequest++;
  document.documentElement.classList.remove('game-loading');
  gameAudio.setScene('menu');
  const scene = getScene();
  scene?.pauseGame();
  getScene()?.persistGame();
  resumeAfterModal = false;
  closeModal();
  game?.loop.sleep();
  if (gameScreen) gameScreen.hidden = true;
  if (homeScreen) homeScreen.hidden = false;
  updateHomeState();
}

function showGame(): void {
  if (homeScreen) homeScreen.hidden = true;
  if (gameScreen) gameScreen.hidden = false;
}

async function startRound(state: Parameters<PlayScene['begin']>[0] | null, difficulty = selectedDifficulty): Promise<void> {
  gameAudio.setForeground(true); gameAudio.unlock();
  const request = ++roundRequest, mode = selectedMode, duration = selectedDuration;
  document.documentElement.classList.add('game-loading');
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  try { await ensureGame(); }
  catch { document.documentElement.classList.remove('game-loading'); showToast('游戏加载失败，请重试'); return; }
  if (request !== roundRequest) return;
  showGame();
  const beginWhenReady = () => {
    if (request !== roundRequest) return;
    const scene = getScene();
    if (!scene?.ready) {
      window.setTimeout(beginWhenReady, 30);
      return;
    }
    scene.setSettings(settings);
    scene.begin(state ?? createRound(difficulty, mode, duration));
    gameAudio.setScene('play'); gameAudio.unlock();
    document.documentElement.classList.remove('game-loading');
    game?.loop.wake();
  };
  beginWhenReady();
}

function updateHomeState(): void {
  updateHome();
  const saved = loadGame();
  const note = document.querySelector<HTMLElement>('#save-note');
  if (note) { note.hidden = !hasLegacySave(); note.textContent = '旧版未完成对局使用旧网格规则，无法继续；历史记录和设置不受影响。'; }
  const description = document.querySelector<HTMLElement>('#difficulty-description');
  const config = getDifficulty(selectedDifficulty);
  if (description) description.textContent = `${config.colors} 种颜色 · 开局 ${config.initialRows} 行 · 首次下降前 ${shotsUntilDescent(config.id,0)} 次发射`;
  if (continueButton) continueButton.disabled = !saved;
  const best = loadHistory().top.filter(r => rankingKey(r) === 'endless')[0]?.score ?? 0;
  if (homeHighScore) homeHighScore.textContent = `无尽最高 ${formatScore(best)}`;
  if (continueButton) continueButton.textContent = saved ? `无尽存档 · ${saved.score} 分` : '无尽 · 暂无存档';
  const timedSaved = loadGame('timed');
  if (timedContinueButton) {
    timedContinueButton.disabled = !timedSaved;
    timedContinueButton.textContent = timedSaved ? `限时存档 · ${formatDuration(Math.max(0,timedSaved.durationMs! - (timedSaved.elapsedMs ?? 0)) + 999)}` : '限时 · 暂无存档';
  }
  document.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((button) => {
    button.classList.toggle('active', button.dataset.difficulty === selectedDifficulty);
  });
}

function formatScore(score: number): string {
  return String(Math.max(0, Math.floor(score))).padStart(5, '0');
}

function updateGameState(detail: SceneStateDetail): void {
  gameAudio.setPressure(detail.musicPressure);
  gameAudio.setScene(!gameScreen?.hidden && modalRoot?.hidden && ['READY', 'FLYING', 'RESOLVING'].includes(detail.phase) ? 'play' : 'menu');
  if (scoreValue && scoreValue.textContent !== formatScore(detail.score)) scoreValue.textContent = formatScore(detail.score);
  const timed = detail.mode === 'timed';
  gameScreen?.classList.toggle('timed-mode', timed);
  if (descentTimeRow) descentTimeRow.hidden = !timed;
  if (descentCaption) descentCaption.hidden = timed;
  if (shotCountdownLabel) shotCountdownLabel.hidden = !timed;
  const bars = countdownProgress(detail.difficultyId, detail.danger, detail.descentRemainingMs, detail.descentIntervalMs);
  const remaining = shotsUntilDescent(detail.difficultyId, detail.danger);
  if (dangerValue) {
    const label = detail.status !== 'READY' ? '本局结束' : timed ? `${remaining} 次` : remaining === 1 ? '下一发后下降' : `再发射 ${remaining} 次`;
    if (dangerValue.textContent !== label) dangerValue.textContent = label;
    dangerValue.style.color = remaining <= 2 ? 'var(--coral)' : 'var(--cream)';
  }
  if (dangerFill) {
    const progress = timed ? (detail.status === 'READY' ? bars.shotPercent : 0) : Math.max(0, Math.min(100, detail.danger / DANGER_MAX * 100));
    dangerFill.style.width = `${progress}%`;
    dangerFill.parentElement?.setAttribute('aria-valuenow', String(progress));
    dangerFill.parentElement?.setAttribute('aria-valuetext', dangerValue?.textContent ?? '');
  }
  if (timed && descentTimeFill && descentTimeValue) {
    const label = detail.status === 'READY' ? `${Math.ceil(detail.descentRemainingMs / 1000)} 秒` : '本局结束';
    if (descentTimeValue.textContent !== label) descentTimeValue.textContent = label;
    const progress = detail.status === 'READY' ? bars.timePercent : 0;
    descentTimeFill.style.transform = `scaleX(${progress / 100})`;
    descentTimeFill.parentElement?.setAttribute('aria-valuenow', String(Math.round(progress)));
    descentTimeFill.parentElement?.setAttribute('aria-valuetext', label);
    descentTimeRow?.classList.toggle('urgent', detail.status === 'READY' && detail.descentRemainingMs <= 5000);
  }
  const difficultyText = `${detail.mode === 'timed' ? '限时' : '无尽'} · ${getDifficulty(detail.difficultyId).label} ×${scoreMultiplier(detail.difficultyId)}`;
  if (difficultyLabel && difficultyLabel.textContent !== difficultyText) difficultyLabel.textContent = difficultyText;
  const phaseText = detail.endReason ? (detail.endReason === 'timeout' ? '时间到' : '已结算') : statusLabel(detail.phase, detail.status);
  if (gameStatusLabel && gameStatusLabel.textContent !== phaseText) gameStatusLabel.textContent = phaseText;
  for (const button of [pauseButton, document.querySelector<HTMLButtonElement>('#mobile-pause-button')]) {
    if (!button) continue;
    if (button.textContent !== '存档') button.textContent = '存档';
    button.disabled = detail.status !== 'READY';
    button.setAttribute('aria-label', '存档并返回首页');
  }
  if (nextOrbPreview) updateOrbPreview(nextOrbPreview, detail.nextColor);
  const current = document.querySelector<HTMLElement>('#current-orb-preview');
  if (current) updateOrbPreview(current, import.meta.env.MODE === 'windows' ? detail.nextColor : detail.currentColor);
  const clock = document.querySelector<HTMLElement>('#round-clock');
  if (clock) {
    const clockText = formatDuration(detail.mode === 'timed' ? Math.max(0, detail.durationMs! - detail.elapsedMs + 999) : detail.elapsedMs);
    if (clock.textContent !== clockText) clock.textContent = clockText;
    const clockLabel = detail.mode === 'timed' ? '整局剩余' : '本局用时';
    if (clock.previousElementSibling!.textContent !== clockLabel) clock.previousElementSibling!.textContent = clockLabel;
    clock.classList.toggle('clock-urgent', detail.mode === 'timed' && detail.durationMs! - detail.elapsedMs <= 30000);
  }
  if (launchButton) launchButton.disabled = detail.phase !== 'READY';
  const mobileFire = document.querySelector<HTMLButtonElement>('#mobile-fire');
  if (mobileFire) {
    mobileFire.disabled = detail.phase !== 'READY';
    const label = detail.phase === 'READY' ? '发射' : detail.phase === 'FLYING' ? '已发射' : detail.phase === 'RESOLVING' ? '装填中' : detail.phase === 'PAUSED' ? '暂停' : '已结束';
    const text = mobileFire.querySelector('small');
    if (text && text.textContent !== label) text.textContent = label;
    mobileFire.setAttribute('aria-label', label);
  }
  if (['PAUSED', 'WON', 'LOST'].includes(detail.phase)) stopRotation();
  const settleButton = document.querySelector<HTMLButtonElement>('#settle-button');
  if (settleButton) settleButton.disabled = detail.status !== 'READY';
}

function statusLabel(phase: SceneStateDetail['phase'], status: SceneStateDetail['status']): string {
  if (phase === 'PAUSED') return '已存档';
  if (status === 'WON') return '棋盘清空';
  if (status === 'LOST') return '触底';
  if (phase === 'FLYING') return '飞行中';
  if (phase === 'RESOLVING') return '结算中';
  return '选择角度';
}

function updateOrbPreview(element: HTMLElement, colorId: number): void {
  if (element.dataset.colorId === String(colorId)) return;
  element.dataset.colorId = String(colorId);
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
  disposeModal?.(); disposeModal = null;
  stopRotation(); gameAudio.setScene('menu');
  if (modalRoot.hidden) {
    resumeAfterModal = !gameScreen?.hidden && !!getScene() && !getScene()!.isPaused;
    getScene()?.pauseGame();
  }
  modalRoot.innerHTML = `<div class="modal-card ${className}" role="dialog" aria-modal="true">${content}</div>`;
  modalRoot.hidden = false;
  document.documentElement.classList.add('modal-open');
  formatHeadings(modalRoot);
  game?.loop.sleep();
  modalRoot.querySelectorAll<HTMLElement>('[data-close-modal]').forEach(button => button.addEventListener('click', closeModal));
  modalRoot.onclick = handleModalBackdrop;
}

function handleModalBackdrop(event: MouseEvent): void {
  if (modalRoot && event.target === modalRoot && !settingsBack(modalRoot)) closeModal();
}

function closeModal(): void {
  if (!modalRoot) return;
  disposeModal?.(); disposeModal = null;
  modalRoot.hidden = true;
  document.documentElement.classList.remove('modal-open');
  modalRoot.innerHTML = '';
  modalRoot.onclick = null;
  if (resumeAfterModal && !gameScreen?.hidden) { game?.loop.wake(); getScene()?.resumeGame(); }
  resumeAfterModal = false;
}

function showHistory(top = true, page = 0, board = 'endless'): void {
  const data = loadHistory();
  openModal(historyMarkup(data, top, board, page, usesButtonControls()), 'history-card');
  document.querySelectorAll<HTMLElement>('[data-board]').forEach(button => button.addEventListener('click', () => showHistory(top, 0, button.dataset.board)));
  document.querySelector('#history-toggle')?.addEventListener('click', () => showHistory(!top,0,board));
  document.querySelector('#history-prev')?.addEventListener('click', () => showHistory(top,page-1,board));
  document.querySelector('#history-next')?.addEventListener('click', () => showHistory(top,page+1,board));
}

function showTutorial(): void {
  openModal(`
    <button class="modal-close" data-close-modal type="button">关闭</button>
    <p class="eyebrow">FIELD GUIDE / 01</p>
    <h2>三步读懂棋盘</h2>
    <p>无尽与限时模式各有独立存档。存档可以续玩，结算后成绩才会入榜。</p><p>限时模式提供 5 / 10 分钟挑战。菜单、存档与后台均暂停计时。次数或下落时间归零时，棋盘下降，两项计数同时重置。限时清盘后继续补充新棋盘。</p>
    <div class="tutorial-steps">
      <div class="tutorial-step"><b>01</b><div><strong>调整炮口方向</strong><span>${usesButtonControls() ? (settings.immersiveMode ? '沉浸模式：在整个棋盘区域按住拖动瞄准，发射区域也可操作；松手发射。移出棋盘松手或被系统中断会取消发射。设置中可关闭沉浸模式，恢复双滑条。' : '上滑条选择方向，下滑条左右微调。松手停止，另一只手可同时发射。设置 → 操作与反馈可开启沉浸模式，改为棋盘按住瞄准、松手发射。') : `使用鼠标瞄准，鼠标左键、右键或${shortcutLabel(settings.shortcuts.fire)}键发射；${shortcutLabel(settings.shortcuts.left)} / ${shortcutLabel(settings.shortcuts.right)} 长按转向，${shortcutLabel(settings.shortcuts.quickLeft)} / ${shortcutLabel(settings.shortcuts.quickRight)} 快转 30°。设置中可自定义快捷键。`}下落期间仍可转向。</span></div></div>
      <div class="tutorial-step"><b>02</b><div><strong>三个同类连在一起</strong><span>同色相连达到 3 球即可消除。一次消除 3、4、5、6 球，分别得 30、50、80、120 分。</span></div></div>
      <div class="tutorial-step"><b>03</b><div><strong>让悬空小球掉落</strong><span>切断顶部支撑，悬空球就会掉落。掉落 1、2、3 球，额外加 30、70、120 分；掉落越多，加分越高。</span></div></div>
    </div>
    <div class="modal-footer"><button class="primary-button" data-close-modal type="button"><span>知道了，开始</span><b>↗</b></button></div>
  `);
}

function showSettings(): void {
  openModal(settingsMarkup(settings, usesButtonControls()), 'settings-card');
  if (!modalRoot) return;
  disposeModal = bindSettingsPanel(modalRoot, settings, commit => {
    immersiveControl?.reset();
    if (commit) saveSettings(settings);
    gameAudio.setMix(settings.volume, settings.musicVolume);
    gameAudio.setAdaptiveMusic(settings.adaptiveMusic);
    getScene()?.setSettings(settings);
    syncMobileLayout();
  });
}

function showResult(state: GameState): void {
  const won = state.status === 'WON';
  if (state.mode !== 'timed') setHighScore(weightedScore(state));
  clearGame(state.mode);
  selectedMode = state.mode ?? 'endless';
  selectedDuration = state.durationMs ?? 300000;
  selectedDifficulty = state.difficultyId;
  const title = state.endReason === 'timeout' ? '时间到，挑战完成！' : state.endReason === 'settled' ? '本局已结算' : won ? '全部清空，胜利！' : '棋盘触底了。';
  openModal(`
    <button class="modal-close" data-close-modal type="button">关闭</button>
    <div class="result-mark">${won ? '✦' : '!'}</div>
    <p class="eyebrow">${state.endReason ? 'ROUND COMPLETE' : won ? 'BOARD CLEARED' : 'ONE MORE TRY'}</p>
    <h2>${title}</h2>
    <p class="result-description">${state.endReason ? '<span>本局成绩，已为你保存。</span><span>下一局，试着突破自己的纪录。</span>' : won ? '<span>棋盘已清空，这一局很漂亮。</span><span>下一局，试试更大胆的反弹。</span>' : '<span>留意次数，先消掉上方支撑；</span><span>让成片小球一起掉落。</span>'}</p>
    <div class="result-score">${formatScore(weightedScore(state))}</div>
    <div class="result-meta">原始分 ${state.score} × 难度 ${scoreMultiplier(state.difficultyId)}<br>${state.step} 次发射 · 已计入${state.mode === 'timed' ? `限时 ${state.durationMs! / 60000} 分钟` : '无尽'}排行榜</div>
    <div class="modal-footer"><button id="result-retry" class="primary-button" type="button"><span>${won ? '再开一局' : '再试一次'}</span><b>↗</b></button><button id="result-home" class="quiet-button" type="button">返回首页</button></div>
  `, `result-card${won ? '' : ' lost'}`);
  modalRoot?.querySelector<HTMLButtonElement>('#result-retry')?.addEventListener('click', () => {
    resumeAfterModal = false;
    closeModal();
    startRound(null, selectedDifficulty);
  });
  modalRoot?.querySelector<HTMLButtonElement>('#result-home')?.addEventListener('click', () => {
    closeModal();
    showHome();
  });
}

function showModeSetup(mode: GameMode): void {
  selectedMode = mode;
  openModal(`<button class="modal-close" data-close-modal>关闭</button><p class="eyebrow">${mode === 'timed' ? 'RACE THE CLOCK' : 'FIND YOUR RHYTHM'}</p>
    <h2>${mode === 'timed' ? '限时模式' : '无尽模式'}</h2>
    <p>${mode === 'timed' ? '选择 5 或 10 分钟，争取更高得分。</p><p>次数或下落时间归零，棋盘就会下降。可随时存档续玩；新开本局会替换限时存档。' : '按自己的节奏，清空棋盘。</p><p>可随时存档续玩，或主动结算入榜。新开本局会替换无尽存档。'}</p>
    <div class="mode-tabs">${['easy','normal','hard'].map(id => `<button class="quiet-button ${id === selectedDifficulty ? 'active' : ''}" data-setup-difficulty="${id}">${getDifficulty(id).label.split(' · ')[0]} ×${scoreMultiplier(id)}</button>`).join('')}</div>
    ${mode === 'timed' ? `<div class="mode-tabs"><button data-duration="300000" class="quiet-button ${selectedDuration === 300000 ? 'active' : ''}">5 分钟</button><button data-duration="600000" class="quiet-button ${selectedDuration === 600000 ? 'active' : ''}">10 分钟</button></div><p class="mode-note">下落会逐渐加快：简单 36→18 秒，普通 30→15 秒，困难 24→12 秒。</p>` : ''}
    ${loadGame(mode) ? '<button id="mode-continue" class="quiet-button mode-continue">读取此模式存档</button>' : ''}
    <div class="modal-footer"><button id="mode-begin" class="primary-button">开始挑战 ↗</button><button id="mode-ranking" class="quiet-button">查看排行榜</button></div>`);
  document.querySelector('#mode-continue')?.addEventListener('click', () => { closeModal(); continueSaved(mode); });
  document.querySelectorAll<HTMLElement>('[data-setup-difficulty]').forEach(button => button.addEventListener('click', () => {
    selectedDifficulty = button.dataset.setupDifficulty!; showModeSetup(mode); updateHomeState();
  }));
  document.querySelectorAll<HTMLElement>('[data-duration]').forEach(button => button.addEventListener('click', () => {
    selectedDuration = Number(button.dataset.duration); showModeSetup(mode);
  }));
  document.querySelector('#mode-ranking')?.addEventListener('click', () => showHistory(true,0,mode === 'timed' ? `timed-${selectedDuration}` : 'endless'));
  document.querySelector('#mode-begin')?.addEventListener('click', () => {
    const previous = loadGame(mode);
    if (previous) recordRound(previous, true);
    clearGame(mode); closeModal(); startRound(null);
  });
  // Warm the engine after the setup panel paints, when play intent is explicit.
  requestAnimationFrame(() => requestAnimationFrame(() => { void loadRuntime().catch(() => {}); }));
}
document.querySelector('#start-button')?.addEventListener('click', () => loadGame('endless') ? continueSaved('endless') : showModeSetup('endless'));
document.querySelector('#timed-button')?.addEventListener('click', () => loadGame('timed') ? continueSaved('timed') : showModeSetup('timed'));
document.querySelectorAll<HTMLElement>('[data-new-mode]').forEach(button => button.addEventListener('click', () => showModeSetup(button.dataset.newMode as GameMode)));

function continueSaved(mode: GameMode): void {
  const saved = loadGame(mode);
  if (!saved) {
    showToast('没有找到可继续的完整回合');
    updateHomeState();
    return;
  }
  selectedDifficulty = saved.difficultyId;
  selectedMode = mode;
  selectedDuration = saved.durationMs ?? 300000;
  startRound(saved, saved.difficultyId);
}
continueButton?.addEventListener('click', () => continueSaved('endless'));
timedContinueButton?.addEventListener('click', () => continueSaved('timed'));

document.querySelectorAll<HTMLButtonElement>('[data-difficulty]').forEach((button) => {
  button.addEventListener('click', () => {
    selectedDifficulty = button.dataset.difficulty ?? 'normal';
    updateHomeState();
  });
});

document.querySelector<HTMLButtonElement>('#tutorial-button')?.addEventListener('click', showTutorial);
document.querySelector<HTMLButtonElement>('#settings-button')?.addEventListener('click', showSettings);
document.querySelector<HTMLButtonElement>('#game-settings-button')?.addEventListener('click', showSettings);
document.querySelector('#game-help-button')?.addEventListener('click', showTutorial);
function saveAndHome(): void {
  getScene()?.pauseGame();
  showHome();
  showToast('已存档，下次可从首页继续');
}
document.querySelector<HTMLButtonElement>('#pause-button')?.addEventListener('click', saveAndHome);
launchButton?.addEventListener('click', () => getScene()?.launchFromButton());
bindFireButton(document.querySelector<HTMLButtonElement>('#mobile-fire')!, () => { gameAudio.unlock(); getScene()?.launchFromButton(); });
document.querySelector('#mobile-pause-button')?.addEventListener('click', saveAndHome);
document.querySelector('#mobile-help-button')?.addEventListener('click', showTutorial);
document.querySelector('#settle-button')?.addEventListener('click', () => {
  openModal(`<button class="modal-close" data-close-modal>继续游戏</button><h2>结算本局</h2><p>结算后按难度系数计入对应排行榜，本局存档将结束。</p><div class="modal-footer"><button id="desktop-confirm-settle" class="primary-button">结算并计入排行榜</button></div>`);
  document.querySelector('#desktop-confirm-settle')?.addEventListener('click', () => { closeModal(); getScene()?.settleGame(); });
});
function showGameMenu(): void {
  openModal(`<button class="modal-close" data-close-modal type="button">继续游戏</button><h2>游戏菜单</h2>
    <p>本局已暂停并存档。</p><p>继续游玩，或结算成绩后入榜。</p>
    <div class="mobile-menu-actions"><button id="menu-settings" class="quiet-button">设置</button><button id="menu-history" class="quiet-button">历史与排行</button><button id="menu-settle" class="quiet-button">结算并入榜</button><button id="menu-restart" class="quiet-button">放弃本局…</button><button id="menu-home" class="quiet-button">存档并返回首页</button></div>`);
  document.querySelector('#menu-settle')?.addEventListener('click', () => { closeModal(); getScene()?.settleGame(); });
  document.querySelector('#menu-settings')?.addEventListener('click', showSettings);
  document.querySelector('#menu-history')?.addEventListener('click', () => showHistory());
  document.querySelector('#menu-restart')?.addEventListener('click', () => {
    openModal(`<button class="modal-close" id="abandon-cancel">返回菜单</button><h2>放弃本局？</h2><p>本局存档将删除，成绩不计入排行榜。请选择重新开始，或退出到首页。</p><div class="mobile-menu-actions"><button id="abandon-restart" class="primary-button">放弃并重开</button><button id="abandon-exit" class="quiet-button">放弃并退出</button></div>`);
    document.querySelector('#abandon-cancel')?.addEventListener('click', showGameMenu);
    document.querySelector('#abandon-restart')?.addEventListener('click', () => { closeModal(); getScene()?.restartGame(); });
    document.querySelector('#abandon-exit')?.addEventListener('click', () => { getScene()?.abandonGame(); resumeAfterModal = false; showHome(); showToast('已放弃本局'); });
  });
  document.querySelector('#menu-home')?.addEventListener('click', () => { resumeAfterModal = false; closeModal(); showHome(); });
}
document.querySelector('#mobile-menu-button')?.addEventListener('click', showGameMenu);

const aimSlider = document.querySelector<HTMLInputElement>('#aim-slider')!;
const fineSlider = document.querySelector<HTMLInputElement>('#fine-slider')!;
function stopRotation(): void {
  immersiveControl?.reset();
  aimControl?.reset(); fineControl?.reset(); getScene()?.stopRotation();
}
let aimControl: ReturnType<typeof bindSteeringControl> | undefined;
let fineControl: ReturnType<typeof bindSteeringControl> | undefined;
let immersiveControl: ReturnType<typeof bindImmersiveControl> | undefined;
const controlActive = () => !gameScreen?.hidden && !!modalRoot?.hidden;
immersiveControl = bindImmersiveControl(document.querySelector<HTMLElement>('#game-container')!, {
  active: () => usesButtonControls() && settings.immersiveMode && controlActive(), canFire: () => getScene()?.isReady === true,
  aim: degrees => getScene()?.setAimDegrees(degrees), fire: () => getScene()?.launchFromButton(), unlock: () => gameAudio.unlock(),
});
aimControl = bindSteeringControl(aimSlider, { fine: false, hitArea: aimSlider.closest<HTMLElement>('.steering-control')!, active: controlActive, onStart: stopRotation,
  onValue: value => getScene()?.setAimDegrees(directAimDegrees(value)) });
fineControl = bindSteeringControl(fineSlider, { fine: true, hitArea: fineSlider.closest<HTMLElement>('.steering-control')!, active: controlActive, onStart: stopRotation,
  onValue: value => getScene()?.setFineRotation(value) });
const aimAngle = document.querySelector('#aim-angle')!;
window.addEventListener('snood-angle', event => {
  const degrees = (event as CustomEvent<number>).detail;
  const value = degrees.toFixed(1);
  if (aimSlider.value !== value) aimSlider.value = value;
  if (aimAngle.textContent !== `${value}°`) aimAngle.textContent = `${value}°`;
});
window.addEventListener('blur', stopRotation);
document.addEventListener('visibilitychange', stopRotation);
window.addEventListener('snood-fired', () => {
  document.querySelector('#mobile-fire')?.animate([
    { transform: 'scale(1)', filter: 'brightness(1)' },
    { transform: 'scale(.95)', filter: 'brightness(1.25)' },
    { transform: 'scale(1)', filter: 'brightness(1)' },
  ], { duration: 160 });
});
document.querySelector<HTMLButtonElement>('#restart-button')?.addEventListener('click', () => {
  getScene()?.restartGame();
  showToast('新回合已开始');
});
document.querySelector<HTMLButtonElement>('#back-home-button')?.addEventListener('click', () => {
  saveAndHome();
});

window.addEventListener('snood-state', (event) => {
  updateGameState((event as CustomEvent<SceneStateDetail>).detail);
});
window.addEventListener('snood-save-request', (event) => {
  saveGame((event as CustomEvent<Parameters<PlayScene['begin']>[0]>).detail);
  if (!homeScreen?.hidden) updateHomeState();
});
window.addEventListener('snood-clear-save', (event) => {
  clearGame((event as CustomEvent<GameMode>).detail);
  updateHomeState();
});
window.addEventListener('snood-finished', (event) => {
  const state = (event as CustomEvent<GameState>).detail;
  showResult(state);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && !gameScreen?.hidden) showHome();
});

if (Capacitor.isNativePlatform()) {
  void App.addListener('appStateChange', ({ isActive }) => {
    stopRotation();
    gameAudio.setForeground(isActive);
    if (!isActive && !gameScreen?.hidden) showHome();
  });
  void App.addListener('backButton', () => {
    if (modalRoot && !modalRoot.hidden) {
      if (!settingsBack(modalRoot)) closeModal();
    } else if (gameScreen && !gameScreen.hidden) {
      getScene()?.pauseGame();
      showHome();
    } else {
      void App.minimizeApp();
    }
  });
}

window.addEventListener('keydown', (event) => {
  if (usesButtonControls() || event.repeat || event.defaultPrevented || gameScreen?.hidden || !modalRoot?.hidden) return;
  const action = shortcutAction(event, settings.shortcuts);
  const actions: Partial<Record<ShortcutAction, string>> = { save: '#back-home-button', settle: '#settle-button', restart: '#restart-button', settings: '#game-settings-button', history: '.sidebar-actions [data-history]', help: '#game-help-button' };
  const selector = action && actions[action];
  if (!selector) return;
  event.preventDefault(); document.querySelector<HTMLButtonElement>(selector)?.click();
});

formatHeadings(document);
updateHomeState();
window.addEventListener('snood-save-home', saveAndHome);
document.querySelectorAll('[data-history]').forEach(button => button.addEventListener('click', () => showHistory()));
window.addEventListener('snood-storage-error', () => showToast('本地记录未能保存，请检查可用磁盘空间'));
window.addEventListener('beforeunload', () => getScene()?.persistGame());
window.addEventListener('snood-settings-applied', () => gameScreen?.classList.toggle('independent-launch', settings.independentLaunch));


requestAnimationFrame(() => {
  document.documentElement.classList.remove('booting');
  performance.mark('orbbound-home-ready');
  window.dispatchEvent(new Event('orbbound-ready'));
});

bindDesktopBridge(() => { settings = loadSettings(); gameAudio.setMix(settings.volume, settings.musicVolume); gameAudio.setAdaptiveMusic(settings.adaptiveMusic); syncMobileLayout(); closeModal(); updateHomeState(); }, showToast);
window.addEventListener('orbbound-host-background', () => { gameAudio.setForeground(false); if (!gameScreen?.hidden) showHome(); });
window.addEventListener('orbbound-host-foreground', () => gameAudio.setForeground(true));
