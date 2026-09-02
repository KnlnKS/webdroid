// android.media: MediaPlayer over HTMLAudioElement, SoundPool over Web Audio.

import { rt, JObj } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { vfs } from "../jvm/natives/jio";
import { onMain } from "./mainloop";
import { reportUncaught } from "./os";

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
        const v = host.res.value(resId);
        const bytes = v.s ? host.zip[v.s] : null;
        if (bytes) mpLoad(mp, bytes);
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
    "setOnPreparedListener(Landroid/media/MediaPlayer$OnPreparedListener;)V": function (this: JMediaPlayer, l: unknown) {
      setTimeout(() => void vcall(l, "onPrepared", "(Landroid/media/MediaPlayer;)V", this).catch(reportUncaught), 10);
    },
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
      const v = host ? host.res.value(resId) : null;
      return this.load(v?.s ? host.zip[v.s] ?? null : null);
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
class JSoundPoolBuilder extends JObj { max = 1; }
rt.register({
  name: "android/media/SoundPool$Builder", ctor: JSoundPoolBuilder,
  methods: {
    "<init>()V": function () {},
    "setMaxStreams(I)Landroid/media/SoundPool$Builder;": function (this: JSoundPoolBuilder, n: number) { this.max = n; return this; },
    "build()Landroid/media/SoundPool;": function (this: JSoundPoolBuilder) {
      const p = new JSoundPool(); p.maxStreams = this.max; pools.add(p); return p;
    },
  },
});
