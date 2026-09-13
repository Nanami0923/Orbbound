import { activeColors, boardIsEmpty, cellKey, cloneBoard, createEmptyBoard, findGroup, findTopConnected, hasOccupiedAtOrBelow, neighbors, occupiedCells } from './grid';
import { normalizeSeed, SeededRandom } from './rng';
import type { Board, Cell, ColorId, GameEvent, GameState, ResolveResult } from './types';

export const RULES_VERSION = 'classic-v2';
export const SCHEMA_VERSION = 1;
export const MATCH_THRESHOLD = 3;
export const DANGER_MAX = 100;
export const matchPoints = (n: number): number => n < 3 ? 0 : n * 10 + (n - 3) * (n - 2) * 5;
export const dropPoints = (n: number): number => n * 30 + n * Math.max(0, n - 1) * 5;

export interface DifficultyConfig {
  id: string;
  label: string;
  description: string;
  colors: number;
  initialRows: number;
  dangerPerShot: number;
  opening: number[];
}

export const DIFFICULTIES: DifficultyConfig[] = [
  {
    id: 'easy',
    label: '简单 · 漫游',
    description: '颜色更少，给你更多拆解空间。',
    colors: 4,
    initialRows: 5,
    dangerPerShot: 8,
    opening: [0, 0, 1, 2, 2, 1, 3, 0, 1, 3, 2, 1, 0, 3],
  },
  {
    id: 'normal',
    label: '普通 · 经典',
    description: '规则与压力的平衡起点。',
    colors: 5,
    initialRows: 7,
    dangerPerShot: 10,
    opening: [0, 1, 2, 1, 3, 4, 2, 0, 3, 4, 1, 2, 0, 3],
  },
  {
    id: 'hard',
    label: '困难 · 风暴',
    description: '颜色更多，棋盘更快逼近底线。',
    colors: 6,
    initialRows: 8,
    dangerPerShot: 12,
    opening: [0, 2, 4, 1, 3, 5, 2, 0, 4, 1, 5, 3, 2, 4],
  },
];

export const BOARD_COLUMNS = 14;
export const BOARD_ROWS = 19;
export const LOSE_ROW = 17;

export function getDifficulty(id: string): DifficultyConfig {
  return DIFFICULTIES.find((difficulty) => difficulty.id === id) ?? DIFFICULTIES[1];
}

export function shotsUntilDescent(difficultyId: string, danger: number): number {
  return Math.max(1, Math.ceil((DANGER_MAX - danger) / getDifficulty(difficultyId).dangerPerShot));
}

function shuffledColor(random: SeededRandom, config: DifficultyConfig): ColorId {
  return random.nextInt(config.colors);
}

function fillOpeningRow(board: Board, row: number, random: SeededRandom, config: DifficultyConfig): void {
  const base = config.opening;
  for (let col = 0; col < BOARD_COLUMNS; col += 1) {
    const pattern = base[(col + row * 2) % base.length] % config.colors;
    const jitter = random.next() < 0.27 ? random.nextInt(config.colors) : pattern;
    board[row][col] = jitter;
  }
}

function chooseNextColor(board: Board, random: SeededRandom, config: DifficultyConfig): ColorId {
  const colors = activeColors(board);
  if (colors.length > 0) return colors[random.nextInt(colors.length)];
  return shuffledColor(random, config);
}

