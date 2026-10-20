/** Decorative motion only. These values never enter rules, shot timing or RNG. */
export const V5_CLEAR_MOTION = {
  matchMs: 520, fallMs: 1050,
  scoreMs: 1250, particleMs: 560, maxParticles: 54, androidMaxParticles: 30,
} as const;

export interface ClearOrb { color: number; x: number; y: number; index: number; falling: boolean }
export interface ClearParticle { color: number; x: number; y: number; vx: number; vy: number; radius: number }
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Keep the patterned orb legible until the final third of its fall. */
export function clearOrbPose(item: Pick<ClearOrb, 'x' | 'y' | 'index' | 'falling'>, elapsedMs: number) {
  const p = clamp(elapsedMs / (item.falling ? V5_CLEAR_MOTION.fallMs : V5_CLEAR_MOTION.matchMs));
  const direction = item.index % 2 ? 1 : -1;
  const spread = (item.falling ? 32 : 24) + item.index % 4 * 11;
  return {
    x: item.x + direction * spread * Math.sin(p * Math.PI / 2),
    y: item.y + (item.falling ? 390 * (0.25 * p + 0.75 * p * p) : 155 * p * p - 22 * Math.sin(p * Math.PI)),
    scale: 1 - (item.falling ? .12 : .35) * p,
    rotation: direction * (item.falling ? .68 : .42) * p,
    alpha: clamp((1 - p) / .32),
  };
}

/** Deterministic, capped samples; never consume the gameplay random stream. */
export function createClearParticles(orbs: readonly ClearOrb[], budget: number = V5_CLEAR_MOTION.maxParticles): ClearParticle[] {
  const limit = Math.min(V5_CLEAR_MOTION.maxParticles, Math.max(0, Math.floor(budget)));
  if (!limit) return [];
  const stride = Math.max(1, Math.ceil(orbs.length / (limit / 3)));
  const particles: ClearParticle[] = [];
  for (let index = 0; index < orbs.length; index += stride) {
    const orb = orbs[index];
    for (let ray = 0; ray < 3 && particles.length < limit; ray++) {
      const angle = ((index * 47 + ray * 120) % 360) * Math.PI / 180;
      const speed = 42 + (index + ray) % 4 * 13;
      particles.push({ color: orb.color, x: orb.x, y: orb.y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 38,
        radius: 2 + (index + ray) % 3 * .8 });
    }
  }
  return particles;
}

export function clearParticlePose(particle: ClearParticle, elapsedMs: number) {
  const p = clamp(elapsedMs / V5_CLEAR_MOTION.particleMs);
  return { x: particle.x + particle.vx * p, y: particle.y + particle.vy * p + 105 * p * p,
    radius: particle.radius * (1 - .6 * p), alpha: .78 * (1 - p) };
}
