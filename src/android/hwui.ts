// HardwareRenderer's natives: hwui's RenderProxy over a window's surface. A frame replays the root
// RenderNode's tree into the surface's next buffer and queues it; the frame-drawing callback runs
// before the queue (ViewRootImpl arms its BLAST sync there), the commit and complete callbacks
// after. Render-thread animators keep the proxy drawing on each vsync until they finish, without
// the UI thread, as hwui's RenderThread does.
import { rt, JObj, driven, type Gen } from "../jvm/runtime.ts";
import { vcall, scall, callOn, JThread } from "../jvm/natives/jentry.ts";
import { handle, deref, release, refBaseHandle } from "./handles.ts";
import { NativeRenderNode, drawNodeInto, positionUpdates } from "./rendernode.ts";
import { textureLayerNatives } from "./texturelayer.ts";
import { animateRenderThread } from "./rtanimator.ts";
import { nativeSurface, surfaceBuffer, queueBuffer } from "./surfaceflinger.ts";
import { onNextVsync, frameDrawn } from "./vsync.ts";
import { mkPfd } from "./os.ts";
import { uptimeMillis } from "../guest-clock.ts";
import { perf } from "../perf.ts";
import { resetDrawn } from "./webfunctor.ts";
import type { NativeBitmap } from "./bitmap.ts";
import { hostStub } from "./binder.ts";
import { detached } from "../jvm/natives/jthrowable.ts";
import { note, Ev } from "../timeline.ts";

const PIXEL_COPY_SUCCESS = 0, PIXEL_COPY_SOURCE_NO_DATA = 3;

const SYNC_OK = 0, SYNC_LOST_SURFACE_REWARD_IF_FOUND = 2, SYNC_CONTEXT_IS_STOPPED = 4;
interface Proxy {
  root: NativeRenderNode; surface: ReturnType<typeof nativeSurface>; opaque: boolean; stopped: boolean; frame: bigint;
  drawCallback: JObj | null; commitCallback: JObj | null; completeCallback: JObj | null; animating: boolean; running: boolean;
}
const proxy = (h: bigint) => deref<Proxy>(h);

const drawFrame = driven(function* (p: Proxy): Gen<number> {
  if (p.stopped) return SYNC_CONTEXT_IS_STOPPED;
  const buffer = p.surface && surfaceBuffer(p.surface);
  if (!buffer) return SYNC_LOST_SURFACE_REWARD_IF_FOUND;
  const t0 = performance.now(), frame = ++p.frame;
  note(Ev.DrawBegin);
  animate(p);
  const ctx = buffer.getContext("2d")!;
  ctx.reset();
  if (!p.opaque) ctx.clearRect(0, 0, buffer.width, buffer.height);
  resetDrawn(buffer);
  drawNodeInto(ctx, p.root);
  perf.draws++; perf.drawMs += performance.now() - t0;
  note(Ev.DrawEnd);
  frameDrawn();
  // prepareTree's position updates reach their listeners before the frame queues, so a SurfaceView
  // merges its move into this frame's transaction
  for (const [listener, l, t, r, b] of positionUpdates.splice(0)) {
    yield scall("android/graphics/RenderNode$PositionUpdateListener", "callPositionChanged", "(Ljava/lang/ref/WeakReference;JIIII)Z", listener, frame, l, t, r, b);
  }
  const draw = p.drawCallback;
  p.drawCallback = null;
  const commit: JObj | null = draw ? yield vcall(draw, "onFrameDraw", "(IJ)Landroid/graphics/HardwareRenderer$FrameCommitCallback;", SYNC_OK, frame) : null;
  yield queueBuffer(p.surface!);
  for (const callback of [commit, p.commitCallback]) if (callback) yield vcall(callback, "onFrameCommit", "(Z)V", 1);
  if (p.completeCallback) yield vcall(p.completeCallback, "onFrameComplete", "()V");
  return SYNC_OK;
});
/** hwui's RenderThread, which draws the frames its animators run on their own */
const renderThread = Object.assign(new JThread(), { jname: "RenderThread" });
/** render-thread animators step at the frame's time, and while any runs the next vsync draws again */
function animate(p: Proxy): void {
  p.running = animateRenderThread(uptimeMillis());
  if (p.running) armAnimation(p);
}
/** draw at the next vsync unless a draw came first: the main thread's, sharing the vsync, has
 *  already stepped the animators */
