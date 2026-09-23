import { JObj, rt, noops } from "../jvm/runtime";
import { jarray, u8 } from "../jvm/abi";
import { box, boxInt, JDouble, JThrowable, newObj, vcall } from "../jvm/natives/jlang";
import { JBuffer, mkByteBuffer } from "../jvm/natives/jnio";
import { JMediaFormat } from "./media-format";
import { JBufferInfo } from "./media";
import { JSurface, presentSurface, type GlSurface } from "./glview";
import { mainHandler, reportUncaught } from "./os";

type VideoLimits = { maxDimension: number; maxBitrate: number; blockSize: number; maxBlocks: number; blocksPerSecond: number };
type Definition = ({ kind: "video"; mime: string; codec: string; profiles: [number, number][] } & VideoLimits) | { kind: "audio"; mime: string; codec: string; profiles: [number, number][] };
const avc42 = { maxDimension: 4096, maxBitrate: 50000000, blockSize: 16, maxBlocks: 8704, blocksPerSecond: 522240 };
const definitions: Definition[] = [
  { kind: "video", mime: "video/avc", codec: "avc1.42002A", ...avc42, profiles: [[1, 8192]] },
  { kind: "video", mime: "video/avc", codec: "avc1.4d002A", ...avc42, profiles: [[2, 8192]] },
  { kind: "video", mime: "video/avc", codec: "avc1.64002A", ...avc42, maxBitrate: 62500000, profiles: [[8, 8192]] },
  { kind: "video", mime: "video/x-vnd.on2.vp8", codec: "vp8", maxDimension: 16383, maxBitrate: 100000000, blockSize: 16, maxBlocks: 0x7fffffff, blocksPerSecond: 0x7fffffff, profiles: [[1, 8]] },
  { kind: "video", mime: "video/x-vnd.on2.vp9", codec: "vp09.00.41.08", maxDimension: 4160, maxBitrate: 30000000, blockSize: 8, maxBlocks: 34816, blocksPerSecond: 2506752, profiles: [[1, 128]] },
  { kind: "audio", mime: "audio/mp4a-latm", codec: "mp4a.40.2", profiles: [[2, 0]] },
  { kind: "audio", mime: "audio/opus", codec: "opus", profiles: [] },
];
const numberValue = (format: JMediaFormat, key: string, fallback: number): number => {
  const value = format.values.get(key)?.value; return typeof value === "number" ? value : fallback;
};
const stringValue = (format: JMediaFormat, key: string): string => {
  const value = format.values.get(key)?.value; return typeof value === "string" ? value : "";
};
function bufferBytes(buffer: JBuffer): Uint8Array { const view = buffer.dv; return u8(view, buffer.pos, buffer.lim - buffer.pos); }
function codecData(format: JMediaFormat, key: string): Uint8Array | undefined {
  const value = format.values.get(key)?.value; return value instanceof JBuffer ? bufferBytes(value) : undefined;
}
function videoKeyFrame(mime: string, data: Uint8Array): boolean {
  if (mime === "video/x-vnd.on2.vp8") return data.length > 0 && !(data[0] & 1);
  if (mime === "video/x-vnd.on2.vp9") {
    const header = data[0], shift = (header & 48) === 48 ? 1 : 0;
    return data.length > 0 && header >>> 6 === 2 && !(header & (12 >>> shift));
  }
  if (mime === "video/avc") for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] || data[i + 1] || data[i + 2] !== 1) continue;
    const type = data[i + 3] & 31;
    if (type === 1 || type === 5) return type === 5;
  }
  return false;
}
function videoConfig(def: Definition, format: JMediaFormat): VideoDecoderConfig {
  let codec = def.codec;
  const data = codecData(format, "csd-0");
  if (def.mime === "video/avc" && data) {
    for (let i = 0; i + 7 < data.length; i++) if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || data[i + 2] === 0 && data[i + 3] === 1)) {
      const start = i + (data[i + 2] === 1 ? 3 : 4);
      if ((data[start] & 31) === 7) { codec = "avc1." + [...data.subarray(start + 1, start + 4)].map(b => b.toString(16).padStart(2, "0")).join(""); break; }
    }
  }
  return { codec, codedWidth: numberValue(format, "width", 640), codedHeight: numberValue(format, "height", 360), optimizeForLatency: true };
}
function audioConfig(def: Definition, format: JMediaFormat): AudioDecoderConfig {
  return { codec: def.codec, sampleRate: numberValue(format, "sample-rate", 48000), numberOfChannels: numberValue(format, "channel-count", 2), description: codecData(format, "csd-0") };
}
function frameRates(def: VideoLimits, width: number, height: number): [number, number] | null {
  const blocks = Math.ceil(width / def.blockSize) * Math.ceil(height / def.blockSize);
  if (width <= 0 || height <= 0 || width > def.maxDimension || height > def.maxDimension || blocks > def.maxBlocks) return null;
  return [1 / blocks, Math.min(960, def.blocksPerSecond / blocks)];
}
async function supports(def: Definition, format = new JMediaFormat()): Promise<boolean> {
  const mime = stringValue(format, "mime");
  if (mime && mime !== def.mime) return false;
  if (def.kind === "video") {
    const range = frameRates(def, numberValue(format, "width", 640), numberValue(format, "height", 360));
    const rate = numberValue(format, "frame-rate", 0);
    if (!range || numberValue(format, "bitrate", 0) > def.maxBitrate || rate && (rate < range[0] || rate > range[1])) return false;
  }
  try {
    return def.kind === "video" ? typeof VideoDecoder !== "undefined" && (await VideoDecoder.isConfigSupported(videoConfig(def, format))).supported === true
      : typeof AudioDecoder !== "undefined" && (await AudioDecoder.isConfigSupported(audioConfig(def, format))).supported === true;
  } catch { return false; }
}
class JProfileLevel extends JObj { profile = 0; level = 0; }
class JCodecInfo extends JObj {
  constructor(readonly definition: Definition) { super(); }
  get name(): string { return "webcodecs." + this.definition.codec; }
}
let codecInfos: Promise<JCodecInfo[]> | null = null;
function codecs(): Promise<JCodecInfo[]> {
  rt.link("android/media/MediaCodecInfo");
  return codecInfos ??= Promise.all(definitions.map(async d => await supports(d) ? new JCodecInfo(d) : null)).then(a => a.filter(v => v !== null));
}
class JCapabilities extends JObj {
  profileLevels: JProfileLevel[];
  constructor(readonly info: JCodecInfo) { super(); this.profileLevels = jarray(info.definition.profiles.map(([profile, level]) => Object.assign(new JProfileLevel(), { profile, level })), "Landroid/media/MediaCodecInfo$CodecProfileLevel;"); }
}
class JVideoCapabilities extends JObj { constructor(readonly info: JCodecInfo) { super(); } }
class JAudioCapabilities extends JObj { constructor(readonly info: JCodecInfo) { super(); } }
rt.register({ name: "android/media/MediaCodecInfo$CodecProfileLevel", ctor: JProfileLevel, fields: { profile: "profile", level: "level" }, methods: { "<init>()V": function () {} } });
rt.register({ name: "android/media/MediaCodecInfo", ctor: JCodecInfo, methods: {
  "getName()Ljava/lang/String;": function (this: JCodecInfo) { return this.name; },
  "getCanonicalName()Ljava/lang/String;": function (this: JCodecInfo) { return this.name; },
  "getSupportedTypes()[Ljava/lang/String;": function (this: JCodecInfo) { return jarray([this.definition.mime], "Ljava/lang/String;"); },
  "isAlias()Z": () => 0, "isEncoder()Z": () => 0, "isHardwareAccelerated()Z": () => 0, "isSoftwareOnly()Z": () => 0, "isVendor()Z": () => 0,
  "getCapabilitiesForType(Ljava/lang/String;)Landroid/media/MediaCodecInfo$CodecCapabilities;": function (this: JCodecInfo, mime: string) {
    if (mime !== this.definition.mime) throw rt.mkThrowable("java/lang/IllegalArgumentException", mime);
    rt.link("android/media/MediaCodecInfo$CodecCapabilities"); rt.link("android/media/MediaCodecInfo$CodecProfileLevel"); return new JCapabilities(this);
  },
} });
rt.register({ name: "android/media/MediaCodecInfo$CodecCapabilities", ctor: JCapabilities, fields: { profileLevels: "profileLevels" }, methods: {
  "isFeatureSupported(Ljava/lang/String;)Z": () => 0, "isFeatureRequired(Ljava/lang/String;)Z": () => 0,
  "getMaxSupportedInstances()I": () => 1,
  "isFormatSupported(Landroid/media/MediaFormat;)Z": async function (this: JCapabilities, format: JMediaFormat) { return +await supports(this.info.definition, format); },
  "getVideoCapabilities()Landroid/media/MediaCodecInfo$VideoCapabilities;": function (this: JCapabilities) { rt.link("android/media/MediaCodecInfo$VideoCapabilities"); return this.info.definition.kind === "video" ? new JVideoCapabilities(this.info) : null; },
  "getAudioCapabilities()Landroid/media/MediaCodecInfo$AudioCapabilities;": function (this: JCapabilities) { rt.link("android/media/MediaCodecInfo$AudioCapabilities"); return this.info.definition.kind === "audio" ? new JAudioCapabilities(this.info) : null; },
} });
const supportsSize = async function (this: JVideoCapabilities, width: number, height: number) {
  const format = new JMediaFormat(); format.values.set("width", { type: 1, value: width }); format.values.set("height", { type: 1, value: height });
  return +await supports(this.info.definition, format);
};
rt.register({ name: "android/media/MediaCodecInfo$VideoCapabilities", ctor: JVideoCapabilities, methods: {
  "getWidthAlignment()I": () => 1, "getHeightAlignment()I": () => 1,
  "getSupportedFrameRates()Landroid/util/Range;": () => newObj("android/util/Range", "(Ljava/lang/Comparable;Ljava/lang/Comparable;)V", boxInt(0), boxInt(960)),
  "getSupportedFrameRatesFor(II)Landroid/util/Range;": async function (this: JVideoCapabilities, width: number, height: number) {
    const def = this.info.definition, range = def.kind === "video" ? frameRates(def, width, height) : null;
    if (!range || !await supportsSize.call(this, width, height)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "unsupported size");
    return newObj("android/util/Range", "(Ljava/lang/Comparable;Ljava/lang/Comparable;)V", box(JDouble, range[0]), box(JDouble, range[1]));
  },
  "getBitrateRange()Landroid/util/Range;": function (this: JVideoCapabilities) {
    const definition = this.info.definition;
    if (definition.kind !== "video") throw rt.mkThrowable("java/lang/IllegalStateException", "Not a video codec");
    return newObj("android/util/Range", "(Ljava/lang/Comparable;Ljava/lang/Comparable;)V", boxInt(1), boxInt(definition.maxBitrate));
  },
  "getSupportedHeights()Landroid/util/Range;": function (this: JVideoCapabilities) {
    const definition = this.info.definition;
    if (definition.kind !== "video") throw rt.mkThrowable("java/lang/IllegalStateException", "Not a video codec");
    return newObj("android/util/Range", "(Ljava/lang/Comparable;Ljava/lang/Comparable;)V", boxInt(1), boxInt(definition.maxDimension));
  },
  "getSupportedWidths()Landroid/util/Range;": function (this: JVideoCapabilities) {
    const definition = this.info.definition;
    if (definition.kind !== "video") throw rt.mkThrowable("java/lang/IllegalStateException", "Not a video codec");
    return newObj("android/util/Range", "(Ljava/lang/Comparable;Ljava/lang/Comparable;)V", boxInt(1), boxInt(definition.maxDimension));
  },
  "isSizeSupported(II)Z": supportsSize,
  "areSizeAndRateSupported(IID)Z": async function (this: JVideoCapabilities, width: number, height: number, rate: number) {
    const def = this.info.definition, range = def.kind === "video" ? frameRates(def, width, height) : null;
    return +(!!range && rate >= range[0] && rate <= range[1] && !!await supportsSize.call(this, width, height));
  },
  "getSupportedPerformancePoints()Ljava/util/List;": () => null,
  "getAchievableFrameRatesFor(II)Landroid/util/Range;": () => null,
} });
rt.register({ name: "android/media/MediaCodecInfo$AudioCapabilities", ctor: JAudioCapabilities, methods: {
  "getMaxInputChannelCount()I": () => 2,
  "isSampleRateSupported(I)Z": async function (this: JAudioCapabilities, rate: number) { const format = new JMediaFormat(); format.values.set("sample-rate", { type: 1, value: rate }); return +await supports(this.info.definition, format); },
} });
rt.register({ name: "android/media/MediaCodecList", ctor: class extends JObj {}, statics: { REGULAR_CODECS: 0, ALL_CODECS: 1 }, methods: {
  "<init>(I)V": function () {},
  "getCodecInfos()[Landroid/media/MediaCodecInfo;": async () => jarray(await codecs(), "Landroid/media/MediaCodecInfo;"),
  "static getCodecCount()I": async () => (await codecs()).length,
  "static getCodecInfoAt(I)Landroid/media/MediaCodecInfo;": async (index: number) => {
    const info = (await codecs())[index]; if (!info) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", String(index)); return info;
  },
  "findDecoderForFormat(Landroid/media/MediaFormat;)Ljava/lang/String;": async (format: JMediaFormat) => {
    for (const info of await codecs()) if (info.definition.mime === stringValue(format, "mime") && await supports(info.definition, format)) return info.name;
    return null;
  },
  "findEncoderForFormat(Landroid/media/MediaFormat;)Ljava/lang/String;": () => null,
} });

