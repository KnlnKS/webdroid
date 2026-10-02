import { rt, driven, type JObj, type Gen } from "../jvm/runtime";
import { concat } from "../jvm/abi";
import { after, vcall } from "../jvm/natives/jlang";
import { fdInt } from "../jvm/natives/jio";
import { isBuffer, remainingBytes } from "../jvm/natives/jnio";
import { javaFdSource } from "../native/fs";
import { SliceFile, type FileSource } from "../shell/lazyfile";
import { NativeBitmap, javaBitmap } from "./bitmap";
import { MediaExtractor } from "./media-extractor";
import { inspectMp3 } from "./media-mp3";

const value = (format: MediaExtractor["tracks"][number]["format"], key: string) => format.values.get(key)?.value;
const codecBytes = (format: MediaExtractor["tracks"][number]["format"], key: string): Uint8Array => {
  const buffer = value(format, key);
  return isBuffer(buffer) ? remainingBytes(buffer) : new Uint8Array(0);
};

class Retriever {
  extractor: MediaExtractor | null = null;
  source: FileSource | null = null;
  metadata = new Map<number, string>();
  picture: Int8Array | null = null;

  reset() {
    this.extractor = null;
    this.source = null;
    this.metadata.clear();
    this.picture = null;
  }
  async open(source: FileSource) {
    this.reset();
    const mp3 = await inspectMp3(source);
    if (mp3) {
      this.source = source;
      this.picture = mp3.picture;
      this.metadata = new Map([[9, String(mp3.durationMs)], [10, "1"], [12, "audio/mpeg"],
        [16, "yes"], [17, "no"], [20, String(mp3.bitrate)]]);
      return;
    }
    const extractor = new MediaExtractor();
    await extractor.open(source);
    this.extractor = extractor;
    this.source = source;
    const tracks = extractor.tracks;
    const video = tracks.find(track => String(value(track.format, "mime")).startsWith("video/"));
    const audio = tracks.find(track => String(value(track.format, "mime")).startsWith("audio/"));
    this.metadata = new Map([
      [9, String(Math.round(Math.max(0, ...tracks.map(track => Number(value(track.format, "durationUs") ?? 0) / 1000))))],
      [10, String(tracks.length)],
      [12, video ? "video/mp4" : "audio/mp4"],
      [16, audio ? "yes" : "no"],
      [17, video ? "yes" : "no"],
      [20, String(Math.round(tracks.reduce((sum, track) => sum + Number(value(track.format, "bitrate") ?? 0), 0)))],
    ]);
    if (video) {
      this.metadata.set(18, String(value(video.format, "width") ?? 0));
      this.metadata.set(19, String(value(video.format, "height") ?? 0));
      this.metadata.set(24, "0");
      this.metadata.set(32, String(video.samples.length));
    }
  }
  async frame(timeUs: bigint, option: number, targetWidth?: number, targetHeight?: number): Promise<NativeBitmap | null> {
    // no source, no video track or no decoder for it: the retriever has no frame to give
    const extractor = this.extractor, source = this.source;
    if (!source || !extractor || typeof VideoDecoder === "undefined") return null;
    const track = extractor.tracks.find(item => String(value(item.format, "mime")).startsWith("video/"));
    if (!track?.samples.length) return null;
    const codec = value(track.format, "codecs-string");
    const width = Number(value(track.format, "width") ?? 0), height = Number(value(track.format, "height") ?? 0);
    if (typeof codec !== "string" || !width || !height) return null;
    const config = { codec, codedWidth: width, codedHeight: height };
    if (!(await VideoDecoder.isConfigSupported(config)).supported) return null;
    const requested = timeUs < 0n ? 0 : Number(timeUs);
    const mode = option === 1 ? 1 : option === 2 || option === 3 ? 2 : 0;
    track.selected = true;
    let packet: { data: Uint8Array; time: number } | null = null;
    try {
      extractor.seek(requested, mode);
      const current = extractor.current();
      if (current?.sample.is_sync) {
        const data = await extractor.read(source);
        if (data) packet = { data, time: current.time };
      }
    } finally { track.selected = false; }
    if (!packet) return null;
    const frames: VideoFrame[] = [];
    let failure: unknown = null;
    const decoder = new VideoDecoder({ output: output => { if (frames.length) output.close(); else frames.push(output); }, error: error => { failure = error; } });
    try {
      decoder.configure(config);
      decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: packet.time,
        data: concat([codecBytes(track.format, "csd-0"), codecBytes(track.format, "csd-1"), packet.data]) }));
      await decoder.flush();
      if (failure || !frames[0]) return null;
      const decoded = frames[0];
      const width = targetWidth ?? decoded.displayWidth, height = targetHeight ?? decoded.displayHeight;
      const bitmap = new NativeBitmap(width, height);
      bitmap.ctx.drawImage(decoded, 0, 0, width, height);
      return bitmap;
    } catch { return null; }
    finally { frames[0]?.close(); if (decoder.state !== "closed") decoder.close(); }
  }
}

