// libOpenSLES: the engine, output mixes and buffer-queue audio players over the shared PCM output, as AAudio's streams are.
// An interface is a guest pointer to its vtable pointer, followed here by the id of the object it belongs to. Players of other
// sources (URIs, file descriptors) and recorders are features this device lacks.
import { PcmOutput, minFrames, newAudioSessionId } from "../android/audio-output.ts";
import { JThread } from "../jvm/natives/jentry.ts";
import { Cpu, bindCpu } from "./cpu.ts";
import { hostLib, hostData, defineHost, stp, ldp, ptr, type HostFn } from "./host.ts";
import { mem } from "./mem.ts";
import { toThread } from "../jvm/natives/jthrowable.ts";

const SUCCESS = 0, PRECONDITIONS_VIOLATED = 1, PARAMETER_INVALID = 2, BUFFER_INSUFFICIENT = 7, CONTENT_UNSUPPORTED = 9, FEATURE_UNSUPPORTED = 12;
const UNREALIZED = 1, REALIZED = 2;
const PLAYSTATE_STOPPED = 1, PLAYSTATE_PLAYING = 3;
const LOCATOR_BUFFERQUEUE = 0x6, LOCATOR_ANDROIDSIMPLEBUFFERQUEUE = 0x800007bd, LOCATOR_OUTPUTMIX = 0x4;
const DATAFORMAT_PCM = 2, ANDROID_DATAFORMAT_PCM_EX = 4, PCM_REPRESENTATION_FLOAT = 3;

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
    const cpu = this.thread ??= (() => {
      const t = new JThread(); t.jname = "OpenSL ES callback";
      const c = new Cpu(t, t.jname); c.lastFrameAt = Infinity; bindCpu(t, c);
      return c;
    })();
    this.chain = this.chain.then(() => cpu.call(cb, [bq, this.context], "OpenSL ES buffer queue callback")).catch(toThread(cpu.jthread));
  }
  applyVolume(): void { this.track.setVolume(this.muted ? 0 : Math.min(1, 10 ** (this.volume / 2000))); }
  async destroy(): Promise<void> {
    this.track.release();
    if (this.thread) { await this.chain; await this.thread.endThread(); this.thread.dispose(); }
  }
}

const objects = new Map<number, SlObject>();
let nextId = 1;
const tables = new Map<Iid, number>();
/** each interface's GUID, which SL_IID_<name> points at */
const iidAddress: number[] = [];
const self = (a: { p(): number }): SlObject => objects.get(mem.ld32(a.p() + 8))!;
const iidOf = (p: number): Iid | undefined => { const tag = p ? mem.ld32(p) - TAG : -1; return IIDS[tag]; };

/** a new object exposing `kinds`; FEATURE_UNSUPPORTED when an interface the app requires is not among them */
function create<T extends SlObject>(o: T, out: number, count: number, ids: number, required: number): number {
  for (let i = 0; i < count; i++) {
    const kind = iidOf(ldp(ids + 8 * i));
    if ((!kind || !o.kinds.includes(kind)) && required && mem.ld32(required + 4 * i)) return FEATURE_UNSUPPORTED;
  }
  objects.set(o.id, o);
  for (const kind of o.kinds) {
    const itf = mem.hostAlloc(16, 8);
    stp(itf, vtable(kind)); mem.st32(itf + 8, o.id);
    o.interfaces.set(kind, itf);
  }
  stp(out, o.interfaces.get("OBJECT")!);
  return SUCCESS;
}

