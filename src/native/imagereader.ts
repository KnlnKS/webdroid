// AImageReader and AImage (libmediandk, NdkImageReader.h): the consumer of a window a producer queues frames to
// (MediaCodec's output, through ANativeWindow_toSurface). Each frame goes to an AHardwareBuffer of the reader's,
// one no image holds, and waits there to be acquired as an AImage; deleting the image frees its buffer for another
// frame. The image listener runs on the reader's callback thread once per frame queued.

import { mem } from "./mem.ts";
import { hostLib, ldp, stp, ptr, PTR, type HostFn } from "./host.ts";
import { nativeWindowFor, releaseWindow } from "./libandroid.ts";
import { closeFd } from "./fd.ts";
import { allocate, queueFrame, release, type HardwareBuffer } from "./hardwarebuffer.ts";
import { callbackThread } from "./thread.ts";
import { after } from "../jvm/natives/jentry.ts";
import { frameSize, frameTimestamp, type GlSurface } from "../android/glsurface.ts";

type Frame = VideoFrame | ImageBitmap;
const OK = 0, INVALID_PARAMETER = -10004, UNSUPPORTED = -10002, NO_BUFFER_AVAILABLE = -30001, MAX_IMAGES_ACQUIRED = -30002;
/** BufferQueueDefs::NUM_BUFFER_SLOTS, the most images a reader may hold */
const SLOTS = 64;
/** the AIMAGE_FORMATs whose buffers hold frames here: RGBA_8888, RGBX_8888, RGB_888, RGB_565, RGBA_FP16, PRIVATE and
 *  YUV_420_888; the camera's (JPEG, RAW, DEPTH, HEIC) have no producer */
const FORMATS = new Set([1, 2, 3, 4, 0x16, 0x22, 0x23]);
const PRIVATE = 0x22, CPU_READ = 0xfn;

interface Image { reader: Reader; buffer: HardwareBuffer; timestamp: bigint }
class Reader {
  readonly handle: number; readonly format: number; readonly usage: bigint; readonly maxImages: number;
  readonly surface: GlSurface;
  window = 0;
  /** the context and onImageAvailable of the listener set */
  listener: [number, number] | null = null;
  /** buffers holding queued frames, oldest first, then those free for the next */
  readonly queued: Image[] = [];
  readonly free: HardwareBuffer[] = [];
  acquired = 0;
  deleted = false;
  constructor(handle: number, width: number, height: number, format: number, usage: bigint, maxImages: number) {
    this.handle = handle; this.format = format; this.usage = usage; this.maxImages = maxImages;
    this.surface = { width, height, present: null, frames: 0, post: (frame) => this.queue(frame) };
  }
  /** the producer's frame into a free buffer; past maxImages waiting, the oldest is dropped, as a producer that
   *  never blocks on a free buffer leaves it */
  private queue(frame: Frame): void {
    const [width, height] = frameSize(frame);
    let buffer = this.free.pop();
    if (buffer && (buffer.width !== width || buffer.height !== height)) { release(buffer); buffer = undefined; }
    buffer ??= allocate(width, height, this.format, this.usage) ?? undefined;
    if (!buffer) { frame.close(); return; }
    queueFrame(buffer, frame);
    this.queued.push({ reader: this, buffer, timestamp: frameTimestamp(this.surface, frame) });
    if (this.queued.length > this.maxImages) this.recycle(this.queued.shift()!.buffer);
    const listener = this.listener;
    if (listener) callbacks(async (cpu) => { if (!this.deleted) await cpu.call(listener[1], [ptr(listener[0]), ptr(this.handle)], "AImageReader image listener"); });
  }
  /** acquireNextImage, or acquireLatestImage dropping those before the newest */
  acquire(latest: boolean, out: number, fence: number): number {
    if (!out) return INVALID_PARAMETER;
    if (this.acquired >= this.maxImages) return MAX_IMAGES_ACQUIRED;
    if (latest) while (this.queued.length > 1) this.recycle(this.queued.shift()!.buffer);
    const image = this.queued.shift();
    if (!image) return NO_BUFFER_AVAILABLE;
    const at = mem.malloc(PTR);
    images.set(at, image);
    this.acquired++;
    stp(out, at);
    if (fence) mem.st32(fence, -1);
    return OK;
  }
  /** a buffer free for the next frame, letting go of one it still holds: a decoder reuses its frames once closed */
  recycle(buffer: HardwareBuffer): void {
    buffer.frame?.close(); buffer.frame = null;
    this.free.push(buffer);
  }
  delete(): void {
    this.deleted = true;
    for (const image of this.queued.splice(0)) release(image.buffer);
    for (const buffer of this.free.splice(0)) release(buffer);
    if (this.window) releaseWindow(this.window);
    readers.delete(this.handle);
    mem.free(this.handle);
  }
}
const readers = new Map<number, Reader>(), images = new Map<number, Image>();
const callbacks = callbackThread("ImageReader");

