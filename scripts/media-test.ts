import { BASE_URL } from "../tests/e2e/lib/util";
import { launchBrowser } from "../tests/e2e/drivers/webdroid";
import type { Runtime } from "../src/jvm/runtime";
import type { newObj, vcall } from "../src/jvm/natives/jlang";

declare const wd: { rt: Runtime; newObj: typeof newObj; vcall: typeof vcall; scall: (cls: string, name: string, desc: string, ...args: unknown[]) => Promise<unknown> };
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.goto(BASE_URL);
  await page.waitForFunction(() => typeof wd !== "undefined");
  const result = await page.evaluate(async (videoCodec: string) => {
    const check = (ok: boolean, message: string) => { if (!ok) throw new Error(message); };
    const pause = () => new Promise(resolve => setTimeout(resolve, 5));
    const codec = async (mime: string) => wd.scall("android/media/MediaCodec", "createDecoderByType", "(Ljava/lang/String;)Landroid/media/MediaCodec;", mime);
    const set = async (format: unknown, key: string, value: number) => wd.vcall(format, "setInteger", "(Ljava/lang/String;I)V", key, value);
    const chunks: EncodedVideoChunk[] = [];
    const encoder = new VideoEncoder({ output: chunk => chunks.push(chunk), error: error => { throw error; } });
    const mime = videoCodec.startsWith("avc") ? "video/avc" : "video/x-vnd.on2.vp8";
    encoder.configure({ codec: videoCodec, width: 16, height: 16, bitrate: 100000, framerate: 30, latencyMode: "realtime", avc: videoCodec.startsWith("avc") ? { format: "annexb" } : undefined });
    const canvas = new OffscreenCanvas(16, 16), context = canvas.getContext("2d");
    if (!context) throw new Error("2D canvas unavailable");
    for (const [i, color] of ["red", "lime", "blue"].entries()) {
      context.fillStyle = color; context.fillRect(0, 0, 16, 16);
      const frame = new VideoFrame(canvas, { timestamp: i * 33333 }); encoder.encode(frame, { keyFrame: true }); frame.close();
    }
    await encoder.flush(); encoder.close();
    const texture = await wd.newObj("android/graphics/SurfaceTexture", "(I)V", 0);
    const surface = await wd.newObj("android/view/Surface", "(Landroid/graphics/SurfaceTexture;)V", texture);
    const colors: number[][] = [];
    for (const callbackMode of [false, true]) {
      const decoder = await codec(mime);
      const format = await wd.scall("android/media/MediaFormat", "createVideoFormat", "(Ljava/lang/String;II)Landroid/media/MediaFormat;", mime, 16, 16);
      await set(format, "max-input-size", 4096);
      const inputs: number[] = [], outputs: { index: number; flags: number }[] = [];
      if (callbackMode) {
        class Callback extends (wd.rt.link("java/lang/Object").ctor) {}
        wd.rt.register({ name: "webdroid/CodecTestCallback", ctor: Callback, sup: "android/media/MediaCodec$Callback", methods: {
          "onInputBufferAvailable(Landroid/media/MediaCodec;I)V": (_codec: unknown, index: number) => { inputs.push(index); },
          "onOutputBufferAvailable(Landroid/media/MediaCodec;ILandroid/media/MediaCodec$BufferInfo;)V": (_codec: unknown, index: number, info: { flags: number }) => { outputs.push({ index, flags: info.flags }); },
          "onOutputFormatChanged(Landroid/media/MediaCodec;Landroid/media/MediaFormat;)V": () => {},
          "onError(Landroid/media/MediaCodec;Landroid/media/MediaCodec$CodecException;)V": (_codec: unknown, error: { msg: string }) => { throw new Error(error.msg); },
        } });
        const callback = new (wd.rt.link("webdroid/CodecTestCallback").ctor)();
        await wd.vcall(decoder, "setCallback", "(Landroid/media/MediaCodec$Callback;)V", callback);
      }
      await wd.vcall(decoder, "configure", "(Landroid/media/MediaFormat;Landroid/view/Surface;Landroid/media/MediaCrypto;I)V", format, surface, null, 0);
      await wd.vcall(decoder, "start", "()V");
      for (let i = 0; i <= chunks.length; i++) {
        const deadline = performance.now() + 2000;
        while (callbackMode && !inputs.length && performance.now() < deadline) await pause();
        const index = callbackMode ? inputs.shift() : await wd.vcall(decoder, "dequeueInputBuffer", "(J)I", 100000n);
        check(typeof index === "number" && index >= 0, "input buffer was not delivered");
        const input = await wd.vcall(decoder, "getInputBuffer", "(I)Ljava/nio/ByteBuffer;", index);
        const chunk = chunks[i];
        if (chunk) { const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); new Uint8Array(input.ab).set(bytes); }
        await wd.vcall(decoder, "queueInputBuffer", "(IIIJI)V", index, 0, chunk?.byteLength ?? 0, BigInt(chunk?.timestamp ?? 100000), chunk ? 1 : 4);
      }
      const info = await wd.newObj("android/media/MediaCodec$BufferInfo");
      let ended = false, frames = 0;
      const deadline = performance.now() + 3000;
      while (!ended && performance.now() < deadline) {
        const event = callbackMode ? outputs.shift() : { index: await wd.vcall(decoder, "dequeueOutputBuffer", "(Landroid/media/MediaCodec$BufferInfo;J)I", info, 100000n), flags: info.flags };
        if (!event || event.index < 0) { await pause(); continue; }
        ended = !!(event.flags & 4);
        await wd.vcall(decoder, "releaseOutputBuffer", "(IZ)V", event.index, 1);
        if (!ended) {
          context.drawImage(surface.surf.present, 0, 0);
          const pixel = [...context.getImageData(8, 8, 1, 1).data].slice(0, 3);
          check(pixel[frames] > 200 && pixel.filter((_, index) => index !== frames).every(v => v < 40), "decoded color mismatch: " + pixel);
          colors.push(pixel); frames++;
        }
      }
      check(ended && frames === chunks.length, "decoded video did not finish");
      await wd.vcall(decoder, "release", "()V");
    }
    await wd.vcall(surface, "release", "()V"); await wd.vcall(texture, "release", "()V");
    const audioChunks: EncodedAudioChunk[] = [];
    let description: Uint8Array | undefined;
    const audioEncoder = new AudioEncoder({ error: error => { throw error; }, output: (chunk, metadata) => {
      audioChunks.push(chunk);
      const data = metadata?.decoderConfig?.description;
      if (data && ArrayBuffer.isView(data)) description = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else if (data) description = new Uint8Array(data);
    } });
    audioEncoder.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 1, bitrate: 64000 });
    const samples = Float32Array.from({ length: 960 }, (_, i) => Math.sin(i * Math.PI * 2 * 440 / 48000) / 2);
    const audio = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfChannels: 1, numberOfFrames: samples.length, timestamp: 0, data: samples });
    audioEncoder.encode(audio); audio.close(); await audioEncoder.flush(); audioEncoder.close();
    const decoder = await codec("audio/opus");
    const format = await wd.scall("android/media/MediaFormat", "createAudioFormat", "(Ljava/lang/String;II)Landroid/media/MediaFormat;", "audio/opus", 48000, 1);
    if (description) {
      const buffer = await wd.scall("java/nio/ByteBuffer", "wrap", "([B)Ljava/nio/ByteBuffer;", new Int8Array(description));
      await wd.vcall(format, "setByteBuffer", "(Ljava/lang/String;Ljava/nio/ByteBuffer;)V", "csd-0", buffer);
    }
    await wd.vcall(decoder, "configure", "(Landroid/media/MediaFormat;Landroid/view/Surface;Landroid/media/MediaCrypto;I)V", format, null, null, 0);
    await wd.vcall(decoder, "start", "()V");
    for (let i = 0; i <= audioChunks.length; i++) {
      const index = await wd.vcall(decoder, "dequeueInputBuffer", "(J)I", 100000n), chunk = audioChunks[i];
      const buffer = await wd.vcall(decoder, "getInputBuffer", "(I)Ljava/nio/ByteBuffer;", index);
      if (chunk) { const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes); new Uint8Array(buffer.ab).set(bytes); }
      await wd.vcall(decoder, "queueInputBuffer", "(IIIJI)V", index, 0, chunk?.byteLength ?? 0, BigInt(chunk?.timestamp ?? 20000), chunk ? 1 : 4);
    }
    let energy = 0, count = 0, ended = false;
    const info = await wd.newObj("android/media/MediaCodec$BufferInfo"), deadline = performance.now() + 3000;
    while (!ended && performance.now() < deadline) {
      const index = await wd.vcall(decoder, "dequeueOutputBuffer", "(Landroid/media/MediaCodec$BufferInfo;J)I", info, 100000n);
      if (index < 0) continue;
      ended = !!(info.flags & 4);
      const buffer = await wd.vcall(decoder, "getOutputBuffer", "(I)Ljava/nio/ByteBuffer;", index);
      if (buffer) for (let i = 0; i < info.size; i += 2) { const value = buffer.dv.getInt16(i, true) / 32768; energy += value * value; count++; }
      await wd.vcall(decoder, "releaseOutputBuffer", "(IZ)V", index, 0);
    }
    await wd.vcall(decoder, "release", "()V");
    const rms = Math.sqrt(energy / count); check(ended && count >= 960 && rms > 0.2 && rms < 0.5, "decoded audio mismatch");
    return { videoCodec, colors, audioSamples: count, rms };
  }, process.env.MEDIA_CODEC ?? "vp8");
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
