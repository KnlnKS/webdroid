// Web Audio for a process Worker, which has none. The page's one AudioContext mixes every process's
// graph, as AudioFlinger mixes every client's tracks; a Worker holds proxies for the nodes and
// buffers it made, and the page posts back its clock, ended sources and decoded buffers.
import type { AudioData, AudioGain, AudioNodeLike, AudioOut, AudioPcm, AudioSource } from "../android/audio-output";

type Command =
  | { op: "gain" | "source" | "disconnect" | "free" | "resume"; id: number }
  | { op: "buffer"; id: number; rate: number; channels: Float32Array<ArrayBuffer>[] }
  | { op: "decode"; id: number; bytes: ArrayBuffer }
  | { op: "set"; id: number; key: "gain" | "rate" | "loop" | "buffer"; value: number }
  | { op: "connect"; id: number; to: number }
  | { op: "start"; id: number; when: number; offset: number }
  | { op: "stop"; id: number; when?: number };
type Clock = { time: number; at: number; state: AudioContextState; sampleRate: number; outputLatency: number; baseLatency: number };
type Notice = { op: "clock" } | { op: "ended"; id: number } | { op: "decoded"; id: number; length: number; duration: number } | { op: "failed"; id: number };
type Reply = Notice & { clock: Clock };

const wallTime = () => performance.timeOrigin + performance.now();
const DESTINATION = 0;

