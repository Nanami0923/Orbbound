import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const options = vi.hoisted(() => ({ touch: true, immersive: true, reducedMotion: false }));
vi.mock('../src/game/input-mode', () => ({ usesButtonControls: () => options.touch }));
vi.mock('../src/game/audio', async importOriginal => ({ ...await importOriginal<typeof import('../src/game/audio')>(), gameAudio: { unlock: vi.fn(), blip: vi.fn(), setScene: vi.fn(), setPressure: vi.fn(), setMix: vi.fn(), setAdaptiveMusic: vi.fn() } }));
vi.mock('../src/game/feedback', () => ({ haptic: vi.fn() }));
vi.mock('../src/storage/storage', async importOriginal => {
  const original = await importOriginal<typeof import('../src/storage/storage')>();
  return { ...original, loadSettings: () => ({ ...original.DEFAULT_SETTINGS, immersiveMode: options.immersive, reducedMotion: options.reducedMotion }) };
});
import { bindLanBoard } from '../src/ui/lan-board';
import { formatLanDuration } from '../src/ui/lan-panel';
import { applyShot, createMatch } from '../src/lan/authority';
import type { LanSession } from '../src/lan/session';
import { updateSettings } from '../src/storage/settings-store';
import type { PresentationEvent, ShotResolvedEvent } from '../src/lan/presentation';
import { getOrbTheme } from '../src/content/theme';

class ElementStub extends EventTarget {
  value = '0'; disabled = false; hidden = false; textContent = ''; width = 640; height = 760; owner: number | null = null;
  rect = { left: 10, top: 20, right: 330, bottom: 400, width: 320, height: 380 };
  children = new Map<string, ElementStub>();
  dataset: Record<string, string> = {};
  context = new Proxy({ setTransform: vi.fn() }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(), set: () => true });
  getBoundingClientRect() { return this.rect; }
  getContext() { return this.context; }
  setPointerCapture(id: number) { this.owner = id; }
  hasPointerCapture(id: number) { return this.owner === id; }
  releasePointerCapture() { this.owner = null; }
  closest(selector: string) { return selector === '[hidden]' && this.hidden ? this : null; }
  matches() { return false; }
  querySelector(selector: string) { return this.children.get(selector) ?? null; }
  querySelectorAll(selector: string) { return selector === '[data-lan-player-board]' ? [...this.children].filter(([key]) => key.startsWith('opponent:')).map(([, element]) => element) : []; }
}

const send = (target: EventTarget, type: string, values: Record<string, unknown> = {}) => {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: 1, clientX: 210, clientY: 250, button: 0, detail: 1 }, values);
  target.dispatchEvent(event); return event;
};
const disposals: Array<() => void> = [];

function setup(playerIds = ['host', 'guest']) {
  const root = new ElementStub();
  for (const key of ['lan-self-board', 'lan-other-board', 'lan-angle', 'lan-fine', 'lan-fire', 'lan-turn-left', 'lan-turn-right', 'lan-angle-value']) root.children.set(`#${key}`, new ElementStub());
  const board = root.children.get('#lan-self-board')!, fire = root.children.get('#lan-fire')!, slider = root.children.get('#lan-angle')!, fine = root.children.get('#lan-fine')!;
  const windowEvents = new EventTarget(), documentEvents = Object.assign(new EventTarget(), { hidden: false });
  let clock = 0, renderClock = 0, presentationClock = 0, nextFrame: FrameRequestCallback | undefined;
  const listeners = new Set<() => void>();
  const session = {
    view: { selfId: 'host', phase: 'playing', pendingShot: false, presentationEvents: [] as PresentationEvent[], snapshot: createMatch({ matchId: 'controls', difficultyId: 'normal', durationMs: 180000, seed: 42, playerIds }) },
    displayElapsed: () => clock, presentationTime: () => presentationClock,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    shoot: vi.fn((angleMilliDeg: number) => {
      const player = session.view.snapshot.players.host;
      session.view.snapshot = applyShot(session.view.snapshot, { playerId: 'host', seq: player.lastSeq + 1, boardRevision: player.boardRevision, angleMilliDeg }, clock).snapshot;
      listeners.forEach(listener => listener());
    }),
  };
  vi.stubGlobal('window', windowEvents); vi.stubGlobal('document', documentEvents);
  vi.stubGlobal('performance', { now: () => renderClock }); vi.stubGlobal('devicePixelRatio', 3);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const dispose = bindLanBoard(root as unknown as HTMLElement, session as unknown as LanSession); disposals.push(dispose);
  return { root, board, fire, slider, fine, session, windowEvents, documentEvents, dispose,
    activeTime: (value: number) => { clock = value; },
    wallTime: (value: number) => { renderClock = value; },
    notify: () => listeners.forEach(listener => listener()),
    frame: (value: number) => { renderClock = value; if (['playing', 'finished'].includes(session.view.phase)) presentationClock = value; nextFrame?.(value); },
  };
}

