import { BOARD_GEOMETRY } from '../content/game-config';
import { getOrbTheme } from '../content/theme';
import { BOARD_APPEARANCE, drawAimMarkers, drawDangerLine } from '../render/board-appearance';
import { arenaArtwork, canvasGraphics, drawOrb, makeArtworkCanvas, paintArena, paintLauncherBarrel, paintLauncherBase } from '../render/board-artwork';
import { boardCanvasSize, boardView, type BoardRole } from '../render/board-view';
import type { BoardPaintOptions } from './lan-presentation';
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

interface SettledLayer {
  board: GameState['board']; rowOffset: number; ceilingRow: number; targets: GameState['targets']; width: number; height: number; image: HTMLCanvasElement; context: CanvasRenderingContext2D;
}
const settledLayers = new WeakMap<HTMLCanvasElement, SettledLayer>();
function paintSettled(context: CanvasRenderingContext2D, state: GameState): void {
  const view = boardView(state), graphics = canvasGraphics(context);
  for (let row = 0; row < state.board.length; row++) for (let col = 0; col < state.board[row].length; col++) {
    const color = state.board[row][col]; if (color === null) continue;
    const point = cellToPoint({ row, col }, view.geometry); drawOrb(context, color, point.x, point.y);
    if (state.targets?.some(cell => cell.row === row && cell.col === col)) graphics.lineStyle(2, 0xffffff).strokeCircle(point.x, point.y, 20);
  }
}
export function drawLanBoard(canvas: HTMLCanvasElement, state: GameState, angle?: number, aim?: ShotTrace, boardOffset = 0, options: BoardPaintOptions = {}): void {
  const context = canvas.getContext('2d'); if (!context) return;
  const view = boardView(state), graphics = canvasGraphics(context), role = options.role ?? 'main';
  context.setTransform(canvas.width / 640, 0, 0, canvas.height / 760, 0, 0);
  const arena = arenaArtwork(); if (arena) context.drawImage(arena, 0, 0, 640, 760); else paintArena(context);
  drawDangerLine(graphics, view.pressure, view.geometry);
  let cached = settledLayers.get(canvas);
  if (!cached || cached.board !== state.board || cached.rowOffset !== (state.rowOffset ?? 0) || cached.ceilingRow !== (state.ceilingRow ?? 0)
    || cached.targets !== state.targets || cached.width !== canvas.width || cached.height !== canvas.height) {
    // Keep the large backing bitmap through before/transition/after board changes.
    const reusable = cached?.width === canvas.width && cached.height === canvas.height ? cached : undefined;
    const image = reusable?.image ?? makeArtworkCanvas(canvas.width, canvas.height);
    const layer = reusable?.context ?? image?.getContext('2d');
    if (image && layer) {
      layer.setTransform(1, 0, 0, 1, 0, 0); layer.clearRect(0, 0, canvas.width, canvas.height);
      layer.setTransform(canvas.width / 640, 0, 0, canvas.height / 760, 0, 0); paintSettled(layer, state);
      cached = { board: state.board, rowOffset: state.rowOffset ?? 0, ceilingRow: state.ceilingRow ?? 0, targets: state.targets, width: canvas.width, height: canvas.height, image, context: layer };
      settledLayers.set(canvas, cached);
    } else cached = undefined;
  }
  if (cached) context.drawImage(cached.image, 0, boardOffset, 640, 760);
  else { context.save(); context.translate(0, boardOffset); paintSettled(context, state); context.restore(); }
  if (role === 'thumbnail') return;
  if (angle !== undefined && aim) drawAimMarkers(graphics, aim, view.geometry, state.currentColor, aim.landing ? cellToPoint(aim.landing, view.geometry) : undefined);
  paintLauncherBase(context);
  // Read-only observation has no unsynchronized aiming angle; the loaded ball remains visible.
  if (angle !== undefined) {
    const recoil = options.recoil ?? 0;
    context.save(); context.translate(BOARD_GEOMETRY.launcherX - Math.sin(angle) * recoil * BOARD_APPEARANCE.recoilDistance,
      BOARD_GEOMETRY.launcherY + Math.cos(angle) * recoil * BOARD_APPEARANCE.recoilDistance); context.rotate(angle);
    paintLauncherBarrel(context, state.currentColor); context.restore();
  }
  drawOrb(context, state.currentColor, BOARD_GEOMETRY.launcherX, BOARD_GEOMETRY.launcherY, BOARD_APPEARANCE.orbRadius * BOARD_APPEARANCE.loadedScale);
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
  let angle = 0, dirty = true, raf = 0, direction = 0, held = 0, lastAt = 0;
  let pointer: number | null = null, queued: { angle: number; expiresAt: number } | undefined;
  let cachedState: GameState | undefined, cachedAngle = NaN, cachedTrace: ShotTrace | undefined;
  let animation: { state: GameState; trace: ShotTrace; start: number; duration: number; color: number; seqShots: number } | undefined;
  const presentation = new LanPresentation((target, drawnState, drawnAngle, aim, offset, paintOptions) => {
    drawLanBoard(target, drawnState, drawnAngle, aim, offset, paintOptions);
    // The preview follows the main canvas's presentation state, including prediction and observation.
    if (target !== canvas) return;
    const preview = root.querySelector<HTMLElement>('#lan-next-orb-preview');
    if (!preview || preview.dataset.colorId === String(drawnState.nextColor)) return;
    const theme = getOrbTheme(drawnState.nextColor);
    preview.dataset.colorId = String(drawnState.nextColor); preview.dataset.symbol = theme.symbol;
    preview.style.backgroundColor = theme.cssColor; preview.style.setProperty('--orb-ink', theme.ink);
  }, drawOrb, kind => { gameAudio.blip(kind); if (kind !== 'danger') haptic('match', settings); });
  presentation.reset(session.view.snapshot?.eventSeq ?? 0);
  const budget = new FrameBudget(); const heldKeys = new Set<number>();
  const governor = new FrameRateGovernor(); governor.setRequested(settings.frameRate);
  let reportStarted = performance.now(), paintedFrames = 0, observationFrames = 0, thumbnailFrames = 0, lastRaf = 0;
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
  interface PaintedView { playerId: string; revision: number; board: GameState['board']; rowOffset: number; ceilingRow: number; targets: GameState['targets']; current: number; next: number; width: number; height: number; busy: boolean; at: number; generation: number }
  const painted = new Map<HTMLCanvasElement, PaintedView>();
  const observedCanvases = new Set<HTMLCanvasElement>();
  let visualGeneration = 0, previousIdle = true, observationCanvas: HTMLCanvasElement | null = null;
  const sizeCanvas = (target: HTMLCanvasElement, role: BoardRole) => {
    const rect = target.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return;
    const constrained = governor.capabilities.powerSave === true || (governor.capabilities.thermalStatus ?? 0) >= 2;
    const pixels = boardCanvasSize(role, rect.width, rect.height, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, settings.quality, constrained);
    let changed = false;
    if (target.width !== pixels.width) { target.width = pixels.width; changed = true; }
    if (target.height !== pixels.height) { target.height = pixels.height; changed = true; }
    if (changed) { painted.delete(target); settledLayers.delete(target); }
  };
  const resize = () => {
    const wrap = canvas.parentElement, available = wrap?.parentElement;
    if (wrap && available) {
      const space = available.getBoundingClientRect(), preview = available.querySelector<HTMLElement>('.lan-next-preview');
      const gap = preview && typeof getComputedStyle === 'function' ? Number.parseFloat(getComputedStyle(available).rowGap) || 0 : 0;
      const height = Math.max(0, space.height - (preview?.getBoundingClientRect().height ?? 0) - gap);
      const width = Math.min(space.width, height * 640 / 760);
      if (width > 0 && Math.abs((Number.parseFloat(wrap.style.width) || 0) - width) >= .5) wrap.style.width = `${width}px`;
    }
    sizeCanvas(canvas, 'main'); for (const target of opponentCanvases()) sizeCanvas(target, 'thumbnail');
    if (observationCanvas) sizeCanvas(observationCanvas, 'observation'); dirty = true;
  };
  let resizeFrame = 0;
  const scheduleResize = () => { if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; resize(); }); };
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
      root.classList.toggle('lan-swapped', value.controlsSwapped); root.style.setProperty('--lan-fire-width', `${value.fireSize}px`); root.style.setProperty('--lan-control-offset', `${value.controlOffset}px`);
    }
    if (changed.quality || changed.layout) resize();
    if (changed.visual) { dirty = true; visualGeneration++; }
  });
  window.addEventListener('orbbound-performance-capabilities', event => { governor.setCapabilities((event as CustomEvent).detail); scheduleResize(); }, { signal: abort.signal });
  const cachedCapabilities = (window as unknown as { __orbboundPerformanceCapabilities?: unknown }).__orbboundPerformanceCapabilities;
  if (cachedCapabilities) governor.setCapabilities(cachedCapabilities);
  window.dispatchEvent(new Event('orbbound-performance-request'));
  window.addEventListener('resize', scheduleResize, { signal: abort.signal });
  let previousPhase = session.view.phase, previousInputActive = active();
  const unsubscribe = session.subscribe(() => {
    if (previousPhase !== session.view.phase) {
      resetInput(); animation = undefined;
      if (session.view.phase === 'countdown' || session.view.phase === 'reconnecting') { presentation.reset(session.view.snapshot?.eventSeq ?? 0); visualGeneration++; }
      previousPhase = session.view.phase;
    }
    const player = state();
    if (animation && !session.view.pendingShot && player?.totalShots === animation.seqShots && performance.now() > animation.start + 150) animation = undefined;
  });
  let audioBoard: GameState['board'] | undefined, audioPressure = -1, audioScene = '', pressure = 0;
  const updateAudio = () => {
    if (settingsOpen()) return;
    const player = state(), playing = session.view.phase === 'playing' && !!player && !player.sealed, scene = playing ? 'play' : 'menu';
    if (audioBoard !== player?.state.board) { audioBoard = player?.state.board; pressure = audioBoard ? boardMusicPressure(audioBoard) : 0; }
    if (audioScene !== scene) { audioScene = scene; gameAudio.setScene(scene); }
    const nextPressure = playing ? pressure : 0;
    if (nextPressure !== audioPressure) { audioPressure = nextPressure; gameAudio.setPressure(nextPressure); }
  };
  const frame = (at: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(100, lastAt ? at - lastAt : 0) / 1000; lastAt = at;
    if (document.hidden || root.closest('[hidden]')) return;
    const workStarted = performance.now();
    if (lastRaf && at > lastRaf && at - lastRaf < 250) intervals.push(at - lastRaf); lastRaf = at;
    if (at - reportStarted >= 1000) {
      const seconds = (at - reportStarted) / 1000;
      governor.observeDisplay(intervals); governor.assess(percentile(costs, .95), paintedFrames / seconds, previousIdle);
      window.dispatchEvent(new CustomEvent('snood-performance', { detail: { source: 'lan', requested: governor.requested, renderFps: (observationCanvas ? observationFrames : paintedFrames) / seconds,
        mainFps: paintedFrames / seconds, observationFps: observationFrames / seconds, thumbnailFps: thumbnailFrames / seconds, targetFps: governor.target, displayHz: governor.displayHz,
        idle: previousIdle, frameP95Ms: percentile(intervals, .95), workP95Ms: percentile(costs, .95), reason: governor.reason } }));
      reportStarted = at; paintedFrames = observationFrames = thumbnailFrames = 0; intervals = []; costs = [];
    }
    const inputActive = active(); if (!inputActive && previousInputActive) resetInput(); previousInputActive = inputActive;
    if (queued && at > queued.expiresAt) queued = undefined;
    if (queued && canFire()) { setAngle(queued.angle); fire(); }
    if (inputActive && direction) { const before = heldRotationDegrees(held); held += dt; setAngle(angle + direction * (heldRotationDegrees(held) - before)); }
    if (inputActive && Number(fine.value)) setAngle(angle + fineRotationSpeed(Number(fine.value), settings.sensitivity) * dt);
    const firing = canFire();
    if (fireButton.disabled === firing) fireButton.disabled = !firing;
    for (const control of [slider, fine, leftButton, rightButton]) if (control.disabled === inputActive) control.disabled = !inputActive;
    const fireLabel = session.view.pendingShot ? '确认中' : state()?.sealed ? '已触底' : queued ? '已待发' : firing ? '发射 ↑' : '准备中';
    if (fireButton.textContent !== fireLabel) fireButton.textContent = fireLabel;
    const player = state(), snapshot = session.view.snapshot;
    if (!player || !snapshot) { costs.push(Math.max(0, performance.now() - workStarted)); return; }
    const logicalTime = session.presentationTime();
    presentation.ingest(session.view.presentationEvents ?? [], snapshot.eventSeq ?? 0, logicalTime); presentation.advance(logicalTime, session.view.selfId);
    const nextObservation = root.querySelector<HTMLCanvasElement>('#lan-observe-board');
    if (nextObservation !== observationCanvas) {
      if (observationCanvas) { observer.unobserve?.(observationCanvas); settledLayers.delete(observationCanvas); painted.delete(observationCanvas); observedCanvases.delete(observationCanvas); }
      observationCanvas = nextObservation;
      if (observationCanvas) { observer.observe(observationCanvas); observedCanvases.add(observationCanvas); sizeCanvas(observationCanvas, 'observation'); }
    }
    const observedId = player.sealed ? root.dataset?.watchPlayer : undefined, visiblePlayer = observedId && snapshot.players[observedId] || player;
    const observationId = observationCanvas?.dataset?.lanObservePlayer;
    const motionActive = session.view.phase === 'playing' || session.view.phase === 'finished';
    const animated = dirty || !!animation || motionActive && (presentation.busyFor(visiblePlayer.playerId) || !!observationId && presentation.busyFor(observationId));
    // The fixed-rate budget keeps ticking during static views; input uses its next slot without bypassing the cap.
    previousIdle = !animated;
    if (budget.next(at, governor.target) === null) { costs.push(Math.max(0, performance.now() - workStarted)); return; }
    updateAudio();
    if (animation && at - animation.start >= animation.duration) { animation = undefined; dirty = true; }
    const paintView = (target: HTMLCanvasElement, playerId: string, role: BoardRole, local: boolean) => {
      const current = snapshot.players[playerId]; if (!current) return;
      const busy = motionActive && presentation.busyFor(playerId, role !== 'thumbnail'), last = painted.get(target);
      const changed = !last || last.playerId !== playerId || last.revision !== current.boardRevision || last.board !== current.state.board || last.current !== current.state.currentColor || last.next !== current.state.nextColor
        || last.rowOffset !== (current.state.rowOffset ?? 0) || last.ceilingRow !== (current.state.ceilingRow ?? 0) || last.targets !== current.state.targets
        || last.width !== target.width || last.height !== target.height || last.generation !== visualGeneration || last.busy !== busy;
      const predicting = local && !!animation && !presentation.hasBoardAnimationFor(playerId);
      if (!changed && !busy && !predicting && !(local && dirty)) return;
      if (role === 'thumbnail' && last && at - last.at < 50 && last.generation === visualGeneration) return;
      const visibleState = predicting ? animation!.state : current.state;
      const recoil = predicting && !settings.reducedMotion ? Math.max(0, 1 - (at - animation!.start) / BOARD_APPEARANCE.recoilMs) : 0;
      presentation.draw(target, playerId, visibleState, logicalTime, role === 'thumbnail' || settings.reducedMotion, local, local ? angle * Math.PI / 180 : undefined,
        local && !predicting && settings.aimAssist && session.view.phase === 'playing' ? getTrace() : undefined, { role, recoil });
      if (predicting && !settings.reducedMotion) { const point = pointOnTrace(animation!.trace, (at - animation!.start) / animation!.duration); drawOrb(target.getContext('2d')!, animation!.color, point.x, point.y, BOARD_APPEARANCE.orbRadius * BOARD_APPEARANCE.loadedScale); }
      painted.set(target, { playerId, revision: current.boardRevision, board: current.state.board, current: current.state.currentColor, next: current.state.nextColor,
        rowOffset: current.state.rowOffset ?? 0, ceilingRow: current.state.ceilingRow ?? 0, targets: current.state.targets,
        width: target.width, height: target.height, busy, at, generation: visualGeneration });
      if (role === 'thumbnail') thumbnailFrames++; else if (role === 'observation' && target === observationCanvas) observationFrames++; else paintedFrames++;
    };
    for (const target of opponentCanvases()) {
      const rivalId = target.dataset?.lanPlayerBoard ?? snapshot.playerIds.find(id => id !== session.view.selfId); if (rivalId) paintView(target, rivalId, 'thumbnail', false);
    }
    paintView(canvas, visiblePlayer.playerId, observedId ? 'observation' : 'main', !observedId);
    if (observationCanvas && observationId && !observationCanvas.closest('[hidden]')) paintView(observationCanvas, observationId, 'observation', false);
    dirty = false;
    const angleLabel = `${angle.toFixed(1)}°`, angleOutput = root.querySelector<HTMLOutputElement>('#lan-angle-value'); if (angleOutput && angleOutput.value !== angleLabel) angleOutput.value = angleLabel;
    costs.push(Math.max(0, performance.now() - workStarted));
  };
  raf = requestAnimationFrame(frame);
  return () => {
    resetInput(); presentation.reset(); gameAudio.setPressure(0); gameAudio.setScene('menu'); directControl.dispose(); fineControl.dispose(); abort.abort();
    cancelAnimationFrame(raf); cancelAnimationFrame(resizeFrame); observer.disconnect(); unsubscribe(); unsubscribeSettings();
    for (const target of [canvas, ...opponentCanvases(), ...observedCanvases]) settledLayers.delete(target); painted.clear(); observedCanvases.clear();
  };
}