/** a Worker's AudioOut over `port`; the page creates its context at the first command */
export function sendAudio(port: MessagePort): AudioOut {
  let next = DESTINATION + 1, closed = false;
  let clock: Clock = { time: 0, at: 0, state: "suspended", sampleRate: 0, outputLatency: 0, baseLatency: 0 };
  const sources = new Map<number, Source>(), decodes = new Map<number, ReturnType<typeof Promise.withResolvers<AudioData>>>();
  const freed = new FinalizationRegistry<number>(id => post({ op: "free", id }));
  const post = (command: Command) => { if (!closed) port.postMessage(command); };
  const param = (id: number, key: "gain" | "rate", value: number) => {
    let current = value;
    return { get value() { return current; }, set value(v: number) { current = v; post({ op: "set", id, key, value: v }); } };
  };
  class Node implements AudioNodeLike {
    readonly id = next++;
    constructor(op: "gain" | "source") { post({ op, id: this.id }); freed.register(this, this.id); }
    connect(node: AudioNodeLike) { post({ op: "connect", id: this.id, to: (node as Node).id }); return node; }
    disconnect() { post({ op: "disconnect", id: this.id }); }
  }
  class Gain extends Node implements AudioGain { readonly gain = param(this.id, "gain", 1); constructor() { super("gain"); } }
  class Source extends Node implements AudioSource {
    readonly playbackRate = param(this.id, "rate", 1);
    onended: ((event: Event) => void) | null = null;
    #buffer: AudioData | null = null; #loop = false;
    constructor() { super("source"); }
    get buffer() { return this.#buffer; }
    set buffer(data: AudioData | null) { this.#buffer = data; post({ op: "set", id: this.id, key: "buffer", value: data ? upload(data) : DESTINATION }); }
    get loop() { return this.#loop; }
    set loop(on: boolean) { this.#loop = on; post({ op: "set", id: this.id, key: "loop", value: +on }); }
    start(when = 0, offset = 0) { sources.set(this.id, this); post({ op: "start", id: this.id, when, offset }); }
    stop(when?: number) { post({ op: "stop", id: this.id, when }); }
  }
  const ids = new WeakMap<AudioData, number>();
  /** a created buffer reaches the page when a source first plays it */
  function upload(data: AudioData): number {
    let id = ids.get(data);
    if (id === undefined) {
      const pcm = data as Pcm;
      ids.set(data, id = next++);
      post({ op: "buffer", id, rate: pcm.sampleRate, channels: pcm.channels });
      freed.register(data, id);
    }
    return id;
  }
  class Pcm implements AudioPcm {
    readonly channels: Float32Array<ArrayBuffer>[];
    constructor(count: number, readonly length: number, readonly sampleRate: number) {
      this.channels = Array.from({ length: count }, () => new Float32Array(length));
    }
    get duration() { return this.length / this.sampleRate; }
    getChannelData(channel: number) { return this.channels[channel]; }
  }
  port.onmessage = ({ data }: MessageEvent<Reply>) => {
    clock = data.clock;
    if (data.op === "ended") { const source = sources.get(data.id); sources.delete(data.id); source?.onended?.(new Event("ended")); }
    else if (data.op === "decoded" || data.op === "failed") {
      const decode = decodes.get(data.id);
      decodes.delete(data.id);
      if (data.op === "failed") decode?.reject(new DOMException("Unable to decode audio data", "EncodingError"));
      else if (decode) { const buffer = { length: data.length, duration: data.duration }; ids.set(buffer, data.id); freed.register(buffer, data.id); decode.resolve(buffer); }
    }
  };
  const destination = { id: DESTINATION, connect: () => { throw new Error("the destination has no outputs"); }, disconnect() {} };
  return {
    get currentTime() { return clock.state === "running" ? clock.time + Math.max(0, wallTime() - clock.at) / 1000 : clock.time; },
    get sampleRate() { return clock.sampleRate || 44100; },
    get outputLatency() { return clock.outputLatency; },
    get baseLatency() { return clock.baseLatency; },
    get state() { return closed ? "closed" : clock.state; },
    destination,
    resume: async () => { post({ op: "resume", id: DESTINATION }); },
    close: async () => { if (!closed) { port.postMessage({ kind: "close" }); closed = true; port.close(); } },
    createGain: () => new Gain(),
    createBufferSource: () => new Source(),
    createBuffer: (channels, length, rate) => new Pcm(channels, length, rate),
    decodeAudioData(bytes) {
      const id = next++, decode = Promise.withResolvers<AudioData>();
      decodes.set(id, decode);
      port.postMessage({ op: "decode", id, bytes } satisfies Command, [bytes]);
      return decode.promise;
    },
  };
}

let shared: AudioContext | undefined;
const waiting = new Set<(context: AudioContext) => void>();
/** the page's context, created by the first process to play; every process then follows its clock */
function sharedContext(): AudioContext {
  if (!shared) { shared = new AudioContext(); for (const attach of waiting) attach(shared); waiting.clear(); }
  return shared;
}
/** play one process's graph on the page's context; closing stops what it still sounds */
export function receiveAudio(port: MessagePort): () => void {
  const objects = new Map<number, AudioNode | AudioBuffer>(), playing = new Set<AudioBufferSourceNode>();
  let context: AudioContext | undefined, closed = false;
  const clock = (ctx: AudioContext): Clock => ({ time: ctx.currentTime, at: wallTime(), state: ctx.state, sampleRate: ctx.sampleRate,
    outputLatency: ctx.outputLatency || 0, baseLatency: ctx.baseLatency || 0 });
  const reply = (data: Notice) => { if (!closed && context) port.postMessage({ ...data, clock: clock(context) }); };
  const changed = () => reply({ op: "clock" });
  const attach = (ctx: AudioContext) => { context = ctx; ctx.addEventListener("statechange", changed); changed(); };
  if (shared) attach(shared); else waiting.add(attach);
  const node = <T extends AudioNode | AudioBuffer>(id: number) => objects.get(id) as T;
  function run(c: Command, ctx: AudioContext): void {
    switch (c.op) {
      case "gain": objects.set(c.id, ctx.createGain()); break;
      case "source": {
        const source = ctx.createBufferSource();
        source.onended = () => { playing.delete(source); reply({ op: "ended", id: c.id }); };
        objects.set(c.id, source); break;
      }
      case "buffer": {
        const buffer = ctx.createBuffer(c.channels.length, c.channels[0].length, c.rate);
        c.channels.forEach((data, channel) => buffer.copyToChannel(data, channel));
        objects.set(c.id, buffer); break;
      }
      case "decode":
        ctx.decodeAudioData(c.bytes).then(buffer => { objects.set(c.id, buffer); reply({ op: "decoded", id: c.id, length: buffer.length, duration: buffer.duration }); },
          () => reply({ op: "failed", id: c.id }));
        break;
      case "set": {
        if (c.key === "gain") node<GainNode>(c.id).gain.value = c.value;
        else if (c.key === "rate") node<AudioBufferSourceNode>(c.id).playbackRate.value = c.value;
        else if (c.key === "loop") node<AudioBufferSourceNode>(c.id).loop = !!c.value;
        else node<AudioBufferSourceNode>(c.id).buffer = c.value === DESTINATION ? null : node<AudioBuffer>(c.value);
        break;
      }
      case "connect": node<AudioNode>(c.id).connect(c.to === DESTINATION ? ctx.destination : node<AudioNode>(c.to)); break;
      case "disconnect": node<AudioNode>(c.id).disconnect(); break;
      case "start": { const source = node<AudioBufferSourceNode>(c.id); playing.add(source); source.start(c.when, c.offset); break; }
      case "stop": node<AudioBufferSourceNode>(c.id).stop(c.when); break;
      // a source stays reachable until it ends, so that closing can still silence it
      case "free": if (!playing.has(objects.get(c.id) as AudioBufferSourceNode)) objects.delete(c.id); break;
      case "resume": void ctx.resume(); break;
    }
  }
  function close(): void {
    if (closed) return;
    closed = true;
    waiting.delete(attach);
    context?.removeEventListener("statechange", changed);
    for (const source of playing) { source.onended = null; source.stop(); }
    for (const object of objects.values()) if (object instanceof AudioNode) object.disconnect();
    objects.clear(); playing.clear(); port.close();
  }
  port.onmessage = ({ data }: MessageEvent<Command | { kind: "close" }>) => {
    if ("kind" in data) { close(); return; }
    try { run(data, context ?? sharedContext()); } catch (error) { console.warn("[audio]", data.op, error); }
  };
  return close;
}
