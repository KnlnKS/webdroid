const ligatures: Record<string, string> = { fi: "\uFB01", fl: "\uFB02", ffi: "\uFB03", ffl: "\uFB04" };

export function shapeLigatures(text: string): string {
  return text.replace(/ff[il]|f[il]/g, sequence => ligatures[sequence]!);
}

export function ligatureBoundary(text: string, start: number, end: number): number {
  for (let at = Math.max(start, end - 3); at < end; at++) {
    const length = text.startsWith("ffi", at) || text.startsWith("ffl", at) ? 3
      : text.startsWith("fi", at) || text.startsWith("fl", at) ? 2 : 0;
    if (at + length > end) return at > start ? at : at + length;
  }
  return end;
}
