// MediaCodec's and MediaCodecList's natives over WebCodecs: the codec list is the definitions
// below that the browser's decoders accept, and a codec is a VideoDecoder or AudioDecoder behind
// MediaCodec's buffer-index protocol, which libmediandk's AMediaCodec shares.
import { JObj, rt, setDeclared, driven, type Gen } from "../jvm/runtime";
import { concat, jarray } from "../jvm/abi";
import { after, newObj, vcall } from "../jvm/natives/jlang";
import { type JBuffer, allocateDirectNow, bufferBytes, capacity as bufferCapacity, directReady, nativeOrder, setLimit, setPosition } from "../jvm/natives/jnio";
import { NativeFormat, TYPE_INTEGER, TYPE_LONG, TYPE_STRING, csdBytes, formatFromJava, formatToJava } from "./media-format";
import { surfaceTarget, presentSurface, type GlSurface } from "./glsurface";
import { nativePeer, postNativeEvent } from "./media-native";

type VideoLimits = { maxDimension: number; maxBitrate: number; blockSize: number; maxBlocks: number; blocksPerSecond: number };
type Definition = ({ kind: "video"; mime: string; codec: string; profiles: [number, number][] } & VideoLimits)
  | { kind: "audio"; mime: string; codec: string; profiles: [number, number][]; rates: string };
const avc42 = { maxDimension: 4096, maxBitrate: 50000000, blockSize: 16, maxBlocks: 8704, blocksPerSecond: 522240 };
const definitions: Definition[] = [
  { kind: "video", mime: "video/avc", codec: "avc1.42002A", ...avc42, profiles: [[1, 8192]] },
  { kind: "video", mime: "video/avc", codec: "avc1.4d002A", ...avc42, profiles: [[2, 8192]] },
  { kind: "video", mime: "video/avc", codec: "avc1.64002A", ...avc42, maxBitrate: 62500000, profiles: [[8, 8192]] },
  { kind: "video", mime: "video/hevc", codec: "hvc1.1.6.L123.B0", ...avc42, profiles: [[1, 4096]] },
  { kind: "video", mime: "video/x-vnd.on2.vp8", codec: "vp8", maxDimension: 16383, maxBitrate: 100000000, blockSize: 16, maxBlocks: 0x7fffffff, blocksPerSecond: 0x7fffffff, profiles: [[1, 8]] },
  { kind: "video", mime: "video/x-vnd.on2.vp9", codec: "vp09.00.41.08", maxDimension: 4160, maxBitrate: 30000000, blockSize: 8, maxBlocks: 34816, blocksPerSecond: 2506752, profiles: [[1, 128]] },
  { kind: "audio", mime: "audio/mp4a-latm", codec: "mp4a.40.2", profiles: [[2, 0]], rates: "7350-96000" },
  { kind: "audio", mime: "audio/mpeg", codec: "mp3", profiles: [], rates: "8000-48000" },
  { kind: "audio", mime: "audio/opus", codec: "opus", profiles: [], rates: "8000-48000" },
];
/** the first definition for a type, whether or not the browser decodes it */
export const definitionFor = (mime: string): Definition | undefined => definitions.find((d) => d.mime === mime);
const codecName = (def: Definition) => "webcodecs." + def.codec;
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
  if (mime === "video/hevc") for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] || data[i + 1] || data[i + 2] !== 1) continue;
    const type = data[i + 3] >>> 1 & 63;
    if (type <= 31) return type >= 16 && type <= 21;
  }
  return false;
}
/** a decoder chunk for an access unit; AVC and HEVC parameter sets (csd-0, csd-1) lead the first */
export function videoChunk(mime: string, format: NativeFormat, data: Uint8Array, timestamp: number, key: boolean, first: boolean): EncodedVideoChunk {
  const csd = first && (mime === "video/avc" || mime === "video/hevc") ? csdBytes(format, "csd-0") : undefined;
  if (csd) data = concat([csd, csdBytes(format, "csd-1") ?? new Uint8Array(0), data]);
  return new EncodedVideoChunk({ type: key || videoKeyFrame(mime, data) ? "key" : "delta", timestamp, data });
}
export function videoConfig(def: Definition, format: NativeFormat): VideoDecoderConfig {
  const specified = format.string("codecs-string");
  let codec = def.mime === "video/hevc" && /^(hvc1|hev1)\./.test(specified) ? specified : def.codec;
  const data = csdBytes(format, "csd-0");
  if (def.mime === "video/avc" && data) {
    for (let i = 0; i + 7 < data.length; i++) if (data[i] === 0 && data[i + 1] === 0 && (data[i + 2] === 1 || data[i + 2] === 0 && data[i + 3] === 1)) {
      const start = i + (data[i + 2] === 1 ? 3 : 4);
      if ((data[start] & 31) === 7) { codec = "avc1." + [...data.subarray(start + 1, start + 4)].map(b => b.toString(16).padStart(2, "0")).join(""); break; }
    }
  }
  return { codec, codedWidth: format.number("width", 640), codedHeight: format.number("height", 360), optimizeForLatency: true };
}
function audioConfig(def: Definition, format: NativeFormat): AudioDecoderConfig {
  return { codec: def.codec, sampleRate: format.number("sample-rate", 48000), numberOfChannels: format.number("channel-count", 2), description: csdBytes(format, "csd-0") };
}
async function supported(def: Definition): Promise<boolean> {
  const format = new NativeFormat();
  try {
    return def.kind === "video" ? typeof VideoDecoder !== "undefined" && (await VideoDecoder.isConfigSupported(videoConfig(def, format))).supported === true
      : typeof AudioDecoder !== "undefined" && (await AudioDecoder.isConfigSupported(audioConfig(def, format))).supported === true;
  } catch { return false; }
}
let probed: Promise<Definition[]> | null = null;
/** the codec list: each definition a browser decoder accepts */
const codecs = (): Promise<Definition[]> =>
  probed ??= Promise.all(definitions.map(async d => await supported(d) ? d : null)).then(a => a.filter(v => v !== null));

