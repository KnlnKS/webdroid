// AnimatedImageDrawable's native half (hwui's AnimatedImageDrawable over SkAnimatedImage), drawn
// in software as SkiaCanvas::drawAnimatedImage draws it: nDraw draws the frame due now and
// answers the milliseconds until the next one, 0 when not running, FINISHED when the last
// repetition just ended. The frames come from the browser's ImageDecoder (WebCodecs), decoded
// once at the drawable's size; until they arrive nothing is drawn and a redraw is asked for.

import { rt } from "../jvm/runtime.ts";
import { handle, deref, FINALIZER } from "./handles.ts";
import { edges } from "./graphics.ts";
import type { NativeColorFilter } from "./colorfilter.ts";
import { type NativeCanvas, drawingCanvas } from "./canvas.ts";
import { drawBitmap } from "./canvas-draw.ts";
import { NativePaint } from "./paint.ts";
import { NativeBitmap } from "./bitmap.ts";
import type { EncodedImage } from "./decode.ts";
import { uptimeMillis } from "../guest-clock.ts";

const REPEAT_INFINITE = -1, FINISHED = -1n, RETRY_MS = 16n;
class AnimatedImage {
  readonly w: number; readonly h: number;
  frames: { image: NativeBitmap; ms: number }[] = [];
  count = 1;
  repeatCount = REPEAT_INFINITE;
  running = false; finished = false;
  /** uptime the current repetition's first frame started at, while running */
  start = 0;
  current = 0;
  alpha = 255; filter: NativeColorFilter | null = null; mirrored = false;
  /** what a frame is drawn with: the alpha and colour filter */
  private readonly paint = new NativePaint();
  bounds = [0, 0, 0, 0];
  constructor(w: number, h: number) { this.w = w; this.h = h; }

  async decode(bytes: Uint8Array, type: string, crop: number[] | null): Promise<void> {
    if (typeof ImageDecoder === "undefined") return;
    const decoder = new ImageDecoder({ data: bytes, type });
    try {
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack!;
      this.count = track.frameCount;
      this.repeatCount = track.repetitionCount === Infinity ? REPEAT_INFINITE : track.repetitionCount;
      for (let i = 0; i < this.count; i++) {
        const { image } = await decoder.decode({ frameIndex: i });
        try {
          const [sx, sy, sw, sh] = crop ?? [0, 0, image.displayWidth, image.displayHeight];
          const b = new NativeBitmap(this.w, this.h);
          b.setImage(await createImageBitmap(image, sx, sy, sw, sh, { resizeWidth: this.w, resizeHeight: this.h }));
          this.frames.push({ image: b, ms: (image.duration ?? 0) / 1000 });
        } finally { image.close(); }
      }
    } catch (e) { console.warn("[animated image]", type, e); }
    finally { decoder.close(); }
  }
  /** the frame due at `now`, and the milliseconds until the next (FINISHED at the end) */
  advance(now: number): bigint {
    const all = this.frames.length === this.count, cycle = this.frames.reduce((sum, f) => sum + f.ms, 0);
    if (!this.running || !all || !cycle) {
      if (this.running && !all) this.current = Math.max(0, this.frames.length - 1);
      return this.running ? RETRY_MS : 0n;
    }
    const elapsed = now - this.start, round = Math.floor(elapsed / cycle);
    if (this.repeatCount !== REPEAT_INFINITE && round > this.repeatCount) {
      this.running = false; this.finished = true; this.current = this.frames.length - 1;
      return FINISHED;
    }
    let at = elapsed - round * cycle, i = 0;
    while (at >= this.frames[i].ms) at -= this.frames[i++].ms;
    this.current = i;
    return BigInt(Math.max(1, Math.ceil(this.frames[i].ms - at)));
  }
  draw(cv: NativeCanvas): void {
    const frame = this.frames[this.current];
    if (!frame) return;
    const [l, t, r, b] = this.bounds, ctx = cv.ctx, paint = this.paint;
    paint.setAlpha(this.alpha);
    paint.colorFilter = this.filter;
    ctx.save();
    try {
      ctx.translate(l, t);
      ctx.scale((r - l) / this.w, (b - t) / this.h);
      if (this.mirrored) { ctx.translate(this.w, 0); ctx.scale(-1, 1); }
      drawBitmap(cv, frame.image, paint, 0, 0, this.w, this.h);
    } finally { ctx.restore(); }
  }
}

const anim = (h: bigint) => deref<AnimatedImage>(h);
rt.registerJnis("android/graphics/drawable/AnimatedImageDrawable", {
  "nCreate(JLandroid/graphics/ImageDecoder;IIJZLandroid/graphics/Rect;)J":
    (decoder: bigint, _jdecoder: unknown, w: number, h: number, _cs: bigint, _extended: number, cropRect: object | null) => {
      const crop = cropRect && edges(cropRect), { bytes, header } = deref<EncodedImage>(decoder), a = new AnimatedImage(crop ? crop.right - crop.left : w, crop ? crop.bottom - crop.top : h);
      a.bounds = [0, 0, a.w, a.h];
      // the crop is in the scaled image's coordinates: frames are decoded whole, then cut
      const scale = crop && [header.width / w, header.height / h];
      void a.decode(bytes, header.mime, crop && scale ? [crop.left * scale[0], crop.top * scale[1], a.w * scale[0], a.h * scale[1]] : null);
      return handle(a);
    },
  "nGetNativeFinalizer()J": () => FINALIZER,
  "nNativeByteSize(J)J": (h: bigint) => BigInt(anim(h).w * anim(h).h * 4),
  "nDraw(JJ)J": (h: bigint, canvas: bigint) => {
    const a = anim(h), next = a.advance(uptimeMillis());
    a.draw(drawingCanvas(canvas));
    return next;
  },
  "nSetAlpha(JI)V": (h: bigint, alpha: number) => { anim(h).alpha = alpha; },
  "nGetAlpha(J)I": (h: bigint) => anim(h).alpha,
  "nSetColorFilter(JJ)V": (h: bigint, filter: bigint) => { anim(h).filter = filter ? deref<NativeColorFilter>(filter) : null; },
  "nIsRunning(J)Z": (h: bigint) => +anim(h).running,
  // a start resumes at the current frame, or from the first once the repetitions are done
  "nStart(J)Z": (h: bigint) => {
    const a = anim(h);
    if (a.running) return 0;
    if (a.finished) { a.finished = false; a.current = 0; }
    a.running = true;
    a.start = uptimeMillis() - a.frames.slice(0, a.current).reduce((sum, f) => sum + f.ms, 0);
    return 1;
  },
  "nStop(J)Z": (h: bigint) => { const a = anim(h), was = a.running; a.running = false; return +was; },
  "nGetRepeatCount(J)I": (h: bigint) => anim(h).repeatCount,
  "nSetRepeatCount(JI)V": (h: bigint, count: number) => { anim(h).repeatCount = count; },
  // hardware rendering's end callback; in software the drawable posts its own from FINISHED
  "nSetOnAnimationEndListener(JLjava/lang/ref/WeakReference;)V": () => {},
  "nSetMirrored(JZ)V": (h: bigint, mirrored: number) => { anim(h).mirrored = !!mirrored; },
  "nSetBounds(JLandroid/graphics/Rect;)V": (h: bigint, rect: object) => {
    const r = edges(rect);
    anim(h).bounds = [r.left, r.top, r.right, r.bottom];
  },
});
