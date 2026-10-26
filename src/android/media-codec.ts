// MediaCodec's and MediaCodecList's natives over WebCodecs: the codec list is the definitions
// below that the browser's decoders accept, and a codec is a VideoDecoder or AudioDecoder behind
// MediaCodec's buffer-index protocol, which libmediandk's AMediaCodec shares.
import { awaited, JObj, rt, setDeclared, driven, waits, type Gen } from "../jvm/runtime.ts";
import { concat, jarray } from "../jvm/abi.ts";
import { after, newObj, vcall } from "../jvm/natives/jentry.ts";
import { type JBuffer, allocateDirectNow, bufferBytes, capacity as bufferCapacity, directReady, directView, nativeOrder, setLimit, setPosition } from "../jvm/natives/jnio.ts";
import { NativeFormat, TYPE_INTEGER, TYPE_LONG, TYPE_STRING, annexB, csdBytes, copiedFormatFromJava, formatToJava } from "./media-format.ts";
import { surfaceTarget, presentSurface, type GlSurface } from "./glsurface.ts";
import { nativePeer, nativeThread, postNativeEvent } from "./media-native.ts";
import { uptimeMillis } from "../guest-clock.ts";

/** a profile and level the codec lists, as MediaCodecInfo.CodecProfileLevel's */
type Level = { profile: number; level: number };
/** how a video format's access units read: whether one starts a coded video sequence, and for AVC
 *  and HEVC the codec string the sequence parameter set leading it gives */
type Bitstream = { keyFrame(data: Uint8Array): boolean; spsCodec?(data: Uint8Array): string | null };
/** a video codec's profiles carry the WebCodecs codec string a browser decoder is probed with */
type Definition = { kind: "video"; name: string; mime: string; profiles: (Level & { codec: string })[]; bitstream: Bitstream }
  | { kind: "audio"; name: string; mime: string; codec: string; profiles: Level[]; rates: string };
const profile = (profile: number, level: number, codec: string) => ({ profile, level, codec });

/** an Annex B stream's NAL units, each from its header byte to the next start code */
function nalUnits(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let start = -1;
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] || data[i + 1] || data[i + 2] !== 1) continue;
    if (start >= 0) units.push(data.subarray(start, i && !data[i - 1] ? i - 1 : i));
    start = i += 3;
  }
  if (start >= 0) units.push(data.subarray(start));
  return units;
}
/** the RBSP of a NAL unit's first bytes, without emulation prevention */
function rbsp(unit: Uint8Array, length: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < unit.length && out.length < length; i++) if (!(unit[i] === 3 && i >= 2 && !unit[i - 1] && !unit[i - 2])) out.push(unit[i]);
  return out;
}
const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");
/** AVC and HEVC in Annex B: a unit's type, the picture (VCL) types and the key ones among them, and the
 *  sequence parameter set's type and codec string (ISO/IEC 14496-15 Annex E) */
const nalBitstream = (nal: { type(unit: Uint8Array): number; vcl(type: number): boolean; key(type: number): boolean; sps: number; codec(unit: Uint8Array): string | null }): Bitstream => ({
  keyFrame(data) {
    for (const unit of nalUnits(data)) { const type = nal.type(unit); if (nal.vcl(type)) return nal.key(type); }
    return false;
  },
  spsCodec(data) {
    for (const unit of nalUnits(data)) if (nal.type(unit) === nal.sps) return nal.codec(unit);
    return null;
  },
});
const avc = nalBitstream({ type: (unit) => unit[0] & 31, vcl: (type) => type === 1 || type === 5, key: (type) => type === 5, sps: 7,
  codec: (unit) => "avc1." + rbsp(unit, 4).slice(1).map(hex2).join("") });
