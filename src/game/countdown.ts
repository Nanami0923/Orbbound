import { shotsUntilDescent } from '../core/engine';

// Both bars count down from full to empty. Use the interval fixed at the last
// descent, not the shrinking interval for a future descent.
export function countdownProgress(difficultyId: string, danger: number, remainingMs: number, intervalMs: number) {
  const remainingShots = shotsUntilDescent(difficultyId, danger);
  return {
    remainingShots,
    shotPercent: Math.max(0, Math.min(100, remainingShots / shotsUntilDescent(difficultyId, 0) * 100)),
    timePercent: intervalMs > 0 ? Math.max(0, Math.min(100, remainingMs / intervalMs * 100)) : 0,
  };
}
