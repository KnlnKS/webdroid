export function sampleError(sample: { error?: string; result: string; completedCalls: number; first: number; steady: number }, expected: string, calls?: number): string | undefined {
  if (sample.error) return sample.error;
  if (sample.result !== expected) return "result differs";
  if (calls !== undefined && sample.completedCalls !== calls) return "incomplete call count";
  if (![sample.first, sample.steady].every(time => Number.isFinite(time) && time > 0)) return "invalid timing sample";
}