const hevc = nalBitstream({ type: (unit) => unit[0] >>> 1 & 63, vcl: (type) => type <= 31, key: (type) => type >= 16 && type <= 21, sps: 33, codec(unit) {
  // NAL header (2), vps id/sub-layers/nesting (1), then profile_tier_level's general fields
  const b = rbsp(unit, 15);
  if (b.length < 15) return null;
  const flags = (b[4] << 24 | b[5] << 16 | b[6] << 8 | b[7]) >>> 0;
  let compatibility = 0;
  for (let i = 0; i < 32; i++) if (flags & 1 << (31 - i)) compatibility |= 1 << i;
  const constraints = b.slice(8, 14);
  while (constraints.length && !constraints[constraints.length - 1]) constraints.pop();
  return `hvc1.${["", "A", "B", "C"][b[3] >>> 6]}${b[3] & 31}.${(compatibility >>> 0).toString(16).toUpperCase()}.${b[3] & 32 ? "H" : "L"}${b[14]}` +
    constraints.map(c => "." + hex2(c)).join("");
} });
const vp8: Bitstream = { keyFrame: (data) => !(data[0] & 1) };
const vp9: Bitstream = { keyFrame(data) {
  const header = data[0], shift = (header & 48) === 48 ? 1 : 0;
  return header >>> 6 === 2 && !(header & (12 >>> shift));
} };
/** the first frame (header) OBU: show_existing_frame 0 and frame_type KEY_FRAME, as an uncompressed header begins */
const av1: Bitstream = { keyFrame(data) {
  for (let i = 0; i < data.length;) {
    const header = data[i], type = header >>> 3 & 15;
    let at = i + 1 + (header & 4 ? 1 : 0), size = 0;
    if (!(header & 2)) size = data.length - at;
    else for (let shift = 0; at < data.length; shift += 7) { const b = data[at++]; size += (b & 127) * 2 ** shift; if (!(b & 128)) break; }
    if (type === 3 || type === 6) return at < data.length && !(data[at] & 0xe0);
    i = at + size;
  }
  return false;
} };

// Names follow Codec2's c2.<vendor>.<type>.decoder for codecs that run outside the device's CPU, as
// the Android Emulator lists its host-backed c2.goldfish decoders: the browser decodes, off the
// guest's thread, whether or not it uses the GPU. Players choose by these names and flags
// (c2.android and OMX.google are AOSP's software codecs, which run on the CPU they emulate).
// A video codec lists each profile the browser decodes.
const definitions: Definition[] = [
  // High first: the codec string a stream without parameter sets configures
  { kind: "video", name: "c2.webcodecs.avc.decoder", mime: "video/avc", bitstream: avc, profiles: [profile(8, 0x10000, "avc1.640034"), profile(0x80000, 0x10000, "avc1.640C34"),
    profile(2, 0x10000, "avc1.4D0034"), profile(1, 0x10000, "avc1.420034"), profile(0x10000, 0x10000, "avc1.42C034")] },
  { kind: "video", name: "c2.webcodecs.hevc.decoder", mime: "video/hevc", bitstream: hevc, profiles: [profile(1, 0x10000, "hvc1.1.6.L153.B0"), profile(2, 0x10000, "hvc1.2.4.L153.B0")] },
  { kind: "video", name: "c2.webcodecs.vp8.decoder", mime: "video/x-vnd.on2.vp8", bitstream: vp8, profiles: [profile(1, 8, "vp8")] },
  { kind: "video", name: "c2.webcodecs.vp9.decoder", mime: "video/x-vnd.on2.vp9", bitstream: vp9, profiles: [profile(1, 512, "vp09.00.51.08"), profile(4, 512, "vp09.02.51.10")] },
  { kind: "video", name: "c2.webcodecs.av1.decoder", mime: "video/av01", bitstream: av1, profiles: [profile(1, 0x2000, "av01.0.13M.08"), profile(2, 0x2000, "av01.0.13M.10")] },
  { kind: "audio", name: "c2.webcodecs.aac.decoder", mime: "audio/mp4a-latm", codec: "mp4a.40.2", profiles: [{ profile: 2, level: 0 }], rates: "7350-96000" },
  { kind: "audio", name: "c2.webcodecs.mp3.decoder", mime: "audio/mpeg", codec: "mp3", profiles: [], rates: "8000-48000" },
  { kind: "audio", name: "c2.webcodecs.opus.decoder", mime: "audio/opus", codec: "opus", profiles: [], rates: "8000-48000" },
];
/** the definition for a type, whether or not the browser decodes it */
export const definitionFor = (mime: string): Definition | undefined => definitions.find((d) => d.mime === mime);
/** whether an access unit starts a coded video sequence */
export const videoKeyFrame = (def: Definition & { kind: "video" }, data: Uint8Array) => data.length > 0 && def.bitstream.keyFrame(data);
/** csd-0 and csd-1: AVC's and HEVC's parameter sets in Annex B, as a decoder takes them before the first access unit */
export const parameterSets = (def: Definition, format: NativeFormat): Uint8Array[] =>
  def.kind === "video" && def.bitstream.spsCodec ? [csdBytes(format, "csd-0"), csdBytes(format, "csd-1")].filter(b => b !== undefined) : [];
