// SoundPool's native half over Web Audio: a decoded AudioBuffer per sample id (null while
// decoding), and a one-shot source + gain node per stream id.
import { rt, type JObj } from "../jvm/runtime.ts";
import { after } from "../jvm/natives/jentry.ts";
import { fdInt } from "../jvm/natives/jio.ts";
import { readFully } from "../shell/lazyfile.ts";
import { audioContext, type AudioData, type AudioGain, type AudioSource } from "./audio-output.ts";
import { fdSlice, nativePeer, postNativeEvent } from "./media-native.ts";

type Stream = { src: AudioSource; gain: AudioGain; prio: number; rate: number; volume: number };
/** Web Audio sources cannot pause; a zero playback rate holds the position instead */
function setRate(s: Stream, rate: number): void { s.src.playbackRate.value = rate; }
class Pool {
  readonly owner: JObj; readonly maxStreams: number;
  constructor(owner: JObj, maxStreams: number) { this.owner = owner; this.maxStreams = maxStreams; }
  sounds = new Map<number, AudioData | null>();
  streams = new Map<number, Stream>();
  nextId = 1;
  nextStream = 1;
  muted = false;
  load(bytes: Uint8Array): number {
    const id = this.nextId++;
    this.sounds.set(id, null);
    // decodeAudioData detaches the buffer it is given, so the bytes are copied first
    audioContext().decodeAudioData(bytes.slice().buffer as ArrayBuffer)
      .then((buf) => this.decoded(id, buf, 0), () => this.decoded(id, null, 1));
    return id;
  }
  /** SoundPool::Sound's SAMPLE_LOADED event, unless the sample was unloaded or released first */
  decoded(id: number, buf: AudioData | null, status: number) {
    if (!this.sounds.has(id)) return;
    if (buf) this.sounds.set(id, buf);
    postNativeEvent(this.owner, () => this.sounds.has(id), 1, id, status);
  }
  stop(sid: number) {
    const s = this.streams.get(sid);
    if (s) { s.src.stop(); this.streams.delete(sid); }
  }
  each(sid: number, f: (s: Stream) => void) { const s = this.streams.get(sid); if (s) f(s); }
  release() { for (const s of this.streams.values()) s.src.stop(); this.streams.clear(); this.sounds.clear(); }
}
const pools = nativePeer<Pool>(null, "SoundPool released", (p) => p.release());
const P = pools.on;
rt.claimNativeLib("soundpool");
rt.registerJnis("android/media/SoundPool", {
  "native_setup(ILjava/lang/Object;Ljava/lang/String;)I": function (this: JObj, maxStreams: number) { pools.attach(this, new Pool(this, maxStreams)); return 0; },
  "native_release()V": pools.detach,
  "_load(Ljava/io/FileDescriptor;JJI)I": function (this: JObj, fd: JObj | null, offset: bigint, length: bigint) {
    if (fd === null) rt.npe();
    return after(fdSlice(fdInt(fd), offset, length), source => source ? after(readFully(source), (bytes) => pools.get(this).load(bytes)) : 0);
  },
  "_play(IFFIIFI)I": P((p, id: number, l: number, r: number, prio: number, loop: number, rate: number) => {
    const buf = p.sounds.get(id);
    if (!buf) return 0;
    const actx = audioContext();
    // reached from a pointer-driven main-looper job, i.e. inside the user-activation window
    if (actx.state === "suspended") void actx.resume();
    if (p.streams.size >= p.maxStreams) {
      // the lowest-priority stream at or below the newcomer's yields, else the newcomer is refused
      let v: [number, Stream] | undefined;
      for (const e of p.streams) if (e[1].prio <= prio && (!v || e[1].prio < v[1].prio)) v = e;
      if (!v) return 0;
      p.stop(v[0]);
    }
    const src = actx.createBufferSource();
    src.buffer = buf; src.loop = loop !== 0;
    const gain = actx.createGain(), volume = Math.max(l, r);
    gain.gain.value = p.muted ? 0 : volume;
    src.connect(gain); gain.connect(actx.destination);
    const sid = p.nextStream++, s: Stream = { src, gain, prio, rate, volume };
    src.onended = () => p.streams.delete(sid);
    setRate(s, rate);
    src.start();
    // loop = n > 0 means n + 1 plays: keep looping and schedule the end (at the starting rate)
    if (loop > 0) src.stop(actx.currentTime + (buf.duration * (loop + 1)) / rate);
    p.streams.set(sid, s);
    return sid;
  }),
  "stop(I)V": P((p, sid: number) => p.stop(sid)),
  "pause(I)V": P((p, sid: number) => p.each(sid, (s) => setRate(s, 0))),
  "resume(I)V": P((p, sid: number) => p.each(sid, (s) => setRate(s, s.rate))),
  "autoPause()V": P((p) => { for (const s of p.streams.values()) setRate(s, 0); }),
  "autoResume()V": P((p) => { for (const s of p.streams.values()) setRate(s, s.rate); }),
  "_setVolume(IFF)V": P((p, sid: number, l: number, r: number) => p.each(sid, (s) => { s.volume = Math.max(l, r); if (!p.muted) s.gain.gain.value = s.volume; })),
  "_mute(Z)V": P((p, muted: number) => { p.muted = !!muted; for (const s of p.streams.values()) s.gain.gain.value = p.muted ? 0 : s.volume; }),
  "setLoop(II)V": P((p, sid: number, loop: number) => p.each(sid, (s) => { s.src.loop = loop !== 0; })),
  "setRate(IF)V": P((p, sid: number, rate: number) => p.each(sid, (s) => { if (s.src.playbackRate.value) setRate(s, rate); s.rate = rate; })),
  "setPriority(II)V": P((p, sid: number, prio: number) => p.each(sid, (s) => { s.prio = prio; })),
  "unload(I)Z": P((p, id: number) => +p.sounds.delete(id)),
});
