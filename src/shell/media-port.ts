// Web Audio and media elements for a process Worker, which has neither. The page's one AudioContext
// mixes every process's graph, as AudioFlinger mixes every client's tracks; a Worker holds proxies for
// the nodes, buffers and elements it made, and the page posts back its clock, ended sources, decoded
// buffers, element state with each event, and the video frames the Worker asks for.
import type { AudioData, AudioGain, AudioNodeLike, AudioOut, AudioPcm, AudioSource } from "../android/audio-output.ts";
import type { Handler, MediaElement } from "../android/mediaplayer.ts";

type Command =
  | { op: "gain" | "source" | "disconnect" | "free" | "resume"; id: number }
  | { op: "buffer"; id: number; rate: number; channels: Float32Array<ArrayBuffer>[] }
  | { op: "decode"; id: number; bytes: ArrayBuffer }
  | { op: "set"; id: number; key: "gain" | "rate" | "loop" | "buffer"; value: number }
  | { op: "connect"; id: number; to: number }
  | { op: "start"; id: number; when: number; offset: number }
  | { op: "stop"; id: number; when?: number }
  | { op: "element" | "pause" | "load" | "frame"; id: number }
  | { op: "play"; id: number; call: number }
  | { op: "prop"; id: number; key: Prop; value: Props[Prop] };
type Props = { preload: string; loop: boolean; volume: number; src: string; playbackRate: number; preservesPitch: boolean; currentTime: number };
type Prop = keyof Props;
/** an element's playback state, as of `seen` commands on the port */
type Shown = { paused: boolean; time: number; at: number; rate: number; duration: number; videoWidth: number; videoHeight: number;
  readyState: number; error: number; seen: number };
type Media = { op: "media"; id: number; event: string; state: Shown } | { op: "frame"; id: number; frame: VideoFrame }
  | { op: "played"; call: number; error?: string };
type Clock = { time: number; at: number; state: AudioContextState; sampleRate: number; outputLatency: number; baseLatency: number };
type Notice = { op: "clock" } | { op: "ended"; id: number } | { op: "decoded"; id: number; length: number; duration: number } | { op: "failed"; id: number };
type Reply = Notice & { clock: Clock };

const wallTime = () => performance.timeOrigin + performance.now();
const DESTINATION = 0;

