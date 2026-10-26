// libOpenSLES: the engine, output mixes and buffer-queue audio players over the shared PCM output, as AAudio's streams are.
// An interface is a guest pointer to its vtable pointer, followed here by the id of the object it belongs to. Players of other
// sources (URIs, file descriptors) and recorders are features this device lacks.
import { PcmOutput, minFrames, newAudioSessionId } from "../android/audio-output.ts";
import { Cpu, callbackCpu } from "./cpu.ts";
import { hostLib, hostData, defineHost, stp, ldp, ptr, PTR, type ArgReader, type HostFn } from "./host.ts";
import { mem } from "./mem.ts";
import { struct } from "./struct.ts";
import { toThread } from "../jvm/natives/jthrowable.ts";

const SUCCESS = 0, PRECONDITIONS_VIOLATED = 1, PARAMETER_INVALID = 2, BUFFER_INSUFFICIENT = 7, CONTENT_UNSUPPORTED = 9, FEATURE_UNSUPPORTED = 12;
const UNREALIZED = 1, REALIZED = 2;
const PLAYSTATE_STOPPED = 1, PLAYSTATE_PLAYING = 3;
const LOCATOR_BUFFERQUEUE = 0x6, LOCATOR_ANDROIDSIMPLEBUFFERQUEUE = 0x800007bd, LOCATOR_OUTPUTMIX = 0x4;
const DATAFORMAT_PCM = 2, ANDROID_DATAFORMAT_PCM_EX = 4, PCM_REPRESENTATION_FLOAT = 3;

/** SLDataSource and SLDataSink */
const Data = struct("locator:ptr format:ptr");
const BufferQueueLocator = struct("type:u32 buffers:u32");
/** SLDataFormat_PCM, and SLAndroidDataFormat_PCM_EX's representation after it */
const PcmFormat = struct("type:u32 channels:u32 rate:u32 bits:u32 container:u32 channelMask:u32 endianness:u32 representation:u32");

/** every interface ID this library exports, by the tag its GUID holds */
const IIDS = ["ENGINE", "PLAY", "RECORD", "BUFFERQUEUE", "VOLUME", "ANDROIDSIMPLEBUFFERQUEUE", "ANDROIDCONFIGURATION", "OUTPUTMIX", "OBJECT",
  "PLAYBACKRATE", "ANDROIDAUTOMATICGAINCONTROL", "ANDROIDNOISESUPPRESSION", "ANDROIDACOUSTICECHOCANCELLATION", "ENGINECAPABILITIES", "EFFECTSEND",
  "ENVIRONMENTALREVERB", "EQUALIZER", "SEEK", "PREFETCHSTATUS", "METADATAEXTRACTION", "MUTESOLO"] as const;
type Iid = typeof IIDS[number];
const TAG = 0x51e000;

class SlObject {
  state = UNREALIZED;
  readonly interfaces = new Map<Iid, number>();
  readonly id: number; readonly kinds: readonly Iid[];
  constructor(id: number, kinds: readonly Iid[]) { this.id = id; this.kinds = kinds; }
}
type Samples = Int16Array | Int8Array | Float32Array;
/** A buffer-queue player: AOSP's AudioPlayer copies the app's buffers into an AudioTrack of the minimum size, releasing each
 *  (its callback) once the track has taken it rather than once it has played. */
class Player extends SlObject {
  readonly track: PcmOutput;
  readonly capacity: number;
  /** the app's buffers the track has not taken */
  pending: { samples: Samples; frames: number }[] = [];
  index = 0;
  playState = PLAYSTATE_STOPPED;
  callback = 0; context: number | bigint = 0;
  volume = 0; muted = false;
  thread: Cpu | null = null;
  chain: Promise<unknown> = Promise.resolve();
  destroyed = false;
  constructor(id: number, track: PcmOutput, capacity: number) {
    super(id, ["OBJECT", "PLAY", "BUFFERQUEUE", "ANDROIDSIMPLEBUFFERQUEUE", "VOLUME", "ANDROIDCONFIGURATION", "EFFECTSEND", "PLAYBACKRATE"]);
    this.track = track; this.capacity = capacity;
  }
  /** move what the track has room for into it */
  take(): void {
    const t = this.track;
    while (this.playState === PLAYSTATE_PLAYING && this.pending.length && t.queuedSec() * t.rate < minFrames(t.rate)) {
      const { samples, frames } = this.pending.shift()!;
      t.push(samples, frames, () => this.take());
      this.released();
    }
  }
  /** the app's buffer-queue callback, on the player's callback thread, one at a time */
  released(): void {
    this.index++;
    const cb = this.callback, bq = this.interfaces.get("ANDROIDSIMPLEBUFFERQUEUE") ?? this.interfaces.get("BUFFERQUEUE")!;
    if (!cb) return;
    const cpu = this.thread ??= callbackCpu("OpenSL ES callback");
    this.chain = this.chain.then(() => this.destroyed ? 0 : cpu.call(cb, [bq, this.context], "OpenSL ES buffer queue callback")).catch(toThread(cpu.jthread));
  }
  applyVolume(): void { this.track.setVolume(this.muted ? 0 : Math.min(1, 10 ** (this.volume / 2000))); }
  /** stays valid for a callback already running, as AOSP's; queued callbacks are dropped */
  async destroy(): Promise<void> {
    this.destroyed = true; this.playState = PLAYSTATE_STOPPED;
    this.track.release();
    if (this.thread) { await this.chain; await this.thread.endThread(); this.thread.dispose(); }
  }
}

