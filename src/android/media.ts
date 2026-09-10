// android.media: MediaPlayer over HTMLAudioElement, SoundPool over Web Audio.

import { rt, JObj, maySuspend } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { vcall } from "../jvm/natives/jlang";
import { vfs } from "../jvm/natives/jio";
import type { JBuffer } from "../jvm/natives/jnio";
rt.register({ name: "android/media/AudioManager$OnAudioFocusChangeListener", ctor: class extends JObj {} });
/** the rate the Web Audio output actually runs at */
export const outputSampleRate = (): number => actx?.sampleRate ?? 44100;
import { onMain } from "./mainloop";
import { reportUncaught } from "./os";
import { mkUri } from "./net";

rt.register({ name: "android/media/RingtoneManager", ctor: class extends JObj {},
  statics: { TYPE_RINGTONE: 1, TYPE_NOTIFICATION: 2, TYPE_ALARM: 4, TYPE_ALL: 7 },
  methods: {
    "static getDefaultUri(I)Landroid/net/Uri;": (type: number) => {
      const setting = type & 1 ? "ringtone" : type & 2 ? "notification_sound" : type & 4 ? "alarm_alert" : null;
      if (!setting) return null;
      rt.link("android/net/Uri");
      return mkUri("content://settings/system/" + setting);
    },
  },
});

rt.register({ name: "android/media/Image", ctor: class extends JObj {}, ifaces: ["java/lang/AutoCloseable"] });

class JAudioAttributes extends JObj { usage = 0; contentType = 0; flags = 0x800; }
rt.register({
  name: "android/media/AudioAttributes", ctor: JAudioAttributes, ifaces: ["android/os/Parcelable"],
  methods: {
    "getUsage()I": function (this: JAudioAttributes) { return this.usage; },
    "getContentType()I": function (this: JAudioAttributes) { return this.contentType; },
    "getFlags()I": function (this: JAudioAttributes) { return this.flags & 0x111; },
    "getAllFlags()I": function (this: JAudioAttributes) { return this.flags & 0x1f7ff; },
    "getAllowedCapturePolicy()I": function (this: JAudioAttributes) { return this.flags & 0x1000 ? 3 : this.flags & 0x400 ? 2 : 1; },
    "areHapticChannelsMuted()Z": function (this: JAudioAttributes) { return this.flags & 0x800 ? 1 : 0; },
    "isContentSpatialized()Z": function (this: JAudioAttributes) { return this.flags & 0x4000 ? 1 : 0; },
    "getSpatializationBehavior()I": function (this: JAudioAttributes) { return this.flags & 0x8000 ? 1 : 0; },
    "equals(Ljava/lang/Object;)Z": function (this: JAudioAttributes, other: unknown) {
      return other instanceof JAudioAttributes && this.usage === other.usage && this.contentType === other.contentType && this.flags === other.flags ? 1 : 0;
    },
    "hashCode()I": function (this: JAudioAttributes) { return ((this.contentType * 31 + this.usage) * 31 + this.flags) | 0; },
  },
});
class JAudioAttributesBuilder extends JObj { attrs = new JAudioAttributes(); }
rt.register({
  name: "android/media/AudioAttributes$Builder", ctor: JAudioAttributesBuilder,
  methods: {
    "<init>()V": function () {},
    "setFlags(I)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, flags: number) { this.attrs.flags |= flags & 0x1d1; return this; },
    "setAllowedCapturePolicy(I)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, policy: number) {
      if (policy < 1 || policy > 3) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid capture policy " + policy);
      this.attrs.flags = (this.attrs.flags & ~0x1400) | (policy === 3 ? 0x1400 : policy === 2 ? 0x400 : 0); return this;
    },
    "setHapticChannelsMuted(Z)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, muted: number) { this.attrs.flags = (this.attrs.flags & ~0x800) | (muted ? 0x800 : 0); return this; },
    "setIsContentSpatialized(Z)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, spatialized: number) { this.attrs.flags = (this.attrs.flags & ~0x4000) | (spatialized ? 0x4000 : 0); return this; },
    "setSpatializationBehavior(I)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, behavior: number) {
      if (behavior !== 0 && behavior !== 1) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid spatialization behavior " + behavior);
      this.attrs.flags = (this.attrs.flags & ~0x8000) | (behavior ? 0x8000 : 0); return this;
    },
    "setUsage(I)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, usage: number) {
      if (usage < 0 || usage > 16) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid usage " + usage);
      this.attrs.usage = usage; return this;
    },
    "setContentType(I)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, type: number) {
      if (type < 0 || type > 4) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid content type " + type);
      this.attrs.contentType = type; return this;
    },
    "build()Landroid/media/AudioAttributes;": function (this: JAudioAttributesBuilder) {
      const attrs = Object.assign(new JAudioAttributes(), this.attrs);
      if (attrs.usage >= 7 && attrs.usage <= 9) attrs.usage = 5;
      return attrs;
    },
  },
});

