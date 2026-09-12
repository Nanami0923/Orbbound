import Phaser from 'phaser';
import { cellKey, cellToPoint } from '../core/grid';
import { createGameState, resolveShot } from '../core/engine';
import { traceShot } from '../core/physics';
import type { Cell, GameEvent, GameState, Point } from '../core/types';
import { BOARD_GEOMETRY, GAME_HEIGHT, GAME_WIDTH, UI_COLORS } from '../content/game-config';
import { getOrbTheme } from '../content/theme';
import { DEFAULT_SETTINGS, type Settings } from '../storage/storage';
import { GameAudio } from './audio';
import { recordRound } from '../storage/history';
import { usesButtonControls } from './input-mode';
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
  private audio = new GameAudio(this.settings);
  private angle = 0;
  private pointerActive = false;
  private rotationDirection: -1 | 0 | 1 = 0;
  private rotationHeldSeconds = 0;
  private quickTurn: { from: number; to: number; elapsed: number } | null = null;
  private get canSteer(): boolean { return ['READY', 'FLYING', 'RESOLVING'].includes(this.phase); }
  private pausedFrom: ScenePhase = 'READY';
  private boardGroup!: Phaser.GameObjects.Container;
  private aimGraphics!: Phaser.GameObjects.Graphics;
  private boardBalls = new Map<string, Phaser.GameObjects.Container>();
  private launcherOrb?: Phaser.GameObjects.Container;
  private nextOrb?: Phaser.GameObjects.Container;
  private launcherBase!: Phaser.GameObjects.Graphics;
  private statusText!: Phaser.GameObjects.Text;
  public ready = false;
  public get isPaused(): boolean { return this.phase === 'PAUSED'; }
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
    this.stopRotation();
    this.tweens.killAll();
    this.time.removeAllEvents();
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
    if (!this.ready) return;
    if (this.gameState.status === 'READY') sendWindowEvent('snood-save-request', this.gameState);
    else { recordRound(this.gameState); sendWindowEvent('snood-clear-save', this.gameState.mode ?? 'endless'); }
  }
  private clockTick = 0;
  private transient = new Set<Phaser.GameObjects.GameObject>();

  public override update(_time: number, delta: number): void {
    if (this.isTimed) this.syncTimedClock();
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
      this.drawAim();
    }
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
    this.input.on('pointermove', this.handlePointerMove, this);
    this.input.on('pointerup', this.handlePointerUp, this);
    this.input.on('pointerout', () => { this.pointerActive = false; });
    this.input.keyboard?.on('keydown', this.handleKeyDown, this);

    this.begin(createGameState('normal'));
    this.ready = true;
  }

  public begin(state: GameState): void {
    state = resumeTimed(state);
    this.stopRotation();
    this.tweens.killAll();
    this.tweens.resumeAll();
    this.time.removeAllEvents();
    this.time.paused = false;
    this.transient.forEach(object => object.destroy());
    this.transient.clear();
    this.pointerActive = false;
    state.sessionId ??= crypto.randomUUID();
    state.startedAt ??= Date.now();
    state.elapsedMs = Number.isFinite(state.elapsedMs) ? Math.max(0, state.elapsedMs!) : 0;
    this.clockTick = 0;
    this.gameState = state;
    this.phase = state.status;
    if (state.status === 'READY') this.phase = 'READY';
    this.angle = 0;
    this.statusText.setText(usesButtonControls() ? '底部按钮转向 · 中间按钮发射' : '移动瞄准 · 点击发射');
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

  public setSettings(settings: Settings): void {
    this.settings = { ...settings };
    this.audio.setEnabled(settings.sound);
    this.renderLauncher();
    this.drawAim();
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
    this.statusText.setText(this.phase === 'READY' ? (usesButtonControls() ? '底部按钮转向 · 中间按钮发射' : '选择角度 · 点击发射') : '等待本次发射结算');
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

  public startRotation(direction: -1 | 1): void {
    if (!this.canSteer) return;
    this.stopRotation();
    this.rotationDirection = direction;
    this.rotationHeldSeconds = 0;
    this.rotateLauncher(direction);
  }

  public stopRotation(): void {
    this.quickTurn = null;
    this.rotationDirection = 0;
    this.rotationHeldSeconds = 0;
  }

  public rotateLauncher(direction: -1 | 1, degrees = 1): void {
    if (!this.canSteer) return;
    const limit = 78 * Math.PI / 180;
    const angle = Math.max(-limit, Math.min(limit, this.angle + direction * degrees * Math.PI / 180));
    if (angle === this.angle) return;
    this.angle = angle;
    this.drawAim();
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
    this.add.text(478, 649, '下一球', {
      resolution: 2, color: '#98a1b8', fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif', fontSize: '14px',
    }).setOrigin(0.5);

  }

  private renderBoard(offsetY = 0): void {
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
    this.nextOrb = this.createOrb(this.gameState.nextColor, { x: 478, y: 698 });
    this.nextOrb.setScale(1.35);
    if (!this.settings.aimAssist) return;
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

  private drawAim(): void {
    this.aimGraphics.clear();
    // Keep the cursor hidden for the entire shot, including flight and resolution.
    const playing = this.phase === 'READY' || this.phase === 'FLYING' || this.phase === 'RESOLVING';
    this.input.setDefaultCursor(!this.settings.aimAssist && playing ? 'none' : 'auto');
    if (!playing) return;
    // During board animation show direction only; trace the settled board when ready.
    if (!this.settings.aimAssist || this.phase !== 'READY') {
      const x = BOARD_GEOMETRY.launcherX, y = BOARD_GEOMETRY.launcherY - BOARD_GEOMETRY.radius - 3;
      this.aimGraphics.lineStyle(4, getOrbTheme(this.gameState.currentColor).color, 1);
      this.aimGraphics.lineBetween(x, y, x + Math.sin(this.angle) * 84, y - Math.cos(this.angle) * 84);
      return;
    }

    const trace = traceShot(this.gameState.board, this.angle, this.geometry);
    const theme = getOrbTheme(this.gameState.currentColor);
    this.aimGraphics.lineStyle(3, theme.color, 0.62);
    this.aimGraphics.beginPath();
    this.aimGraphics.moveTo(trace.points[0].x, trace.points[0].y);
    for (const point of trace.points.slice(1)) this.aimGraphics.lineTo(point.x, point.y);
    this.aimGraphics.strokePath();

    if (trace.bounced && trace.points.length > 2) {
      const bounce = trace.points.find((point, index) => index > 0 && (point.x <= BOARD_GEOMETRY.left + BOARD_GEOMETRY.radius + 0.1 || point.x >= BOARD_GEOMETRY.right - BOARD_GEOMETRY.radius - 0.1));
      if (bounce) this.aimGraphics.fillStyle(UI_COLORS.warning, 0.9).fillCircle(bounce.x, bounce.y, 4);
    }

    if (trace.landing) {
      const landingPoint = cellToPoint(trace.landing, this.geometry);
      this.aimGraphics.lineStyle(2, theme.color, 0.95);
      this.aimGraphics.strokeCircle(landingPoint.x, landingPoint.y, BOARD_GEOMETRY.radius + 5);
      this.aimGraphics.fillStyle(theme.color, 0.18).fillCircle(landingPoint.x, landingPoint.y, BOARD_GEOMETRY.radius + 2);
    }
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (usesButtonControls()) return;
    if (this.phase !== 'READY') return;
    this.pointerActive = true;
    this.updateAim(pointer);
  }

  private handlePointerMove(pointer: Phaser.Input.Pointer): void {
    if (usesButtonControls()) return;
    if (this.phase !== 'READY') return;
    if (pointer.isDown || this.pointerActive || pointer.worldY < BOARD_GEOMETRY.launcherY) this.updateAim(pointer);
  }

  private handlePointerUp(): void {
    if (usesButtonControls()) { this.pointerActive = false; return; }
    if (!this.pointerActive) return;
    this.pointerActive = false;
    if (!this.settings.independentLaunch) this.launch();
  }

  private updateAim(pointer: Phaser.Input.Pointer): void {
    const dx = pointer.worldX - BOARD_GEOMETRY.launcherX;
    const dy = pointer.worldY - BOARD_GEOMETRY.launcherY;
    const nextAngle = Math.atan2(dx, -dy);
    const limit = Phaser.Math.DegToRad(78);
    this.angle = Phaser.Math.Clamp(Number.isFinite(nextAngle) ? nextAngle : 0, -limit, limit);
    this.drawAim();
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (document.querySelector<HTMLElement>('#game-screen')?.hidden || !document.querySelector<HTMLElement>('#modal-root')?.hidden) return;
    if (event.code === 'Space') { event.preventDefault(); if (event.repeat) return; }
    if (event.code === 'Escape') {
      event.preventDefault();
      sendWindowEvent('snood-save-home', undefined);
      return;
    }
    if (this.phase === 'PAUSED' && event.code === 'Space') {
      event.preventDefault();
      this.resumeGame();
      return;
    }
    if (this.phase !== 'READY') return;
    if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
      event.preventDefault();
      const amount = event.code === 'ArrowLeft' ? -Phaser.Math.DegToRad(3) : Phaser.Math.DegToRad(3);
      this.angle = Phaser.Math.Clamp(this.angle + amount, -Phaser.Math.DegToRad(78), Phaser.Math.DegToRad(78));
      this.drawAim();
    } else if (event.code === 'Space') {
      event.preventDefault();
      this.launch();
    }
  }

  private launch(): void {
    this.syncTimedClock();
    if (this.phase !== 'READY') return;
    const trace = traceShot(this.gameState.board, this.angle, this.geometry);
    if (!trace.landing) {
      this.showHint('这个角度没有合法落点', UI_COLORS.danger);
      return;
    }

    this.phase = 'FLYING';
    this.drawAim();
    this.pointerActive = false;
    this.audio.blip('shoot');
    this.statusText.setText(trace.bounced ? '反弹中 · 等待落点' : '飞行中 · 等待落点');
    this.emitState();

    const projectile = this.createOrb(this.gameState.currentColor, trace.points[0]);
    this.transient.add(projectile);
    projectile.setScale(0.93);
    const driver: ProgressDriver = { progress: 0 };
    const duration = this.settings.reducedMotion ? 90 : Math.min(920, Math.max(220, trace.points.length * 2.8));
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
        const position = driver.progress * (trace.points.length - 1);
        const index = Math.min(trace.points.length - 1, Math.floor(position));
        const point = trace.points[index];
        const next = trace.points[Math.min(index + 1, trace.points.length - 1)];
        const fraction = position - index;
        projectile.setPosition(point.x + (next.x - point.x) * fraction, point.y + (next.y - point.y) * fraction);
      },
      onComplete: () => {
        projectile.destroy();
        this.transient.delete(projectile);
        this.phase = 'RESOLVING';
        this.flashLanding(trace.landing!, getOrbTheme(previous.currentColor).color);
        this.animateResolution(previous, result.events);
      },
    });
  }

  private animateResolution(_previous: GameState, events: GameEvent[]): void {
    const matched = events.find((event) => event.type === 'match')?.cells ?? [];
    const dropped = events.find((event) => event.type === 'drop')?.cells ?? [];
    const removed = [...matched, ...dropped];
    const reduced = this.settings.reducedMotion;
    const removeDuration = reduced ? 80 : 170;
    const removeDelay = reduced ? 0 : 36;

    const animationGroups = new Map<number, Phaser.GameObjects.Container[]>();
    for (const [index, cell] of removed.entries()) {
      const orb = this.boardBalls.get(cellKey(cell));
      if (!orb) continue;
      const delay = dropped.includes(cell) ? Math.min(index, 8) * removeDelay : 0;
      const group = animationGroups.get(delay) ?? [];
      group.push(orb);
      animationGroups.set(delay, group);
    }
    for (const [delay, targets] of animationGroups) {
      this.tweens.add({
        targets,
        scale: 0.05,
        alpha: 0,
        duration: removeDuration,
        delay,
        ease: 'Back.In',
      });
    }

    const points = events.reduce((total, event) => total + (event.points ?? 0), 0);
    if (points > 0) {
      this.showScorePopup(points, dropped.length > 0 ? '同色消除 + 悬空掉落' : '同色消除');
      this.audio.blip(dropped.length > 0 ? 'drop' : 'match');
    }
    if (events.some((event) => event.type === 'board-drop')) this.audio.blip('danger');

    const wait = animationGroups.size ? removeDuration + Math.max(...animationGroups.keys()) + 20 : 60;
    this.time.delayedCall(wait, () => {
      const droppedBoard = events.some((event) => event.type === 'board-drop');
      this.renderBoard(droppedBoard ? -BOARD_GEOMETRY.rowStep : 0);
      this.renderLauncher();
      const finish = () => {

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
        this.statusText.setText(usesButtonControls() ? '底部按钮转向 · 中间按钮发射' : '移动瞄准 · 点击发射');
      }
      this.drawAim();
      this.emitState();
      if (this.phase === 'READY') sendWindowEvent('snood-save-request', this.gameState);
      if (this.phase === 'WON' || this.phase === 'LOST') {
        recordRound(this.gameState);
        sendWindowEvent('snood-finished', this.gameState);
      }
      };
      if (droppedBoard && !reduced) {
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
      duration: this.settings.reducedMotion ? 80 : 220,
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
      duration: this.settings.reducedMotion ? 120 : 620,
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
        this.statusText.setText((usesButtonControls() ? '底部按钮转向 · 中间按钮发射' : '选择角度 · 点击发射'));
      }
    });
  }

  private emitState(): void {
    sendWindowEvent('snood-state', {
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

