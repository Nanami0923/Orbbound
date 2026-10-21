import { BOARD_COLUMNS, BOARD_ROWS, RULES_VERSION, SCHEMA_VERSION, getDifficulty } from '../core/engine';
import { activeColors, createEmptyBoard } from '../core/grid';
import { normalizeSeed, SeededRandom } from '../core/rng';
import type { Board, GameState } from '../core/types';

export const LAN_INITIAL_COLOR_QUOTAS = {
  easy: [18, 18, 17, 17],
  normal: [20, 20, 20, 19, 19],
  hard: [19, 19, 19, 19, 18, 18],
} as const;

/** Stable FNV-1a over UTF-16 code units followed by the 32-bit fmix finalizer. */
export function deriveLanSeed(matchSeed: number, playerId: string, waveIndex: number, domain: string): number {
  let hash = (matchSeed ^ 0x811c9dc5) >>> 0;
  const encoded = `${playerId}\0${waveIndex}\0${domain}`;
  for (let index = 0; index < encoded.length; index += 1) {
    hash = Math.imul(hash ^ encoded.charCodeAt(index), 0x01000193) >>> 0;
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return normalizeSeed((hash ^ (hash >>> 16)) >>> 0);
}

function createLanOpeningBoard(difficultyId: string, seed: number): Board {
  const difficulty = getDifficulty(difficultyId);
  const quotas = LAN_INITIAL_COLOR_QUOTAS[difficulty.id as keyof typeof LAN_INITIAL_COLOR_QUOTAS];
  const expectedCells = difficulty.initialRows * BOARD_COLUMNS;
  if (!quotas || quotas.length !== difficulty.colors || quotas.reduce((sum, count) => sum + count, 0) !== expectedCells) {
    throw new Error(`联机开局配额无效：${difficulty.id}`);
  }

  const pool = quotas.flatMap((count, color) => Array<number>(count).fill(color));
  const random = new SeededRandom(seed);
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const other = random.nextInt(index + 1);
    [pool[index], pool[other]] = [pool[other], pool[index]];
  }

  const board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
  for (let index = 0; index < pool.length; index += 1) {
    board[Math.floor(index / BOARD_COLUMNS)][index % BOARD_COLUMNS] = pool[index];
  }
  return board;
}

/** LAN-only initial and wave state. Single-player createGameState stays unchanged. */
export function createLanGameState(difficultyId: string, matchSeed: number, playerId: string, waveIndex: number): GameState {
  const difficulty = getDifficulty(difficultyId);
  const boardSeed = deriveLanSeed(matchSeed, playerId, waveIndex, 'board-v1');
  const supplySeed = deriveLanSeed(matchSeed, playerId, waveIndex, 'supply-v1');
  const board = createLanOpeningBoard(difficulty.id, boardSeed);
  const random = new SeededRandom(supplySeed);
  const colors = activeColors(board);
  const currentColor = colors[random.nextInt(colors.length)];
  const nextColor = colors[random.nextInt(colors.length)];

  return {
    schemaVersion: SCHEMA_VERSION,
    rulesVersion: RULES_VERSION,
    difficultyId: difficulty.id,
    seed: boardSeed,
    rngState: random.getState(),
    board,
    rowOffset: 0,
    score: 0,
    danger: 0,
    step: 0,
    currentColor,
    nextColor,
    status: 'READY',
  };
}
