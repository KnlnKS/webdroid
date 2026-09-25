import { rt, JObj } from "../jvm/runtime";
import { concat } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";
import { JFileDescriptor, vfs } from "../jvm/natives/jio";
import { JBuffer } from "../jvm/natives/jnio";
import { javaFdSource } from "../native/stdio";
import { SliceFile, type FileSource } from "../shell/lazyfile";
import { JBitmap } from "./graphics";
import { MediaExtractor } from "./media-extractor";
import { mpegAudioDuration } from "./media-mpeg";

const value = (format: MediaExtractor["tracks"][number]["format"], key: string) => format.values.get(key)?.value;
const codecBytes = (format: MediaExtractor["tracks"][number]["format"], key: string): Uint8Array => {
  const buffer = value(format, key);
  return buffer instanceof JBuffer ? new Uint8Array(buffer.dv.buffer, buffer.dv.byteOffset + buffer.pos, buffer.lim - buffer.pos) : new Uint8Array(0);
};

class JMediaMetadataRetriever extends JObj {
  extractor: MediaExtractor | null = null;
  source: FileSource | null = null;
  metadata = new Map<number, string>();

  async open(source: FileSource) {
    this.extractor = null;
    this.source = null;
    this.metadata.clear();
    const mp3Duration = await mpegAudioDuration(source);
    if (mp3Duration !== null) {
      this.source = source;
      this.metadata = new Map([[9, String(mp3Duration)], [10, "1"], [12, "audio/mpeg"], [16, "yes"], [17, "no"]]);
      return;
    }
    const extractor = new MediaExtractor();
    try { await extractor.open(source); }
    catch { throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid media source"); }
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
  async frame(timeUs: bigint, option: number, targetWidth?: number, targetHeight?: number): Promise<JBitmap | null> {
    if (option < 0 || option > 3) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid frame option");
    const extractor = this.extractor, source = this.source;
    if (!source) throw rt.mkThrowable("java/lang/IllegalStateException", "No media source");
    if (!extractor) return null;
    if (typeof VideoDecoder === "undefined") throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Video decoding is unavailable");
    const track = extractor.tracks.find(item => String(value(item.format, "mime")).startsWith("video/"));
    if (!track?.samples.length) return null;
    const codec = value(track.format, "codecs-string");
    const width = Number(value(track.format, "width") ?? 0), height = Number(value(track.format, "height") ?? 0);
    if (typeof codec !== "string" || !width || !height) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Unsupported video track");
    const config = { codec, codedWidth: width, codedHeight: height };
    if (!(await VideoDecoder.isConfigSupported(config)).supported)
      throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Video codec is unavailable");
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
      const bitmap = JBitmap.create(width, height);
      bitmap.ctx.drawImage(decoded, 0, 0, width, height);
      return bitmap;
    } catch { return null; }
    finally { frames[0]?.close(); if (decoder.state !== "closed") decoder.close(); }
  }
}

async function openFd(this: JMediaMetadataRetriever, fd: JFileDescriptor, offset = 0n, length = 0x7fffffffffffffffn) {
  const source = javaFdSource(fd.fd) ?? vfs.source(fd.path);
  if (!source || offset < 0n || length <= 0n || offset > BigInt(source.size))
    throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid file descriptor or range");
  const start = Number(offset);
  await this.open(new SliceFile(source, start, Math.min(Number(length), source.size - start)));
}

rt.register({ name: "android/media/MediaMetadataRetriever", ctor: JMediaMetadataRetriever, ifaces: ["java/lang/AutoCloseable"],
  statics: { OPTION_PREVIOUS_SYNC: 0, OPTION_NEXT_SYNC: 1, OPTION_CLOSEST_SYNC: 2, OPTION_CLOSEST: 3,
    METADATA_KEY_DURATION: 9, METADATA_KEY_NUM_TRACKS: 10, METADATA_KEY_MIMETYPE: 12,
    METADATA_KEY_HAS_AUDIO: 16, METADATA_KEY_HAS_VIDEO: 17, METADATA_KEY_VIDEO_WIDTH: 18,
    METADATA_KEY_VIDEO_HEIGHT: 19, METADATA_KEY_BITRATE: 20, METADATA_KEY_VIDEO_ROTATION: 24,
    METADATA_KEY_VIDEO_FRAME_COUNT: 32 },
  methods: {
    "<init>()V": () => {},
    "setDataSource(Ljava/io/FileDescriptor;)V": openFd,
    "setDataSource(Ljava/io/FileDescriptor;JJ)V": openFd,
    "setDataSource(Ljava/lang/String;)V": function (this: JMediaMetadataRetriever, path: string) {
      const source = vfs.source(path.startsWith("file://") ? decodeURI(path.slice(7)) : path);
      if (!source) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid media path");
      return this.open(source);
    },
    "setDataSource(Landroid/media/MediaDataSource;)V": async function (this: JMediaMetadataRetriever, data: unknown) {
      const size = Number(await vcall(data, "getSize", "()J"));
      if (size <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid media source");
      await this.open({ size, read: async (offset, length) => {
        const out = new Int8Array(length);
        const count = await vcall(data, "readAt", "(J[BII)I", BigInt(offset), out, 0, length) as number;
        return count <= 0 ? new Uint8Array(0) : new Uint8Array(out.buffer, 0, Math.min(count, length));
      } });
    },
    "extractMetadata(I)Ljava/lang/String;": function (this: JMediaMetadataRetriever, key: number) { return this.metadata.get(key) ?? null; },
    "getFrameAtTime(JI)Landroid/graphics/Bitmap;": function (this: JMediaMetadataRetriever, time: bigint, option: number) { return this.frame(time, option); },
    "getFrameAtTime(J)Landroid/graphics/Bitmap;": function (this: JMediaMetadataRetriever, time: bigint) { return this.frame(time, 2); },
    "getFrameAtTime()Landroid/graphics/Bitmap;": function (this: JMediaMetadataRetriever) { return this.frame(-1n, 2); },
    "getScaledFrameAtTime(JIII)Landroid/graphics/Bitmap;": function (this: JMediaMetadataRetriever, time: bigint, option: number, width: number, height: number) {
      if (width <= 0 || height <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid frame size");
      return this.frame(time, option, width, height);
    },
    "getEmbeddedPicture()[B": () => null,
    "release()V": function (this: JMediaMetadataRetriever) { this.extractor = null; this.source = null; this.metadata.clear(); },
    "close()V": function (this: JMediaMetadataRetriever) { this.extractor = null; this.source = null; this.metadata.clear(); },
  },
});