/** a Worker's AudioOut and media elements over `port`; the page creates its context at the first command */
export function sendMedia(port: MessagePort): { audio: AudioOut; createElement: () => MediaElement } {
  let next = DESTINATION + 1, sent = 0, closed = false;
  let clock: Clock = { time: 0, at: 0, state: "suspended", sampleRate: 0, outputLatency: 0, baseLatency: 0 }, shownTime = 0;
  const sources = new Map<number, Source>(), decodes = new Map<number, ReturnType<typeof Promise.withResolvers<AudioData>>>();
  const freed = new FinalizationRegistry<number>(id => post({ op: "free", id }));
  const post = (command: Command) => { if (!closed) { sent++; port.postMessage(command); } };
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
    readonly length: number; readonly sampleRate: number;
    readonly channels: Float32Array<ArrayBuffer>[];
    constructor(count: number, length: number, sampleRate: number) {
      this.length = length; this.sampleRate = sampleRate;
      this.channels = Array.from({ length: count }, () => new Float32Array(length));
    }
    get duration() { return this.length / this.sampleRate; }
    getChannelData(channel: number) { return this.channels[channel]; }
  }
  const elements = new Map<number, WeakRef<Element>>(), plays = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  const handled = new Set(["play", "pause", "ended", "error", "loadedmetadata", "seeked"]);
  class Element implements MediaElement {
    readonly id = next++;
    onplay: Handler = null; onpause: Handler = null; onended: Handler = null; onerror: Handler = null; onloadedmetadata: Handler = null; onseeked: Handler = null;
    shown: Shown = { paused: true, time: 0, at: 0, rate: 1, duration: NaN, videoWidth: 0, videoHeight: 0, readyState: 0, error: 0, seen: 0 };
    /** the commands sent when this proxy last changed its own state: older page state is stale */
    wrote = 0;
    shows: ((frame: VideoFrame) => void)[] = [];
    #props: Omit<Props, "currentTime"> = { preload: "auto", loop: false, volume: 1, src: "", playbackRate: 1, preservesPitch: true };
    constructor() { post({ op: "element", id: this.id }); elements.set(this.id, new WeakRef(this)); freed.register(this, this.id); }
    #set<K extends Exclude<Prop, "currentTime">>(key: K, value: Props[K]) { this.#props[key] = value; post({ op: "prop", id: this.id, key, value }); }
    get preload() { return this.#props.preload; } set preload(v) { this.#set("preload", v); }
    get loop() { return this.#props.loop; } set loop(v) { this.#set("loop", v); }
    get volume() { return this.#props.volume; } set volume(v) { this.#set("volume", v); }
    get src() { return this.#props.src; } set src(v) { this.#set("src", v); }
    get preservesPitch() { return this.#props.preservesPitch; } set preservesPitch(v) { this.#set("preservesPitch", v); }
    get playbackRate() { return this.#props.playbackRate; } set playbackRate(v) { this.#hold(); this.shown.rate = v; this.#set("playbackRate", v); }
    get currentTime() {
      const s = this.shown;
      if (s.paused || s.readyState < 3) return s.time;
      const time = s.time + (wallTime() - s.at) / 1000 * s.rate, end = s.duration || Infinity;
      return this.loop ? time % end : Math.min(end, time);
    }
    set currentTime(v) { this.#hold(); this.shown.time = v; post({ op: "prop", id: this.id, key: "currentTime", value: v }); this.wrote = sent; }
    get paused() { return this.shown.paused; }
    get duration() { return this.shown.duration; }
    get videoWidth() { return this.shown.videoWidth; }
    get videoHeight() { return this.shown.videoHeight; }
    get readyState() { return this.shown.readyState; }
    get error() { return this.shown.error ? { code: this.shown.error } : null; }
    /** fix the extrapolated position before a local change of state */
    #hold() { this.shown.time = this.currentTime; this.shown.at = wallTime(); }
    play() {
      const call = next++, play = Promise.withResolvers<void>();
      plays.set(call, play); this.#hold(); this.shown.paused = false;
      post({ op: "play", id: this.id, call }); this.wrote = sent;
      return play.promise;
    }
    pause() { this.#hold(); this.shown.paused = true; post({ op: "pause", id: this.id }); this.wrote = sent; }
    load() { post({ op: "load", id: this.id }); }
    nextFrame(show: (frame: VideoFrame) => void) { if (this.shows.push(show) === 1) post({ op: "frame", id: this.id }); }
  }
  function media(data: Media): void {
    if (data.op === "played") {
      const play = plays.get(data.call);
      plays.delete(data.call);
      if (data.error) play?.reject(new DOMException("play() failed", data.error)); else play?.resolve();
      return;
    }
    const el = elements.get(data.id)?.deref();
    if (data.op === "frame") {
      const shows = el?.shows.splice(0) ?? [];
      if (!shows.length) data.frame.close();
      shows.forEach((show, i) => show(i === shows.length - 1 ? data.frame : data.frame.clone()));
    } else if (el) {
      if (data.state.seen >= el.wrote) el.shown = data.state;
      if (handled.has(data.event)) el[`on${data.event}` as "onplay"]?.(new Event(data.event));
    }
  }
  port.onmessage = ({ data }: MessageEvent<Reply | Media>) => {
    if ("clock" in data) clock = data.clock; else { media(data); return; }
    if (data.op === "ended") { const source = sources.get(data.id); sources.delete(data.id); source?.onended?.(new Event("ended")); }
    else if (data.op === "decoded" || data.op === "failed") {
      const decode = decodes.get(data.id);
      decodes.delete(data.id);
      if (data.op === "failed") decode?.reject(new DOMException("Unable to decode audio data", "EncodingError"));
      else if (decode) { const buffer = { length: data.length, duration: data.duration }; ids.set(buffer, data.id); freed.register(buffer, data.id); decode.resolve(buffer); }
    }
  };
  const destination = { id: DESTINATION, connect: () => { throw new Error("the destination has no outputs"); }, disconnect() {} };
  const audio: AudioOut = {
    // the page's clock runs behind the wall clock this extrapolates with: a later report must not turn the time back
    get currentTime() { return shownTime = Math.max(shownTime, clock.state === "running" ? clock.time + Math.max(0, wallTime() - clock.at) / 1000 : clock.time); },
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
  return { audio, createElement: () => new Element() };
}

let shared: AudioContext | undefined;
const waiting = new Set<(context: AudioContext) => void>();
/** the page's context, created by the first process to play; every process then follows its clock */
function sharedContext(): AudioContext {
  if (!shared) { shared = new AudioContext(); for (const attach of waiting) attach(shared); waiting.clear(); }
  return shared;
}
const EVENTS = ["play", "pause", "ended", "error", "loadedmetadata", "seeked", "timeupdate", "ratechange", "durationchange", "resize", "playing", "waiting"];
/** play one process's graph on the page's context and its media elements; closing stops what it still sounds */
export function receiveMedia(port: MessagePort): () => void {
  const objects = new Map<number, AudioNode | AudioBuffer>(), playing = new Set<AudioBufferSourceNode>(), elements = new Map<number, HTMLVideoElement>();
  let context: AudioContext | undefined, closed = false, seen = 0;
  const clock = (ctx: AudioContext): Clock => ({ time: ctx.currentTime, at: wallTime(), state: ctx.state, sampleRate: ctx.sampleRate,
    outputLatency: ctx.outputLatency || 0, baseLatency: ctx.baseLatency || 0 });
  const reply = (data: Notice) => { if (!closed && context) port.postMessage({ ...data, clock: clock(context) }); };
  const changed = () => reply({ op: "clock" });
  const attach = (ctx: AudioContext) => { context = ctx; ctx.addEventListener("statechange", changed); changed(); };
  if (shared) attach(shared); else waiting.add(attach);
  const node = <T extends AudioNode | AudioBuffer>(id: number) => objects.get(id) as T;
  const send = (data: Media, transfer: Transferable[] = []) => { if (!closed) port.postMessage(data, transfer); };
  const shown = (el: HTMLVideoElement): Shown => ({ paused: el.paused, time: el.currentTime, at: wallTime(), rate: el.playbackRate, duration: el.duration,
    videoWidth: el.videoWidth, videoHeight: el.videoHeight, readyState: el.readyState, error: el.error?.code ?? 0, seen });
  function element(id: number): void {
    const el = document.createElement("video");
    for (const event of EVENTS) el.addEventListener(event, () => send({ op: "media", id, event, state: shown(el) }));
    elements.set(id, el);
  }
  const unload = (el: HTMLVideoElement) => { el.pause(); el.removeAttribute("src"); el.load(); };
  function control(c: Command & { op: "element" | "pause" | "load" | "frame" | "play" | "prop" }, el: HTMLVideoElement): void {
    switch (c.op) {
      case "prop": (el[c.key] as Props[Prop]) = c.value; break;
      case "play": el.play().then(() => send({ op: "played", call: c.call }), (error: DOMException) => send({ op: "played", call: c.call, error: error.name })); break;
      case "pause": el.pause(); break;
      case "load": el.load(); break;
      case "frame": el.requestVideoFrameCallback(() => {
        if (elements.get(c.id) !== el) return;
        const frame = new VideoFrame(el);
        send({ op: "frame", id: c.id, frame }, [frame]);
      }); break;
    }
  }
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
      case "free": if (elements.has(c.id)) { unload(elements.get(c.id)!); elements.delete(c.id); } else if (!playing.has(objects.get(c.id) as AudioBufferSourceNode)) objects.delete(c.id); break;
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
    for (const el of elements.values()) unload(el);
    objects.clear(); playing.clear(); elements.clear(); port.close();
  }
  port.onmessage = ({ data }: MessageEvent<Command | { kind: "close" }>) => {
    if ("kind" in data) { close(); return; }
    seen++;
    try {
      if (data.op === "element") element(data.id);
      else if (data.op === "play" || data.op === "pause" || data.op === "load" || data.op === "frame" || data.op === "prop") control(data, elements.get(data.id)!);
      else run(data, context ?? sharedContext());
    } catch (error) { console.warn("[media]", data.op, error); }
  };
  return close;
}
