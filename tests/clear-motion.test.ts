import { describe, expect, it } from 'vitest';
import { clearMotionSeed, clearOrbPose, clearParticleCap, clearParticlePose, createClearParticles, V5_CLEAR_MOTION } from '../src/render/clear-motion';

describe('shared V5 clear motion', () => {
  it('uses one 720 ms alpha and the exact confirmed parabolic path for matched and dropped balls', () => {
    const matched = { color: 0xff0000, x: 320, y: 180, index: 0, falling: false };
    const dropped = { ...matched, falling: true };
    for (const elapsed of [0, 80, 160, 320, 500, 719, 720, 1000]) {
      const a = clearOrbPose(matched, elapsed), b = clearOrbPose(dropped, elapsed);
      expect(b).toEqual(a);
      expect(a.scale).toBe(1);
      const p = Math.max(0, Math.min(1, elapsed / 720));
      expect(a.alpha).toBeCloseTo((1 - p) ** 1.15);
      if (elapsed <= 720) {
        const t = p * .72, vx = 60, ax = 140;
        const d = vx * t + .5 * ax * t * t, end = vx * .72 + .5 * ax * .72 * .72, u = d / end;
        expect(a.x).toBeCloseTo(matched.x - d);
        expect(a.y).toBeCloseTo(matched.y + 420 * u * u - 144 * u);
        expect(a.rotation).toBeCloseTo(-.28 * p);
      }
    }
    expect(V5_CLEAR_MOTION.matchMs).toBe(V5_CLEAR_MOTION.fallMs);
    expect(V5_CLEAR_MOTION.matchMs).toBe(720);
  });

  it('keeps a stationary 320 ms base fade when reduced motion is enabled', () => {
    const orb = { x: 12, y: 30, index: 2, falling: true };
    const half = clearOrbPose(orb, 160, true);
    expect(half).toMatchObject({ x: 12, y: 30, rotation: 0, scale: 1, alpha: expect.any(Number) });
    expect(half.alpha).toBeCloseTo(.5 ** 1.15);
    expect(clearOrbPose(orb, 320, true)).toMatchObject({ x: 12, y: 30, rotation: 0, scale: 1, alpha: 0 });
  });

  it('keeps the platform particle budgets, per-ball round robin, stable radii and event-specific seeds', () => {
    const orbs = Array.from({ length: 12 }, (_, index) => ({ color: index % 6, x: index, y: 100, index, falling: index > 3 }));
    const windows = createClearParticles(orbs, { platform: 'windows', seed: clearMotionSeed('event', 12) });
    const android = createClearParticles(orbs, { platform: 'android', seed: clearMotionSeed('event', 12) });
    expect(windows).toHaveLength(168); expect(android).toHaveLength(120);
    expect(clearParticleCap('windows')).toBe(192); expect(clearParticleCap('android')).toBe(144);
    for (const particles of [windows, android]) {
      expect(new Set(particles.map(particle => particle.sourceIndex)).size).toBe(orbs.length);
      for (const orb of orbs) expect(particles.filter(particle => particle.sourceIndex === orb.index).length).toBeGreaterThan(0);
      expect(particles).toEqual(createClearParticles(orbs, { platform: particles === windows ? 'windows' : 'android', seed: clearMotionSeed('event', 12) }));
      expect(particles.every(particle => clearParticlePose(particle, 720).alpha === 0)).toBe(true);
      expect(particles.every(particle => clearParticlePose(particle, 100).radius === particle.radius)).toBe(true);
    }
    expect(windows).not.toEqual(createClearParticles(orbs, { platform: 'windows', seed: clearMotionSeed('event', 13) }));
    expect(createClearParticles(Array.from({ length: 100 }, (_, index) => ({ ...orbs[0], index })), { platform: 'windows' })).toHaveLength(192);
    expect(createClearParticles(orbs, { platform: 'windows', role: 'thumbnail' }).length).toBeLessThan(windows.length);
    expect(createClearParticles(orbs, { platform: 'android', role: 'thumbnail' }).length).toBeLessThan(android.length);
  });
});
