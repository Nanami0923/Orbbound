// Smoothstep speed ramp: 12 -> 96 deg/s over 1.8 seconds. Acceleration
// starts and ends at zero; integrating the curve keeps movement independent of FPS.
export const ROTATION_RAMP_SECONDS = 1.8;
export const ROTATION_MIN_SPEED = 12;
export const ROTATION_MAX_SPEED = 96;
export function heldRotationDegrees(seconds: number): number {
  const t = Math.max(0, seconds);
  const ramp = Math.min(t, ROTATION_RAMP_SECONDS);
  const u = ramp / ROTATION_RAMP_SECONDS;
  return ROTATION_MIN_SPEED * ramp
    + (ROTATION_MAX_SPEED - ROTATION_MIN_SPEED) * ROTATION_RAMP_SECONDS * (u ** 3 - u ** 4 / 2)
    + ROTATION_MAX_SPEED * Math.max(0, t - ROTATION_RAMP_SECONDS);
}

export function fineRotationSpeed(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const position = Math.max(-1, Math.min(1, value / 100));
  const magnitude = Math.max(0, (Math.abs(position) - 0.04) / 0.96);
  return Math.sign(position) * 60 * magnitude * magnitude;
}
