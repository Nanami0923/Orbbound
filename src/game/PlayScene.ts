import Phaser from 'phaser';
import { cellKey, cellToPoint } from '../core/grid';
import { createGameState, resolveShot } from '../core/engine';
import { traceShot } from '../core/physics';
import type { Cell, GameEvent, GameState, Point } from '../core/types';
import { BOARD_GEOMETRY, GAME_HEIGHT, GAME_WIDTH, UI_COLORS } from '../content/game-config';
import { getOrbTheme } from '../content/theme';
import { DEFAULT_SETTINGS, type Settings } from '../storage/storage';
import { gameAudio, boardMusicPressure } from './audio';
import { fineRotationSpeed } from './rotation';
import { haptic } from './feedback';
import { recordRound } from '../storage/history';
import { usesButtonControls } from './input-mode';
import { shortcutAction, shortcutLabel } from './shortcuts';
import { heldRotationDegrees } from './rotation';
import { advanceTimed, createRound, descentInterval, freezeTimed, resumeTimed, resetDescent } from '../core/modes';

type ScenePhase = 'READY' | 'FLYING' | 'RESOLVING' | 'PAUSED' | 'WON' | 'LOST';

interface ProgressDriver {
  progress: number;
}

function sendWindowEvent(name: string, detail: unknown): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(name, { detail }));
}

