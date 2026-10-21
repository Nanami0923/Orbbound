import Phaser from 'phaser';
import { advanceCampaign, createCampaign } from '../core/campaign';
import { recordCampaign } from '../storage/campaign';
import { cellKey, cellToPoint } from '../core/grid';
import { createGameState, resolveShot } from '../core/engine';
import { traceShot } from '../core/physics';
import type { Cell, GameEvent, GameState, Point } from '../core/types';
import { BOARD_GEOMETRY, GAME_HEIGHT, GAME_WIDTH, UI_COLORS } from '../content/game-config';
import { getOrbTheme, getOrbThemeVariant } from '../content/theme';
import { BOARD_APPEARANCE, BOARD_APPEARANCE_V5, boardBackground, boardGeometry, drawAimMarkers, drawArena, drawDangerLine, drawLauncherBarrel, drawLauncherBase, isV5BoardAppearance } from '../render/board-appearance';
import { clearMotionPlatform, clearMotionSeed, clearOrbPose, clearParticleCap, clearParticlePose, createClearParticles, V5_CLEAR_MOTION, type ClearOrb, type ClearParticle } from '../render/clear-motion';
import { shouldReduceMotion, systemPrefersReducedMotion } from '../render/motion-preferences';
import { paintOrbArtwork } from '../render/board-artwork';
import { clearGame, DEFAULT_SETTINGS, saveGame, type Settings } from '../storage/storage';
import { gameAudio, boardMusicPressure } from './audio';
import { fineRotationSpeed } from './rotation';
import { haptic } from './feedback';
import { recordRound } from '../storage/history';
import { usesButtonControls } from './input-mode';
import { insideInputSurface, isFirePointerButton } from './input-controller';
import { shortcutAction, shortcutLabel } from './shortcuts';
import { heldRotationDegrees } from './rotation';
import { rebaseTweenClock } from './tween-clock';
import { settingsEffects, snapshotSettings } from '../ui/settings-effects';
import { advanceTimed, createRound, descentInterval, freezeTimed, resumeTimed, resetDescent, type GameMode } from '../core/modes';

type ScenePhase = 'READY' | 'FLYING' | 'RESOLVING' | 'PAUSED' | 'WON' | 'LOST';

interface ProgressDriver {
  progress: number;
}

interface V5RemovalItem {
  orb: Phaser.GameObjects.Container;
  motion: ClearOrb;
}

interface V5ParticleInstance {
  particle: ClearParticle;
  object: Phaser.GameObjects.Arc;
  trail?: Phaser.GameObjects.Graphics;
}

interface ActiveV5ClearAnimation {
  driver: ProgressDriver;
  orbs: V5RemovalItem[];
  particles: V5ParticleInstance[];
  duration: number;
  reduced: boolean;
  generation: number;
}

interface ActiveV5ScorePopup {
  score: Phaser.GameObjects.Text;
  caption: Phaser.GameObjects.Text;
  timer?: Phaser.Time.TimerEvent;
}

function cssColor(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export interface ScenePersistenceResult {
  ok: boolean;
  kind: 'save' | 'result' | 'clear';
  mode: GameMode;
  sessionId?: string;
}

function sendWindowEvent(name: string, detail: unknown): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail }));
}

function usesInlineNextPreview(): boolean {
  const windowsLayout = import.meta.env.MODE === 'windows' || (typeof document !== 'undefined' && document.documentElement.classList.contains('windows-v5'));
  return !usesButtonControls() && !windowsLayout;
}

