import { BOARD_GEOMETRY } from '../content/game-config';
import { getOrbTheme } from '../content/theme';
import { createGameState, resolveShot } from '../core/engine';
import { cellToPoint, createEmptyBoard, occupiedCells } from '../core/grid';
import { traceShot } from '../core/physics';
import type { GameEvent, GameState, ShotTrace } from '../core/types';
import { DEFAULT_SHORTCUTS, shortcutLabel, type Shortcuts } from '../game/shortcuts';
import { fineRotationSpeed } from '../game/rotation';
import { bindSteeringControl } from '../game/steering-control';

export type PracticeControlMode = 'desktop' | 'buttons' | 'immersive';
export const PRACTICE_GEOMETRY = { ...BOARD_GEOMETRY, launcherY: 344, floor: 315 };
export const PRACTICE_STEPS = [
  { title: '同色连接', goal: '调整方向，把珊瑚色球接到上方两个同类旁。三个相连才会消除。', hint: '看空心落点圈，让它紧贴两个 ● 球。', columns: [6, 7] },
  { title: '切断支撑', goal: '先消除顶部的 ● 球，让它们下方的两个球失去支撑。', hint: '绕开下方的球，瞄准顶部支撑的右侧。', columns: [6, 7] },
  { title: '借墙反弹', goal: '这一步请先碰到墙，再连上左上方的两个 ● 球。', hint: '把炮口转向左墙，观察反弹路线和空心落点圈。', columns: [0, 1] },
  { title: '用自己的方式发射', goal: '用当前操控方式，消除右上方两个 ● 球。', hint: '调整方向，确认落点，再发射。', columns: [10, 11] },
] as const;

/** Practice owns no session ID and never calls storage or leaderboard APIs. */
export function createPracticeState(step: number): GameState {
  const lesson = PRACTICE_STEPS[step];
  if (!lesson) throw Error('练习步骤不存在');
  const state = createGameState('easy', 4200 + step);
  state.board = createEmptyBoard(14, 19);
  for (const col of lesson.columns) state.board[0][col] = 0;
  if (step === 1) { state.board[1][6] = 1; state.board[2][6] = 2; }
  state.currentColor = 0; state.nextColor = 0;
  return state;
}

export interface PracticeShot { state: GameState; trace: ShotTrace; events: GameEvent[]; passed: boolean; message: string }
export function resolvePracticeShot(step: number, state: GameState, angleDegrees: number): PracticeShot {
  const degrees = Math.max(-78, Math.min(78, Number.isFinite(angleDegrees) ? angleDegrees : 0));
  const trace = traceShot(state.board, degrees * Math.PI / 180, PRACTICE_GEOMETRY);
  if (!trace.landing) return { state, trace, events: [], passed: false, message: '这个方向没有落点，调整方向再试。' };
  const result = resolveShot(state, trace.landing);
  const matched = result.events.some(event => event.type === 'match' && (event.cells?.length ?? 0) >= 3);
  const dropped = result.events.some(event => event.type === 'drop' && (event.cells?.length ?? 0) >= 2);
  const passed = matched && (step !== 1 || dropped) && (step !== 2 || trace.bounced);
  const message = passed ? step === 1 ? '支撑已切断，下面的两个球一起掉落。' : step === 2 ? '反弹命中，同色相连消除了。' : '三个同类连上了，消除成功。'
    : step === 2 && matched ? '已经连上同色；这一关再试先碰墙反弹。' : PRACTICE_STEPS[step]?.hint ?? '再调整方向试试。';
  return { ...result, trace, passed, message };
}

function controlDescription(mode: PracticeControlMode, shortcuts = DEFAULT_SHORTCUTS): string {
  if (mode === 'buttons') return '上条定位方向，下条按住微调；可以一只手瞄准，另一只手按发射。';
  if (mode === 'immersive') return '在棋盘内按住拖动瞄准，松手发射；移出棋盘松手或系统中断会取消。';
  return `移动鼠标瞄准，左右键松开发射；也可用 ${shortcutLabel(shortcuts.left)} / ${shortcutLabel(shortcuts.right)} 调整方向，${shortcutLabel(shortcuts.fire)} 发射。`;
}

export function practiceMarkup(controlMode: PracticeControlMode = 'desktop'): string {
  return `<button class="modal-close" id="practice-close" type="button">关闭练习</button><p class="eyebrow">PRACTICE / <span id="practice-progress">01 / 04</span></p><h2 id="practice-title">同色连接</h2><p id="practice-goal">${PRACTICE_STEPS[0].goal}</p><p class="mode-note" id="practice-control-help">${controlDescription(controlMode)}</p><svg id="practice-board" class="practice-board" viewBox="0 0 640 400" tabindex="0" aria-label="互动练习棋盘，使用当前操控方式瞄准发射"></svg><div class="practice-controls" ${controlMode !== 'buttons' ? 'hidden' : ''}><label class="steering-control" for="practice-aim">方向<input id="practice-aim" type="range" min="-78" max="78" step="0.1" value="-28" aria-label="练习瞄准方向"></label><label class="steering-control" for="practice-fine">按住微调<input id="practice-fine" type="range" min="-100" max="100" step="1" value="0" aria-label="练习微调"></label></div><div class="practice-shot-actions"><output id="practice-angle" aria-live="off">-28.0°</output><button class="primary-button" id="practice-fire" type="button" ${controlMode === 'immersive' ? 'hidden' : ''}>发射</button></div><p id="practice-feedback" class="mode-note" role="status" aria-live="polite">练习可随时跳过，不影响存档和成绩。</p><div class="modal-footer"><button id="practice-next" class="primary-button" type="button" disabled>下一步 →</button><button id="practice-reset" class="quiet-button" type="button">重试这一步</button><button id="practice-skip" class="quiet-button" type="button">跳过练习</button></div>`;
}

