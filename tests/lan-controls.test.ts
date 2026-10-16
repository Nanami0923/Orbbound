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

class ElementStub extends EventTarget {
  value = '0'; disabled = false; hidden = false; textContent = ''; width = 640; height = 760; owner: number | null = null;
  rect = { left: 10, top: 20, right: 330, bottom: 400, width: 320, height: 380 };
  children = new Map<string, ElementStub>();
  context = new Proxy({ setTransform: vi.fn() }, { get: (target, key) => key in target ? target[key as keyof typeof target] : vi.fn(), set: () => true });
  getBoundingClientRect() { return this.rect; }
  getContext() { return this.context; }
  setPointerCapture(id: number) { this.owner = id; }
  hasPointerCapture(id: number) { return this.owner === id; }
  releasePointerCapture() { this.owner = null; }
  closest(selector: string) { return selector === '[hidden]' && this.hidden ? this : null; }
  matches() { return false; }
  querySelector(selector: string) { return this.children.get(selector) ?? null; }
}

const send = (target: EventTarget, type: string, values: Record<string, unknown> = {}) => {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: 1, clientX: 210, clientY: 250, button: 0, detail: 1 }, values);
  target.dispatchEvent(event); return event;
};
const disposals: Array<() => void> = [];

function setup() {
  const root = new ElementStub();
  for (const key of ['lan-self-board', 'lan-other-board', 'lan-angle', 'lan-fine', 'lan-fire', 'lan-turn-left', 'lan-turn-right', 'lan-angle-value']) root.children.set(`#${key}`, new ElementStub());
  const board = root.children.get('#lan-self-board')!, fire = root.children.get('#lan-fire')!, slider = root.children.get('#lan-angle')!, fine = root.children.get('#lan-fine')!;
  const windowEvents = new EventTarget(), documentEvents = Object.assign(new EventTarget(), { hidden: false });
  let clock = 0, renderClock = 0, nextFrame: FrameRequestCallback | undefined;
  const listeners = new Set<() => void>();
  const session = {
    view: { selfId: 'host', phase: 'playing', pendingShot: false, snapshot: createMatch({ matchId: 'controls', difficultyId: 'normal', durationMs: 180000, seed: 42, playerIds: ['host', 'guest'] }) },
    displayElapsed: () => clock,
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
    frame: (value: number) => { renderClock = value; nextFrame?.(value); },
  };
}

beforeEach(() => { options.touch = true; options.immersive = true; options.reducedMotion = false; });
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('LAN actual control event lifecycle', () => {
  it('applies quality now and releases the old immersive gesture when settings change', () => {
    const { board, session } = setup();
    send(board, 'pointerdown'); expect(board.owner).toBe(1);
    updateSettings({ immersiveMode: false, quality: 1 }, { persist: false });
    expect(board.owner).toBeNull(); expect(board.width).toBe(320);
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
    expect(board.width).toBe(640); expect(board.height).toBe(760);
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