export class PlayScene extends Phaser.Scene {
  private gameState: GameState = createGameState();
  private launcherColors: Pick<GameState, 'currentColor' | 'nextColor'> = { currentColor: this.gameState.currentColor, nextColor: this.gameState.nextColor };
  private persistenceResult?: ScenePersistenceResult;
  private terminalPersistedId?: string;
  public get lastPersistenceResult(): ScenePersistenceResult | undefined { return this.persistenceResult; }
  private get geometry() { return boardGeometry(this.gameState); }
  private phase: ScenePhase = 'READY';
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private audio = gameAudio;
  private angle = 0;
  private aimDirty = false;
  private lastAngleSent = NaN;
  private barrel?: Phaser.GameObjects.Graphics;
  private recoil = 0;
  private dangerLine?: Phaser.GameObjects.Graphics;
  private traceCache?: { board: GameState['board']; rowOffset: number; angle: number; trace: ReturnType<typeof traceShot> };
  private getShotTrace(): ReturnType<typeof traceShot> {
    const { board, rowOffset = 0 } = this.gameState;
    const cache = this.traceCache;
    if (cache && cache.board === board && cache.rowOffset === rowOffset && cache.angle === this.angle) return cache.trace;
    const trace = traceShot(board, this.angle, this.geometry);
    this.traceCache = { board, rowOffset, angle: this.angle, trace };
    return trace;
  }
  private pointerActive = false;
  private rotationDirection: -1 | 0 | 1 = 0;
  private rotationHeldSeconds = 0;
  private heldDirections = new Set<-1 | 1>();
  private fineSpeed = 0;
  private quickTurn: { from: number; to: number; elapsed: number } | null = null;
  private get canSteer(): boolean { return ['READY', 'FLYING', 'RESOLVING'].includes(this.phase); }
  private pausedFrom: ScenePhase = 'READY';
  private roundEpoch = 0;
  private comboCount = 0;
  private boardGroup!: Phaser.GameObjects.Container;
  private aimGraphics!: Phaser.GameObjects.Graphics;
  private boardBalls = new Map<string, Phaser.GameObjects.Container>();
  private launcherOrb?: Phaser.GameObjects.Container;
  private nextOrb?: Phaser.GameObjects.Container;
  private launcherBase!: Phaser.GameObjects.Graphics;
  private statusText!: Phaser.GameObjects.Text;
  public ready = false;
  public get isPaused(): boolean { return this.phase === 'PAUSED'; }
  public get isReady(): boolean { return this.phase === 'READY'; }
  public get performanceIdle(): boolean {
    return this.phase === 'READY' && !this.aimDirty && !this.recoil && !this.rotationDirection && !this.fineSpeed && !this.quickTurn && !this.transient.size;
  }
  private get reducedMotion(): boolean {
    return shouldReduceMotion(this.settings.reducedMotion);
  }
  private get reducedSystemMotion(): boolean { return systemPrefersReducedMotion(); }
  private controlHint(): string {
    if (usesButtonControls()) return this.settings.immersiveMode ? '按住棋盘瞄准 · 松手发射' : '上条定位 · 下条微调 · 侧边发射';
    return `鼠标左 / 右键或${shortcutLabel(this.settings.shortcuts.fire)}发射`;
  }
  public get isTimed(): boolean { return this.gameState.mode === 'timed'; }
  public get activeState(): GameState { return this.gameState; }
  public settleGame(): void {
    if (this.gameState.mode === 'campaign') return;
    this.syncTimedClock();
    if (this.gameState.status !== 'READY') return;
    this.gameState.status = 'WON';
    this.gameState.endReason = 'settled';
    this.finishImmediately();
  }
  private finishImmediately(): void {
    this.roundEpoch++;
    this.clearMotionGeneration++;
    this.activeV5ClearAnimations.clear();
    this.clearActiveV5ScorePopups();
    this.stopRotation();
    this.tweens.killAll();
    this.time.removeAllEvents();
    this.time.clearPendingEvents();
    this.transient.forEach(object => object.destroy());
    this.transient.clear();
    this.v5Particles.clear();
    this.v5ParticleInstances.clear();
    this.phase = this.gameState.status;
    this.renderBoard();
    this.renderLauncher();
    this.drawAim();
    this.emitState();
    this.persistGame();
    sendWindowEvent('snood-finished', this.gameState);
  }
  public syncTimedClock(): void {
    if (!this.ready || !this.isTimed || this.isPaused || this.gameState.status !== 'READY') return;
    const previous = this.gameState;
    const now = Date.now();
    this.gameState = advanceTimed(previous, now, this.phase === 'READY' || now >= previous.deadlineAt!);
    if (this.gameState.status !== 'READY') { this.finishImmediately(); return; }
    if (previous.board !== this.gameState.board) {
      this.phase = 'RESOLVING';
      this.animateResolution(previous, [{ type: 'board-drop' }]);
      this.persistGame();
    }
  }
  private reportPersistence(ok: boolean, kind: ScenePersistenceResult['kind']): boolean {
    this.persistenceResult = { ok, kind, mode: this.gameState.mode ?? 'endless', sessionId: this.gameState.sessionId };
    sendWindowEvent('snood-persistence-result', this.persistenceResult);
    return ok;
  }
  private clearStoredGame(): boolean {
    const ok = this.reportPersistence(clearGame(this.gameState.mode ?? 'endless'), 'clear');
    if (ok) sendWindowEvent('snood-clear-save', this.gameState.mode ?? 'endless');
    return ok;
  }
  public persistGame(): boolean {
    if (!this.ready) return false;
    if (this.abandoned) return true;
    if (this.gameState.status === 'READY') {
      const ok = this.reportPersistence(saveGame(this.gameState), 'save');
      if (ok) sendWindowEvent('snood-save-request', this.gameState);
      return ok;
    }
    if (this.gameState.sessionId && this.terminalPersistedId === this.gameState.sessionId) return true;
    const recorded = this.gameState.mode === 'campaign' ? recordCampaign(this.gameState) : recordRound(this.gameState);
    if (!recorded) return this.reportPersistence(false, 'result');
    if (!this.clearStoredGame()) return false;
    this.terminalPersistedId = this.gameState.sessionId;
    return true;
  }
  private clockTick = 0;
  private decisionClockAt: number | null = null;
  private abandoned = false;
  private transient = new Set<Phaser.GameObjects.GameObject>();
  private v5Particles = new Set<Phaser.GameObjects.Arc>();
  private v5ParticleInstances = new Set<V5ParticleInstance>();
  private activeV5ClearAnimations = new Set<ActiveV5ClearAnimation>();
  private activeV5ScorePopups = new Set<ActiveV5ScorePopup>();
  private clearMotionGeneration = 0;

