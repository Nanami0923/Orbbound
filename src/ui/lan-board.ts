import { BOARD_GEOMETRY } from '../content/game-config';
import { getOrbTheme } from '../content/theme';
import { cellToPoint } from '../core/grid';
import { traceShot } from '../core/physics';
import type { GameState, ShotTrace } from '../core/types';
import { gameAudio, boardMusicPressure } from '../game/audio';
import { LanPresentation } from './lan-presentation';
import { pointOnTrace } from '../lan/presentation';
import { FrameBudget, FrameRateGovernor, percentile } from '../game/frame-rate';
import { haptic } from '../game/feedback';
import { usesButtonControls } from '../game/input-mode';
import { directAimDegrees, fineRotationSpeed, heldRotationDegrees } from '../game/rotation';
import { immersiveAngle } from '../game/immersive-control';
import { bindSteeringControl } from '../game/steering-control';
import { shortcutAction } from '../game/shortcuts';
import { loadSettings } from '../storage/storage';
import { subscribeSettings } from '../storage/settings-store';
import { settingsEffects, snapshotSettings } from './settings-effects';
import { insideInputSurface, isFirePointerButton } from '../game/input-controller';
import { syncGameShell } from './game-shell';
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
  let settings = loadSettings();
  const touch = usesButtonControls(), abort = new AbortController();
  const fireButton = root.querySelector<HTMLButtonElement>('#lan-fire')!;
  const leftButton = root.querySelector<HTMLButtonElement>('#lan-turn-left')!;
  const rightButton = root.querySelector<HTMLButtonElement>('#lan-turn-right')!;
  let angle = 0, dirty = true, raf = 0, direction = 0, held = 0, lastAt = 0, lastPaint = 0;
  let pointer: number | null = null, queued: { angle: number; expiresAt: number } | undefined;
  let lastState: GameState | undefined, cachedState: GameState | undefined, cachedAngle = NaN, cachedTrace: ShotTrace | undefined;
  let animation: { state: GameState; trace: ShotTrace; start: number; duration: number; color: number; seqShots: number } | undefined;
  const presentation = new LanPresentation(drawLanBoard, orb, kind => { gameAudio.blip(kind); if (kind !== 'danger') haptic('match', settings); });
  presentation.reset(session.view.snapshot?.eventSeq ?? 0);
  let terminalAt: number | undefined;
  const budget = new FrameBudget(); const heldKeys = new Set<number>();
  const governor = new FrameRateGovernor(); governor.setRequested(settings.frameRate);
  let reportStarted = performance.now(), paintedFrames = 0, lastRaf = 0, opponentPaintAt = -Infinity;
  let intervals: number[] = [], costs: number[] = [];
  const releasePointer = () => { const previous = pointer; pointer = null; if (previous !== null && canvas.hasPointerCapture(previous)) canvas.releasePointerCapture(previous); };
  const resetInput = () => { direction = 0; held = 0; heldKeys.clear(); fine.value = '0'; queued = undefined; releasePointer(); directControl.reset(); fineControl.reset(); dirty = true; };
  const setAngle = (degrees: number) => { angle = directAimDegrees(degrees); slider.value = String(angle); dirty = true; };
  const state = () => session.view.snapshot?.players[session.view.selfId];
  const settingsOpen = () => document.documentElement?.classList.contains('settings-open') || !document.querySelector?.<HTMLElement>('#modal-root')?.hidden && !!document.querySelector?.<HTMLElement>('#modal-root');
  const active = () => session.view.phase === 'playing' && !state()?.sealed && !document.hidden && !root.closest('[hidden]') && !root.querySelector('.lan-confirm') && !settingsOpen();
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
    if (!active() || (touch && !settings.immersiveMode) || !isFirePointerButton(event.button, touch) || pointer !== null || !touch && !canFire()) return;
    event.preventDefault(); queued = undefined; pointer = event.pointerId; canvas.setPointerCapture(pointer); pointAim(event);
  }, { signal: abort.signal });
  canvas.addEventListener('pointerup', event => {
    if (pointer !== event.pointerId) return;
    event.preventDefault(); const rect = canvas.getBoundingClientRect();
    const inside = insideInputSurface(event.clientX, event.clientY, rect);
    releasePointer();
    if (touch && !settings.immersiveMode || !active() || !inside) return;
    pointAim(event); if (canFire()) fire(); else if (touch) queued = { angle, expiresAt: performance.now() + 1600 };
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
  const opponentCanvases = () => {
    const items = [...(root.querySelectorAll?.<HTMLCanvasElement>('[data-lan-player-board]') ?? [])];
    return items.length ? items : [other];
  };
  const opponentRevisions = new Map<string, number>();
  const resize = () => {
    const wrap = canvas.parentElement, available = wrap?.parentElement;
    if (wrap && available) {
      const space = available.getBoundingClientRect();
      const width = Math.min(space.width, space.height * 640 / 760);
      if (width > 0 && Math.abs((Number.parseFloat(wrap.style.width) || 0) - width) >= 0.5) wrap.style.width = `${width}px`;
    }
    const rect = canvas.getBoundingClientRect(), scale = settings.quality === 'auto' ? Math.min(2, devicePixelRatio || 1) : settings.quality;
    let changed = false;
    const size = (target: HTMLCanvasElement, width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      const pixelsWide = Math.max(1, Math.round(width * scale)), pixelsHigh = Math.max(1, Math.round(height * scale));
      if (target.width !== pixelsWide) { target.width = pixelsWide; changed = true; }
      if (target.height !== pixelsHigh) { target.height = pixelsHigh; changed = true; }
    };
    size(canvas, rect.width, rect.height);
    for (const target of opponentCanvases()) {
      const otherRect = target.getBoundingClientRect();
      size(target, otherRect.width, otherRect.height);
    }
    if (changed) { opponentRevisions.clear(); dirty = true; }
  };
  let resizeFrame = 0;
  const scheduleResize = () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; resize(); });
  };
  const observer = new ResizeObserver(scheduleResize); observer.observe(canvas); observer.observe(other);
  if (canvas.parentElement?.parentElement) observer.observe(canvas.parentElement.parentElement);
  resize();
  if (root.classList) syncGameShell(root, { touch, immersive: settings.immersiveMode, mode: session.view.snapshot?.mode ?? 'score' });
  let appliedSettings = snapshotSettings(settings);
  const unsubscribeSettings = subscribeSettings(value => {
    const changed = settingsEffects(appliedSettings, value); appliedSettings = snapshotSettings(value);
    if (changed.controls || changed.quality) { resetInput(); animation = undefined; }
    settings = value;
    if (changed.frameRate) { governor.setRequested(value.frameRate); budget.reset(); }
    if (changed.audio) { gameAudio.setMix(value.volume, value.musicVolume); gameAudio.setAdaptiveMusic(value.adaptiveMusic); }
    if (changed.layout && root.classList) {
      syncGameShell(root, { touch, immersive: value.immersiveMode, mode: session.view.snapshot?.mode ?? 'score' });
      root.classList.toggle('lan-swapped', value.controlsSwapped);
      root.style.setProperty('--lan-fire-width', `${value.fireSize}px`);
      root.style.setProperty('--lan-control-offset', `${value.controlOffset}px`);
    }
    if (changed.quality || changed.layout) resize();
    if (changed.visual) { dirty = true; opponentRevisions.clear(); }
  });
  window.addEventListener('orbbound-performance-capabilities', event => { governor.setCapabilities((event as CustomEvent).detail); scheduleResize(); }, { signal: abort.signal });
  const cachedCapabilities = (window as unknown as { __orbboundPerformanceCapabilities?: unknown }).__orbboundPerformanceCapabilities;
  if (cachedCapabilities) governor.setCapabilities(cachedCapabilities);
  window.dispatchEvent(new Event('orbbound-performance-request'));
  window.addEventListener('resize', scheduleResize, { signal: abort.signal });
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
    if (lastRaf && at > lastRaf && at - lastRaf < 250) intervals.push(at - lastRaf);
    lastRaf = at;
    if (at - reportStarted >= 1000) {
      const seconds = (at - reportStarted) / 1000, idle = !presentation.busy && !animation && !direction && !Number(fine.value);
      governor.observeDisplay(intervals); governor.assess(percentile(costs, .95), paintedFrames / seconds, idle);
      if (typeof CustomEvent !== 'undefined') window.dispatchEvent(new CustomEvent('snood-performance', { detail: { source: 'lan', renderFps: paintedFrames / seconds, targetFps: governor.target, idle, reason: governor.reason } }));
      reportStarted = at; paintedFrames = 0; intervals = []; costs = [];
    }
    const inputActive = active();
    if (!inputActive && previousInputActive) resetInput();
    previousInputActive = inputActive;
    if (queued && at > queued.expiresAt) queued = undefined;
    if (queued && canFire()) { setAngle(queued.angle); fire(); }
    if (active() && direction) { const before = heldRotationDegrees(held); held += dt; setAngle(angle + direction * (heldRotationDegrees(held) - before)); }
    if (active() && Number(fine.value)) setAngle(angle + fineRotationSpeed(Number(fine.value), settings.sensitivity) * dt);
    fireButton.disabled = !canFire(); slider.disabled = fine.disabled = leftButton.disabled = rightButton.disabled = !active();
    fireButton.textContent = session.view.pendingShot ? '确认中' : state()?.sealed ? '已触底' : queued ? '已待发' : canFire() ? '发射 ↑' : '准备中';
    if (budget.next(at, governor.target) === null) return;
    const player = state(), snapshot = session.view.snapshot; if (!player || !snapshot) return;
    const musicPlaying = session.view.phase === 'playing' && !player.sealed;
    if (!settingsOpen()) {
      gameAudio.setScene(musicPlaying ? 'play' : 'menu');
      gameAudio.setPressure(musicPlaying ? boardMusicPressure(player.state.board) : 0);
    }
    if (session.view.phase === 'finished' && terminalAt === undefined) terminalAt = at;
    if (session.view.phase !== 'finished') terminalAt = undefined;
    const logicalTime = snapshot.startedAtMs + session.displayElapsed() + (terminalAt === undefined ? 0 : Math.min(2000, at - terminalAt));
    presentation.ingest(session.view.presentationEvents ?? [], snapshot.eventSeq ?? 0, logicalTime);
    const workStarted = performance.now();
    const paintOpponents = at - opponentPaintAt >= 50;
    for (const target of opponentCanvases()) {
      const rivalId = target.dataset?.lanPlayerBoard ?? snapshot.playerIds.find(id => id !== session.view.selfId);
      const rival = rivalId && snapshot.players[rivalId];
      if (rival && paintOpponents && (rival.boardRevision !== opponentRevisions.get(rival.playerId) || presentation.busy)) {
        presentation.draw(target, rival.playerId, rival.state, logicalTime, true, false);
        opponentRevisions.set(rival.playerId, rival.boardRevision);
      }
    }
    if (paintOpponents) opponentPaintAt = at;
    if (!dirty && !animation && !presentation.busy && at - lastPaint < 200) return;
    dirty = false; lastPaint = at;
    if (animation && at - animation.start >= animation.duration) animation = undefined;
    const observed = player.sealed && root.dataset?.watchPlayer ? snapshot.players[root.dataset.watchPlayer] : undefined;
    const visiblePlayer = observed ?? player;
    const visibleState = animation?.state ?? visiblePlayer.state;
    const presenting = presentation.busy;
    presentation.draw(canvas, visiblePlayer.playerId, presenting ? visiblePlayer.state : visibleState, logicalTime, settings.reducedMotion, !observed, angle * Math.PI / 180,
      !observed && !animation && settings.aimAssist && session.view.phase === 'playing' ? getTrace() : undefined);
    if (animation && !presenting && !settings.reducedMotion) {
      // A pointer event can arrive after this RAF's timestamp was sampled.
      const point = pointOnTrace(animation.trace, (at - animation.start) / animation.duration);
      orb(canvas.getContext('2d')!, animation.color, point.x, point.y);
    }
    root.querySelector<HTMLOutputElement>('#lan-angle-value')!.value = `${angle.toFixed(1)}°`;
    paintedFrames++; costs.push(Math.max(0, performance.now() - workStarted));
  };
  raf = requestAnimationFrame(frame);
  return () => { resetInput(); presentation.reset(); gameAudio.setPressure(0); gameAudio.setScene('menu'); directControl.dispose(); fineControl.dispose(); abort.abort(); cancelAnimationFrame(raf); cancelAnimationFrame(resizeFrame); observer.disconnect(); unsubscribe(); unsubscribeSettings(); };
}