export class PlayScene extends Phaser.Scene {
  private gameState: GameState = createGameState();
  private get geometry() { return { ...BOARD_GEOMETRY, rowOffset: this.gameState.rowOffset ?? 0 }; }
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
  private fineSpeed = 0;
  private quickTurn: { from: number; to: number; elapsed: number } | null = null;
  private get canSteer(): boolean { return ['READY', 'FLYING', 'RESOLVING'].includes(this.phase); }
  private pausedFrom: ScenePhase = 'READY';
  private roundEpoch = 0;
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
  private controlHint(): string {
    if (usesButtonControls()) return this.settings.immersiveMode ? '按住棋盘瞄准 · 松手发射' : '上条定位 · 下条微调 · 侧边发射';
    return `鼠标左 / 右键或${shortcutLabel(this.settings.shortcuts.fire)}发射`;
  }
  public get isTimed(): boolean { return this.gameState.mode === 'timed'; }
  public get activeState(): GameState { return this.gameState; }
  public settleGame(): void {
    this.syncTimedClock();
    if (this.gameState.status !== 'READY') return;
    this.gameState.status = 'WON';
    this.gameState.endReason = 'settled';
    this.finishImmediately();
  }
  private finishImmediately(): void {
    this.roundEpoch++;
    this.stopRotation();
    this.tweens.killAll();
    this.time.removeAllEvents();
    this.time.clearPendingEvents();
    this.transient.forEach(object => object.destroy());
    this.transient.clear();
    this.phase = this.gameState.status;
    this.renderBoard();
    this.renderLauncher();
    this.drawAim();
    this.emitState();
    recordRound(this.gameState);
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
  public persistGame(): void {
    if (!this.ready || this.abandoned) return;
    if (this.gameState.status === 'READY') sendWindowEvent('snood-save-request', this.gameState);
    else { recordRound(this.gameState); sendWindowEvent('snood-clear-save', this.gameState.mode ?? 'endless'); }
  }
  private clockTick = 0;
  private abandoned = false;
  private transient = new Set<Phaser.GameObjects.GameObject>();

  public override update(_time: number, delta: number): void {
    if (this.recoil > 0) {
      this.recoil = Math.max(0, this.recoil - delta / 140);
      this.positionBarrel();
    }
    if (this.isTimed) this.syncTimedClock();
    if (this.canSteer && this.fineSpeed) this.rotateLauncher(this.fineSpeed < 0 ? -1 : 1, Math.abs(this.fineSpeed) * Math.min(100, Math.max(0, delta)) / 1000);
    if (this.canSteer && this.rotationDirection !== 0) {
      const before = this.rotationHeldSeconds;
      this.rotationHeldSeconds += Math.max(0, delta) / 1000;
      const degrees = heldRotationDegrees(this.rotationHeldSeconds) - heldRotationDegrees(before);
      this.rotateLauncher(this.rotationDirection, degrees);
    } else if (!this.canSteer) this.stopRotation();
    if (this.canSteer && this.quickTurn) {
      const turn = this.quickTurn;
      turn.elapsed += Math.max(0, delta);
      const t = Math.min(1, turn.elapsed / 260);
      this.angle = turn.from + (turn.to - turn.from) * t * t * (3 - 2 * t);
      if (t === 1) this.quickTurn = null;
      this.aimDirty = true;
    }
    if (this.aimDirty) { this.aimDirty = false; this.drawAim(); }
    if (['READY', 'FLYING', 'RESOLVING'].includes(this.phase)) {
      if (!this.isTimed) this.gameState.elapsedMs = (this.gameState.elapsedMs ?? 0) + delta;
      this.clockTick += delta;
      if (this.clockTick >= (this.isTimed ? 100 : 1000)) { this.clockTick = 0; this.emitState(); }
    }
  }

  public constructor() {
    super({ key: 'PlayScene' });
  }

  public create(): void {
    // Render at twice the pixel density while retaining the original game coordinates.
    this.cameras.main.setZoom(2).centerOn(GAME_WIDTH / 2, GAME_HEIGHT / 2);
    this.cameras.main.setBackgroundColor(UI_COLORS.panel);
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
    this.input.on('pointerout', () => { this.pointerActive = false; });
    this.input.keyboard?.on('keydown', this.handleKeyDown, this);
    this.input.keyboard?.on('keyup', this.handleKeyUp, this);

    this.begin(createGameState('normal'));
    this.ready = true;
  }

  public begin(state: GameState): void {
    this.abandoned = false;
    this.roundEpoch++;
    state = resumeTimed(state);
    this.stopRotation();
    this.tweens.killAll();
    this.tweens.resumeAll();
    this.time.removeAllEvents();
    this.time.clearPendingEvents();
    this.time.paused = false;
    this.transient.forEach(object => object.destroy());
    this.transient.clear();
    this.pointerActive = false;
    this.pausedFrom = 'READY';
    state.sessionId ??= crypto.randomUUID();
    state.startedAt ??= Date.now();
    state.elapsedMs = Number.isFinite(state.elapsedMs) ? Math.max(0, state.elapsedMs!) : 0;
    this.clockTick = 0;
    this.gameState = state;
    this.phase = state.status;
    if (state.status === 'READY') this.phase = 'READY';
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

  public restartGame(): void {
    if (this.gameState.status === 'READY') recordRound(this.gameState, true);
    const difficulty = this.gameState.difficultyId;
    sendWindowEvent('snood-clear-save', this.gameState.mode ?? 'endless');
    this.begin(createRound(difficulty, this.gameState.mode ?? 'endless', this.gameState.durationMs));
  }

  public abandonGame(): void {
    this.pauseGame();
    if (this.gameState.status === 'READY') recordRound(this.gameState, true);
    this.abandoned = true;
    sendWindowEvent('snood-clear-save', this.gameState.mode ?? 'endless');
  }

  public setSettings(settings: Settings): void {
    const visualChanged = this.settings.aimAssist !== settings.aimAssist;
    this.settings = { ...settings };
    this.pointerActive = false;
    this.stopRotation();
    if (this.phase === 'READY') this.statusText?.setText(this.controlHint());
    this.audio.setMix(settings.volume, settings.musicVolume);
    if (visualChanged) { this.renderLauncher(); this.drawAim(); }
    sendWindowEvent('snood-settings-applied', this.settings);
  }

  public pauseGame(): void {
    this.stopRotation();
    this.syncTimedClock();
    if (this.phase === 'PAUSED' || this.phase === 'WON' || this.phase === 'LOST') return;
    this.gameState = freezeTimed(this.gameState);
    this.pausedFrom = this.phase;
    this.phase = 'PAUSED';
    this.tweens.pauseAll();
    this.time.paused = true;
    this.pointerActive = false;
    this.drawAim();
    this.persistGame();
    this.statusText.setText('已存档 · 可退出，下次继续');
    this.emitState();
  }

  public resumeGame(): void {
    if (this.phase !== 'PAUSED') return;
    this.gameState = resumeTimed(this.gameState);
    this.phase = this.pausedFrom;
    this.statusText.setText(this.phase === 'READY' ? this.controlHint() : '等待本次发射结算');
    this.tweens.resumeAll();
    this.time.paused = false;
    this.drawAim();
    this.emitState();
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
    if (this.angle !== angle) { this.angle = angle; this.aimDirty = true; }
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
  }

  public stopRotation(): void {
    this.quickTurn = null;
    this.fineSpeed = 0;
    this.rotationDirection = 0;
    this.rotationHeldSeconds = 0;
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
    const background = this.add.graphics();
    background.fillStyle(0x111a2d, 1);
    background.fillRoundedRect(26, 48, 588, 592, 24);
    background.lineStyle(1, UI_COLORS.line, 0.8);
    background.strokeRoundedRect(26, 48, 588, 592, 24);

    background.fillStyle(0x21304d, 0.55);
    background.fillRoundedRect(42, 61, 556, 20, 10);
    background.fillStyle(0x0d1323, 0.48);
    background.fillRoundedRect(42, 608, 556, 24, 12);

    background.lineStyle(1, UI_COLORS.line, 0.38);
    for (let row = 0; row < 17; row += 1) {
      const y = BOARD_GEOMETRY.baseY + row * BOARD_GEOMETRY.rowStep;
      background.lineBetween(48, y, 592, y);
    }

    for (let index = 0; index < 14; index += 1) {
      const x = 58 + index * 40;
      background.fillStyle(UI_COLORS.accent, index % 2 === 0 ? 0.16 : 0.08);
      background.fillCircle(x, 72, 2.2);
    }

    const floorLabel = this.add.text(GAME_WIDTH / 2, 623, '触底线 · 小球到达这里即失败', {
      resolution: 2,
      color: '#64718d',
      fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
      fontSize: '11px',
      fontStyle: 'bold',
      letterSpacing: 1,
    }).setOrigin(0.5);
    floorLabel.setAlpha(0.85);
    this.dangerLine = this.add.graphics();
    if (!usesButtonControls()) this.add.text(import.meta.env.MODE === 'windows' ? 478 : 405, 661, import.meta.env.MODE === 'windows' ? '当前球' : '下一球', {
      resolution: 2, color: '#98a1b8', fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif', fontSize: '14px',
    }).setOrigin(0.5);

  }

  private renderBoard(offsetY = 0): void {
    const pressure = boardMusicPressure(this.gameState.board);
    this.dangerLine?.clear().lineStyle(2, UI_COLORS.danger, .18 + pressure * .65).lineBetween(48, 608, 592, 608);
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
        if (orb && orb.getData('colorId') !== color) { orb.destroy(); orb = undefined; }
        if (!orb) {
          orb = this.createOrb(color, point);
          orb.setData('colorId', color);
          orb.setData('cellKey', key);
          this.boardGroup.add(orb);
          this.boardBalls.set(key, orb);
        }
        orb.setPosition(point.x, point.y).setScale(1).setAlpha(1);
        retained.add(key);
      }
    }
    for (const [key, orb] of this.boardBalls) {
      if (!retained.has(key)) { orb.destroy(); this.boardBalls.delete(key); }
    }
  }

