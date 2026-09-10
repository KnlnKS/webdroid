import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";
import { rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import type { JBuffer } from "../jvm/natives/jnio";

test("AudioTrack builder retains PCM format and consumes sliced native-order buffers", async () => {
  const formatBuilder = await newObj("android/media/AudioFormat$Builder");
  await vcall(formatBuilder, "setSampleRate", "(I)Landroid/media/AudioFormat$Builder;", 48000);
  await vcall(formatBuilder, "setChannelMask", "(I)Landroid/media/AudioFormat$Builder;", 12);
  await vcall(formatBuilder, "setEncoding", "(I)Landroid/media/AudioFormat$Builder;", 2);
  const format = await vcall(formatBuilder, "build", "()Landroid/media/AudioFormat;");
  const builder = await newObj("android/media/AudioTrack$Builder");
  await vcall(builder, "setAudioFormat", "(Landroid/media/AudioFormat;)Landroid/media/AudioTrack$Builder;", format);
  await vcall(builder, "setBufferSizeInBytes", "(I)Landroid/media/AudioTrack$Builder;", 8);
  await vcall(builder, "setSessionId", "(I)Landroid/media/AudioTrack$Builder;", 42);
  const track = await vcall(builder, "build", "()Landroid/media/AudioTrack;") as { queuedSec(): number; push(samples: Int16Array, frames: number): void; state: number };
  expect(await vcall(track, "getSampleRate", "()I")).toBe(48000);
  expect(await vcall(track, "getChannelCount", "()I")).toBe(2);
  expect(await vcall(track, "getAudioSessionId", "()I")).toBe(42);
  expect(await vcall(track, "getBufferSizeInFrames", "()I")).toBe(2);
  track.queuedSec = () => 0;
  const received: number[][] = [];
  track.push = (samples, frames) => { received.push([...samples]); expect(frames).toBe(1); };
  const data = new Int8Array([99, 0, -128, -1, 127, 33]);
  const buffer = rt.link("java/nio/ByteBuffer").ctor[mangleMethod("wrap", "([B)Ljava/nio/ByteBuffer;")](data.subarray(1, 5)) as JBuffer;
  expect(await vcall(track, "write", "(Ljava/nio/ByteBuffer;II)I", buffer, 4, 1)).toBe(4);
  expect(received).toEqual([[-32768, 32767]]);
  expect(buffer.pos).toBe(4);
  expect(await vcall(track, "write", "(Ljava/nio/ByteBuffer;II)I", buffer, 1, 1)).toBe(-2);
  buffer.pos = 0;
  track.queuedSec = () => 1;
  expect(await vcall(track, "write", "(Ljava/nio/ByteBuffer;II)I", buffer, 4, 1)).toBe(0);
  expect(buffer.pos).toBe(0);
  track.state = 0;
  expect(await vcall(track, "write", "(Ljava/nio/ByteBuffer;II)I", buffer, 4, 1)).toBe(-3);
});

test("AudioTrack buffers before play, freezes the clock on pause, and discards flushed audio", async () => {
  let now = 0;
  const starts: [number, number][] = [];
  let stopped = 0;
  const context = {
    get currentTime() { return now; },
    resume: async () => {},
    createBuffer: (channels: number, length: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, getChannelData: (channel: number) => data[channel] };
    },
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createBufferSource: () => ({ connect() {}, disconnect() {}, start(time: number, offset: number) { starts.push([time, offset]); }, stop() { stopped++; } }),
  } as unknown as AudioContext;
  const track = await newObj("android/media/AudioTrack", "(IIIIII)V", 3, 8000, 4, 2, 1600, 1) as { ctx(): AudioContext; push(samples: Int16Array, frames: number): void };
  track.ctx = () => context;
  track.push(new Int16Array(800), 800);
  expect(starts).toEqual([]);
  expect(await vcall(track, "getPlaybackHeadPosition", "()I")).toBe(0);
  await vcall(track, "play", "()V");
  expect(starts).toEqual([[0.02, 0]]);
  now = 0.07;
  expect(await vcall(track, "getPlaybackHeadPosition", "()I")).toBe(400);
  await vcall(track, "pause", "()V");
  expect(stopped).toBe(1);
  now = 1;
  expect(await vcall(track, "getPlaybackHeadPosition", "()I")).toBe(400);
  await vcall(track, "play", "()V");
  expect(starts[1][0]).toBe(1.02);
  expect(starts[1][1]).toBeCloseTo(0.05);
  await vcall(track, "stop", "()V");
  expect(await vcall(track, "getPlaybackHeadPosition", "()I")).toBe(0);
  now = 1.03;
  expect(await vcall(track, "getPlaybackHeadPosition", "()I")).toBe(0);
  await vcall(track, "play", "()V");
  expect(await vcall(track, "getPlaybackHeadPosition", "()I")).toBe(0);
  now = 1.04;
  expect(await vcall(track, "getPlaybackHeadPosition", "()I")).toBeGreaterThan(0);
  await vcall(track, "pause", "()V");
  await vcall(track, "flush", "()V");
  expect(await vcall(track, "getPlaybackHeadPosition", "()I")).toBe(0);
  await vcall(track, "play", "()V");
  expect(starts).toHaveLength(2);
  await vcall(track, "release", "()V");
});

test("blocking PCM buffer writes wait for capacity and retain the unconsumed position", async () => {
  const track = await newObj("android/media/AudioTrack", "(IIIIII)V", 3, 8000, 12, 2, 4, 1) as { queuedSec(): number; push(samples: Int16Array, frames: number): void };
  let full = false, calls = 0, finished = false;
  track.queuedSec = () => full ? 1 : 0;
  track.push = () => { full = true; calls++; };
  const buffer = rt.link("java/nio/ByteBuffer").ctor[mangleMethod("wrap", "([B)Ljava/nio/ByteBuffer;")](new Int8Array(8)) as JBuffer;
  const write = vcall(track, "write", "(Ljava/nio/ByteBuffer;II)I", buffer, 8, 0).then(n => { finished = true; return n; });
  await Bun.sleep(15);
  expect(buffer.pos).toBe(4);
  expect(calls).toBe(1);
  expect(finished).toBe(false);
  full = false;
  expect(await write).toBe(8);
  expect(buffer.pos).toBe(8);
  expect(calls).toBe(2);
});