function armAnimation(p: Proxy): void {
  if (p.animating) return;
  p.animating = true;
  const drawn = p.frame;
  onNextVsync(() => {
    p.animating = false;
    if (p.frame === drawn) detached(() => callOn(renderThread, () => drawFrame(p)));
    else if (p.running) armAnimation(p);
  });
}

// IGraphicsStats: GraphicsStatsService hands each process a buffer for hwui's jank statistics; no
// frame here records hwui's per-stage timings, so the buffer stays empty
rt.register({ name: "webdroid/GraphicsStatsService", ctor: class extends JObj {}, sup: "android/view/IGraphicsStats$Stub", methods: {
  "requestBufferForProcess(Ljava/lang/String;Landroid/view/IGraphicsStatsCallback;)Landroid/os/ParcelFileDescriptor;": () => mkPfd(new Uint8Array(0), null),
} });
hostStub("graphicsstats", "webdroid/GraphicsStatsService");

// a frame-metrics observer: no frame here reports hwui's per-stage timings, so none is ever delivered
rt.registerJnis("android/graphics/HardwareRendererObserver", {
  "nCreateObserver(Ljava/lang/ref/WeakReference;Z)J": (observer: JObj) => handle({ observer }),
  "nGetNextBuffer(J[J)I": () => -1,
});
rt.registerJnis("android/graphics/HardwareRenderer", {
  "nCreateRootRenderNode()J": () => refBaseHandle(new NativeRenderNode("RootRenderNode"), 1),
  "nCreateProxy(ZJ)J": (translucent: number, root: bigint) => handle({
    root: deref<NativeRenderNode>(root), surface: null, opaque: !translucent, stopped: false, frame: 0n,
    drawCallback: null, commitCallback: null, completeCallback: null, animating: false, running: false,
  } satisfies Proxy),
  "nDeleteProxy(J)V": (h: bigint) => release(h),
  "nSetSurface(JLandroid/view/Surface;Z)V": (h: bigint, surface: JObj | null) => { proxy(h).surface = nativeSurface(surface); },
  "nSetSurfaceControl(JJ)V": () => {},
  ...textureLayerNatives,
  // PixelCopy.request on a surface: its latest buffer, or the whole of it for an empty source rect
  "nCopySurfaceInto(Landroid/view/Surface;IIIILandroid/graphics/HardwareRenderer$CopyRequest;)V":
    driven(function* (javaSurface: JObj, l: number, t: number, r: number, b: number, request: JObj) {
      const s = nativeSurface(javaSurface), src = s?.queue?.canvas;
      if (!src) return yield vcall(request, "onCopyFinished", "(I)V", PIXEL_COPY_SOURCE_NO_DATA);
      if (r <= l || b <= t) { l = t = 0; r = src.width; b = src.height; }
      const dst = deref<NativeBitmap>(yield vcall(request, "getDestinationBitmap", "(II)J", r - l, b - t));
      dst.ctx.clearRect(0, 0, dst.w, dst.h);
      dst.ctx.drawImage(src, l, t, r - l, b - t, 0, 0, dst.w, dst.h);
      return yield vcall(request, "onCopyFinished", "(I)V", PIXEL_COPY_SUCCESS);
    }),
  "nSyncAndDrawFrame(J[JI)I": (h: bigint) => drawFrame(proxy(h)),
  "nDestroy(JJ)V": (h: bigint) => { proxy(h).surface = null; },
  "nSetOpaque(JZ)V": (h: bigint, opaque: number) => { proxy(h).opaque = !!opaque; },
  "nSetStopped(JZ)V": (h: bigint, stopped: number) => { proxy(h).stopped = !!stopped; },
  "nPause(J)Z": () => 0,
  "nSetFrameCallback(JLandroid/graphics/HardwareRenderer$FrameDrawingCallback;)V": (h: bigint, c: JObj | null) => { proxy(h).drawCallback = c; },
  "nSetFrameCommitCallback(JLandroid/graphics/HardwareRenderer$FrameCommitCallback;)V": (h: bigint, c: JObj | null) => { proxy(h).commitCallback = c; },
  "nSetFrameCompleteCallback(JLandroid/graphics/HardwareRenderer$FrameCompleteCallback;)V": (h: bigint, c: JObj | null) => { proxy(h).completeCallback = c; },
  // the sRGB, SDR canvas: every color mode draws as the default, at an HDR/SDR ratio of 1
  "nSetColorMode(JI)F": () => 1,
  "nGetRenderThreadTid(J)I": () => 0,
  "nLoadSystemProperties(J)Z": () => 0,
  "nIsDrawingEnabled()Z": () => 1,
  "isWebViewOverlaysEnabled()Z": () => 0,
  // render-thread animations always run; a client may only leave them on (the default FPS divisor)
  "nSetRtAnimationsEnabled(Z)V": (enabled: number) => {
    if (!enabled) rt.noteMissing("android/graphics/HardwareRenderer.nSetRtAnimationsEnabled(false)");
  },
  // what tunes a GPU renderer and its process: lights, caches, priorities and profiling
  ...Object.fromEntries([
    "nSetName(JLjava/lang/String;)V", "nSetLightGeometry(JFFFF)V", "nSetLightAlpha(JFF)V", "nSetSdrWhitePoint(JF)V",
    "nSetTargetSdrHdrRatio(JF)V", "nFence(J)V", "nStopDrawing(J)V", "nNotifyFramePending(J)V", "nNotifyCallbackPending(J)V",
    "nNotifyExpensiveFrame(J)V", "nSetContentDrawBounds(JIIII)V", "nForceDrawNextFrame(J)V", "nAllocateBuffers(J)V",
    "nSetForceDark(JI)V", "nDestroyHardwareResources(J)V", "nTrimMemory(I)V", "nTrimCaches(I)V", "nOverrideProperty(Ljava/lang/String;Ljava/lang/String;)V",
    "nSetContextPriority(I)V", "nSetDebuggingEnabled(Z)V", "nSetDisplayDensityDpi(I)V", "nSetDrawingEnabled(Z)V", "nSetHighContrastText(Z)V",
    "nSetIsHighEndGfx(Z)V", "nSetIsLowRam(Z)V", "nSetIsSystemOrPersistent(Z)V", "nSetIsolatedProcess(Z)V", "nInitDisplayInfo(IIFIJJZZZ)V",
    "preload()V", "setupShadersDiskCache(Ljava/lang/String;Ljava/lang/String;)V", "disableVsync()V", "nRotateProcessStatsBuffer()V",
    "nSetProcessStatsBuffer(I)V", "nAddObserver(JJ)V", "nRemoveObserver(JJ)V",
    "nSetASurfaceTransactionCallback(JLandroid/graphics/HardwareRenderer$ASurfaceTransactionCallback;)V",
    "nSetPrepareSurfaceControlForWebviewCallback(JLandroid/graphics/HardwareRenderer$PrepareSurfaceControlForWebviewCallback;)V",
    "nSetPictureCaptureCallback(JLandroid/graphics/HardwareRenderer$PictureCapturedCallback;)V",
    "nRegisterAnimatingRenderNode(JJ)V", "nRegisterVectorDrawableAnimator(JJ)V",
  ].map((sig) => [sig, () => {}])),
});