beforeEach(() => { options.touch = true; options.immersive = true; options.reducedMotion = false; });
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function visualShot(game: ReturnType<typeof setup>, playerId: string): ShotResolvedEvent {
  const player = game.session.view.snapshot.players[playerId], beforeState = player.state, board = beforeState.board.map(row => [...row]);
  board[0][0] = null;
  return { type: 'shot-resolved', eventSeq: 1, playerId, atMs: 0, commandSeq: 1, angleMilliDeg: 0, beforeRevision: 0, afterRevision: 1,
    beforeState, afterState: { ...beforeState, board }, trace: { points: [{ x: 320, y: 680 }, { x: 320, y: 100 }], landing: { row: 0, col: 0 }, bounced: false, reason: 'bubble' },
    rulesEvents: [], stages: { flightMs: 920, resolutionMs: 60, descentMs: 0, waveMs: 0 }, readyAtMs: 980 };
}

function commitVisual(game: ReturnType<typeof setup>, playerId: string) {
  const event = visualShot(game, playerId); game.session.view.snapshot.eventSeq = 1; game.session.view.presentationEvents = [event];
  const player = game.session.view.snapshot.players[playerId]; player.state = event.afterState; player.boardRevision = 1; game.notify(); return event;
}

function nextPreview(game: ReturnType<typeof setup>) {
  const preview = Object.assign(new ElementStub(), { style: { backgroundColor: '', setProperty: vi.fn() } });
  game.root.children.set('#lan-next-orb-preview', preview); return preview;
}

describe('LAN next-orb presentation preview', () => {
  it('keeps the original next orb during local prediction and advances when the canvas catches up', () => {
    const game = setup(), preview = nextPreview(game), player = game.session.view.snapshot.players.host;
    player.state = { ...player.state, currentColor: 0, nextColor: 1 }; game.frame(0);
    send(game.fire, 'pointerdown');
    game.session.view.snapshot.players.host.state.nextColor = 2;
    game.frame(20); expect(preview.dataset.colorId).toBe('1');
    expect(preview.dataset.symbol).toBe(getOrbTheme(1).symbol);
    expect(preview.style.backgroundColor).toBe(getOrbTheme(1).cssColor);
    expect(preview.style.setProperty).toHaveBeenCalledExactlyOnceWith('--orb-ink', getOrbTheme(1).ink);
    game.frame(1000); expect(preview.dataset.colorId).toBe('2');
  });

  it('uses the authoritative flight state and advances together with its resolution state', () => {
    const game = setup(), preview = nextPreview(game), player = game.session.view.snapshot.players.host;
    player.state = { ...player.state, currentColor: 0, nextColor: 1 };
    const event = commitVisual(game, 'host'); event.afterState.currentColor = 1; event.afterState.nextColor = 2;
    game.frame(100); expect(preview.dataset.colorId).toBe('1');
    game.frame(930); expect(preview.dataset.colorId).toBe('2');
  });

  it('follows the player drawn in the main canvas during observation without taking other canvases previews', () => {
    const game = setup(['host', 'guest', 'guest2']), preview = nextPreview(game), players = game.session.view.snapshot.players;
    players.host.sealed = true; players.host.state.nextColor = 0;
    players.guest.state = { ...players.guest.state, currentColor: 1, nextColor: 2 }; players.guest2.state.nextColor = 4;
    game.root.dataset.watchPlayer = 'guest';
    const observation = new ElementStub(); observation.dataset.lanObservePlayer = 'guest2'; game.root.children.set('#lan-observe-board', observation);
    const event = commitVisual(game, 'guest'); event.afterState.currentColor = 2; event.afterState.nextColor = 3;
    game.frame(100); expect(preview.dataset.colorId).toBe('2');
    game.frame(930); expect(preview.dataset.colorId).toBe('3');
    game.root.dataset.watchPlayer = 'guest2'; game.frame(950); expect(preview.dataset.colorId).toBe('4');
  });

  it('renders when the next-orb DOM preview is absent', () => {
    const game = setup(); commitVisual(game, 'host');
    expect(() => { game.frame(100); game.frame(930); }).not.toThrow();
    expect(game.board.context.setTransform).toHaveBeenCalledTimes(2);
  });
});

