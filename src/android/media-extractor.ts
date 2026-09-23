import type { Sample } from "mp4box";
import { JMediaFormat } from "./media-format";
import { mkByteBuffer } from "../jvm/natives/jnio";
import { readFully, type FileSource } from "../shell/lazyfile";

function annexB(units: readonly { data: Uint8Array }[]): Uint8Array {
  const result = new Uint8Array(units.reduce((n, unit) => n + 4 + unit.data.length, 0));
  let offset = 0;
  for (const unit of units) { result.set([0, 0, 0, 1], offset); result.set(unit.data, offset + 4); offset += unit.data.length + 4; }
  return result;
}
function csd(format: JMediaFormat, key: string, data: Uint8Array): void {
  const buffer = mkByteBuffer(data.length, true); new Uint8Array(buffer.ab).set(data);
  format.values.set(key, { type: 5, value: buffer });
}
type Track = { format: JMediaFormat; samples: Sample[]; nalLength: number; timeOffset: number; index: number; selected: boolean };
export class MediaExtractor {
  tracks: Track[] = [];
  async open(source: FileSource): Promise<void> {
    const { createFile, MP4BoxBuffer, BoxParser, Descriptor } = await import("mp4box");
    const file = createFile(false);
    let error = "";
    file.onError = message => { error = String(message); };
    for (let offset = 0; offset < source.size;) {
      const data = await readFully(source, offset, Math.min(65536, source.size - offset));
      if (!data.length) throw new Error("Truncated media source");
      const next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(data.buffer, offset), offset + data.length === source.size);
      if (error) throw new Error(error);
      offset = Math.max(offset + data.length, next);
    }
    const movie = file.getInfo();
    if (!movie.hasMoov || !movie.tracks.length) throw new Error("Unsupported media container");
    this.tracks = movie.tracks.map(track => {
      const samples = file.getTrackSamplesInfo(track.id), entry = samples[0]?.description;
      const format = new JMediaFormat();
      let nalLength = 0;
      const avc = entry && "avcC" in entry && entry.avcC instanceof BoxParser.box.avcC ? entry.avcC : null;
      const hevc = entry && "hvcC" in entry && entry.hvcC instanceof BoxParser.box.hvcC ? entry.hvcC : null;
      const mime = avc ? "video/avc" : hevc ? "video/hevc" : track.codec.startsWith("mp4a.40.") ? "audio/mp4a-latm" : "application/octet-stream";
      format.values.set("mime", { type: 4, value: mime });
      if (hevc) format.values.set("codecs-string", { type: 4, value: track.codec });
      format.values.set("durationUs", { type: 2, value: BigInt(Math.round(track.duration / track.timescale * 1e6)) });
      format.values.set("bitrate", { type: 1, value: Math.round(track.bitrate) });
      format.values.set("language", { type: 4, value: track.language });
      let maxSize = 0;
      for (const sample of samples) maxSize = Math.max(maxSize, sample.size);
      if (avc) {
        nalLength = avc.lengthSizeMinusOne + 1;
        csd(format, "csd-0", annexB(avc.SPS)); csd(format, "csd-1", annexB(avc.PPS));
        maxSize *= Math.ceil(4 / nalLength);
      } else if (hevc) {
        nalLength = hevc.lengthSizeMinusOne + 1;
        csd(format, "csd-0", annexB(hevc.nalu_arrays.flat()));
        maxSize *= Math.ceil(4 / nalLength);
      }
      format.values.set("max-input-size", { type: 1, value: maxSize });
      if (track.video) {
        format.values.set("width", { type: 1, value: track.video.width }); format.values.set("height", { type: 1, value: track.video.height });
        format.values.set("frame-rate", { type: 1, value: Math.round(samples.length * track.timescale / track.duration) });
      }
      if (track.audio) {
        format.values.set("sample-rate", { type: 1, value: track.audio.sample_rate }); format.values.set("channel-count", { type: 1, value: track.audio.channel_count });
        if (entry && "esds" in entry && entry.esds instanceof BoxParser.box.esds) {
          const config: unknown = entry.esds.esd.findDescriptor(4);
          const data: unknown = config instanceof Descriptor ? config.findDescriptor(5) : null;
          if (data instanceof Descriptor && data.data instanceof Uint8Array) csd(format, "csd-0", data.data);
        }
      }
      let timeOffset = 0;
      for (const edit of track.edits ?? []) {
        if (edit.media_time === -1) timeOffset += edit.segment_duration / movie.timescale;
        else { timeOffset -= edit.media_time / track.timescale; break; }
      }
      return { format, samples, nalLength, timeOffset, index: 0, selected: false };
    });
  }
  current(): { track: Track; sample: Sample; index: number; time: number } | null {
    let current: ReturnType<MediaExtractor["current"]> = null;
    for (let index = 0; index < this.tracks.length; index++) {
      const track = this.tracks[index], sample = track.samples[track.index];
      if (!track.selected || !sample) continue;
      const time = Math.round((sample.cts / sample.timescale + track.timeOffset) * 1e6);
      if (!current || sample.dts / sample.timescale + track.timeOffset < current.sample.dts / current.sample.timescale + current.track.timeOffset) current = { track, sample, index, time };
    }
    return current;
  }
  advance(): boolean { const current = this.current(); if (current) current.track.index++; return this.current() !== null; }
  async read(source: FileSource): Promise<Uint8Array | null> {
    const current = this.current(); if (!current) return null;
    const { sample, track } = current;
    const data = await readFully(source, sample.offset, sample.size);
    if (data.length !== sample.size) throw new Error("Truncated media sample");
    if (!track.nalLength) return data;
    const units: { data: Uint8Array }[] = [];
    for (let offset = 0; offset < data.length;) {
      if (offset + track.nalLength > data.length) throw new Error("Truncated NAL length");
      let length = 0;
      for (let i = 0; i < track.nalLength; i++) length = length * 256 + data[offset++];
      if (offset + length > data.length) throw new Error("Truncated NAL unit");
      units.push({ data: data.subarray(offset, offset + length) }); offset += length;
    }
    return annexB(units);
  }
  seek(timeUs: number, mode: number): void {
    for (const track of this.tracks) {
      let previous = -1, next = -1;
      for (let i = 0; i < track.samples.length; i++) {
        const sample = track.samples[i]; if (!sample.is_sync) continue;
        const time = (sample.cts / sample.timescale + track.timeOffset) * 1e6;
        if (time <= timeUs) previous = i;
        if (time >= timeUs) { next = i; break; }
      }
      if (previous < 0) previous = next;
      if (next < 0) next = previous;
      const distance = (i: number) => Math.abs((track.samples[i].cts / track.samples[i].timescale + track.timeOffset) * 1e6 - timeUs);
      track.index = Math.max(0, mode === 0 ? previous : mode === 1 ? next : previous >= 0 && distance(previous) <= distance(next) ? previous : next);
    }
  }
}