const players = new Set<JMediaPlayer>();
const pools = new Set<JSoundPool>();
/** AudioManager.isMusicActive: a MediaPlayer or a SoundPool stream is sounding right now. */
export function isMusicActive(): number {
  for (const p of players) if (p.audio && !p.audio.paused) return 1;
  for (const p of pools) for (const s of p.streams.values()) if (s.src.playbackRate.value) return 1;
  return 0;
}

class JMediaPlayer extends JObj {
  audio: HTMLAudioElement | null = null;
  looping = false;
  prepared = false;
  completionL: unknown = null;
  srcBytes: Uint8Array | null = null;
}
function mpLoad(mp: JMediaPlayer, bytes: Uint8Array) {
  const blob = new Blob([bytes as BlobPart]);
  mp.audio = new Audio(URL.createObjectURL(blob));
  mp.audio.onended = () => {
    if (mp.completionL) void vcall(mp.completionL, "onCompletion", "(Landroid/media/MediaPlayer;)V", mp).catch(reportUncaught);
  };
}
rt.register({
  name: "android/media/MediaPlayer", ctor: JMediaPlayer,
  methods: {
    "<init>()V": function () {},
    "static create(Landroid/content/Context;I)Landroid/media/MediaPlayer;": (c: any, resId: number) => {
      const mp = new JMediaPlayer();
      const host = c?.$host;
      if (host) {
        const f = host.res.fileOf(resId);
        if (f) mpLoad(mp, f.bytes);
      }
      return mp;
    },
    "setDataSource(Landroid/content/Context;Landroid/net/Uri;)V": () => {},
    "prepare()V": function (this: JMediaPlayer) { this.prepared = true; },
    "prepareAsync()V": function (this: JMediaPlayer) { this.prepared = true; },
    "start()V": function (this: JMediaPlayer) { players.add(this); void this.audio?.play().catch(() => { /* */ }); },
    "pause()V": function (this: JMediaPlayer) { this.audio?.pause(); },
    "stop()V": function (this: JMediaPlayer) {
      if (this.audio) {
        this.audio.pause();
        this.audio.currentTime = 0;
      }
    },
    "release()V": function (this: JMediaPlayer) { players.delete(this); this.audio = null; },
    "reset()V": function () {},
    "isPlaying()Z": function (this: JMediaPlayer) { return this.audio && !this.audio.paused ? 1 : 0; },
    "setLooping(Z)V": function (this: JMediaPlayer, l: number) {
      this.looping = !!l;
      if (this.audio) this.audio.loop = !!l;
    },
    "setVolume(FF)V": function (this: JMediaPlayer, v: number) { if (this.audio) this.audio.volume = Math.min(1, v); },
    "setAudioStreamType(I)V": () => {},
    "setOnCompletionListener(Landroid/media/MediaPlayer$OnCompletionListener;)V": function (this: JMediaPlayer, l: unknown) {
      this.completionL = l;
    },
    "setOnPreparedListener(Landroid/media/MediaPlayer$OnPreparedListener;)V": maySuspend(function (this: JMediaPlayer, l: unknown) {
      setTimeout(() => void vcall(l, "onPrepared", "(Landroid/media/MediaPlayer;)V", this).catch(reportUncaught), 10);
    }),
    "setOnErrorListener(Landroid/media/MediaPlayer$OnErrorListener;)V": () => {},
    "setWakeMode(Landroid/content/Context;I)V": () => {},
    "getDuration()I": function (this: JMediaPlayer) { return Math.round((this.audio?.duration ?? 0) * 1000); },
    "getCurrentPosition()I": function (this: JMediaPlayer) { return Math.round((this.audio?.currentTime ?? 0) * 1000); },
    "seekTo(I)V": function (this: JMediaPlayer, ms: number) { if (this.audio) this.audio.currentTime = ms / 1000; },
  },
});
for (const n of ["android/media/MediaPlayer$OnCompletionListener", "android/media/MediaPlayer$OnPreparedListener",
  "android/media/MediaPlayer$OnErrorListener", "android/media/MediaPlayer$OnSeekCompleteListener",
  "android/media/SoundPool$OnLoadCompleteListener"]) {
  rt.register({ name: n, ctor: class extends JObj {} });
}

