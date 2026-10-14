import { traceShot } from './physics';
import type { Board, BoardGeometry, Cell } from './types';

export interface LandingTolerance {
  landing: Cell;
  minAngle: number;
  maxAngle: number;
  width: number;
  capped: boolean;
}
/** Local sampled interval around a reference angle, not a proof of human playability. */
export function landingTolerance(board: Board, degrees: number, geometry: BoardGeometry, step = 0.05, radius = 12): LandingTolerance | null {
  if (!Number.isFinite(degrees) || Math.abs(degrees) > 78 || !Number.isFinite(step) || step <= 0 || !Number.isFinite(radius) || radius <= 0) return null;
  const reference = traceShot(board, degrees * Math.PI / 180, geometry).landing;
  if (!reference) return null;
  const same = (angle: number) => {
    const landing = traceShot(board, angle * Math.PI / 180, geometry).landing;
    return landing?.row === reference.row && landing.col === reference.col;
  };
  let capped = false;
  const boundary = (direction: -1 | 1) => {
    const limit = Math.max(-78, Math.min(78, degrees + direction * radius));
    let valid = degrees;
    while (Math.abs(valid - limit) > 0.000001) {
      const probe = direction === 1 ? Math.min(limit, valid + step) : Math.max(limit, valid - step);
      if (!same(probe)) {
        let outside = probe;
        for (let iteration = 0; iteration < 8 && Math.abs(outside - valid) > 0.005; iteration++) {
          const middle = (valid + outside) / 2;
          if (same(middle)) valid = middle; else outside = middle;
        }
        return valid;
      }
      valid = probe;
    }
    capped = true;
    return valid;
  };
  const minAngle = boundary(-1), maxAngle = boundary(1);
  return { landing: reference, minAngle, maxAngle, width: maxAngle - minAngle, capped };
}
