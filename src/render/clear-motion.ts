/** Cosmetic clear motion only. These values never enter rules, shot timing or RNG. */
export const V5_CLEAR_MOTION = {
  fullMs: 720,
  reducedMs: 320,
  matchMs: 720,
  fallMs: 720,
  scoreMs: 1250,
  particleMs: 720,
  windowsParticlesPerOrb: 14,
  androidParticlesPerOrb: 10,
  maxParticles: 192,
  androidMaxParticles: 144,
  thumbnailMaxParticles: 36,
  androidThumbnailMaxParticles: 24,
  thumbnailParticlesPerOrb: 3,
  outwardSpeed: 60,
  outwardAcceleration: 140,
  arcCurvature: 420,
  arcLift: 144,
} as const;

export type ClearPlatform = 'windows' | 'android';
export type ClearBoardRole = 'main' | 'thumbnail' | 'observation';

export interface ClearOrb { color: number; x: number; y: number; index: number; falling: boolean }
export interface ClearParticle {
  color: number; x: number; y: number; vx: number; vy: number; radius: number;
  alpha: number; tail: boolean; sourceIndex: number;
}

export interface ClearParticleOptions {
  platform?: ClearPlatform;
  role?: ClearBoardRole;
  budget?: number;
  seed?: number | string;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function clearMotionPlatform(): ClearPlatform {
  return typeof document !== 'undefined' && document.documentElement?.classList?.contains('android-v5') ? 'android' : 'windows';
}

export function clearParticleCap(platform: ClearPlatform, role: ClearBoardRole = 'main'): number {
  if (role === 'thumbnail') return platform === 'android'
    ? V5_CLEAR_MOTION.androidThumbnailMaxParticles : V5_CLEAR_MOTION.thumbnailMaxParticles;
  return platform === 'android' ? V5_CLEAR_MOTION.androidMaxParticles : V5_CLEAR_MOTION.maxParticles;
}

/** Stable cosmetic-only seed derivation. It must never share the game RNG stream. */
export function clearMotionSeed(...parts: Array<string | number>): number {
  let hash = 0x811c9dc5;
  const text = parts.join('\0');
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  hash = Math.imul(hash ^ hash >>> 16, 0x85ebca6b);
  hash = Math.imul(hash ^ hash >>> 13, 0xc2b2ae35);
  return ((hash ^ hash >>> 16) >>> 0) || 0x5200;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    let value = state += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Match and detached orbs share one impact clock and the confirmed demo's
 * accelerated horizontal distance mapped onto a true spatial parabola.
 */
export function clearOrbPose(item: Pick<ClearOrb, 'x' | 'y' | 'index' | 'falling'>, elapsedMs: number, reduced = false) {
  const p = clamp(elapsedMs / (reduced ? V5_CLEAR_MOTION.reducedMs : V5_CLEAR_MOTION.fullMs));
  const direction = item.index % 2 ? 1 : -1;
  const t = p * V5_CLEAR_MOTION.fullMs / 1000;
  const vx = V5_CLEAR_MOTION.outwardSpeed + item.index % 3 * 6;
  const ax = V5_CLEAR_MOTION.outwardAcceleration + item.index % 4 * 30;
  const distance = vx * t + .5 * ax * t * t;
  const endT = V5_CLEAR_MOTION.fullMs / 1000;
  const endDistance = vx * endT + .5 * ax * endT * endT;
  const u = clamp(distance / endDistance);
  return {
    x: item.x + (reduced ? 0 : direction * distance),
    y: item.y + (reduced ? 0 : V5_CLEAR_MOTION.arcCurvature * u * u - V5_CLEAR_MOTION.arcLift * u),
    scale: 1,
    rotation: reduced ? 0 : direction * .28 * p,
    alpha: Math.pow(1 - p, 1.15),
    progress: p,
    pathProgress: reduced ? 0 : u,
  };
}

/** Deterministic round-robin samples, with a board-wide budget per display role. */
export function createClearParticles(orbs: readonly ClearOrb[], options: ClearParticleOptions = {}): ClearParticle[] {
  if (!orbs.length) return [];
  const platform = options.platform ?? clearMotionPlatform();
  const role = options.role ?? 'main';
  const perOrb = role === 'thumbnail' ? V5_CLEAR_MOTION.thumbnailParticlesPerOrb
    : platform === 'android' ? V5_CLEAR_MOTION.androidParticlesPerOrb : V5_CLEAR_MOTION.windowsParticlesPerOrb;
  const cap = clearParticleCap(platform, role);
  const requestedBudget = options.budget === undefined ? cap : Math.max(0, Math.floor(options.budget));
  const count = Math.min(cap, requestedBudget, orbs.length * perOrb);
  const random = seeded(typeof options.seed === 'number' ? options.seed : clearMotionSeed(options.seed ?? 0x5200));
  const particles: ClearParticle[] = [];
  for (let index = 0; index < count; index++) {
    const orb = orbs[index % orbs.length];
    const angle = random() * Math.PI * 2;
    const speed = 28 + random() * 88;
    particles.push({
      color: orb.color, x: orb.x, y: orb.y,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 25,
      radius: 1.2 + random() * 2.3,
      alpha: .35 + random() * .4,
      tail: index % 6 === 0,
      sourceIndex: orb.index,
    });
  }
  return particles;
}

export function clearParticlePose(particle: ClearParticle, elapsedMs: number) {
  const p = clamp(elapsedMs / V5_CLEAR_MOTION.particleMs);
  const drag = (1 - Math.exp(-2.2 * p)) / (1 - Math.exp(-2.2));
  return {
    x: particle.x + particle.vx * drag,
    y: particle.y + particle.vy * drag + 66 * p * p,
    radius: particle.radius,
    alpha: particle.alpha * Math.pow(1 - p, 1.3),
  };
}
