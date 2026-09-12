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
  public persistGame(): void {
    if (!this.ready) return;
    if (this.gameState.status === 'READY') sendWindowEvent('snood-save-request', this.gameState);
    else recordRound(this.gameState);
  }
  private clockTick = 0;
  private transient = new Set<Phaser.GameObjects.GameObject>();

  public override update(_time: number, delta: number): void {
    if (['READY', 'FLYING', 'RESOLVING'].includes(this.phase)) {
      this.gameState.elapsedMs = (this.gameState.elapsedMs ?? 0) + delta;
      this.clockTick += delta;
      if (this.clockTick >= 1000) { this.clockTick = 0; this.emitState(); }
    }
  }

  public constructor() {
    super({ key: 'PlayScene' });
  }

  public create(): void {
    this.cameras.main.setBackgroundColor(UI_COLORS.panel);
    this.createArena();
    this.boardGroup = this.add.container(0, 0);
    this.aimGraphics = this.add.graphics();
    this.launcherBase = this.add.graphics();
    this.statusText = this.add.text(0, 0, '', {
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
    this.gameState = state;
    this.phase = state.status;
    if (state.status === 'READY') this.phase = 'READY';
    this.angle = 0;
    this.statusText.setText(usesButtonControls() ? '底部按钮转向 · 中间按钮发射' : '移动瞄准 · 点击发射');
    this.renderBoard();
    this.renderLauncher();
    this.drawAim();
    this.emitState();
  }

  public restartGame(): void {
    if (this.gameState.status === 'READY') recordRound(this.gameState, true);
    const difficulty = this.gameState.difficultyId;
    sendWindowEvent('snood-clear-save', undefined);
    this.begin(createGameState(difficulty, Date.now()));
  }

  public setSettings(settings: Settings): void {
    this.settings = { ...settings };
    this.audio.setEnabled(settings.sound);
    this.renderLauncher();
    this.drawAim();
    sendWindowEvent('snood-settings-applied', this.settings);
  }

  public pauseGame(): void {
    if (this.phase === 'PAUSED' || this.phase === 'WON' || this.phase === 'LOST') return;
    this.pausedFrom = this.phase;
    this.phase = 'PAUSED';
    this.tweens.pauseAll();
    this.time.paused = true;
    this.pointerActive = false;
    this.drawAim();
    this.persistGame();
    this.statusText.setText('已暂停 · 按 Esc 或按钮继续');
    this.emitState();
  }

  public resumeGame(): void {
    if (this.phase !== 'PAUSED') return;
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
    this.launch();
  }

  public rotateLauncher(direction: -1 | 1): void {
    if (this.phase !== 'READY') return;
    const limit = 78 * Math.PI / 180;
    this.angle = Math.max(-limit, Math.min(limit, this.angle + direction * Math.PI / 180));
    this.drawAim();
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
      color: '#64718d',
      fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
      fontSize: '11px',
      fontStyle: 'bold',
      letterSpacing: 1,
    }).setOrigin(0.5);
    floorLabel.setAlpha(0.85);

  }

  private renderBoard(offsetY = 0): void {
    this.boardGroup.removeAll(true);
    this.boardGroup.setY(offsetY);
    this.boardBalls.clear();

    for (let row = 0; row < this.gameState.board.length; row += 1) {
      for (let col = 0; col < this.gameState.board[row].length; col += 1) {
        const color = this.gameState.board[row][col];
        if (color === null) continue;
        const cell = { row, col };
        const orb = this.createOrb(color, cellToPoint(cell, this.geometry));
        orb.setData('cellKey', cellKey(cell));
        this.boardGroup.add(orb);
        this.boardBalls.set(cellKey(cell), orb);
      }
    }
  }

  private renderLauncher(): void {
    this.launcherOrb?.destroy();
    this.nextOrb?.destroy();

    this.launcherBase.clear();
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

    this.nextOrb = this.createOrb(this.gameState.nextColor, { x: 478, y: 698 });
    this.nextOrb.setScale(0.72);

    const nextLabel = this.add.text(478, 735, '下一枚', {
      color: '#64718d',
      fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif',
      fontSize: '11px',
      fontStyle: 'bold',
      letterSpacing: 1,
    }).setOrigin(0.5);
    nextLabel.setData('launcher-label', true);
    this.time.delayedCall(1, () => nextLabel.destroy());
  }

  private createOrb(colorId: number, point: Point): Phaser.GameObjects.Container {
    const key = `orb-shared-${colorId}`;
    if (!this.textures.exists(key)) {
      const theme = getOrbTheme(colorId);
      const texture = this.textures.createCanvas(key, 96, 96)!;
      const ctx = texture.context;
      ctx.scale(2, 2);
      const circle = (x: number, y: number, radius: number, color: string) => {
        ctx.beginPath(); ctx.arc(x,y,radius,0,Math.PI*2); ctx.fillStyle=color; ctx.fill();
      };
      circle(26,28,18,'rgba(6,10,20,.45)');
      circle(24,24,18,theme.cssColor);
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
    if (this.phase !== 'READY') return;
    if (!this.settings.aimAssist) {
      const x = BOARD_GEOMETRY.launcherX, y = BOARD_GEOMETRY.launcherY - BOARD_GEOMETRY.radius - 3;
      this.aimGraphics.lineStyle(4, getOrbTheme(this.gameState.currentColor).color, 1);
      this.aimGraphics.lineBetween(x, y, x + Math.sin(this.angle) * 36, y - Math.cos(this.angle) * 36);
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
    if (pointer.isDown || this.pointerActive || pointer.y < BOARD_GEOMETRY.launcherY) this.updateAim(pointer);
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
      this.togglePause();
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
    this.tweens.add({
      targets: driver,
      progress: 1,
      duration,
      ease: 'Linear',
      onUpdate: () => {
        const index = Math.min(trace.points.length - 1, Math.floor(driver.progress * (trace.points.length - 1)));
        const point = trace.points[index];
        projectile.setPosition(point.x, point.y);
      },
      onComplete: () => {
        projectile.destroy();
        this.transient.delete(projectile);
        if (trace.landing) this.resolve(trace.landing);
      },
    });
  }

  private resolve(landing: Cell): void {
    this.phase = 'RESOLVING';
    const previous = this.gameState;
    const result = resolveShot(previous, landing);
    this.flashLanding(landing, getOrbTheme(previous.currentColor).color);
    this.gameState = result.state;
    this.animateResolution(previous, result.events);
  }

  private animateResolution(_previous: GameState, events: GameEvent[]): void {
    const matched = events.find((event) => event.type === 'match')?.cells ?? [];
    const dropped = events.find((event) => event.type === 'drop')?.cells ?? [];
    const removed = [...matched, ...dropped];
    const reduced = this.settings.reducedMotion;
    const removeDuration = reduced ? 80 : 170;
    const removeDelay = reduced ? 0 : 36;

    for (const [index, cell] of removed.entries()) {
      const orb = this.boardBalls.get(cellKey(cell));
      if (!orb) continue;
      this.tweens.add({
        targets: orb,
        scale: 0.05,
        alpha: 0,
        duration: removeDuration,
        delay: dropped.includes(cell) ? Math.min(index, 8) * removeDelay : 0,
        ease: 'Back.In',
      });
    }

    const points = events.reduce((total, event) => total + (event.points ?? 0), 0);
    if (points > 0) {
      this.showScorePopup(points, dropped.length > 0 ? '同色消除 + 悬空掉落' : '同色消除');
      this.audio.blip(dropped.length > 0 ? 'drop' : 'match');
    }
    if (events.some((event) => event.type === 'board-drop')) this.audio.blip('danger');

    const wait = reduced ? 100 : Math.min(620, 240 + removed.length * 28);
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
    });
  }
}

export const PHASER_CONFIG: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  fps: { target: 60, limit: 60 },
  width: GAME_WIDTH,
  height: GAME_HEIGHT,
  parent: 'game-container',
  backgroundColor: '#18223a',
  render: {
    antialias: true,
    pixelArt: false,
    roundPixels: true,
  },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
  },
  input: {
    activePointers: 3,
  },
  scene: [PlayScene],
};