class JCodecException extends JThrowable {}
rt.register({ name: "android/media/MediaCodec$CodecException", ctor: JCodecException, sup: "java/lang/IllegalStateException", methods: {
  "isRecoverable()Z": () => 0, "isTransient()Z": () => 0, "getErrorCode()I": () => -1,
  "getDiagnosticInfo()Ljava/lang/String;": function (this: JCodecException) { return this.msg ?? "WebCodecs decoding failed"; },
} });
type Output = { kind: "video"; frame: VideoFrame; info: JBufferInfo } | { kind: "video-buffer" | "audio"; buffer: JBuffer; info: JBufferInfo } | { kind: "end"; info: JBufferInfo };
export class JMediaCodec extends JObj {
  constructor(readonly info: JCodecInfo) { super(); }
  format = new JMediaFormat();
  surface: JSurface | GlSurface | null = null;
  callback: unknown = null;
  handler: ReturnType<typeof mainHandler> | null = null;
  frameListener: unknown = null;
  frameHandler: ReturnType<typeof mainHandler> | null = null;
  decoder: VideoDecoder | AudioDecoder | null = null;
  inputs: JBuffer[] = [];
  available = new Set<number>();
  announced = new Set<number>();
  outputs = new Map<number, Output>();
  outputQueue: number[] = [];
  nextOutput = 0;
  freeOutputs: number[] = [];
  inFlight = 0;
  epoch = 0;
  started = false;
  ending = false;
  released = false;
  formatChanged = false;
  outputFormat = new JMediaFormat();
  prepend = true;
  error: JThrowable | null = null;
  waiters = new Set<() => void>();
  scheduled = new Map<ReturnType<typeof setTimeout>, VideoFrame>();
  send(name: string, desc: string, ...args: unknown[]): void {
    if (!this.callback) return;
    const epoch = this.epoch, callback = this.callback;
    void (this.handler ?? mainHandler()).looper.run(() => epoch === this.epoch ? vcall(callback, name, desc, this, ...args) : undefined).catch(reportUncaught);
  }
  wake(): void { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  check(): void { if (this.error) throw this.error; if (this.released) throw rt.mkThrowable("java/lang/IllegalStateException", "codec released"); }
  fail(error: unknown): void {
    if (this.error) return;
    console.warn("[media codec]", error);
    this.error = rt.mkThrowable("android/media/MediaCodec$CodecException", error instanceof Error ? error.message : String(error));
    this.send("onError", "(Landroid/media/MediaCodec;Landroid/media/MediaCodec$CodecException;)V", this.error); this.wake();
  }
  pump(): void {
    if (!this.started || this.ending || this.error || this.inFlight + this.outputs.size + this.scheduled.size >= 8) return;
    if (this.callback) for (const index of this.available) if (!this.announced.has(index)) {
      this.announced.add(index); this.send("onInputBufferAvailable", "(Landroid/media/MediaCodec;I)V", index);
    }
    this.wake();
  }
  changed(format: JMediaFormat): void {
    this.outputFormat = format; this.formatChanged = true;
    this.send("onOutputFormatChanged", "(Landroid/media/MediaCodec;Landroid/media/MediaFormat;)V", format);
  }
  output(output: Output): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const index = this.freeOutputs.pop() ?? this.nextOutput++;
    this.outputs.set(index, output);
    if (this.callback) this.send("onOutputBufferAvailable", "(Landroid/media/MediaCodec;ILandroid/media/MediaCodec$BufferInfo;)V", index, output.info);
    else this.outputQueue.push(index);
    this.pump(); this.wake();
  }
  reset(): void {
    this.epoch++; this.started = false; if (this.decoder?.state !== "closed") this.decoder?.close(); this.decoder = null;
    for (const output of this.outputs.values()) if (output.kind === "video") output.frame.close();
    for (const [timer, frame] of this.scheduled) { clearTimeout(timer); frame.close(); }
    this.scheduled.clear(); this.ending = false;
    this.outputs.clear(); this.outputQueue = []; this.nextOutput = 0; this.freeOutputs = []; this.available.clear(); this.announced.clear(); this.inFlight = 0; this.prepend = true; this.error = null; this.wake();
  }
  configure(format: JMediaFormat, surface: JSurface | GlSurface | null, crypto: unknown, flags: number): void {
    this.check(); if (crypto || flags) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "encoding and protected media are unavailable");
    this.format = new JMediaFormat(); this.format.values = new Map(format.values); this.surface = surface;
  }
  start(): void {
    this.check();
    if (this.started) return;
    this.started = true;
    const epoch = this.epoch;
    const outputFormat = new JMediaFormat(); outputFormat.values = new Map(this.format.values);
    if (this.info.definition.kind === "video") {
      outputFormat.values.set("mime", { type: 4, value: "video/raw" });
      const decoder = new VideoDecoder({ error: e => { if (epoch === this.epoch) this.fail(e); }, output: frame => {
        if (epoch !== this.epoch) { frame.close(); return; }
        const info = new JBufferInfo(); info.presentationTimeUs = BigInt(frame.timestamp);
        if (this.surface) { info.size = 1; this.output({ kind: "video", frame, info }); return; }
        try {
          const color = frame.format === "I420" ? 19 : frame.format === "NV12" ? 21 : 0;
          if (!color) throw new Error(`unsupported raw video format: ${frame.format}`);
          const height = frame.visibleRect?.height ?? frame.displayHeight;
          const buffer = mkByteBuffer(frame.allocationSize(), true);
          void frame.copyTo(new Uint8Array(buffer.ab)).then(layout => {
            frame.close(); if (epoch !== this.epoch) return;
            const stride = layout[0].stride;
            if (numberValue(this.outputFormat, "color-format", 0) !== color || numberValue(this.outputFormat, "stride", 0) !== stride || numberValue(this.outputFormat, "slice-height", 0) !== height) {
              const format = new JMediaFormat(); format.values = new Map(this.outputFormat.values);
              format.values.set("color-format", { type: 1, value: color });
              format.values.set("stride", { type: 1, value: stride });
              format.values.set("slice-height", { type: 1, value: height });
              this.changed(format);
            }
            info.size = buffer.cap; this.output({ kind: "video-buffer", buffer, info });
          }).catch(e => { frame.close(); if (epoch === this.epoch) this.fail(e); });
        } catch (e) { frame.close(); this.fail(e); }
      } });
      this.decoder = decoder; decoder.configure(videoConfig(this.info.definition, this.format));
    } else {
      outputFormat.values.set("mime", { type: 4, value: "audio/raw" }); outputFormat.values.set("pcm-encoding", { type: 1, value: 2 });
      this.decoder = new AudioDecoder({ error: e => { if (epoch === this.epoch) this.fail(e); }, output: audio => {
        if (epoch !== this.epoch) { audio.close(); return; }
        const buffer = mkByteBuffer(audio.numberOfFrames * audio.numberOfChannels * 2, true);
        buffer.little = true;
        const pcm = new Int16Array(buffer.ab), plane = new Float32Array(audio.numberOfFrames);
        for (let channel = 0; channel < audio.numberOfChannels; channel++) {
          audio.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
          for (let i = 0; i < plane.length; i++) pcm[i * audio.numberOfChannels + channel] = Math.max(-32768, Math.min(32767, Math.round(plane[i] * 32768)));
        }
        const info = new JBufferInfo(); info.presentationTimeUs = BigInt(audio.timestamp); info.size = buffer.cap;
        audio.close(); this.output({ kind: "audio", buffer, info });
      } });
      this.decoder.configure(audioConfig(this.info.definition, this.format));
    }
    const capacity = numberValue(this.format, "max-input-size", this.info.definition.kind === "video" ? Math.ceil(numberValue(this.format, "width", 640) * numberValue(this.format, "height", 360) * 1.5) : 65536);
    rt.link("java/nio/ByteBuffer"); rt.link("android/media/MediaCodec$BufferInfo"); rt.link("android/media/MediaFormat");
    if (this.inputs.length !== 4 || this.inputs[0].cap !== capacity) this.inputs = Array.from({ length: 4 }, () => { const buffer = mkByteBuffer(capacity, true); buffer.little = true; return buffer; });
    this.available = new Set([0, 1, 2, 3]); this.changed(outputFormat); this.pump();
  }
  queue(index: number, offset: number, size: number, timestamp: bigint, flags: number): void {
    this.check(); const decoder = this.decoder, buffer = this.inputs[index];
    if (!decoder || !buffer || !this.announced.delete(index)) throw rt.mkThrowable("java/lang/IllegalStateException", "input buffer is not dequeued");
    this.available.delete(index);
    if (offset < 0 || size < 0 || offset + size > buffer.cap) throw rt.mkThrowable("java/lang/IllegalArgumentException", "invalid input range");
    let data = u8(buffer.dv, offset, size);
    if (!(flags & 2) && size) {
      this.inFlight++;
      if (decoder instanceof VideoDecoder) {
        if (this.prepend && this.info.definition.mime === "video/avc") {
          const a = codecData(this.format, "csd-0"), b = codecData(this.format, "csd-1");
          if (a) { const joined = new Uint8Array(a.length + (b?.length ?? 0) + data.length); joined.set(a); if (b) joined.set(b, a.length); joined.set(data, a.length + (b?.length ?? 0)); data = joined; }
        }
        this.prepend = false; decoder.decode(new EncodedVideoChunk({ type: flags & 1 || videoKeyFrame(this.info.definition.mime, data) ? "key" : "delta", timestamp: Number(timestamp), data }));
      } else decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: Number(timestamp), data }));
    }
    this.available.add(index);
    if (flags & 4) {
      this.ending = true;
      const epoch = this.epoch;
      void decoder.flush().then(() => {
        if (epoch !== this.epoch) return;
        const info = new JBufferInfo(); info.flags = 4; info.presentationTimeUs = timestamp; this.output({ kind: "end", info });
      }).catch(e => { if (epoch === this.epoch) this.fail(e); });
    } else this.pump();
  }
  releaseOutput(index: number, render: boolean, timeNs?: bigint): void {
    this.check(); const output = this.outputs.get(index);
    if (!output) throw rt.mkThrowable("java/lang/IllegalStateException", "unknown output buffer");
    this.outputs.delete(index);
    this.freeOutputs.push(index);
    if (output.kind === "video") {
      const epoch = this.epoch;
      const present = () => {
        const surface = this.surface instanceof JSurface ? this.surface.surf : this.surface;
        if (render && epoch === this.epoch && surface) {
          presentSurface(surface, output.frame);
          const listener = this.frameListener;
          if (listener) void (this.frameHandler ?? mainHandler()).looper.run(() => epoch === this.epoch ? vcall(listener, "onFrameRendered", "(Landroid/media/MediaCodec;JJ)V", this, output.info.presentationTimeUs, BigInt(Math.floor(performance.now() * 1e6))) : undefined).catch(reportUncaught);
        } else output.frame.close();
      };
      const delay = timeNs === undefined ? 0 : Number(timeNs) / 1e6 - performance.now();
      if (render && delay > 0) { const timer = setTimeout(() => { this.scheduled.delete(timer); present(); this.pump(); }, delay); this.scheduled.set(timer, output.frame); } else present();
    }
    this.pump();
  }
  dequeueInput(timeout: bigint): number | Promise<number> {
    this.check(); if (timeout > 0n && !this.ending && (!this.available.size || this.inFlight + this.outputs.size + this.scheduled.size >= 8)) return this.wait(timeout).then(() => this.dequeueInput(0n));
    if (this.ending || !this.available.size || this.inFlight + this.outputs.size + this.scheduled.size >= 8) return -1;
    const index = this.available.values().next().value;
    if (index === undefined) return -1; this.available.delete(index); this.announced.add(index); return index;
  }
  dequeueOutput(info: JBufferInfo, timeout: bigint): number | Promise<number> {
    this.check(); if (timeout > 0n && !this.formatChanged && !this.outputQueue.length) return this.wait(timeout).then(() => this.dequeueOutput(info, 0n));
    if (this.formatChanged) { this.formatChanged = false; return -2; }
    const index = this.outputQueue.shift(); if (index === undefined) return -1;
    Object.assign(info, this.outputs.get(index)?.info); return index;
  }
  async wait(timeout: bigint): Promise<void> {
    if (timeout <= 0n) return;
    await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); }; const timer = setTimeout(done, Number(timeout) / 1000); this.waiters.add(done); });
    this.check();
  }
}
export async function createCodec(name: string, mime: boolean): Promise<JMediaCodec> {
  const info = (await codecs()).find(info => mime ? info.definition.mime === name : info.name === name);
  if (!info) throw rt.mkThrowable("java/io/IOException", "decoder unavailable: " + name);
  rt.link("android/media/MediaCodec"); return new JMediaCodec(info);
}
rt.register({ name: "android/media/MediaCodec", ctor: JMediaCodec, methods: {
  "static createByCodecName(Ljava/lang/String;)Landroid/media/MediaCodec;": async (name: string) => createCodec(name, false),
  "static createDecoderByType(Ljava/lang/String;)Landroid/media/MediaCodec;": async (mime: string) => createCodec(mime, true),
  "getName()Ljava/lang/String;": function (this: JMediaCodec) { return this.info.name; },
  "getCodecInfo()Landroid/media/MediaCodecInfo;": function (this: JMediaCodec) { return this.info; },
  "setCallback(Landroid/media/MediaCodec$Callback;Landroid/os/Handler;)V": function (this: JMediaCodec, callback: unknown, handler: ReturnType<typeof mainHandler> | null) { this.callback = callback; this.handler = handler; },
  "setCallback(Landroid/media/MediaCodec$Callback;)V": function (this: JMediaCodec, callback: unknown) { this.callback = callback; },
  "setOnFrameRenderedListener(Landroid/media/MediaCodec$OnFrameRenderedListener;Landroid/os/Handler;)V": function (this: JMediaCodec, listener: unknown, handler: ReturnType<typeof mainHandler> | null) { this.frameListener = listener; this.frameHandler = handler; },
  "configure(Landroid/media/MediaFormat;Landroid/view/Surface;Landroid/media/MediaCrypto;I)V": function (this: JMediaCodec, format: JMediaFormat, surface: JSurface | null, crypto: unknown, flags: number) {
    this.configure(format, surface, crypto, flags);
  },
  "start()V": function (this: JMediaCodec) { this.start(); },
  "stop()V": function (this: JMediaCodec) { this.reset(); },
  "flush()V": function (this: JMediaCodec) { const restart = this.started && !this.callback; this.reset(); if (restart) this.start(); },
  "release()V": function (this: JMediaCodec) { this.reset(); this.inputs = []; this.released = true; },
  "getInputBuffer(I)Ljava/nio/ByteBuffer;": function (this: JMediaCodec, index: number) { const b = this.inputs[index]; if (!b) return null; b.pos = 0; b.lim = b.cap; return b; },
  "getOutputBuffer(I)Ljava/nio/ByteBuffer;": function (this: JMediaCodec, index: number) { const o = this.outputs.get(index); return o?.kind === "audio" || o?.kind === "video-buffer" ? o.buffer : null; },
  "getInputBuffers()[Ljava/nio/ByteBuffer;": function (this: JMediaCodec) { return jarray(this.inputs.slice(), "Ljava/nio/ByteBuffer;"); },
  "getOutputFormat()Landroid/media/MediaFormat;": function (this: JMediaCodec) { return this.outputFormat; },
  "getOutputFormat(I)Landroid/media/MediaFormat;": function (this: JMediaCodec) { return this.outputFormat; },
  "queueInputBuffer(IIIJI)V": function (this: JMediaCodec, index: number, offset: number, size: number, timestamp: bigint, flags: number) { this.queue(index, offset, size, timestamp, flags); },
  "dequeueInputBuffer(J)I": function (this: JMediaCodec, timeout: bigint) { return this.dequeueInput(timeout); },
  "dequeueOutputBuffer(Landroid/media/MediaCodec$BufferInfo;J)I": function (this: JMediaCodec, info: JBufferInfo, timeout: bigint) { return this.dequeueOutput(info, timeout); },
  "releaseOutputBuffer(IZ)V": function (this: JMediaCodec, index: number, render: number) { this.releaseOutput(index, !!render); },
  "releaseOutputBuffer(IJ)V": function (this: JMediaCodec, index: number, time: bigint) { this.releaseOutput(index, true, time); },
  "setOutputSurface(Landroid/view/Surface;)V": function (this: JMediaCodec, surface: JSurface) { this.surface = surface; },
  "detachOutputSurface()V": function (this: JMediaCodec) { this.surface = null; },
  ...noops("setVideoScalingMode(I)V", "setParameters(Landroid/os/Bundle;)V",
    "subscribeToVendorParameters(Ljava/util/List;)V", "unsubscribeFromVendorParameters(Ljava/util/List;)V"),
} });
