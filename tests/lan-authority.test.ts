import { describe, expect, it, vi } from 'vitest';
import { advanceMatch, applyShot, createLanGameState, createMatch, deriveLanSeed, finishMatch, forfeitMatch, shotTiming } from '../src/lan/authority';
import { LAN_CONTENT_HASH, LAN_PROTOCOL_VERSION, LAN_RULES_HASH, isLanName, isMatchConfig, isMatchSnapshot, isShotCommand } from '../src/lan/protocol';
import type { MatchSnapshot, ShotCommand } from '../src/lan/protocol';
import { activeColors, createEmptyBoard } from '../src/core/grid';
import { SeededRandom } from '../src/core/rng';
import { BOARD_COLUMNS, BOARD_ROWS } from '../src/core/engine';
import { descentInterval } from '../src/core/modes';
import { LAN_INITIAL_COLOR_QUOTAS } from '../src/lan/random';

const config = { matchId: 'test-match', difficultyId: 'normal' as const, durationMs: 180000 as const, seed: 42, playerIds: ['host', 'guest'] as [string, string] };
const command = (snapshot: MatchSnapshot, playerId = 'host', angleMilliDeg = 0): ShotCommand => ({ playerId, seq: snapshot.players[playerId].lastSeq + 1, boardRevision: snapshot.players[playerId].boardRevision, angleMilliDeg });

function prepareClear(snapshot: MatchSnapshot, id = 'host'): void {
  const player = snapshot.players[id];
  player.state.board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
  player.state.board[0][7] = player.state.board[0][8] = 0;
  player.state.currentColor = player.state.nextColor = 0;
}

function prepareLoss(snapshot: MatchSnapshot, id = 'host'): void {
  const player = snapshot.players[id];
  player.state.board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
  for (let row = 0; row < 17; row++) player.state.board[row][7] = row % 5;
}

