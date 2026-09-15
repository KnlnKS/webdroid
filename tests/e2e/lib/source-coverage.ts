type CoverageRange = { startOffset: number; endOffset: number; count: number };
export type CoverageFunction = { functionName: string; ranges: CoverageRange[] };

type SourceMap = { mappings: string; sources: string[] };
type MappingPoint = { offset: number; source: string };

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVlq(text: string, start: number): [number, number] {
  let value = 0;
  let shift = 0;
  let at = start;
  for (;;) {
    const digit = BASE64.indexOf(text[at++]);
    if (digit < 0) throw new Error("invalid source map VLQ");
    value |= (digit & 31) << shift;
    if (!(digit & 32)) break;
    shift += 5;
  }
  return [(value & 1 ? -1 : 1) * (value >> 1), at];
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function decodeMappings(map: SourceMap, generatedSource: string): MappingPoint[] {
  const starts = lineStarts(generatedSource);
  const points: MappingPoint[] = [];
  let at = 0;
  let line = 0;
  let column = 0;
  let sourceIndex = 0;
  while (at < map.mappings.length) {
    const separator = map.mappings[at];
    if (separator === ";") { line++; column = 0; at++; continue; }
    if (separator === ",") { at++; continue; }

    const fields: number[] = [];
    while (at < map.mappings.length && map.mappings[at] !== "," && map.mappings[at] !== ";") {
      const [value, next] = decodeVlq(map.mappings, at);
      fields.push(value);
      at = next;
    }
    column += fields[0] ?? 0;
    if (fields.length < 4) continue;
    sourceIndex += fields[1]!;
    const source = map.sources[sourceIndex];
    const offset = starts[line] === undefined ? undefined : starts[line]! + column;
    if (source && offset !== undefined) points.push({ offset, source: source.replace(/^\.\//, "") });
  }
  return points;
}

function lowerBound(points: MappingPoint[], offset: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (points[mid]!.offset < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function executedSources(points: MappingPoint[], functions: CoverageFunction[]): string[] {
  const files = new Set<string>();
  for (const fn of functions) {
    if (!fn.functionName) continue;
    for (const range of fn.ranges) {
      if (!range.count) continue;
      for (let i = lowerBound(points, range.startOffset); i < points.length && points[i]!.offset < range.endOffset; i++) {
        const source = points[i]!.source;
        if (source.startsWith("src/") || source.startsWith("tests/")) files.add(source);
      }
    }
  }
  return [...files].sort();
}
