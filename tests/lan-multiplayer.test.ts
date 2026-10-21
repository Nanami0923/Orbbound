import { describe, expect, it } from 'vitest';
import { advanceMatch, applyShot, createMatch, forfeitMatch, forfeitPlayersMatch } from '../src/lan/authority';
import { applyBattleBatch } from '../src/lan/battle';
import { isMatchSnapshot } from '../src/lan/protocol';
import type { MatchSnapshot, LanMode } from '../src/lan/protocol';
import { isPresentationEvents } from '../src/lan/presentation';
import { BOARD_COLUMNS, BOARD_ROWS } from '../src/core/engine';
import { createEmptyBoard } from '../src/core/grid';

const ids = ['alice', 'bob', 'chen', 'dana'];
const game = (mode: LanMode = 'battle', count = 4) => createMatch({ mode, matchId: 'four-player', difficultyId: 'normal', durationMs: 180000, seed: 42, playerIds: ids.slice(0, count) });
const shot = (match: MatchSnapshot, playerId: string) => ({ playerId, seq: match.players[playerId].lastSeq + 1, boardRevision: match.players[playerId].boardRevision, angleMilliDeg: 0 });
function clear(match: MatchSnapshot, id: string, count: number) {
  const state = match.players[id].state;
  state.board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
  for (let index = 0; index < count - 1; index++) state.board[Math.floor(index / BOARD_COLUMNS)][index % BOARD_COLUMNS] = 0;
  state.currentColor = state.nextColor = 0;
}
function fatal(match: MatchSnapshot, id: string, at = 0) {
  const player = match.players[id];
  player.state.board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
  for (let row = 0; row < 17; row++) player.state.board[row][7] = row % 5;
  match.eventSeq = Math.max(1, match.eventSeq);
  const source = match.playerIds.find(other => other !== id)!;
  player.battle!.pendingAttacks.push({ attackId: `fatal-${id}`, sourcePlayerId: source, sourcePlayerIds: [source], targetPlayerId: id,
    createdAtMs: at, notBeforeAtMs: at + 2000, sourceEventSeq: 1 });
}
function assertValid(match: MatchSnapshot) { expect(isMatchSnapshot(JSON.parse(JSON.stringify(match)))).toBe(true); }

