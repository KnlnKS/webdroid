export class Random {
  readonly seed: number;
  private state: number;

  constructor(seed: number) {
    this.seed = seed;
    this.state = seed >>> 0;
  }

  next(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state / 0x1_0000_0000;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(values: readonly T[]): T {
    if (!values.length) throw new Error("cannot pick from an empty list");
    return values[this.int(0, values.length - 1)]!;
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}
