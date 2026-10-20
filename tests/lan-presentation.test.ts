import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/game/audio', async importOriginal => ({ ...await importOriginal<typeof import('../src/game/audio')>(), gameAudio: { unlock: vi.fn(), blip: vi.fn(), setScene: vi.fn(), setPressure: vi.fn() } }));
vi.mock('../src/game/feedback', () => ({ haptic: vi.fn() }));
vi.mock('../src/game/input-mode', () => ({ usesButtonControls: () => false }));
vi.mock('../src/storage/storage', async importOriginal => {
  const original = await importOriginal<typeof import('../src/storage/storage')>();
  return { ...original, loadSettings: () => ({ ...original.DEFAULT_SETTINGS, reducedMotion: false }) };
});
import { LanPresentation } from '../src/ui/lan-presentation';
import { bindLanBoard } from '../src/ui/lan-board';
import { gameAudio, boardMusicPressure } from '../src/game/audio';
import { haptic } from '../src/game/feedback';
import { createGameState } from '../src/core/engine';
import { createMatch } from '../src/lan/authority';
import { BOARD_APPEARANCE, boardGeometry } from '../src/render/board-appearance';
import { BOARD_GEOMETRY } from '../src/content/game-config';
import { cellToPoint } from '../src/core/grid';
import type { BoardDescendedEvent, PresentationEvent, ShotResolvedEvent } from '../src/lan/presentation';
import type { GameState } from '../src/core/types';
import type { LanSession, SessionPhase } from '../src/lan/session';

function shot(eventSeq = 1, playerId = 'host'): ShotResolvedEvent {
  const initial = createGameState('normal', 42);
  const board = initial.board.map(row => row.map(() => null as number | null));
  board[0][5] = 1; board[1][5] = 1; board[1][6] = 2;
  const beforeState: GameState = { ...initial, board, currentColor: 1 };
  const afterState: GameState = { ...initial, board: board.map(row => row.map(() => null)), currentColor: 2, nextColor: 3 };
  return { type: 'shot-resolved', eventSeq, playerId, atMs: 100, beforeRevision: 0, afterRevision: 1,
    commandSeq: eventSeq, angleMilliDeg: 0, beforeState, afterState,
    trace: { points: [{ x: 100, y: 600 }, { x: 100, y: 500 }, { x: 200, y: 500 }], landing: { row: 2, col: 5 }, bounced: true, reason: 'bubble' },
    rulesEvents: [{ type: 'match', cells: [{ row: 0, col: 5 }, { row: 1, col: 5 }, { row: 2, col: 5 }], points: 30 }, { type: 'drop', cells: [{ row: 1, col: 6 }], points: 20 }],
    stages: { flightMs: 220, resolutionMs: 656, descentMs: 0, waveMs: 0 }, readyAtMs: 976 };
}
function painter() {
  const context = { save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), fillText: vi.fn(), strokeText: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), globalAlpha: 1, fillStyle: '', font: '', textAlign: '' };
  const canvas = { getContext: () => context } as unknown as HTMLCanvasElement;
  const paint = vi.fn(), orb = vi.fn(), feedback = vi.fn();
  return { canvas, context, paint, orb, feedback, presentation: new LanPresentation(paint, orb, feedback) };
}
function descent(eventSeq = 1): BoardDescendedEvent {
  const value = shot();
  return { type: 'board-descended', eventSeq, playerId: 'host', atMs: 100, beforeRevision: 0, afterRevision: 1,
    beforeState: value.beforeState, afterState: value.afterState, reason: 'attack', durationMs: 360 };
}

