// AudioTrack's native half (MODE_STREAM): PCM written from Java is scheduled back-to-back on the
// shared AudioContext. The periodic position event is what streaming mixers (a native engine's
// SoundPlayer) refill from, so it fires whenever the queue runs below a few periods.
import { rt, type JObj } from "../jvm/runtime.ts";
import { after } from "../jvm/natives/jentry.ts";
import { type JBuffer, readBufferBytes } from "../jvm/natives/jnio.ts";
import { uptimeMillis } from "../guest-clock.ts";
import { PCM_BYTES, PcmOutput, type PcmConfig, audioContext, minFrames, newAudioSessionId, outputSampleRate } from "./audio-output.ts";
import { nativePeer, postNativeEvent } from "./media-native.ts";

const bitCount = (mask: number) => { let n = 0; for (; mask; mask &= mask - 1) n++; return n; };
const AT = "android/media/AudioTrack";
/** a Java AudioTrack's native track, which posts position events back through its WeakReference */
class Track extends PcmOutput {
  readonly ref: JObj;
  constructor(ref: JObj, config: PcmConfig, bufBytes: number) {
    super(config);
    this.ref = ref;
    this.bufBytes = Math.max(bufBytes, minFrames(this.rate) * this.frameBytes());
  }
  readonly bufBytes: number;
  stopped = true; origin = 0; period = 0; marker = 0; markerSent = false;
  timer: ReturnType<typeof setInterval> | null = null;
  /** AudioTrack::getPosition: 0 once stopped (a stopping track plays out its queue and keeps counting), whatever is written before the next start */
  position(): number { return this.stopped && !this.playing ? 0 : Math.floor(this.head() - this.origin); }
  /** refill until ~3 periods are queued: each NATIVE_EVENT_NEW_POS is one write of one period */
  tick(): void {
    if (!this.playing) return;
    if (this.marker > 0 && !this.markerSent && this.position() >= this.marker) { this.markerSent = true; postNativeEvent([AT, this.ref], null, 3); }
    if (this.period && this.queuedSec() < 3 * this.period / this.rate) postNativeEvent([AT, this.ref], null, 4);
  }
  startTimer(): void {
    if (this.timer || (!this.period && !this.marker)) return;
    this.timer = setInterval(() => this.tick(), Math.max(5, (this.period || 1024) / this.rate * 500));
  }
  stopTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  close(): void { this.stopTimer(); this.release(); }
  /** a blocking write waits while the buffer is full, which is what paces a writer loop; a
   *  non-blocking one takes what fits */
  write(blocking: boolean, frames: number, take: (frames: number) => void): number | Promise<number> {
    const room = () => Math.max(0, Math.floor(this.bufBytes / this.frameBytes() - this.queuedSec() * this.rate));
    if (!blocking) { const n = Math.min(frames, room()); take(n); return n; }
    take(frames);
    const excess = this.queuedSec() - this.bufBytes / this.frameBytes() / this.rate;
    return excess > 0.005 ? new Promise((r) => setTimeout(() => r(frames), excess * 1000)) : frames;
  }
}
const tracks = nativePeer<Track>(null, "Unable to retrieve AudioTrack pointer", (tr) => tr.close());
const T = tracks.on;
/** a write of `count` samples starting at `off`, answered in samples (bytes for byte[]) as the JNI does */
function writeSamples(this: JObj, data: Int16Array | Int8Array | Float32Array, off: number, count: number, format: number, blocking: number) {
  const tr = tracks.find(this);
  if (!tr) return -3;
  if (PCM_BYTES[format] !== tr.bytesPerSample) return -2;
  const unit = data instanceof Int8Array ? tr.bytesPerSample : 1;
  const frames = Math.floor(count / unit / tr.channels);
  return after(tr.write(!!blocking, frames, (n) => {
    const n0 = n * tr.channels * unit;
    // byte[] PCM wider than 8 bits is copied out to an aligned buffer
    tr.push(data instanceof Int8Array && tr.bytesPerSample !== 1
      ? new (tr.bytesPerSample === 2 ? Int16Array : Float32Array)(new Uint8Array(data.buffer, data.byteOffset + off, n0).slice().buffer)
      : data.subarray(off, off + n0), n);
  }), (n) => n * tr.channels * unit);
}
rt.registerJnis(AT, {
  "native_setup(Ljava/lang/Object;Ljava/lang/Object;[IIIIII[ILandroid/os/Parcel;JZILjava/lang/Object;Ljava/lang/String;)I": function (this: JObj,
    ref: JObj, _attributes: unknown, rate: Int32Array, channelMask: number, indexMask: number, format: number, bufBytes: number, mode: number, session: Int32Array) {
    // MODE_STATIC's shared-memory buffer is not modelled: AUDIOTRACK_ERROR_SETUP_NATIVEINITFAILED
    if (mode !== 1 || !PCM_BYTES[format]) return -20;
    const tr = new Track(ref, { rate: rate[0] || outputSampleRate(), channels: bitCount(indexMask || channelMask), bytesPerSample: PCM_BYTES[format],
      sessionId: session[0] ||= newAudioSessionId() }, bufBytes);
    rate[0] = tr.rate;
    tracks.attach(this, tr);
    return 0;
  },
  "native_start()V": T((tr) => { if (tr.stopped) { tr.origin = tr.head(); tr.markerSent = false; } tr.stopped = false; tr.play(); tr.startTimer(); }),
  "native_pause()V": T((tr) => { tr.pause(); tr.stopTimer(); }),
  "native_stop()V": T((tr) => { tr.stopped = true; tr.stop(); tr.stopTimer(); }),
  "native_flush()V": T((tr) => { if (!tr.playing) { tr.flush(); tr.origin = 0; } }),
  "native_release()V": tracks.detach,
  "native_finalize()V": tracks.detach,
  "native_write_byte([BIIIZ)I": writeSamples,
  "native_write_short([SIIIZ)I": writeSamples,
  "native_write_float([FIIIZ)I": writeSamples,
  "native_write_native_bytes(Ljava/nio/ByteBuffer;IIIZ)I": function (this: JObj, buffer: JBuffer, pos: number, n: number, f: number, b: number) {
    return after(readBufferBytes(buffer,pos,n), bytes => writeSamples.call(this,new Int8Array(bytes.buffer,bytes.byteOffset,bytes.length),0,n,f,b));
  },
  "native_get_position()I": T((tr) => tr.position() | 0),
  "native_get_timestamp([J)I": T((tr, out: BigInt64Array) => {
    if (!tr.playing || !tr.written) return -7;   // ERROR_WOULD_BLOCK until frames are presented
    out[0] = BigInt(tr.position()); out[1] = BigInt(Math.floor(uptimeMillis() * 1e6));
    return 0;
  }),
  // AudioTrack::latency(): the output's latency plus the track's own buffer, in ms
  "native_get_latency()I": T((tr) => {
    const ctx = audioContext();
    return Math.round(((ctx.outputLatency || ctx.baseLatency) + tr.bufBytes / tr.frameBytes() / tr.rate) * 1000);
  }),
  "native_setVolume(FF)V": T((tr, l: number, r: number) => tr.setVolume(Math.max(l, r))),
  "native_set_pos_update_period(I)I": T((tr, period: number) => { tr.period = period; if (tr.playing) tr.startTimer(); return 0; }),
  "native_get_pos_update_period()I": T((tr) => tr.period),
  "native_set_marker_pos(I)I": T((tr, marker: number) => { tr.marker = marker; tr.markerSent = false; if (tr.playing) tr.startTimer(); return 0; }),
  "native_get_marker_pos()I": T((tr) => tr.marker),
  "native_get_buffer_size_frames()I": T((tr) => tr.bufBytes / tr.frameBytes()),
  "native_get_buffer_capacity_frames()I": T((tr) => tr.bufBytes / tr.frameBytes()),
  "native_get_underrun_count()I": T((tr) => tr.underruns),
  "native_get_playback_rate()I": T((tr) => tr.rate),
  "native_get_flags()I": () => 0,
  "native_getRoutedDeviceId()I": () => 0,
  "native_getPortId()I": () => 0,
  // the output never changes route, so no routing event is ever posted; no AudioFlinger reads the ids
  "native_enableDeviceCallback()V": () => {}, "native_disableDeviceCallback()V": () => {},
  "native_setPlayerIId(I)V": () => {}, "native_setLogSessionId(Ljava/lang/String;)V": () => {},
  "native_get_min_buff_size(III)I": (rate: number, channels: number, format: number) =>
    PCM_BYTES[format] ? minFrames(rate) * channels * PCM_BYTES[format] : -1,
  "native_get_output_sample_rate(I)I": outputSampleRate,
  "native_is_direct_output_supported(IIIIIII)Z": () => 0,
});
// No capture device is modelled: AudioRecord's setup fails as AUDIORECORD_ERROR_SETUP_NATIVEINITFAILED.
rt.registerJnis("android/media/AudioRecord", {
  "native_setup(Ljava/lang/Object;Ljava/lang/Object;[IIIII[ILandroid/os/Parcel;JII)I": () => -20,
  "native_get_min_buff_size(III)I": (rate: number, channels: number, format: number) =>
    rate >= 4000 && rate <= 192000 && PCM_BYTES[format] ? minFrames(rate) * channels * PCM_BYTES[format] : 0,
  "native_release()V": () => {}, "native_finalize()V": () => {},
});
rt.registerJni("android/media/MediaRecorder", "native_init()V", () => {});