const unsupported: HostFn = () => FEATURE_UNSUPPORTED;
const ok: HostFn = () => SUCCESS;
const METHODS: Record<Iid, HostFn[]> = {
  OBJECT: [
    (_c, a) => { self(a).state = REALIZED; return SUCCESS; },                                   // Realize
    ok,                                                                                     // Resume
    (_c, a) => { const o = self(a); mem.st32(a.p(), o.state); return SUCCESS; },             // GetState
    (_c, a) => {                                                                            // GetInterface
      const o = self(a), kind = iidOf(a.p()), out = a.p();
      if (o.state !== REALIZED) return PRECONDITIONS_VIOLATED;
      const itf = kind && o.interfaces.get(kind);
      if (!itf) return FEATURE_UNSUPPORTED;
      stp(out, itf);
      return SUCCESS;
    },
    ok, () => {},                                                                           // RegisterCallback, AbortAsyncOperation
    (_c, a) => { const o = self(a); objects.delete(o.id); if (o instanceof Player) return o.destroy().then(() => undefined); },  // Destroy
    ok, unsupported, ok,                                                                    // Set/GetPriority, SetLossOfControlInterfaces
  ],
  ENGINE: [
    unsupported, unsupported,                                                               // CreateLEDDevice, CreateVibraDevice
    (_c, a) => {                                                                            // CreateAudioPlayer
      a.p(); const out = a.p(), src = a.p(), sink = a.p(), n = a.u(), ids = a.p(), required = a.p();
      const locator = ldp(src), format = ldp(src + 8), sinkLocator = ldp(sink);
      const type = mem.ld32(locator) >>> 0;
      if (type !== LOCATOR_ANDROIDSIMPLEBUFFERQUEUE && type !== LOCATOR_BUFFERQUEUE) return CONTENT_UNSUPPORTED;
      if ((mem.ld32(sinkLocator) >>> 0) !== LOCATOR_OUTPUTMIX) return CONTENT_UNSUPPORTED;
      const formatType = mem.ld32(format), bits = mem.ld32(format + 12);
      if (formatType !== DATAFORMAT_PCM && formatType !== ANDROID_DATAFORMAT_PCM_EX) return CONTENT_UNSUPPORTED;
      const float = formatType === ANDROID_DATAFORMAT_PCM_EX && mem.ld32(format + 28) === PCM_REPRESENTATION_FLOAT;
      if (float ? bits !== 32 : bits !== 8 && bits !== 16) return CONTENT_UNSUPPORTED;
      const track = new PcmOutput({ rate: Math.round((mem.ld32(format + 8) >>> 0) / 1000), channels: mem.ld32(format + 4), bytesPerSample: bits / 8, sessionId: newAudioSessionId() });
      return create(new Player(nextId++, track, mem.ld32(locator + 4)), out, n, ids, required);
    },
    unsupported, unsupported, unsupported, unsupported,                                     // recorder, MIDI player, listener, 3D group
    (_c, a) => { a.p(); const out = a.p(), n = a.u(), ids = a.p(), required = a.p(); return create(new SlObject(nextId++, ["OBJECT", "OUTPUTMIX", "ENVIRONMENTALREVERB", "EQUALIZER"]), out, n, ids, required); },
    unsupported, unsupported,                                                               // metadata extractor, extension object
    (_c, a) => { a.p(); a.u(); mem.st32(a.p(), 0); return SUCCESS; },                         // QueryNumSupportedInterfaces
    () => PARAMETER_INVALID,
    (_c, a) => { a.p(); mem.st32(a.p(), 0); return SUCCESS; },                                // QueryNumSupportedExtensions
    () => PARAMETER_INVALID,
    (_c, a) => { a.p(); a.p(); mem.st32(a.p(), 0); return SUCCESS; },                         // IsExtensionSupported
  ],
  PLAY: [
    (_c, a) => {                                                                            // SetPlayState
      const p = self(a) as Player, state = a.u();
      if (state < PLAYSTATE_STOPPED || state > PLAYSTATE_PLAYING) return PARAMETER_INVALID;
      p.playState = state;
      if (state === PLAYSTATE_PLAYING) { p.track.play(); p.take(); } else p.track.pause();
      return SUCCESS;
    },
    (_c, a) => { const p = self(a) as Player; mem.st32(a.p(), p.playState); return SUCCESS; },
    (_c, a) => { a.p(); mem.st32(a.p(), -1); return SUCCESS; },                               // GetDuration: SL_TIME_UNKNOWN
    (_c, a) => { const p = self(a) as Player; mem.st32(a.p(), Math.floor(p.track.head() * 1000 / p.track.rate)); return SUCCESS; },
    ok, ok, (_c, a) => { a.p(); mem.st32(a.p(), 0); return SUCCESS; },                         // callback and its event mask
    ok, ok, unsupported, ok, unsupported,                                                   // markers and position updates
  ],
  ANDROIDSIMPLEBUFFERQUEUE: [],
  BUFFERQUEUE: [
    (_c, a) => {                                                                            // Enqueue
      const p = self(a) as Player, buf = a.p(), size = a.u(), t = p.track, frames = Math.floor(size / t.frameBytes());
      if (!buf || !size) return PARAMETER_INVALID;
      if (p.pending.length >= p.capacity) return BUFFER_INSUFFICIENT;
      const bytes = mem.bytes(buf, frames * t.frameBytes()).slice();
      const samples = t.bytesPerSample === 2 ? new Int16Array(bytes.buffer) : t.bytesPerSample === 4 ? new Float32Array(bytes.buffer) : new Int8Array(bytes.buffer);
      p.pending.push({ samples, frames });
      p.take();
      return SUCCESS;
    },
    (_c, a) => { const p = self(a) as Player; p.track.flush(); p.pending = []; if (p.playState === PLAYSTATE_PLAYING) p.track.play(); return SUCCESS; },  // Clear
    (_c, a) => { const p = self(a) as Player, out = a.p(); mem.st32(out, p.pending.length); mem.st32(out + 4, p.index); return SUCCESS; },  // GetState
    (_c, a) => { const p = self(a) as Player; p.callback = a.p(); p.context = ptr(a.p()); return SUCCESS; },               // RegisterCallback
  ],
  VOLUME: [
    (_c, a) => { const p = self(a) as Player; p.volume = Math.min(0, a.i() << 16 >> 16); p.applyVolume(); return SUCCESS; },
    (_c, a) => { const p = self(a) as Player; mem.st16(a.p(), p.volume); return SUCCESS; },
    (_c, a) => { a.p(); mem.st16(a.p(), 0); return SUCCESS; },
    (_c, a) => { const p = self(a) as Player; p.muted = a.u() !== 0; p.applyVolume(); return SUCCESS; },
    (_c, a) => { const p = self(a) as Player; mem.st32(a.p(), p.muted ? 1 : 0); return SUCCESS; },
    ok, (_c, a) => { a.p(); mem.st32(a.p(), 0); return SUCCESS; }, ok, (_c, a) => { a.p(); mem.st16(a.p(), 0); return SUCCESS; },
  ],
  ANDROIDCONFIGURATION: [ok, unsupported, unsupported, unsupported],
  OUTPUTMIX: [unsupported, ok, unsupported],
  RECORD: [], PLAYBACKRATE: [], ANDROIDAUTOMATICGAINCONTROL: [], ANDROIDNOISESUPPRESSION: [], ANDROIDACOUSTICECHOCANCELLATION: [],
  ENGINECAPABILITIES: [], EFFECTSEND: [], ENVIRONMENTALREVERB: [], EQUALIZER: [], SEEK: [], PREFETCHSTATUS: [], METADATAEXTRACTION: [], MUTESOLO: [],
};
METHODS.ANDROIDSIMPLEBUFFERQUEUE = METHODS.BUFFERQUEUE;
/** the interface's vtable: its methods, then (for interfaces no object here implements in full) FEATURE_UNSUPPORTED */
function vtable(kind: Iid): number {
  let t = tables.get(kind);
  if (t !== undefined) return t;
  const methods = METHODS[kind], n = Math.max(methods.length, 32);
  t = mem.hostAlloc(8 * n, 8);
  for (let i = 0; i < n; i++) stp(t + 8 * i, defineHost(`OpenSLES:${kind}.${i}`, methods[i] ?? unsupported));
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
    const guid = mem.hostAlloc(16, 4), id = mem.hostAlloc(8, 8);
    mem.st32(guid, TAG + i);
    stp(id, guid);
    iidAddress[i] = guid;
    hostData("libOpenSLES.so", "SL_IID_" + name, id);
  });
}
