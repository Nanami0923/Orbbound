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

function doesNotOverlap(occupiedPoints: Point[], candidate: Cell, geometry: BoardGeometry): boolean {
  const point = cellToPoint(candidate, geometry);
  const minimum = geometry.radius * 2 - 0.8;
  return occupiedPoints.every((occupied) => distanceSquared(point, occupied) >= minimum * minimum);
}

function chooseLanding(board: Board, contact: Point, geometry: BoardGeometry, occupiedPoints: Point[], topOnly = false): Cell | null {
  let best: Cell | null = null;
  let bestDistance = Infinity;
  for (let row = 0; row < geometry.maxRows; row += 1) {
    for (let col = 0; col < geometry.columns; col += 1) {
      const cell = { row, col };
      if (topOnly && row !== 0) continue;
      if (!isLegalAttachment(board, cell, geometry.rowOffset) || !doesNotOverlap(occupiedPoints, cell, geometry)) continue;
      const point = cellToPoint(cell, geometry);
      const distance = distanceSquared(point, contact);
      if (distance < bestDistance) { bestDistance = distance; best = cell; }
    }
  }

  return best;
}

export function angleToDirection(angle: number): Point {
  return { x: Math.sin(angle), y: -Math.cos(angle) };
}

export function traceShot(board: Board, angle: number, geometry: BoardGeometry): ShotTrace {
  let direction = angleToDirection(angle);
  // Keep the trajectory on the rotating barrel axis at every aiming angle.
  const muzzleOffset = geometry.radius + 3;
  let position: Point = { x: geometry.launcherX + direction.x * muzzleOffset, y: geometry.launcherY + direction.y * muzzleOffset };
  const points: Point[] = [{ ...position }];
  let bounced = false;
  const collisionDistance = geometry.radius * 2 - 0.5;
  const occupiedPoints = occupiedCells(board).map(cell => cellToPoint(cell, geometry));
  // A projectile can collide only with points in its own or adjacent vertical bands.
  const bands: Point[][] = [];
  for (const point of occupiedPoints) (bands[Math.floor(point.y / collisionDistance)] ??= []).push(point);
  const collides = (next: Point): boolean => {
    const band = Math.floor(next.y / collisionDistance);
    for (let index = band - 1; index <= band + 1; index++) {
      const points = bands[index];
      if (!points) continue;
      for (const point of points) {
        if (Math.abs(next.x - point.x) <= collisionDistance && distanceSquared(next, point) <= collisionDistance * collisionDistance) return true;
      }
    }
    return false;
  };

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
      const landing = chooseLanding(board, { x: next.x, y: geometry.top + geometry.radius }, geometry, occupiedPoints, true);
      return { points: [...points, { x: next.x, y: geometry.top + geometry.radius }], landing, bounced, reason: landing ? 'top' : 'overflow' };
    }

    const collision = collides(next);
    points.push({ ...next });
    if (collision) {
      const landing = chooseLanding(board, next, geometry, occupiedPoints);
      return { points, landing, bounced, reason: landing ? 'bubble' : 'overflow' };
    }

    position = next;
  }

  const fallback = chooseLanding(board, position, geometry, occupiedPoints);
  return { points, landing: fallback, bounced, reason: fallback ? 'bubble' : 'overflow' };
}

export function cellSet(cells: Cell[]): Set<string> {
  return new Set(cells.map(cellKey));
}

