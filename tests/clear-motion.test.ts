import { describe, expect, it } from 'vitest';
import { clearOrbPose, clearParticlePose, createClearParticles, V5_CLEAR_MOTION } from '../src/render/clear-motion';

describe('bounded decorative clear motion', () => {
  it('starts match and drop motion on the same hit frame with distinct early paths', () => {
    const orb = { x: 320, y: 180, index: 0, falling: true };
    expect(clearOrbPose(orb, 0)).toMatchObject({ x: 320, y: 180, alpha: 1 });
    const match = { ...orb, index: 1, falling: false };
    expect(clearOrbPose(match, 0)).toMatchObject({ x: 320, y: 180, alpha: 1 });

    const firstFrame = clearOrbPose(orb, 16), matchFrame = clearOrbPose(match, 16);
    expect(firstFrame.y).toBeGreaterThan(orb.y);
    expect(matchFrame.y).toBeLessThan(match.y);
    expect(firstFrame.x).not.toBe(orb.x);
    expect(matchFrame.x).not.toBe(match.x);

    // Index controls lateral direction only; a large drop batch never staggers start time.
    const lateIndex = clearOrbPose({ ...orb, index: 99 }, 16);
    expect(lateIndex.y - orb.y).toBeCloseTo(firstFrame.y - orb.y);
    expect(clearOrbPose(orb, V5_CLEAR_MOTION.fallMs)).toMatchObject({ y: 570, alpha: 0 });
    expect(clearOrbPose(match, V5_CLEAR_MOTION.matchMs).alpha).toBe(0);
  });

  it('caps a whole-board burst without touching the cells or consuming random numbers', () => {
    const cells = Array.from({ length: 266 }, (_, index) => Object.freeze({ x: index, y: 100, index, falling: index > 3, color: index % 6 }));
    const before = JSON.stringify(cells), burst = createClearParticles(cells);
    expect(burst.length).toBeLessThanOrEqual(V5_CLEAR_MOTION.maxParticles);
    expect(burst).toEqual(createClearParticles(cells));
    expect(JSON.stringify(cells)).toBe(before);
    for (const particle of burst) expect(clearParticlePose(particle, 2000).alpha).toBe(0);
  });
});
