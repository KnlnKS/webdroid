import { PcmOutput, outputSampleRate, newAudioSessionId, burstFrames, minFrames } from "../android/audio-output.ts";
import { Cpu, callbackCpu } from "./cpu.ts";
import { processExited } from "../process-exit.ts";
import { hostLib, stp, ptr, type HostFn } from "./host.ts";
import { mem, anchor } from "./mem.ts";
import { msLeft, waitUntil } from "./poll.ts";
import { guestNow, uptimeNanos } from "../guest-clock.ts";
import { toThread } from "../jvm/natives/jthrowable.ts";
import { popcount } from "../bits.ts";

const INVALID = -898, INVALID_STATE = -895, INVALID_HANDLE = -892, UNAVAILABLE = -889, NULL = -886, OUT_OF_RANGE = -882;
/** what a stream opened with these unspecified (0) reports, as AudioStream::open resolves them */
const USAGE_MEDIA = 1, CONTENT_TYPE_MUSIC = 2, INPUT_PRESET_VOICE_RECOGNITION = 6;
const AAUDIO_STREAM_STATE_OPEN = 2, AAUDIO_STREAM_STATE_STARTED = 4, AAUDIO_STREAM_STATE_PAUSED = 6, AAUDIO_STREAM_STATE_FLUSHED = 8,
  AAUDIO_STREAM_STATE_STOPPING = 9, AAUDIO_STREAM_STATE_STOPPED = 10, AAUDIO_STREAM_STATE_CLOSED = 12;
