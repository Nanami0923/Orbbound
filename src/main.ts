import { CAMPAIGN_LEVELS, getLevel } from './content/campaign';
import { campaignStars, createCampaign } from './core/campaign';
import { isUnlocked, loadProgress } from './storage/campaign';
import { campaignMarkup, campaignPageSize, levelMarkup, starRules } from './ui/campaign-panel';
import { bindDesktopBridge } from './ui/desktop-bridge';
import { bindModalFocus } from './ui/modal-focus';
import { bindAndroidServices, refreshPlatformPerformance, replayDisplayInfo } from './ui/platform-services';
import { bindPracticePanel, practiceMarkup, type PracticeControlMode } from './ui/practice-panel';
import { backupSummary } from './storage/backup';
import { readStorage, writeStorage } from './storage/safe-storage';
import { escapeText, failureAdvice, starBudget } from './ui/progress-feedback';
import { RULES_VERSION } from './core/engine';
import './ui/android-insets';
import { shortcutAction, shortcutLabel, type ShortcutAction } from './game/shortcuts';
import { bindImmersiveControl } from './game/immersive-control';
import { historyMarkup, historyPageSize, historyTrend } from './ui/history-panel';
import type Phaser from 'phaser';
import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { usesButtonControls } from './game/input-mode';
import { countdownProgress } from './game/countdown';
import { DANGER_MAX, getDifficulty, shotsUntilDescent } from './core/engine';
import { createRound, scoreMultiplier, weightedScore, type GameMode } from './core/modes';
import type { GameState } from './core/types';
import type { PlayScene } from './game/PlayScene';
import { updateOrbPreview } from './ui/next-orb-preview';
import { clearGame, hasLegacySave, loadGame, setHighScore, type Settings } from './storage/storage';
import './style.css';
import './ui/windows-v5.css';
import './ui/android-v5.css';
import './ui/v5-components.css';
import { buildHome, updateHome } from './ui/home';
import { gameAudio } from './game/audio';
import { bindFireButton } from './game/fire-control';
import { bindSteeringControl } from './game/steering-control';
import { directAimDegrees } from './game/rotation';
import { settingsMarkup, bindSettingsPanel, settingsBack } from './ui/settings-panel';
import { getSettings, updateSettings, subscribeSettings, reloadSettings } from './storage/settings-store';
import { bindViewportShell, bindModalPages, type ModalLayout } from './ui/viewport-shell';
import { settingsEffects, snapshotSettings } from './ui/settings-effects';
import { syncGameShell } from './ui/game-shell';
import { formatHeadings, prepareModalHeader } from './ui/typography';
import { createModalNavigation, type ModalPage } from './ui/modal-navigation';
import { loadHistory, recordRound, hasCompletedRound, formatDuration, rankingKey, leaderboard, recordRules, roundStanding, type HistoryDifficulty, type HistoryRules } from './storage/history';
import { installLan } from './ui/lan-panel';
import { dangerValueParts } from './ui/danger-value';

interface SceneStateDetail {
  levelId?: number;
  targetsRemaining?: number;
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
  previewNextColor?: number;
  difficultyId: string;
  step: number;
  elapsedMs: number;
}

const requestedV5Platform = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('platform') : null;
const windowsV5 = import.meta.env.MODE === 'windows' || requestedV5Platform === 'windows';
const androidV5 = Capacitor.getPlatform() === 'android' || requestedV5Platform === 'android';
document.documentElement.classList.toggle('windows-v5', windowsV5);
document.documentElement.classList.toggle('android-v5', androidV5);

bindViewportShell();
buildHome(usesButtonControls());
const lan = installLan(showHome);
if (!usesButtonControls()) {
  document.querySelector('.mobile-launch-row')?.remove();
  document.querySelector('.current-card')?.remove();
  document.querySelector('#pause-button')?.remove();
  document.querySelector('.legend-card')?.remove();
  const buttons: Record<string, [ShortcutAction, string]> = {
    'settle-button': ['settle', '结算本局'], 'restart-button': ['restart', '重新开始'],
    'game-settings-button': ['settings', '游戏设置'], 'back-home-button': ['save', '存档并返回'],
  };
  for (const [id, [action, label]] of Object.entries(buttons)) document.querySelector(`#${id}`)!.innerHTML = `<span>${label}</span><kbd data-shortcut="${action}"></kbd>`;
  document.querySelector('.sidebar-actions [data-history]')!.innerHTML = '<span>历史与排行</span><kbd data-shortcut="history"></kbd>';
  document.querySelector('.sidebar-actions')!.insertAdjacentHTML('beforeend', '<button id="game-help-button" class="side-button" type="button"><span>玩法提示</span><kbd data-shortcut="help"></kbd></button>');
  document.querySelector('.sidebar-actions')!.insertAdjacentHTML('beforeend', '<button id="fullscreen-button" class="side-button" type="button"><span>全屏</span><kbd>F11</kbd></button>');
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
const dangerStat = document.querySelector<HTMLElement>('.danger-stat');
const dangerFill = document.querySelector<HTMLElement>('#danger-fill');
const comboFeedback = document.querySelector<HTMLOutputElement>('#combo-feedback');
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

let settings: Settings = getSettings();
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
let comboFeedbackTimer: number | undefined;
let resumeAfterModal = false;
let disposeModal: (() => void) | null = null;
let disposeModalPages: (() => void) | undefined;
let resizeModal: (() => void) | undefined;
let modalResizeFrame = 0;
let settingsOnClosed: (() => void) | undefined;
let settingsRestore: (() => void) | undefined;
let roundRequest = 0;
const modalNavigation = createModalNavigation(closeModal);
let modalPage: ModalPage | undefined;
let releaseModalFocus:(()=>void)|null=null;
let modalReturnFocus:HTMLElement|null=null;
let roundBootTimer:number|undefined;
let roundReadyTimer:number|undefined;
let previousUiDetail:SceneStateDetail|undefined;
let pendingFire=false;
let practiceSeen=readStorage('orbbound-practice-seen')==='1';

function syncAndroidV5Hud(): void {
  if (!androidV5) return;
  const header = gameScreen?.querySelector<HTMLElement>('.game-header');
  const topbar = gameScreen?.querySelector<HTMLElement>('.mobile-topbar');
  const next = gameScreen?.querySelector<HTMLElement>('.next-card');
  const danger = header?.querySelector<HTMLElement>('.danger-stat');
  if (header && next && danger && next.parentElement !== header) danger.after(next);

  const clock = header?.querySelector<HTMLElement>('#round-clock')?.closest<HTMLElement>('.header-stat');
  const help = topbar?.querySelector<HTMLElement>('#mobile-help-button');
  if (topbar && clock && help && clock.parentElement !== topbar) {
    clock.classList.add('android-v5-round-clock');
    topbar.insertBefore(clock, help);
  }
}

function syncMobileLayout(): void {
  if (usesButtonControls()) {
    const preview = document.querySelector('.next-card');
    const target = document.querySelector('.board-heading');
    if (preview && target && preview.parentElement !== target) target.append(preview);
  }
  syncAndroidV5Hud();
  document.documentElement.classList.toggle('immersive-mode', usesButtonControls() && settings.immersiveMode);
  if (gameScreen) syncGameShell(gameScreen, { touch: usesButtonControls(), immersive: settings.immersiveMode, mode: previousUiDetail?.mode ?? selectedMode });
  document.querySelectorAll<HTMLElement>('[data-shortcut]').forEach(label => { label.textContent = shortcutLabel(settings.shortcuts[label.dataset.shortcut as ShortcutAction]); });
  document.documentElement.classList.toggle("desktop-ui", !usesButtonControls());
  document.documentElement.classList.toggle('mobile-ui', usesButtonControls());
  document.documentElement.classList.toggle('controls-swapped', settings.controlsSwapped);
  document.documentElement.classList.toggle('reduce-motion', settings.reducedMotion);
  document.documentElement.style.setProperty('--fire-width', `${settings.fireSize}px`);
  // Leave enough room for the system gesture area on short phones.
  const offset = Math.min(settings.controlOffset, Math.max(0, (window.innerHeight - 640) * 0.24));
  document.documentElement.style.setProperty('--control-offset', `${offset}px`);
}
syncMobileLayout();
window.addEventListener('resize', () => { stopRotation(); syncMobileLayout(); cancelAnimationFrame(modalResizeFrame); modalResizeFrame = requestAnimationFrame(() => resizeModal?.()); });
const singleBoardWrap = document.querySelector<HTMLElement>('#game-screen .board-wrap')!;
const singleBoardSize = new ResizeObserver(() => {
  if (!usesButtonControls() || gameScreen?.hidden) return;
  const heading = singleBoardWrap.querySelector<HTMLElement>('.board-heading');
  const available = Math.max(0, singleBoardWrap.clientHeight - (heading?.getBoundingClientRect().height ?? 0));
  const width = Math.max(1, Math.min(singleBoardWrap.clientWidth, available * 640 / 760));
  const previous = Number.parseFloat(singleBoardWrap.style.getPropertyValue('--single-board-width'));
  if (!Number.isFinite(previous) || Math.abs(previous - width) >= 0.5) {
    singleBoardWrap.style.setProperty('--single-board-width', `${width}px`);
    game?.scale.refresh();
  }
});
singleBoardSize.observe(singleBoardWrap);


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
  if (!game) { game = module.createGame(); replayDisplayInfo(); window.dispatchEvent(new Event('orbbound-query-display')); }
}

