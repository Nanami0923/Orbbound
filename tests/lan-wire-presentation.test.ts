import { describe, expect, it } from 'vitest';
import { createMatch, advanceWithEvents } from '../src/lan/authority';
import { applyBattleBatch } from '../src/lan/battle';
import { isMatchSnapshot } from '../src/lan/protocol';
import { compressTrace, isPresentationEvent, pointOnTrace } from '../src/lan/presentation';

describe('bounded LAN presentation wire', () => {
  it('keeps two simultaneous large clears and the snapshot within one native 64 KiB frame', () => {
    const snapshot = createMatch({ mode: 'battle', matchId: 'max-payload', difficultyId: 'normal', durationMs: 180000, seed: 17, playerIds: ['host', 'guest'] });
    for (const id of snapshot.playerIds) { const player = snapshot.players[id]; player.state = { ...player.state,
      board: Array.from({ length: 19 }, (_, row) => Array(14).fill(row < 17 ? 0 : null)), currentColor: 0, nextColor: 0 }; }
    const outcome = applyBattleBatch(snapshot, snapshot.playerIds.map(playerId => ({ playerId, seq: 1, boardRevision: 0, angleMilliDeg: 0 })), 0);
    expect(outcome.outcomes.every(item => item.accepted)).toBe(true);
    expect(outcome.presentationEvents.every(isPresentationEvent)).toBe(true); expect(isMatchSnapshot(outcome.snapshot)).toBe(true);
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 2, type: 'STATE', roomId: 'room-max', matchId: snapshot.matchId,
      data: { snapshot: outcome.snapshot, events: outcome.presentationEvents, serverSeq: 1, epoch: 1 } }));
    expect(bytes.length).toBeLessThanOrEqual(65536);
    expect(outcome.presentationEvents.filter(e => e.type === 'shot-resolved')).toHaveLength(2);
  });
  it('bounds a full score catch-up payload and preserves its true event watermark', () => {
    const snapshot = createMatch({ matchId: 'catch-up', difficultyId: 'hard', durationMs: 180000, seed: 1, playerIds: ['host', 'guest'] });
    const update = advanceWithEvents(snapshot, 179999);
    expect(update.presentationEvents.length).toBeLessThanOrEqual(32);
    expect(update.presentationEvents.every(isPresentationEvent)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify({ snapshot: update.snapshot, events: update.presentationEvents })).length).toBeLessThan(65536);
  });
  it('preserves bounces when compressing and clamps a prediction sampled before its start', () => {
    const trace = compressTrace({ points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 3 }, { x: 0, y: 4 }], landing: null, bounced: true, reason: 'bubble' });
    expect(trace.points).toEqual([{ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 4 }]);
    expect(pointOnTrace(trace, -.01)).toEqual({ x: 0, y: 0 });
    expect(pointOnTrace(trace, 2)).toEqual({ x: 0, y: 4 });
  });
});