describe('LAN committed canvas presentation', () => {
  it('keeps V5 scatter and particles visible after the committed stage without delaying the next shot', () => {
    vi.stubGlobal('document', { documentElement: { classList: { contains: (value: string) => value === 'android-v5' } } });
    try {
      const p = painter(), event = shot();
      event.stages = { flightMs: 220, resolutionMs: 190, descentMs: 0, waveMs: 0 }; event.readyAtMs = 510;
      const before = structuredClone(event);
      p.presentation.ingest([event], 1, 100); p.presentation.advance(510, 'host');
      expect(p.presentation.hasBoardAnimationFor('host')).toBe(false);
      p.presentation.draw(p.canvas, 'host', event.afterState, 600, false, true);
      expect(p.paint.mock.calls.at(-1)![1]).toBe(event.afterState);
      expect(p.orb).toHaveBeenCalled(); expect(p.context.arc).toHaveBeenCalled();
      expect(p.context.fillText).toHaveBeenCalledWith('+50', 320, expect.any(Number));
      expect(event).toEqual(before);
      p.presentation.advance(1700, 'host'); expect(p.presentation.busyFor('host')).toBe(false);
      const reduced = painter(); reduced.presentation.ingest([event], 1, 100);
      reduced.presentation.draw(reduced.canvas, 'host', event.afterState, 600, true, true);
      expect(reduced.orb).not.toHaveBeenCalled(); expect(reduced.context.arc).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('starts match and falling balls together at impact and retains the unchanged 656 ms stage through their visual tail', () => {
    vi.stubGlobal('document', { documentElement: { classList: { contains: (value: string) => value === 'windows-v5' } } });
    try {
      const p = painter(), event = shot();
      event.rulesEvents = [
        { type: 'match', cells: [{ row: 0, col: 5 }, { row: 1, col: 5 }, { row: 2, col: 5 }] },
        { type: 'drop', cells: [{ row: 1, col: 6 }] },
      ];
      event.stages = { flightMs: 220, resolutionMs: 656, descentMs: 0, waveMs: 0 };
      event.readyAtMs = 976;
      p.presentation.ingest([event], 1, 100);

      const matchPoint = cellToPoint({ row: 0, col: 5 }, boardGeometry(event.beforeState));
      const dropPoint = cellToPoint({ row: 1, col: 6 }, boardGeometry(event.beforeState));
      p.presentation.draw(p.canvas, 'host', event.afterState, 320, false, true);
      const initialMatch = p.orb.mock.calls.find(call => call[1] === 1)!;
      const initialDrop = p.orb.mock.calls.find(call => call[1] === 2)!;
      expect(initialMatch.slice(2, 4)).toEqual([matchPoint.x, matchPoint.y]);
      expect(initialDrop.slice(2, 4)).toEqual([dropPoint.x, dropPoint.y]);

      p.presentation.draw(p.canvas, 'host', event.afterState, 336, false, true);
      const firstMatchFrame = p.orb.mock.calls.filter(call => call[1] === 1).at(-3)!;
      const firstDropFrame = p.orb.mock.calls.filter(call => call[1] === 2).at(-1)!;
      expect(firstMatchFrame[3]).toBeLessThan(matchPoint.y);
      expect(firstDropFrame[3]).toBeGreaterThan(dropPoint.y);

      expect(event.readyAtMs).toBe(976);
      p.presentation.advance(event.readyAtMs, 'host');
      expect(p.presentation.hasBoardAnimationFor('host')).toBe(false);
      expect(p.presentation.busyFor('host')).toBe(true); // Cosmetic drop tail continues after READY.
      expect(event.readyAtMs).toBe(976);
      p.presentation.advance(1369, 'host');
      expect(p.presentation.busyFor('host')).toBe(true);
      p.presentation.advance(1370, 'host');
      expect(p.presentation.busyFor('host')).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it('removes the fallback canvas drop start wait while retaining its separate legacy curve', () => {
    vi.stubGlobal('document', { documentElement: { classList: { contains: () => false } } });
    try {
      const p = painter(), event = shot();
      event.stages = { flightMs: 220, resolutionMs: 656, descentMs: 0, waveMs: 0 };
      p.presentation.ingest([event], 1, 100);
      const dropPoint = cellToPoint({ row: 1, col: 6 }, boardGeometry(event.beforeState));
      p.presentation.draw(p.canvas, 'host', event.afterState, 320, false, true);
      const atImpact = p.orb.mock.calls.find(call => call[1] === 2)!;
      expect(atImpact[3]).toBe(dropPoint.y);
      p.presentation.draw(p.canvas, 'host', event.afterState, 336, false, true);
      const nextFrame = p.orb.mock.calls.filter(call => call[1] === 2).at(-1)!;
      expect(nextFrame[3]).toBeGreaterThan(dropPoint.y);
    } finally { vi.unstubAllGlobals(); }
  });

  it('caches the transition board and removal list for all renders of a committed event', () => {
    const p = painter(), event = shot(), before = structuredClone(event.beforeState); p.presentation.ingest([event], 1, 100);
    p.presentation.draw(p.canvas, 'host', event.afterState, 450, false, true); const first = p.paint.mock.calls.at(-1)![1];
    p.presentation.draw(p.canvas, 'host', event.afterState, 500, false, true);
    expect(p.paint.mock.calls.at(-1)![1]).toBe(first); expect(event.beforeState).toEqual(before);
    expect(p.presentation.busyFor('host')).toBe(true); expect(p.presentation.busyFor('guest')).toBe(false);
  });

  it('keeps score cosmetics after a short match without extending the committed shot stage', () => {
    const p = painter(), event = shot(); event.rulesEvents = [{ type: 'match', cells: [{ row: 0, col: 5 }], points: 30 }];
    event.stages = { flightMs: 220, resolutionMs: 190, descentMs: 0, waveMs: 0 }; event.readyAtMs = 510;
    p.presentation.ingest([event], 1, 100); p.presentation.advance(510, 'host');
    expect(p.presentation.hasBoardAnimationFor('host')).toBe(false); expect(p.presentation.busyFor('host')).toBe(true); expect(p.presentation.busyFor('host', false)).toBe(false);
    p.presentation.draw(p.canvas, 'host', event.afterState, 600, false, true); expect(p.paint.mock.calls.at(-1)![1]).toBe(event.afterState);
    expect(event.readyAtMs).toBe(510); p.presentation.advance(941, 'host'); expect(p.presentation.busyFor('host')).toBe(false);
  });

  it('holds the before-board during flight and interpolates compressed bounce paths by distance', () => {
    const p = painter(), event = shot(); p.presentation.ingest([event], 1, 100);
    p.presentation.draw(p.canvas, 'host', event.afterState, 210, false, true);
    expect(p.paint.mock.calls.at(-1)?.[1]).toBe(event.beforeState);
    expect(p.orb).toHaveBeenCalledWith(p.context, 1, 100, 500, BOARD_APPEARANCE.orbRadius * BOARD_APPEARANCE.loadedScale);
    expect(p.feedback).not.toHaveBeenCalled(); expect(p.presentation.busy).toBe(true);
  });

  it('animates removal and falling from the committed cells and counts feedback once across frames and duplicate events', () => {
    const p = painter(), event = shot(); p.presentation.ingest([event], 1, 100);
    p.presentation.draw(p.canvas, 'host', event.afterState, 600, false, true);
    const painted = p.paint.mock.calls.at(-1)?.[1] as GameState;
    expect(painted.board[0][5]).toBeNull(); expect(painted.board[1][6]).toBeNull(); expect(painted.board[2][5]).toBeNull();
    expect(painted.currentColor).toBe(event.afterState.currentColor);
    const dropped = p.orb.mock.calls.find(call => call[1] === 2)!;
    expect(dropped[3]).toBeGreaterThan(cellToPoint({ row: 1, col: 6 }, { ...BOARD_GEOMETRY, rowOffset: event.beforeState.rowOffset ?? 0 }).y);
    expect(p.context.fillText.mock.calls[0][0]).toContain('+50');
    p.presentation.ingest([event], 1, 620); p.presentation.draw(p.canvas, 'host', event.afterState, 620, false, true);
    p.presentation.draw(p.canvas, 'host', event.afterState, 976, false, true);
    expect(p.feedback).toHaveBeenCalledExactlyOnceWith('drop'); expect(p.presentation.busy).toBe(false);
    expect(p.paint.mock.calls.at(-1)?.[1]).toBe(event.afterState);
  });

  it('uses reduced motion without changing presentation duration or committed state', () => {
    const p = painter(), event = shot(); p.presentation.ingest([event], 1, 100);
    p.presentation.draw(p.canvas, 'host', event.afterState, 210, true, true); expect(p.orb).not.toHaveBeenCalled();
    p.presentation.draw(p.canvas, 'host', event.afterState, 600, true, true);
    expect(p.orb).not.toHaveBeenCalled(); // Match the single-player reduced-motion instant removal.
    expect(p.presentation.busy).toBe(true); p.presentation.draw(p.canvas, 'host', event.afterState, 976, true, true);
    expect(p.presentation.busy).toBe(false); expect(p.paint.mock.calls.at(-1)?.[1]).toBe(event.afterState);
  });

  it('eases a committed attack descent and emits only one local danger cue', () => {
    const p = painter(), event = descent(); p.presentation.ingest([event], 1, 100);
    p.presentation.draw(p.canvas, 'host', event.afterState!, 100, false, true);
    expect(p.paint.mock.calls.at(-1)?.[4]).toBe(-BOARD_GEOMETRY.rowStep);
    p.presentation.draw(p.canvas, 'host', event.afterState!, 280, false, true);
    expect(p.paint.mock.calls.at(-1)?.[4]).toBeCloseTo(-BOARD_GEOMETRY.rowStep * 0.125);
    expect(p.context.fillRect).toHaveBeenCalled(); expect(p.feedback).toHaveBeenCalledExactlyOnceWith('danger');
    p.presentation.draw(p.canvas, 'host', event.afterState!, 300, true, true);
    expect(p.paint.mock.calls.at(-1)?.[4]).toBe(0);
  });

  it('never plays the opponent presentation through local sound or haptic callbacks', () => {
    const p = painter(), event = shot(1, 'guest'); p.presentation.ingest([event], 1, 100);
    p.presentation.draw(p.canvas, 'guest', event.afterState, 600, true, false);
    p.presentation.draw(p.canvas, 'guest', event.afterState, 976, true, false);
    expect(p.feedback).not.toHaveBeenCalled(); expect(p.context.fillText).not.toHaveBeenCalled();
  });

  it('snaps to current state for late events and never replays stale sound', () => {
    const p = painter(), event = shot(); p.presentation.ingest([event], 1, 2201);
    expect(p.presentation.busy).toBe(false); p.presentation.draw(p.canvas, 'host', event.afterState, 2201, false, true);
    expect(p.feedback).not.toHaveBeenCalled(); expect(p.orb).not.toHaveBeenCalled(); expect(p.paint.mock.calls.at(-1)?.[1]).toBe(event.afterState);
  });

  it('clears visual history at a recovery watermark and accepts only later events', () => {
    const p = painter(), first = shot(); p.presentation.ingest([first], 1, 100); p.presentation.reset(4);
    p.presentation.ingest([first, shot(4)], 4, 100); expect(p.presentation.busy).toBe(false);
    const next = shot(5); p.presentation.ingest([next], 5, 100); expect(p.presentation.busy).toBe(true);
    p.presentation.draw(p.canvas, 'host', next.afterState, 600, false, true); expect(p.feedback).toHaveBeenCalledOnce();
  });

  it('keeps all four players animated when STATE arrives before one presentation packet per frame', () => {
    const p = painter(), events = ['host', 'guest', 'guest2', 'guest3'].map((id, index) => shot(index * 2 + 1, id));
    // The snapshot includes omitted decorative events and reaches the renderer first.
    p.presentation.ingest([], 8, 100);
    for (const [index, event] of events.entries()) {
      p.presentation.ingest([event], 8, 120 + index * 20);
      p.presentation.draw(p.canvas, event.playerId, event.afterState, 200, false, event.playerId === 'guest3');
      expect(p.paint.mock.calls.at(-1)?.[1]).toBe(event.beforeState);
    }
    // A newer state-only packet must not clear an animation already in progress.
    p.presentation.ingest([], 12, 210);
    for (const event of events) {
      p.presentation.draw(p.canvas, event.playerId, event.afterState, 220, false, event.playerId === 'guest3');
      expect(p.paint.mock.calls.at(-1)?.[1]).toBe(event.beforeState);
    }
    p.presentation.ingest(events, 12, 600);
    for (const event of events) p.presentation.draw(p.canvas, event.playerId, event.afterState, 600, false, event.playerId === 'guest3');
    expect(p.feedback).toHaveBeenCalledExactlyOnceWith('drop');
    for (const event of events) p.presentation.draw(p.canvas, event.playerId, event.afterState, 976, false, event.playerId === 'guest3');
    expect(p.presentation.busy).toBe(false);
    expect(p.feedback).toHaveBeenCalledOnce();
  });

  it('does not let a later global sequence from one player discard another player packet', () => {
    const p = painter(), events = [shot(8, 'host'), shot(2, 'guest'), shot(5, 'guest2'), shot(3, 'guest3')];
    for (const event of events) p.presentation.ingest([event], 8, 100);
    for (const event of events) {
      p.presentation.draw(p.canvas, event.playerId, event.afterState, 200, false, false);
      expect(p.paint.mock.calls.at(-1)?.[1]).toBe(event.beforeState);
    }
    expect(p.feedback).not.toHaveBeenCalled();
  });

  it('applies an explicit recovery baseline to delayed packets from every player', () => {
    const p = painter(), before = shot(3, 'host'), delayed = shot(4, 'guest3');
    p.presentation.ingest([before], 8, 100); p.presentation.reset(8);
    p.presentation.ingest([delayed, before, shot(8, 'guest2')], 12, 120);
    expect(p.presentation.busy).toBe(false);
    for (const event of [shot(12, 'host'), shot(9, 'guest3')]) {
      p.presentation.ingest([event], 12, 140);
      p.presentation.draw(p.canvas, event.playerId, event.afterState, 200, false, false);
      expect(p.paint.mock.calls.at(-1)?.[1]).toBe(event.beforeState);
    }
  });

  it('converges a packet more than two seconds late without starving a fresh different player', () => {
    const p = painter(), late = shot(8, 'host'), fresh = { ...shot(3, 'guest'), atMs: 2200 };
    p.presentation.ingest([], 8, 2201);
    p.presentation.ingest([late], 8, 2201);
    p.presentation.ingest([fresh], 8, 2201);
    p.presentation.draw(p.canvas, late.playerId, late.afterState, 2300, false, true);
    expect(p.paint.mock.calls.at(-1)?.[1]).toBe(late.afterState);
    p.presentation.draw(p.canvas, fresh.playerId, fresh.afterState, 2300, false, false);
    expect(p.paint.mock.calls.at(-1)?.[1]).toBe(fresh.beforeState);
    expect(p.feedback).not.toHaveBeenCalled();
  });

  it('finishes pressure and next-wave stages after removal without advancing gameplay state', () => {
    const p = painter(), pressure = shot(); pressure.stages = { flightMs: 220, resolutionMs: 60, descentMs: 360, waveMs: 0 }; pressure.rulesEvents = [];
    p.presentation.ingest([pressure], 1, 100); p.presentation.draw(p.canvas, 'host', pressure.afterState, 400, false, true);
    expect(p.paint.mock.calls.at(-1)?.[1]).toBe(pressure.afterState); expect(p.paint.mock.calls.at(-1)?.[4]).toBeLessThan(0);
    expect(p.feedback).toHaveBeenCalledExactlyOnceWith('danger');
    const wave = shot(2); wave.stages = { flightMs: 220, resolutionMs: 60, descentMs: 0, waveMs: 360 }; wave.rulesEvents = [];
    p.presentation.reset(1); p.presentation.ingest([wave], 2, 100); p.presentation.draw(p.canvas, 'host', wave.afterState, 400, false, true);
    expect(p.context.fillText).toHaveBeenCalledWith('进入下一波', 320, 500);
    expect(wave.afterState).toEqual(shot().afterState);
  });
});

class BoardElement extends EventTarget {
  value = '0'; disabled = false; hidden = false; textContent = ''; width = 640; height = 760;
  children = new Map<string, BoardElement>();
  context = new Proxy({}, { get: () => vi.fn(), set: () => true });
  getBoundingClientRect() { return { left: 0, top: 0, right: 320, bottom: 380, width: 320, height: 380 }; }
  getContext() { return this.context; }
  hasPointerCapture() { return false; }
  closest() { return null; }
  matches() { return false; }
  querySelector(selector: string) { return this.children.get(selector) ?? null; }
}
const disposals: Array<() => void> = [];
function boundBoard(playerIds = ['host', 'guest'], selfId = 'host') {
  const root = new BoardElement();
  for (const key of ['lan-self-board', 'lan-other-board', 'lan-angle', 'lan-fine', 'lan-fire', 'lan-turn-left', 'lan-turn-right', 'lan-angle-value']) root.children.set(`#${key}`, new BoardElement());
  const listeners = new Set<() => void>(); let activeMs = 0, frameMs = 0, nextFrame: FrameRequestCallback | undefined;
  const session = { view: { selfId, phase: 'playing' as SessionPhase, pendingShot: false, presentationEvents: [] as PresentationEvent[],
    snapshot: createMatch({ matchId: 'audio-binding', difficultyId: 'normal', durationMs: 180000, seed: 42, playerIds }) },
    displayElapsed: () => activeMs, presentationTime: () => activeMs, shoot: vi.fn(), subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); } };
  const document = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', document); vi.stubGlobal('performance', { now: () => frameMs });
  vi.stubGlobal('devicePixelRatio', 1); vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn()); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const dispose = bindLanBoard(root as unknown as HTMLElement, session as unknown as LanSession); disposals.push(dispose);
  return { root, session, document, dispose, notify: () => listeners.forEach(listener => listener()), frame: (logicalMs: number) => { activeMs = logicalMs; frameMs += 20; nextFrame?.(frameMs); } };
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.unstubAllGlobals(); });

describe('LAN board sound and background music binding', () => {
  it('plays the last seat removal when a four-player STATE and routed packets span separate RAFs', () => {
    const ids = ['host', 'guest', 'guest2', 'guest3'], game = boundBoard(ids, 'guest3');
    game.session.view.snapshot.eventSeq = 8;
    game.notify(); game.frame(100);
    for (const [index, playerId] of ids.entries()) {
      const event = shot(index * 2 + 1, playerId);
      game.session.view.snapshot.players[playerId].state = event.afterState;
      game.session.view.presentationEvents.push(event);
      game.notify(); game.frame(140 + index * 20);
    }
    expect(gameAudio.blip).not.toHaveBeenCalled();
    game.frame(600); game.frame(620); game.notify(); game.frame(640);
    expect(gameAudio.blip).toHaveBeenCalledExactlyOnceWith('drop');
    expect(haptic).toHaveBeenCalledExactlyOnceWith('match', expect.any(Object));
    game.session.view.phase = 'reconnecting'; game.notify(); game.frame(660);
    game.session.view.phase = 'countdown'; game.notify(); game.frame(680);
    game.session.view.phase = 'playing'; game.notify(); game.frame(700);
    expect(gameAudio.blip).toHaveBeenCalledOnce();
  });

  it('plays committed local removal feedback once and keeps rival events silent', () => {
    const game = boundBoard(), local = shot(), rival = shot(2, 'guest');
    game.session.view.snapshot.eventSeq = 2; game.session.view.presentationEvents = [local, rival];
    game.frame(600); game.frame(620); game.notify(); game.frame(640);
    expect(gameAudio.blip).toHaveBeenCalledExactlyOnceWith('drop'); expect(haptic).toHaveBeenCalledExactlyOnceWith('match', expect.any(Object));
  });

  it('uses only the local board height for adaptive music pressure', () => {
    const game = boundBoard(), local = game.session.view.snapshot.players.host.state, rival = game.session.view.snapshot.players.guest.state;
    rival.board[17][0] = 1; game.frame(0);
    expect(gameAudio.setScene).toHaveBeenLastCalledWith('play'); expect(gameAudio.setPressure).toHaveBeenLastCalledWith(boardMusicPressure(local.board));
    local.board = local.board.map(row => [...row]); local.board[17][0] = 1; game.frame(50); expect(gameAudio.setPressure).toHaveBeenLastCalledWith(1);
  });

  it.each(['countdown', 'paused', 'reconnecting', 'finished'] as const)('uses quiet music pressure in %s and restores it on play', phase => {
    const game = boundBoard(); game.session.view.snapshot.players.host.state.board[17][0] = 1; game.frame(0);
    game.session.view.phase = phase; game.notify(); game.frame(50);
    expect(gameAudio.setScene).toHaveBeenLastCalledWith('menu'); expect(gameAudio.setPressure).toHaveBeenLastCalledWith(0);
    game.session.view.phase = 'playing'; game.notify(); game.frame(100);
    expect(gameAudio.setScene).toHaveBeenLastCalledWith('play'); expect(gameAudio.setPressure).toHaveBeenLastCalledWith(1);
  });

  it('clears sound history on recovery without replaying already committed effects', () => {
    const game = boundBoard(); game.session.view.snapshot.eventSeq = 1; game.session.view.presentationEvents = [shot()]; game.frame(600);
    game.session.view.phase = 'reconnecting'; game.notify(); game.frame(620);
    game.session.view.phase = 'countdown'; game.notify(); game.frame(640);
    game.session.view.phase = 'playing'; game.notify(); game.frame(660);
    expect(gameAudio.blip).toHaveBeenCalledExactlyOnceWith('drop');
  });

  it('returns sealed boards and disposed bindings to neutral music state', () => {
    const game = boundBoard(); game.session.view.snapshot.players.host.sealed = true; game.frame(0);
    expect(gameAudio.setScene).toHaveBeenLastCalledWith('menu'); expect(gameAudio.setPressure).toHaveBeenLastCalledWith(0);
    game.dispose(); expect(gameAudio.setScene).toHaveBeenLastCalledWith('menu'); expect(gameAudio.setPressure).toHaveBeenLastCalledWith(0);
  });
});