/** a decoder configuration for a video format, its codec string from the parameter sets that lead `data` if any */
export function videoConfig(def: Definition & { kind: "video" }, format: NativeFormat, data?: Uint8Array): VideoDecoderConfig {
  const specified = format.number("profile", -1);
  const codec = (data && def.bitstream.spsCodec?.(data)) ?? (def.profiles.find(p => p.profile === specified) ?? def.profiles[0]).codec;
  return { codec, codedWidth: format.number("width", 640), codedHeight: format.number("height", 360), optimizeForLatency: true };
}
function audioConfig(def: Definition & { kind: "audio" }, format: NativeFormat, description = csdBytes(format, "csd-0")): AudioDecoderConfig {
  return { codec: def.codec, sampleRate: format.number("sample-rate", 48000), numberOfChannels: format.number("channel-count", 2), description };
}
/** the codec list: each definition with the profiles a browser decoder accepts */
let probed: Promise<Definition[]> | null = null;
const codecs = (): Promise<Definition[]> => probed ??= Promise.all(definitions.map(async (def): Promise<Definition | null> => {
  const accepts = async (probe: () => Promise<{ supported?: boolean }>) => { try { return (await probe()).supported === true; } catch { return false; } };
  if (def.kind === "audio") return typeof AudioDecoder !== "undefined" && await accepts(() => AudioDecoder.isConfigSupported(audioConfig(def, new NativeFormat()))) ? def : null;
  const ok = typeof VideoDecoder === "undefined" ? [] : await Promise.all(def.profiles.map((p) => accepts(() => VideoDecoder.isConfigSupported({ codec: p.codec, codedWidth: 1920, codedHeight: 1080 }))));
  const profiles = def.profiles.filter((_, i) => ok[i]);
  return profiles.length ? { ...def, profiles } : null;
})).then(list => list.filter(d => d !== null));

// ── MediaCodecList: MediaCodecInfo and its capabilities are AOSP's Java over these answers.
// The capability map is what media_codecs.xml gives a codec, which CodecCapabilities parses.
const CPL = "android/media/MediaCodecInfo$CodecProfileLevel";
function capabilityMap(def: Definition): Record<string, string> {
  if (def.kind === "audio") return { "sample-rate-ranges": def.rates, "max-channel-count": "2", "bitrate-range": "8000-510000" };
  // up to 4096x2304 at 60 frames per second; the levels bound each profile further
  return { "size-range": "16x16-4096x4096", "alignment": "2x2", "block-size": "16x16", "block-count-range": "1-36864",
    "blocks-per-second-range": "1-2073600", "bitrate-range": "1-120000000", "frame-rate-range": "0-960" };
}
const stringMap = (entries: Record<string, string>) =>
  formatToJava(Object.entries(entries).reduce((format, [k, v]) => format.set(k, TYPE_STRING, v), new NativeFormat()));