// MediaMetadataRetriever's natives: a failed open is a RuntimeException, as the JNI's
// process_media_retriever_call reports any status but OK.
const retrievers = new WeakMap<JObj, Retriever>();
function retriever(r: JObj): Retriever {
  const found = retrievers.get(r);
  if (!found) throw rt.mkThrowable("java/lang/IllegalStateException", "No retriever available");
  return found;
}
const opened = (r: Retriever, source: FileSource) => r.open(source).catch(() => {
  throw rt.mkThrowable("java/lang/RuntimeException", "setDataSource failed: status = 0x80000000");
});
const MMR = "android/media/MediaMetadataRetriever";
rt.registerJnis(MMR, {
  "native_init()V": () => {},
  "native_setup()V": function (this: JObj) { retrievers.set(this, new Retriever()); },
  "release()V": function (this: JObj) { retrievers.get(this)?.reset(); retrievers.delete(this); },
  "native_finalize()V": function (this: JObj) { retrievers.delete(this); },
  "_setDataSource(Ljava/io/FileDescriptor;JJ)V": function (this: JObj, fd: JObj | null, offset: bigint, length: bigint) {
    const r = retriever(this), source = fd && javaFdSource(fdInt(fd));
    if (!source || offset < 0n || length < 0n || offset > BigInt(source.size)) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    const start = Number(offset);
    return opened(r, new SliceFile(source, start, Math.min(Number(length), source.size - start)));
  },
  "_setDataSource(Landroid/media/MediaDataSource;)V": function (this: JObj, data: JObj) {
    const r = retriever(this);
    return after(vcall(data, "getSize", "()J"), (size: bigint) => opened(r, { size: Math.max(0, Number(size)), read: async (offset, length) => {
      const out = new Int8Array(length);
      const count = await vcall(data, "readAt", "(J[BII)I", BigInt(offset), out, 0, length) as number;
      return count <= 0 ? new Uint8Array(0) : new Uint8Array(out.buffer, 0, Math.min(count, length));
    } }));
  },
  "nativeExtractMetadata(I)Ljava/lang/String;": function (this: JObj, key: number) { return retriever(this).metadata.get(key) ?? null; },
  "_getFrameAtTime(JIIILandroid/media/MediaMetadataRetriever$BitmapParams;)Landroid/graphics/Bitmap;": driven(function* (this: JObj,
    time: bigint, option: number, width: number, height: number): Gen {
    const bitmap: NativeBitmap | null = yield retriever(this).frame(time, option, width > 0 ? width : undefined, height > 0 ? height : undefined);
    return bitmap && (yield javaBitmap(bitmap));
  }),
  // only an MP3's APIC frame is read, whatever picture type is asked for
  "getEmbeddedPicture(I)[B": function (this: JObj) { return retriever(this).picture; },
});