// ── SoundPool: one shared AudioContext (never closed), a decoded AudioBuffer per sound id
// (null while decoding), and a one-shot source + gain node per stream id.
let actx: AudioContext | null = null;
type Stream = { src: AudioBufferSourceNode; gain: GainNode; prio: number; rate: number };
class JSoundPool extends JObj {
  maxStreams = 1;
  audioAttributes = new JAudioAttributes();
  sounds = new Map<number, AudioBuffer | null>();
  streams = new Map<number, Stream>();
  nextId = 1;
  nextStream = 1;
  loadL: unknown = null;
  load(bytes: Uint8Array | null): number {
    if (!bytes) return 0;
    const id = this.nextId++;
    this.sounds.set(id, null);
    // decodeAudioData detaches the buffer it is given, so the apk's bytes are copied first.
    (actx ??= new AudioContext()).decodeAudioData(bytes.slice().buffer as ArrayBuffer)
      .then((buf) => this.decoded(id, buf, 0), () => this.decoded(id, null, 1));
    return id;
  }
  decoded(id: number, buf: AudioBuffer | null, status: number) {
    if (!this.sounds.has(id)) return; // unloaded or released before the decode finished
    if (buf) this.sounds.set(id, buf);
    if (this.loadL) void onMain(() => vcall(this.loadL, "onLoadComplete", "(Landroid/media/SoundPool;II)V", this, id, status)).catch(reportUncaught);
  }
  stop(sid: number) {
    const s = this.streams.get(sid);
    if (s) { s.src.stop(); this.streams.delete(sid); }
  }
}
rt.register({
  name: "android/media/SoundPool", ctor: JSoundPool,
  methods: {
    "<init>(III)V": function (this: JSoundPool, max: number) { this.maxStreams = max; pools.add(this); },
    "load(Landroid/content/res/AssetFileDescriptor;I)I": function (this: JSoundPool, afd: any) { return this.load(afd?.bytes ?? null); },
    "load(Landroid/content/Context;II)I": function (this: JSoundPool, c: any, resId: number) {
      const host = c?.$host;
      return this.load(host?.res.fileOf(resId)?.bytes ?? null);
    },
    "load(Ljava/lang/String;I)I": function (this: JSoundPool, path: string) { return this.load(vfs.read(path)); },
    "play(IFFIIF)I": function (this: JSoundPool, id: number, l: number, r: number, prio: number, loop: number, rate: number) {
      const buf = this.sounds.get(id);
      if (!buf || !actx) return 0;
      // Reached from a pointer-driven main-looper job, i.e. inside the user-activation window.
      if (actx.state === "suspended") void actx.resume();
      if (this.streams.size >= this.maxStreams) {
        // AOSP: the lowest-priority stream at or below the newcomer's yields, else the newcomer is refused.
        let v: [number, Stream] | undefined;
        for (const e of this.streams) if (e[1].prio <= prio && (!v || e[1].prio < v[1].prio)) v = e;
        if (!v) return 0;
        this.stop(v[0]);
      }
      const src = actx.createBufferSource();
      src.buffer = buf; src.loop = loop !== 0; src.playbackRate.value = rate;
      const gain = actx.createGain();
      gain.gain.value = Math.max(l, r);
      src.connect(gain).connect(actx.destination);
      const sid = this.nextStream++;
      src.onended = () => this.streams.delete(sid);
      src.start();
      // loop = n > 0 means n + 1 plays: keep looping and schedule the end (at the starting rate).
      if (loop > 0) src.stop(actx.currentTime + (buf.duration * (loop + 1)) / rate);
      this.streams.set(sid, { src, gain, prio, rate });
      return sid;
    },
    "stop(I)V": function (this: JSoundPool, sid: number) { this.stop(sid); },
    // Web Audio sources cannot pause; a zero playback rate holds the position instead.
    "pause(I)V": function (this: JSoundPool, sid: number) { const s = this.streams.get(sid); if (s) s.src.playbackRate.value = 0; },
    "resume(I)V": function (this: JSoundPool, sid: number) { const s = this.streams.get(sid); if (s) s.src.playbackRate.value = s.rate; },
    "autoPause()V": function (this: JSoundPool) { for (const s of this.streams.values()) s.src.playbackRate.value = 0; },
    "autoResume()V": function (this: JSoundPool) { for (const s of this.streams.values()) s.src.playbackRate.value = s.rate; },
    "setVolume(IFF)V": function (this: JSoundPool, sid: number, l: number, r: number) {
      const s = this.streams.get(sid); if (s) s.gain.gain.value = Math.max(l, r);
    },
    "setLoop(II)V": function (this: JSoundPool, sid: number, loop: number) { const s = this.streams.get(sid); if (s) s.src.loop = loop !== 0; },
    "setRate(IF)V": function (this: JSoundPool, sid: number, rate: number) {
      const s = this.streams.get(sid);
      if (s) { if (s.src.playbackRate.value) s.src.playbackRate.value = rate; s.rate = rate; }
    },
    "setPriority(II)V": function (this: JSoundPool, sid: number, prio: number) { const s = this.streams.get(sid); if (s) s.prio = prio; },
    "unload(I)Z": function (this: JSoundPool, id: number) { return this.sounds.delete(id) ? 1 : 0; },
    "release()V": function (this: JSoundPool) {
      for (const s of this.streams.values()) s.src.stop();
      this.streams.clear(); this.sounds.clear(); pools.delete(this);
    },
    "setOnLoadCompleteListener(Landroid/media/SoundPool$OnLoadCompleteListener;)V": function (this: JSoundPool, l: unknown) { this.loadL = l; },
  },
});
class JSoundPoolBuilder extends JObj { max = 1; attrs: JAudioAttributes | null = null; }
rt.register({
  name: "android/media/SoundPool$Builder", ctor: JSoundPoolBuilder,
  methods: {
    "<init>()V": function () {},
    "setMaxStreams(I)Landroid/media/SoundPool$Builder;": function (this: JSoundPoolBuilder, n: number) { this.max = n; return this; },
    "setAudioAttributes(Landroid/media/AudioAttributes;)Landroid/media/SoundPool$Builder;": function (this: JSoundPoolBuilder, attrs: JAudioAttributes | null) {
      if (!attrs) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid null AudioAttributes");
      this.attrs = attrs; return this;
    },
    "build()Landroid/media/SoundPool;": function (this: JSoundPoolBuilder) {
      const p = new JSoundPool(); p.maxStreams = this.max;
      if (this.attrs) p.audioAttributes = this.attrs; else p.audioAttributes.usage = 1;
      pools.add(p); return p;
    },
  },
});