const capabilities = driven(function* capabilities$(def: Definition): Gen<JObj> {
  const levels: JObj[] = [];
  for (const { profile, level } of def.profiles) levels.push(setDeclared(yield newObj(CPL), CPL, { profile, level }));
  // COLOR_FormatYUV420Flexible, and the planar and semi-planar layouts a VideoFrame copies out as
  const colors = def.kind === "video" ? Int32Array.of(0x7f420888, 19, 21) : new Int32Array(0);
  return newObj("android/media/MediaCodecInfo$CodecCapabilities", `([L${CPL};[IZLjava/util/Map;Ljava/util/Map;)V`,
    jarray(levels, `L${CPL};`), colors, 0, yield* awaited(stringMap({ mime: def.mime })), yield* awaited(stringMap(capabilityMap(def))));
});
const at = (index: number) => after(codecs(), (list) => {
  const def = list[index];
  if (!def) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
  return def;
});
/** vendor and hardware-accelerated: see the names */
const ATTRIBUTES = 2 | 8;
rt.registerJnis("android/media/MediaCodecList", {
  "native_init()V": () => {},
  "native_getCodecCount()I": () => after(codecs(), (list) => list.length),
  "getCodecName(I)Ljava/lang/String;": (i: number) => after(at(i), (def) => def.name),
  "getCanonicalName(I)Ljava/lang/String;": (i: number) => after(at(i), (def) => def.name),
  "getAttributes(I)I": (i: number) => after(at(i), () => ATTRIBUTES),
  "getSupportedTypes(I)[Ljava/lang/String;": (i: number) => after(at(i), (def) => jarray([def.mime], "Ljava/lang/String;")),
  "getCodecCapabilities(ILjava/lang/String;)Landroid/media/MediaCodecInfo$CodecCapabilities;": (i: number, type: string) => after(at(i), (def) => {
    if (type !== def.mime) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    return capabilities(def);
  }),
  "findCodecByName(Ljava/lang/String;)I": (name: string) => after(codecs(), (list) => list.findIndex((d) => d.name === name)),
  "native_getGlobalSettings()Ljava/util/Map;": () => newObj("java/util/HashMap"),
});

// ── a codec
export type Info = { offset: number; size: number; time: bigint; flags: number };
type Output = { kind: "video"; frame: VideoFrame; info: Info } | { kind: "video-buffer" | "audio"; buffer: JBuffer; info: Info } | { kind: "end"; info: Info };
const CB_INPUT_AVAILABLE = 1, CB_OUTPUT_AVAILABLE = 2, CB_ERROR = 3, CB_OUTPUT_FORMAT_CHANGE = 4;
const EVENT_CALLBACK = 1, EVENT_FRAME_RENDERED = 3;
const info = (time: bigint, size = 0, flags = 0): Info => ({ offset: 0, size, time, flags });
const illegalState = (message: string | null) => rt.mkThrowable("java/lang/IllegalStateException", message);
/** the output buffers a codec decodes into, each held from its decode until its client releases it: as many as a
 *  surface's buffer queue gives a device's decoder, so a client holding a renderer's queue still keeps it decoding */
const OUTPUT_BUFFERS = 16;
/** A started codec's session, from start() to the stop, flush or reset that closes it: its decoder,
 *  buffer indices and outputs. Its callbacks act, and its events reach Java, only while it is the codec's run. */