function showHome(): boolean {
  roundRequest++;
  window.clearTimeout(roundBootTimer); roundBootTimer=undefined;
  window.clearTimeout(roundReadyTimer); roundReadyTimer=undefined;
  document.documentElement.classList.remove('game-loading');
  gameAudio.setScene('menu');
  const scene = getScene();
  scene?.pauseGame();
  const saved = scene ? scene.persistGame() : true;
  resumeAfterModal = false;
  closeModal();
  game?.loop.sleep();
  if (gameScreen) gameScreen.hidden = true;
  if (homeScreen) homeScreen.hidden = false;
  updateHomeState();
  document.querySelector<HTMLElement>('#campaign-button')?.focus({preventScroll:true});
  return saved;
}

function showGame(): void {
  if (homeScreen) homeScreen.hidden = true;
  if (gameScreen) gameScreen.hidden = false;
}

async function startRound(state: Parameters<PlayScene['begin']>[0] | null, difficulty = selectedDifficulty): Promise<void> {
  if (state && hasCompletedRound(state)) {
    clearGame(state.mode); showHome(); showToast('本局已经结算，不能续玩旧存档'); return;
  }
  const previous = getScene();
  if (previous?.lastPersistenceResult?.ok === false && previous.activeState.status !== 'READY' && !previous.persistGame()) {
    showToast('本局结果尚未保存，请先重试保存后开始新局'); return;
  }
  if (state?.sessionId && previous?.activeState.status !== 'READY' && state.sessionId === previous?.activeState.sessionId) {
    showHome(); showToast('本局已经结算，请开始新局'); return;
  }
  gameAudio.setForeground(true); gameAudio.unlock();
  const request = ++roundRequest, mode = selectedMode, duration = selectedDuration;
  window.clearTimeout(roundBootTimer);
  performance.mark('orbbound-round-request');
  const fail = () => {
    if(request !== roundRequest)return;
    showHome();
    openModal('<button class="modal-close" data-close-modal>返回首页</button><h2>棋盘准备未完成</h2><p>可以重试，存档仍保留在本机。</p><div class="modal-footer"><button id="round-load-retry" class="primary-button">重试</button><button class="quiet-button" data-close-modal>返回首页</button></div>');
    document.querySelector('#round-load-retry')?.addEventListener('click',()=>{closeModal();void startRound(state,difficulty);});
  };
  roundBootTimer=window.setTimeout(fail,15000);
  document.documentElement.classList.add('game-loading');
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  try { await ensureGame(); }
  catch { fail(); return; }
  if (request !== roundRequest) return;
  game?.loop.wake();
  showGame();
  const beginWhenReady = () => {
    if (request !== roundRequest) return;
    const scene = getScene();
    if (!scene?.ready) {
      roundReadyTimer = window.setTimeout(beginWhenReady, 30);
      return;
    }
    scene.setSettings(settings);
    previousUiDetail=undefined;
    scene.begin(state ?? createRound(difficulty, mode, duration));
    gameAudio.setScene('play'); gameAudio.unlock();
    document.documentElement.classList.remove('game-loading');
    window.clearTimeout(roundBootTimer);roundBootTimer=undefined;
    window.clearTimeout(roundReadyTimer);roundReadyTimer=undefined;
    performance.mark('orbbound-round-ready');
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
  const best = leaderboard(loadHistory(),'endless')[0]?.score ?? 0;
  if (homeHighScore) homeHighScore.textContent = `无尽最高 ${formatScore(best)}`;
  if (continueButton) continueButton.textContent = saved ? `无尽存档 · 基础分 ${saved.score}` : '无尽 · 暂无存档';
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
  const previous=previousUiDetail; previousUiDetail=detail;
  const roundChanged=!previous || previous.mode!==detail.mode || previous.levelId!==detail.levelId || previous.difficultyId!==detail.difficultyId;
  if (!lan.isActive() && !document.documentElement.classList.contains('settings-open')) {
    gameAudio.setPressure(detail.musicPressure);
    gameAudio.setScene(!gameScreen?.hidden && modalRoot?.hidden && ['READY', 'FLYING', 'RESOLVING'].includes(detail.phase) ? 'play' : 'menu');
  }
  if (scoreValue && scoreValue.textContent !== formatScore(detail.score)) scoreValue.textContent = formatScore(detail.score);
  const level = detail.mode === 'campaign' ? getLevel(detail.levelId!) : null;
  const timed = detail.mode === 'timed';
  if(roundChanged){
    if (gameScreen) syncGameShell(gameScreen, { touch: usesButtonControls(), immersive: settings.immersiveMode, mode: detail.mode });
    gameScreen?.classList.toggle('campaign-mode', !!level);
    gameScreen?.classList.toggle('timed-mode', timed);
    if (descentTimeRow) descentTimeRow.hidden = !timed;
    if (descentCaption) descentCaption.hidden = timed;
    if (shotCountdownLabel) shotCountdownLabel.hidden = !timed;
  }
  const bars = countdownProgress(detail.difficultyId, detail.danger, detail.descentRemainingMs, detail.descentIntervalMs);
  const remaining = shotsUntilDescent(detail.difficultyId, detail.danger);
  if (dangerValue) {
    const label = detail.status !== 'READY' ? '本局结束' : level ? (level.timeLimitMs ? '限时清空' : `剩余 ${Math.max(0, level.maxShots - detail.step)} 发`) : timed ? `${remaining} 次` : remaining === 1 ? '下一发后下降' : `再发射 ${remaining} 次`;
    const accessibleLabel = label;
    const visualLabel = androidV5 && label === '下一发后下降' ? '1 次' : label;
    if (androidV5) {
      const parts = dangerValueParts(visualLabel);
      if (parts) {
        if (dangerValue.getAttribute('aria-label') !== accessibleLabel) {
          const number = document.createElement('span');
          number.className = 'danger-value-number';
          number.textContent = parts.number;
          const unit = document.createElement('small');
          unit.className = 'unit';
          unit.textContent = parts.unit;
          dangerValue.replaceChildren(number, unit);
          dangerValue.setAttribute('aria-label', accessibleLabel);
        }
      } else if (dangerValue.textContent !== visualLabel || dangerValue.hasAttribute('aria-label')) {
        dangerValue.textContent = visualLabel;
        dangerValue.removeAttribute('aria-label');
      }
    } else if (dangerValue.textContent !== label) dangerValue.textContent = label;
    const shotsLeft = level ? (level.timeLimitMs ? Number.POSITIVE_INFINITY : Math.max(0, level.maxShots - detail.step)) : remaining;
    const critical = detail.status === 'READY' && shotsLeft <= 2;
    const immediate = detail.status === 'READY' && shotsLeft <= 1;
    dangerStat?.classList.toggle('near', critical && !immediate);
    dangerStat?.classList.toggle('urgent', immediate);
  }
  if (dangerFill) {
    const progress = level ? (level.timeLimitMs ? Math.max(0, 100 * (1 - detail.elapsedMs / level.timeLimitMs)) : Math.max(0, 100 * (1 - detail.step / level.maxShots))) : timed ? (detail.status === 'READY' ? bars.shotPercent : 0) : Math.max(0, Math.min(100, detail.danger / DANGER_MAX * 100));
    dangerFill.style.transform = `scaleX(${progress/100})`;
    if(roundChanged)dangerFill.parentElement?.setAttribute('aria-label', level ? '闯关剩余资源' : '下落次数倒计时');
    setAttributeIfChanged(dangerFill.parentElement,'aria-valuenow',String(Math.round(progress)));
    setAttributeIfChanged(dangerFill.parentElement,'aria-valuetext',dangerValue?.getAttribute('aria-label') ?? dangerValue?.textContent ?? '');
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
  if (descentCaption) setTextIfChanged(descentCaption,level ? `${level.targets ? `目标剩余 ${detail.targetsRemaining ?? 0}` : '清空棋盘'}${level.descentEvery ? ` · ${level.descentEvery - detail.step % level.descentEvery} 发后下移` : ' · 不下压'}` : androidV5 ? '距下压' : '距离棋盘下降');
  const budget=document.querySelector<HTMLElement>('#campaign-budget');
  if(budget){budget.hidden=!level;if(level)setTextIfChanged(budget,starBudget(level,detail.step,detail.elapsedMs));}
  const difficultyText = level ? `第 ${level.id} 关 · ${level.name}` : `${detail.mode === 'timed' ? '限时' : '无尽'} · ${getDifficulty(detail.difficultyId).label} ×${scoreMultiplier(detail.difficultyId)}`;
  if (difficultyLabel && difficultyLabel.textContent !== difficultyText) difficultyLabel.textContent = difficultyText;
  const phaseText = detail.mode === 'campaign' && detail.status === 'WON' ? '目标完成' : detail.endReason === 'shots' ? '发数用尽' : detail.endReason ? (detail.endReason === 'timeout' ? '时间到' : '已结算') : statusLabel(detail.phase, detail.status);
  if (gameStatusLabel) setTextIfChanged(gameStatusLabel,pendingFire ? '待发射 · 点击取消' : level && detail.phase==='READY' ? starBudget(level,detail.step,detail.elapsedMs) : phaseText);
  for (const button of [pauseButton, document.querySelector<HTMLButtonElement>('#mobile-pause-button')]) {
    if (!button) continue;
    if (button.textContent !== '存档') button.textContent = '存档';
    button.disabled = detail.status !== 'READY';
    button.setAttribute('aria-label', '存档并返回首页');
  }
  if (nextOrbPreview) updateOrbPreview(nextOrbPreview, detail.previewNextColor ?? detail.nextColor);
  const current = document.querySelector<HTMLElement>('#current-orb-preview');
  if (current) updateOrbPreview(current, import.meta.env.MODE === 'windows' ? detail.nextColor : detail.currentColor);
  const clock = document.querySelector<HTMLElement>('#round-clock');
  if (clock) {
    const clockText = formatDuration(level?.timeLimitMs ? Math.max(0, level.timeLimitMs - detail.elapsedMs + 999) : detail.mode === 'timed' ? Math.max(0, detail.durationMs! - detail.elapsedMs + 999) : detail.elapsedMs);
    if (clock.textContent !== clockText) clock.textContent = clockText;
    const clockLabel = level?.timeLimitMs ? '剩余时间' : detail.mode === 'timed' ? '整局剩余' : '本局用时';
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
  if (settleButton) { settleButton.disabled = detail.status !== 'READY' || !!level; settleButton.hidden = !!level; }
}

function setTextIfChanged(element:HTMLElement,text:string):void { if(element.textContent!==text)element.textContent=text; }
function setAttributeIfChanged(element:HTMLElement|null,name:string,value:string):void { if(element?.getAttribute(name)!==value)element?.setAttribute(name,value); }

function statusLabel(phase: SceneStateDetail['phase'], status: SceneStateDetail['status']): string {
  if (phase === 'PAUSED') return '已存档';
  if (status === 'WON') return '棋盘清空';
  if (status === 'LOST') return '触底';
  if (phase === 'FLYING') return '飞行中';
  if (phase === 'RESOLVING') return '结算中';
  return '选择角度';
}

function showToast(message: string): void {
  if (!toast) return;
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add('show');
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2200);
}

function openModal(content: string, className = '', onDismiss?: () => void, layout: ModalLayout = 'compact'): boolean {
  if (!modalRoot) return false;
  resizeModal = undefined;
  disposeModal?.(); disposeModal = null;
  disposeModalPages?.(); disposeModalPages = undefined;
  stopRotation(); gameAudio.setScene('menu');
  if (modalRoot.hidden) {
    modalReturnFocus=document.activeElement instanceof HTMLElement ? document.activeElement : null;
    resumeAfterModal = !gameScreen?.hidden && !!getScene() && getScene()!.activeState.status === 'READY' && !getScene()!.isPaused;
    const previousPage = modalPage;
    getScene()?.pauseGame();
    if (modalPage !== previousPage) return false;
  }
  releaseModalFocus?.();releaseModalFocus=null;
  const page = modalPage = modalNavigation.open(onDismiss);
  modalRoot.innerHTML = `<div class="modal-card ${className}" role="dialog" aria-modal="true">${content}</div>`;
  modalRoot.hidden = false;
  document.documentElement.classList.add('modal-open');
  formatHeadings(modalRoot);
  prepareModalHeader(modalRoot.querySelector<HTMLElement>('.modal-card')!);
  releaseModalFocus=bindModalFocus(modalRoot.querySelector<HTMLElement>('.modal-card')!,[homeScreen,gameScreen,document.querySelector<HTMLElement>('#lan-screen')].filter((element):element is HTMLElement=>!!element));
  disposeModalPages = bindModalPages(modalRoot.querySelector<HTMLElement>('.modal-card')!, layout);
  game?.loop.sleep();
  modalRoot.querySelectorAll<HTMLElement>('[data-close-modal]').forEach(button => button.addEventListener('click', page.dismiss));
  modalRoot.onclick = handleModalBackdrop;
  return true;
}

function handleModalBackdrop(event: MouseEvent): void {
  if (modalRoot && event.target === modalRoot && !settingsBack(modalRoot)) dismissModal();
}

function dismissModal(): void {
  modalNavigation.dismiss();
}
const modalAction = (action: () => void) => modalPage?.action(action) ?? (() => {});

function closeModal(): void {
  modalNavigation.clear(); modalPage = undefined; resizeModal = undefined;
  if (!modalRoot) return;
  disposeModal?.(); disposeModal = null;
  disposeModalPages?.(); disposeModalPages = undefined;
  const settingsClosed = settingsOnClosed; settingsOnClosed = undefined; settingsRestore = undefined;
  document.documentElement.classList.remove('settings-open');
  releaseModalFocus?.();releaseModalFocus=null;
  modalRoot.hidden = true;
  document.documentElement.classList.remove('modal-open');
  modalRoot.innerHTML = '';
  modalRoot.onclick = null;
  if (resumeAfterModal && !gameScreen?.hidden) { game?.loop.wake(); getScene()?.resumeGame(); }
  resumeAfterModal = false;
  if(modalReturnFocus?.isConnected && !modalReturnFocus.closest('[hidden]'))modalReturnFocus.focus({preventScroll:true});
  else document.querySelector<HTMLElement>(homeScreen?.hidden ? '#game-container' : '#campaign-button')?.focus({preventScroll:true});
  modalReturnFocus=null;
  settingsClosed?.();
}

function showHistory(top = true, page = 0, board = 'endless', difficulty:HistoryDifficulty='all', rules:HistoryRules=RULES_VERSION, onReturn?: () => void): void {
  const data = loadHistory(), capacity = historyPageSize(usesButtonControls());
  openModal(historyMarkup(data, top, board, page, usesButtonControls(),difficulty,rules), 'history-card', onReturn, 'custom');
  resizeModal = () => showHistory(top,Math.floor(page * capacity / historyPageSize(usesButtonControls())),board,difficulty,rules,onReturn);
  document.querySelector('#history-toggle')?.addEventListener('click', modalAction(() => showHistory(!top,0,board,difficulty,rules,onReturn)));
  document.querySelector('#history-prev')?.addEventListener('click', modalAction(() => showHistory(top,page-1,board,difficulty,rules,onReturn)));
  document.querySelector('#history-next')?.addEventListener('click', modalAction(() => showHistory(top,page+1,board,difficulty,rules,onReturn)));
  document.querySelector<HTMLSelectElement>('#history-board')?.addEventListener('change', event => showHistory(top,0,(event.target as HTMLSelectElement).value,difficulty,rules,onReturn));
  document.querySelector<HTMLSelectElement>('#history-difficulty')?.addEventListener('change', event => showHistory(top,0,board,(event.target as HTMLSelectElement).value as HistoryDifficulty,rules,onReturn));
  document.querySelector<HTMLSelectElement>('#history-rules')?.addEventListener('change', event => showHistory(top,0,board,difficulty,(event.target as HTMLSelectElement).value as HistoryRules,onReturn));
  document.querySelector('#history-explain')?.addEventListener('click', () => {
    const back = () => showHistory(top,page,board,difficulty,rules,onReturn);
    openModal(`<button class="modal-close" data-close-modal>返回记录</button><h2>排名规则与趋势</h2><p>结算分 = 基础分 × 难度系数。简单 ×1，普通 ×1.5，困难 ×2。</p><p>同分时用时较短者优先，再同分按较早结算排序。重开不入榜，新旧规则分开排名。</p>${historyTrend(data,board,difficulty,rules)}`, '', back, 'paged');
  });
}

function showTutorial(onReturn?: () => void): void {
  const closeLabel = onReturn ? '返回上级' : gameScreen?.hidden ? '返回首页' : '继续游戏';
  openModal(`
    <button class="modal-close" data-close-modal type="button">${closeLabel}</button>
    <p class="eyebrow">FIELD GUIDE / 01</p>
    <h2>三步读懂棋盘</h2>
    <p>闯关模式：30 个高难度固定关卡，通关解锁下一关；限发、目标球与限时挑战拥有独立存档和星级。白圈标记目标球，消除或掉落均可；限时关只有可以操作时才计时。</p><p>无尽与限时模式各有独立存档。存档可以续玩，结算后成绩才会入榜。</p><p>限时模式提供 5 / 10 分钟挑战。菜单、存档与后台均暂停计时。次数或下落时间归零时，棋盘下降，两项计数同时重置。限时清盘后继续补充新棋盘。</p>
    <div class="tutorial-steps">
      <div class="tutorial-step"><b>01</b><div><strong>调整炮口方向</strong><span>${usesButtonControls() ? (settings.immersiveMode ? '沉浸模式：在整个棋盘区域按住拖动瞄准，发射区域也可操作；松手发射。移出棋盘松手或被系统中断会取消发射。设置中可关闭沉浸模式，恢复双滑条。' : '上滑条选择方向，下滑条左右微调。松手停止，另一只手可同时发射。设置 → 操作与反馈可开启沉浸模式，改为棋盘按住瞄准、松手发射。') : `使用鼠标瞄准，鼠标左键、右键或${shortcutLabel(settings.shortcuts.fire)}键发射；${shortcutLabel(settings.shortcuts.left)} / ${shortcutLabel(settings.shortcuts.right)} 长按转向，${shortcutLabel(settings.shortcuts.quickLeft)} / ${shortcutLabel(settings.shortcuts.quickRight)} 快转 30°。设置中可自定义快捷键。`}下落期间仍可转向。</span></div></div>
      <div class="tutorial-step"><b>02</b><div><strong>三个同类连在一起</strong><span>同色相连达到 3 球即可消除。一次消除 3、4、5、6 球，分别得 30、50、80、120 分。</span></div></div>
      <div class="tutorial-step"><b>03</b><div><strong>让悬空小球掉落</strong><span>切断顶部支撑，悬空球就会掉落。掉落 1、2、3 球，额外加 30、70、120 分；掉落越多，加分越高。</span></div></div>
    </div>
    <div class="modal-footer"><button id="help-practice" class="primary-button" type="button">动手练习 →</button><button class="quiet-button" data-close-modal type="button">${closeLabel}</button></div>
  `, '', onReturn, 'paged');
  document.querySelector('#help-practice')?.addEventListener('click',modalAction(()=>showPractice(onReturn,()=>showTutorial(onReturn))));
}

function showPractice(onReturn?:()=>void,onCancel:()=>void=showTutorial):void {
  const controlMode:PracticeControlMode=usesButtonControls() ? settings.immersiveMode ? 'immersive' : 'buttons' : 'desktop';
  const finish=()=>{practiceSeen=true;writeStorage('orbbound-practice-seen','1');if(onReturn)onReturn();else closeModal();};
  openModal(practiceMarkup(controlMode),'practice-card',onCancel,'custom');
  const complete = modalAction(finish);
  if(modalRoot)disposeModal=bindPracticePanel(modalRoot,{controlMode,shortcuts:settings.shortcuts,sensitivity:settings.sensitivity,onComplete:complete,onSkip:complete,onClose:modalPage!.dismiss});
}

function showSettings(onClosed?: () => void, onReturn?: () => void, page = 'root'): void {
  if (document.documentElement.classList.contains('settings-open')) return;
  const leaveSettings = onReturn ? () => {
    disposeModal?.(); disposeModal = null;
    const closed = settingsOnClosed; settingsOnClosed = undefined;
    settingsRestore = undefined;
    document.documentElement.classList.remove('settings-open');
    closed?.(); onReturn();
  } : undefined;
  if (!openModal(settingsMarkup(settings, usesButtonControls(), lan.isActive() || !gameScreen?.hidden), 'settings-card', leaveSettings, 'custom')) return;
  if (!modalRoot) return;
  settingsOnClosed = onClosed;
  settingsRestore = () => showSettings(onClosed, onReturn, 'backup');
  document.documentElement.classList.add('settings-open');
  disposeModal = bindSettingsPanel(modalRoot, settings, commit => updateSettings(settings, { persist: commit }));
  window.dispatchEvent(new Event('orbbound-settings-open'));
  if (page !== 'root') modalRoot.querySelector<HTMLButtonElement>(`[data-settings-open="${page}"]`)?.click();
}
let appliedSettings = snapshotSettings(settings);
subscribeSettings(value => {
  const changed = settingsEffects(appliedSettings, value); appliedSettings = snapshotSettings(value);
  settings = value;
  if (changed.controls) immersiveControl?.reset();
  if (changed.audio) { gameAudio.setMix(settings.volume, settings.musicVolume); gameAudio.setAdaptiveMusic(settings.adaptiveMusic); }
  getScene()?.setSettings(settings);
  if (changed.controls || changed.visual) syncMobileLayout();
  if (changed.frameRate) void refreshPlatformPerformance(settings);
});
window.addEventListener('orbbound-open-settings', event => {
  showSettings((event as CustomEvent<{ onClosed?: () => void }>).detail?.onClosed);
});
window.addEventListener('orbbound-close-settings', () => {
  if (document.documentElement.classList.contains('settings-open')) closeModal();
});

let campaignPage = 0, campaignChapter = '';
function showCampaign(): void {
  const capacity = campaignPageSize();
  openModal(campaignMarkup(loadProgress(), loadGame('campaign'), campaignPage, campaignChapter), 'campaign-panel campaign-picker', undefined, 'custom');
  resizeModal = () => { campaignPage = Math.floor(campaignPage * capacity / campaignPageSize()); showCampaign(); };
  const chapterSelect = modalRoot?.querySelector<HTMLSelectElement>('#campaign-chapter');
  campaignChapter = chapterSelect?.value ?? '';
  chapterSelect?.addEventListener('change', () => { campaignChapter = chapterSelect.value; campaignPage = 0; showCampaign(); });
  modalRoot?.querySelector('#campaign-prev')?.addEventListener('click', () => { campaignPage = Math.max(0, campaignPage - 1); showCampaign(); });
  modalRoot?.querySelector('#campaign-next')?.addEventListener('click', () => { campaignPage++; showCampaign(); });
  modalRoot?.querySelector('#campaign-resume')?.addEventListener('click', () => { resumeAfterModal = false; closeModal(); continueSaved('campaign'); });
  modalRoot?.querySelectorAll<HTMLButtonElement>('[data-level]').forEach(button => button.addEventListener('click', () => {
    const id = Number(button.dataset.level);
    if (!isUnlocked(id)) return;
    openModal(levelMarkup(getLevel(id), loadProgress(), loadGame('campaign')), 'campaign-panel', showCampaign, 'paged');
    modalRoot?.querySelector('#campaign-back')?.addEventListener('click', modalPage!.dismiss);
    modalRoot?.querySelector('#campaign-begin')?.addEventListener('click', modalAction(() => beginCampaign(id)));
  }));
}

function beginCampaign(id: number): void {
  if (!isUnlocked(id)) return;
  if(!practiceSeen){showPractice(()=>beginCampaign(id),showCampaign);return;}
  selectedMode = 'campaign';
  resumeAfterModal = false; closeModal();
  void startRound(createCampaign(id));
}

function showCampaignResult(state: GameState): void {
  const saved = getScene()?.lastPersistenceResult?.ok === true;
  const level = getLevel(state.levelId!), won = state.status === 'WON', stars = campaignStars(state);
  const next = CAMPAIGN_LEVELS.find(candidate => candidate.id === level.id + 1);
  const starMarkup = Array.from({ length: 3 }, (_, index) => `<span class="campaign-result-star${index < stars ? ' earned' : ''}" style="--star-delay:${index * 140}ms" aria-hidden="true">${index < stars ? '★' : '☆'}</span>`).join('');
  openModal(`<button class="modal-close" data-close-modal>关闭</button><p class="eyebrow">第 ${level.id} 关 / ${level.name}</p><h2>${won ? next ? '目标完成，继续向前' : '三十关，全部走过' : state.endReason === 'shots' ? '发数用尽，再想一步' : state.endReason === 'timeout' ? '时间到了，再试一次' : '棋盘触底，再试一次'}</h2><div class="campaign-result-stars" aria-label="${stars} 星">${starMarkup}</div><p>${state.step} 次发射 · 操作用时 ${formatDuration(state.elapsedMs ?? 0)}</p><p>${won ? starRules(level) : escapeText(failureAdvice(state,level))}</p>${won && stars<3 ? `<p>${escapeText(starBudget(level,state.step,state.elapsedMs??0))}。重试同一布局，争取更少发数或更短操作时间。</p>` : ''}${won && !next ? `<p>你已完成本篇章。可以返回选关，挑战全部 ${CAMPAIGN_LEVELS.length * 3} 星。</p>` : ''}<div class="modal-footer">${won && next ? '<button id="campaign-next" class="primary-button">下一关 →</button>' : ''}<button id="campaign-retry" class="${won && next ? 'quiet-button' : 'primary-button'}">重试本关</button><button id="campaign-select" class="quiet-button">返回选关</button><button id="campaign-home" class="quiet-button">首页</button></div>`, 'result-card', showHome, 'paged');
  modalRoot?.querySelector('#campaign-next')?.addEventListener('click', modalAction(() => beginCampaign(next!.id)));
  modalRoot?.querySelector('#campaign-retry')?.addEventListener('click', modalAction(() => beginCampaign(level.id)));
  modalRoot?.querySelector('#campaign-select')?.addEventListener('click', modalAction(() => { showHome(); showCampaign(); }));
  modalRoot?.querySelector('#campaign-home')?.addEventListener('click', modalPage!.dismiss);
  bindResultSaveRetry(state, saved);
}

function showResult(state: GameState): void {
  if (state.mode === 'campaign') { showCampaignResult(state); return; }
  const won = state.status === 'WON';
  const persistence = getScene()?.lastPersistenceResult;
  const saved = persistence?.ok === true;
  const resultRecorded = saved || persistence?.kind === 'clear';
  if (resultRecorded && state.mode !== 'timed') setHighScore(weightedScore(state));
  selectedMode = state.mode ?? 'endless';
  selectedDuration = state.durationMs ?? 300000;
  selectedDifficulty = state.difficultyId;
  const title = state.endReason === 'timeout' ? '时间到，挑战完成！' : state.endReason === 'settled' ? '本局已结算' : won ? '全部清空，胜利！' : '棋盘触底了。';
  const standing=roundStanding(loadHistory(),state);
  openModal(`
    <button class="modal-close" data-close-modal type="button">关闭</button>
    <div class="result-mark">${won ? '✦' : '!'}</div>
    <p class="eyebrow">${state.endReason ? 'ROUND COMPLETE' : won ? 'BOARD CLEARED' : 'ONE MORE TRY'}</p>
    <h2>${title}</h2>
    <p class="result-description">${!resultRecorded ? '<span>本局结果暂未保存，原存档已保留。</span><span>请重试保存，再开始新局。</span>' : state.endReason ? '<span>本局成绩，已为你保存。</span><span>下一局，试着突破自己的纪录。</span>' : won ? '<span>棋盘已清空，这一局很漂亮。</span><span>下一局，试试更大胆的反弹。</span>' : `<span>${escapeText(failureAdvice(state))}</span>`}</p>
    <p class="eyebrow">结算分</p>
    <div class="result-score">${formatScore(weightedScore(state))}</div>
    <div class="result-meta">基础分 ${state.score} × 难度 ${scoreMultiplier(state.difficultyId)}<br>${state.step} 次发射 · ${resultRecorded ? '已计入' : '尚未计入'}${state.mode === 'timed' ? `限时 ${state.durationMs! / 60000} 分钟` : '无尽'}排行榜</div>
    <p class="result-progress">${!resultRecorded ? '保存成功后会更新排行榜。' : !saved ? '成绩已保存，旧存档清理未完成，请重试。' : `${standing.newRecord ? '新纪录！' : standing.difference===0 ? '追平个人最佳' : `距个人最佳 ${Math.abs(standing.difference).toLocaleString('zh-CN')} 分`}${standing.rank ? ` · 本榜第 ${standing.rank}` : ' · 本榜前十之外'}`}</p>
    <div class="modal-footer"><button id="result-retry" class="primary-button" type="button"><span>${won ? '再开一局' : '再试一次'}</span><b>↗</b></button><button id="result-ranking" class="quiet-button" type="button">查看本榜</button><button id="result-home" class="quiet-button" type="button">返回首页</button></div>
  `, `result-card${won ? '' : ' lost'}`, showHome, 'paged');
  modalRoot?.querySelector<HTMLButtonElement>('#result-retry')?.addEventListener('click', modalAction(() => {
    resumeAfterModal = false;
    closeModal();
    startRound(null, selectedDifficulty);
  }));
  modalRoot?.querySelector<HTMLButtonElement>('#result-home')?.addEventListener('click', modalPage!.dismiss);
  modalRoot?.querySelector('#result-ranking')?.addEventListener('click',modalAction(()=>{showHome();showHistory(true,0,rankingKey(state),'all',recordRules(state));}));
  bindResultSaveRetry(state, saved);
}

function bindResultSaveRetry(state: GameState, saved: boolean): void {
  if (saved || !modalRoot) return;
  disposeModalPages?.(); disposeModalPages = undefined;
  for (const selector of ['#result-retry', '#campaign-retry', '#campaign-next']) {
    const button = modalRoot.querySelector<HTMLButtonElement>(selector); if (button) button.disabled = true;
  }
  const footer = modalRoot.querySelector('.modal-footer');
  const button = document.createElement('button'); button.className = 'quiet-button'; button.id = 'result-save-retry'; button.textContent = '重试保存';
  button.addEventListener('click', modalAction(() => { getScene()?.persistGame(); showResult(state); }));
  footer?.prepend(button);
  if (state.mode === 'campaign') {
    const message = document.createElement('p'); message.className = 'result-progress'; message.textContent = '本关结果保存或存档清理未完成，原副本已保留。';
    footer?.before(message);
  }
  disposeModalPages = bindModalPages(modalRoot.querySelector<HTMLElement>('.modal-card')!, 'paged');
}

function showModeSetup(mode: GameMode): void {
  if (mode === 'campaign') { showCampaign(); return; }
  selectedMode = mode;
  openModal(`<button class="modal-close" data-close-modal>关闭</button><p class="eyebrow">${mode === 'timed' ? 'RACE THE CLOCK' : 'FIND YOUR RHYTHM'}</p>
    <h2>${mode === 'timed' ? '限时模式' : '无尽模式'}</h2>
    <p>${mode === 'timed' ? '选择 5 或 10 分钟，争取更高得分。</p><p>次数或下落时间归零，棋盘就会下降。可随时存档续玩；新开本局会替换限时存档。' : '按自己的节奏，清空棋盘。</p><p>可随时存档续玩，或主动结算入榜。新开本局会替换无尽存档。'}</p>
    <div class="mode-tabs">${['easy','normal','hard'].map(id => `<button class="quiet-button ${id === selectedDifficulty ? 'active' : ''}" data-setup-difficulty="${id}">${getDifficulty(id).label.split(' · ')[0]} ×${scoreMultiplier(id)}</button>`).join('')}</div>
    ${mode === 'timed' ? `<div class="mode-tabs"><button data-duration="300000" class="quiet-button ${selectedDuration === 300000 ? 'active' : ''}">5 分钟</button><button data-duration="600000" class="quiet-button ${selectedDuration === 600000 ? 'active' : ''}">10 分钟</button></div><p class="mode-note">下落会逐渐加快：简单 36→18 秒，普通 30→15 秒，困难 24→12 秒。</p>` : ''}
    ${loadGame(mode) ? '<button id="mode-continue" class="quiet-button mode-continue">读取此模式存档</button>' : ''}
    <div class="modal-footer"><button id="mode-begin" class="primary-button">开始挑战 ↗</button><button id="mode-ranking" class="quiet-button">查看排行榜</button></div>`, '', undefined, 'paged');
  document.querySelector('#mode-continue')?.addEventListener('click', () => { closeModal(); continueSaved(mode); });
  document.querySelectorAll<HTMLElement>('[data-setup-difficulty]').forEach(button => button.addEventListener('click', () => {
    selectedDifficulty = button.dataset.setupDifficulty!; showModeSetup(mode); updateHomeState();
  }));
  document.querySelectorAll<HTMLElement>('[data-duration]').forEach(button => button.addEventListener('click', () => {
    selectedDuration = Number(button.dataset.duration); showModeSetup(mode);
  }));
  document.querySelector('#mode-ranking')?.addEventListener('click', modalAction(() => showHistory(true,0,mode === 'timed' ? `timed-${selectedDuration}` : 'endless','all',RULES_VERSION,()=>showModeSetup(mode))));
  document.querySelector('#mode-begin')?.addEventListener('click', modalAction(() => {
    const begin=()=>{const scene = getScene(); if (scene?.lastPersistenceResult?.ok === false && scene.activeState.status !== 'READY' && !scene.persistGame()) { showToast('本局结果尚未保存，原副本已保留'); showModeSetup(mode); return; } const previous = loadGame(mode);if (previous?.sessionId && previous.step > 0 && !recordRound(previous, true)) { showToast('本局记录未能保存，原存档已保留'); showModeSetup(mode); return; }if(!clearGame(mode)){showModeSetup(mode);return;} closeModal();void startRound(null);};
    if(!practiceSeen)showPractice(begin,()=>showModeSetup(mode));else begin();
  }));
  // Warm the engine after the setup panel paints, when play intent is explicit.
  requestAnimationFrame(() => requestAnimationFrame(() => { void loadRuntime().catch(() => {}); }));
}
document.querySelector('#campaign-button')?.addEventListener('click', showCampaign);
document.querySelector('#start-button')?.addEventListener('click', () => showModeSetup('endless'));
document.querySelector('#timed-button')?.addEventListener('click', () => showModeSetup('timed'));
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

document.querySelector<HTMLButtonElement>('#tutorial-button')?.addEventListener('click', () => showTutorial());
document.querySelector<HTMLButtonElement>('#settings-button')?.addEventListener('click', () => showSettings());
document.querySelector<HTMLButtonElement>('#game-settings-button')?.addEventListener('click', () => showSettings());
document.querySelector('#game-help-button')?.addEventListener('click', () => showTutorial());
document.querySelector('#fullscreen-button')?.addEventListener('click',()=>window.dispatchEvent(new Event('orbbound-request-fullscreen')));
document.querySelector('#round-load-cancel')?.addEventListener('click',showHome);
function saveAndHome(): void {
  if (showHome()) showToast('已存档，下次可从首页继续');
  else showToast('本局尚未保存，已保留原副本；请恢复存储后重试');
}
document.querySelector<HTMLButtonElement>('#pause-button')?.addEventListener('click', saveAndHome);
launchButton?.addEventListener('click', () => { if (controlActive()) getScene()?.launchFromButton(); });
bindFireButton(document.querySelector<HTMLButtonElement>('#mobile-fire')!, () => { if (!controlActive()) return; gameAudio.unlock(); getScene()?.launchFromButton(); });
document.querySelector('#mobile-pause-button')?.addEventListener('click', saveAndHome);
document.querySelector('#mobile-help-button')?.addEventListener('click', () => showTutorial());
document.querySelector('#settle-button')?.addEventListener('click', () => {
  openModal(`<button class="modal-close" data-close-modal>继续游戏</button><h2>结算本局</h2><p>结算后按难度系数计入对应排行榜，本局存档将结束。</p><div class="modal-footer"><button id="desktop-confirm-settle" class="primary-button">结算并计入排行榜</button></div>`);
  document.querySelector('#desktop-confirm-settle')?.addEventListener('click', modalAction(() => { resumeAfterModal = false; closeModal(); getScene()?.settleGame(); }));
});
function showGameMenu(): void {
  const campaign = getScene()?.activeState.mode === 'campaign';
  openModal(`<button class="modal-close" data-close-modal type="button">继续游戏</button><h2>游戏菜单</h2>
    <p>本局已暂停。</p><p>${campaign ? '完成目标获得星级，可随时重试本关。' : '继续游玩，或结算成绩后入榜。'}</p>
    <div class="mobile-menu-actions"><button id="menu-settings" class="quiet-button">设置</button><button id="menu-history" class="quiet-button">历史与排行</button>${campaign ? '' : '<button id="menu-settle" class="quiet-button">结算并入榜</button>'}<button id="menu-restart" class="quiet-button">放弃本局…</button><button id="menu-home" class="quiet-button">存档并返回首页</button></div>`, '', undefined, 'paged');
  document.querySelector('#menu-settle')?.addEventListener('click', modalAction(() => { resumeAfterModal = false; closeModal(); getScene()?.settleGame(); }));
  document.querySelector('#menu-settings')?.addEventListener('click', modalAction(() => showSettings(undefined, showGameMenu)));
  document.querySelector('#menu-history')?.addEventListener('click', modalAction(() => showHistory(true,0,'endless','all',RULES_VERSION,showGameMenu)));
  document.querySelector('#menu-restart')?.addEventListener('click', modalAction(() => {
    openModal(`<button class="modal-close" data-close-modal>返回菜单</button><h2>放弃本局？</h2><p>本局存档将删除，成绩不计入排行榜。请选择重新开始，或退出到首页。</p><div class="mobile-menu-actions"><button id="abandon-restart" class="primary-button">放弃并重开</button><button id="abandon-exit" class="quiet-button">放弃并退出</button></div>`, '', showGameMenu);
    document.querySelector('#abandon-restart')?.addEventListener('click', modalAction(restartCurrentRound));
    document.querySelector('#abandon-exit')?.addEventListener('click', modalAction(() => {
      if (!getScene()?.abandonGame()) { showToast('放弃未完成，原存档已保留'); showGameMenu(); return; }
      resumeAfterModal = false; showHome(); showToast('已放弃本局');
    }));
  }));
  document.querySelector('#menu-home')?.addEventListener('click', modalAction(saveAndHome));
}
function restartCurrentRound(): void {
  if (!getScene()?.restartGame()) { showToast('重开未完成，原存档已保留'); showGameMenu(); return; }
  closeModal(); game?.loop.wake(); getScene()?.resumeGame(); showToast('新回合已开始');
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
  onPending:pending=>{pendingFire=pending;const badge=document.querySelector<HTMLElement>('#pending-fire');if(badge)badge.hidden=!pending;if(gameStatusLabel)setTextIfChanged(gameStatusLabel,pending ? '待发射 · 点击取消' : previousUiDetail ? statusLabel(previousUiDetail.phase,previousUiDetail.status) : '选择角度');},
});
document.querySelector('#pending-fire')?.addEventListener('click',()=>immersiveControl?.reset());
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
  if(settings.reducedMotion)return;
  document.querySelector('#mobile-fire')?.animate([
    { transform: 'scale(1)', filter: 'brightness(1)' },
    { transform: 'scale(.95)', filter: 'brightness(1.25)' },
    { transform: 'scale(1)', filter: 'brightness(1)' },
  ], { duration: 160 });
});
document.querySelector<HTMLButtonElement>('#restart-button')?.addEventListener('click', () => {
  const scene=getScene();if(!scene)return;
  if(scene.activeState.step===0 || scene.activeState.status!=='READY'){restartCurrentRound();return;}
  openModal('<button class="modal-close" data-close-modal>继续游戏</button><h2>放弃当前局并重开？</h2><p>当前进度会结束，重开不计入正常排行榜。</p><div class="modal-footer"><button class="quiet-button" data-autofocus data-close-modal>继续游戏</button><button id="confirm-restart" class="primary-button">放弃并重开</button></div>');
  document.querySelector('#confirm-restart')?.addEventListener('click',modalAction(restartCurrentRound));
});
document.querySelector<HTMLButtonElement>('#back-home-button')?.addEventListener('click', () => {
  saveAndHome();
});