// ── MediaCodecList: MediaCodecInfo and its capabilities are AOSP's Java over these answers.
// The capability map is what media_codecs.xml gives a codec, which CodecCapabilities parses.
const CPL = "android/media/MediaCodecInfo$CodecProfileLevel";
function capabilityMap(def: Definition): Record<string, string> {
  if (def.kind === "audio") return { "sample-rate-ranges": def.rates, "max-channel-count": "2", "bitrate-range": "8000-510000" };
  const b = def.blockSize;
  return { "size-range": `${b}x${b}-${def.maxDimension}x${def.maxDimension}`, "alignment": "2x2", "block-size": `${b}x${b}`,
    "block-count-range": `1-${def.maxBlocks}`, "blocks-per-second-range": `1-${def.blocksPerSecond}`, "bitrate-range": `1-${def.maxBitrate}`,
    "frame-rate-range": "0-960" };
}
const stringMap = (entries: Record<string, string>) =>
  formatToJava(Object.entries(entries).reduce((format, [k, v]) => format.set(k, TYPE_STRING, v), new NativeFormat()));
const capabilities = driven(function* capabilities$(def: Definition): Gen<JObj> {
  const levels: JObj[] = [];
  for (const [profile, level] of def.profiles) levels.push(setDeclared(yield newObj(CPL), CPL, { profile, level }));
  // COLOR_FormatYUV420Flexible, and the planar and semi-planar layouts a VideoFrame copies out as
  const colors = def.kind === "video" ? Int32Array.of(0x7f420888, 19, 21) : new Int32Array(0);
  return newObj("android/media/MediaCodecInfo$CodecCapabilities", `([L${CPL};[IZLjava/util/Map;Ljava/util/Map;)V`,
    jarray(levels, `L${CPL};`), colors, 0, yield stringMap({ mime: def.mime }), yield stringMap(capabilityMap(def)));
});
const at = (index: number) => after(codecs(), (list) => {
  const def = list[index];
  if (!def) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
  return def;
});
/** no MediaCodecInfo flag: not an encoder, and a browser decoder may or may not use hardware */
const ATTRIBUTES = 0;
rt.registerJnis("android/media/MediaCodecList", {
  "native_init()V": () => {},
  "native_getCodecCount()I": () => after(codecs(), (list) => list.length),
  "getCodecName(I)Ljava/lang/String;": (i: number) => after(at(i), codecName),
  "getCanonicalName(I)Ljava/lang/String;": (i: number) => after(at(i), codecName),
  "getAttributes(I)I": (i: number) => after(at(i), () => ATTRIBUTES),
  "getSupportedTypes(I)[Ljava/lang/String;": (i: number) => after(at(i), (def) => jarray([def.mime], "Ljava/lang/String;")),
  "getCodecCapabilities(ILjava/lang/String;)Landroid/media/MediaCodecInfo$CodecCapabilities;": (i: number, type: string) => after(at(i), (def) => {
    if (type !== def.mime) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    return capabilities(def);
  }),
  "findCodecByName(Ljava/lang/String;)I": (name: string) => after(codecs(), (list) => list.findIndex((d) => codecName(d) === name)),
  "native_getGlobalSettings()Ljava/util/Map;": () => newObj("java/util/HashMap"),
});

// ── a codec
export type Info = { offset: number; size: number; time: bigint; flags: number };
type Output = { kind: "video"; frame: VideoFrame; info: Info } | { kind: "video-buffer" | "audio"; buffer: JBuffer; info: Info } | { kind: "end"; info: Info };
const CB_INPUT_AVAILABLE = 1, CB_OUTPUT_AVAILABLE = 2, CB_ERROR = 3, CB_OUTPUT_FORMAT_CHANGE = 4;
const EVENT_CALLBACK = 1, EVENT_FRAME_RENDERED = 3;
const info = (time: bigint, size = 0, flags = 0): Info => ({ offset: 0, size, time, flags });
const illegalState = (message: string | null) => rt.mkThrowable("java/lang/IllegalStateException", message);
/** A started codec's session, from start() to the stop, flush or reset that closes it: its decoder,
 *  buffer indices and outputs. Its callbacks act, and its events reach Java, only while it is the codec's run. */
