export function sampleError(sample: { error?: string; result: string; completedCalls: number; first: number; steady: number }, expected: string, calls?: number): string | undefined {
  if (sample.error) return sample.error;
  if (sample.result !== expected) return "result differs";
  if (calls !== undefined && sample.completedCalls !== calls) return "incomplete call count";
  if (![sample.first, sample.steady].every(time => Number.isFinite(time) && time > 0)) return "invalid timing sample";
}
export const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
export const geo = (a: number[]) => Math.exp(a.reduce((s, x) => s + Math.log(x), 0) / a.length);
