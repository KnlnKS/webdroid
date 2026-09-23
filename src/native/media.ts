import { JMediaFormat } from "../android/media-format";
import { MediaExtractor } from "../android/media-extractor";
import { createCodec, type JMediaCodec } from "../android/media-codec";
import { JBufferInfo } from "../android/media";
import { directBufferAddress, JBuffer, mkByteBuffer } from "../jvm/natives/jnio";
import { SliceFile, type FileSource } from "../shell/lazyfile";
import { javaCloseFd, javaDupFd, javaFdSource, javaOpenFd } from "./stdio";
import { windowOf } from "./libandroid";
import { mem } from "./mem";
import { cstr, hostData, hostLib, PTR, ptr, stp, stpVa, type HostFn } from "./host";
import type { Cpu } from "./cpu";

const INVALID = -10004, BAD_OBJECT = -10003, UNSUPPORTED = -10002, IO = -10007;
let nextHandle = 1;
const formats = new Map<number, { value: JMediaFormat; strings: Map<string, number> }>();
const codecs = new Map<number, JMediaCodec>();
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
function addFormat(value: JMediaFormat): number {
  const handle = nextHandle++, copy = new JMediaFormat(); copy.values = new Map(value.values);
  formats.set(handle, { value: copy, strings: new Map() }); return handle;
}
function sizeOut(cpu: Cpu, address: number, size: number): void { if (address) { if (cpu.a64) mem.st64(address, BigInt(size)); else mem.st32(address, size); } }
function codecStatus(action: (codec: JMediaCodec) => void): HostFn {
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
function openFd(cpu: Cpu, handle: number, fd: number, offset: number, length: number): Promise<number> | number {
  const copy = javaDupFd(fd), file = javaFdSource(copy);
  if (!file || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || offset > file.size) { if (copy >= 0) javaCloseFd(copy); return INVALID; }
  const source = new SliceFile(file, offset, Math.min(length, file.size - offset));
  return openExtractor(cpu, handle, () => source, () => javaCloseFd(copy));
}
export function mediaInit(): void {
  const api: Record<string, HostFn> = {
    AMediaFormat_new: () => addFormat(new JMediaFormat()),
    AMediaFormat_delete: (_cpu, a) => { const handle = a.p(), format = formats.get(handle); if (!format) return BAD_OBJECT; for (const p of format.strings.values()) mem.free(p); formats.delete(handle); return 0; },
    AMediaFormat_getString: (_cpu, a) => {
      const format = formats.get(a.p()), key = a.str(), out = a.p(), value = format?.value.values.get(key)?.value;
      if (!format || !out || typeof value !== "string") return 0;
      let p = format.strings.get(key); if (!p) { p = mem.strdup(value); format.strings.set(key, p); } stp(out, p); return 1;
    },
    AMediaFormat_setString: (_cpu, a) => {
      const format = formats.get(a.p()), key = a.str(), value = a.str(); if (!format) return;
      const previous = format.strings.get(key); if (previous) mem.free(previous); format.strings.delete(key);
      format.value.values.set(key, { type: 4, value });
    },
    AMediaFormat_getBuffer: (cpu, a) => {
      const format = formats.get(a.p()), key = a.str(), out = a.p(), size = a.p(), value = format?.value.values.get(key)?.value;
      if (!(value instanceof JBuffer) || !out) return 0;
      stpVa(out, directBufferAddress(value)); sizeOut(cpu, size, value.cap); return 1;
    },
    AMediaFormat_setBuffer: (_cpu, a) => {
      const format = formats.get(a.p()), key = a.str(), data = a.p(), size = a.u(); if (!format) return;
      const value = mkByteBuffer(size, true); new Uint8Array(value.ab).set(mem.bytes(data, size)); format.value.values.set(key, { type: 5, value });
    },
    AMediaExtractor_new: () => { const handle = nextHandle++; extractors.set(handle, { value: new MediaExtractor(), source: null, close: null }); return handle; },
    AMediaExtractor_delete: async (cpu, a) => { const handle = a.p(), extractor = extractors.get(handle); if (!extractor) return BAD_OBJECT; extractors.delete(handle); await extractor.close?.(cpu); return 0; },
    AMediaExtractor_setDataSourceFd: (cpu, a) => { const handle = a.p(), fd = a.i(), offset = Number(a.l()), length = Number(a.l()); return openFd(cpu, handle, fd, offset, length); },
    AMediaExtractor_setDataSource: async (cpu, a) => {
      const handle = a.p(), path = a.str(), fd = javaOpenFd(path.startsWith("file://") ? decodeURI(path.slice(7)) : path, 0);
      if (fd < 0) return IO;
      try { return await openFd(cpu, handle, fd, 0, javaFdSource(fd)?.size ?? 0); } finally { javaCloseFd(fd); }
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
      const extractor = extractors.get(a.p()), out = a.p(), capacity = a.u(); if (!extractor?.source) return -1;
      try { const data = await extractor.value.read(extractor.source(cpu)); if (!data) return -1; if (data.length > capacity) return INVALID; mem.bytes(out, data.length).set(data); return data.length; } catch { return IO; }
    },
    AMediaDataSource_new: () => { const handle = nextHandle++; sources.set(handle, new DataSource()); return handle; },
    AMediaDataSource_delete: async (cpu, a) => { const handle = a.p(), source = sources.get(handle); sources.delete(handle); await source?.close(cpu); },
    AMediaCodec_createDecoderByType: async (_cpu, a) => { const mime = a.str(); try { const codec = await createCodec(mime, true), handle = nextHandle++; codecs.set(handle, codec); return handle; } catch { return 0; } },
    AMediaCodec_delete: (_cpu, a) => { const handle = a.p(), codec = codecs.get(handle); if (!codec) return BAD_OBJECT; codec.reset(); codec.inputs = []; codec.released = true; codecs.delete(handle); return 0; },
    AMediaCodec_configure: (_cpu, a) => {
      const codec = codecs.get(a.p()), format = formats.get(a.p()), window = a.p(), crypto = a.p(), flags = a.u();
      if (!codec || !format) return BAD_OBJECT; if (crypto || flags) return UNSUPPORTED;
      const surface = windowOf(window); if (window && !surface) return INVALID;
      try { codec.configure(format.value, surface, crypto, flags); return 0; } catch { return INVALID; }
    },
    AMediaCodec_start: codecStatus(codec => codec.start()),
    AMediaCodec_stop: codecStatus(codec => codec.reset()),
    AMediaCodec_flush: codecStatus(codec => { const restart = codec.started; codec.reset(); if (restart) codec.start(); }),
    AMediaCodec_getInputBuffer: (cpu, a) => { const codec = codecs.get(a.p()), index = a.u(), size = a.p(), buffer = codec?.inputs[index]; sizeOut(cpu, size, buffer?.cap ?? 0); return buffer ? directBufferAddress(buffer) : 0; },
    AMediaCodec_getOutputBuffer: (cpu, a) => { const output = codecs.get(a.p())?.outputs.get(a.u()), size = a.p(), buffer = output?.kind === "audio" || output?.kind === "video-buffer" ? output.buffer : null; sizeOut(cpu, size, buffer?.cap ?? 0); return buffer ? directBufferAddress(buffer) : 0; },
    AMediaCodec_dequeueInputBuffer: (_cpu, a) => { const codec = codecs.get(a.p()), timeout = a.l(); if (!codec) return BAD_OBJECT; try { const result = codec.dequeueInput(timeout); return result instanceof Promise ? result.catch(() => INVALID) : result; } catch { return INVALID; } },
    AMediaCodec_dequeueOutputBuffer: (_cpu, a) => {
      const codec = codecs.get(a.p()), out = a.p(), timeout = a.l(); if (!codec || !out) return INVALID;
      const info = new JBufferInfo();
      const done = (index: number) => { if (index >= 0) { mem.st32(out, info.offset); mem.st32(out + 4, info.size); mem.st64(out + 8, info.presentationTimeUs); mem.st32(out + 16, info.flags); } return index; };
      try { const result = codec.dequeueOutput(info, timeout); return result instanceof Promise ? result.then(done, () => INVALID) : done(result); } catch { return INVALID; }
    },
    AMediaCodec_queueInputBuffer: (_cpu, a) => {
      const codec = codecs.get(a.p()), index = a.u(), offset = a.u(), size = a.u(), time = a.l(), flags = a.u(); if (!codec) return BAD_OBJECT;
      try { codec.queue(index, offset, size, time, flags); return 0; } catch { return INVALID; }
    },
    AMediaCodec_getOutputFormat: (_cpu, a) => { const codec = codecs.get(a.p()); return codec ? addFormat(codec.outputFormat) : 0; },
    AMediaCodec_releaseOutputBuffer: (_cpu, a) => { const codec = codecs.get(a.p()), index = a.u(), render = a.i(); if (!codec) return BAD_OBJECT; try { codec.releaseOutput(index, !!render); return 0; } catch { return INVALID; } },
    AMediaCodec_setOutputSurface: (_cpu, a) => { const codec = codecs.get(a.p()), surface = windowOf(a.p()); if (!codec || !surface) return INVALID; codec.surface = surface; return 0; },
  };
  for (const [suffix, key] of [["Userdata", "userdata"], ["ReadAt", "readAt"], ["GetSize", "getSize"], ["Close", "closeAt"]] as const) {
    api["AMediaDataSource_set" + suffix] = (_cpu, a) => { const source = sources.get(a.p()), value = a.p(); if (source) source[key] = value; };
  }
  for (const [suffix, type] of [["Int32", 1], ["Int64", 2], ["Float", 3]] as const) {
    api["AMediaFormat_get" + suffix] = (_cpu, a) => {
      const format = formats.get(a.p()), key = a.str(), out = a.p(), entry = format?.value.values.get(key);
      if (!out || entry?.type !== type) return 0;
      if (type === 2 && typeof entry.value === "bigint") mem.st64(out, entry.value);
      else if (typeof entry.value === "number") { if (type === 3) mem.stf32(out, entry.value); else mem.st32(out, entry.value); }
      else return 0;
      return 1;
    };
    api["AMediaFormat_set" + suffix] = (_cpu, a) => { const format = formats.get(a.p()), key = a.str(), value = type === 2 ? a.l() : type === 3 ? a.f() : a.i(); format?.value.values.set(key, { type, value }); };
  }
  hostLib("libmediandk.so", api, { closed: true });
  const keys = { MIME: "mime", DURATION: "durationUs", WIDTH: "width", HEIGHT: "height", FRAME_RATE: "frame-rate", ROTATION: "rotation-degrees", CHANNEL_COUNT: "channel-count", SAMPLE_RATE: "sample-rate", LANGUAGE: "language", COLOR_FORMAT: "color-format", COLOR_RANGE: "color-range", COLOR_STANDARD: "color-standard", STRIDE: "stride", SLICE_HEIGHT: "slice-height", ENCODER_DELAY: "encoder-delay", MAX_INPUT_SIZE: "max-input-size", BIT_RATE: "bitrate" };
  for (const [name, key] of Object.entries(keys)) { const address = mem.hostAlloc(PTR); stp(address, cstr(key)); hostData("libmediandk.so", "AMEDIAFORMAT_KEY_" + name, address); }
}