const builders = new Map<number, Builder>(), streams = new Map<number, Stream>();
class Builder {
  SampleRate = 0; ChannelCount = 0; Format = 0; Direction = 0; SharingMode = 1;
  BufferCapacityInFrames = 0; FramesPerDataCallback = 0; PerformanceMode = 10;
  DeviceId = 0; SessionId = -1; Usage = 0; ContentType = 0; InputPreset = 0;
  callback = 0; context: number | bigint = 0;
}
class Stream {
  readonly handle: number; readonly config: Builder;
  readonly track: PcmOutput;
  readonly cpu: Cpu;
  readonly buffer: number;
  readonly frames: number;
  readonly capacity: number;
  size: number;
  state = AAUDIO_STREAM_STATE_OPEN;
  pumping: Promise<void> | null = null;
  readonly waiters = new Set<() => void>();
  constructor(handle: number, config: Builder) {
    this.handle = handle; this.config = config;
    const track = this.track = new PcmOutput({ rate: config.SampleRate || outputSampleRate(), channels: config.ChannelCount || 2,
      bytesPerSample: config.Format === 1 ? 2 : 4, sessionId: config.SessionId === 0 ? newAudioSessionId() : config.SessionId });
    this.frames = config.FramesPerDataCallback || burstFrames(track.rate);
    this.capacity = Math.max(config.BufferCapacityInFrames, this.frames * 4);
    this.size = this.capacity;
    this.buffer = mem.malloc(this.frames * track.frameBytes());
    this.cpu = callbackCpu("AAudio callback");
  }
  change(state: number): void { this.state = state; for (const wake of this.waiters) wake(); }
  pump(): void {
    if (this.pumping || !this.config.callback || this.state !== AAUDIO_STREAM_STATE_STARTED) return;
    this.pumping = this.fill().catch(toThread(this.cpu.jthread)).finally(() => { this.pumping = null; });
  }
  async fill(): Promise<void> {
    // below the stream's buffer the output holds about 100 ms more, as AudioFlinger's does: the next callback
    // runs while that plays, not once a buffer of one callback's frames has run dry
    const track = this.track, room = Math.max(this.size, this.frames + minFrames(track.rate));
    while (this.state === AAUDIO_STREAM_STATE_STARTED && !processExited() && track.queuedSec() * track.rate + this.frames <= room) {
      const result = await this.cpu.call(this.config.callback, [this.handle, this.config.context, this.buffer, this.frames], "AAudio data callback");
      if (this.state !== AAUDIO_STREAM_STATE_STARTED) break;
      if (result !== 0) { this.stop(); break; }
      const bytes = mem.bytes(this.buffer, this.frames * track.frameBytes());
      const samples = track.bytesPerSample === 2 ? new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2) : new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      track.push(samples, this.frames, () => {
        if (this.state === AAUDIO_STREAM_STATE_STOPPING && track.idle) this.change(AAUDIO_STREAM_STATE_STOPPED);
        else this.pump();
      });
    }
  }
  start(): number {
    if (this.state === AAUDIO_STREAM_STATE_CLOSED || this.state === AAUDIO_STREAM_STATE_STOPPING) return INVALID_STATE;
    this.track.play(); this.change(AAUDIO_STREAM_STATE_STARTED); this.pump(); return 0;
  }
  stop(): number {
    this.change(this.track.stop() ? AAUDIO_STREAM_STATE_STOPPING : AAUDIO_STREAM_STATE_STOPPED);
    return 0;
  }
  async close(): Promise<number> {
    this.change(AAUDIO_STREAM_STATE_CLOSED); this.track.release();
    await this.pumping;
    await this.cpu.endThread(); this.cpu.dispose(); mem.free(this.buffer); mem.free(this.handle);
    streams.delete(this.handle); return 0;
  }
  /** AAudioStream_waitForStateChange: the timeout is the app's, on the guest clock; the changes
   *  come at the audio clock's pace, a drain's STOPPED once the output has played its queue */
  wait(input: number, out: () => number, nanos: bigint): PromiseOrVal<number> {
    const done = () => { const at = out(); if (at) mem.st32(at, this.state); return this.state === input ? -885 : 0; };
    if (this.state !== input || nanos <= 0n) return done();
    const timeout = Number(nanos / 1000000n), deadline = guestNow() + timeout;
    const subscribe = (wake: () => void) => { this.waiters.add(wake); return () => { this.waiters.delete(wake); }; };
    const next = (): Promise<number> => waitUntil(subscribe, msLeft(timeout, deadline)).then(woken => woken && this.state === input ? next() : done());
    return next();
  }
}
type Setting = "SampleRate" | "ChannelCount" | "Format" | "Direction" | "SharingMode" | "BufferCapacityInFrames" | "FramesPerDataCallback" | "PerformanceMode" | "DeviceId" | "SessionId" | "Usage" | "ContentType" | "InputPreset";
export function aaudioInit(): void {
  const methods: Record<string, HostFn> = {
    AAudio_createStreamBuilder: (_cpu, a) => { const out = a.p(); if (!out) return NULL; const p = mem.malloc(4); builders.set(p, new Builder()); stp(out, p); return 0; },
    AAudioStreamBuilder_delete: (_cpu, a) => { const p = a.p(); if (!builders.delete(p)) return INVALID_HANDLE; mem.free(p); return 0; },
    AAudioStreamBuilder_openStream: (_cpu, a) => {
      const b = builders.get(a.p()), out = a.p(); if (!b) return INVALID_HANDLE; if (!out) return NULL; stp(out, 0);
      if (b.Direction !== 0 || (b.DeviceId !== 0 && b.DeviceId !== 1) || !b.callback) return UNAVAILABLE;
      if (b.SessionId < -1) return INVALID;
      if (b.SampleRate !== 0 && (b.SampleRate < 8000 || b.SampleRate > 192000)) return -880;
      if (![0, 1, 2].includes(b.Format)) return -883;
      if (![0, 1, 2].includes(b.ChannelCount) || ![0, 1].includes(b.SharingMode) || ![10, 11, 12].includes(b.PerformanceMode) || b.FramesPerDataCallback < 0 || b.BufferCapacityInFrames < 0) return INVALID;
      if (b.FramesPerDataCallback > 1000000 || b.BufferCapacityInFrames > 1000000) return OUT_OF_RANGE;
      const p = mem.malloc(4), stream = new Stream(p, { ...b }); streams.set(p, stream); stp(out, p); return 0;
    },
    AAudioStreamBuilder_setDataCallback: (_cpu, a) => { const b = builders.get(a.p()); if (b) { b.callback = a.p(); b.context = ptr(a.p()); } },
    AAudioStreamBuilder_setErrorCallback: () => {},
    // a channel mask sets the count of its channels, as setChannelCount clears the mask
    AAudioStreamBuilder_setChannelMask: (_cpu, a) => { const b = builders.get(a.p()); if (b) b.ChannelCount = popcount(a.u()); },
    AAudioStream_close: (_cpu, a) => streams.get(a.p())?.close() ?? INVALID_HANDLE,
    AAudioStream_requestStart: (_cpu, a) => streams.get(a.p())?.start() ?? INVALID_HANDLE,
    AAudioStream_requestStop: (_cpu, a) => streams.get(a.p())?.stop() ?? INVALID_HANDLE,
    AAudioStream_requestPause: (_cpu, a) => { const s = streams.get(a.p()); if (!s) return INVALID_HANDLE; s.track.pause(); s.change(AAUDIO_STREAM_STATE_PAUSED); return 0; },
    AAudioStream_requestFlush: (_cpu, a) => { const s = streams.get(a.p()); if (!s) return INVALID_HANDLE; if (s.state === AAUDIO_STREAM_STATE_STARTED) return INVALID_STATE; s.track.flush(); s.change(AAUDIO_STREAM_STATE_FLUSHED); return 0; },
    AAudioStream_waitForStateChange: (_cpu, a) => { const s = streams.get(a.p()), input = a.i(), out = a.p(), timeout = a.l(); return s?.wait(input, anchor(out), timeout) ?? INVALID_HANDLE; },
    AAudioStream_getTimestamp: (_cpu, a) => {
      const s = streams.get(a.p()); a.i(); const position = a.p(), time = a.p();
      if (!s) return INVALID_HANDLE;
      if (!position || !time) return NULL;
      if (s.state !== AAUDIO_STREAM_STATE_STARTED || !s.track.written) return INVALID_STATE;
      mem.st64(position, BigInt(Math.floor(s.track.head()))); mem.st64(time, uptimeNanos());
      return 0;
    },
    AAudioStream_setBufferSizeInFrames: (_cpu, a) => { const s = streams.get(a.p()), size = a.i(); if (!s) return INVALID_HANDLE; if (size < 0) return OUT_OF_RANGE; s.size = Math.max(s.frames, Math.min(size, s.capacity)); s.pump(); return s.size; },
  };
  const settings: Setting[] = ["SampleRate", "ChannelCount", "Format", "Direction", "SharingMode", "BufferCapacityInFrames", "FramesPerDataCallback", "PerformanceMode", "DeviceId", "SessionId", "Usage", "ContentType", "InputPreset"];
  for (const key of settings) methods[`AAudioStreamBuilder_set${key}`] = (_cpu, a) => { const b = builders.get(a.p()); if (b) b[key] = a.i(); };
  const getters: Record<string, (stream: Stream) => number | bigint> = {
    SampleRate: s => s.track.rate, ChannelCount: s => s.track.channels, Format: s => s.track.bytesPerSample === 2 ? 1 : 2,
    Direction: () => 0, SharingMode: () => 1, PerformanceMode: () => 10, DeviceId: () => 1, SessionId: s => s.track.sessionId,
    FramesPerDataCallback: s => s.frames, FramesPerBurst: s => burstFrames(s.track.rate),
    BufferCapacityInFrames: s => s.capacity, BufferSizeInFrames: s => s.size, XRunCount: s => s.track.underruns,
    Usage: s => s.config.Usage || USAGE_MEDIA, ContentType: s => s.config.ContentType || CONTENT_TYPE_MUSIC, InputPreset: s => s.config.InputPreset || INPUT_PRESET_VOICE_RECOGNITION,
    State: s => s.state, FramesWritten: s => BigInt(s.track.written), FramesRead: s => BigInt(Math.floor(s.track.head())),
  };
  for (const [key, get] of Object.entries(getters)) methods[`AAudioStream_get${key}`] = (_cpu, a) => { const s = streams.get(a.p()); return s ? get(s) : INVALID_HANDLE; };
  methods.AAudioStream_isMMapUsed = () => 0;
  hostLib("libaaudio.so", methods, { closed: true });
}
