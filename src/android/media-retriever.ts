import { awaited, rt, driven, type JObj, type Gen } from "../jvm/runtime.ts";
import { concat } from "../jvm/abi.ts";
import { after } from "../jvm/natives/jentry.ts";
import { fdInt } from "../jvm/natives/jio.ts";
import type { FileSource } from "../shell/lazyfile.ts";
import { NativeBitmap, javaBitmap } from "./bitmap.ts";
import { MediaExtractor } from "./media-extractor.ts";
import { TYPE_LONG } from "./media-format.ts";
import { definitionFor, parameterSets, videoConfig } from "./media-codec.ts";
import { inspectMp3 } from "./media-mp3.ts";
import { dataSourceFile, fdSlice, nativePeer } from "./media-native.ts";

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
  /** MediaExtractor.open makes Java buffers as the thread that calls it, so it follows the MP3 check through `after` */
  open(source: FileSource): Promise<void> {
    this.reset();
    return Promise.resolve(after(inspectMp3(source), (mp3) => {
      if (!mp3) {
        const extractor = new MediaExtractor();
        return extractor.open(source).then(() => this.describe(source, extractor));
      }
      this.source = source;
      this.picture = mp3.picture;
      this.metadata = new Map([[9, String(mp3.durationMs)], [10, "1"], [12, "audio/mpeg"],
        [16, "yes"], [17, "no"], [20, String(mp3.bitrate)]]);
    }));
  }
  private describe(source: FileSource, extractor: MediaExtractor): void {
    this.extractor = extractor;
    this.source = source;
    const tracks = extractor.tracks;
    const video = tracks.find(track => track.format.string("mime").startsWith("video/"));
    const audio = tracks.find(track => track.format.string("mime").startsWith("audio/"));
    this.metadata = new Map([
      [9, String(Math.round(Math.max(0, ...tracks.map(track => Number(track.format.get("durationUs", TYPE_LONG) ?? 0n) / 1000))))],
      [10, String(tracks.length)],
      [12, video ? "video/mp4" : "audio/mp4"],
      [16, audio ? "yes" : "no"],
      [17, video ? "yes" : "no"],
      [20, String(Math.round(tracks.reduce((sum, track) => sum + track.format.number("bitrate", 0), 0)))],
    ]);
    if (video) {
      this.metadata.set(18, String(video.format.number("width", 0)));
      this.metadata.set(19, String(video.format.number("height", 0)));
      this.metadata.set(24, "0");
      this.metadata.set(32, String(video.samples.length));
    }
  }
  async frame(timeUs: bigint, option: number, targetWidth?: number, targetHeight?: number): Promise<NativeBitmap | null> {
    // no source, no video track or no decoder for it: the retriever has no frame to give
    const extractor = this.extractor, source = this.source;
    if (!source || !extractor || typeof VideoDecoder === "undefined") return null;
    const track = extractor.tracks.find(item => item.format.string("mime").startsWith("video/"));
    if (!track?.samples.length) return null;
    const { format } = track, mime = format.string("mime"), def = definitionFor(mime);
    if (def?.kind !== "video" || !format.number("width", 0) || !format.number("height", 0)) return null;
    const sets = parameterSets(def, format), config = videoConfig(def, format, concat(sets));
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
      decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: packet.time, data: concat([...sets, packet.data]) }));
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
const retrievers = nativePeer<Retriever>(null, "No retriever available", (r) => r.reset());
const R = retrievers.on;
const opened = (r: Retriever, source: FileSource) => r.open(source).catch(() => {
  throw rt.mkThrowable("java/lang/RuntimeException", "setDataSource failed: status = 0x80000000");
});
rt.registerJnis("android/media/MediaMetadataRetriever", {
  "native_init()V": () => {},
  "native_setup()V": function (this: JObj) { retrievers.attach(this, new Retriever()); },
  "release()V": retrievers.detach,
  "native_finalize()V": retrievers.detach,
  "_setDataSource(Ljava/io/FileDescriptor;JJ)V": R((r, fd: JObj | null, offset: bigint, length: bigint) => {
    const source = fd && fdSlice(fdInt(fd), offset, length);
    if (!source) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    return opened(r, source);
  }),
  "_setDataSource(Landroid/media/MediaDataSource;)V": R((r, data: JObj) => after(dataSourceFile(data), (source) => opened(r, source))),
  "nativeExtractMetadata(I)Ljava/lang/String;": R((r, key: number) => r.metadata.get(key) ?? null),
  "_getFrameAtTime(JIIILandroid/media/MediaMetadataRetriever$BitmapParams;)Landroid/graphics/Bitmap;": driven(function* (this: JObj,
    time: bigint, option: number, width: number, height: number): Gen {
    const bitmap = yield* awaited(retrievers.get(this).frame(time, option, width > 0 ? width : undefined, height > 0 ? height : undefined));
    return bitmap && (yield* awaited(javaBitmap(bitmap)));
  }),
  // only an MP3's APIC frame is read, whatever picture type is asked for
  "getEmbeddedPicture(I)[B": R((r) => r.picture),
});
