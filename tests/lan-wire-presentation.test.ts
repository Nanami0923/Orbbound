import { describe, expect, it } from 'vitest';
import { createMatch, advanceWithEvents } from '../src/lan/authority';
import { applyBattleBatch } from '../src/lan/battle';
import { isMatchSnapshot } from '../src/lan/protocol';
import { compressTrace, isPresentationEvent, isPresentationEvents, LAN_MESSAGE_TARGET_BYTES, partitionPresentationEvents, pointOnTrace, utf8JsonBytes } from '../src/lan/presentation';

describe('bounded LAN presentation wire', () => {
  it.each([2, 3, 4])('keeps %i simultaneous large clears and the snapshot within one native 64 KiB frame', count => {
    const snapshot = createMatch({ mode: 'battle', matchId: 'max-payload', difficultyId: 'normal', durationMs: 180000, seed: 17, playerIds: ['host', 'guest', 'third', 'fourth'].slice(0, count) });
    for (const id of snapshot.playerIds) { const player = snapshot.players[id]; player.state = { ...player.state,
      board: Array.from({ length: 19 }, (_, row) => Array(14).fill(row < 17 ? 0 : null)), currentColor: 0, nextColor: 0 }; }
    const outcome = applyBattleBatch(snapshot, snapshot.playerIds.map(playerId => ({ playerId, seq: 1, boardRevision: 0, angleMilliDeg: 0 })), 0);
    expect(outcome.outcomes.every(item => item.accepted)).toBe(true);
    expect(outcome.presentationEvents.every(isPresentationEvent)).toBe(true); expect(isMatchSnapshot(outcome.snapshot)).toBe(true);
    const bytes = new TextEncoder().encode(JSON.stringify({ v: 3, type: 'STATE', roomId: 'room-max', matchId: snapshot.matchId,
      data: { snapshot: outcome.snapshot, events: outcome.presentationEvents, serverSeq: 1, epoch: 1 } }));
    expect(bytes.length).toBeLessThanOrEqual(65536);
    expect(outcome.presentationEvents.filter(e => e.type === 'shot-resolved')).toHaveLength(count);
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
  it('splits by complete UTF-8 envelope bytes while preserving every player and global event order', () => {
    const snapshot = createMatch({ mode: 'battle', matchId: 'split-payload', difficultyId: 'normal', durationMs: 180000, seed: 17, playerIds: ['one', 'two', 'three', 'four'] });
    for (const id of snapshot.playerIds) {
      const player = snapshot.players[id];
      player.state = { ...player.state, board: Array.from({ length: 19 }, (_, row) => Array(14).fill(row < 17 ? 0 : null)), currentColor: 0, nextColor: 0 };
    }
    const outcome = applyBattleBatch(snapshot, snapshot.playerIds.map(playerId => ({ playerId, seq: 1, boardRevision: 0, angleMilliDeg: 0 })), 0);
    const names = Object.fromEntries(snapshot.playerIds.map(id => [id, '中文🙂'.repeat(5)]));
    const envelope = (events: typeof outcome.presentationEvents) => ({ v: 3, type: 'PRESENTATION', names, data: { events } });
    // A deliberately small budget forces multiple frames, as a congested sender may choose.
    const batches = partitionPresentationEvents(outcome.presentationEvents, envelope, 16000);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat()).toEqual(outcome.presentationEvents);
    expect(new Set(batches.flat().filter(event => event.type === 'shot-resolved').map(event => event.playerId)).size).toBe(4);
    for (const batch of batches) { expect(isPresentationEvents(batch)).toBe(true); expect(utf8JsonBytes(envelope(batch))).toBeLessThanOrEqual(16000); }
    expect(utf8JsonBytes(envelope([]))).toBeGreaterThan(JSON.stringify(envelope([])).length);
    expect(LAN_MESSAGE_TARGET_BYTES).toBeLessThan(65536);
    expect(() => partitionPresentationEvents(outcome.presentationEvents, envelope, 100)).toThrow();
  });
  it('accepts routed per-player sequence gaps but rejects replayed and reversed events', () => {
    const snapshot = createMatch({ mode: 'battle', matchId: 'route-events', difficultyId: 'normal', durationMs: 180000, seed: 17, playerIds: ['one', 'two', 'three', 'four'] });
    const events = applyBattleBatch(snapshot, snapshot.playerIds.map(playerId => ({ playerId, seq: 1, boardRevision: 0, angleMilliDeg: 0 })), 0).presentationEvents;
    const routed = events.filter((_, index) => index % 2 === 0);
    expect(isPresentationEvents(routed)).toBe(true);
    expect(isPresentationEvents([...routed, routed[0]])).toBe(false);
    expect(isPresentationEvents([...events].reverse())).toBe(false);
  });
});