class Run {
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
  prepend = true;
  error: string | null = null;
  waiters = new Set<() => void>();
  scheduled = new Map<ReturnType<typeof setTimeout>, VideoFrame>();
  constructor(readonly codec: Codec) {
    const { def, format } = codec, outputFormat = new NativeFormat(format);
    const error = (e: unknown) => { if (this.live()) this.fail(e); };
    if (def.kind === "video") {
      outputFormat.set("mime", TYPE_STRING, "video/raw");
      const decoder = this.decoder = new VideoDecoder({ error, output: frame => this.frame(frame) });
      decoder.configure(videoConfig(def, format));
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
    if (this.codec.owner) postNativeEvent(this.codec.owner, this.live, what, arg1, arg2, obj);
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
  busy(): boolean { return this.inFlight + this.outputs.size + this.scheduled.size >= 8; }
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
    if (!(flags & 2) && size) {
      this.inFlight++;
      if (decoder instanceof VideoDecoder) {
        decoder.decode(videoChunk(this.codec.def.mime, this.codec.format, data, Number(timestamp), !!(flags & 1), this.prepend));
        this.prepend = false;
      } else decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: Number(timestamp), data }));
    }
    this.available.add(index);
    if (flags & 4) {
      this.ending = true;
      void decoder.flush().then(() => { if (this.live()) this.output({ kind: "end", info: info(timestamp, 0, 4) }); })
        .catch(e => { if (this.live()) this.fail(e); });
    } else this.pump();
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
            const media = output.info.time, nano = BigInt(Math.floor(performance.now() * 1e6));
            this.post(EVENT_FRAME_RENDERED, 0, 0, () => formatToJava(new NativeFormat().set("0-media-time-us", TYPE_LONG, media).set("0-system-nano", TYPE_LONG, nano)));
          }
        } else output.frame.close();
      };
      const delay = timeNs === undefined ? 0 : Number(timeNs) / 1e6 - performance.now();
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
  /** owner: the Java MediaCodec events go to, absent for an AMediaCodec */
  constructor(readonly def: Definition, readonly owner: JObj | null = null) {}
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
  codecs().then((list) => { const def = list.find((d) => nameIsType ? d.mime === name : codecName(d) === name); return def ? new Codec(def, owner) : null; });

// ── MediaCodec's natives
const MC = "android/media/MediaCodec";
const peers = nativePeer<Codec>(MC, null, (c) => c.release());
const C = peers.on;
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
  "native_configure([Ljava/lang/String;[Ljava/lang/Object;Landroid/view/Surface;Landroid/media/MediaCrypto;Landroid/os/IHwBinder;I)V": C((c,
    keys: string[] | null, values: unknown[] | null, surface: JObj | null, crypto: unknown, descrambler: unknown, flags: number) => {
    // a decoder cannot encode (CONFIGURE_FLAG_ENCODE), and no crypto plugin exists to decrypt
    if (flags & 1 || crypto || descrambler) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    c.configure(formatFromJava(keys, values), surface);
  }),
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
  "getBuffers(Z)[Ljava/nio/ByteBuffer;": C((c, input: number) => {
    // output buffers are allocated per frame, so only input buffers form a fixed array
    if (!input || c.async) throw illegalState(null);
    return jarray(c.inputs.slice(), "Ljava/nio/ByteBuffer;");
  }),
  "getBuffer(ZI)Ljava/nio/ByteBuffer;": C((c, input: number, index: number) => {
    if (input) { const b = c.inputs[index]; if (b) { setLimit(b, bufferCapacity(b)); setPosition(b, 0); } return b ?? null; }
    const b = c.run?.outputBuffer(index) ?? null, i = c.run?.outputs.get(index)?.info;
    if (b && i) { setLimit(b, i.offset + i.size); setPosition(b, i.offset); }
    return b;
  }),
  "getImage(ZI)Landroid/media/Image;": () => null,
  "getFormatNative(Z)Ljava/util/Map;": C((c, input: number) => formatToJava(input ? c.format : c.outputFormat)),
  "getOutputFormatNative(I)Ljava/util/Map;": C((c) => formatToJava(c.outputFormat)),
  "getCanonicalName()Ljava/lang/String;": C((c) => codecName(c.def)),
  "getOwnCodecInfo()Landroid/media/MediaCodecInfo;": C((c) => after(capabilities(c.def), (caps) => newObj("android/media/MediaCodecInfo",
    "(Ljava/lang/String;Ljava/lang/String;I[Landroid/media/MediaCodecInfo$CodecCapabilities;)V",
    codecName(c.def), codecName(c.def), ATTRIBUTES, jarray([caps], "Landroid/media/MediaCodecInfo$CodecCapabilities;")))),
  "native_setSurface(Landroid/view/Surface;)V": C((c, surface: JObj) => { c.surface = surface; }),
  "native_detachOutputSurface()V": C((c) => { c.surface = null; }),
  // the decoders take no parameters while running, and scale only to fit
  "setParameters([Ljava/lang/String;[Ljava/lang/Object;)V": C(() => {}),
  "setVideoScalingMode(I)V": C(() => {}),
});