class Run {
  readonly codec: Codec;
  readonly decoder: VideoDecoder | AudioDecoder;
  readonly live = () => this.codec.run === this;
  available = new Set([0, 1, 2, 3]);
  announced = new Set<number>();
  outputs = new Map<number, Output>();
  outputQueue: number[] = [];
  nextOutput = 0;
  freeOutputs: number[] = [];
  inFlight = 0;
  ending = false;
  formatChanged = false;
  /** AVC or HEVC parameter sets (csd-0 and csd-1, then codec-config buffers) that lead the next key frame */
  parameterSets: Uint8Array[];
  error: string | null = null;
  waiters = new Set<() => void>();
  scheduled = new Map<ReturnType<typeof setTimeout>, VideoFrame>();
  constructor(codec: Codec) {
    this.codec = codec;
    const { def, format } = codec, outputFormat = new NativeFormat(format);
    const error = (e: unknown) => { if (this.live()) this.fail(e); };
    this.parameterSets = parameterSets(def, format);
    if (def.kind === "video") {
      // configured at the first key frame, whose parameter sets give the codec string
      outputFormat.set("mime", TYPE_STRING, "video/raw");
      this.decoder = new VideoDecoder({ error, output: frame => this.frame(frame) });
    } else {
      outputFormat.set("mime", TYPE_STRING, "audio/raw").set("pcm-encoding", TYPE_INTEGER, 2);
      const decoder = this.decoder = new AudioDecoder({ error, output: audio => {
        if (!this.live()) { audio.close(); return; }
        const size = audio.numberOfFrames * audio.numberOfChannels * 2, buffer = nativeOrder(allocateDirectNow(size)), bytes = bufferBytes(buffer);
        const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, size >> 1), plane = new Float32Array(audio.numberOfFrames);
        for (let channel = 0; channel < audio.numberOfChannels; channel++) {
          audio.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
          for (let i = 0; i < plane.length; i++) pcm[i * audio.numberOfChannels + channel] = Math.max(-32768, Math.min(32767, Math.round(plane[i] * 32768)));
        }
        const out = info(BigInt(audio.timestamp), size);
        audio.close(); this.output({ kind: "audio", buffer, info: out });
      } });
      decoder.configure(audioConfig(def, format));
    }
    const capacity = format.number("max-input-size", def.kind === "video" ? Math.ceil(format.number("width", 640) * format.number("height", 360) * 1.5) : 65536);
    if (codec.inputs.length !== 4 || bufferCapacity(codec.inputs[0]) !== capacity) codec.inputs = Array.from({ length: 4 }, () => nativeOrder(allocateDirectNow(capacity)));
    this.changed(outputFormat); this.pump();
  }
  /** an event to the Java codec's EventHandler, dropped once this run ends */
  post(what: number, arg1: number, arg2: number, obj?: () => unknown): void {
    if (this.codec.owner) postNativeEvent(this.codec.owner, this.live, what, arg1, arg2, obj, this.codec.looper);
  }
  frame(frame: VideoFrame): void {
    if (!this.live()) { frame.close(); return; }
    const out = info(BigInt(frame.timestamp));
    if (this.codec.surface) { out.size = 1; this.output({ kind: "video", frame, info: out }); return; }
    try {
      const color = frame.format === "I420" ? 19 : frame.format === "NV12" ? 21 : 0;
      if (!color) throw new Error(`unsupported raw video format: ${frame.format}`);
      const height = frame.visibleRect?.height ?? frame.displayHeight;
      const pixels = new Uint8Array(frame.allocationSize());
      void frame.copyTo(pixels).then(layout => {
        frame.close(); if (!this.live()) return;
        const buffer = nativeOrder(allocateDirectNow(pixels.length));
        bufferBytes(buffer).set(pixels);
        const stride = layout[0].stride, current = this.codec.outputFormat;
        if (current.number("color-format", 0) !== color || current.number("stride", 0) !== stride || current.number("slice-height", 0) !== height)
          this.changed(new NativeFormat(current).set("color-format", TYPE_INTEGER, color).set("stride", TYPE_INTEGER, stride).set("slice-height", TYPE_INTEGER, height));
        out.size = pixels.length; this.output({ kind: "video-buffer", buffer, info: out });
      }).catch(e => { frame.close(); if (this.live()) this.fail(e); });
    } catch (e) { frame.close(); this.fail(e); }
  }
  wake(): void { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  fail(error: unknown): void {
    if (this.error) return;
    console.warn("[media codec]", error);
    const message = this.error = error instanceof Error ? error.message : String(error);
    // ERROR_UNKNOWN (0), neither transient nor recoverable
    if (this.codec.async) this.post(EVENT_CALLBACK, CB_ERROR, 0, () => newObj("android/media/MediaCodec$CodecException", "(IILjava/lang/String;)V", 0, 0, message));
    this.wake();
  }
  busy(): boolean { return this.inFlight + this.outputs.size + this.scheduled.size >= OUTPUT_BUFFERS; }
  pump(): void {
    if (this.ending || this.error || this.busy()) return;
    if (this.codec.async) for (const index of this.available) if (!this.announced.has(index)) {
      this.announced.add(index); this.post(EVENT_CALLBACK, CB_INPUT_AVAILABLE, index);
    }
    this.wake();
  }
  changed(format: NativeFormat): void {
    this.codec.outputFormat = format;
    if (this.codec.async) this.post(EVENT_CALLBACK, CB_OUTPUT_FORMAT_CHANGE, 0, () => formatToJava(format));
    else this.formatChanged = true;
  }
  output(output: Output): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const index = this.freeOutputs.pop() ?? this.nextOutput++;
    this.outputs.set(index, output);
    const { offset, size, time, flags } = output.info;
    if (this.codec.async) this.post(EVENT_CALLBACK, CB_OUTPUT_AVAILABLE, index, () => after(newObj("android/media/MediaCodec$BufferInfo"),
      (bufferInfo: JObj) => after(vcall(bufferInfo, "set", "(IIJI)V", offset, size, time, flags), () => bufferInfo)));
    else this.outputQueue.push(index);
    this.pump(); this.wake();
  }
  close(): void {
    if (this.decoder.state !== "closed") this.decoder.close();
    for (const output of this.outputs.values()) if (output.kind === "video") output.frame.close();
    for (const [timer, frame] of this.scheduled) { clearTimeout(timer); frame.close(); }
    this.wake();
  }
  queue(index: number, offset: number, size: number, timestamp: bigint, flags: number): void {
    const decoder = this.decoder, buffer = this.codec.inputs[index];
    if (!buffer || !this.announced.delete(index)) throw illegalState("input buffer is not dequeued");
    this.available.delete(index);
    if (offset < 0 || size < 0 || offset + size > bufferCapacity(buffer)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "invalid input range");
    const data = bufferBytes(buffer).subarray(offset, offset + size);
    try {
      if (flags & 2) this.config(data);
      else if (size) this.decode(data, Number(timestamp), !!(flags & 1));
    } catch (e) { this.fail(e); }
    this.available.add(index);
    if (flags & 4) {
      this.ending = true;
      void (decoder.state === "configured" ? decoder.flush() : Promise.resolve()).then(() => { if (this.live()) this.output({ kind: "end", info: info(timestamp, 0, 4) }); })
        .catch(e => { if (this.live()) this.fail(e); });
    } else this.pump();
  }
  /** a codec-config buffer: parameter sets for AVC and HEVC, an audio decoder's description;
   *  VP8, VP9 and AV1 decoders take theirs in band, as AOSP's do */
  config(data: Uint8Array): void {
    const { def, format } = this.codec;
    if (def.kind === "audio") (this.decoder as AudioDecoder).configure(audioConfig(def, format, data.slice()));
    else if (def.bitstream.spsCodec) this.parameterSets.push(data.slice());
  }
  decode(data: Uint8Array, timestamp: number, key: boolean): void {
    const def = this.codec.def;
    if (def.kind === "audio") { this.inFlight++; (this.decoder as AudioDecoder).decode(new EncodedAudioChunk({ type: "key", timestamp, data })); return; }
    const decoder = this.decoder as VideoDecoder;
    // a player that configures its decoder before its demuxer has read the sample entry can queue samples still in the MP4 framing
    if (def.bitstream.spsCodec) data = annexB(data) ?? data;
    if (this.parameterSets.length) data = concat([...this.parameterSets, data]);
    key ||= videoKeyFrame(def, data);
    // a decoder starts at a key frame: what precedes it decodes to nothing, as on a device
    if (decoder.state !== "configured") {
      if (!key) return;
      decoder.configure(videoConfig(def, this.codec.format, data));
    }
    if (key) this.parameterSets = [];
    this.inFlight++;
    decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data }));
  }
  releaseOutput(index: number, render: boolean, timeNs?: bigint): void {
    const output = this.outputs.get(index);
    if (!output) throw illegalState("unknown output buffer");
    this.outputs.delete(index);
    this.freeOutputs.push(index);
    if (output.kind === "video") {
      const present = () => {
        const surface = this.codec.surface instanceof JObj ? surfaceTarget(this.codec.surface) : this.codec.surface;
        if (render && this.live() && surface) {
          presentSurface(surface, output.frame);
          if (this.codec.frameEvents) {
            const media = output.info.time, nano = BigInt(Math.floor(uptimeMillis() * 1e6));
            this.post(EVENT_FRAME_RENDERED, 0, 0, () => formatToJava(new NativeFormat().set("0-media-time-us", TYPE_LONG, media).set("0-system-nano", TYPE_LONG, nano)));
          }
        } else output.frame.close();
      };
      // timeNs is on System.nanoTime's clock
      const delay = timeNs === undefined ? 0 : Number(timeNs) / 1e6 - uptimeMillis();
      if (render && delay > 0) { const timer = setTimeout(() => { this.scheduled.delete(timer); present(); this.pump(); }, delay); this.scheduled.set(timer, output.frame); } else present();
    }
    this.pump();
  }
  dequeueInput(timeout: bigint): number | Promise<number> {
    if (timeout > 0n && !this.ending && (!this.available.size || this.busy())) return this.wait(timeout).then(() => this.codec.running().dequeueInput(0n));
    if (this.ending || !this.available.size || this.busy()) return -1;
    const index = this.available.values().next().value;
    if (index === undefined) return -1; this.available.delete(index); this.announced.add(index); return index;
  }
  /** an output index and its info, or INFO_TRY_AGAIN_LATER (-1) or INFO_OUTPUT_FORMAT_CHANGED (-2) */
  dequeueOutput(timeout: bigint): [number, Info | null] | Promise<[number, Info | null]> {
    if (timeout > 0n && !this.formatChanged && !this.outputQueue.length) return this.wait(timeout).then(() => this.codec.running().dequeueOutput(0n));
    if (this.formatChanged) { this.formatChanged = false; return [-2, null]; }
    const index = this.outputQueue.shift(); if (index === undefined) return [-1, null];
    return [index, this.outputs.get(index)!.info];
  }
  wait(timeout: bigint): Promise<void> {
    return new Promise<void>(resolve => { const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); }; const timer = setTimeout(done, Number(timeout) / 1000); this.waiters.add(done); });
  }
  outputBuffer(index: number): JBuffer | null {
    const o = this.outputs.get(index);
    return o?.kind === "audio" || o?.kind === "video-buffer" ? o.buffer : null;
  }
}
/** a codec's configuration; a Run holds what it does once started */
export class Codec {
  readonly def: Definition; readonly owner: JObj | null;
  /** owner: the Java MediaCodec events go to, absent for an AMediaCodec */
  constructor(def: Definition, owner: JObj | null = null) { this.def = def; this.owner = owner; }
  /** JMediaCodec's looper, which calls postEventFromNative for the codec's callbacks */
  readonly looper = nativeThread("MediaCodec_looper");
  format = new NativeFormat();
  /** a Java Surface, or a native ANativeWindow's GlSurface */
  surface: JObj | GlSurface | null = null;
  async = false;
  frameEvents = false;
  inputs: JBuffer[] = [];
  /** the last output format, which a flushed codec still answers */
  outputFormat = new NativeFormat();
  released = false;
  run: Run | null = null;
  check(): void { if (this.released) throw illegalState("codec released"); }
  /** the started run each buffer call needs */
  running(): Run {
    this.check();
    const run = this.run;
    if (!run) throw illegalState("codec is not started");
    if (run.error) throw illegalState(run.error);
    return run;
  }
  configure(format: NativeFormat, surface: JObj | GlSurface | null): void {
    this.check();
    this.format = new NativeFormat(format); this.surface = surface;
  }
  start(): void { this.check(); this.run ??= new Run(this); }
  reset(): void { this.run?.close(); this.run = null; }
  /** MediaCodec::flush: a synchronous codec resumes at once; an asynchronous one waits for start() */
  flush(): void { const restart = this.run && !this.async; this.reset(); if (restart) this.start(); }
  release(): void { this.reset(); this.inputs = []; this.released = true; }
}
/** the codec for a type or component name, or null when the list has none */
export const createCodec = (name: string, nameIsType: boolean, owner: JObj | null = null): Promise<Codec | null> =>
  codecs().then((list) => { const def = list.find((d) => nameIsType ? d.mime === name : d.name === name); return def ? new Codec(def, owner) : null; });