export function bindPracticePanel(root: HTMLElement, options: { controlMode: PracticeControlMode; shortcuts?: Shortcuts; sensitivity?: number; onComplete(): void; onSkip(): void; onClose?: () => void }): () => void {
  const board = root.querySelector<SVGSVGElement>('#practice-board')!;
  const title = root.querySelector<HTMLElement>('#practice-title')!;
  const goal = root.querySelector<HTMLElement>('#practice-goal')!;
  const progress = root.querySelector<HTMLElement>('#practice-progress')!;
  const feedback = root.querySelector<HTMLElement>('#practice-feedback')!;
  const next = root.querySelector<HTMLButtonElement>('#practice-next')!;
  const fireButton = root.querySelector<HTMLButtonElement>('#practice-fire')!;
  const aimInput = root.querySelector<HTMLInputElement>('#practice-aim')!;
  const fineInput = root.querySelector<HTMLInputElement>('#practice-fine')!;
  const angleOutput = root.querySelector<HTMLElement>('#practice-angle')!;
  const abort = new AbortController(), shortcuts = options.shortcuts ?? DEFAULT_SHORTCUTS;
  root.querySelector<HTMLElement>('#practice-control-help')!.textContent = controlDescription(options.controlMode, shortcuts);
  let step = 0, state = createPracticeState(0), angle = -28, passed = false, disposed = false;
  let owner: number | null = null, fine = 0, frame = 0, lastTime = 0;
  const keys = new Set<string>();
  let resultTimer: ReturnType<typeof setTimeout> | undefined;
  let resultTrace: ShotTrace | undefined;
  const playing = () => !disposed && !passed && resultTimer === undefined;
  const setStatus = (message: string) => { feedback.textContent = message; };
  const render = () => {
    const trace = resultTrace ?? traceShot(state.board, angle * Math.PI / 180, PRACTICE_GEOMETRY);
    const circles = occupiedCells(state.board).map(cell => {
      const point = cellToPoint(cell, PRACTICE_GEOMETRY), theme = getOrbTheme(state.board[cell.row][cell.col]!);
      return `<g><circle cx="${point.x}" cy="${point.y}" r="18" fill="${theme.cssColor}"/><text x="${point.x}" y="${point.y}" fill="${theme.ink}" text-anchor="middle" dominant-baseline="central" font-size="22" font-weight="700">${theme.symbol}</text></g>`;
    }).join('');
    const path = trace.points.filter((point, index) => index % 4 === 0 || index === trace.points.length - 1 || point.x <= 58.1 || point.x >= 581.9).map(point => `${point.x},${point.y}`).join(' ');
    const landing = trace.landing && !passed ? cellToPoint(trace.landing, PRACTICE_GEOMETRY) : null;
    board.innerHTML = `<rect x="40" y="58" width="560" height="320" rx="18" fill="#18223a" stroke="#64718d" stroke-width="2"/><path d="M40 58V360M600 58V360" fill="none" stroke="#f6c85f" stroke-width="4"/><polyline points="${path}" fill="none" stroke="#c5d7e0" stroke-width="3" stroke-dasharray="5 10"/>${circles}${landing ? `<circle cx="${landing.x}" cy="${landing.y}" r="18" fill="none" stroke="white" stroke-width="2"/>` : ''}<g transform="rotate(${angle} 320 344)"><path d="M320 344V313" stroke="#64718d" stroke-width="28" stroke-linecap="round"/><circle cx="320" cy="344" r="18" fill="#ff777b"/><text x="320" y="345" text-anchor="middle" dominant-baseline="central" fill="#3b2036" font-size="22">●</text></g>`;
    angleOutput.textContent = `${angle.toFixed(1)}°`;
    aimInput.value = String(angle);
    fireButton.disabled = !playing();
    next.disabled = !passed || resultTimer !== undefined;
  };
  const setAngle = (value: number) => {
    if (!playing()) return;
    angle = Math.max(-78, Math.min(78, value)); resultTrace = undefined; render();
  };
  const resetStep = () => {
    clearTimeout(resultTimer); resultTimer = undefined; resultTrace = undefined;
    keys.clear(); fine = 0; fineInput.value = '0'; owner = null;
    passed = false; state = createPracticeState(step); angle = step === 3 ? 0 : -28;
    title.textContent = PRACTICE_STEPS[step].title;
    goal.textContent = PRACTICE_STEPS[step].goal;
    progress.textContent = `${String(step + 1).padStart(2, '0')} / 04`;
    next.textContent = step === 3 ? '完成练习 →' : '下一步 →';
    setStatus(PRACTICE_STEPS[step].hint); render();
  };
  const fire = () => {
    if (!playing()) return;
    const outcome = resolvePracticeShot(step, state, angle);
    state = outcome.state; passed = outcome.passed; resultTrace = outcome.trace;
    keys.clear(); fine = 0; fineInput.value = '0';
    setStatus(outcome.message);
    resultTimer = setTimeout(() => {
      resultTimer = undefined;
      if (disposed) return;
      if (!passed) { state = createPracticeState(step); resultTrace = undefined; }
      render();
    }, 420);
    render();
  };
  const pointerAim = (event: PointerEvent) => {
    const rect = board.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (event.clientX - rect.left) / rect.width * 640, y = (event.clientY - rect.top) / rect.height * 400;
    setAngle(Math.atan2(x - 320, Math.max(36, 344 - y)) * 180 / Math.PI);
  };
  board.addEventListener('contextmenu', event => event.preventDefault(), { signal: abort.signal });
  board.addEventListener('pointerdown', event => {
    if (options.controlMode === 'buttons' || !playing() || owner !== null || (event.button !== 0 && (options.controlMode !== 'desktop' || event.button !== 2))) return;
    event.preventDefault(); owner = event.pointerId; keys.clear();
    board.setPointerCapture(owner); pointerAim(event);
  }, { signal: abort.signal });
  board.addEventListener('pointermove', event => {
    if (options.controlMode === 'desktop' || owner === event.pointerId) pointerAim(event);
  }, { signal: abort.signal });
  const resetPointer = () => {
    const id = owner; owner = null;
    if (id !== null && board.hasPointerCapture(id)) board.releasePointerCapture(id);
  };
  board.addEventListener('pointerup', event => {
    if (owner !== event.pointerId) return;
    event.preventDefault();
    const rect = board.getBoundingClientRect(), inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    pointerAim(event); resetPointer(); if (inside) fire();
  }, { signal: abort.signal });
  for (const type of ['pointercancel', 'lostpointercapture']) board.addEventListener(type, resetPointer, { signal: abort.signal });
  fireButton.addEventListener('click', fire, { signal: abort.signal });
  next.addEventListener('click', () => {
    if (!passed || resultTimer !== undefined) return;
    if (step === PRACTICE_STEPS.length - 1) options.onComplete();
    else { step++; resetStep(); }
  }, { signal: abort.signal });
  root.querySelector('#practice-reset')!.addEventListener('click', resetStep, { signal: abort.signal });
  root.querySelector('#practice-close')!.addEventListener('click', options.onClose ?? options.onSkip, { signal: abort.signal });
  root.querySelector('#practice-skip')!.addEventListener('click', options.onSkip, { signal: abort.signal });
  const aimControl = bindSteeringControl(aimInput, { fine: false, hitArea: aimInput.closest<HTMLElement>('.steering-control')!, active: playing, onValue: setAngle });
  const fineControl = bindSteeringControl(fineInput, { fine: true, hitArea: fineInput.closest<HTMLElement>('.steering-control')!, active: playing, onValue: value => { fine = fineRotationSpeed(value, options.sensitivity ?? 100); } });
  document.addEventListener('keydown', event => {
    if (options.controlMode !== 'desktop' || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || !playing()) return;
    if ([shortcuts.left, shortcuts.right].includes(event.code)) { event.preventDefault(); keys.add(event.code); }
    else if ([shortcuts.quickLeft, shortcuts.quickRight].includes(event.code) && !event.repeat) { event.preventDefault(); setAngle(angle + (event.code === shortcuts.quickLeft ? -30 : 30)); }
    else if (event.code === shortcuts.fire && !event.repeat && !(event.target instanceof HTMLInputElement)) { event.preventDefault(); fire(); }
  }, { signal: abort.signal });
  document.addEventListener('keyup', event => keys.delete(event.code), { signal: abort.signal });
  const stopInput = () => { keys.clear(); fine = 0; fineControl.reset(); resetPointer(); };
  window.addEventListener('blur', stopInput, { signal: abort.signal });
  document.addEventListener('visibilitychange', stopInput, { signal: abort.signal });
  const tick = (time: number) => {
    if (disposed) return;
    const delta = Math.min(50, Math.max(0, time - (lastTime || time))); lastTime = time;
    const direction = Number(keys.has(shortcuts.right)) - Number(keys.has(shortcuts.left));
    if (playing() && (direction || fine)) setAngle(angle + (direction * 45 + fine) * delta / 1000);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick); resetStep();
  return () => { disposed = true; clearTimeout(resultTimer); cancelAnimationFrame(frame); stopInput(); aimControl.dispose(); fineControl.dispose(); abort.abort(); };
}
