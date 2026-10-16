// RenderScript's natives (librs_jni over the CPU reference driver), as far as apps use the
// deprecated API: elements, 2D types, allocations over bitmaps, and ScriptIntrinsicBlur. Any
// other intrinsic or script kernel is an RSRuntimeException, as a driver without it reports.
import { rt } from "../jvm/runtime.ts";
import { bitmapOf } from "./bitmap.ts";
import { clampedBlur, type BlurCache } from "./rendereffect.ts";
import { handle, deref, release } from "./handles.ts";

type Element = { kind: "element" };
type Type = { kind: "type"; element: bigint; x: number; y: number };
type Allocation = { kind: "allocation"; type: bigint; w: number; h: number; raster: OffscreenCanvas; bitmap: object | null };
type Blur = { kind: "blur"; radius: number; input: Allocation | null } & BlurCache;
/** RenderScript's context waits in nContextPeekMessage for a message no script sends, until teardown */
type Context = { kind: "context"; teardown: (() => void) | null };
const obj = <T>(h: bigint): T => {
  const o = deref<T>(h);
  if (!o) throw rt.mkThrowable("android/renderscript/RSIllegalArgumentException", "Invalid object id");
  return o;
};
function allocation(type: bigint, bitmap: object | null): bigint {
  const t = obj<Type>(type), raster = new OffscreenCanvas(Math.max(1, t.x), Math.max(1, t.y || 1));
  const a: Allocation = { kind: "allocation", type, w: t.x, h: t.y || 1, raster, bitmap };
  if (bitmap) copyFrom(a, bitmap);
  return handle(a);
}
function copyFrom(a: Allocation, bitmap: object) {
  const g = a.raster.getContext("2d")!;
  g.clearRect(0, 0, a.w, a.h); g.drawImage(bitmapOf(bitmap).image, 0, 0);
}
function copyTo(a: Allocation, bitmap: object) {
  const b = bitmapOf(bitmap);
  b.ctx.clearRect(0, 0, b.w, b.h); b.ctx.drawImage(a.raster, 0, 0);
}
const RS = "android/renderscript/RenderScript";
rt.claimNativeLib("rs_jni");
rt.registerJnis(RS, {
  "_nInit()V": () => {},
  "rsnSystemGetPointerSize()I": () => 8,
  "nDeviceCreate()J": () => handle({ kind: "device" }),
  "nDeviceDestroy(J)V": (dev: bigint) => release(dev),
  "nDeviceSetConfig(JII)V": () => {},
  "rsnContextCreate(JIII)J": () => handle({ kind: "context", teardown: null } satisfies Context),
  "rsnContextDestroy(J)V": (con: bigint) => release(con),
  "rsnContextSetCacheDir(JLjava/lang/String;)V": () => {},
  "rsnContextSetPriority(JI)V": () => {},
  // scripts run to completion when launched, so nothing is ever pending
  "rsnContextFinish(J)V": () => {},
  "nContextInitToClient(J)V": () => {},
  "nContextDeinitToClient(J)V": (con: bigint) => { const c = obj<Context>(con); c.teardown?.(); c.teardown = null; },
  // RS_MESSAGE_TO_CLIENT_NONE once the context is torn down
  "nContextPeekMessage(J[I)I": (con: bigint) => new Promise<number>((resolve) => { obj<Context>(con).teardown = () => resolve(0); }),
  "rsnObjDestroy(JJ)V": (_con: bigint, o: bigint) => release(o),
  "rsnElementCreate(JJIZI)J": () => handle({ kind: "element" } satisfies Element),
  "rsnTypeCreate(JJIIIZZI)J": (_con: bigint, element: bigint, x: number, y: number, z: number, mips: number, faces: number, yuv: number) => {
    if (z > 1 || mips || faces || yuv) throw rt.mkThrowable("android/renderscript/RSRuntimeException", "Only 2D types are supported");
    return handle({ kind: "type", element, x, y } satisfies Type);
  },
  "rsnTypeGetNativeData(JJ[J)V": (_con: bigint, type: bigint, out: BigInt64Array) => {
    const t = obj<Type>(type);
    out.set([BigInt(t.x), BigInt(t.y), 0n, 0n, 0n, t.element]);
  },
  "rsnAllocationCreateTyped(JJIIJ)J": (_con: bigint, type: bigint) => allocation(type, null),
  "rsnAllocationCreateFromBitmap(JJILandroid/graphics/Bitmap;I)J": (_con: bigint, type: bigint, _mips: number, bitmap: object) => allocation(type, bitmap),
  // the allocation shares the bitmap's pixels: a script's output reaches the bitmap too
  "rsnAllocationCreateBitmapBackedAllocation(JJILandroid/graphics/Bitmap;I)J": (_con: bigint, type: bigint, _mips: number, bitmap: object) => allocation(type, bitmap),
  "rsnAllocationGetType(JJ)J": (_con: bigint, a: bigint) => obj<Allocation>(a).type,
  "rsnAllocationCopyFromBitmap(JJLandroid/graphics/Bitmap;)V": (_con: bigint, a: bigint, bitmap: object) => copyFrom(obj(a), bitmap),
  "rsnAllocationCopyToBitmap(JJLandroid/graphics/Bitmap;)V": (_con: bigint, a: bigint, bitmap: object) => copyTo(obj(a), bitmap),
  "rsnAllocationSyncAll(JJI)V": (_con: bigint, h: bigint) => { const a = obj<Allocation>(h); if (a.bitmap) copyFrom(a, a.bitmap); },
  // RS_SCRIPT_INTRINSIC_ID_BLUR (5)
  "rsnScriptIntrinsicCreate(JIJ)J": (_con: bigint, intrinsic: number) => {
    if (intrinsic !== 5) throw rt.mkThrowable("android/renderscript/RSRuntimeException", `Intrinsic ${intrinsic} is not supported`);
    return handle({ kind: "blur", radius: 5, input: null, padded: null, blurred: null } satisfies Blur);
  },
  // slot 0 is the radius
  "rsnScriptSetVarF(JJIF)V": (_con: bigint, s: bigint, slot: number, value: number) => { if (slot === 0) obj<Blur>(s).radius = value; },
  // slot 1 is the input
  "rsnScriptSetVarObj(JJIJ)V": (_con: bigint, s: bigint, slot: number, a: bigint) => { if (slot === 1) obj<Blur>(s).input = a ? obj<Allocation>(a) : null; },
  "rsnScriptForEach(JJI[JJ[B[I)V": (_con: bigint, s: bigint, _slot: number, _ins: unknown, aout: bigint) => {
    const blur = obj<Blur>(s), out = obj<Allocation>(aout);
    if (!blur.input) return;
    // the Gaussian the intrinsic applies, sigma = 0.4 r + 0.6, edges clamped
    const sigma = 0.4 * blur.radius + 0.6, pad = Math.ceil(3 * sigma);
    const g = out.raster.getContext("2d")!;
    g.clearRect(0, 0, out.w, out.h); g.drawImage(clampedBlur(blur.input.raster, sigma, blur), -pad, -pad);
    if (out.bitmap) copyTo(out, out.bitmap);
  },
});
