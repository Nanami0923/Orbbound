import type { Board, BoardGeometry, Cell, Point } from './types';

export function createEmptyBoard(columns: number, rows: number): Board {
  return Array.from({ length: rows }, () => Array<ColorValue>(columns).fill(null));
}

type ColorValue = number | null;

export function cloneBoard(board: Board): Board {
  return board.map((row) => [...row]);
}

export function isInside(board: Board, cell: Cell): boolean {
  return cell.row >= 0 && cell.row < board.length && cell.col >= 0 && cell.col < board[cell.row].length;
}

export function cellKey(cell: Cell): string {
  return `${cell.row}:${cell.col}`;
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.row === b.row && a.col === b.col;
}

export function neighbors(cell: Cell, columns: number, rows: number, rowOffset = 0): Cell[] {
  const offsets = (cell.row + rowOffset) % 2 === 0
    ? [[0, -1], [0, 1], [-1, -1], [-1, 0], [1, -1], [1, 0]]
    : [[0, -1], [0, 1], [-1, 0], [-1, 1], [1, 0], [1, 1]];

  return offsets
    .map(([rowDelta, colDelta]) => ({ row: cell.row + rowDelta, col: cell.col + colDelta }))
    .filter((candidate) => candidate.row >= 0 && candidate.row < rows && candidate.col >= 0 && candidate.col < columns);
}

export function cellToPoint(cell: Cell, geometry: BoardGeometry): Point {
  return {
    x: geometry.baseX + cell.col * geometry.radius * 2 + ((cell.row + (geometry.rowOffset ?? 0)) % 2 === 1 ? geometry.radius : 0),
    y: geometry.baseY + cell.row * geometry.rowStep,
  };
}

export function occupiedCells(board: Board): Cell[] {
  const cells: Cell[] = [];
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board[row].length; col += 1) {
      if (board[row][col] !== null) cells.push({ row, col });
    }
  }
  return cells;
}

export function connectedCells(board: Board, start: Cell, predicate: (cell: Cell) => boolean, rowOffset = 0): Cell[] {
  if (!isInside(board, start) || !predicate(start)) return [];

  const result: Cell[] = [];
  const queue: Cell[] = [start];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const key = cellKey(current);
    if (visited.has(key)) continue;
    visited.add(key);
    if (!predicate(current)) continue;
    result.push(current);
    for (const next of neighbors(current, board[0].length, board.length, rowOffset)) {
      if (!visited.has(cellKey(next))) queue.push(next);
    }
  }

  return result;
}

export function findGroup(board: Board, start: Cell, rowOffset = 0): Cell[] {
  const color = isInside(board, start) ? board[start.row][start.col] : null;
  if (color === null) return [];
  return connectedCells(board, start, (cell) => board[cell.row][cell.col] === color, rowOffset);
}

export function findTopConnected(board: Board, rowOffset = 0): Set<string> {
  const connected = new Set<string>();
  const queue: Cell[] = [];
  for (let col = 0; col < board[0].length; col += 1) {
    if (board[0][col] !== null) queue.push({ row: 0, col });
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const key = cellKey(current);
    if (connected.has(key) || board[current.row][current.col] === null) continue;
    connected.add(key);
    for (const next of neighbors(current, board[0].length, board.length, rowOffset)) {
      if (!connected.has(cellKey(next))) queue.push(next);
    }
  }

  return connected;
}

export function hasOccupiedAtOrBelow(board: Board, row: number): boolean {
  return occupiedCells(board).some((cell) => cell.row >= row);
}

export function activeColors(board: Board): number[] {
  return [...new Set(occupiedCells(board).map((cell) => board[cell.row][cell.col]).filter((value): value is number => value !== null))].sort((a, b) => a - b);
}

export function boardIsEmpty(board: Board): boolean {
  return occupiedCells(board).length === 0;
}

