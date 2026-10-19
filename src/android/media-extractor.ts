import type { Sample } from "mp4box";
import { rt, type JObj } from "../jvm/runtime.ts";
import { after } from "../jvm/natives/jentry.ts";
import { NativeFormat, TYPE_BYTE_BUFFER, TYPE_INTEGER, TYPE_LONG, TYPE_STRING, formatToJava } from "./media-format.ts";
import { type JBuffer, allocateDirectNow, bufferBytes, capacity, directReady, setLimit, setPosition, writeBufferBytes } from "../jvm/natives/jnio.ts";
import { fdInt } from "../jvm/natives/jio.ts";
import { vfs } from "../shell/vfs.ts";
import { readFully, type FileSource } from "../shell/lazyfile.ts";
import { fdSlice, nativePeer } from "./media-native.ts";

function annexB(units: readonly { data: Uint8Array }[]): Uint8Array {
  const result = new Uint8Array(units.reduce((n, unit) => n + 4 + unit.data.length, 0));
  let offset = 0;
  for (const unit of units) { result.set([0, 0, 0, 1], offset); result.set(unit.data, offset + 4); offset += unit.data.length + 4; }
  return result;
}
function csd(format: NativeFormat, key: string, data: Uint8Array): void {
  const buffer = allocateDirectNow(data.length); bufferBytes(buffer).set(data);
  format.set(key, TYPE_BYTE_BUFFER, buffer);
}
type Track = { format: NativeFormat; samples: Sample[]; nalLength: number; timeOffset: number; index: number; selected: boolean };
export class MediaExtractor {
  tracks: Track[] = [];
  /** reads the container's tracks. The reads enter no Java; the codec data the formats hold are direct buffers, which Java makes, so they
   *  are made through `after` from this call, as the thread that calls it */
  open(source: FileSource): Promise<void> {
    const ready = directReady();
    return Promise.resolve(after(this.parse(source), (build) => after(ready, () => { this.tracks = build(); })));
  }
  /** the container's track list, read from `source`, as the step that makes the tracks */
  private async parse(source: FileSource): Promise<() => Track[]> {
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
    return () => movie.tracks.map(track => {
      const samples = file.getTrackSamplesInfo(track.id), entry = samples[0]?.description;
      const format = new NativeFormat();
      let nalLength = 0;
      const avc = entry && "avcC" in entry && entry.avcC instanceof BoxParser.box.avcC ? entry.avcC : null;
      const hevc = entry && "hvcC" in entry && entry.hvcC instanceof BoxParser.box.hvcC ? entry.hvcC : null;
      const mime = avc ? "video/avc" : hevc ? "video/hevc" : track.codec.startsWith("mp4a.40.") ? "audio/mp4a-latm" : "application/octet-stream";
      format.set("mime", TYPE_STRING, mime);
      if (avc || hevc) format.set("codecs-string", TYPE_STRING, track.codec);
      format.set("durationUs", TYPE_LONG, BigInt(Math.round(track.duration / track.timescale * 1e6)))
        .set("bitrate", TYPE_INTEGER, Math.round(track.bitrate)).set("language", TYPE_STRING, track.language);
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
      format.set("max-input-size", TYPE_INTEGER, maxSize);
      if (track.video) format.set("width", TYPE_INTEGER, track.video.width).set("height", TYPE_INTEGER, track.video.height)
        .set("frame-rate", TYPE_INTEGER, Math.round(samples.length * track.timescale / track.duration));
      if (track.audio) {
        format.set("sample-rate", TYPE_INTEGER, track.audio.sample_rate).set("channel-count", TYPE_INTEGER, track.audio.channel_count);
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

// ── MediaExtractor's natives over the extractor above. A source no extractor recognizes fails
// as NuMediaExtractor's does: IOException "Failed to instantiate extractor."
type Peer = { extractor: MediaExtractor; source: FileSource | null };
const peers = nativePeer<Peer>(null, null);
const failed = () => rt.mkThrowable("java/io/IOException", "Failed to instantiate extractor.");
const opened = (p: Peer, source: FileSource | null) => {
  if (!source) throw failed();
  return p.extractor.open(source).then(() => { p.source = source; }, () => { throw failed(); });
};
const E = peers.on;
function trackAt(p: Peer, i: number) {
  const track = p.extractor.tracks[i];
  if (!track) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
  return track;
}
rt.registerJnis("android/media/MediaExtractor", {
  "native_init()V": () => {},
  "native_setup()V": function (this: JObj) { peers.attach(this, { extractor: new MediaExtractor(), source: null }); },
  "native_finalize()V": peers.detach,
  "release()V": peers.detach,
  "setDataSource(Ljava/io/FileDescriptor;JJ)V": E((p, fd: JObj | null, offset: bigint, length: bigint) => {
    if (!fd) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    return after(fdSlice(fdInt(fd), offset, length), source => opened(p, source));
  }),
  // a path or a URL; only the file system is read
  "nativeSetDataSource(Landroid/os/IBinder;Ljava/lang/String;[Ljava/lang/String;[Ljava/lang/String;)V": E((p, _http: unknown, path: string) =>
    opened(p, vfs.source(path.startsWith("file://") ? decodeURI(path.slice(7)) : path))),
  "getTrackCount()I": E((p) => p.extractor.tracks.length),
  "getTrackFormatNative(I)Ljava/util/Map;": E((p, i: number) => formatToJava(trackAt(p, i).format)),
  "getFileFormatNative()Ljava/util/Map;": E((p) => formatToJava(new NativeFormat().set("mime", TYPE_STRING, p.extractor.tracks.some((t) => t.format.string("mime").startsWith("video/")) ? "video/mp4" : "audio/mp4"))),
  "selectTrack(I)V": E((p, i: number) => { trackAt(p, i).selected = true; }),
  "unselectTrack(I)V": E((p, i: number) => { trackAt(p, i).selected = false; }),
  "seekTo(JI)V": E((p, time: bigint, mode: number) => p.extractor.seek(Number(time), mode)),
  "advance()Z": E((p) => +p.extractor.advance()),
  "readSampleData(Ljava/nio/ByteBuffer;I)I": E((p, buffer: JBuffer, offset: number) => {
    if (!p.source || !p.extractor.current()) return -1;
    return after(p.extractor.read(p.source), (data) => {
      if (!data) return -1;
      if (offset < 0 || offset + data.length > capacity(buffer)) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
      return after(writeBufferBytes(buffer,data,offset), () => {
        setLimit(buffer,offset + data.length); setPosition(buffer,offset);
        return data.length;
      });
    });
  }),
  "getSampleTrackIndex()I": E((p) => p.extractor.current()?.index ?? -1),
  "getSampleTime()J": E((p) => BigInt(p.extractor.current()?.time ?? -1)),
  // SAMPLE_FLAG_SYNC
  "getSampleFlags()I": E((p) => { const c = p.extractor.current(); return c ? +c.sample.is_sync : -1; }),
  "getSampleSize()J": E((p) => BigInt(p.extractor.current()?.sample.size ?? -1)),
  "getSampleCryptoInfo(Landroid/media/MediaCodec$CryptoInfo;)Z": () => 0,
  // the whole source is local, so nothing is cached ahead
  "getCachedDuration()J": () => -1n,
  "hasCacheReachedEndOfStream()Z": () => 1,
});
