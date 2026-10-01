// HardwareRenderer's natives: hwui's RenderProxy over a window's surface. A frame replays the root
// RenderNode's tree into the surface's next buffer and queues it; the frame-drawing callback runs
// before the queue (ViewRootImpl arms its BLAST sync there), the commit and complete callbacks
// after. Render-thread animators keep the proxy drawing on each vsync until they finish, without
// the UI thread, as hwui's RenderThread does.
import { rt, type JObj } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { handle, deref, release } from "./handles";
import { NativeRenderNode, drawNodeInto } from "./rendernode";
import { animateRenderThread } from "./rtanimator";
import { nativeSurface, surfaceBuffer, queueBuffer } from "./surfaceflinger";
import { onNextVsync } from "./vsync";
import { reportUncaught } from "./os";
import { uptimeMillis } from "../guest-clock";
import { perf } from "../perf";

const SYNC_OK = 0, SYNC_LOST_SURFACE_REWARD_IF_FOUND = 2, SYNC_CONTEXT_IS_STOPPED = 4;
interface Proxy {
  root: NativeRenderNode; surface: ReturnType<typeof nativeSurface>; opaque: boolean; stopped: boolean; frame: bigint;
  drawCallback: JObj | null; commitCallback: JObj | null; completeCallback: JObj | null; animating: boolean;
}
const proxy = (h: bigint) => deref<Proxy>(h);

async function drawFrame(p: Proxy): Promise<number> {
  if (p.stopped) return SYNC_CONTEXT_IS_STOPPED;
  const buffer = p.surface && surfaceBuffer(p.surface);
  if (!buffer) return SYNC_LOST_SURFACE_REWARD_IF_FOUND;
  const t0 = performance.now(), frame = ++p.frame;
  animate(p);
  const ctx = buffer.getContext("2d")!;
  ctx.reset();
  if (!p.opaque) ctx.clearRect(0, 0, buffer.width, buffer.height);
  drawNodeInto(ctx, p.root);
  perf.draws++; perf.drawMs += performance.now() - t0;
  const draw = p.drawCallback;
  p.drawCallback = null;
  const commit: JObj | null = draw ? await vcall(draw, "onFrameDraw", "(IJ)Landroid/graphics/HardwareRenderer$FrameCommitCallback;", SYNC_OK, frame) : null;
  await queueBuffer(p.surface!);
  for (const callback of [commit, p.commitCallback]) if (callback) await vcall(callback, "onFrameCommit", "(Z)V", 1);
  if (p.completeCallback) await vcall(p.completeCallback, "onFrameComplete", "()V");
  return SYNC_OK;
}
/** render-thread animators step at the frame's time, and while any runs the next vsync draws again */
function animate(p: Proxy): void {
  if (!animateRenderThread(uptimeMillis()) || p.animating) return;
  p.animating = true;
  onNextVsync(() => {
    p.animating = false;
    drawFrame(p).catch(reportUncaught);
  });
}

// a frame-metrics observer: no frame here reports hwui's per-stage timings, so none is ever delivered
rt.registerJnis("android/graphics/HardwareRendererObserver", {
  "nCreateObserver(Ljava/lang/ref/WeakReference;Z)J": (observer: JObj) => handle({ observer }),
  "nGetNextBuffer(J[J)I": () => -1,
});
rt.registerJnis("android/graphics/HardwareRenderer", {
  "nCreateRootRenderNode()J": () => handle(new NativeRenderNode("RootRenderNode")),
  "nCreateProxy(ZJ)J": (translucent: number, root: bigint) => handle({
    root: deref<NativeRenderNode>(root), surface: null, opaque: !translucent, stopped: false, frame: 0n,
    drawCallback: null, commitCallback: null, completeCallback: null, animating: false,
  } satisfies Proxy),
  "nDeleteProxy(J)V": (h: bigint) => release(h),
  "nSetSurface(JLandroid/view/Surface;Z)V": (h: bigint, surface: JObj | null) => { proxy(h).surface = nativeSurface(surface); },
  "nSetSurfaceControl(JJ)V": () => {},
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
