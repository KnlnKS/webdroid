// Queue submission and synchronization. One queue executes in submission order, so semaphores order
// nothing on the device and only carry completion to the host: a fence or semaphore a submit signals
// resolves once the device has done its work and host-visible memory it wrote holds the results.
// Images an AHardwareBuffer backs give it their pixels when released to the foreign queue family, and
// take its pixels when acquired from it with their contents kept.

import { mem } from "../mem.ts";
import { PTR, ldp, type HostFn } from "../host.ts";
import { queueFrame, bufferFrame } from "../hardwarebuffer.ts";
import { closeFd } from "../fd.ts";
import { fence, fenceOf, syncFileFd } from "../syncfile.ts";
import { struct, list, u64s, stU64 } from "../struct.ts";
import { handle, object, maybe, release } from "./handles.ts";
import { R, SYNC_FD } from "./instance.ts";
import { nd, BU, TU, type Device, type Image, type Buffer } from "./device.ts";
import { Replay, type CommandBuffer } from "./commands.ts";

/** a fence or semaphore: the work that signals it, once a submit has given it some */
interface Signal { work: Promise<void> | null; signaled: boolean }
const signal = (initial: boolean): Signal => ({ work: null, signaled: initial });
function arm(s: Signal, work: Promise<void>): void {
  s.signaled = false; s.work = work;
  void work.then(() => { if (s.work === work) s.signaled = true; });
}

const SubmitInfo = struct("sType:u32 pNext:ptr waits:u32 pWaits:ptr pWaitStages:ptr buffers:u32 pBuffers:ptr signals:u32 pSignals:ptr");
const FenceInfo = struct("sType:u32 pNext:ptr flags:u32");
const GetFd = struct("sType:u32 pNext:ptr semaphore:u64 handleType:u32");
const ImportFd = struct("sType:u32 pNext:ptr semaphore:u64 flags:u32 handleType:u32 fd:i32");

/** the canvas that turns textures into frames for the AHardwareBuffers they fill, by format */
const canvases = new Map<string, GPUCanvasContext>();
function publish(dev: Device, img: Image): void {
  const b = img.ahb!, format = img.format.gpu, key = `${format}`;
  let ctx = canvases.get(key);
  if (!ctx) {
    ctx = new OffscreenCanvas(b.width, b.height).getContext("webgpu") as GPUCanvasContext;
    canvases.set(key, ctx);
  }
  const canvas = ctx.canvas as OffscreenCanvas;
  if (canvas.width !== b.width || canvas.height !== b.height) { canvas.width = b.width; canvas.height = b.height; }
  ctx.configure({ device: dev.gpu, format: format === "rgba8unorm-srgb" ? "rgba8unorm" : format, usage: TU.COPY_DST, alphaMode: "premultiplied" });
  const enc = dev.gpu.createCommandEncoder();
  enc.copyTextureToTexture({ texture: img.texture }, { texture: ctx.getCurrentTexture() }, { width: b.width, height: b.height });
  dev.gpu.queue.submit([enc.finish()]);
  queueFrame(b, canvas.transferToImageBitmap());
}
function take(dev: Device, img: Image): void {
  const b = img.ahb!, queued = b.frame, frame = queued ?? bufferFrame(b);
  if (frame) dev.gpu.queue.copyExternalImageToTexture({ source: frame }, { texture: img.texture, premultipliedAlpha: true }, { width: b.width, height: b.height });
  if (frame !== queued) frame?.close();
}

/** host-visible buffers' bytes into their GPUBuffers */
function upload(dev: Device, buffers: Iterable<Buffer>): void {
  for (const b of buffers) dev.gpu.queue.writeBuffer(b.gpu, 0, mem.bytes(b.host, Math.ceil(b.size / 4) * 4));
}
/** copies of buffers the work wrote, read back into their guest bytes once it is done */
function readbacks(dev: Device, enc: GPUCommandEncoder, buffers: Iterable<Buffer>): (() => Promise<void>)[] {
  const out: (() => Promise<void>)[] = [];
  for (const b of buffers) {
    const size = Math.ceil(b.size / 4) * 4, staging = dev.gpu.createBuffer({ size, usage: BU.MAP_READ | BU.COPY_DST });
    enc.copyBufferToBuffer(b.gpu, 0, staging, 0, size);
    out.push(async () => {
      await staging.mapAsync(1);
      mem.write(b.host, new Uint8Array(staging.getMappedRange(), 0, b.size));
      staging.destroy();
    });
  }
  return out;
}

function submit(dev: Device, cbs: CommandBuffer[]): Promise<void> {
  const host = new Set<Buffer>(), written = new Set<Buffer>();
  for (const cb of cbs) { for (const b of cb.host) host.add(b); for (const b of cb.written) written.add(b); }
  upload(dev, host);
  const r = new Replay(dev);
  r.acquire = (img) => { if (img.ahb) { r.cut(); r.writePush(); dev.gpu.queue.submit(r.done.splice(0)); take(dev, img); } };
  for (const cb of cbs) for (const op of cb.ops) op(r);
  r.outside();
  const reads = readbacks(dev, r.enc, written);
  r.writePush();
  dev.gpu.queue.submit(r.finish());
  for (const img of r.released) if (img.ahb) publish(dev, img);
  return dev.gpu.queue.onSubmittedWorkDone().then(() => Promise.all(reads.map((f) => f()))).then(() => {});
}
const cbOf = (h: number) => object<{ cb: CommandBuffer }>(h).cb;