export function createGameState(difficultyId = 'normal', seed = Date.now()): GameState {
  const config = getDifficulty(difficultyId);
  const normalizedSeed = normalizeSeed(seed);
  const random = new SeededRandom(normalizedSeed);
  const board = createEmptyBoard(BOARD_COLUMNS, BOARD_ROWS);
  for (let row = 0; row < config.initialRows; row += 1) fillOpeningRow(board, row, random, config);
  const currentColor = chooseNextColor(board, random, config);
  const nextColor = chooseNextColor(board, random, config);

  return {
    schemaVersion: SCHEMA_VERSION,
    rulesVersion: RULES_VERSION,
    difficultyId: config.id,
    seed: normalizedSeed,
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

function isValidLanding(board: Board, landing: Cell, rowOffset = 0): boolean {
  if (landing.row < 0 || landing.row >= board.length || landing.col < 0 || landing.col >= board[0].length) return false;
  if (board[landing.row][landing.col] !== null) return false;
  if (landing.row === 0) return true;
  return neighbors(landing, board[0].length, board.length, rowOffset).some((cell) => board[cell.row][cell.col] !== null);
}

function removeCells(board: Board, cells: Cell[]): void {
  for (const cell of cells) board[cell.row][cell.col] = null;
}

function shiftBoardDown(board: Board, random: SeededRandom, config: DifficultyConfig): boolean {
  for (let row = board.length - 1; row >= 0; row -= 1) {
    board[row] = row === 0 ? Array.from({ length: BOARD_COLUMNS }, () => shuffledColor(random, config)) : [...board[row - 1]];
  }
  return hasOccupiedAtOrBelow(board, LOSE_ROW);
}

export function forceDescent(input: GameState): ResolveResult {
  if (input.status !== 'READY') return { state: input, events: [] };
  const state = { ...input, board: cloneBoard(input.board), danger: 0 };
  const random = new SeededRandom(state.rngState);
  const lost = shiftBoardDown(state.board, random, getDifficulty(state.difficultyId));
  state.rowOffset = 1 - (state.rowOffset ?? 0);
  state.rngState = random.getState();
  if (lost) state.status = 'LOST';
  return { state, events: [{ type: 'board-drop' }, ...(lost ? [{ type: 'lost' as const }] : [])] };
}

export function resolveShot(input: GameState, landing: Cell): ResolveResult {
  if (input.status !== 'READY') return { state: input, events: [] };

  const state: GameState = {
    ...input,
    board: cloneBoard(input.board),
  };
  const config = getDifficulty(state.difficultyId);
  const random = new SeededRandom(state.rngState);
  const events: GameEvent[] = [{ type: 'shot-landed', landing }];

  if (!isValidLanding(state.board, landing, state.rowOffset)) {
    state.status = 'LOST';
    events.push({ type: 'lost' });
    return { state, events };
  }

  state.board[landing.row][landing.col] = state.currentColor;
  const group = findGroup(state.board, landing, state.rowOffset);
  let matched: Cell[] = [];
  if (group.length >= MATCH_THRESHOLD) {
    matched = group;
    removeCells(state.board, matched);
    events.push({ type: 'match', cells: matched, points: matchPoints(matched.length) });
  }

  const connected = findTopConnected(state.board, state.rowOffset);
  const floating = occupiedCells(state.board).filter((cell) => !connected.has(cellKey(cell)));
  if (floating.length > 0) {
    removeCells(state.board, floating);
    events.push({ type: 'drop', cells: floating, points: dropPoints(floating.length) });
  }

  state.score += matchPoints(matched.length) + dropPoints(floating.length);
  state.step += 1;

  if (boardIsEmpty(state.board)) {
    if (state.mode === 'timed') {
      const wave = createGameState(state.difficultyId, random.getState());
      Object.assign(state, { board: wave.board, rowOffset: 0, danger: 0, rngState: wave.rngState,
        currentColor: wave.currentColor, nextColor: wave.nextColor });
      events.push({ type: 'board-drop' });
      return { state, events };
    }
    state.status = 'WON';
    state.rngState = random.getState();
    events.push({ type: 'win' });
    return { state, events };
  }

  state.danger += config.dangerPerShot;
  if (state.danger >= DANGER_MAX) {
    state.danger = state.mode === 'timed' ? 0 : state.danger - DANGER_MAX;
    const lostByDrop = shiftBoardDown(state.board, random, config);
    // Moving a hex grid one row must flip its stagger origin, preserving every existing x coordinate and edge.
    state.rowOffset = 1 - (state.rowOffset ?? 0);
    events.push({ type: 'board-drop', danger: state.danger });
    if (lostByDrop) state.status = 'LOST';
  }

  if (state.status === 'READY' && hasOccupiedAtOrBelow(state.board, LOSE_ROW)) state.status = 'LOST';

  state.rngState = random.getState();
  if (state.status === 'LOST') events.push({ type: 'lost' });

  if (state.status === 'READY') {
    state.currentColor = state.nextColor;
    state.nextColor = chooseNextColor(state.board, random, config);
    state.rngState = random.getState();
  }

  return { state, events };
}