const objects = new Map<number, SlObject>();
let nextId = 1;
const tables = new Map<Iid, number>();
/** each interface's GUID, which SL_IID_<name> points at */
const iidAddress: number[] = [];
/** the object of the interface a method's first argument is */
const self = (a: ArgReader): SlObject => objects.get(mem.ld32(a.p() + PTR))!;
/** the player of a player's interface: one of PLAY, BUFFERQUEUE and VOLUME */
function player(a: ArgReader): Player {
  const o = self(a);
  if (!(o instanceof Player)) throw new Error(`OpenSL ES: object ${o.id} is not a player`);
  return o;
}
const iidOf = (p: number): Iid | undefined => { const tag = p ? mem.ld32(p) - TAG : -1; return IIDS[tag]; };

/** a new object exposing `kinds`; FEATURE_UNSUPPORTED when an interface the app requires is not among them */
function create<T extends SlObject>(o: T, out: number, count: number, ids: number, required: number): number {
  for (let i = 0; i < count; i++) {
    const kind = iidOf(ldp(ids + PTR * i));
    if ((!kind || !o.kinds.includes(kind)) && required && mem.ld32(required + 4 * i)) return FEATURE_UNSUPPORTED;
  }
  objects.set(o.id, o);
  for (const kind of o.kinds) {
    const itf = mem.hostAlloc(2 * PTR, PTR);
    stp(itf, vtable(kind)); mem.st32(itf + PTR, o.id);
    o.interfaces.set(kind, itf);
  }
  stp(out, o.interfaces.get("OBJECT")!);
  return SUCCESS;
}

