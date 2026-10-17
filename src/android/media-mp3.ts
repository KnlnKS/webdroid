import { readFully, type FileSource } from "../shell/lazyfile.ts";

type Mp3Info = { durationMs: number; bitrate: number; picture: Int8Array | null };

const be32 = (bytes: Uint8Array, offset: number) =>
  (bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
const syncSafe = (bytes: Uint8Array, offset: number) =>
  (bytes[offset] << 21) | (bytes[offset + 1] << 14) | (bytes[offset + 2] << 7) | bytes[offset + 3];

function frameHeader(bytes: Uint8Array, offset: number) {
  if (offset + 4 > bytes.length || bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe6) !== 0xe2) return null;
  const version = (bytes[offset + 1] >> 3) & 3;
  const bitrateIndex = bytes[offset + 2] >> 4, rateIndex = (bytes[offset + 2] >> 2) & 3;
  if (version === 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const rates = [44100, 48000, 32000];
  const bitrate = (version === 3
    ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144])[bitrateIndex] * 1000;
  const sampleRate = rates[rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
  const samples = version === 3 ? 1152 : 576;
  const length = Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + ((bytes[offset + 2] >> 1) & 1);
  return { bitrate, sampleRate, samples, length, version,
    mono: (bytes[offset + 3] >> 6) === 3, crc: !(bytes[offset + 1] & 1) };
}

function pictureFromTag(tag: Uint8Array, version: number): Int8Array | null {
  let offset = 0;
  while (offset + 10 <= tag.length) {
    const id = String.fromCharCode(...tag.subarray(offset, offset + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = version === 4 ? syncSafe(tag, offset + 4) : be32(tag, offset + 4);
    const end = offset + 10 + size;
    if (end > tag.length) break;
    if (id === "APIC" && size > 5) {
      let pos = offset + 11;
      while (pos < end && tag[pos]) pos++;
      pos += 2;
      const unicode = tag[offset + 10] === 1 || tag[offset + 10] === 2;
      if (unicode) {
        while (pos + 1 < end && (tag[pos] || tag[pos + 1])) pos += 2;
        pos += 2;
      } else {
        while (pos < end && tag[pos]) pos++;
        pos++;
      }
      if (pos < end) return new Int8Array(tag.slice(pos, end).buffer);
    }
    offset = end;
  }
  return null;
}

export async function inspectMp3(source: FileSource): Promise<Mp3Info | null> {
  const head = await readFully(source, 0, Math.min(source.size, 10));
  let audioStart = 0, picture: Int8Array | null = null;
  const id3 = head.length === 10 && String.fromCharCode(...head.subarray(0, 3)) === "ID3";
  if (!id3 && (head.length < 2 || head[0] !== 0xff || (head[1] & 0xe0) !== 0xe0)) return null;
  if (id3) {
    if (head[3] < 3 || head[3] > 4 || head.subarray(6, 10).some(byte => byte & 0x80)) return null;
    const tagSize = syncSafe(head, 6);
    audioStart = 10 + tagSize + (head[5] & 0x10 ? 10 : 0);
    if (audioStart >= source.size) return null;
    const tag = await readFully(source, 10, tagSize);
    if (tag.length !== tagSize) return null;
    picture = pictureFromTag(tag, head[3]);
  }
  const bytes = await readFully(source, audioStart, Math.min(65536, source.size - audioStart));
  for (let offset = 0; offset + 4 < bytes.length; offset++) {
    const frame = frameHeader(bytes, offset);
    if (!frame || offset + frame.length + 4 > bytes.length) continue;
    const next = frameHeader(bytes, offset + frame.length);
    if (!next || next.sampleRate !== frame.sampleRate || next.version !== frame.version) continue;
    audioStart += offset;
    const sideInfo = frame.version === 3 ? frame.mono ? 17 : 32 : frame.mono ? 9 : 17;
    const xing = offset + 4 + (frame.crc ? 2 : 0) + sideInfo;
    let durationMs = 0;
    if (xing + 12 <= bytes.length && /^(Xing|Info)$/.test(String.fromCharCode(...bytes.subarray(xing, xing + 4)))
      && (be32(bytes, xing + 4) & 1))
      durationMs = Math.round(be32(bytes, xing + 8) * frame.samples * 1000 / frame.sampleRate);
    const vbri = offset + 36;
    if (!durationMs && vbri + 18 <= bytes.length && String.fromCharCode(...bytes.subarray(vbri, vbri + 4)) === "VBRI")
      durationMs = Math.round(be32(bytes, vbri + 14) * frame.samples * 1000 / frame.sampleRate);
    if (!durationMs) {
      const tail = await readFully(source, Math.max(audioStart, source.size - 128), Math.min(128, source.size - audioStart));
      const id3v1 = tail.length === 128 && String.fromCharCode(...tail.subarray(0, 3)) === "TAG" ? 128 : 0;
      durationMs = Math.round((source.size - audioStart - id3v1) * 8000 / frame.bitrate);
    }
    return { durationMs, bitrate: frame.bitrate, picture };
  }
  return null;
}