describe('LAN deterministic score authority', () => {
  it('creates independent boards with explicit three or five minute durations', () => {
    for (const durationMs of [180000, 300000] as const) {
      const snapshot = createMatch({ ...config, durationMs });
      expect(snapshot.durationMs).toBe(durationMs);
      expect(snapshot.players.host.state).not.toEqual(snapshot.players.guest.state);
      expect(snapshot.players.host.state.board).not.toBe(snapshot.players.guest.state.board);
      expect(snapshot.players.host.state.board).not.toEqual(snapshot.players.guest.state.board);
      expect(snapshot.players.host.state.board[0]).not.toBe(snapshot.players.guest.state.board[0]);
      expect(isMatchSnapshot(JSON.parse(JSON.stringify(snapshot)))).toBe(true);
    }
  });

  it.each([2, 3, 4])('builds independent board and supply streams for %i players at all difficulties', count => {
    const playerIds = ['p1', 'p2', 'p3', 'p4'].slice(0, count);
    for (const difficultyId of ['easy', 'normal', 'hard'] as const) {
      const snapshot = createMatch({ ...config, difficultyId, playerIds });
      const shuffledSeats = createMatch({ ...config, difficultyId, playerIds: [...playerIds].reverse() });
      const boardKeys = new Set<string>();
      const supplyStates = new Set<number>();
      for (const playerId of playerIds) {
        const state = snapshot.players[playerId].state;
        expect(shuffledSeats.players[playerId].state).toEqual(state);
        const quota = LAN_INITIAL_COLOR_QUOTAS[difficultyId];
        const counts = Array.from({ length: quota.length }, (_, color) => state.board.flat().filter(cell => cell === color).length);
        expect(counts).toEqual(quota);
        expect(state).toEqual(createLanGameState(difficultyId, snapshot.seed, playerId, 0));
        boardKeys.add(JSON.stringify(state.board));
        supplyStates.add(state.rngState);

        const colors = activeColors(state.board);
        const supply = new SeededRandom(deriveLanSeed(snapshot.seed, playerId, 0, 'supply-v1'));
        expect(state.currentColor).toBe(colors[supply.nextInt(colors.length)]);
        expect(state.nextColor).toBe(colors[supply.nextInt(colors.length)]);
        expect(state.rngState).toBe(supply.getState());

        const nextWave = createLanGameState(difficultyId, snapshot.seed, playerId, 1);
        expect(nextWave).toEqual(createLanGameState(difficultyId, snapshot.seed, playerId, 1));
        expect(nextWave.board).not.toEqual(state.board);
      }
      expect(boardKeys.size).toBe(count);
      expect(supplyStates.size).toBe(count);
      expect(isMatchSnapshot(snapshot)).toBe(true);
    }
  });

  it('pins UTF-16 FNV-1a and fmix seed derivation with the documented vectors', () => {
    expect([
      deriveLanSeed(520, 'p1', 0, 'board-v1'),
      deriveLanSeed(520, 'p1', 0, 'supply-v1'),
      deriveLanSeed(520, 'p2', 0, 'board-v1'),
      deriveLanSeed(520, 'p1', 1, 'board-v1'),
    ]).toEqual([603175877, 3636614665, 2466274389, 3356980069]);
  });

  it('accepts actual traced shots and reproduces the same complete state and events', () => {
    const snapshot = createMatch(config);
    const before = JSON.stringify(snapshot);
    const shot = command(snapshot, 'host', 23000);
    const first = applyShot(snapshot, shot, 1000);
    const second = applyShot(snapshot, shot, 1000);
    expect(first.accepted).toBe(true);
    expect(first).toEqual(second);
    expect(first.trace?.landing).not.toBeNull();
    expect(first.events[0].type).toBe('shot-landed');
    expect(first.snapshot.players.host.totalShots).toBe(1);
    expect(first.snapshot.players.host.boardRevision).toBe(1);
    expect(first.snapshot.players.host.readyAtMs).toBe(1000 + shotTiming(first.trace!, first.events));
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(isMatchSnapshot(first.snapshot)).toBe(true);
  });

  it('uses only the host active clock without reading wall time or browser state', () => {
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('wall clock access'); });
    try {
      const snapshot = createMatch(config, 1000);
      const result = applyShot(snapshot, command(snapshot), 2000);
      expect(result.accepted).toBe(true);
      expect(result.snapshot.elapsedMs).toBe(1000);
    } finally { dateNow.mockRestore(); }
  });

  it('replays an entire match with identical commands, cooldown rejections and final results', () => {
    const replay = (): MatchSnapshot => {
      let snapshot = createMatch(config);
      for (let now = 0; now < config.durationMs && snapshot.status === 'playing'; now += 1000) {
        const angle = ((now / 1000) % 9 - 4) * 18000;
        for (const id of config.playerIds) snapshot = applyShot(snapshot, command(snapshot, id, angle), now).snapshot;
        expect(isMatchSnapshot(snapshot)).toBe(true);
      }
      return advanceMatch(snapshot, config.durationMs);
    };
    const first = replay(); const second = replay();
    expect(first).toEqual(second);
    expect(first.players.host.totalShots).toBeGreaterThan(10);
    expect(first.players.host.state).not.toEqual(first.players.guest.state);
    expect(first.result).toBeDefined();
  });

  it('clears into each player’s independently seeded numbered wave despite timing and prior RNG', () => {
    const snapshot = createMatch(config);
    prepareClear(snapshot, 'host'); prepareClear(snapshot, 'guest');
    snapshot.players.host.state.rngState = 123;
    snapshot.players.guest.state.rngState = 999;
    const first = applyShot(snapshot, command(snapshot), 0);
    expect(first.accepted).toBe(true);
    expect(first.snapshot.players.host.completedWaves).toBe(1);
    expect(first.snapshot.players.host.score).toBe(30);
    expect(first.events.some(event => event.type === 'win')).toBe(false);
    const second = applyShot(first.snapshot, command(first.snapshot, 'guest'), 5000);
    expect(second.snapshot.players.guest.completedWaves).toBe(1);
    const expectedHostWave = createLanGameState('normal', config.seed, 'host', 1);
    const expectedGuestWave = createLanGameState('normal', config.seed, 'guest', 1);
    expect(second.snapshot.players.host.state).toEqual({ ...expectedHostWave, score: second.snapshot.players.host.score, step: second.snapshot.players.host.totalShots });
    expect(second.snapshot.players.guest.state).toEqual({ ...expectedGuestWave, score: second.snapshot.players.guest.score, step: second.snapshot.players.guest.totalShots });
    expect(second.snapshot.players.host.state.board).not.toEqual(second.snapshot.players.guest.state.board);
    expect(second.snapshot.players.guest.nextDescentAtMs).toBe(5000 + descentInterval('normal', 5000, 180000));
    expect(second.snapshot.players.guest.totalShots).toBe(1);
    expect(isMatchSnapshot(second.snapshot)).toBe(true);
  });

  it('rejects duplicate commands, old board revisions and cooldown spam without double scoring', () => {
    const snapshot = createMatch(config); prepareClear(snapshot);
    const shot = command(snapshot);
    const first = applyShot(snapshot, shot, 1000);
    const duplicate = applyShot(first.snapshot, shot, 1001);
    expect(duplicate.reason).toBe('DUPLICATE_SEQUENCE');
    expect(duplicate.snapshot.players.host).toEqual(first.snapshot.players.host);
    expect(applyShot(first.snapshot, { ...shot, seq: 2 }, 1001).reason).toBe('STALE_STATE');
    expect(applyShot(first.snapshot, command(first.snapshot), 1001).reason).toBe('COOLDOWN');
    const next = applyShot(first.snapshot, command(first.snapshot), first.snapshot.players.host.readyAtMs);
    expect(next.accepted).toBe(true);
    expect(next.snapshot.players.host.totalShots).toBe(2);
  });

  it('rejects malformed angles and unavailable landings without declaring a loss', () => {
    const snapshot = createMatch(config);
    for (const angleMilliDeg of [-78001, 78001, 0.1, NaN, Infinity]) {
      const result = applyShot(snapshot, { ...command(snapshot), angleMilliDeg }, 0);
      expect(result.reason).toBe('INVALID_COMMAND');
      expect(result.snapshot.players.host.state.status).toBe('READY');
      expect(result.snapshot.players.host.totalShots).toBe(0);
    }
    snapshot.players.host.state.board.forEach(row => row.fill(0));
    const result = applyShot(snapshot, command(snapshot), 0);
    expect(result.reason).toBe('INVALID_LANDING');
    expect(result.snapshot.players.host.state.status).toBe('READY');
    expect(result.snapshot.players.host.score).toBe(0);
  });

  it('applies overdue descent before validating an old revision and clears shot pressure', () => {
    const snapshot = createMatch(config);
    snapshot.players.host.state.danger = 90;
    const result = applyShot(snapshot, command(snapshot), 30000);
    expect(result.reason).toBe('STALE_STATE');
    expect(result.snapshot.players.host.boardRevision).toBe(1);
    expect(result.snapshot.players.host.state.danger).toBe(0);
    expect(result.snapshot.players.host.state.rowOffset).toBe(1);
    expect(result.snapshot.players.host.state.board[1]).toEqual(snapshot.players.host.state.board[0]);
    expect(result.snapshot.players.host.lastSeq).toBe(0);
    expect(result.snapshot.players.host.nextDescentAtMs).toBe(57500);
    expect(applyShot(result.snapshot, command(result.snapshot), 30360).accepted).toBe(true);
  });

  it('waits for logical cooldown before descent without losing or resetting its debt', () => {
    const snapshot = createMatch(config);
    const first = applyShot(snapshot, command(snapshot), 29999);
    expect(first.accepted).toBe(true);
    const readyAt = first.snapshot.players.host.readyAtMs;
    expect(readyAt).toBeGreaterThan(30000);
    const delayed = advanceMatch(first.snapshot, 30000);
    expect(delayed.players.host.boardRevision).toBe(1);
    expect(delayed.players.host.nextDescentAtMs).toBe(30000);
    const dropped = advanceMatch(delayed, readyAt);
    expect(dropped.players.host.boardRevision).toBe(2);
    expect(dropped.players.host.nextDescentAtMs).toBe(57500);
    expect(dropped.players.host.readyAtMs).toBe(readyAt + 360);
  });

  it('keeps the time-descent schedule when shot pressure triggers its own descent', () => {
    const snapshot = createMatch(config);
    snapshot.players.host.state.danger = 90;
    const result = applyShot(snapshot, command(snapshot), 1000);
    expect(result.accepted).toBe(true);
    expect(result.events.some(event => event.type === 'board-drop')).toBe(true);
    expect(result.snapshot.players.host.nextDescentAtMs).toBe(30000);
    expect(result.snapshot.players.host.state.danger).toBe(0);
    expect(result.snapshot.players.host.state.rowOffset).toBe(1);
  });

  it('produces the same catch-up state at high and low scheduler rates', () => {
    const snapshot = createMatch(config);
    let fast = snapshot;
    for (let now = 50; now <= 170000; now += 50) fast = advanceMatch(fast, now);
    const slow = advanceMatch(snapshot, 170000);
    expect(slow).toEqual(fast);
    expect(isMatchSnapshot(slow)).toBe(true);
    expect(slow.players.host.boardRevision).toBeGreaterThan(1);
  });

  it('scores a committed last shot even when its animation crosses the deadline', () => {
    const snapshot = createMatch(config); prepareClear(snapshot);
    snapshot.players.host.nextDescentAtMs = snapshot.players.guest.nextDescentAtMs = 180001;
    const accepted = applyShot(snapshot, command(snapshot), 179999);
    expect(accepted.accepted).toBe(true);
    expect(accepted.snapshot.players.host.readyAtMs).toBeGreaterThan(180000);
    const result = applyShot(accepted.snapshot, command(accepted.snapshot, 'guest'), 180000);
    expect(result.reason).toBe('MATCH_FINISHED');
    expect(result.snapshot.elapsedMs).toBe(180000);
    expect(result.snapshot.result).toMatchObject({ winnerId: 'host', reason: 'timeout', finishedAtMs: 180000 });
    expect(result.snapshot.players.host.score).toBe(30);
    expect(result.snapshot.players.guest.totalShots).toBe(0);
    expect(isMatchSnapshot(result.snapshot)).toBe(true);
  });

  it('does not apply a time descent scheduled exactly at the deadline', () => {
    const snapshot = createMatch(config);
    snapshot.players.host.nextDescentAtMs = snapshot.players.guest.nextDescentAtMs = 180000;
    const finished = advanceMatch(snapshot, 180000);
    expect(finished.players.host.state.board).toEqual(snapshot.players.host.state.board);
    expect(finished.players.host.boardRevision).toBe(0);
    expect(finished.result?.winnerId).toBeNull();
  });

  it('seals one player on bottom contact while the opponent keeps playing', () => {
    const snapshot = createMatch(config); prepareLoss(snapshot);
    snapshot.players.host.score = snapshot.players.host.state.score = 500;
    const dropped = advanceMatch(snapshot, 30000);
    expect(dropped.status).toBe('playing');
    expect(dropped.players.host.sealed).toBe(true);
    expect(dropped.players.host.score).toBe(500);
    expect(dropped.players.guest.sealed).toBe(false);
    expect(applyShot(dropped, command(dropped), 30360).reason).toBe('PLAYER_SEALED');
    expect(applyShot(dropped, command(dropped, 'guest'), 30360).accepted).toBe(true);
    expect(advanceMatch(dropped, 180000).result?.winnerId).toBe('host');
  });

  it('ends when both are sealed and records the same finish time after a delayed tick', () => {
    const snapshot = createMatch(config); prepareLoss(snapshot); prepareLoss(snapshot, 'guest');
    const onTime = advanceMatch(snapshot, 30000);
    const late = advanceMatch(snapshot, 45000);
    expect(late).toEqual(onTime);
    expect(late.result).toMatchObject({ reason: 'all-sealed', winnerId: null, finishedAtMs: 30000 });
    expect(isMatchSnapshot(late)).toBe(true);
  });

  it('ranks score first, then cleared waves, then a draw, ignoring survival', () => {
    const snapshot = createMatch(config);
    snapshot.players.host.nextDescentAtMs = snapshot.players.guest.nextDescentAtMs = 180001;
    snapshot.players.host.score = snapshot.players.host.state.score = 50;
    snapshot.players.guest.score = snapshot.players.guest.state.score = 40;
    snapshot.players.guest.waveIndex = snapshot.players.guest.completedWaves = 10;
    expect(advanceMatch(snapshot, 180000).result?.winnerId).toBe('host');
    snapshot.players.guest.score = snapshot.players.guest.state.score = 50;
    expect(advanceMatch(snapshot, 180000).result?.winnerId).toBe('guest');
    snapshot.players.host.waveIndex = snapshot.players.host.completedWaves = 10;
    expect(advanceMatch(snapshot, 180000).result?.winnerId).toBeNull();
  });

  it('makes completed results immutable and distinguishes interruption from forfeiture', () => {
    const snapshot = createMatch(config);
    const interrupted = finishMatch(snapshot, 'interrupted', 1000);
    expect(interrupted.result).toMatchObject({ reason: 'interrupted', winnerId: null });
    expect(isMatchSnapshot(interrupted)).toBe(true);
    const forfeit = forfeitMatch(snapshot, 'host', 2000);
    expect(forfeit.result).toMatchObject({ reason: 'forfeit', winnerId: 'guest' });
    expect(isMatchSnapshot(forfeit)).toBe(true);
    expect(advanceMatch(forfeit, 180000)).toBe(forfeit);
    expect(forfeitMatch(forfeit, 'guest', 180000)).toBe(forfeit);
    expect(applyShot(forfeit, command(forfeit), 3000).reason).toBe('MATCH_FINISHED');
  });
});