// ── AudioTrack (MODE_STREAM): PCM written from Java is scheduled back-to-back on the shared
// AudioContext; the periodic position listener is what streaming mixers (a native engine's
// SoundPlayer) refill from, so it fires whenever the queue runs below a few periods.
const D_periodic = "(Landroid/media/AudioTrack;)V";
class JAudioTrack extends JObj {
  rate = 44100; channels = 2; bytesPerSample = 2; bufBytes = 0;
  sessionId = 0; attributes: unknown = null;
  state = 1; playState = 1;          // STATE_INITIALIZED; PLAYSTATE_STOPPED
  nextTime = 0; written = 0; underruns = 0;
  period = 0; listener: unknown = null; timer: ReturnType<typeof setInterval> | null = null;
  gain: GainNode | null = null;
  vol = 1;
  ctx(): AudioContext { return (actx ??= new AudioContext()); }
  frameBytes(): number { return this.channels * this.bytesPerSample; }
  queuedSec(): number { return Math.max(0, this.nextTime - this.ctx().currentTime); }
  /** a streaming write blocks while the track's buffer is full, which is what paces a writer
   *  loop; the wait is the excess over one buffer's worth of queued audio */
  wrote(n: number): number | Promise<number> {
    const bufSec = this.bufBytes / (this.rate * this.frameBytes()), excess = this.queuedSec() - bufSec;
    return excess > 0.005 ? new Promise((r) => setTimeout(() => r(n), excess * 1000)) : n;
  }
  /** interleaved 16-bit (or 8-bit unsigned) PCM → one scheduled buffer */
  push(samples: Int16Array | Int8Array | Float32Array, frames: number): void {
    if (frames <= 0) return;
    const ctx = this.ctx();
    const buf = ctx.createBuffer(this.channels, frames, this.rate);
    for (let c = 0; c < this.channels; c++) {
      const ch = buf.getChannelData(c);
      if (samples instanceof Float32Array) for (let i = 0; i < frames; i++) ch[i] = samples[i * this.channels + c];
      else if (samples instanceof Int16Array) for (let i = 0; i < frames; i++) ch[i] = samples[i * this.channels + c] / 32768;
      else for (let i = 0; i < frames; i++) ch[i] = ((samples[i * this.channels + c] & 0xff) - 128) / 128;
    }
    if (!this.gain) { this.gain = ctx.createGain(); this.gain.gain.value = this.vol; this.gain.connect(ctx.destination); }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    if (this.playState === 3 && this.written && this.nextTime < ctx.currentTime) this.underruns++;
    const at = Math.max(this.nextTime, ctx.currentTime + 0.02);
    src.start(at);
    this.nextTime = at + frames / this.rate;
    this.written += frames;
  }
  writeBuffer(buffer: JBuffer, n: number, mode: number): number | Promise<number> {
    if (this.state !== 1) return -3;
    if (!buffer || n < 0 || n > buffer.lim - buffer.pos || (mode !== 0 && mode !== 1)) return -2;
    const available = mode === 1 ? Math.max(0, this.bufBytes - Math.ceil(this.queuedSec() * this.rate) * this.frameBytes()) : n;
    n = Math.floor(Math.min(n, available) / this.frameBytes()) * this.frameBytes();
    if (!n) return 0;
    const data = new DataView(buffer.ab, buffer.dv.byteOffset + buffer.pos, n);
    const count = n / this.bytesPerSample;
    // AudioTrack consumes native-order PCM, independently of ByteBuffer.order().
    const SampleArray = this.bytesPerSample === 4 ? Float32Array : this.bytesPerSample === 2 ? Int16Array : Int8Array;
    const aligned = data.byteOffset % this.bytesPerSample === 0;
    const samples = aligned ? new SampleArray(data.buffer, data.byteOffset, count) : new SampleArray(count);
    if (!aligned) for (let i = 0; i < count; i++) samples[i] = this.bytesPerSample === 4 ? data.getFloat32(i * 4, true) : data.getInt16(i * 2, true);
    this.push(samples, n / this.frameBytes());
    buffer.pos += n;
    return mode === 1 ? n : this.wrote(n);
  }
  startTimer(): void {
    if (this.timer || !this.listener || !this.period) return;
    const periodMs = Math.max(5, this.period / this.rate * 1000);
    this.timer = setInterval(() => {
      if (this.playState !== 3 || !this.listener) return;
      // refill until ~3 periods are queued; each callback is one write of one period
      if (this.queuedSec() < 3 * this.period / this.rate) void onMain(() => vcall(this.listener, "onPeriodicNotification", D_periodic, this)).catch(reportUncaught);
    }, periodMs / 2);
  }
  stopTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
rt.register({
  name: "android/media/AudioTrack", ctor: JAudioTrack,
  statics: { MODE_STATIC: 0, MODE_STREAM: 1, PLAYSTATE_STOPPED: 1, PLAYSTATE_PAUSED: 2, PLAYSTATE_PLAYING: 3, STATE_UNINITIALIZED: 0, STATE_INITIALIZED: 1, STATE_NO_STATIC_DATA: 2,
    SUCCESS: 0, ERROR: -1, ERROR_BAD_VALUE: -2, ERROR_INVALID_OPERATION: -3, WRITE_BLOCKING: 0, WRITE_NON_BLOCKING: 1 },
  methods: {
    "<init>(IIIIII)V": function (this: JAudioTrack, _stream: number, rate: number, chanCfg: number, fmt: number, bufBytes: number) {
      this.rate = rate; this.channels = chanCfg === 12 || chanCfg === 3 ? 2 : 1; this.bytesPerSample = fmt === 3 ? 1 : 2; this.bufBytes = bufBytes;
    },
    "static getMinBufferSize(III)I": (rate: number, chanCfg: number, fmt: number) => {
      // ~100 ms of frames, as AudioFlinger answers for a typical output
      const frames = Math.max(1024, Math.ceil(rate / 10));
      return frames * (chanCfg === 12 || chanCfg === 3 ? 2 : 1) * (fmt === 3 ? 1 : 2);
    },
    "static getNativeOutputSampleRate(I)I": () => outputSampleRate(),
    "static isDirectPlaybackSupported(Landroid/media/AudioFormat;Landroid/media/AudioAttributes;)Z": () => 0,
    "static getMaxVolume()F": () => 1, "static getMinVolume()F": () => 0,
    "getState()I": function (this: JAudioTrack) { return this.state; },
    "getPlayState()I": function (this: JAudioTrack) { return this.playState; },
    "getSampleRate()I": function (this: JAudioTrack) { return this.rate; },
    "getChannelCount()I": function (this: JAudioTrack) { return this.channels; },
    "getPlaybackHeadPosition()I": function (this: JAudioTrack) { return Math.max(0, Math.min(this.written, Math.floor(this.written - this.queuedSec() * this.rate))) | 0; },
    "setStereoVolume(FF)I": function (this: JAudioTrack, l: number, r: number) { this.vol = (l + r) / 2; if (this.gain) this.gain.gain.value = this.vol; return 0; },
    "setVolume(F)I": function (this: JAudioTrack, v: number) { this.vol = v; if (this.gain) this.gain.gain.value = v; return 0; },
    "setPlaybackRate(I)I": () => 0,
    "setPlaybackPositionUpdateListener(Landroid/media/AudioTrack$OnPlaybackPositionUpdateListener;)V": function (this: JAudioTrack, l: unknown) { this.listener = l; if (!l) this.stopTimer(); else if (this.playState === 3) this.startTimer(); },
    "setPlaybackPositionUpdateListener(Landroid/media/AudioTrack$OnPlaybackPositionUpdateListener;Landroid/os/Handler;)V": function (this: JAudioTrack, l: unknown) { this.listener = l; if (!l) this.stopTimer(); else if (this.playState === 3) this.startTimer(); },
    "setPositionNotificationPeriod(I)I": function (this: JAudioTrack, p: number) { this.period = p; return 0; },
    "setNotificationMarkerPosition(I)I": () => 0,
    "play()V": function (this: JAudioTrack) { this.playState = 3; void this.ctx().resume(); this.nextTime = Math.max(this.nextTime, this.ctx().currentTime); this.startTimer(); },
    "pause()V": function (this: JAudioTrack) { this.playState = 2; this.stopTimer(); },
    "stop()V": function (this: JAudioTrack) { this.playState = 1; this.stopTimer(); },
    "flush()V": function (this: JAudioTrack) { this.nextTime = 0; },
    "release()V": function (this: JAudioTrack) { this.stopTimer(); this.state = 0; this.listener = null; },
    "write([SII)I": function (this: JAudioTrack, data: Int16Array, off: number, n: number) {
      if (this.state !== 1) return -3;
      this.push(data.subarray(off, off + n), Math.floor(n / this.channels));
      return this.wrote(n);
    },
    "write([BIII)I": function (this: JAudioTrack, data: Int8Array, off: number, n: number, mode: number) {
      if (this.state !== 1) return -3;
      if (this.bytesPerSample === 2) this.push(new Int16Array(data.buffer.slice(data.byteOffset + off, data.byteOffset + off + (n & ~1))), Math.floor(n / this.frameBytes()));
      else this.push(data.subarray(off, off + n), Math.floor(n / this.channels));
      return mode === 1 ? n : this.wrote(n);   // WRITE_NON_BLOCKING
    },
    "write([BII)I": function (this: JAudioTrack, data: Int8Array, off: number, n: number) {
      if (this.state !== 1) return -3;
      if (this.bytesPerSample === 2) this.push(new Int16Array(data.buffer.slice(data.byteOffset + off, data.byteOffset + off + (n & ~1))), Math.floor(n / this.frameBytes()));
      else this.push(data.subarray(off, off + n), Math.floor(n / this.channels));
      return this.wrote(n);
    },
    "getAudioSessionId()I": function (this: JAudioTrack) { return this.sessionId; },
    "getBufferSizeInFrames()I": function (this: JAudioTrack) { return Math.floor(this.bufBytes / this.frameBytes()); },
    "getBufferCapacityInFrames()I": function (this: JAudioTrack) { return Math.floor(this.bufBytes / this.frameBytes()); },
    "getAudioAttributes()Landroid/media/AudioAttributes;": function (this: JAudioTrack) { return this.attributes; },
    "isOffloadedPlayback()Z": () => 0,
    "getTimestamp(Landroid/media/AudioTimestamp;)Z": () => 0,
    "getUnderrunCount()I": function (this: JAudioTrack) { return this.underruns; },
    "setPreferredDevice(Landroid/media/AudioDeviceInfo;)Z": (_device: unknown) => 0,
    "getRoutedDevice()Landroid/media/AudioDeviceInfo;": () => null,
    "addOnRoutingChangedListener(Landroid/media/AudioRouting$OnRoutingChangedListener;Landroid/os/Handler;)V": () => {},
    "removeOnRoutingChangedListener(Landroid/media/AudioRouting$OnRoutingChangedListener;)V": () => {},
    "write(Ljava/nio/ByteBuffer;II)I": function (this: JAudioTrack, buffer: JBuffer, n: number, mode: number) { return this.writeBuffer(buffer, n, mode); },
    "write(Ljava/nio/ByteBuffer;IIJ)I": function (this: JAudioTrack, buffer: JBuffer, n: number, mode: number) { return this.writeBuffer(buffer, n, mode); },
  },
});
let nextAudioSession = 1;
class JAudioTrackBuilder extends JObj {
  format: JAudioFormat | null = null;
  attributes: unknown = null;
  mode = 1; bufferSize = 0; sessionId = 0; offload = false;
}
rt.register({
  name: "android/media/AudioTrack$Builder", ctor: JAudioTrackBuilder,
  methods: {
    "<init>()V": () => {},
    "setAudioFormat(Landroid/media/AudioFormat;)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder, format: JAudioFormat) {
      if (!format) throw rt.mkThrowable("java/lang/NullPointerException", null);
      this.format = format; return this;
    },
    "setAudioAttributes(Landroid/media/AudioAttributes;)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder, attributes: unknown) {
      if (!attributes) throw rt.mkThrowable("java/lang/NullPointerException", null);
      this.attributes = attributes; return this;
    },
    "setTransferMode(I)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder, mode: number) {
      if (mode !== 0 && mode !== 1) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid transfer mode");
      this.mode = mode; return this;
    },
    "setBufferSizeInBytes(I)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder, size: number) {
      if (size <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid buffer size");
      this.bufferSize = size; return this;
    },
    "setSessionId(I)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder, id: number) {
      if (id < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid session ID");
      this.sessionId = id; return this;
    },
    "setOffloadedPlayback(Z)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder, offload: number) { this.offload = !!offload; return this; },
    "setContext(Landroid/content/Context;)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder) { return this; },
    "build()Landroid/media/AudioTrack;": function (this: JAudioTrackBuilder) {
      if (this.offload || this.mode !== 1) rt.unimplemented("AudioTrack non-streaming output");
      const format = this.format, encoding = format?.encoding || 2;
      if (encoding !== 2 && encoding !== 3 && encoding !== 4) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Unsupported PCM encoding");
      const track = new (rt.link("android/media/AudioTrack").ctor)() as JAudioTrack;
      track.rate = format?.sampleRate || outputSampleRate();
      if (track.rate < 3000 || track.rate > 384000) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid sample rate");
      let mask = format?.channelIndexMask || format?.channelMask || 12, channels = 0;
      for (; mask; mask &= mask - 1) channels++;
      track.channels = channels;
      track.bytesPerSample = encoding === 4 ? 4 : encoding === 3 ? 1 : 2;
      track.bufBytes = this.bufferSize || Math.max(1024, Math.ceil(track.rate / 10)) * track.frameBytes();
      if (track.bufBytes % track.frameBytes()) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Buffer size must contain whole frames");
      track.attributes = this.attributes;
      track.sessionId = this.sessionId || nextAudioSession++;
      return track;
    },
  },
});
rt.register({ name: "android/media/AudioRouting$OnRoutingChangedListener", ctor: class extends JObj {} });
rt.register({ name: "android/media/AudioTimestamp", ctor: class extends JObj { framePosition = 0n; nanoTime = 0n; }, fields: { framePosition: "framePosition", nanoTime: "nanoTime" }, methods: { "<init>()V": () => {} } });
rt.register({ name: "android/media/AudioTrack$OnPlaybackPositionUpdateListener", ctor: class extends JObj {} });
rt.register({ name: "android/media/AudioRecord$OnRecordPositionUpdateListener", ctor: class extends JObj {} });
class JAudioFormat extends JObj { encoding = 0; sampleRate = 0; channelMask = 0; channelIndexMask = 0; }
rt.register({
  name: "android/media/AudioFormat", ctor: JAudioFormat,
  statics: { CHANNEL_CONFIGURATION_MONO: 2, CHANNEL_CONFIGURATION_STEREO: 3, CHANNEL_OUT_MONO: 4, CHANNEL_OUT_STEREO: 12, CHANNEL_IN_MONO: 16, CHANNEL_IN_STEREO: 12,
    ENCODING_PCM_16BIT: 2, ENCODING_PCM_8BIT: 3, ENCODING_PCM_FLOAT: 4, ENCODING_DEFAULT: 1, ENCODING_INVALID: 0 },
  methods: {
    "getEncoding()I": function (this: JAudioFormat) { return this.encoding; },
    "getSampleRate()I": function (this: JAudioFormat) { return this.sampleRate; },
    "getChannelMask()I": function (this: JAudioFormat) { return this.channelMask; },
    "getChannelIndexMask()I": function (this: JAudioFormat) { return this.channelIndexMask; },
    "getChannelCount()I": function (this: JAudioFormat) {
      let mask = this.channelMask || this.channelIndexMask, n = 0;
      for (; mask; mask &= mask - 1) n++;
      return n;
    },
  },
});
class JAudioFormatBuilder extends JObj { format = new JAudioFormat(); }
rt.register({
  name: "android/media/AudioFormat$Builder", ctor: JAudioFormatBuilder,
  methods: {
    "<init>()V": function () {},
    "<init>(Landroid/media/AudioFormat;)V": function (this: JAudioFormatBuilder, format: JAudioFormat) { Object.assign(this.format, format); },
    "setEncoding(I)Landroid/media/AudioFormat$Builder;": function (this: JAudioFormatBuilder, encoding: number) { this.format.encoding = encoding === 1 ? 2 : encoding; return this; },
    "setSampleRate(I)Landroid/media/AudioFormat$Builder;": function (this: JAudioFormatBuilder, rate: number) { this.format.sampleRate = rate; return this; },
    "setChannelMask(I)Landroid/media/AudioFormat$Builder;": function (this: JAudioFormatBuilder, mask: number) { this.format.channelMask = mask; return this; },
    "setChannelIndexMask(I)Landroid/media/AudioFormat$Builder;": function (this: JAudioFormatBuilder, mask: number) { this.format.channelIndexMask = mask; return this; },
    "build()Landroid/media/AudioFormat;": function (this: JAudioFormatBuilder) { return Object.assign(new JAudioFormat(), this.format); },
  },
});