describe('four-player authoritative rules', () => {
  it.each([2, 3, 4])('starts %i independent boards for both modes', count => {
    for (const mode of ['battle', 'score'] as const) {
      const match = game(mode, count), replay = game(mode, count); assertValid(match);
      for (const id of match.playerIds) expect(match.players[id].state).toEqual(replay.players[id].state);
      expect(new Set(match.playerIds.map(id => JSON.stringify(match.players[id].state.board))).size).toBe(count);
      if (mode === 'battle') expect(match.players.alice.battle!.threshold).toBe(12 * (count - 1));
    }
  });
  it.each([[2, 11, 0], [2, 12, 1], [3, 23, 0], [3, 24, 1], [4, 35, 0], [4, 36, 1]])('uses the %i-player threshold for %i actual balls', (count, balls, rows) => {
    const match = game('battle', count); clear(match, 'bob', balls);
    const result = applyBattleBatch(match, [shot(match, 'bob')], 0);
    expect(result.snapshot.players.alice.battle!.pendingAttacks).toHaveLength(rows);
    expect(result.snapshot.players.alice.battle!.incomingBalls).toBe(balls % (12 * (count - 1)));
    assertValid(result.snapshot);
  });
  it.each([[3, [10, 14]], [4, [10, 14, 12]]] as const)('aggregates all other players in %i players including a target with zero output', (count, contributions) => {
    const match = game('battle', count);
    contributions.forEach((balls, i) => clear(match, ids[i + 1], balls));
    const commands = ids.slice(1, count).map(id => shot(match, id));
    const result = applyBattleBatch(match, commands, 0);
    const attack = result.snapshot.players.alice.battle!.pendingAttacks[0];
    expect(attack.sourcePlayerIds).toEqual(ids.slice(1, count));
    expect(result.snapshot.players.alice.battle!.incomingContributions).toEqual({});
    expect(result.snapshot).toEqual(applyBattleBatch(match, [...commands].reverse(), 0).snapshot);
    expect(isPresentationEvents(result.presentationEvents)).toBe(true); assertValid(result.snapshot);
  });
  it('uses one clear for independent defense and contributions to all three others', () => {
    const match = game(); [12, 10, 14, 12].forEach((balls, i) => clear(match, ids[i], balls));
    const result = applyBattleBatch(match, ids.map(id => shot(match, id)), 0).snapshot;
    expect(result.players.alice.battle).toMatchObject({ pendingAttacks: [], stats: { generatedRows: 1, cancelledRows: 1 } });
    expect(result.players.bob.battle!.pendingAttacks).toHaveLength(1);
    expect(result.players.bob.battle!.pendingAttacks[0].sourcePlayerIds).toContain('alice');
    assertValid(result);
  });
  it('does not bank unused whole defense rows', () => {
    let match = game(); clear(match, 'alice', 24);
    match = applyBattleBatch(match, [shot(match, 'alice')], 0).snapshot;
    expect(match.players.alice.battle!.defenseRemainder).toBe(0);
    clear(match, 'bob', 36);
    match = applyBattleBatch(match, [shot(match, 'bob')], 1000).snapshot;
    expect(match.players.alice.battle!.pendingAttacks).toHaveLength(1); assertValid(match);
  });
  it('consumes excess complete rows and keeps exactly the modulo contribution ledger', () => {
    const match = game(); clear(match, 'bob', 100);
    const result = applyBattleBatch(match, [shot(match, 'bob')], 0).snapshot;
    expect(result.players.alice.battle).toMatchObject({ incomingBalls: 28, incomingContributions: { bob: 28 }, stats: { generatedRows: 2, discardedRows: 0 } });
    clear(result, 'chen', 100);
    const next = applyBattleBatch(result, [shot(result, 'chen')], 100).snapshot;
    expect(next.players.alice.battle).toMatchObject({ incomingBalls: 20, incomingContributions: { chen: 20 }, stats: { generatedRows: 4, discardedRows: 2 } });
    expect(next.players.alice.battle!.pendingAttacks).toHaveLength(3); assertValid(next);
  });
  it('preserves progress and historical contributors across 4 to 3 to 2 players', () => {
    const match = game(); clear(match, 'dana', 18);
    let next = applyBattleBatch(match, [shot(match, 'dana')], 0).snapshot;
    next = forfeitMatch(next, 'dana', 100);
    expect(next.status).toBe('playing');
    next = advanceMatch(next, 150);
    expect(next.players.alice.battle).toMatchObject({ threshold: 24, incomingBalls: 12, incomingContributions: { dana: 12 } });
    next = forfeitMatch(next, 'chen', 200); next = advanceMatch(next, 250);
    expect(next.players.alice.battle).toMatchObject({ threshold: 12, incomingBalls: 6, incomingContributions: { dana: 6 }, pendingAttacks: [] });
    expect(applyBattleBatch(next, [shot(next, 'dana')], 300).outcomes[0].reason).toBe('PLAYER_SEALED'); assertValid(next);
  });
  it('rescales fractional contributor shares deterministically with exact ledger sum', () => {
    const match = game(); const battle = match.players.alice.battle!;
    battle.incomingBalls = 5; battle.incomingContributions = { bob: 1, chen: 1, dana: 3 };
    let next = forfeitMatch(match, 'dana', 0); next = advanceMatch(next, 50);
    expect(next.players.alice.battle).toMatchObject({ incomingBalls: 3, incomingContributions: { bob: 1, dana: 2 } }); assertValid(next);
  });
  it('continues after one elimination and assigns tied competition ranks atomically', () => {
    const match = game(); fatal(match, 'chen'); fatal(match, 'dana');
    const next = advanceMatch(match, 2000);
    expect(next.status).toBe('playing'); expect(next.players.chen.eliminationRank).toBe(3); expect(next.players.dana.eliminationRank).toBe(3);
    fatal(next, 'bob', 2000);
    const ended = advanceMatch(next, 4000);
    expect(ended.result!.winnerIds).toEqual(['alice']);
    expect(ended.result!.ranking.map(entry => [entry.playerId, entry.rank])).toEqual([['alice', 1], ['bob', 2], ['chen', 3], ['dana', 3]]); assertValid(ended);
  });
  it('ties the final remaining group without promoting previously eliminated players', () => {
    const match = game(); fatal(match, 'chen'); fatal(match, 'dana');
    const next = advanceMatch(match, 2000); fatal(next, 'alice', 2000); fatal(next, 'bob', 2000);
    const ended = advanceMatch(next, 4000);
    expect(ended.result).toMatchObject({ winnerId: null, winnerIds: ['alice', 'bob'], reason: 'double-knockout' });
    expect(ended.result!.ranking.map(entry => entry.rank)).toEqual([1, 1, 3, 3]); assertValid(ended);
  });
  it('commits other players shots before resolving same-batch eliminations', () => {
    const match = game(); fatal(match, 'bob'); clear(match, 'chen', 36);
    const result = applyBattleBatch(match, [shot(match, 'chen')], 2000).snapshot;
    expect(result.players.bob.sealed).toBe(true);
    expect(result.players.alice.battle!.pendingAttacks[0].sourcePlayerIds).toEqual(['chen']); assertValid(result);
  });
  it('batches multiple forfeits, preserves non-leavers and never awards an all-forfeit win', () => {
    const match = game();
    const some = forfeitPlayersMatch(match, ['bob', 'chen'], 100);
    expect(some.status).toBe('playing'); expect(some.players.bob.eliminationRank).toBe(3); expect(some.players.chen.eliminationRank).toBe(3); assertValid(some);
    const all = forfeitPlayersMatch(match, ids, 100);
    expect(all.result!.winnerIds).toEqual([]); expect(all.result!.ranking.every(entry => entry.rank === null)).toBe(true); assertValid(all);
  });
  it('does not remove score-mode sealed players from the normal ranking or end when only one can shoot', () => {
    const match = game('score', 3), alice = match.players.alice;
    alice.sealed = true; alice.sealedAtMs = 0; alice.state.status = 'LOST'; alice.score = alice.state.score = 500;
    let next = forfeitMatch(match, 'bob', 100);
    expect(next.status).toBe('playing'); expect(next.players.chen.sealed).toBe(false);
    expect(forfeitMatch(next, 'alice', 100)).toBe(next);
    next.players.chen.nextDescentAtMs = 180001;
    next = advanceMatch(next, 180000);
    expect(next.result!.winnerIds).toEqual(['alice']);
    expect(next.result!.ranking).toEqual([{ playerId: 'alice', rank: 1, status: 'sealed' }, { playerId: 'chen', rank: 2, status: 'active' }, { playerId: 'bob', rank: null, status: 'forfeit' }]); assertValid(next);
  });
  it('uses competition score ranks with tied winners and rejects forged ranking or attack provenance', () => {
    const match = game('score'); ids.forEach(id => { match.players[id].nextDescentAtMs = 180001; });
    [50, 50, 30, 10].forEach((score, i) => { match.players[ids[i]].score = match.players[ids[i]].state.score = score; });
    const ended = advanceMatch(match, 180000); expect(ended.result!.ranking.map(row => row.rank)).toEqual([1, 1, 3, 4]); assertValid(ended);
    const forged = structuredClone(ended); forged.result!.winnerIds = ['dana']; expect(isMatchSnapshot(forged)).toBe(false);
    const wrongRank = structuredClone(ended); wrongRank.result!.ranking[1].rank = 2; expect(isMatchSnapshot(wrongRank)).toBe(false);
    const battle = game(); clear(battle, 'bob', 36); const update = applyBattleBatch(battle, [shot(battle, 'bob')], 0).snapshot;
    update.players.alice.battle!.pendingAttacks[0].sourcePlayerIds = ['alice']; expect(isMatchSnapshot(update)).toBe(false);
  });
  it('deadline takes precedence over departures and newly submitted shots', () => {
    const match = game(); match.players.dana.score = match.players.dana.state.score = 100;
    const ended = forfeitPlayersMatch(match, ['dana'], 180000);
    expect(ended.result).toMatchObject({ reason: 'timeout', winnerIds: ['dana'] }); expect(ended.players.dana.forfeited).toBe(false); assertValid(ended);
    expect(applyShot(ended, shot(ended, 'alice'), 180000).reason).toBe('MATCH_FINISHED');
  });
  it('replays four-player batches independently of command arrival order without mutating inputs', () => {
    let left = game(), right = game();
    for (let at = 0; at < 30000 && left.status === 'playing'; at += 1000) {
      const before = JSON.stringify(left);
      const commands = left.playerIds.filter(id => !left.players[id].sealed).map((id, index) => ({ ...shot(left, id), angleMilliDeg: ((at / 1000 + index) % 7 - 3) * 20000 }));
      const next = applyBattleBatch(left, commands, at);
      expect(JSON.stringify(left)).toBe(before);
      left = next.snapshot;
      right = applyBattleBatch(right, [...commands].reverse(), at).snapshot;
      expect(right).toEqual(left); assertValid(left);
    }
  });
  it('reconstructs a four-player score catch-up identically at fast and delayed scheduler rates', () => {
    const original = game('score'); let fast = original;
    for (let at = 50; at <= 170000; at += 50) fast = advanceMatch(fast, at);
    const slow = advanceMatch(original, 170000);
    expect(slow).toEqual(fast); assertValid(slow);
  });
  it('rejects forged contributor totals, aliases, duplicate sources and impossible elimination ranks', () => {
    const initial = game();
    for (const mutate of [
      (match: MatchSnapshot) => { match.players.alice.battle!.incomingBalls = 1; },
      (match: MatchSnapshot) => { match.players.alice.battle!.incomingContributions = { alice: 1 }; match.players.alice.battle!.incomingBalls = 1; },
      (match: MatchSnapshot) => { match.players.alice.battle!.chargeRemainder = 1; },
      (match: MatchSnapshot) => { match.players.alice.forfeited = true; },
    ]) { const copy = structuredClone(initial); mutate(copy); expect(isMatchSnapshot(copy)).toBe(false); }
    fatal(initial, 'dana'); const dropped = advanceMatch(initial, 2000); assertValid(dropped);
    dropped.players.dana.eliminationRank = 1; expect(isMatchSnapshot(dropped)).toBe(false);
    const two = game('battle', 2); two.players.alice.battle!.threshold = 36; expect(isMatchSnapshot(two)).toBe(false);
  });
});