const unsupported: HostFn = () => FEATURE_UNSUPPORTED;
const ok: HostFn = () => SUCCESS;
const none: HostFn = () => {};
/** writes `v` through the method's next argument */
const put32 = (v: number): HostFn => (_c, a) => { a.p(); mem.st32(a.p(), v); return SUCCESS; };
/** each interface's methods, in the order OpenSLES.h declares its vtable */
const VTABLES: Partial<Record<Iid, string>> = {
  OBJECT: "Realize Resume GetState GetInterface RegisterCallback AbortAsyncOperation Destroy SetPriority GetPriority SetLossOfControlInterfaces",
  ENGINE: `CreateLEDDevice CreateVibraDevice CreateAudioPlayer CreateAudioRecorder CreateMidiPlayer CreateListener Create3DGroup CreateOutputMix
    CreateMetadataExtractor CreateExtensionObject QueryNumSupportedInterfaces QuerySupportedInterfaces QueryNumSupportedExtensions
    QuerySupportedExtension IsExtensionSupported`,
  PLAY: `SetPlayState GetPlayState GetDuration GetPosition RegisterCallback SetCallbackEventsMask GetCallbackEventsMask SetMarkerPosition
    ClearMarkerPosition GetMarkerPosition SetPositionUpdatePeriod GetPositionUpdatePeriod`,
  BUFFERQUEUE: "Enqueue Clear GetState RegisterCallback",
  ANDROIDSIMPLEBUFFERQUEUE: "Enqueue Clear GetState RegisterCallback",
  VOLUME: "SetVolumeLevel GetVolumeLevel GetMaxVolumeLevel SetMute GetMute EnableStereoPosition IsEnabledStereoPosition SetStereoPosition GetStereoPosition",
  ANDROIDCONFIGURATION: "SetConfiguration GetConfiguration AcquireJavaProxy ReleaseJavaProxy",
  OUTPUTMIX: "GetDestinationOutputDeviceIDs RegisterDeviceChangeCallback ReRoute",
};
const BUFFER_QUEUE: Record<string, HostFn> = {
  Enqueue: (_c, a) => {
    const p = player(a), buf = a.p(), size = a.u(), t = p.track, frames = Math.floor(size / t.frameBytes());
    if (!buf || !size) return PARAMETER_INVALID;
    if (p.pending.length >= p.capacity) return BUFFER_INSUFFICIENT;
    const bytes = mem.bytes(buf, frames * t.frameBytes()).slice();
    const samples = t.bytesPerSample === 2 ? new Int16Array(bytes.buffer) : t.bytesPerSample === 4 ? new Float32Array(bytes.buffer) : new Int8Array(bytes.buffer);
    p.pending.push({ samples, frames });
    p.take();
    return SUCCESS;
  },
  Clear: (_c, a) => { const p = player(a); p.track.flush(); p.pending = []; if (p.playState === PLAYSTATE_PLAYING) p.track.play(); return SUCCESS; },
  GetState: (_c, a) => { const p = player(a), out = a.p(); mem.st32(out, p.pending.length); mem.st32(out + 4, p.index); return SUCCESS; },
  RegisterCallback: (_c, a) => { const p = player(a); p.callback = a.p(); p.context = ptr(a.p()); return SUCCESS; },
};
/** the methods objects here implement, by interface; the rest are FEATURE_UNSUPPORTED */
const METHODS: Partial<Record<Iid, Record<string, HostFn>>> = {
  OBJECT: {
    Realize: (_c, a) => { self(a).state = REALIZED; return SUCCESS; },
    Resume: ok,
    GetState: (_c, a) => { const o = self(a); mem.st32(a.p(), o.state); return SUCCESS; },
    GetInterface: (_c, a) => {
      const o = self(a), kind = iidOf(a.p()), out = a.p();
      if (o.state !== REALIZED) return PRECONDITIONS_VIOLATED;
      const itf = kind && o.interfaces.get(kind);
      if (!itf) return FEATURE_UNSUPPORTED;
      stp(out, itf);
      return SUCCESS;
    },
    RegisterCallback: ok, AbortAsyncOperation: none,
    Destroy: (_c, a) => { const o = self(a); if (!(o instanceof Player)) objects.delete(o.id); else return o.destroy().then(() => { objects.delete(o.id); }); },
    SetPriority: ok, SetLossOfControlInterfaces: ok,
  },
  ENGINE: {
    CreateAudioPlayer: (_c, a) => {
      a.p(); const out = a.p(), src = Data.read(a.p()), sink = Data.read(a.p()), n = a.u(), ids = a.p(), required = a.p();
      const locator = BufferQueueLocator.read(src.locator);
      if (locator.type !== LOCATOR_ANDROIDSIMPLEBUFFERQUEUE && locator.type !== LOCATOR_BUFFERQUEUE) return CONTENT_UNSUPPORTED;
      if (BufferQueueLocator.read(sink.locator).type !== LOCATOR_OUTPUTMIX) return CONTENT_UNSUPPORTED;
      const format = PcmFormat.read(src.format);
      if (format.type !== DATAFORMAT_PCM && format.type !== ANDROID_DATAFORMAT_PCM_EX) return CONTENT_UNSUPPORTED;
      const float = format.type === ANDROID_DATAFORMAT_PCM_EX && format.representation === PCM_REPRESENTATION_FLOAT;
      if (float ? format.bits !== 32 : format.bits !== 8 && format.bits !== 16) return CONTENT_UNSUPPORTED;
      // samplesPerSec is in milliHertz
      const track = new PcmOutput({ rate: Math.round(format.rate / 1000), channels: format.channels, bytesPerSample: format.bits / 8, sessionId: newAudioSessionId() });
      return create(new Player(nextId++, track, locator.buffers), out, n, ids, required);
    },
    CreateOutputMix: (_c, a) => { a.p(); const out = a.p(), n = a.u(), ids = a.p(), required = a.p(); return create(new SlObject(nextId++, ["OBJECT", "OUTPUTMIX", "ENVIRONMENTALREVERB", "EQUALIZER"]), out, n, ids, required); },
    QueryNumSupportedInterfaces: (_c, a) => { a.p(); a.u(); mem.st32(a.p(), 0); return SUCCESS; },
    QuerySupportedInterfaces: () => PARAMETER_INVALID,
    QueryNumSupportedExtensions: put32(0),
    QuerySupportedExtension: () => PARAMETER_INVALID,
    IsExtensionSupported: (_c, a) => { a.p(); a.p(); mem.st32(a.p(), 0); return SUCCESS; },
  },
  PLAY: {
    SetPlayState: (_c, a) => {
      const p = player(a), state = a.u();
      if (state < PLAYSTATE_STOPPED || state > PLAYSTATE_PLAYING) return PARAMETER_INVALID;
      p.playState = state;
      if (state === PLAYSTATE_PLAYING) { p.track.play(); p.take(); } else p.track.pause();
      return SUCCESS;
    },
    GetPlayState: (_c, a) => { const p = player(a); mem.st32(a.p(), p.playState); return SUCCESS; },
    GetDuration: put32(-1),                                                                 // SL_TIME_UNKNOWN
    GetPosition: (_c, a) => { const p = player(a); mem.st32(a.p(), Math.floor(p.track.head() * 1000 / p.track.rate)); return SUCCESS; },
    RegisterCallback: ok, SetCallbackEventsMask: ok, GetCallbackEventsMask: put32(0),
    SetMarkerPosition: ok, ClearMarkerPosition: ok, SetPositionUpdatePeriod: ok,
  },
  BUFFERQUEUE: BUFFER_QUEUE,
  ANDROIDSIMPLEBUFFERQUEUE: BUFFER_QUEUE,
  VOLUME: {
    SetVolumeLevel: (_c, a) => { const p = player(a); p.volume = Math.min(0, a.i() << 16 >> 16); p.applyVolume(); return SUCCESS; },
    GetVolumeLevel: (_c, a) => { const p = player(a); mem.st16(a.p(), p.volume); return SUCCESS; },
    GetMaxVolumeLevel: (_c, a) => { a.p(); mem.st16(a.p(), 0); return SUCCESS; },
    SetMute: (_c, a) => { const p = player(a); p.muted = a.u() !== 0; p.applyVolume(); return SUCCESS; },
    GetMute: (_c, a) => { const p = player(a); mem.st32(a.p(), p.muted ? 1 : 0); return SUCCESS; },
    EnableStereoPosition: ok, IsEnabledStereoPosition: put32(0), SetStereoPosition: ok, GetStereoPosition: (_c, a) => { a.p(); mem.st16(a.p(), 0); return SUCCESS; },
  },
  ANDROIDCONFIGURATION: { SetConfiguration: ok },
  OUTPUTMIX: { RegisterDeviceChangeCallback: ok },
};
/** the longest vtable an interface has: those no object here implements are this many FEATURE_UNSUPPORTED methods */
const MAX_METHODS = 32;
function vtable(kind: Iid): number {
  let t = tables.get(kind);
  if (t !== undefined) return t;
  const names = VTABLES[kind]?.trim().split(/\s+/) ?? Array<string>(MAX_METHODS).fill("");
  t = mem.hostAlloc(PTR * names.length, PTR);
  names.forEach((name, i) => stp(t! + PTR * i, defineHost(`OpenSLES:${kind}.${name || i}`, METHODS[kind]?.[name] ?? unsupported)));
  tables.set(kind, t);
  return t;
}

