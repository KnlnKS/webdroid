// Web Audio and media elements for a process Worker, which has neither. The page's one AudioContext
// mixes every process's graph, as AudioFlinger mixes every client's tracks; a Worker holds proxies for
// the nodes, buffers and elements it made, and the page tells it its clock, ended sources, element
// state with each event, and the video frames the Worker asks for.
import type { AudioData, AudioGain, AudioNodeLike, AudioOut, AudioPcm, AudioSource } from "../android/audio-output.ts";
import type { Handler, MediaElement } from "../android/mediaplayer.ts";
import { duplex, methodsOf } from "./rpc.ts";

type Props = { preload: string; loop: boolean; volume: number; src: string; playbackRate: number; preservesPitch: boolean; currentTime: number };
type Prop = keyof Props;
/** an element's playback state, as of `seen` commands on the port */
type Shown = { paused: boolean; time: number; at: number; rate: number; duration: number; videoWidth: number; videoHeight: number;
  readyState: number; error: number; seen: number };
type Clock = { time: number; at: number; state: AudioContextState; sampleRate: number; outputLatency: number; baseLatency: number };
/** what a Worker has the page's context and elements do, naming its nodes, buffers and elements by the ids it gives them */
type MediaCalls = {
  gain(id: number): void; source(id: number): void; buffer(id: number, rate: number, channels: Float32Array<ArrayBuffer>[]): void;
  /** the decoded buffer's length and duration */
  decode(id: number, bytes: ArrayBuffer): Promise<AudioData>;
  /** a node's parameter, or a source's loop or buffer (DESTINATION: none) */
  set(id: number, key: "gain" | "rate" | "loop" | "buffer", value: number): void;
  connect(id: number, to: number): void; disconnect(id: number): void;
  start(id: number, when: number, offset: number): void; stop(id: number, when?: number): void;
  free(id: number): void; resume(): void;
  element(id: number): void; prop(id: number, key: Prop, value: Props[Prop]): void;
  play(id: number): Promise<void>; pause(id: number): void; load(id: number): void; frame(id: number): void;
};
const mediaMethods = methodsOf<MediaCalls>()(["gain", "source", "buffer", "decode", "set", "connect", "disconnect", "start", "stop", "free", "resume",
  "element", "prop", "play", "pause", "load", "frame"]);
/** what the Worker hears of them */
type MediaView = { clock(clock: Clock): void; ended(id: number): void; media(id: number, event: string, state: Shown): void; frame(id: number, frame: VideoFrame): void };
const viewMethods = methodsOf<MediaView>()(["clock", "ended", "media", "frame"]);

const wallTime = () => performance.timeOrigin + performance.now();
const DESTINATION = 0;