window.addEventListener('snood-state', (event) => {
  updateGameState((event as CustomEvent<SceneStateDetail>).detail);
});
window.addEventListener('snood-combo', (event) => {
  if ((!windowsV5 && !androidV5) || !comboFeedback) return;
  const count = Number((event as CustomEvent<{ count: number }>).detail?.count);
  if (!Number.isInteger(count) || count < 2) return;
  window.clearTimeout(comboFeedbackTimer);
  comboFeedback.textContent = `连击 ×${count}`;
  comboFeedback.hidden = false;
  comboFeedback.classList.remove('is-active');
  void comboFeedback.offsetWidth;
  comboFeedback.classList.add('is-active');
  comboFeedbackTimer = window.setTimeout(() => {
    comboFeedback.classList.remove('is-active');
    comboFeedbackTimer = window.setTimeout(() => { comboFeedback.hidden = true; }, 220);
  }, 1030);
});
window.addEventListener('snood-round-start', () => {
  window.clearTimeout(comboFeedbackTimer);
  comboFeedback?.classList.remove('is-active');
  if (comboFeedback) comboFeedback.hidden = true;
});
window.addEventListener('snood-persistence-result', (event) => {
  const detail = (event as CustomEvent<{ ok: boolean; kind: 'save' | 'result' | 'clear' }>).detail;
  if (!homeScreen?.hidden) updateHomeState();
  if (!detail.ok) showToast(detail.kind === 'clear' ? '结果已保存，旧存档尚未清理，可重试' : detail.kind === 'result' ? '本局结果暂未保存，原副本已保留' : '存档未能保存，原副本已保留');
});
window.addEventListener('snood-finished', (event) => {
  const state = (event as CustomEvent<GameState>).detail;
  showResult(state);
});