/** how long to wait, in ms, for a timeout in ns; UINT64_MAX is forever */
const waitMs = (ns: bigint) => ns >= 0xffffffffffffffffn ? Infinity : Number(ns / 1000000n);
async function until(works: Promise<void>[], all: boolean, ms: number): Promise<boolean> {
  const done = all ? Promise.all(works).then(() => true) : Promise.race(works).then(() => true);
  if (ms === Infinity) return done;
  return Promise.race([done, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

export const SYNC: Record<string, HostFn> = {
  vkQueueSubmit: (_c, a) => {
    const queue = a.p(), n = a.u(), infos = a.p(), fence = maybe<Signal>(nd(a)), dev = object<{ device: Device }>(queue).device;
    if (dev.lost) return R.DEVICE_LOST;
    let last: Promise<void> = Promise.resolve();
    for (const info of list(infos, n, SubmitInfo.size(), (at) => SubmitInfo.read(at))) {
      const cbs = list(info.pBuffers, info.buffers, PTR, (at) => cbOf(ldp(at)));
      try { last = submit(dev, cbs); }
      catch (e) { console.warn("[vulkan] vkQueueSubmit:", (e as Error).stack); return R.DEVICE_LOST; }
      for (const s of u64s(info.pSignals, info.signals)) arm(object<Signal>(s), last);
    }
    if (fence) arm(fence, last);
    return R.SUCCESS;
  },
  vkQueueWaitIdle: async (_c, a) => { const dev = object<{ device: Device }>(a.p()).device; await dev.gpu.queue.onSubmittedWorkDone(); return R.SUCCESS; },
  vkQueueBindSparse: () => R.FEATURE_NOT_PRESENT,

  vkCreateFence: (_c, a) => { a.p(); const info = FenceInfo.read(a.p()); a.p(); stU64(a.p(), handle(signal(!!(info.flags & 1)))); return R.SUCCESS; },
  vkDestroyFence: (_c, a) => { a.p(); release(nd(a)); },
  vkResetFences: (_c, a) => { a.p(); const n = a.u(); for (const h of u64s(a.p(), n)) { const f = object<Signal>(h); f.signaled = false; f.work = null; } return R.SUCCESS; },
  vkGetFenceStatus: (_c, a) => { a.p(); return object<Signal>(nd(a)).signaled ? R.SUCCESS : R.NOT_READY; },
  vkWaitForFences: async (_c, a) => {
    a.p(); const n = a.u(), fences = u64s(a.p(), n).map((h) => object<Signal>(h)), all = !!a.u(), ms = waitMs(a.ul());
    const pending = fences.filter((f) => !f.signaled);
    if (all ? !pending.length : pending.length < fences.length) return R.SUCCESS;
    // a fence no submit armed is signaled only by a later submit, which this thread waiting cannot make
    const works = pending.flatMap((f) => f.work ? [f.work] : []);
    if (!works.length || (all && works.length < pending.length)) return ms === Infinity ? R.DEVICE_LOST : R.TIMEOUT;
    return await until(works, all, ms) ? R.SUCCESS : R.TIMEOUT;
  },

  vkCreateSemaphore: (_c, a) => { a.p(); a.p(); a.p(); stU64(a.p(), handle(signal(false))); return R.SUCCESS; },
  vkDestroySemaphore: (_c, a) => { a.p(); release(nd(a)); },
  vkGetSemaphoreFdKHR: (_c, a) => {
    a.p(); const info = GetFd.read(a.p()), out = a.p();
    if (info.handleType !== SYNC_FD) return R.INVALID_EXTERNAL_HANDLE;
    const s = object<Signal>(info.semaphore);
    mem.st32(out, syncFileFd(fence(s.work ?? Promise.resolve())));
    s.work = null; s.signaled = false;                                           // exporting a sync fd unsignals the semaphore
    return R.SUCCESS;
  },
  // a sync fd of work already done may be -1; the semaphore owns the fd it takes
  vkImportSemaphoreFdKHR: (_c, a) => {
    a.p(); const info = ImportFd.read(a.p());
    const passed = info.fd === -1 ? null : fenceOf(info.fd);
    if (info.handleType !== SYNC_FD || info.fd !== -1 && !passed) return R.INVALID_EXTERNAL_HANDLE;
    const s = object<Signal>(info.semaphore);
    if (passed) { arm(s, passed.done); void closeFd(info.fd); }
    else { s.work = null; s.signaled = true; }
    return R.SUCCESS;
  },

  vkCreateEvent: (_c, a) => { a.p(); a.p(); a.p(); stU64(a.p(), handle({ set: false })); return R.SUCCESS; },
  vkDestroyEvent: (_c, a) => { a.p(); release(nd(a)); },
  vkGetEventStatus: (_c, a) => { a.p(); return object<{ set: boolean }>(nd(a)).set ? 3 : 4; },     // VK_EVENT_SET / VK_EVENT_RESET
  vkSetEvent: (_c, a) => { a.p(); object<{ set: boolean }>(nd(a)).set = true; return R.SUCCESS; },
  vkResetEvent: (_c, a) => { a.p(); object<{ set: boolean }>(nd(a)).set = false; return R.SUCCESS; },
  vkCmdSetEvent: () => {}, vkCmdResetEvent: () => {}, vkCmdWaitEvents: () => {},
};