  public override update(_time: number, delta: number): void {
    delta = Number.isFinite(delta) ? Math.max(0, delta) : 0;
    const steeringDelta = Math.min(250, delta);
    if (this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - delta / BOARD_APPEARANCE.recoilMs);
      this.positionBarrel();
    }
    if (this.isTimed) this.syncTimedClock();
    if (this.gameState.mode === 'campaign' && this.phase === 'READY') this.syncCampaignClock(delta);
    else this.decisionClockAt = null;
    if (this.canSteer && this.fineSpeed) this.rotateLauncher(this.fineSpeed < 0 ? -1 : 1, Math.abs(this.fineSpeed) * Math.min(100, steeringDelta) / 1000);
    if (this.canSteer && this.rotationDirection !== 0) {
      const before = this.rotationHeldSeconds;
      this.rotationHeldSeconds += steeringDelta / 1000;
      const degrees = heldRotationDegrees(this.rotationHeldSeconds) - heldRotationDegrees(before);
      this.rotateLauncher(this.rotationDirection, degrees);
    } else if (!this.canSteer) this.stopRotation();
    if (this.canSteer && this.quickTurn) {
      const turn = this.quickTurn;
      turn.elapsed += steeringDelta;
      const t = Math.min(1, turn.elapsed / 260);
      this.angle = turn.from + (turn.to - turn.from) * t * t * (3 - 2 * t);
      if (t === 1) this.quickTurn = null;
      this.aimDirty = true;
    }
    if (this.aimDirty) { this.aimDirty = false; this.drawAim(); }
    if (['READY', 'FLYING', 'RESOLVING'].includes(this.phase)) {
      if (!this.isTimed && this.gameState.mode !== 'campaign') this.gameState.elapsedMs = (this.gameState.elapsedMs ?? 0) + delta;
      this.clockTick += delta;
      if (this.clockTick >= (this.isTimed ? 100 : 1000)) { this.clockTick = 0; this.emitState(); }
    }
  }

  public constructor() {
    super({ key: 'PlayScene' });
  }

  private syncCampaignClock(fallbackDelta = 0): void {
    if (this.gameState.mode !== 'campaign' || this.phase !== 'READY' || this.gameState.status !== 'READY') return;
    const now = Date.now();
    const elapsed = this.decisionClockAt === null ? fallbackDelta : Math.max(0, now - this.decisionClockAt);
    this.decisionClockAt = now;
    this.gameState = advanceCampaign(this.gameState, elapsed);
    if (this.gameState.status !== 'READY') this.finishImmediately();
  }

  public create(): void {
    // Runtime quality changes backing pixels, never the logical board coordinates.
    const quality = (this.game as unknown as { orbboundQuality?: number }).orbboundQuality ?? 2;
    this.cameras.main.setZoom(quality).centerOn(GAME_WIDTH / 2, GAME_HEIGHT / 2);
    this.cameras.main.setBackgroundColor(boardBackground());
    this.createArena();
    this.boardGroup = this.add.container(0, 0);
    this.aimGraphics = this.add.graphics();
    this.launcherBase = this.add.graphics();
    this.barrel = this.add.graphics().setPosition(BOARD_GEOMETRY.launcherX, BOARD_GEOMETRY.launcherY);
    this.statusText = this.add.text(0, 0, '', {
      resolution: 2,
      color: '#98a1b8',
      fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
      fontSize: '13px',
      fontStyle: 'bold',
      letterSpacing: 1,
    }).setOrigin(0.5);
    this.statusText.setPosition(GAME_WIDTH / 2, 28);

    this.input.on('pointerdown', this.handlePointerDown, this);
    this.input.mouse?.disableContextMenu();
    this.input.on('pointermove', this.handlePointerMove, this);
    this.input.on('pointerup', this.handlePointerUp, this);
    this.input.on('pointerupoutside', () => { this.pointerActive = false; });
    this.input.on('pointerout', () => { this.pointerActive = false; });
    this.input.keyboard?.on('keydown', this.handleKeyDown, this);
    this.input.keyboard?.on('keyup', this.handleKeyUp, this);

    this.begin(createGameState('normal'));
    this.ready = true;
  }

  public begin(state: GameState): void {
    this.comboCount = 0;
    sendWindowEvent('snood-round-start', undefined);
    this.abandoned = false;
    this.terminalPersistedId = undefined; this.persistenceResult = undefined;
    this.roundEpoch++;
    this.clearMotionGeneration++;
    this.activeV5ClearAnimations.clear();
    this.clearActiveV5ScorePopups();
    state = resumeTimed(state);
    this.stopRotation();
    this.tweens.killAll();
    rebaseTweenClock(this.tweens);
    this.tweens.resumeAll();
    this.time.removeAllEvents();
    this.time.clearPendingEvents();
    this.time.paused = false;
    this.transient.forEach(object => object.destroy());
    this.transient.clear();
    this.v5Particles.clear();
    this.v5ParticleInstances.clear();
    this.pointerActive = false;
    this.pausedFrom = 'READY';
    state.sessionId ??= crypto.randomUUID();
    state.startedAt ??= Date.now();
    state.elapsedMs = Number.isFinite(state.elapsedMs) ? Math.max(0, state.elapsedMs!) : 0;
    this.clockTick = 0;
    this.gameState = state;
    this.launcherColors = { currentColor: state.currentColor, nextColor: state.nextColor };
    this.phase = state.status;
    if (state.status === 'READY') this.phase = 'READY';
    this.decisionClockAt = state.mode === 'campaign' && this.phase === 'READY' ? Date.now() : null;
    this.angle = 0;
    this.recoil = 0;
    this.statusText.setText(this.controlHint());
    this.renderBoard();
    this.renderLauncher();
    this.drawAim();
    this.emitState();
    this.persistGame();
    this.syncTimedClock();
  }

  public restartGame(): boolean {
    if (this.gameState.status === 'READY') {
      if (this.gameState.mode !== 'campaign' && this.gameState.step > 0 && !recordRound(this.gameState, true)) return this.reportPersistence(false, 'result');
      if (!this.clearStoredGame()) return false;
    } else if (!this.persistGame()) return false;
    const difficulty = this.gameState.difficultyId;
    this.begin(this.gameState.mode === 'campaign' ? createCampaign(this.gameState.levelId!) : createRound(difficulty, this.gameState.mode ?? 'endless', this.gameState.durationMs));
    return true;
  }

  public abandonGame(): boolean {
    this.pauseGame();
    if (this.gameState.status === 'READY') {
      if (this.gameState.mode !== 'campaign' && this.gameState.step > 0 && !recordRound(this.gameState, true)) return this.reportPersistence(false, 'result');
      if (!this.clearStoredGame()) return false;
    } else if (!this.persistGame()) return false;
    this.abandoned = true;
    this.roundEpoch++; this.clearMotionGeneration++;
    this.clearActiveV5ScorePopups();
    (this.tweens as Phaser.Tweens.TweenManager | undefined)?.killAll?.();
    (this.time as Phaser.Time.Clock | undefined)?.removeAllEvents?.(); (this.time as Phaser.Time.Clock | undefined)?.clearPendingEvents?.();
    this.transient.forEach(object => object.destroy()); this.transient.clear();
    this.v5Particles.clear(); this.v5ParticleInstances.clear(); this.activeV5ClearAnimations.clear();
    return true;
  }

  public setSettings(settings: Settings): void {
    const wasUserReduced = this.settings.reducedMotion;
    const wasReduced = this.reducedMotion;
    const changed = settingsEffects(this.settings, settings);
    this.settings = snapshotSettings(settings);
    if (!this.ready) return;
    const userEnabledReduced = !wasUserReduced && this.settings.reducedMotion;
    if (userEnabledReduced || wasReduced !== this.reducedMotion) {
      if (this.reducedMotion) this.reduceActiveV5ClearLayers();
      else this.clearActiveV5ClearLayers();
      this.clearActiveV5ScorePopups();
    }
    if (changed.controls || changed.quality) { this.pointerActive = false; this.stopRotation(); }
    if (this.phase === 'READY') this.statusText?.setText(this.controlHint());
    this.audio.setMix(settings.volume, settings.musicVolume);
    if (changed.visual) { this.renderLauncher(this.launcherColors); this.drawAim(); }
    sendWindowEvent('snood-settings-applied', this.settings);
    if (changed.quality || changed.frameRate) sendWindowEvent('snood-performance-settings', this.settings);
  }

  public pauseGame(): void {
    if (!this.ready) return;
    this.stopRotation();
    this.syncTimedClock();
    this.syncCampaignClock();
    if (this.phase === 'PAUSED' || this.phase === 'WON' || this.phase === 'LOST') return;
    this.gameState = freezeTimed(this.gameState);
    this.pausedFrom = this.phase;
    this.phase = 'PAUSED';
    this.decisionClockAt = null;
    sendWindowEvent('snood-performance-reset', undefined);
    this.tweens.pauseAll();
    this.time.paused = true;
    this.pointerActive = false;
    this.drawAim();
    const saved = this.persistGame();
    this.statusText.setText(saved ? '已存档 · 可退出，下次继续' : '未能存档 · 请重试，当前对局仍保留');
    this.emitState();
  }

  public resumeGame(): void {
    if (!this.ready || this.phase !== 'PAUSED') return;
    this.gameState = resumeTimed(this.gameState);
    this.phase = this.pausedFrom;
    this.decisionClockAt = this.gameState.mode === 'campaign' && this.phase === 'READY' ? Date.now() : null;
    sendWindowEvent('snood-performance-reset', undefined);
    this.statusText.setText(this.phase === 'READY' ? this.controlHint() : '等待本次发射结算');
    rebaseTweenClock(this.tweens);
    this.tweens.resumeAll();
    this.time.paused = false;
    this.drawAim();
    this.emitState();
    sendWindowEvent('snood-performance-active', undefined);
  }

  public togglePause(): void {
    if (this.phase === 'PAUSED') this.resumeGame();
    else this.pauseGame();
  }

  public launchFromButton(): void {
    if (this.phase !== 'READY') return;
    this.quickTurn = null;
    this.launch();
  }

  public setAimDegrees(degrees: number): void {
    if (!this.canSteer || !Number.isFinite(degrees)) return;
    this.stopRotation();
    const angle = Math.max(-78, Math.min(78, degrees)) * Math.PI / 180;
    if (this.angle !== angle) { this.angle = angle; this.aimDirty = true; sendWindowEvent('snood-performance-active', undefined); }
  }
  public setFineRotation(value: number): void {
    this.stopRotation();
    if (this.canSteer) this.fineSpeed = fineRotationSpeed(value, this.settings.sensitivity);
  }
  public startRotation(direction: -1 | 1): void {
    if (!this.canSteer) return;
    this.stopRotation();
    this.rotationDirection = direction;
    this.rotationHeldSeconds = 0;
    this.rotateLauncher(direction);
    sendWindowEvent('snood-performance-active', undefined);
  }

  public stopRotation(): void {
    this.quickTurn = null;
    this.fineSpeed = 0;
    this.rotationDirection = 0;
    this.rotationHeldSeconds = 0;
    this.heldDirections.clear();
  }

  public rotateLauncher(direction: -1 | 1, degrees = 1): void {
    if (!this.canSteer) return;
    const limit = 78 * Math.PI / 180;
    const angle = Math.max(-limit, Math.min(limit, this.angle + direction * degrees * Math.PI / 180));
    if (angle === this.angle) return;
    this.angle = angle;
    this.aimDirty = true;
  }

  public quickRotate(direction: -1 | 1): void {
    if (!this.canSteer) return;
    const target = (this.quickTurn?.to ?? this.angle) + direction * 30 * Math.PI / 180;
    this.stopRotation();
    const limit = 78 * Math.PI / 180;
    this.quickTurn = { from: this.angle, to: Math.max(-limit, Math.min(limit, target)), elapsed: 0 };
  }

  private createArena(): void {
    drawArena(this.add.graphics());
    const floorLabel = this.add.text(GAME_WIDTH / 2, 623, BOARD_APPEARANCE.floorLabel, {
      resolution: 2, color: '#64718d', fontFamily: BOARD_APPEARANCE.font,
      fontSize: '11px', fontStyle: 'bold', letterSpacing: 1,
    }).setOrigin(0.5);
    floorLabel.setAlpha(0.85);
    this.dangerLine = this.add.graphics();
    // The browser preview keeps its existing next-ball hint. Windows uses the DOM next-ball card.
    if (usesInlineNextPreview()) this.add.text(405, 661, '下一球', {
      resolution: 2, color: '#98a1b8', fontFamily: BOARD_APPEARANCE.font, fontSize: '14px',
    }).setOrigin(0.5);
  }

  private renderBoard(offsetY = 0): void {
    const pressure = boardMusicPressure(this.gameState.board);
    if (this.dangerLine) { this.dangerLine.clear(); drawDangerLine(this.dangerLine, pressure, this.geometry); }
    this.boardGroup.setY(offsetY);
    const retained = new Set<string>();

    for (let row = 0; row < this.gameState.board.length; row += 1) {
      for (let col = 0; col < this.gameState.board[row].length; col += 1) {
        const color = this.gameState.board[row][col];
        if (color === null) continue;
        const cell = { row, col };
        const key = cellKey(cell);
        const point = cellToPoint(cell, this.geometry);
        let orb = this.boardBalls.get(key);
        const target = this.gameState.targets?.some(cell => cell.row === row && cell.col === col) ?? false;
        if (orb && (orb.getData('colorId') !== color || !!orb.getData('target') !== target)) { orb.destroy(); orb = undefined; }
        if (!orb) {
          orb = this.createOrb(color, point);
          orb.setData('colorId', color);
          orb.setData('target', target);
          if (target) orb.add(this.add.graphics().lineStyle(2, 0xffffff, 1).strokeCircle(0, 0, 20));
          orb.setData('cellKey', key);
          this.boardGroup.add(orb);
          this.boardBalls.set(key, orb);
        }
        orb.setPosition(point.x, point.y).setScale(1).setAlpha(1).setVisible(true);
        retained.add(key);
      }
    }
    for (const [key, orb] of this.boardBalls) {
      if (!retained.has(key)) { orb.destroy(); this.boardBalls.delete(key); }
    }
  }

  private renderLauncher(colors: Pick<GameState, 'currentColor' | 'nextColor'> = this.gameState): void {
    this.launcherColors = { currentColor: colors.currentColor, nextColor: colors.nextColor };
    this.launcherOrb?.destroy(); this.nextOrb?.destroy(); this.nextOrb = undefined;
    this.launcherBase.clear();
    if (usesInlineNextPreview()) {
      this.nextOrb = this.createOrb(colors.nextColor, { x: 405, y: 698 }); this.nextOrb.setScale(.72);
    }
    if (this.barrel) { this.barrel.clear(); drawLauncherBarrel(this.barrel, colors.currentColor); this.barrel.setRotation(this.angle); }
    drawLauncherBase(this.launcherBase);
    this.launcherOrb = this.createOrb(colors.currentColor, { x: BOARD_GEOMETRY.launcherX, y: BOARD_GEOMETRY.launcherY });
    this.launcherOrb.setScale(BOARD_APPEARANCE.loadedScale); this.launcherOrb.setRotation?.(0);
  }

  private createOrb(colorId: number, point: Point): Phaser.GameObjects.Container {
    const key = `orb-shared-${getOrbThemeVariant()}-${colorId}`;
    if (!this.textures.exists(key)) {
      const texture = this.textures.createCanvas(key, BOARD_APPEARANCE.orbTextureSize, BOARD_APPEARANCE.orbTextureSize)!;
      texture.context.scale(4, 4); paintOrbArtwork(texture.context, colorId); texture.refresh();
    }
    return this.add.container(point.x, point.y, [this.add.image(0, 0, key).setDisplaySize(BOARD_APPEARANCE.orbSize, BOARD_APPEARANCE.orbSize)]);
  }

  private positionBarrel(): void {
    if (!this.barrel) return;
    this.barrel.setRotation(this.angle);
    this.barrel.setPosition?.(BOARD_GEOMETRY.launcherX - Math.sin(this.angle) * this.recoil * BOARD_APPEARANCE.recoilDistance,
      BOARD_GEOMETRY.launcherY + Math.cos(this.angle) * this.recoil * BOARD_APPEARANCE.recoilDistance);
  }
  private drawAim(): void {
    this.aimDirty = false;
    this.positionBarrel();
    // Keep the ball symbol upright for quick color / pattern recognition.
    if (this.lastAngleSent !== this.angle) {
      this.lastAngleSent = this.angle;
      sendWindowEvent('snood-angle', this.angle * 180 / Math.PI);
    }
    this.aimGraphics.clear();
    // Keep the cursor hidden for the entire shot, including flight and resolution.
    const playing = this.phase === 'READY' || this.phase === 'FLYING' || this.phase === 'RESOLVING';
    this.input.setDefaultCursor(!this.settings.aimAssist && playing ? 'none' : 'auto');
    if (!playing) return;
    // During board animation show direction only; trace the settled board when ready.
    if (!this.settings.aimAssist || this.phase !== 'READY') {
      if (this.barrel) return; // The rotating barrel itself shows direction.
      const x = BOARD_GEOMETRY.launcherX, y = BOARD_GEOMETRY.launcherY - BOARD_GEOMETRY.radius - 3;
      this.aimGraphics.lineStyle(4, getOrbTheme(this.gameState.currentColor).color, 1);
      this.aimGraphics.lineBetween(x, y, x + Math.sin(this.angle) * 84, y - Math.cos(this.angle) * 84);
      return;
    }

    const trace = this.getShotTrace();
    drawAimMarkers(this.aimGraphics, trace, this.geometry, this.gameState.currentColor,
      trace.landing ? cellToPoint(trace.landing, this.geometry) : undefined);
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (usesButtonControls()) return;
    if (!isFirePointerButton(pointer.button)) return;
    if (!this.canSteer) return;
    this.pointerActive = this.phase === 'READY';
    this.updateAim(pointer);
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer): void {
    if (usesButtonControls()) return;
    if (!this.canSteer) return;
    if (pointer.isDown || this.pointerActive || pointer.worldY < BOARD_GEOMETRY.launcherY) this.updateAim(pointer);
  }

  private handlePointerUp(pointer: Phaser.Input.Pointer): void {
    if (usesButtonControls()) { this.pointerActive = false; return; }
    if (!this.pointerActive) return;
    this.pointerActive = false;
    if (!insideInputSurface(pointer.worldX, pointer.worldY, { left: 0, top: 0, right: GAME_WIDTH, bottom: GAME_HEIGHT })) return;
    if (!this.settings.independentLaunch) this.launch();
  }

  private updateAim(pointer: Phaser.Input.Pointer): void {
    this.stopRotation();
    const dx = pointer.worldX - BOARD_GEOMETRY.launcherX;
    const dy = pointer.worldY - BOARD_GEOMETRY.launcherY;
    const nextAngle = Math.atan2(dx, -dy);
    const limit = Phaser.Math.DegToRad(78);
    this.angle = Phaser.Math.Clamp(Number.isFinite(nextAngle) ? nextAngle : 0, -limit, limit);
    this.aimDirty = true;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (document.querySelector<HTMLElement>('#game-screen')?.hidden || !document.querySelector<HTMLElement>('#modal-root')?.hidden) return;
    if (usesButtonControls()) return;
    const action = shortcutAction(event, this.settings.shortcuts);
    if (!action || !['fire','left','right','quickLeft','quickRight'].includes(action)) return;
    event.preventDefault();
    if (event.repeat) return;
    if (this.phase === 'PAUSED' && action === 'fire') {
      event.preventDefault();
      this.resumeGame();
      return;
    }
    if (!this.canSteer) return;
    if (action === 'left' || action === 'right') {
      event.preventDefault();
      const direction = action === 'left' ? -1 : 1;
      this.heldDirections.delete(direction); this.heldDirections.add(direction);
      this.quickTurn = null; this.fineSpeed = 0; this.rotationDirection = direction; this.rotationHeldSeconds = 0;
      this.rotateLauncher(direction);
      sendWindowEvent('snood-performance-active', undefined);
    } else if (action === 'quickLeft' || action === 'quickRight') {
      event.preventDefault();
      this.quickRotate(action === 'quickLeft' ? -1 : 1);
    } else if (action === 'fire') {
      event.preventDefault();
      this.launchFromButton();
    }
  }

  private handleKeyUp(event: KeyboardEvent): void {
    const direction = event.code === this.settings.shortcuts.left ? -1 : event.code === this.settings.shortcuts.right ? 1 : 0;
    if (!direction) return;
    this.heldDirections.delete(direction);
    if (direction !== this.rotationDirection) return;
    this.rotationDirection = [...this.heldDirections].at(-1) ?? 0;
    this.rotationHeldSeconds = 0;
  }

  private launch(): void {
    this.syncTimedClock();
    this.syncCampaignClock();
    if (this.phase !== 'READY') return;
    const epoch = this.roundEpoch;
    const trace = this.getShotTrace();
    if (!trace.landing) {
      this.showHint('这个角度没有合法落点', UI_COLORS.danger);
      return;
    }

    this.phase = 'FLYING';
    this.decisionClockAt = null;
    sendWindowEvent('snood-performance-active', undefined);
    this.drawAim();
    this.pointerActive = false;
    this.audio.blip('shoot');
    haptic('shoot', this.settings);
    this.recoil = this.reducedSystemMotion ? 0 : 1; this.positionBarrel();
    sendWindowEvent('snood-fired', undefined);
    this.statusText.setText(trace.bounced ? '反弹中 · 等待落点' : '飞行中 · 等待落点');
    this.emitState();

    const projectile = this.createOrb(this.gameState.currentColor, trace.points[0]);
    this.transient.add(projectile);
    projectile.setScale(0.93);
    const driver: ProgressDriver = { progress: 0 };
    const duration = Math.min(920, Math.max(220, trace.points.length * 2.8));
    // Commit once on launch: process termination cannot replay a shot or lose its score.
    const previous = this.gameState;
    const result = resolveShot(previous, trace.landing);
    const cleared = result.events.filter(event => event.type === 'match' || event.type === 'drop')
      .reduce((count, event) => count + (event.cells?.length ?? 0), 0);
    this.comboCount = cleared ? this.comboCount + 1 : 0;
    const comboCount = this.comboCount;
    this.gameState = result.state;
    if (result.events.some(event => event.type === 'board-drop')) resetDescent(this.gameState, Date.now());
    this.persistGame();
    this.tweens.add({
      targets: driver,
      progress: 1,
      duration,
      ease: 'Linear',
      onUpdate: () => {
        if (epoch !== this.roundEpoch) return;
        const position = driver.progress * (trace.points.length - 1);
        const index = Math.min(trace.points.length - 1, Math.floor(position));
        const point = trace.points[index];
        const next = trace.points[Math.min(index + 1, trace.points.length - 1)];
        const fraction = position - index;
        projectile.setPosition(point.x + (next.x - point.x) * fraction, point.y + (next.y - point.y) * fraction);
      },
      onComplete: () => {
        if (epoch !== this.roundEpoch) return;
        projectile.destroy();
        this.transient.delete(projectile);
        this.phase = 'RESOLVING';
        if (comboCount >= 2) sendWindowEvent('snood-combo', { count: comboCount, cleared });
        this.flashLanding(trace.landing!, getOrbTheme(previous.currentColor).color);
        this.animateResolution(previous, result.events);
      },
    });
  }

  private animateResolution(_previous: GameState, events: GameEvent[]): void {
    const epoch = this.roundEpoch;
    const matched = events.find((event) => event.type === 'match')?.cells ?? [];
    const dropped = events.find((event) => event.type === 'drop')?.cells ?? [];
    const removed = [...matched, ...dropped];
    const removeDuration = dropped.length ? BOARD_APPEARANCE.removal.fallMs : BOARD_APPEARANCE.removal.matchMs;
    const removeDelay = BOARD_APPEARANCE.removal.delay;
    const v5 = isV5BoardAppearance();
    const v5Orbs: V5RemovalItem[] = [];
    const animationGroups = new Map<number, Phaser.GameObjects.Container[]>();
    for (const [index, cell] of removed.entries()) {
      const sourceOrb = this.boardBalls.get(cellKey(cell));
      const falling = dropped.includes(cell);
      const delay = falling ? 90 + Math.min(index, 6) * removeDelay : 0;
      if (v5) {
        const colorId = _previous.board[cell.row]?.[cell.col] ?? (sourceOrb?.getData('colorId') as number | undefined) ?? _previous.currentColor;
        const target = _previous.targets?.some(targetCell => targetCell.row === cell.row && targetCell.col === cell.col) ?? false;
        const point = sourceOrb
          ? { x: sourceOrb.x + this.boardGroup.x, y: sourceOrb.y + this.boardGroup.y }
          : cellToPoint(cell, boardGeometry(_previous));
        const motion = { color: getOrbTheme(colorId).color, x: point.x, y: point.y, index, falling };
        // A scene-level copy gives both full and reduced effects a visible fade.
        // The committed board orb stays hidden until renderBoard reconciles it.
        const orb = this.createOrb(colorId, point);
        if (target) orb.add(this.add.graphics().lineStyle(2, 0xffffff, 1).strokeCircle(0, 0, 20));
        this.transient.add(orb);
        sourceOrb?.setVisible(false);
        v5Orbs.push({ orb, motion });
        if (sourceOrb) {
          const group = animationGroups.get(delay) ?? [];
          group.push(sourceOrb);
          animationGroups.set(delay, group);
        }
        continue;
      }
      if (!sourceOrb) continue;
      if (this.reducedMotion) sourceOrb.setAlpha(1);
      else if (falling) {
        this.tweens.add({ targets: sourceOrb, y: sourceOrb.y + BOARD_APPEARANCE.removal.fallDistance, angle: BOARD_APPEARANCE.removal.fallAngle,
          duration: removeDuration, delay, ease: 'Quad.In' });
      }
      const group = animationGroups.get(delay) ?? [];
      group.push(sourceOrb);
      animationGroups.set(delay, group);
    }
    const reducedAtStart = this.reducedMotion;
    const v5Duration = reducedAtStart ? V5_CLEAR_MOTION.reducedMs : V5_CLEAR_MOTION.fullMs;
    if (v5 && v5Orbs.length) this.animateV5Removal(v5Orbs, v5Duration, reducedAtStart, epoch,
      clearMotionSeed('scene', this.roundEpoch, _previous.step, 'clear'));
    if (!v5) {
      for (const [delay, targets] of animationGroups) {
        if (this.reducedMotion) {
          this.tweens.add({ targets, alpha: 0, scale: 1, duration: V5_CLEAR_MOTION.reducedMs, delay: 0, ease: 'Linear' });
          continue;
        }
        this.tweens.add({
          targets,
          scale: delay > 0 ? BOARD_APPEARANCE.removal.fallScale : BOARD_APPEARANCE.removal.matchScale,
          alpha: 0,
          duration: removeDuration,
          delay,
          ease: delay > 0 ? 'Quad.In' : 'Back.In',
        });
      }
    }

    const points = events.reduce((total, event) => total + (event.points ?? 0), 0);
    if (points > 0) {
      this.showScorePopup(points, dropped.length > 0 ? `消除 ${matched.length} · 悬空 ${dropped.length} 额外 +${events.find(event => event.type === 'drop')?.points ?? 0}` : `同色消除 ${matched.length}`);
      this.audio.blip(dropped.length > 0 ? 'drop' : 'match');
      haptic('match', this.settings);
    }
    if (events.some((event) => event.type === 'board-drop')) this.audio.blip('danger');

    // The firing lock follows the pre-V5 board-removal cadence. V5 clones keep
    // playing as root-level cosmetics after the board is ready to accept input.
    const wait = animationGroups.size ? removeDuration + Math.max(...animationGroups.keys()) + 20 : 60;
    this.time.delayedCall(wait, () => {
      if (epoch !== this.roundEpoch) return;
      const droppedBoard = events.some((event) => event.type === 'board-drop');
      this.renderBoard(droppedBoard ? -BOARD_GEOMETRY.rowStep : 0);
      this.renderLauncher();
      this.emitState();
      const finish = () => {
      if (epoch !== this.roundEpoch) return;

      const win = events.some((event) => event.type === 'win');
      const lost = events.some((event) => event.type === 'lost');
      if (win) {
        this.phase = 'WON';
        this.audio.blip('win');
        this.statusText.setText(this.gameState.mode === 'campaign' ? '目标完成 · 关卡通过' : '棋盘清空 · 这局属于你');
      } else if (lost) {
        this.phase = 'LOST';
        this.audio.blip('lose');
        this.statusText.setText(this.gameState.endReason === 'shots' ? '发数用尽 · 再试一次' : '触底 · 再试一次');
      } else {
        this.phase = 'READY';
        this.decisionClockAt = this.gameState.mode === 'campaign' ? Date.now() : null;
        this.statusText.setText(this.controlHint());
      }
      this.drawAim();
      this.emitState();
      if (this.phase === 'READY') this.persistGame();
      if (this.phase === 'WON' || this.phase === 'LOST') {
        this.persistGame();
        sendWindowEvent('snood-finished', this.gameState);
      }
      };
      if (droppedBoard) this.tweens.add({ targets: this.boardGroup, y: 0, duration: 360, ease: 'Cubic.Out', onComplete: finish });
      else { this.boardGroup.setY(0); finish(); }
    });
  }

  private createV5Particles(particles: readonly ClearParticle[]): V5ParticleInstance[] {
    const platform = clearMotionPlatform();
    const particleLimit = clearParticleCap(platform);
    const capacity = Math.max(0, particleLimit - this.v5Particles.size);
    return particles.slice(0, capacity).map(particle => {
      const object = this.add.circle(particle.x, particle.y, particle.radius, particle.color, particle.alpha);
      this.transient.add(object);
      this.v5Particles.add(object);
      const trail = particle.tail ? this.add.graphics() : undefined;
      if (trail) this.transient.add(trail);
      const instance = { particle, object, trail };
      this.v5ParticleInstances.add(instance);
      return instance;
    });
  }

  private applyV5Particles(particles: readonly V5ParticleInstance[], elapsedMs: number): void {
    for (const { particle, object, trail } of particles) {
      const pose = clearParticlePose(particle, elapsedMs);
      object.setPosition(pose.x, pose.y).setScale(1).setAlpha(pose.alpha);
      if (trail) {
        const speed = Math.hypot(particle.vx, particle.vy), length = Math.min(11, 3 + speed * .055);
        const tailX = pose.x - particle.vx / speed * length, tailY = pose.y - particle.vy / speed * length;
        trail.clear().lineStyle(Math.max(.7, particle.radius * .55), particle.color, pose.alpha * .42).lineBetween(tailX, tailY, pose.x, pose.y);
      }
    }
  }

  private disposeV5Particles(particles: readonly V5ParticleInstance[]): void {
    for (const instance of particles) {
      const { object, trail } = instance;
      this.v5Particles.delete(object);
      if (this.transient.delete(object)) object.destroy();
      this.v5ParticleInstances.delete(instance);
      if (trail && this.transient.delete(trail)) trail.destroy();
    }
  }

  private animateV5Particles(particles: readonly V5ParticleInstance[], epoch: number): void {
    if (!particles.length) return;
    const driver = { progress: 0 }, generation = this.clearMotionGeneration;
    this.tweens.add({
      targets: driver,
      progress: 1,
      duration: V5_CLEAR_MOTION.particleMs,
      ease: 'Linear',
      onUpdate: () => {
        if (epoch !== this.roundEpoch || generation !== this.clearMotionGeneration) return;
        this.applyV5Particles(particles, driver.progress * V5_CLEAR_MOTION.particleMs);
      },
      onComplete: () => this.disposeV5Particles(particles),
    });
  }

  private disposeV5Orbs(orbs: readonly V5RemovalItem[]): void {
    for (const { orb } of orbs) {
      if (this.transient.delete(orb)) orb.destroy();
    }
  }

  private animateV5Removal(orbs: V5RemovalItem[], duration: number, reduced: boolean, epoch: number, seed: number): void {
    const particles = reduced ? [] : this.createV5Particles(createClearParticles(orbs.map(({ motion }) => motion), {
      platform: clearMotionPlatform(), seed,
      budget: Math.max(0, clearParticleCap(clearMotionPlatform()) - this.v5Particles.size),
    }));
    const driver = { progress: 0 };
    const animation: ActiveV5ClearAnimation = { driver, orbs, particles, duration, reduced, generation: this.clearMotionGeneration };
    this.activeV5ClearAnimations.add(animation);
    this.tweens.add({
      targets: driver,
      progress: 1,
      duration,
      ease: 'Linear',
      onUpdate: () => {
        if (epoch !== this.roundEpoch || animation.generation !== this.clearMotionGeneration) return;
        const elapsedMs = driver.progress * duration;
        const reduced = animation.reduced;
        if (reduced && elapsedMs >= V5_CLEAR_MOTION.reducedMs) {
          this.disposeV5Orbs(orbs); this.disposeV5Particles(particles); return;
        }
        for (const { orb, motion } of orbs) {
          const pose = clearOrbPose(motion, elapsedMs, reduced);
          orb.setPosition(pose.x, pose.y).setScale(pose.scale).setRotation(pose.rotation).setAlpha(pose.alpha);
        }
        if (reduced && particles.length) this.disposeV5Particles(particles);
        else this.applyV5Particles(particles, elapsedMs);
      },
      onComplete: () => {
        this.activeV5ClearAnimations.delete(animation);
        this.disposeV5Orbs(orbs);
        this.disposeV5Particles(particles);
      },
    });
  }

  private clearActiveV5ClearLayers(): void {
    if (!this.activeV5ClearAnimations.size && !this.v5ParticleInstances.size) return;
    this.clearMotionGeneration++;
    for (const animation of this.activeV5ClearAnimations) {
      (this.tweens as Phaser.Tweens.TweenManager & { killTweensOf?: (target: object) => unknown }).killTweensOf?.(animation.driver);
      this.disposeV5Orbs(animation.orbs);
      this.disposeV5Particles(animation.particles);
    }
    this.activeV5ClearAnimations.clear();
    this.disposeV5Particles([...this.v5ParticleInstances]);
    this.renderBoard();
  }

  private reduceActiveV5ClearLayers(): void {
    for (const animation of this.activeV5ClearAnimations) {
      const elapsedMs = animation.driver.progress * animation.duration;
      animation.reduced = true;
      this.disposeV5Particles(animation.particles);
      animation.particles.length = 0;
      for (const { orb, motion } of animation.orbs) {
        const pose = clearOrbPose(motion, elapsedMs, true);
        orb.setPosition(pose.x, pose.y).setScale(1).setRotation(0).setAlpha(pose.alpha);
      }
      if (elapsedMs >= V5_CLEAR_MOTION.reducedMs) this.disposeV5Orbs(animation.orbs);
    }
    this.disposeV5Particles([...this.v5ParticleInstances]);
  }

  private clearActiveV5ScorePopups(): void {
    if (!this.activeV5ScorePopups.size) return;
    const clock = this.time as Phaser.Time.Clock & { removeEvent?: (event: Phaser.Time.TimerEvent) => unknown };
    const tweens = this.tweens as Phaser.Tweens.TweenManager & { killTweensOf?: (target: object) => unknown };
    for (const popup of this.activeV5ScorePopups) {
      if (popup.timer) clock.removeEvent?.(popup.timer);
      tweens.killTweensOf?.(popup.score);
      tweens.killTweensOf?.(popup.caption);
      if (this.transient.delete(popup.score)) popup.score.destroy();
      if (this.transient.delete(popup.caption)) popup.caption.destroy();
    }
    this.activeV5ScorePopups.clear();
  }

  private flashLanding(cell: Cell, color: number): void {
    if (this.reducedMotion) return;
    const point = cellToPoint(cell, this.geometry);
    if (isV5BoardAppearance()) {
      const epoch = this.roundEpoch;
      const particles = this.createV5Particles(createClearParticles([{ color, x: point.x, y: point.y, index: this.gameState.step, falling: false }], {
        platform: clearMotionPlatform(), seed: clearMotionSeed('scene', this.roundEpoch, this.gameState.step, 'landing'),
        budget: Math.max(0, clearParticleCap(clearMotionPlatform()) - this.v5Particles.size),
      }));
      this.animateV5Particles(particles, epoch);
      return;
    }
    const flash = this.add.circle(point.x, point.y, BOARD_GEOMETRY.radius + 5, color, 0.22);
    this.transient.add(flash);
    this.tweens.add({
      targets: flash,
      scale: 1.75,
      alpha: 0,
      duration: BOARD_APPEARANCE.landingFlashMs,
      ease: 'Cubic.Out',
      onComplete: () => { flash.destroy(); this.transient.delete(flash); },
    });
  }

  private showScorePopup(points: number, label: string): void {
    if (isV5BoardAppearance()) {
      this.showV5ScorePopup(points, label);
      return;
    }
    const text = this.add.text(BOARD_GEOMETRY.launcherX, BOARD_APPEARANCE.score.y, `+${points}  ${label}`, {
      resolution: 2,
      color: '#f5f2eb',
      fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
      fontSize: `${BOARD_APPEARANCE.score.fontSize}px`,
      fontStyle: 'bold',
      stroke: '#111a2d',
      strokeThickness: BOARD_APPEARANCE.score.stroke,
    }).setOrigin(0.5);
    this.transient.add(text);
    this.tweens.add({
      targets: text,
      y: this.reducedMotion ? BOARD_APPEARANCE.score.y : BOARD_APPEARANCE.score.endY,
      alpha: 0,
      duration: BOARD_APPEARANCE.score.duration,
      ease: 'Cubic.Out',
      onComplete: () => { text.destroy(); this.transient.delete(text); },
    });
  }

  private showV5ScorePopup(points: number, label: string): void {
    const epoch = this.roundEpoch;
    const score = this.add.text(BOARD_GEOMETRY.launcherX, 560, `+${points}`, {
      resolution: 2,
      color: cssColor(BOARD_APPEARANCE_V5.warning),
      fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
      fontSize: '28px',
      fontStyle: 'bold',
      stroke: boardBackground(),
      strokeThickness: 3,
    }).setOrigin(.5);
    const caption = this.add.text(BOARD_GEOMETRY.launcherX, 584, label, {
      resolution: 2,
      color: '#a7b1c0',
      fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
      fontSize: '14px',
      stroke: boardBackground(),
      strokeThickness: 1,
    }).setOrigin(.5);
    this.transient.add(score);
    this.transient.add(caption);
    const popup: ActiveV5ScorePopup = { score, caption };
    this.activeV5ScorePopups.add(popup);
    const dispose = () => {
      if (!this.activeV5ScorePopups.delete(popup)) return;
      if (popup.timer) (this.time as Phaser.Time.Clock & { removeEvent?: (event: Phaser.Time.TimerEvent) => unknown }).removeEvent?.(popup.timer);
      if (this.transient.delete(score)) score.destroy();
      if (this.transient.delete(caption)) caption.destroy();
    };
    if (this.reducedMotion) {
      popup.timer = this.time.delayedCall(V5_CLEAR_MOTION.scoreMs, dispose);
      return;
    }
    score.setScale(.88);
    caption.setScale(.94);
    this.tweens.add({
      targets: score,
      scale: 1.05,
      duration: 90,
      ease: 'Back.Out',
      onComplete: () => {
        if (epoch !== this.roundEpoch || !this.activeV5ScorePopups.has(popup)) { dispose(); return; }
        this.tweens.add({
          targets: score,
          y: 500,
          scale: 1,
          alpha: 0,
          duration: V5_CLEAR_MOTION.scoreMs - 90,
          ease: 'Cubic.Out',
          onComplete: dispose,
        });
        this.tweens.add({
          targets: caption,
          y: 524,
          scale: 1,
          alpha: 0,
          delay: 40,
          duration: V5_CLEAR_MOTION.scoreMs - 130,
          ease: 'Cubic.Out',
          onComplete: dispose,
        });
      },
    });
  }

  private showHint(message: string, color: number): void {
    this.statusText.setColor(`#${color.toString(16).padStart(6, '0')}`);
    this.statusText.setText(message);
    this.time.delayedCall(1000, () => {
      if (this.phase === 'READY') {
        this.statusText.setColor('#98a1b8');
        this.statusText.setText(this.controlHint());
      }
    });
  }

  private emitState(): void {
    sendWindowEvent('snood-state', {
      musicPressure: boardMusicPressure(this.gameState.board),
      phase: this.phase,
      status: this.gameState.status,
      score: this.gameState.score,
      danger: this.gameState.danger,
      currentColor: this.gameState.currentColor,
      nextColor: this.gameState.nextColor,
      previewNextColor: this.launcherColors.nextColor,
      difficultyId: this.gameState.difficultyId,
      step: this.gameState.step,
      elapsedMs: this.gameState.elapsedMs ?? 0,
      mode: this.gameState.mode ?? 'endless',
      levelId: this.gameState.levelId,
      targetsRemaining: this.gameState.targets?.length,
      endReason: this.gameState.endReason,
      durationMs: this.gameState.durationMs,
      descentRemainingMs: Math.max(0, (this.gameState.nextDescentAt ?? 0) - (this.gameState.timedSavedAt ?? Date.now())),
      descentIntervalMs: this.gameState.descentIntervalMs ?? descentInterval(this.gameState.difficultyId, this.gameState.elapsedMs ?? 0, this.gameState.durationMs ?? 300000),
    });
  }
}

export const PHASER_CONFIG: Phaser.Types.Core.GameConfig = {
  audio: { noAudio: true },
  type: Phaser.AUTO,
  // Application budget preserves the remainder on 144/165/240Hz RAF; Phaser's limiter discards it.
  fps: { target: 120, limit: 0, smoothStep: false },
  width: GAME_WIDTH * 2,
  height: GAME_HEIGHT * 2,
  parent: 'game-container',
  backgroundColor: '#18223a',
  render: {
    antialias: true,
    pixelArt: false,
    roundPixels: false,
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: GAME_WIDTH * 2,
    height: GAME_HEIGHT * 2,
  },
  input: {
    activePointers: 3,
  },
  scene: [PlayScene],
};
