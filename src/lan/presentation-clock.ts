interface PresentationSample {
  matchId: string;
  epoch: number;
  phase: string;
  time: number;
  end: number;
  sampledAt: number;
}

/** Display time only: never feeds authority advancement, cooldowns or input permission. */
export class PresentationClock {
  private key = '';
  private last = 0;
  private finishedAt = 0;
  private finishedTime = 0;
  reset(): void { this.key = ''; this.last = this.finishedAt = this.finishedTime = 0; }
  sample(value: PresentationSample, now: number): number {
    const key = `${value.matchId}:${value.epoch}:${value.phase}`;
    if (key !== this.key) {
      this.key = key; this.last = value.time;
      this.finishedAt = now; this.finishedTime = value.time;
    }
    if (value.phase === 'finished') return this.last = this.finishedTime + Math.min(2000, Math.max(0, now - this.finishedAt));
    if (value.phase !== 'playing') return this.last = value.time;
    const candidate = Math.min(value.end, value.time + Math.min(1200, Math.max(0, now - value.sampledAt)));
    return this.last = Math.min(value.end, Math.max(this.last, candidate));
  }
}