/**
 * The media scanner indexes a file into MediaStore so a gallery can see it. Nothing here has a
 * MediaStore to index into, but the callback is not optional: an app that waits for it before
 * calling a file finished would hang. AOSP answers with the scanned path and the content URI it
 * was given, and a device with no media provider answers with a null URI.
 */
rt.register({
  name: "android/media/MediaScannerConnection", ctor: class extends JObj {},
  methods: {
    "static scanFile(Landroid/content/Context;[Ljava/lang/String;[Ljava/lang/String;Landroid/media/MediaScannerConnection$OnScanCompletedListener;)V":maySuspend(
      (_c: unknown, paths: string[] | null, _m: unknown, l: unknown) => {
        if (!l) return;
        for (const p of paths ?? []) {
          void onMain(() => vcall(l, "onScanCompleted", "(Ljava/lang/String;Landroid/net/Uri;)V", p, null)).catch(reportUncaught);
        }
      }),
  },
});
rt.register({ name: "android/media/MediaScannerConnection$OnScanCompletedListener", ctor: class extends JObj {} });
rt.register({ name: "android/media/MediaScannerConnection$MediaScannerConnectionClient", ctor: class extends JObj {} });

// ── MediaRouter: one route, the device's own display, with no presentation display behind it
class JRouteInfo extends JObj {}
const theRoute = new JRouteInfo();
rt.register({
  name: "android/media/MediaRouter", ctor: class extends JObj {},
  statics: { ROUTE_TYPE_LIVE_AUDIO: 1, ROUTE_TYPE_LIVE_VIDEO: 2, ROUTE_TYPE_USER: 0x800000, CALLBACK_FLAG_PERFORM_ACTIVE_SCAN: 1, CALLBACK_FLAG_UNFILTERED_EVENTS: 2 },
  methods: {
    "getSelectedRoute(I)Landroid/media/MediaRouter$RouteInfo;": () => theRoute,
    "getDefaultRoute()Landroid/media/MediaRouter$RouteInfo;": () => theRoute,
    "getRouteCount()I": () => 1,
    "getRouteAt(I)Landroid/media/MediaRouter$RouteInfo;": (i: number) => (i === 0 ? theRoute : null),
    "addCallback(ILandroid/media/MediaRouter$Callback;)V": () => {},
    "addCallback(ILandroid/media/MediaRouter$Callback;I)V": () => {},
    "removeCallback(Landroid/media/MediaRouter$Callback;)V": () => {},
  },
});
rt.register({ name: "android/media/MediaRouter$Callback", ctor: class extends JObj {} });
rt.register({
  name: "android/media/MediaRouter$RouteInfo", ctor: JRouteInfo,
  methods: {
    "getPresentationDisplay()Landroid/view/Display;": () => null,
    "getName()Ljava/lang/CharSequence;": () => "Phone",
    "getName(Landroid/content/Context;)Ljava/lang/CharSequence;": () => "Phone",
    "getSupportedTypes()I": () => 3,
    "getPlaybackType()I": () => 0,
    "isEnabled()Z": () => 1,
  },
});

