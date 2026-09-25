import { readFully, type FileSource } from "../shell/lazyfile";

const bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const lowBitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const rates = [44100, 48000, 32000];

function frame(bytes: Uint8Array, at: number) {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[at + 1] >> 3) & 3;
  if (version === 1 || (bytes[at + 1] & 6) !== 2) return null;
  const bitrate = (version === 3 ? bitrates : lowBitrates)[bytes[at + 2] >> 4];
  const rate = rates[(bytes[at + 2] >> 2) & 3] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  if (!bitrate || !rate) return null;
  const samples = version === 3 ? 1152 : 576;
  const size = Math.floor(samples / 8 * bitrate * 1000 / rate) + ((bytes[at + 2] >> 1) & 1);
  return { version, rate, samples, size, mono: (bytes[at + 3] & 0xc0) === 0xc0 };
}

export async function mpegAudioDuration(source: FileSource): Promise<number | null> {
  let chunk = await readFully(source, 0, Math.min(source.size, 131072));
  let start = 0;
  if (chunk.length >= 10 && chunk[0] === 0x49 && chunk[1] === 0x44 && chunk[2] === 0x33) {
    start = 10 + ((chunk[6] & 0x7f) << 21 | (chunk[7] & 0x7f) << 14 | (chunk[8] & 0x7f) << 7 | (chunk[9] & 0x7f));
    if (chunk[5] & 0x10) start += 10;
  }
  if (start >= source.size) return null;
  let searchBase = 0;
  if (start >= chunk.length) {
    searchBase = start;
    chunk = await readFully(source, start, Math.min(131072, source.size - start));
    start = 0;
  }
  for (let i = start; i + 4 < chunk.length; i++) {
    const first = frame(chunk, i);
    if (!first || i + first.size + 4 > chunk.length) continue;
    const second = frame(chunk, i + first.size);
    if (!second || first.version !== second.version || first.rate !== second.rate) continue;
    const xing = i + 4 + (first.version === 3 ? first.mono ? 17 : 32 : first.mono ? 9 : 17);
    if (xing + 12 <= chunk.length &&
      ((chunk[xing] === 0x58 && chunk[xing + 1] === 0x69 && chunk[xing + 2] === 0x6e && chunk[xing + 3] === 0x67) ||
       (chunk[xing] === 0x49 && chunk[xing + 1] === 0x6e && chunk[xing + 2] === 0x66 && chunk[xing + 3] === 0x6f)) &&
      (chunk[xing + 7] & 1)) {
      const count = (chunk[xing + 8] * 0x1000000 + (chunk[xing + 9] << 16) + (chunk[xing + 10] << 8) + chunk[xing + 11]) >>> 0;
      if (count) return Math.round(count * first.samples / first.rate * 1000);
    }
    let base = searchBase, offset = searchBase + i, samples = 0;
    while (offset + 4 <= source.size) {
      if (offset < base || offset + 4 > base + chunk.length) {
        base = offset;
        chunk = await readFully(source, base, Math.min(131072, source.size - base));
      }
      const next = frame(chunk, offset - base);
      if (!next || next.version !== first.version || next.rate !== first.rate || offset + next.size > source.size) break;
      samples += next.samples;
      offset += next.size;
    }
    return offset >= source.size - 4096 ? Math.round(samples / first.rate * 1000) : null;
  }
  return null;
}
