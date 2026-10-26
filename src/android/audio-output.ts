// The audio output: the Web Audio context the page gives this process (closed when the process dies), and the
// PCM a Java AudioTrack or an AAudio stream schedules on it.

import { onProcessExit } from "../process-exit.ts";

/** the Web Audio subset this output uses, which a process Worker reaches on the page */
export interface AudioNodeLike { connect(node: AudioNodeLike): unknown; disconnect(): void }
export interface AudioData { readonly length: number; readonly duration: number }
export interface AudioPcm extends AudioData { getChannelData(channel: number): Float32Array }
export interface AudioGain extends AudioNodeLike { readonly gain: { value: number } }
export interface AudioSource extends AudioNodeLike {
  buffer: AudioData | null; loop: boolean; readonly playbackRate: { value: number }; onended: ((event: Event) => void) | null;
  start(when?: number, offset?: number): void; stop(when?: number): void;
}
export interface AudioOut {
  readonly currentTime: number; readonly sampleRate: number; readonly outputLatency: number; readonly baseLatency: number;
  readonly state: AudioContextState; readonly destination: AudioNodeLike;
  resume(): Promise<void>; close(): Promise<void>;
  createGain(): AudioGain; createBufferSource(): AudioSource; createBuffer(channels: number, length: number, rate: number): AudioPcm;
  decodeAudioData(bytes: ArrayBuffer): Promise<AudioData>;
}
let actx: AudioOut | null = null;
export const audioContext = (): AudioOut => {
  if (!actx) throw new Error("No audio output: the page that owns this process gives it one");
  return actx;
};
export const useAudioOut = (out: AudioOut): void => { actx = out; };
/** the rate the Web Audio output actually runs at */
export const outputSampleRate = (): number => actx?.sampleRate ?? 44100;
let audioSession = 0;
export const newAudioSessionId = (): number => ++audioSession;
/** the frames of one 10 ms burst of the output: the primary output's period and AAudio's burst */
export const burstFrames = (rate: number): number => Math.ceil(rate / 100);
/** the frames AudioFlinger's minimum buffer holds, about 100 ms of output */
export const minFrames = (rate: number): number => Math.max(1024, Math.ceil(rate / 10));
/** bytes per sample of ENCODING_PCM_16BIT, _8BIT and _FLOAT, the encodings Web Audio can play */
export const PCM_BYTES: Record<number, number> = { 2: 2, 3: 1, 4: 4 };

// a dead process sounds nothing: closing its output stops its scheduled PCM and its players' elements
onProcessExit(() => void actx?.close());

type Entry = { buffer: AudioPcm; offset: number; start: number; source: AudioSource | null; consumed?: () => void };
export type PcmConfig = { rate: number; channels: number; bytesPerSample: number; sessionId: number };
/** PCM scheduled back-to-back on the shared context */
export class PcmOutput {
  readonly rate: number; readonly channels: number; readonly bytesPerSample: number; readonly sessionId: number;
  constructor(config: PcmConfig) {
    ({ rate: this.rate, channels: this.channels, bytesPerSample: this.bytesPerSample, sessionId: this.sessionId } = config);
  }
  playing = false; written = 0; played = 0; underruns = 0;
  #queue: Entry[] = [];
  #nextTime = 0;
  #draining = false;
  #gain: AudioGain | null = null;
  #volume = 1;
  frameBytes(): number { return this.channels * this.bytesPerSample; }
  /** nothing is queued or playing */
  get idle(): boolean { return !this.#queue.length; }
  head(): number {
    const now = this.#queue.length ? audioContext().currentTime : 0;
    return this.played + this.#queue.reduce((frames, entry) => frames + Math.min(entry.buffer.length,
      entry.offset + (entry.source ? Math.max(0, now - entry.start) * this.rate : 0)), 0);
  }
  queuedSec(): number { return Math.max(0, this.written - this.head()) / this.rate; }
  setVolume(v: number): void { this.#volume = v; if (this.#gain) this.#gain.gain.value = v; }
  #schedule(): void {
    const ctx = audioContext();
    if (!this.#gain) { this.#gain = ctx.createGain(); this.#gain.gain.value = this.#volume; this.#gain.connect(ctx.destination); }
    for (const entry of this.#queue) {
      if (entry.source) continue;
      const source = entry.source = ctx.createBufferSource();
      source.buffer = entry.buffer; source.connect(this.#gain);
      entry.start = Math.max(this.#nextTime, ctx.currentTime + 0.02);
      source.onended = () => {
        const index = this.#queue.indexOf(entry);
        if (index < 0) return;
        this.#queue.splice(index, 1); this.played += entry.buffer.length; source.disconnect();
        // a stop that played out what was queued leaves the output as a new one
        if (this.#draining && !this.#queue.length) { this.#draining = this.playing = false; this.written = this.played = 0; }
        entry.consumed?.();
      };
      source.start(entry.start, entry.offset / this.rate);
      this.#nextTime = entry.start + (entry.buffer.length - entry.offset) / this.rate;
    }
  }
  play(): void { this.playing = true; this.#draining = false; void audioContext().resume(); this.#schedule(); }
  pause(): void {
    this.playing = this.#draining = false;
    const now = this.#queue.length ? audioContext().currentTime : 0;
    for (const entry of this.#queue) {
      if (!entry.source) continue;
      entry.offset = Math.min(entry.buffer.length, entry.offset + Math.max(0, now - entry.start) * this.rate);
      entry.source.onended = null; entry.source.stop(); entry.source.disconnect(); entry.source = null;
    }
    this.#nextTime = 0;
  }
  flush(): void { this.pause(); this.#queue = []; this.written = this.played = 0; }
  /** a stopped output plays out what it was given: true while it does */
  stop(): boolean {
    if (!this.playing || !this.#queue.length) { this.flush(); return false; }
    return this.#draining = true;
  }
  release(): void { this.flush(); this.#gain?.disconnect(); this.#gain = null; }
  /** interleaved 16-bit, 8-bit unsigned or float PCM → one scheduled buffer */
  push(samples: Int16Array | Int8Array | Float32Array, frames: number, consumed?: () => void): void {
    if (frames <= 0) return;
    const buf = audioContext().createBuffer(this.channels, frames, this.rate);
    for (let c = 0; c < this.channels; c++) {
      const ch = buf.getChannelData(c);
      if (samples instanceof Float32Array) for (let i = 0; i < frames; i++) ch[i] = samples[i * this.channels + c];
      else if (samples instanceof Int16Array) for (let i = 0; i < frames; i++) ch[i] = samples[i * this.channels + c] / 32768;
      else for (let i = 0; i < frames; i++) ch[i] = ((samples[i * this.channels + c] & 0xff) - 128) / 128;
    }
    if (this.playing && this.written && this.queuedSec() === 0) this.underruns++;
    this.#queue.push({ buffer: buf, offset: 0, start: 0, source: null, consumed });
    this.written += frames;
    if (this.playing) this.#schedule();
  }
}