describe('LAN wire validation', () => {
  it('publishes bounded compatibility fingerprints for rules and content', () => {
    expect(LAN_PROTOCOL_VERSION).toBe(3);
    expect(LAN_RULES_HASH).toMatch(/^[0-9a-f]{8}$/);
    expect(LAN_RULES_HASH).toBe('7ca7ef0a');
    expect(LAN_RULES_HASH).not.toBe('4e2a4139');
    expect(LAN_CONTENT_HASH).toMatch(/^[0-9a-f]{8}$/);
  });

  it('rejects unsupported modes, invalid identities, sequence values and forged fields', () => {
    for (const change of [{ durationMs: 600000 }, { seed: Infinity }, { difficultyId: 'extreme' }, { playerIds: ['host', 'host'] }, { playerIds: ['__proto__', 'guest'] }]) {
      expect(isMatchConfig({ ...config, ...change })).toBe(false);
      expect(() => createMatch({ ...config, ...change } as typeof config)).toThrow();
    }
    const shot = command(createMatch(config));
    expect(isShotCommand(shot)).toBe(true);
    for (const change of [{ seq: 0 }, { seq: -1 }, { seq: 1.5 }, { boardRevision: '0' }, { playerId: '__proto__' }, { score: 50000 }, { angleMilliDeg: 90000 }]) {
      expect(isShotCommand({ ...shot, ...change })).toBe(false);
    }
    expect(isLanName('中文玩家')).toBe(true);
    expect(isLanName('🙂'.repeat(16))).toBe(true);
    expect(isLanName('🙂'.repeat(17))).toBe(false);
    expect(isLanName('player\nname')).toBe(false);
    expect(isLanName('   ')).toBe(false);
  });

  it('validates full board dimensions, counters, RNG, scores and terminal result consistency', () => {
    const snapshot = createMatch(config);
    const mutations: Array<(value: MatchSnapshot) => void> = [
      value => { value.rulesHash = 'wrong'; },
      value => { value.players.host.state.board.pop(); },
      value => { value.players.host.state.board[0][0] = 5; },
      value => { value.players.host.state.rngState = NaN; },
      value => { value.players.host.score = 200; },
      value => { value.players.host.lastSeq = -1; },
      value => { value.players.host.readyAtMs = Infinity; },
      value => { value.players.host.state.rowOffset = 3; },
      value => { value.players.host.state.mode = 'timed'; },
      value => { value.elapsedMs = 180001; },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(snapshot); mutate(copy);
      expect(isMatchSnapshot(copy)).toBe(false);
    }
    const finished = advanceMatch(snapshot, 180000);
    expect(isMatchSnapshot(finished)).toBe(true);
    finished.result!.players.host.score += 100;
    expect(isMatchSnapshot(finished)).toBe(false);
  });
});