describe('LAN actual control event lifecycle', () => {
  it('leaves static main and thumbnail canvases untouched after the first paint', () => {
    const game = setup(), other = game.root.children.get('#lan-other-board')!;
    game.frame(0); const main = game.board.context.setTransform.mock.calls.length, thumbnail = other.context.setTransform.mock.calls.length;
    for (let at = 20; at <= 1000; at += 20) game.frame(at);
    expect(game.board.context.setTransform.mock.calls.length).toBe(main); expect(other.context.setTransform.mock.calls.length).toBe(thumbnail);
  });

  it('does not repaint the local or unrelated player boards for one rival animation', () => {
    const game = setup(['host', 'guest', 'guest2', 'guest3']), rivals: ElementStub[] = [];
    for (const id of ['guest', 'guest2', 'guest3']) { const target = new ElementStub(); target.dataset.lanPlayerBoard = id; game.root.children.set(`opponent:${id}`, target); rivals.push(target); }
    game.frame(0); commitVisual(game, 'guest');
    for (let at = 20; at <= 300; at += 20) game.frame(at);
    expect(game.board.context.setTransform).toHaveBeenCalledOnce(); expect(rivals[1].context.setTransform).toHaveBeenCalledOnce(); expect(rivals[2].context.setTransform).toHaveBeenCalledOnce();
    expect(rivals[0].context.setTransform.mock.calls.length).toBeGreaterThan(3); expect(rivals[0].context.setTransform.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('paints a paused animation once and keeps the frozen frame without continuous redraw', () => {
    const game = setup(); commitVisual(game, 'host'); game.frame(0); game.frame(100);
    game.session.view.phase = 'paused'; game.notify(); game.frame(120);
    const frozen = game.board.context.setTransform.mock.calls.length;
    for (let at = 140; at <= 1000; at += 20) game.frame(at);
    expect(game.board.context.setTransform.mock.calls.length).toBe(frozen);
  });

  it('honors 30 FPS under 120 Hz RAF with sparse pointer dirtiness between frames', () => {
    options.touch = false;
    const game = setup(); updateSettings({ frameRate: 30, quality: 1 }, { persist: false }); game.frame(0);
    for (let index = 1; index <= 120; index++) {
      if (index % 2 === 0) send(game.board, 'pointermove', { clientX: 150 + index % 40, clientY: 120 });
      game.frame(index * 1000 / 120);
    }
    expect(game.board.context.setTransform.mock.calls.length).toBeGreaterThanOrEqual(28);
    expect(game.board.context.setTransform.mock.calls.length).toBeLessThanOrEqual(32);
  });

  it('renders a dynamically opened observation at 60 FPS while keeping the thumbnail at 20 FPS', () => {
    const game = setup(), observation = new ElementStub(), other = game.root.children.get('#lan-other-board')!;
    observation.dataset.lanObservePlayer = 'guest'; game.root.children.set('#lan-observe-board', observation); game.root.children.set('.lan-confirm', new ElementStub());
    updateSettings({ frameRate: 60, quality: 1 }, { persist: false }); commitVisual(game, 'guest'); game.frame(0);
    for (let index = 1; index <= 120; index++) game.frame(index * 1000 / 120);
    expect(observation.context.setTransform.mock.calls.length).toBeGreaterThanOrEqual(55); expect(observation.context.setTransform.mock.calls.length).toBeLessThanOrEqual(62);
    expect(other.context.setTransform.mock.calls.length).toBeLessThanOrEqual(22); expect(game.board.context.setTransform).toHaveBeenCalledOnce();
    game.root.children.delete('#lan-observe-board'); game.frame(1020); expect(() => game.dispose()).not.toThrow();
  });

  it('never opens the authoritative fire gate when only presentation time advances', () => {
    const game = setup(); send(game.fire, 'pointerdown'); game.frame(1000); send(game.fire, 'pointerdown', { pointerId: 2 });
    expect(game.session.shoot).toHaveBeenCalledOnce();
  });

  it('keeps an active aim and canvas allocation while dragging audio settings', () => {
    const { board, session } = setup();
    updateSettings({ immersiveMode: true, quality: 'auto', frameRate: 60 }, { persist: false });
    let backingWidth = board.width, backingHeight = board.height, allocations = 0;
    Object.defineProperty(board, 'width', { configurable: true, get: () => backingWidth, set: value => { backingWidth = value; allocations++; } });
    Object.defineProperty(board, 'height', { configurable: true, get: () => backingHeight, set: value => { backingHeight = value; allocations++; } });
    send(board, 'pointerdown');
    for (let volume = 0; volume <= 100; volume++) updateSettings({ volume, musicVolume: 100 - volume }, { persist: false });
    expect(allocations).toBe(0); expect(board.owner).toBe(1);
    send(board, 'pointerup'); expect(session.shoot).toHaveBeenCalledOnce();
  });
  it('applies quality now and releases the old immersive gesture when settings change', () => {
    const { board, session } = setup();
    send(board, 'pointerdown'); expect(board.owner).toBe(1);
    updateSettings({ immersiveMode: false, quality: 1 }, { persist: false });
    expect(board.owner).toBeNull(); expect(board.width).toBe(640);
    send(board, 'pointerup'); expect(session.shoot).not.toHaveBeenCalled();
  });

  it('reports LAN rendering performance independently from a hidden single-player scene', () => {
    const { windowEvents, frame } = setup();
    const reports: Array<{ source: string; targetFps: number; renderFps: number }> = [];
    windowEvents.addEventListener('snood-performance', event => reports.push((event as CustomEvent).detail));
    updateSettings({ frameRate: 60 }, { persist: false }); frame(1); frame(1010);
    expect(reports).toHaveLength(1); expect(reports[0].source).toBe('lan');
    expect(reports[0].targetFps).toBe(60); expect(reports[0].renderFps).toBeGreaterThanOrEqual(0);
  });
  it('clamps prediction when a sampled RAF timestamp precedes the pointer event clock', () => {
    const game = setup(); game.frame(900); game.wallTime(1000);
    send(game.fire, 'pointerdown');
    expect(() => game.frame(990)).not.toThrow();
  });
  it('scales the backing canvas with DPR while retaining CSS-space aim coordinates', () => {
    options.touch = false;
    const { board, session } = setup();
    expect(board.width).toBe(960); expect(board.height).toBe(1140);
    send(board, 'pointerdown', { clientX: 170, clientY: 100 });
    expect(session.shoot).not.toHaveBeenCalled();
    send(board, 'pointerup', { clientX: 170, clientY: 100 });
    expect(session.shoot).toHaveBeenCalledWith(0);
  });

  it('uses either desktop mouse button on release and cancels an outside release', () => {
    options.touch = false;
    const { board, session } = setup();
    send(board, 'pointerdown', { button: 2 });
    expect(session.shoot).not.toHaveBeenCalled();
    send(board, 'pointerup', { button: 2, clientX: 500 });
    expect(session.shoot).not.toHaveBeenCalled();
    send(board, 'pointerdown', { button: 2 }); send(board, 'pointerup', { button: 2 });
    expect(session.shoot).toHaveBeenCalledOnce();
  });

  it('keeps regular touch play on controls without aiming or firing from board touches', () => {
    options.immersive = false;
    const { board, session, slider } = setup();
    send(board, 'pointerdown'); send(board, 'pointermove'); send(board, 'pointerup');
    expect(session.shoot).not.toHaveBeenCalled(); expect(slider.value).toBe('0');
  });

  it('owns one immersive finger and fires only once on its release', () => {
    const { board, session } = setup();
    send(board, 'pointerdown'); send(board, 'pointerdown', { pointerId: 2 });
    send(board, 'pointerup', { pointerId: 2 });
    expect(board.owner).toBe(1); expect(session.shoot).not.toHaveBeenCalled();
    send(board, 'pointerup'); send(board, 'pointerup');
    expect(session.shoot).toHaveBeenCalledOnce(); expect(board.owner).toBeNull();
  });

  it.each(['pointercancel', 'lostpointercapture'])('does not fire a canceled touch after %s', type => {
    const { board, session } = setup();
    send(board, 'pointerdown'); send(board, type); send(board, 'pointerup');
    expect(session.shoot).not.toHaveBeenCalled();
  });

  it('cancels release outside the board and retains upward aim below the launcher', () => {
    const { board, session, slider } = setup();
    send(board, 'pointerdown', { clientX: 170, clientY: 399 });
    expect(Number(slider.value)).toBe(0);
    send(board, 'pointerup', { clientX: 500 });
    expect(session.shoot).not.toHaveBeenCalled();
  });

  it('uses authoritative cooldown even if the previous animation has not received a render frame', () => {
    const { fire, session, activeTime } = setup();
    send(fire, 'pointerdown');
    expect(session.shoot).toHaveBeenCalledOnce();
    activeTime(session.view.snapshot.players.host.readyAtMs);
    // Rendering remains at time zero; the visual prediction still exists.
    send(fire, 'pointerdown', { pointerId: 2 });
    expect(session.shoot).toHaveBeenCalledTimes(2);
    expect(session.view.snapshot.players.host.totalShots).toBe(2);
    send(fire, 'click'); expect(session.shoot).toHaveBeenCalledTimes(2);
  });

  it('accepts a second-finger fire while steering and stops fine steering on cancel', () => {
    const { fine, fire, frame, session } = setup();
    send(fine, 'pointerdown', { clientX: 320 });
    expect(Number(fine.value)).toBeGreaterThan(0);
    frame(0); frame(100);
    send(fire, 'pointerdown', { pointerId: 2 });
    expect(session.shoot).toHaveBeenCalledOnce();
    send(fine, 'pointerup', { pointerId: 2 }); expect(Number(fine.value)).toBeGreaterThan(0);
    send(fine, 'pointercancel'); expect(fine.value).toBe('0');
  });

  it('buffers an early immersive release once and cancels it when a leave dialog opens', () => {
    const { board, fire, session, activeTime, frame, root } = setup();
    send(fire, 'pointerdown'); send(board, 'pointerdown'); send(board, 'pointerup');
    expect(session.shoot).toHaveBeenCalledOnce();
    root.children.set('.lan-confirm', new ElementStub()); frame(100);
    root.children.delete('.lan-confirm'); activeTime(session.view.snapshot.players.host.readyAtMs); frame(500);
    expect(session.shoot).toHaveBeenCalledOnce();
  });

  it('fires one buffered release once authoritative cooldown ends', () => {
    const { board, fire, session, activeTime, frame } = setup();
    send(fire, 'pointerdown'); send(board, 'pointerdown'); send(board, 'pointerup');
    frame(100); expect(session.shoot).toHaveBeenCalledOnce();
    activeTime(session.view.snapshot.players.host.readyAtMs); frame(900); frame(1000);
    expect(session.shoot).toHaveBeenCalledTimes(2);
  });

  it('blocks a new local prediction at the match deadline before the next host tick', () => {
    const { fire, session, activeTime } = setup();
    activeTime(180000); send(fire, 'pointerdown');
    expect(session.shoot).not.toHaveBeenCalled();
  });

  it('blocks shortcuts behind the leave dialog and cancels held steering on pause', () => {
    const { root, session, windowEvents, frame, slider, notify } = setup();
    root.children.set('.lan-confirm', new ElementStub());
    send(windowEvents, 'keydown', { code: 'Space' }); expect(session.shoot).not.toHaveBeenCalled();
    root.children.delete('.lan-confirm'); send(windowEvents, 'keydown', { code: 'ArrowRight' }); frame(0); frame(100);
    const angle = slider.value; session.view.phase = 'paused'; notify(); frame(200);
    session.view.phase = 'playing'; notify(); frame(300);
    expect(slider.value).toBe(angle);
  });

  it('removes input handlers when leaving the board', () => {
    const { board, fire, session, dispose } = setup();
    dispose(); send(board, 'pointerdown'); send(board, 'pointerup'); send(fire, 'pointerdown');
    expect(session.shoot).not.toHaveBeenCalled();
  });
});

describe('LAN countdown display', () => {
  it('rounds the whole time before splitting minutes and seconds', () => {
    expect([180000, 179999, 120001, 120000, 119999, 59999, 1, 0].map(formatLanDuration))
      .toEqual(['3:00', '3:00', '2:01', '2:00', '2:00', '1:00', '0:01', '0:00']);
  });
});