// no hardware codec is enumerable here: an empty list is what a device without one reports
rt.register({ name: "android/media/MediaCodecInfo", ctor: class extends JObj {} });
rt.register({
  name: "android/media/MediaCodecList", ctor: class extends JObj {},
  statics: { REGULAR_CODECS: 0, ALL_CODECS: 1 },
  methods: {
    "<init>(I)V": function () {},
    "getCodecInfos()[Landroid/media/MediaCodecInfo;": () => jarray([], "Landroid/media/MediaCodecInfo;"),
    "static getCodecCount()I": () => 0,
    "findDecoderForFormat(Landroid/media/MediaFormat;)Ljava/lang/String;": () => null,
    "findEncoderForFormat(Landroid/media/MediaFormat;)Ljava/lang/String;": () => null,
  },
});
rt.register({ name: "android/media/MediaCodec$Callback", ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });
rt.register({ name: "android/media/metrics/LogSessionId", ctor: class extends JObj {}, methods: { "getStringId()Ljava/lang/String;": () => "" } });
class JBufferInfo extends JObj { offset = 0; size = 0; presentationTimeUs = 0n; flags = 0; }
rt.register({
  name: "android/media/MediaCodec$BufferInfo", ctor: JBufferInfo,
  fields: { offset: "offset", size: "size", presentationTimeUs: "presentationTimeUs", flags: "flags" },
  methods: {
    "<init>()V": function () {},
    "set(IIJI)V": function (this: JBufferInfo, o: number, s: number, t: bigint, f: number) { this.offset = o; this.size = s; this.presentationTimeUs = t; this.flags = f; },
  },
});
class JCryptoInfo extends JObj { pattern: unknown = null; }
rt.register({
  name: "android/media/MediaCodec$CryptoInfo", ctor: JCryptoInfo,
  methods: { "<init>()V": function () {}, "setPattern(Landroid/media/MediaCodec$CryptoInfo$Pattern;)V": function (this: JCryptoInfo, p: unknown) { this.pattern = p; } },
});
class JCryptoPattern extends JObj { encrypt = 0; skip = 0; }
rt.register({
  name: "android/media/MediaCodec$CryptoInfo$Pattern", ctor: JCryptoPattern,
  methods: {
    "<init>(II)V": function (this: JCryptoPattern, e: number, s: number) { this.encrypt = e; this.skip = s; },
    "set(II)V": function (this: JCryptoPattern, e: number, s: number) { this.encrypt = e; this.skip = s; },
    "getEncryptBlocks()I": function (this: JCryptoPattern) { return this.encrypt; },
    "getSkipBlocks()I": function (this: JCryptoPattern) { return this.skip; },
  },
});

export class JSpatializer extends JObj {}
rt.register({
  name: "android/media/Spatializer", ctor: JSpatializer,
  statics: { SPATIALIZER_IMMERSIVE_LEVEL_NONE: 0 },
  methods: {
    "getImmersiveAudioLevel()I": () => 0,
    "isAvailable()Z": () => 0,
    "isEnabled()Z": () => 0,
    "canBeSpatialized(Landroid/media/AudioAttributes;Landroid/media/AudioFormat;)Z": () => 0,
    "addOnSpatializerStateChangedListener(Ljava/util/concurrent/Executor;Landroid/media/Spatializer$OnSpatializerStateChangedListener;)V": () => {},
    "removeOnSpatializerStateChangedListener(Landroid/media/Spatializer$OnSpatializerStateChangedListener;)V": () => {},
  },
});
rt.register({ name: "android/media/Spatializer$OnSpatializerStateChangedListener", ctor: class extends JObj {} });

rt.register({
  name: "android/media/AudioDeviceCallback", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "onAudioDevicesAdded([Landroid/media/AudioDeviceInfo;)V": () => {},
    "onAudioDevicesRemoved([Landroid/media/AudioDeviceInfo;)V": () => {},
  },
});
