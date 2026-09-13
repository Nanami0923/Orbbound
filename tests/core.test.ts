import { describe, expect, it } from 'vitest';
import { BOARD_COLUMNS, BOARD_ROWS, createGameState, resolveShot } from '../src/core/engine';
import { createEmptyBoard } from '../src/core/grid';
import { traceShot } from '../src/core/physics';
import { BOARD_GEOMETRY } from '../src/content/game-config';
import type { GameState } from '../src/core/types';

function blankState(overrides: Partial<GameState> = {}): GameState {
  return {
    schemaVersion: 1,
    rulesVersion: 'classic-v1',
    difficultyId: 'normal',
    seed: 42,
    rngState: 42,
    board: createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS),
    score: 0,
    danger: 0,
    step: 0,
    currentColor: 0,
    nextColor: 1,
    status: 'READY',
    ...overrides,
  };
}

describe('classic rule engine', () => {
  it('removes exactly three matching orbs and wins when the board is cleared', () => {
    const board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
    board[0][0] = 0;
    board[0][1] = 0;
    const result = resolveShot(blankState({ board }), { row: 0, col: 2 });

    expect(result.state.score).toBe(30);
    expect(result.state.status).toBe('WON');
    expect(result.events.map((event) => event.type)).toEqual(['shot-landed', 'match', 'win']);
  });

  it('does not remove a pair below the match threshold', () => {
    const board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
    board[0][0] = 0;
    const result = resolveShot(blankState({ board }), { row: 0, col: 1 });

    expect(result.state.score).toBe(0);
    expect(result.state.status).toBe('READY');
    expect(result.events.some((event) => event.type === 'match')).toBe(false);
    expect(result.state.board[0][0]).toBe(0);
    expect(result.state.board[0][1]).toBe(0);
  });

  it('drops cells that lose their top connection after a match', () => {
    const board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
    board[0][0] = 0;
    board[0][1] = 0;
    board[1][0] = 1;
    board[1][1] = 1;
    const result = resolveShot(blankState({ board }), { row: 0, col: 2 });
    const dropEvent = result.events.find((event) => event.type === 'drop');

    expect(dropEvent?.cells).toHaveLength(2);
    expect(dropEvent?.points).toBe(70);
    expect(result.state.score).toBe(100);
    expect(result.state.status).toBe('WON');
  });

  it('moves the board down when danger reaches one hundred', () => {
    const board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
    board[0][0] = 1;
    const result = resolveShot(blankState({ board, danger: 90, currentColor: 0 }), { row: 0, col: 1 });

    expect(result.state.danger).toBe(0);
    expect(result.events.some((event) => event.type === 'board-drop')).toBe(true);
    expect(result.state.board[1][0]).toBe(1);
    expect(result.state.board[0].some((cell) => cell !== null)).toBe(true);
  });

  it('is deterministic for the same seed and inputs', () => {
    const first = createGameState('hard', 123456);
    const second = createGameState('hard', 123456);
    expect(first).toEqual(second);

    const firstTurn = resolveShot(first, { row: 0, col: 0 });
    const secondTurn = resolveShot(second, { row: 0, col: 0 });
    expect(firstTurn).toEqual(secondTurn);
  });
});

describe('shared shot prediction', () => {
  it('finds a legal top landing and includes a wall bounce for a wide angle', () => {
    const board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
    const trace = traceShot(board, Math.PI / 3, BOARD_GEOMETRY);

    expect(trace.landing).not.toBeNull();
    expect(trace.reason).toBe('top');
    expect(trace.bounced).toBe(true);
    expect(trace.points.length).toBeGreaterThan(10);
  });
});

