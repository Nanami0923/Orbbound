import { BOARD_GEOMETRY } from '../content/game-config';
import { getOrbTheme } from '../content/theme';
import { cellToPoint } from '../core/grid';
import { traceShot } from '../core/physics';
import type { GameState, ShotTrace } from '../core/types';
import { gameAudio, boardMusicPressure } from '../game/audio';
import { LanPresentation } from './lan-presentation';
import { pointOnTrace } from '../lan/presentation';
import { FrameBudget } from '../game/frame-rate';
import { haptic } from '../game/feedback';
import { usesButtonControls } from '../game/input-mode';
import { directAimDegrees, fineRotationSpeed, heldRotationDegrees } from '../game/rotation';
import { immersiveAngle } from '../game/immersive-control';
import { bindSteeringControl } from '../game/steering-control';
import { shortcutAction } from '../game/shortcuts';
import { loadSettings } from '../storage/storage';
import type { LanSession } from '../lan/session';

function orb(context: CanvasRenderingContext2D, color: number, x: number, y: number, radius = 17): void {
  const theme = getOrbTheme(color);
  context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fillStyle = theme.cssColor; context.fill();
  context.strokeStyle = '#ffffff30'; context.lineWidth = 1.5; context.stroke();
  context.fillStyle = theme.ink; context.font = `bold ${radius}px sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(theme.symbol, x, y + 1);
  context.beginPath(); context.ellipse(x - radius * .3, y - radius * .42, radius * .3, radius * .14, -.4, 0, Math.PI * 2); context.fillStyle = '#ffffff55'; context.fill();
}
export function drawLanBoard(canvas: HTMLCanvasElement, state: GameState, angle?: number, aim?: ShotTrace, boardOffset = 0): void {
  const context = canvas.getContext('2d'); if (!context) return;
  context.setTransform(canvas.width / 640, 0, 0, canvas.height / 760, 0, 0);
  context.clearRect(0, 0, 640, 760); context.fillStyle = '#101a2d'; context.fillRect(0, 0, 640, 760);
  context.fillStyle = '#263650'; context.fillRect(40, 56, 560, 3);
  context.strokeStyle = '#354563'; context.lineWidth = 2; context.strokeRect(40, 58, 560, 577);
  context.strokeStyle = '#ff777b77'; context.setLineDash([9, 10]); context.beginPath(); context.moveTo(40, 616); context.lineTo(600, 616); context.stroke(); context.setLineDash([]);
  const geometry = { ...BOARD_GEOMETRY, rowOffset: state.rowOffset ?? 0 };
  context.save(); context.beginPath(); context.rect(40, 58, 560, 577); context.clip();
  for (let row = 0; row < state.board.length; row++) for (let col = 0; col < state.board[row].length; col++) {
    const color = state.board[row][col]; if (color === null) continue;
    const point = cellToPoint({ row, col }, geometry); orb(context, color, point.x, point.y + boardOffset);
  }
  context.restore();
  if (angle === undefined) return;
  if (aim?.points.length) {
    context.lineWidth = 2; context.strokeStyle = '#b0e7d78a'; context.setLineDash([6, 10]); context.beginPath();
    aim.points.forEach((point, index) => { if (index === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y); }); context.stroke(); context.setLineDash([]);
    if (aim.landing) { const point = cellToPoint(aim.landing, geometry); context.beginPath(); context.arc(point.x, point.y, 17, 0, Math.PI * 2); context.strokeStyle = '#b0e7d7'; context.stroke(); }
  }
  context.save(); context.translate(320, 708); context.rotate(angle); context.fillStyle = '#63d7bd'; context.fillRect(-9, -49, 18, 36); context.restore();
  context.beginPath(); context.arc(320, 708, 28, 0, Math.PI * 2); context.fillStyle = '#263650'; context.fill();
  orb(context, state.currentColor, 320, 708, 20);
  context.font = '15px sans-serif'; context.fillStyle = '#98a1b8'; context.textAlign = 'right'; context.fillText('下一球', 540, 708); orb(context, state.nextColor, 569, 708, 17);
}

export function bindLanBoard(root: HTMLElement, session: LanSession): () => void {
  const canvas = root.querySelector<HTMLCanvasElement>('#lan-self-board')!;
  const other = root.querySelector<HTMLCanvasElement>('#lan-other-board')!;
  const slider = root.querySelector<HTMLInputElement>('#lan-angle')!;
  const fine = root.querySelector<HTMLInputElement>('#lan-fine')!;
  const settings = loadSettings(), touch = usesButtonControls(), abort = new AbortController();
  const fireButton = root.querySelector<HTMLButtonElement>('#lan-fire')!;
  const leftButton = root.querySelector<HTMLButtonElement>('#lan-turn-left')!;
  const rightButton = root.querySelector<HTMLButtonElement>('#lan-turn-right')!;
  let angle = 0, dirty = true, raf = 0, direction = 0, held = 0, lastAt = 0, lastPaint = 0, opponentRevision = -1;
  let pointer: number | null = null, queued: { angle: number; expiresAt: number } | undefined;
  let lastState: GameState | undefined, cachedState: GameState | undefined, cachedAngle = NaN, cachedTrace: ShotTrace | undefined;
  let animation: { state: GameState; trace: ShotTrace; start: number; duration: number; color: number; seqShots: number } | undefined;
  const presentation = new LanPresentation(drawLanBoard, orb, kind => { gameAudio.blip(kind); if (kind !== 'danger') haptic('match', settings); });
  presentation.reset(session.view.snapshot?.eventSeq ?? 0);
  let terminalAt: number | undefined;
  const budget = new FrameBudget(); const heldKeys = new Set<number>();
  const releasePointer = () => { const previous = pointer; pointer = null; if (previous !== null && canvas.hasPointerCapture(previous)) canvas.releasePointerCapture(previous); };
  const resetInput = () => { direction = 0; held = 0; heldKeys.clear(); fine.value = '0'; queued = undefined; releasePointer(); directControl.reset(); fineControl.reset(); dirty = true; };
  const setAngle = (degrees: number) => { angle = directAimDegrees(degrees); slider.value = String(angle); dirty = true; };
  const state = () => session.view.snapshot?.players[session.view.selfId];
  const active = () => session.view.phase === 'playing' && !document.hidden && !root.closest('[hidden]') && !root.querySelector('.lan-confirm');
  const canFire = () => active() && !session.view.pendingShot && !!state() && !state()!.sealed
    && session.displayElapsed() < (session.view.snapshot?.durationMs ?? 0)
    && session.displayElapsed() + (session.view.snapshot?.startedAtMs ?? 0) >= state()!.readyAtMs;
  const getTrace = () => {
    const player = state(); if (!player) return;
    if (cachedState !== player.state || cachedAngle !== angle) {
      cachedState = player.state; cachedAngle = angle;
      cachedTrace = traceShot(player.state.board, angle * Math.PI / 180, { ...BOARD_GEOMETRY, rowOffset: player.state.rowOffset ?? 0 });
    }
    return cachedTrace;
  };
  const fire = () => {
    if (!canFire()) return;
    const player = state()!, trace = getTrace(); if (!trace?.landing) return;
    queued = undefined; gameAudio.unlock();
    animation = { state: player.state, trace, start: performance.now(), duration: Math.min(920, Math.max(220, trace.points.length * 2.8)), color: player.state.currentColor, seqShots: player.totalShots };
    session.shoot(Math.round(angle * 1000)); gameAudio.blip('shoot'); haptic('shoot', settings); dirty = true;
  };
  const pointAim = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    setAngle(immersiveAngle((event.clientX - rect.left) * 640 / rect.width, (event.clientY - rect.top) * 760 / rect.height));
  };
  canvas.addEventListener('pointermove', event => {
    if (!active()) return;
    if ((!touch && pointer === null) || pointer === event.pointerId) { event.preventDefault(); pointAim(event); }
  }, { signal: abort.signal });
  canvas.addEventListener('pointerdown', event => {
    if (!active() || (touch && !settings.immersiveMode) || event.button !== 0 || pointer !== null) return;
    event.preventDefault(); queued = undefined; pointer = event.pointerId; canvas.setPointerCapture(pointer); pointAim(event);
    if (!touch) fire();
  }, { signal: abort.signal });
  canvas.addEventListener('pointerup', event => {
    if (pointer !== event.pointerId) return;
    event.preventDefault(); const rect = canvas.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    releasePointer();
    if (!touch || !settings.immersiveMode || !active() || !inside) return;
    pointAim(event); if (canFire()) fire(); else queued = { angle, expiresAt: performance.now() + 1600 };
  }, { signal: abort.signal });
  for (const type of ['pointercancel', 'lostpointercapture']) canvas.addEventListener(type, event => {
    if ((event as PointerEvent).pointerId === pointer) { queued = undefined; releasePointer(); }
  }, { signal: abort.signal });
  for (const type of ['touchstart', 'touchmove']) canvas.addEventListener(type, event => {
    if (active() && touch && settings.immersiveMode && event.cancelable) event.preventDefault();
  }, { signal: abort.signal, passive: false });
  canvas.addEventListener('contextmenu', event => event.preventDefault(), { signal: abort.signal });
  const beginSteering = () => { queued = undefined; direction = 0; held = 0; heldKeys.clear(); gameAudio.unlock(); };
  const directControl = bindSteeringControl(slider, { fine: false, active, onStart: beginSteering, onValue: setAngle, hitArea: slider.closest('label') ?? slider });
  const fineControl = bindSteeringControl(fine, { fine: true, active, onStart: beginSteering, onValue: value => { fine.value = String(value); }, hitArea: fine.closest('label') ?? fine });
  fireButton.addEventListener('pointerdown', event => { if (event.button === 0) { event.preventDefault(); fire(); } }, { signal: abort.signal });
  fireButton.addEventListener('click', event => { if (event.detail === 0) fire(); }, { signal: abort.signal });
  leftButton.addEventListener('click', () => { if (active()) { queued = undefined; setAngle(angle - 30); } }, { signal: abort.signal });
  rightButton.addEventListener('click', () => { if (active()) { queued = undefined; setAngle(angle + 30); } }, { signal: abort.signal });
  window.addEventListener('keydown', event => {
    const target = event.target as HTMLElement | null;
    if (!active() || target?.closest?.('input,select,textarea,[contenteditable="true"]') || (['Space', 'Enter'].includes(event.code) && target?.closest?.('button'))) return;
    const action = shortcutAction(event, settings.shortcuts); if (!action || !['fire', 'left', 'right', 'quickLeft', 'quickRight'].includes(action)) return;
    event.preventDefault(); if (event.repeat) return;
    if (action === 'fire') fire();
    else if (action === 'quickLeft' || action === 'quickRight') setAngle(angle + (action === 'quickLeft' ? -30 : 30));
    else { const next = action === 'left' ? -1 : 1; heldKeys.delete(next); heldKeys.add(next); direction = next; held = 0; setAngle(angle + next); }
  }, { signal: abort.signal });
  window.addEventListener('keyup', event => {
    const value = event.code === settings.shortcuts.left ? -1 : event.code === settings.shortcuts.right ? 1 : 0;
    if (value) { heldKeys.delete(value); direction = [...heldKeys].at(-1) ?? 0; held = 0; }
  }, { signal: abort.signal });
  window.addEventListener('blur', resetInput, { signal: abort.signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) resetInput(); }, { signal: abort.signal });
  const resize = () => {
    const rect = canvas.getBoundingClientRect(), scale = settings.quality === 'auto' ? Math.min(2, devicePixelRatio || 1) : settings.quality;
    if (rect.width > 0) { canvas.width = Math.max(1, Math.round(rect.width * scale)); canvas.height = Math.max(1, Math.round(rect.height * scale)); }
    const otherRect = other.getBoundingClientRect();
    if (otherRect.width > 0) { other.width = Math.max(1, Math.round(otherRect.width * scale)); other.height = Math.max(1, Math.round(otherRect.height * scale)); }
    dirty = true; opponentRevision = -1;
  };
  const observer = new ResizeObserver(resize); observer.observe(canvas); observer.observe(other); resize();
  window.addEventListener('resize', resize, { signal: abort.signal });
  let previousPhase = session.view.phase;
  let previousInputActive = active();
  const unsubscribe = session.subscribe(() => {
    if (previousPhase !== session.view.phase) {
      resetInput(); animation = undefined;
      if (session.view.phase === 'countdown' || session.view.phase === 'reconnecting') presentation.reset(session.view.snapshot?.eventSeq ?? 0);
      previousPhase = session.view.phase;
    }
    const player = state();
    if (player && player.state !== lastState) { dirty = true; lastState = player.state; }
    if (animation && !session.view.pendingShot && player?.totalShots === animation.seqShots && performance.now() > animation.start + 150) animation = undefined;
  });
  const frame = (at: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(100, lastAt ? at - lastAt : 0) / 1000; lastAt = at;
    if (document.hidden) return;
    const inputActive = active();
    if (!inputActive && previousInputActive) resetInput();
    previousInputActive = inputActive;
    if (queued && at > queued.expiresAt) queued = undefined;
    if (queued && canFire()) { setAngle(queued.angle); fire(); }
    if (active() && direction) { const before = heldRotationDegrees(held); held += dt; setAngle(angle + direction * (heldRotationDegrees(held) - before)); }
    if (active() && Number(fine.value)) setAngle(angle + fineRotationSpeed(Number(fine.value), settings.sensitivity) * dt);
    fireButton.disabled = !canFire(); slider.disabled = fine.disabled = leftButton.disabled = rightButton.disabled = !active();
    fireButton.textContent = session.view.pendingShot ? '确认中' : state()?.sealed ? '已触底' : queued ? '已待发' : canFire() ? '发射 ↑' : '准备中';
    if (budget.next(at, settings.frameRate === 'auto' ? 120 : settings.frameRate) === null) return;
    const player = state(), snapshot = session.view.snapshot; if (!player || !snapshot) return;
    const musicPlaying = session.view.phase === 'playing' && !player.sealed;
    gameAudio.setScene(musicPlaying ? 'play' : 'menu');
    gameAudio.setPressure(musicPlaying ? boardMusicPressure(player.state.board) : 0);
    if (session.view.phase === 'finished' && terminalAt === undefined) terminalAt = at;
    if (session.view.phase !== 'finished') terminalAt = undefined;
    const logicalTime = snapshot.startedAtMs + session.displayElapsed() + (terminalAt === undefined ? 0 : Math.min(2000, at - terminalAt));
    presentation.ingest(session.view.presentationEvents ?? [], snapshot.eventSeq ?? 0, logicalTime);
    const rival = snapshot.players[session.view.selfId === 'host' ? 'guest' : 'host'];
    if (rival && (rival.boardRevision !== opponentRevision || presentation.busy)) { presentation.draw(other, rival.playerId, rival.state, logicalTime, true, false); opponentRevision = rival.boardRevision; }
    if (!dirty && !animation && !presentation.busy && at - lastPaint < 200) return;
    dirty = false; lastPaint = at;
    if (animation && at - animation.start >= animation.duration) animation = undefined;
    const visibleState = animation?.state ?? player.state;
    const presenting = presentation.busy;
    presentation.draw(canvas, player.playerId, presenting ? player.state : visibleState, logicalTime, settings.reducedMotion, true, angle * Math.PI / 180,
      !animation && settings.aimAssist && session.view.phase === 'playing' ? getTrace() : undefined);
    if (animation && !presenting && !settings.reducedMotion) {
      // A pointer event can arrive after this RAF's timestamp was sampled.
      const point = pointOnTrace(animation.trace, (at - animation.start) / animation.duration);
      orb(canvas.getContext('2d')!, animation.color, point.x, point.y);
    }
    root.querySelector<HTMLOutputElement>('#lan-angle-value')!.value = `${angle.toFixed(1)}°`;
  };
  raf = requestAnimationFrame(frame);
  return () => { resetInput(); presentation.reset(); gameAudio.setPressure(0); gameAudio.setScene('menu'); directControl.dispose(); fineControl.dispose(); abort.abort(); cancelAnimationFrame(raf); observer.disconnect(); unsubscribe(); };
}