  private renderLauncher(): void {
    this.launcherOrb?.destroy();
    this.nextOrb?.destroy();

    this.launcherBase.clear();
    if (!usesButtonControls()) {
      this.nextOrb = this.createOrb(import.meta.env.MODE === 'windows' ? this.gameState.currentColor : this.gameState.nextColor, { x: import.meta.env.MODE === 'windows' ? 478 : 405, y: 698 });
      this.nextOrb.setScale(import.meta.env.MODE === 'windows' ? 1.35 : .72);
    }
    const theme = getOrbTheme(this.gameState.currentColor);
    if (this.barrel) {
      this.barrel.clear();
      this.barrel.fillStyle(0x080e1a, 1).fillRoundedRect(-17, -62, 34, 68, 10);
      this.barrel.lineStyle(2, 0x7d91ad, 1).strokeRoundedRect(-17, -62, 34, 68, 10);
      this.barrel.fillStyle(0x304763, 1).fillRoundedRect(-12, -57, 24, 51, 7);
      this.barrel.fillStyle(theme.color, 1).fillRoundedRect(-11, -60, 22, 9, 3);
      this.barrel.fillStyle(0xf5f2eb, 0.8).fillTriangle(-5, -36, 5, -36, 0, -44);
      this.barrel.setRotation(this.angle);
    }
    this.launcherBase.fillStyle(0x0b1120, 0.95);
    this.launcherBase.fillCircle(BOARD_GEOMETRY.launcherX, BOARD_GEOMETRY.launcherY + 3, 42);
    this.launcherBase.lineStyle(2, UI_COLORS.line, 0.9);
    this.launcherBase.strokeCircle(BOARD_GEOMETRY.launcherX, BOARD_GEOMETRY.launcherY + 3, 42);
    this.launcherBase.fillStyle(0x253451, 0.9);
    this.launcherBase.fillCircle(BOARD_GEOMETRY.launcherX, BOARD_GEOMETRY.launcherY + 3, 29);
    this.launcherBase.fillStyle(UI_COLORS.accent, 0.65);
    this.launcherBase.fillCircle(BOARD_GEOMETRY.launcherX, BOARD_GEOMETRY.launcherY - 23, 4);

    this.launcherOrb = this.createOrb(this.gameState.currentColor, {
      x: BOARD_GEOMETRY.launcherX,
      y: BOARD_GEOMETRY.launcherY,
    });
    this.launcherOrb.setScale(0.93);
    this.launcherOrb.setRotation?.(0);

  }