/** the image's buffer back to its reader, or freed with a reader deleted */
function deleteImage(at: number): void {
  const image = images.get(at);
  if (!image) return;
  images.delete(at); mem.free(at);
  const { reader, buffer } = image;
  if (reader.deleted) { release(buffer); return; }
  reader.acquired--;
  reader.recycle(buffer);
}
const imageField = (get: (image: Image) => number | bigint): HostFn => (_c, a) => {
  const image = images.get(a.p()), out = a.p();
  if (!image || !out) return INVALID_PARAMETER;
  const v = get(image);
  if (typeof v === "bigint") mem.st64(out, v); else mem.st32(out, v);
  return OK;
};

export function imageReaderInit(): void {
  const R = (p: number) => readers.get(p);
  hostLib("libmediandk.so", {
    AImageReader_newWithUsage: (_c, a) => {
      const width = a.i(), height = a.i(), format = a.i(), usage = a.l(), maxImages = a.i(), out = a.p();
      if (!out || width < 1 || height < 1 || maxImages < 1 || maxImages > SLOTS || format === PRIVATE && usage & CPU_READ) return INVALID_PARAMETER;
      if (!FORMATS.has(format)) return UNSUPPORTED;
      const at = mem.malloc(PTR);
      readers.set(at, new Reader(at, width, height, format, usage, maxImages));
      stp(out, at);
      return OK;
    },
    AImageReader_delete: (_c, a) => R(a.p())?.delete(),
    // the window stays the reader's: its caller does not release it
    AImageReader_getWindow: (_c, a) => {
      const reader = R(a.p()), out = a.p();
      if (!reader || !out) return INVALID_PARAMETER;
      reader.window ||= nativeWindowFor(reader.surface);
      stp(out, reader.window);
      return OK;
    },
    // AImageReader_ImageListener: its context, then onImageAvailable; none or a null callback removes it
    AImageReader_setImageListener: (_c, a) => {
      const reader = R(a.p()), listener = a.p();
      if (!reader) return INVALID_PARAMETER;
      const fn = listener ? ldp(listener + PTR) : 0;
      reader.listener = fn ? [ldp(listener), fn] : null;
      return OK;
    },
    AImageReader_acquireNextImage: (_c, a) => R(a.p())?.acquire(false, a.p(), 0) ?? INVALID_PARAMETER,
    AImageReader_acquireLatestImage: (_c, a) => R(a.p())?.acquire(true, a.p(), 0) ?? INVALID_PARAMETER,
    // a frame is complete once queued, so no acquire fence follows
    AImageReader_acquireNextImageAsync: (_c, a) => R(a.p())?.acquire(false, a.p(), a.p()) ?? INVALID_PARAMETER,
    AImageReader_acquireLatestImageAsync: (_c, a) => R(a.p())?.acquire(true, a.p(), a.p()) ?? INVALID_PARAMETER,
    AImage_delete: (_c, a) => deleteImage(a.p()),
    AImage_deleteAsync: (_c, a) => {
      const at = a.p(), fence = a.i();
      deleteImage(at);
      if (fence >= 0) return after(closeFd(fence), () => undefined);
    },
    AImage_getWidth: imageField((image) => image.buffer.width),
    AImage_getHeight: imageField((image) => image.buffer.height),
    AImage_getFormat: imageField((image) => image.reader.format),
    AImage_getTimestamp: imageField((image) => image.timestamp),
    // AImageCropRect: left, top, right, bottom; a decoded frame's buffer is its visible area
    AImage_getCropRect: (_c, a) => {
      const image = images.get(a.p()), out = a.p();
      if (!image || !out) return INVALID_PARAMETER;
      mem.st32(out, 0); mem.st32(out + 4, 0); mem.st32(out + 8, image.buffer.width); mem.st32(out + 12, image.buffer.height);
      return OK;
    },
    // the buffer stays the image's: its caller does not release it
    AImage_getHardwareBuffer: (_c, a) => {
      const image = images.get(a.p()), out = a.p();
      if (!image || !out) return INVALID_PARAMETER;
      stp(out, image.buffer.at);
      return OK;
    },
  });
}
