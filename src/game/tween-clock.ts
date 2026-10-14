interface TweenClock {
  time?: number;
  startTime?: number;
  prevTime?: number;
  nextTime?: number;
  gap?: number;
}

/** Phaser 3.90 tweens use Date.now rather than the scene delta; exclude a slept menu explicitly. */
export function rebaseTweenClock(clock: TweenClock, now = Date.now()): void {
  if (typeof clock.time !== 'number' || !Number.isFinite(clock.time)) return;
  clock.prevTime = now;
  clock.startTime = now - clock.time * 1000;
  clock.nextTime = clock.time * 1000 + (typeof clock.gap === 'number' && clock.gap > 0 ? clock.gap : 1000 / 240);
}
