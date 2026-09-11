import { cellKey, cellToPoint, neighbors, occupiedCells } from './grid';
import type { Board, BoardGeometry, Cell, Point, ShotTrace } from './types';

const STEP = 3;
const MAX_STEPS = 1400;

function distanceSquared(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function isEmpty(board: Board, cell: Cell): boolean {
  return board[cell.row]?.[cell.col] === null;
}

function isLegalAttachment(board: Board, cell: Cell, rowOffset = 0): boolean {
  if (!isEmpty(board, cell)) return false;
  if (cell.row === 0) return true;
  return neighbors(cell, board[0].length, board.length, rowOffset)
    .some((neighbor) => board[neighbor.row][neighbor.col] !== null);
}

function doesNotOverlap(board: Board, candidate: Cell, geometry: BoardGeometry): boolean {
  const point = cellToPoint(candidate, geometry);
  const minimum = geometry.radius * 2 - 0.8;
  return occupiedCells(board).every((cell) => distanceSquared(point, cellToPoint(cell, geometry)) >= minimum * minimum);
}

function chooseLanding(board: Board, contact: Point, geometry: BoardGeometry, topOnly = false): Cell | null {
  const candidates: Array<{ cell: Cell; distance: number }> = [];
  for (let row = 0; row < geometry.maxRows; row += 1) {
    for (let col = 0; col < geometry.columns; col += 1) {
      const cell = { row, col };
      if (topOnly && row !== 0) continue;
      if (!isLegalAttachment(board, cell, geometry.rowOffset) || !doesNotOverlap(board, cell, geometry)) continue;
      const point = cellToPoint(cell, geometry);
      candidates.push({ cell, distance: distanceSquared(point, contact) });
    }
  }

  candidates.sort((a, b) => a.distance - b.distance || a.cell.row - b.cell.row || a.cell.col - b.cell.col);
  return candidates[0]?.cell ?? null;
}

export function angleToDirection(angle: number): Point {
  return { x: Math.sin(angle), y: -Math.cos(angle) };
}

export function traceShot(board: Board, angle: number, geometry: BoardGeometry): ShotTrace {
  let position: Point = { x: geometry.launcherX, y: geometry.launcherY - geometry.radius - 3 };
  let direction = angleToDirection(angle);
  const points: Point[] = [{ ...position }];
  let bounced = false;
  const collisionDistance = geometry.radius * 2 - 0.5;
  const occupiedPoints = occupiedCells(board).map(cell => cellToPoint(cell, geometry));

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const next = { x: position.x + direction.x * STEP, y: position.y + direction.y * STEP };

    if (next.x <= geometry.left + geometry.radius) {
      next.x = geometry.left + geometry.radius;
      direction = { x: Math.abs(direction.x), y: direction.y };
      bounced = true;
      points.push({ ...next });
      position = next;
      continue;
    }
    if (next.x >= geometry.right - geometry.radius) {
      next.x = geometry.right - geometry.radius;
      direction = { x: -Math.abs(direction.x), y: direction.y };
      bounced = true;
      points.push({ ...next });
      position = next;
      continue;
    }

    if (next.y <= geometry.top + geometry.radius) {
      const landing = chooseLanding(board, { x: next.x, y: geometry.top + geometry.radius }, geometry, true);
      return { points: [...points, { x: next.x, y: geometry.top + geometry.radius }], landing, bounced, reason: landing ? 'top' : 'overflow' };
    }

    const collision = occupiedPoints.some(point => distanceSquared(next, point) <= collisionDistance * collisionDistance);
    points.push({ ...next });
    if (collision) {
      const landing = chooseLanding(board, next, geometry);
      return { points, landing, bounced, reason: landing ? 'bubble' : 'overflow' };
    }

    position = next;
  }

  const fallback = chooseLanding(board, position, geometry);
  return { points, landing: fallback, bounced, reason: fallback ? 'bubble' : 'overflow' };
}

export function cellSet(cells: Cell[]): Set<string> {
  return new Set(cells.map(cellKey));
}