document.addEventListener('visibilitychange', () => {
  if (lan.isActive()) { lan.foreground(!document.hidden); return; }
  if (document.hidden && !gameScreen?.hidden) showHome();
});

if (Capacitor.isNativePlatform()) {
  void App.addListener('appStateChange', ({ isActive }) => {
    stopRotation();
    gameAudio.setForeground(isActive);
    if (lan.isActive()) { lan.foreground(isActive); return; }
    if (!isActive && !gameScreen?.hidden) showHome();
  });
  void App.addListener('backButton', () => {
    if (modalRoot && !modalRoot.hidden) {
      if (!settingsBack(modalRoot)) dismissModal();
    } else if (lan.isActive()) { lan.back(); return;
    } else if (gameScreen && !gameScreen.hidden) {
      getScene()?.pauseGame();
      showHome();
    } else {
      void App.minimizeApp();
    }
  });
}

window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape' && !event.repeat && modalRoot && !modalRoot.hidden) {
    event.preventDefault(); event.stopImmediatePropagation();
    if (!settingsBack(modalRoot)) dismissModal();
    return;
  }
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

bindDesktopBridge(() => {
  const previousGame=game;game=null;resumeAfterModal=false;roundRequest++;
  previousGame?.destroy(true);previousGame?.loop.wake();
  settings=reloadSettings();gameAudio.setMix(settings.volume,settings.musicVolume);gameAudio.setAdaptiveMusic(settings.adaptiveMusic);
  previousUiDetail=undefined;syncMobileLayout();showHome();void refreshPlatformPerformance(settings);
}, showToast,(text,commit)=>{
  const fromSettings = document.documentElement.classList.contains('settings-open');
  if (lan.isActive() || !gameScreen?.hidden || (!modalRoot?.hidden && !fromSettings)) { showToast('页面已变化，请回到数据与维护重新导入'); return; }
  const back = fromSettings ? settingsRestore : showHome;
  closeModal();
  const confirm = () => {
    openModal(`<button class="modal-close" data-close-modal>取消</button><h2>导入备份？</h2><p>${escapeText(backupSummary(text))}</p><p>同名数据会替换，导入前会保留恢复副本。</p><div class="modal-footer"><button class="quiet-button" data-autofocus data-close-modal>取消</button><button id="confirm-backup-import" class="primary-button">确认导入</button></div>`, '', back);
    document.querySelector('#confirm-backup-import')?.addEventListener('click',modalAction(commit));
  };
  confirm();
});
bindAndroidServices(()=>settings);
window.addEventListener('snood-performance',event=>{
  const detail=(event as CustomEvent<{source?:string;requested?:number;renderFps:number;targetFps:number;idle:boolean;reason:string}>).detail;
  if (lan.isActive() !== (detail.source === 'lan')) return;
  const label=`${Math.round(detail.renderFps)} FPS · 请求 ${detail.requested ?? settings.frameRate} / 调度 ${Math.round(detail.targetFps * 100) / 100}${detail.idle ? ' · 静止按需' : ''}`;
  const badge=document.querySelector<HTMLElement>('#performance-badge');if(badge){badge.hidden=!settings.showPerformance||(lan.isActive() ? !document.querySelector('#lan-screen.lan-in-game') : !!gameScreen?.hidden);if(settings.showPerformance)setTextIfChanged(badge,label);}
  const status=document.querySelector<HTMLElement>('#settings-performance-status');if(status)setTextIfChanged(status,label);
});
window.addEventListener('orbbound-host-background', () => { gameAudio.setForeground(false); if (lan.isActive()) { lan.foreground(false); return; } if (!gameScreen?.hidden) showHome(); });
window.addEventListener('orbbound-host-foreground', () => { gameAudio.setForeground(true); if (lan.isActive()) lan.foreground(true); });
