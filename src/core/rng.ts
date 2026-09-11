export class SeededRandom {
  private value: number;

  public constructor(seed: number) {
    this.value = (seed >>> 0) || 0x6d2b79f5;
  }

  public next(): number {
    let t = (this.value += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  public nextInt(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  public getState(): number {
    return this.value >>> 0;
  }
}

export function normalizeSeed(seed: number): number {
  const normalized = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : 1;
  return normalized || 0x1a2b3c4d;
}

