// Queue submission and synchronization. One queue executes in submission order, so semaphores order
// nothing on the device and only carry completion to the host: a fence or semaphore a submit signals
// resolves once the device has done its work and host-visible memory it wrote holds the results.

import { mem } from "../mem.ts";
import { PTR, ldp, type HostFn } from "../host.ts";
import { closeFd } from "../fd.ts";
import { fence, fenceOf, syncFileFd } from "../syncfile.ts";
import { struct, list, u64s, stU64 } from "../struct.ts";
import { R, SYNC_FD, objects, nd } from "./vk.ts";
import { BU, Queue, type Device, type Buffer } from "./device.ts";
import { Replay, cbOf, type CommandBuffer } from "./commands.ts";
import { publish } from "./ahb.ts";

/** a fence or semaphore: the work that signals it, once a submit has given it some */
export class Signal {
  work: Promise<void> | null = null;
  signaled: boolean;
  constructor(signaled: boolean) { this.signaled = signaled; }
  arm(work: Promise<void>): void {
    this.signaled = false; this.work = work;
    void work.then(() => { if (this.work === work) this.signaled = true; });
  }
  /** signaled as the host says, with no work pending */
  set(signaled: boolean): void { this.work = null; this.signaled = signaled; }
}
class VkEvent { set = false; }

const SubmitInfo = struct("sType:u32 pNext:ptr waits:u32 pWaits:ptr pWaitStages:ptr buffers:u32 pBuffers:ptr signals:u32 pSignals:ptr");
const FenceInfo = struct("sType:u32 pNext:ptr flags:u32");
const GetFd = struct("sType:u32 pNext:ptr semaphore:u64 handleType:u32");
const ImportFd = struct("sType:u32 pNext:ptr semaphore:u64 flags:u32 handleType:u32 fd:i32");

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
  for (const cb of cbs) for (const op of cb.ops) op(r);
  r.outside();
  const reads = readbacks(dev, r.enc, written);
  r.writePush();
  dev.gpu.queue.submit(r.finish());
  for (const img of r.released) if (img.ahb) publish(dev, img);
  return dev.gpu.queue.onSubmittedWorkDone().then(() => Promise.all(reads.map((f) => f()))).then(() => {});
}

/** how long to wait, in ms, for a timeout in ns; UINT64_MAX is forever */
const waitMs = (ns: bigint) => ns >= 0xffffffffffffffffn ? Infinity : Number(ns / 1000000n);
async function until(works: Promise<void>[], all: boolean, ms: number): Promise<boolean> {
  const done = all ? Promise.all(works).then(() => true) : Promise.race(works).then(() => true);
  if (ms === Infinity) return done;
  return Promise.race([done, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);
}

export const SYNC: Record<string, HostFn> = {
  vkQueueSubmit: (_c, a) => {
    const dev = objects.get(a.p(), Queue).dev, n = a.u(), infos = a.p(), fence = objects.find(nd(a), Signal);
    if (dev.lost) return R.DEVICE_LOST;
    let last: Promise<void> = Promise.resolve();
    for (const info of list(infos, n, SubmitInfo.size(), (at) => SubmitInfo.read(at))) {
      const cbs = list(info.pBuffers, info.buffers, PTR, (at) => cbOf(ldp(at)));
      try { last = submit(dev, cbs); }
      catch (e) { console.warn("[vulkan] vkQueueSubmit:", (e as Error).stack); return R.DEVICE_LOST; }
      for (const s of u64s(info.pSignals, info.signals)) objects.get(s, Signal).arm(last);
    }
    fence?.arm(last);
    return R.SUCCESS;
  },
  vkQueueWaitIdle: async (_c, a) => { await objects.get(a.p(), Queue).dev.gpu.queue.onSubmittedWorkDone(); return R.SUCCESS; },
  vkQueueBindSparse: () => R.FEATURE_NOT_PRESENT,

  vkCreateFence: (_c, a) => { a.p(); const info = FenceInfo.read(a.p()); a.p(); stU64(a.p(), objects.add(new Signal(!!(info.flags & 1)))); return R.SUCCESS; },
  vkDestroyFence: (_c, a) => { a.p(); objects.delete(nd(a)); },
  vkResetFences: (_c, a) => { a.p(); const n = a.u(); for (const h of u64s(a.p(), n)) objects.get(h, Signal).set(false); return R.SUCCESS; },
  vkGetFenceStatus: (_c, a) => { a.p(); return objects.get(nd(a), Signal).signaled ? R.SUCCESS : R.NOT_READY; },
  vkWaitForFences: async (_c, a) => {
    a.p(); const n = a.u(), fences = u64s(a.p(), n).map((h) => objects.get(h, Signal)), all = !!a.u(), ms = waitMs(a.ul());
    const pending = fences.filter((f) => !f.signaled);
    if (all ? !pending.length : pending.length < fences.length) return R.SUCCESS;
    // a fence no submit armed is signaled only by a later submit, which this thread waiting cannot make
    const works = pending.flatMap((f) => f.work ? [f.work] : []);
    if (!works.length || (all && works.length < pending.length)) return ms === Infinity ? R.DEVICE_LOST : R.TIMEOUT;
    return await until(works, all, ms) ? R.SUCCESS : R.TIMEOUT;
  },

  vkCreateSemaphore: (_c, a) => { a.p(); a.p(); a.p(); stU64(a.p(), objects.add(new Signal(false))); return R.SUCCESS; },
  vkDestroySemaphore: (_c, a) => { a.p(); objects.delete(nd(a)); },
  vkGetSemaphoreFdKHR: (_c, a) => {
    a.p(); const info = GetFd.read(a.p()), out = a.p();
    if (info.handleType !== SYNC_FD) return R.INVALID_EXTERNAL_HANDLE;
    const s = objects.get(info.semaphore, Signal);
    mem.st32(out, syncFileFd(fence(s.work ?? Promise.resolve())));
    s.set(false);                                                                // exporting a sync fd unsignals the semaphore
    return R.SUCCESS;
  },
  // a sync fd of work already done may be -1; the semaphore owns the fd it takes
  vkImportSemaphoreFdKHR: (_c, a) => {
    a.p(); const info = ImportFd.read(a.p());
    const passed = info.fd === -1 ? null : fenceOf(info.fd);
    if (info.handleType !== SYNC_FD || info.fd !== -1 && !passed) return R.INVALID_EXTERNAL_HANDLE;
    const s = objects.get(info.semaphore, Signal);
    if (passed) { s.arm(passed.done); void closeFd(info.fd); }
    else s.set(true);
    return R.SUCCESS;
  },

  vkCreateEvent: (_c, a) => { a.p(); a.p(); a.p(); stU64(a.p(), objects.add(new VkEvent())); return R.SUCCESS; },
  vkDestroyEvent: (_c, a) => { a.p(); objects.delete(nd(a)); },
  vkGetEventStatus: (_c, a) => { a.p(); return objects.get(nd(a), VkEvent).set ? R.EVENT_SET : R.EVENT_RESET; },
  vkSetEvent: (_c, a) => { a.p(); objects.get(nd(a), VkEvent).set = true; return R.SUCCESS; },
  vkResetEvent: (_c, a) => { a.p(); objects.get(nd(a), VkEvent).set = false; return R.SUCCESS; },
  vkCmdSetEvent: () => {}, vkCmdResetEvent: () => {}, vkCmdWaitEvents: () => {},
};