  private createOrb(colorId: number, point: Point): Phaser.GameObjects.Container {
    const key = `orb-shared-${colorId}`;
    if (!this.textures.exists(key)) {
      const theme = getOrbTheme(colorId);
      const texture = this.textures.createCanvas(key, 192, 192)!;
      const ctx = texture.context;
      ctx.scale(4, 4);
      const circle = (x: number, y: number, radius: number, color: string) => {
        ctx.beginPath(); ctx.arc(x,y,radius,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
      };
      // Keep every painted pixel inside the ball; no cast shadow can cover a neighbour.
      ctx.beginPath(); ctx.arc(24,24,17.5,0,Math.PI*2); ctx.clip();
      circle(24,24,17.5,theme.cssColor);
      ctx.strokeStyle='rgba(255,255,255,.28)'; ctx.lineWidth=1.5; ctx.stroke();
      ctx.beginPath(); ctx.ellipse(18,17,5.5,3,0,0,Math.PI*2); ctx.fillStyle='rgba(255,255,255,.24)'; ctx.fill();
      ctx.fillStyle=theme.ink; ctx.font='bold 17px "Segoe UI Symbol", "Segoe UI", sans-serif';
      ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(theme.symbol,24,25);
      circle(18,32,1.7,theme.ink); circle(30,32,1.7,theme.ink);
      texture.refresh();
    }
    return this.add.container(point.x, point.y, [this.add.image(0, 0, key).setDisplaySize(48,48)]);
  }

  private positionBarrel(): void {
    if (!this.barrel) return;
    this.barrel.setRotation(this.angle);
    this.barrel.setPosition?.(BOARD_GEOMETRY.launcherX - Math.sin(this.angle) * this.recoil * 9,
      BOARD_GEOMETRY.launcherY + Math.cos(this.angle) * this.recoil * 9);
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
    const theme = getOrbTheme(this.gameState.currentColor);
    // Use the projectile's physical trace, with uniform spacing across reflections.
    let distance = 0, nextDot = 34;
    for (let i = 1; i < trace.points.length; i++) {
      const a = trace.points[i - 1], b = trace.points[i];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      while (length > 0 && nextDot <= distance + length) {
        const t = (nextDot - distance) / length;
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        this.aimGraphics.fillStyle(0x0b1120, 0.9).fillCircle(x, y, 3.5);
        this.aimGraphics.fillStyle(0xc5d7e0, 0.65).fillCircle(x, y, 2.2);
        nextDot += 15;
      }
      distance += length;
    }

    if (trace.bounced && trace.points.length > 2) {
      const bounce = trace.points.find((point, index) => index > 0 && (point.x <= BOARD_GEOMETRY.left + BOARD_GEOMETRY.radius + 0.1 || point.x >= BOARD_GEOMETRY.right - BOARD_GEOMETRY.radius - 0.1));
      if (bounce) this.aimGraphics.fillStyle(UI_COLORS.warning, 0.9).fillCircle(bounce.x, bounce.y, 4);
    }

    if (trace.landing) {
      const landingPoint = cellToPoint(trace.landing, this.geometry);
      this.aimGraphics.lineStyle(2, 0xffffff, 0.85);
      this.aimGraphics.strokeCircle(landingPoint.x, landingPoint.y, BOARD_GEOMETRY.radius);
      this.aimGraphics.lineStyle(1, theme.color, 0.9);
      this.aimGraphics.strokeCircle(landingPoint.x, landingPoint.y, BOARD_GEOMETRY.radius - 4);
    }
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (usesButtonControls()) return;
    if (pointer.button !== 0 && pointer.button !== 2) return;
    if (!this.canSteer) return;
    this.pointerActive = this.phase === 'READY';
    this.updateAim(pointer);
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer): void {
    if (usesButtonControls()) return;
    if (!this.canSteer) return;
    if (pointer.isDown || this.pointerActive || pointer.worldY < BOARD_GEOMETRY.launcherY) this.updateAim(pointer);
  }

  private handlePointerUp(): void {
    if (usesButtonControls()) { this.pointerActive = false; return; }
    if (!this.pointerActive) return;
    this.pointerActive = false;
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
      this.startRotation(action === 'left' ? -1 : 1);
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
    if (direction && direction === this.rotationDirection) this.stopRotation();
  }

  private launch(): void {
    this.syncTimedClock();
    if (this.phase !== 'READY') return;
    const epoch = this.roundEpoch;
    const trace = this.getShotTrace();
    if (!trace.landing) {
      this.showHint('这个角度没有合法落点', UI_COLORS.danger);
      return;
    }

    this.phase = 'FLYING';
    this.drawAim();
    this.pointerActive = false;
    this.audio.blip('shoot');
    haptic('shoot', this.settings);
    this.recoil = 1; this.positionBarrel();
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
    const removeDuration = dropped.length ? 330 : 170;
    const removeDelay = 36;

    const animationGroups = new Map<number, Phaser.GameObjects.Container[]>();
    for (const [index, cell] of removed.entries()) {
      const orb = this.boardBalls.get(cellKey(cell));
      if (!orb) continue;
      const falling = dropped.includes(cell);
      const delay = falling ? 90 + Math.min(index, 6) * removeDelay : 0;
      if (falling) {
        this.tweens.add({ targets: orb, y: orb.y + 150, angle: 18,
          duration: removeDuration, delay, ease: 'Quad.In' });
      }
      const group = animationGroups.get(delay) ?? [];
      group.push(orb);
      animationGroups.set(delay, group);
    }
    for (const [delay, targets] of animationGroups) {
      this.tweens.add({
        targets,
        scale: delay > 0 ? .85 : 0.05,
        alpha: 0,
        duration: removeDuration,
        delay,
        ease: delay > 0 ? 'Quad.In' : 'Back.In',
      });
    }

    const points = events.reduce((total, event) => total + (event.points ?? 0), 0);
    if (points > 0) {
      this.showScorePopup(points, dropped.length > 0 ? `消除 ${matched.length} · 悬空 ${dropped.length} 额外 +${events.find(event => event.type === 'drop')?.points ?? 0}` : `同色消除 ${matched.length}`);
      this.audio.blip(dropped.length > 0 ? 'drop' : 'match');
      haptic('match', this.settings);
    }
    if (events.some((event) => event.type === 'board-drop')) this.audio.blip('danger');

    const wait = animationGroups.size ? removeDuration + Math.max(...animationGroups.keys()) + 20 : 60;
    this.time.delayedCall(wait, () => {
      if (epoch !== this.roundEpoch) return;
      const droppedBoard = events.some((event) => event.type === 'board-drop');
      this.renderBoard(droppedBoard ? -BOARD_GEOMETRY.rowStep : 0);
      this.renderLauncher();
      const finish = () => {
      if (epoch !== this.roundEpoch) return;

      const win = events.some((event) => event.type === 'win');
      const lost = events.some((event) => event.type === 'lost');
      if (win) {
        this.phase = 'WON';
        this.audio.blip('win');
        this.statusText.setText('棋盘清空 · 这局属于你');
      } else if (lost) {
        this.phase = 'LOST';
        this.audio.blip('lose');
        this.statusText.setText('触底 · 再试一次');
      } else {
        this.phase = 'READY';
        this.statusText.setText(this.controlHint());
      }
      this.drawAim();
      this.emitState();
      if (this.phase === 'READY') sendWindowEvent('snood-save-request', this.gameState);
      if (this.phase === 'WON' || this.phase === 'LOST') {
        recordRound(this.gameState);
        sendWindowEvent('snood-finished', this.gameState);
      }
      };
      if (droppedBoard) {
        this.tweens.add({ targets: this.boardGroup, y: 0, duration: 360, ease: 'Cubic.Out', onComplete: finish });
      } else { this.boardGroup.setY(0); finish(); }
    });
  }

  private flashLanding(cell: Cell, color: number): void {
    const point = cellToPoint(cell, this.geometry);
    const flash = this.add.circle(point.x, point.y, BOARD_GEOMETRY.radius + 5, color, 0.22);
    this.transient.add(flash);
    this.tweens.add({
      targets: flash,
      scale: 1.75,
      alpha: 0,
      duration: 220,
      ease: 'Cubic.Out',
      onComplete: () => { flash.destroy(); this.transient.delete(flash); },
    });
  }

  private showScorePopup(points: number, label: string): void {
    const text = this.add.text(BOARD_GEOMETRY.launcherX, 590, `+${points}  ${label}`, {
      resolution: 2,
      color: '#f5f2eb',
      fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
      fontSize: '16px',
      fontStyle: 'bold',
      stroke: '#111a2d',
      strokeThickness: 5,
    }).setOrigin(0.5);
    this.transient.add(text);
    this.tweens.add({
      targets: text,
      y: 550,
      alpha: 0,
      duration: 620,
      ease: 'Cubic.Out',
      onComplete: () => { text.destroy(); this.transient.delete(text); },
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
      difficultyId: this.gameState.difficultyId,
      step: this.gameState.step,
      elapsedMs: this.gameState.elapsedMs ?? 0,
      mode: this.gameState.mode ?? 'endless',
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
  fps: { target: 60, limit: 60 },
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