/** a Worker's AudioOut and media elements over `port`; the page creates its context at the first command */
export function sendMedia(port: MessagePort): { audio: AudioOut; createElement: () => MediaElement; close(): void } {
  let next = DESTINATION + 1, sent = 0, closed = false;
  let clock: Clock = { time: 0, at: 0, state: "suspended", sampleRate: 0, outputLatency: 0, baseLatency: 0 }, shownTime = 0;
  const sources = new Map<number, Source>(), elements = new Map<number, WeakRef<Element>>();
  const handled = new Set(["ended", "error", "loadedmetadata", "seeked"]);
  const page = duplex<MediaView, MediaCalls>(port, {
    clock: value => { clock = value; },
    ended: id => { const source = sources.get(id); sources.delete(id); source?.onended?.(new Event("ended")); },
    media: (id, event, state) => {
      const el = elements.get(id)?.deref();
      if (!el) return;
      if (state.seen >= el.wrote) el.shown = state;
      if (handled.has(event)) el[`on${event}` as "onended"]?.(new Event(event));
    },
    frame: (id, frame) => {
      const shows = elements.get(id)?.deref()?.shows.splice(0) ?? [];
      if (!shows.length) frame.close();
      shows.forEach((show, i) => show(i === shows.length - 1 ? frame : frame.clone()));
    },
  }, mediaMethods, { notifications: mediaMethods.filter(name => name !== "decode" && name !== "play"),
    transfer: { decode: (_id, bytes) => [bytes] }, onClose: () => { closed = true; } });
  /** a command, which the page's element state counts once it has run it */
  const send = <T>(command: (page: MediaCalls) => T): T | undefined => { if (closed) return undefined; sent++; return command(page.endpoint); };
  const freed = new FinalizationRegistry<number>(id => send(page => page.free(id)));
  const param = (id: number, key: "gain" | "rate", value: number) => {
    let current = value;
    return { get value() { return current; }, set value(v: number) { current = v; send(page => page.set(id, key, v)); } };
  };
  class Node implements AudioNodeLike {
    readonly id = next++;
    constructor(kind: "gain" | "source") { send(page => page[kind](this.id)); freed.register(this, this.id); }
    connect(node: AudioNodeLike) { send(page => page.connect(this.id, (node as Node).id)); return node; }
    disconnect() { send(page => page.disconnect(this.id)); }
  }
  class Gain extends Node implements AudioGain { readonly gain = param(this.id, "gain", 1); constructor() { super("gain"); } }
  class Source extends Node implements AudioSource {
    readonly playbackRate = param(this.id, "rate", 1);
    onended: ((event: Event) => void) | null = null;
    #buffer: AudioData | null = null; #loop = false;
    constructor() { super("source"); }
    get buffer() { return this.#buffer; }
    set buffer(data: AudioData | null) { this.#buffer = data; send(page => page.set(this.id, "buffer", data ? upload(data) : DESTINATION)); }
    get loop() { return this.#loop; }
    set loop(on: boolean) { this.#loop = on; send(page => page.set(this.id, "loop", +on)); }
    start(when = 0, offset = 0) { sources.set(this.id, this); send(page => page.start(this.id, when, offset)); }
    stop(when?: number) { send(page => page.stop(this.id, when)); }
  }
  const ids = new WeakMap<AudioData, number>();
  /** a created buffer reaches the page when a source first plays it */
  function upload(data: AudioData): number {
    let id = ids.get(data);
    if (id === undefined) {
      const pcm = data as Pcm, buffer = id = next++;
      ids.set(data, id);
      send(page => page.buffer(buffer, pcm.sampleRate, pcm.channels));
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
  class Element implements MediaElement {
    readonly id = next++;
    onended: Handler = null; onerror: Handler = null; onloadedmetadata: Handler = null; onseeked: Handler = null;
    shown: Shown = { paused: true, time: 0, at: 0, rate: 1, duration: NaN, videoWidth: 0, videoHeight: 0, readyState: 0, error: 0, seen: 0 };
    /** the commands sent when this proxy last changed its own state: older page state is stale */
    wrote = 0;
    shows: ((frame: VideoFrame) => void)[] = [];
    #props: Omit<Props, "currentTime"> = { preload: "auto", loop: false, volume: 1, src: "", playbackRate: 1, preservesPitch: true };
    constructor() { send(page => page.element(this.id)); elements.set(this.id, new WeakRef(this)); freed.register(this, this.id); }
    #set<K extends Exclude<Prop, "currentTime">>(key: K, value: Props[K]) { this.#props[key] = value; send(page => page.prop(this.id, key, value)); }
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
    set currentTime(v) { this.#hold(); this.shown.time = v; send(page => page.prop(this.id, "currentTime", v)); this.wrote = sent; }
    get paused() { return this.shown.paused; }
    get duration() { return this.shown.duration; }
    get videoWidth() { return this.shown.videoWidth; }
    get videoHeight() { return this.shown.videoHeight; }
    get readyState() { return this.shown.readyState; }
    get error() { return this.shown.error ? { code: this.shown.error } : null; }
    /** fix the extrapolated position before a local change of state */
    #hold() { this.shown.time = this.currentTime; this.shown.at = wallTime(); }
    play() {
      this.#hold(); this.shown.paused = false;
      const played = send(page => page.play(this.id)) ?? new Promise<void>(() => {});
      this.wrote = sent;
      return played;
    }
    pause() { this.#hold(); this.shown.paused = true; send(page => page.pause(this.id)); this.wrote = sent; }
    load() { send(page => page.load(this.id)); }
    nextFrame(show: (frame: VideoFrame) => void) { if (this.shows.push(show) === 1) send(page => page.frame(this.id)); }
  }
  const destination = { id: DESTINATION, connect: () => { throw new Error("the destination has no outputs"); }, disconnect() {} };
  const audio: AudioOut = {
    // the page's clock runs behind the wall clock this extrapolates with: a later report must not turn the time back
    get currentTime() { return shownTime = Math.max(shownTime, clock.state === "running" ? clock.time + Math.max(0, wallTime() - clock.at) / 1000 : clock.time); },
    get sampleRate() { return clock.sampleRate || 44100; },
    get outputLatency() { return clock.outputLatency; },
    get baseLatency() { return clock.baseLatency; },
    get state() { return closed ? "closed" : clock.state; },
    destination,
    resume: async () => { send(page => page.resume()); },
    close: async () => page.close(),
    createGain: () => new Gain(),
    createBufferSource: () => new Source(),
    createBuffer: (channels, length, rate) => new Pcm(channels, length, rate),
    async decodeAudioData(bytes) {
      const id = next++, buffer = await (send(page => page.decode(id, bytes)) ?? new Promise<AudioData>(() => {}));
      ids.set(buffer, id); freed.register(buffer, id);
      return buffer;
    },
  };
  return { audio, createElement: () => new Element(), close: page.close };
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
  const tell = (notice: (worker: MediaView) => void) => { if (!closed) notice(worker.endpoint); };
  const changed = () => { const ctx = context; if (ctx) tell(worker => worker.clock({ time: ctx.currentTime, at: wallTime(), state: ctx.state,
    sampleRate: ctx.sampleRate, outputLatency: ctx.outputLatency || 0, baseLatency: ctx.baseLatency || 0 })); };
  const attach = (ctx: AudioContext) => { context = ctx; ctx.addEventListener("statechange", changed); changed(); };
  const ctx = () => context ?? sharedContext();
  const node = <T extends AudioNode | AudioBuffer>(id: number) => objects.get(id) as T;
  const shown = (el: HTMLVideoElement): Shown => ({ paused: el.paused, time: el.currentTime, at: wallTime(), rate: el.playbackRate, duration: el.duration,
    videoWidth: el.videoWidth, videoHeight: el.videoHeight, readyState: el.readyState, error: el.error?.code ?? 0, seen });
  const unload = (el: HTMLVideoElement) => { el.pause(); el.removeAttribute("src"); el.load(); };
  const commands: MediaCalls = {
    gain: id => { objects.set(id, ctx().createGain()); },
    source: id => {
      const source = ctx().createBufferSource();
      source.onended = () => { playing.delete(source); changed(); tell(worker => worker.ended(id)); };
      objects.set(id, source);
    },
    buffer: (id, rate, channels) => {
      const buffer = ctx().createBuffer(channels.length, channels[0].length, rate);
      channels.forEach((data, channel) => buffer.copyToChannel(data, channel));
      objects.set(id, buffer);
    },
    decode: async (id, bytes) => {
      const buffer = await ctx().decodeAudioData(bytes).finally(changed);
      objects.set(id, buffer);
      return { length: buffer.length, duration: buffer.duration };
    },
    set: (id, key, value) => {
      if (key === "gain") node<GainNode>(id).gain.value = value;
      else if (key === "rate") node<AudioBufferSourceNode>(id).playbackRate.value = value;
      else if (key === "loop") node<AudioBufferSourceNode>(id).loop = !!value;
      else node<AudioBufferSourceNode>(id).buffer = value === DESTINATION ? null : node<AudioBuffer>(value);
    },
    connect: (id, to) => { node<AudioNode>(id).connect(to === DESTINATION ? ctx().destination : node<AudioNode>(to)); },
    disconnect: id => { node<AudioNode>(id).disconnect(); },
    start: (id, when, offset) => { const source = node<AudioBufferSourceNode>(id); playing.add(source); source.start(when, offset); },
    stop: (id, when) => { node<AudioBufferSourceNode>(id).stop(when); },
    // a source stays reachable until it ends, so that closing can still silence it
    free: id => {
      const el = elements.get(id);
      if (el) { unload(el); elements.delete(id); } else if (!playing.has(objects.get(id) as AudioBufferSourceNode)) objects.delete(id);
    },
    resume: () => { void ctx().resume(); },
    element: id => {
      const el = document.createElement("video");
      for (const event of EVENTS) el.addEventListener(event, () => tell(worker => worker.media(id, event, shown(el))));
      elements.set(id, el);
    },
    prop: (id, key, value) => { (elements.get(id)![key] as Props[Prop]) = value; },
    play: async id => elements.get(id)!.play(),
    pause: id => { elements.get(id)!.pause(); },
    load: id => { elements.get(id)!.load(); },
    frame: id => {
      const el = elements.get(id)!;
      el.requestVideoFrameCallback(() => { if (elements.get(id) === el) tell(worker => worker.frame(id, new VideoFrame(el))); });
    },
  };
  // a command that fails is reported, and the next still runs
  const counted = Object.fromEntries(Object.entries(commands as unknown as Record<string, (...args: unknown[]) => unknown>).map(([name, command]) => [name, (...args: unknown[]) => {
    seen++;
    try { return command(...args); } catch (error) { console.warn("[media]", name, error); }
  }])) as MediaCalls;
  const worker = duplex<MediaCalls, MediaView>(port, counted, viewMethods, { notifications: viewMethods, transfer: { frame: (_id, frame) => [frame] },
    onClose: () => {
      closed = true;
      waiting.delete(attach);
      context?.removeEventListener("statechange", changed);
      for (const source of playing) { source.onended = null; source.stop(); }
      for (const object of objects.values()) if (object instanceof AudioNode) object.disconnect();
      for (const el of elements.values()) unload(el);
      objects.clear(); playing.clear(); elements.clear();
    } });
  if (shared) attach(shared); else waiting.add(attach);
  return worker.close;
}