// ── MediaCodec's natives
const MC = "android/media/MediaCodec";
const peers = nativePeer<Codec>(MC, null, (c) => c.release());
const C = peers.on;
/** a codec buffer as JMediaCodec hands one out: a new buffer over the codec's memory each call, since MediaCodec
 *  invalidates and frees the ones it gave the app; read-only for output, native order, over [offset, offset + size) */
const handOut = (b: JBuffer, input: boolean, offset: number, size: number) =>
  after(directView(b, !input), (v) => { nativeOrder(v); setLimit(v, offset + size); setPosition(v, offset); return v; });
rt.registerJnis(MC, {
  "native_init()V": () => {},
  "native_setup(Ljava/lang/String;ZZII)V": function (this: JObj, name: string, nameIsType: number, encoder: number) {
    // no encoder component exists, so MediaCodec::CreateByType/ByComponentName finds none (NAME_NOT_FOUND)
    return after(encoder ? null : createCodec(name, !!nameIsType, this), (c) => {
      if (!c) throw rt.mkThrowable("java/lang/IllegalArgumentException", `Failed to initialize ${name}, error 0xfffffffe (NAME_NOT_FOUND)`);
      peers.attach(this, c);
    });
  },
  "native_release()V": peers.detach,
  "native_finalize()V": peers.detach,
  "native_configure([Ljava/lang/String;[Ljava/lang/Object;Landroid/view/Surface;Landroid/media/MediaCrypto;Landroid/os/IHwBinder;I)V": waits(C((c,
    keys: string[] | null, values: unknown[] | null, surface: JObj | null, crypto: unknown, descrambler: unknown, flags: number) => {
    // a decoder cannot encode (CONFIGURE_FLAG_ENCODE), and no crypto plugin exists to decrypt
    if (flags & 1 || crypto || descrambler) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    return after(copiedFormatFromJava(keys,values),format => c.configure(format,surface));
  })),
  "native_setCallback(Landroid/media/MediaCodec$Callback;)V": C((c, cb: JObj | null) => { c.async = !!cb; }),
  "native_enableOnFrameRenderedListener(Z)V": C((c, enable: number) => { c.frameEvents = !!enable; }),
  "native_start()V": C((c) => after(directReady(), () => c.start())),
  "native_stop()V": C((c) => c.reset()),
  "native_reset()V": C((c) => { c.reset(); c.async = false; }),
  "native_flush()V": C((c) => c.flush()),
  "native_dequeueInputBuffer(J)I": C((c, timeout: bigint) => c.running().dequeueInput(timeout)),
  "native_queueInputBuffer(IIIJI)V": C((c, index: number, offset: number, size: number, time: bigint, flags: number) => c.running().queue(index, offset, size, time, flags)),
  "native_dequeueOutputBuffer(Landroid/media/MediaCodec$BufferInfo;J)I": C((c, out: JObj, timeout: bigint) => after(c.running().dequeueOutput(timeout), ([index, i]) =>
    i ? after(vcall(out, "set", "(IIJI)V", i.offset, i.size, i.time, i.flags), () => index) : index)),
  "releaseOutputBuffer(IZZJ)V": C((c, index: number, render: number, updatePts: number, timeNs: bigint) => c.running().releaseOutput(index, !!render, updatePts ? timeNs : undefined)),
  "getBuffers(Z)[Ljava/nio/ByteBuffer;": C(driven(function* getBuffers(c: Codec, input: number): Gen<unknown> {
    // output buffers are allocated per frame, so only input buffers form a fixed array
    if (!input || c.async) throw illegalState(null);
    const views: JBuffer[] = [];
    for (const b of c.inputs) views.push(yield handOut(b, true, 0, bufferCapacity(b)));
    return jarray(views, "Ljava/nio/ByteBuffer;");
  })),
  "getBuffer(ZI)Ljava/nio/ByteBuffer;": C((c, input: number, index: number) => {
    if (input) { const b = c.inputs[index]; return b ? handOut(b, true, 0, bufferCapacity(b)) : null; }
    const b = c.run?.outputBuffer(index), i = c.run?.outputs.get(index)?.info;
    return b && i ? handOut(b, false, i.offset, i.size) : null;
  }),
  "getImage(ZI)Landroid/media/Image;": () => null,
  "getFormatNative(Z)Ljava/util/Map;": C((c, input: number) => formatToJava(input ? c.format : c.outputFormat)),
  "getOutputFormatNative(I)Ljava/util/Map;": C((c) => formatToJava(c.outputFormat)),
  "getCanonicalName()Ljava/lang/String;": C((c) => c.def.name),
  "getOwnCodecInfo()Landroid/media/MediaCodecInfo;": C((c) => after(capabilities(c.def), (caps) => newObj("android/media/MediaCodecInfo",
    "(Ljava/lang/String;Ljava/lang/String;I[Landroid/media/MediaCodecInfo$CodecCapabilities;)V",
    c.def.name, c.def.name, ATTRIBUTES, jarray([caps], "Landroid/media/MediaCodecInfo$CodecCapabilities;")))),
  "native_setSurface(Landroid/view/Surface;)V": C((c, surface: JObj) => { c.surface = surface; }),
  "native_detachOutputSurface()V": C((c) => { c.surface = null; }),
  // the decoders take no parameters while running, and scale only to fit
  "setParameters([Ljava/lang/String;[Ljava/lang/Object;)V": C(() => {}),
  "setVideoScalingMode(I)V": C(() => {}),
});
