// Preview model only. Production 5.1.0 rules and renderers are not modified.
export const MOTION = Object.freeze({ fullMs: 720, reducedMs: 320, particleMs: 720, windowsCap: 192, androidCap: 144, cycleMs: 3400, hitAtMs: 1000,
  outwardSpeed: 60, outwardAcceleration: 140, arcCurvature: 420, arcLift: 144 });
export const clamp01 = n => Math.max(0, Math.min(1, n));
export function orbPose(orb, elapsedMs, reduced = false) {
  const p = clamp01(elapsedMs / (reduced ? MOTION.reducedMs : MOTION.fullMs));
  const direction = orb.index % 2 ? 1 : -1;
  const t = p * MOTION.fullMs / 1000;
  const vx = MOTION.outwardSpeed + orb.index % 3 * 6;
  const ax = MOTION.outwardAcceleration + orb.index % 4 * 30;
  const distance = vx * t + .5 * ax * t * t;
  const endT = MOTION.fullMs / 1000;
  const endDistance = vx * endT + .5 * ax * endT * endT;
  const u = clamp01(distance / endDistance);
  // Matched and detached use exactly the same clock, movement, scale and alpha.
  // Accelerate along a true spatial parabola, rather than easing x and y separately.
  return { x: orb.x + (reduced ? 0 : direction * distance),
    y: orb.y + (reduced ? 0 : MOTION.arcCurvature * u * u - MOTION.arcLift * u),
    rotation: reduced ? 0 : direction * .28 * p,
    scale: 1, alpha: Math.pow(1 - p, 1.15), progress: p, pathProgress: reduced ? 0 : u };
}
export function seeded(seed) {
  let state = seed >>> 0;
  return () => { let t = state += 0x6d2b79f5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function deriveSeed(matchSeed, playerId, wave, domain) {
  let h = (matchSeed ^ 0x811c9dc5) >>> 0;
  const text = `${playerId}\0${wave}\0${domain}`;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  h = Math.imul(h ^ h >>> 16, 0x85ebca6b); h = Math.imul(h ^ h >>> 13, 0xc2b2ae35);
  return ((h ^ h >>> 16) >>> 0) || 0x1a2b3c4d;
}
export function independentPlayer(matchSeed, playerId, wave = 0) {
  const boardSeed = deriveSeed(matchSeed, playerId, wave, 'board-v1');
  const supplySeed = deriveSeed(matchSeed, playerId, wave, 'supply-v1');
  const boardRandom = seeded(boardSeed), supplyRandom = seeded(supplySeed);
  // Equal difficulty/ball count/color quota; independently shuffle every position.
  const cells = Array.from({ length: 7 * 14 }, (_, i) => i % 5);
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(boardRandom() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  const board = Array.from({ length: 7 }, (_, row) => cells.slice(row * 14, row * 14 + 14));
  const queue = Array.from({ length: 8 }, () => Math.floor(supplyRandom() * 5));
  return { playerId, wave, boardSeed, supplySeed, board, queue };
}
export function clearParticles(orbs, platform = 'windows', reduced = false) {
  if (reduced) return [];
  const cap = platform === 'android' ? MOTION.androidCap : MOTION.windowsCap;
  const perOrb = platform === 'android' ? 10 : 14;
  const count = Math.min(cap, orbs.length * perOrb);
  const random = seeded(0x5200);
  return Array.from({ length: count }, (_, index) => {
    // Round-robin allocation gives every detached and matched ball some particles.
    const orb = orbs[index % orbs.length], angle = random() * Math.PI * 2;
    const speed = 28 + random() * 88;
    return { color: orb.color, x: orb.x, y: orb.y, vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 25, radius: 1.2 + random() * 2.3, alpha: .35 + random() * .4,
      tail: index % 5 === 0, sourceIndex: orb.index };
  });
}
export function particlePose(particle, elapsedMs) {
  const p = clamp01(elapsedMs / MOTION.particleMs);
  const drag = (1 - Math.exp(-2.2 * p)) / (1 - Math.exp(-2.2));
  return { x: particle.x + particle.vx * drag, y: particle.y + particle.vy * drag + 66 * p * p,
    radius: particle.radius, alpha: particle.alpha * Math.pow(1 - p, 1.3) };
}
export function sceneClock(cycleMs) {
  const hitElapsed = cycleMs - MOTION.hitAtMs;
  return { hitElapsed, beforeHit: hitElapsed < 0, resetAlpha: cycleMs > 3000 ? clamp01((cycleMs - 3000) / 400) : 0 };
}