export function openslesInit(): void {
  hostLib("libOpenSLES.so", {
    slCreateEngine: (_c, a) => {
      const out = a.p(); a.u(); a.p(); const n = a.u(), ids = a.p(), required = a.p();
      if (!out) return PARAMETER_INVALID;
      return create(new SlObject(nextId++, ["OBJECT", "ENGINE", "ENGINECAPABILITIES"]), out, n, ids, required);
    },
    slQueryNumSupportedEngineInterfaces: (_c, a) => { const p = a.p(); if (!p) return PARAMETER_INVALID; mem.st32(p, 2); return SUCCESS; },
    slQuerySupportedEngineInterfaces: (_c, a) => {
      const i = a.u(), out = a.p();
      if (!out || i > 1) return PARAMETER_INVALID;
      stp(out, iidAddress[i === 0 ? IIDS.indexOf("ENGINE") : IIDS.indexOf("ENGINECAPABILITIES")]);
      return SUCCESS;
    },
  }, { closed: true });
  IIDS.forEach((name, i) => {
    // SL_IID_X holds an SLInterfaceID: a pointer to a 16-byte GUID, here tagged with the interface's index
    const guid = mem.hostAlloc(16, 4), id = mem.hostAlloc(PTR, PTR);
    mem.st32(guid, TAG + i);
    stp(id, guid);
    iidAddress[i] = guid;
    hostData("libOpenSLES.so", "SL_IID_" + name, id);
  });
}
