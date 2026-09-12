// Integral of angular speed: 18 deg/s initially, +60 deg/s each second,
// capped at 90 deg/s. Integrating time makes movement independent of FPS.
export function heldRotationDegrees(seconds: number): number {
  const t = Math.max(0, seconds);
  const ramp = Math.min(t, 1.2);
  return 18 * ramp + 30 * ramp * ramp + 90 * Math.max(0, t - 1.2);
}
