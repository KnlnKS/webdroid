import { NativeFormat, TYPE_BYTE_BUFFER, TYPE_FLOAT, TYPE_INTEGER, TYPE_LONG, TYPE_STRING } from "../android/media-format.ts";
import { fdSlice } from "../android/media-native.ts";
import { MediaExtractor } from "../android/media-extractor.ts";
import { createCodec, type Codec, type Info } from "../android/media-codec.ts";
import { capacity, directAddress, directCopy, directReady } from "../jvm/natives/jnio.ts";
import { after } from "../jvm/natives/jentry.ts";
import type { FileSource } from "../shell/lazyfile.ts";
import { closeFd, dupFd } from "./fd.ts";
import { processOpenFd } from "./process-fd.ts";
import { windowOf } from "./libandroid.ts";
import { mem, anchor } from "./mem.ts";
import { cstr, hostData, hostLib, PTR, ptr, stp, stpVa, stLong, type HostFn } from "./host.ts";
import type { Cpu } from "./cpu.ts";

const INVALID = -10004, BAD_OBJECT = -10003, UNSUPPORTED = -10002, IO = -10007;
let nextHandle = 1;
const formats = new Map<number, { value: NativeFormat; strings: Map<string, number> }>();
const codecs = new Map<number, Codec>();
const extractors = new Map<number, { value: MediaExtractor; source: ((cpu: Cpu) => FileSource) | null; close: ((cpu: Cpu) => void | Promise<void>) | null }>();
class DataSource {
  userdata = 0; readAt = 0; getSize = 0; closeAt = 0; closed = false;
  async close(cpu: Cpu): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.closeAt) await cpu.call(this.closeAt, [ptr(this.userdata)], "media source close");
  }
  file(cpu: Cpu, size: number): FileSource {
    return { size, read: async (offset, length) => {
      if (this.closed || !this.readAt) throw new Error("Media source is closed");
      const buffer = mem.malloc(length);
      try {
        const count = await cpu.call(this.readAt, [ptr(this.userdata), BigInt(offset), ptr(buffer), length], "media source read");
        if (count > length) throw new Error("Invalid media source read length");
        return count <= 0 ? new Uint8Array() : mem.bytes(buffer, count).slice();
      } finally { mem.free(buffer); }
    } };
  }
}
const sources = new Map<number, DataSource>();
function addFormat(value: NativeFormat): number {
  const handle = nextHandle++;
  formats.set(handle, { value: new NativeFormat(value), strings: new Map() }); return handle;
}
function sizeOut(address: number, size: number): void { if (address) stLong(address, size); }
function codecStatus(action: (codec: Codec) => void): HostFn {
  return (_cpu, args) => { const codec = codecs.get(args.p()); if (!codec) return BAD_OBJECT; try { action(codec); return 0; } catch { return INVALID; } };
}
async function openExtractor(cpu: Cpu, handle: number, source: (cpu: Cpu) => FileSource, close: (cpu: Cpu) => void | Promise<void>): Promise<number> {
  const extractor = extractors.get(handle);
  if (!extractor) { await close(cpu); return BAD_OBJECT; }
  if (extractor.source) { await close(cpu); return INVALID; }
  try {
    await extractor.value.open(source(cpu)); extractor.source = source; extractor.close = close; return 0;
  } catch (error) { console.warn("[media extractor]", error); await close(cpu); return UNSUPPORTED; }
}
async function openFd(cpu: Cpu, handle: number, fd: number, offset: bigint, length: bigint): Promise<number> {
  const copy = dupFd(fd), source = await fdSlice(copy, offset, length);
  if (!source) { if (copy >= 0) await closeFd(copy); return INVALID; }
  return openExtractor(cpu, handle, () => source, () => after(closeFd(copy), () => {}));
}
export function mediaInit(): void {
  const api: Record<string, HostFn> = {
    AMediaFormat_new: () => addFormat(new NativeFormat()),
    AMediaFormat_delete: (_cpu, a) => { const handle = a.p(), format = formats.get(handle); if (!format) return BAD_OBJECT; for (const p of format.strings.values()) mem.free(p); formats.delete(handle); return 0; },
    AMediaFormat_getString: (_cpu, a) => {
      const format = formats.get(a.p()), key = a.str(), out = a.p(), value = format?.value.get(key, TYPE_STRING);
      if (!format || !out || typeof value !== "string") return 0;
      let p = format.strings.get(key); if (!p) { p = mem.strdup(value); format.strings.set(key, p); } stp(out, p); return 1;
    },
    AMediaFormat_setString: (_cpu, a) => {
      const format = formats.get(a.p()), key = a.str(), value = a.str(); if (!format) return;
      const previous = format.strings.get(key); if (previous) mem.free(previous); format.strings.delete(key);
      format.value.set(key, TYPE_STRING, value);
    },
    AMediaFormat_getBuffer: (_cpu, a) => {
      const format = formats.get(a.p()), key = a.str(), out = a.p(), size = a.p(), value = format?.value.buffer(key);
      if (!value || !out) return 0;
      return after(directAddress(value), (address) => { stpVa(out, address); sizeOut(size, capacity(value)); return 1; });
    },
    AMediaFormat_setBuffer: (_cpu, a) => {
      const format = formats.get(a.p()), key = a.str(), data = a.p(), size = a.u(); if (!format) return;
      return after(directCopy(mem.bytes(data, size)), (value) => { format.value.set(key, TYPE_BYTE_BUFFER, value); });
    },
    AMediaExtractor_new: () => { const handle = nextHandle++; extractors.set(handle, { value: new MediaExtractor(), source: null, close: null }); return handle; },
    AMediaExtractor_delete: async (cpu, a) => { const handle = a.p(), extractor = extractors.get(handle); if (!extractor) return BAD_OBJECT; extractors.delete(handle); await extractor.close?.(cpu); return 0; },
    AMediaExtractor_setDataSourceFd: (cpu, a) => { const handle = a.p(), fd = a.i(), offset = a.l(), length = a.l(); return openFd(cpu, handle, fd, offset, length); },
    AMediaExtractor_setDataSource: async (cpu, a) => {
      const handle = a.p(), path = a.str(), fd = await processOpenFd(path.startsWith("file://") ? decodeURI(path.slice(7)) : path, 0);
      if (fd < 0) return IO;
      // the whole file: fdSlice bounds a slice by the file's size
      try { return await openFd(cpu, handle, fd, 0n, BigInt(Number.MAX_SAFE_INTEGER)); } finally { await closeFd(fd); }
    },
    AMediaExtractor_setDataSourceCustom: async (cpu, a) => {
      const handle = a.p(), source = sources.get(a.p());
      if (!source || source.closed || !source.getSize || !source.readAt) return INVALID;
      const size = await cpu.call(source.getSize, [ptr(source.userdata)], "media source size");
      if (size <= 0) return UNSUPPORTED;
      return openExtractor(cpu, handle, cpu => source.file(cpu, size), cpu => source.close(cpu));
    },
    AMediaExtractor_getTrackCount: (_cpu, a) => extractors.get(a.p())?.value.tracks.length ?? 0,
    AMediaExtractor_getTrackFormat: (_cpu, a) => { const track = extractors.get(a.p())?.value.tracks[a.u()]; return track ? addFormat(track.format) : 0; },
    AMediaExtractor_selectTrack: (_cpu, a) => { const track = extractors.get(a.p())?.value.tracks[a.u()]; if (!track) return INVALID; track.selected = true; return 0; },
    AMediaExtractor_unselectTrack: (_cpu, a) => { const track = extractors.get(a.p())?.value.tracks[a.u()]; if (!track) return INVALID; track.selected = false; return 0; },
    AMediaExtractor_getSampleTime: (_cpu, a) => BigInt(extractors.get(a.p())?.value.current()?.time ?? -1),
    AMediaExtractor_getSampleTrackIndex: (_cpu, a) => extractors.get(a.p())?.value.current()?.index ?? -1,
    AMediaExtractor_getSampleFlags: (_cpu, a) => +(extractors.get(a.p())?.value.current()?.sample.is_sync ?? false),
    AMediaExtractor_advance: (_cpu, a) => +(extractors.get(a.p())?.value.advance() ?? false),
    AMediaExtractor_seekTo: (_cpu, a) => { const extractor = extractors.get(a.p()), time = Number(a.l()), mode = a.i(); if (!extractor || mode < 0 || mode > 2) return INVALID; extractor.value.seek(time, mode); return 0; },
    AMediaExtractor_readSampleData: async (cpu, a) => {
      const extractor = extractors.get(a.p()), out = anchor(a.p()), capacity = a.u(); if (!extractor?.source) return -1;
      try { const data = await extractor.value.read(extractor.source(cpu)); if (!data) return -1; if (data.length > capacity) return INVALID; mem.write(out(), data); return data.length; } catch { return IO; }
    },
    AMediaDataSource_new: () => { const handle = nextHandle++; sources.set(handle, new DataSource()); return handle; },
    AMediaDataSource_delete: async (cpu, a) => { const handle = a.p(), source = sources.get(handle); sources.delete(handle); await source?.close(cpu); },
    AMediaCodec_createDecoderByType: async (_cpu, a) => { const codec = await createCodec(a.str(), true); if (!codec) return 0; const handle = nextHandle++; codecs.set(handle, codec); return handle; },
    AMediaCodec_delete: (_cpu, a) => { const handle = a.p(), codec = codecs.get(handle); if (!codec) return BAD_OBJECT; codec.release(); codecs.delete(handle); return 0; },
    AMediaCodec_configure: (_cpu, a) => {
      const codec = codecs.get(a.p()), format = formats.get(a.p()), window = a.p(), crypto = a.p(), flags = a.u();
      if (!codec || !format) return BAD_OBJECT; if (crypto || flags) return UNSUPPORTED;
      const surface = windowOf(window); if (window && !surface) return INVALID;
      try { codec.configure(format.value, surface); return 0; } catch { return INVALID; }
    },
    AMediaCodec_start: (cpu, a) => after(directReady(), () => codecStatus(codec => codec.start())(cpu, a)),
    AMediaCodec_stop: codecStatus(codec => codec.reset()),
    AMediaCodec_flush: codecStatus(codec => codec.flush()),
    AMediaCodec_getInputBuffer: (_cpu, a) => { const codec = codecs.get(a.p()), index = a.u(), size = a.p(), buffer = codec?.inputs[index]; sizeOut(size, buffer ? capacity(buffer) : 0); return buffer ? directAddress(buffer) : 0; },
    AMediaCodec_getOutputBuffer: (_cpu, a) => { const buffer = codecs.get(a.p())?.run?.outputBuffer(a.u()) ?? null, size = a.p(); sizeOut(size, buffer ? capacity(buffer) : 0); return buffer ? directAddress(buffer) : 0; },
    AMediaCodec_dequeueInputBuffer: (_cpu, a) => { const codec = codecs.get(a.p()), timeout = a.l(); if (!codec) return BAD_OBJECT; try { const result = codec.running().dequeueInput(timeout); return result instanceof Promise ? result.catch(() => INVALID) : result; } catch { return INVALID; } },
    AMediaCodec_dequeueOutputBuffer: (_cpu, a) => {
      const codec = codecs.get(a.p()), info = a.p(), timeout = a.l(); if (!codec || !info) return INVALID;
      const at = anchor(info);
      const done = ([index, info]: [number, Info | null]) => { if (info) { const out = at(); mem.st32(out, info.offset); mem.st32(out + 4, info.size); mem.st64(out + 8, info.time); mem.st32(out + 16, info.flags); } return index; };
      try { const result = codec.running().dequeueOutput(timeout); return result instanceof Promise ? result.then(done, () => INVALID) : done(result); } catch { return INVALID; }
    },
    AMediaCodec_queueInputBuffer: (_cpu, a) => {
      const codec = codecs.get(a.p()), index = a.u(), offset = a.u(), size = a.u(), time = a.l(), flags = a.u(); if (!codec) return BAD_OBJECT;
      try { codec.running().queue(index, offset, size, time, flags); return 0; } catch { return INVALID; }
    },
    AMediaCodec_getOutputFormat: (_cpu, a) => { const codec = codecs.get(a.p()); return codec ? addFormat(codec.outputFormat) : 0; },
    AMediaCodec_releaseOutputBuffer: (_cpu, a) => { const codec = codecs.get(a.p()), index = a.u(), render = a.i(); if (!codec) return BAD_OBJECT; try { codec.running().releaseOutput(index, !!render); return 0; } catch { return INVALID; } },
    AMediaCodec_setOutputSurface: (_cpu, a) => { const codec = codecs.get(a.p()), surface = windowOf(a.p()); if (!codec || !surface) return INVALID; codec.surface = surface; return 0; },
  };
  for (const [suffix, key] of [["Userdata", "userdata"], ["ReadAt", "readAt"], ["GetSize", "getSize"], ["Close", "closeAt"]] as const) {
    api["AMediaDataSource_set" + suffix] = (_cpu, a) => { const source = sources.get(a.p()), value = a.p(); if (source) source[key] = value; };
  }
  for (const [suffix, type] of [["Int32", TYPE_INTEGER], ["Int64", TYPE_LONG], ["Float", TYPE_FLOAT]] as const) {
    api["AMediaFormat_get" + suffix] = (_cpu, a) => {
      const format = formats.get(a.p()), key = a.str(), out = a.p(), value = format?.value.get(key, type);
      if (!out) return 0;
      if (typeof value === "bigint") mem.st64(out, value);
      else if (typeof value === "number") { if (type === TYPE_FLOAT) mem.stf32(out, value); else mem.st32(out, value); }
      else return 0;
      return 1;
    };
    api["AMediaFormat_set" + suffix] = (_cpu, a) => { const format = formats.get(a.p()), key = a.str(), value = type === TYPE_LONG ? a.l() : type === TYPE_FLOAT ? a.f() : a.i(); format?.value.set(key, type, value); };
  }
  hostLib("libmediandk.so", api, { closed: true });
  const keys = { MIME: "mime", DURATION: "durationUs", WIDTH: "width", HEIGHT: "height", FRAME_RATE: "frame-rate", ROTATION: "rotation-degrees", CHANNEL_COUNT: "channel-count", SAMPLE_RATE: "sample-rate", LANGUAGE: "language", COLOR_FORMAT: "color-format", COLOR_RANGE: "color-range", COLOR_STANDARD: "color-standard", STRIDE: "stride", SLICE_HEIGHT: "slice-height", ENCODER_DELAY: "encoder-delay", MAX_INPUT_SIZE: "max-input-size", BIT_RATE: "bitrate" };
  for (const [name, key] of Object.entries(keys)) { const address = mem.hostAlloc(PTR); stp(address, cstr(key)); hostData("libmediandk.so", "AMEDIAFORMAT_KEY_" + name, address); }
}
