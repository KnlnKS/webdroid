// android.renderscript, as far as apps use it on API 33: ScriptIntrinsicBlur over bitmap
// allocations (image-blur libraries, androidx.mediarouter's art backdrop).
import { JObj, rt, noops } from "../jvm/runtime";
import { JBitmap } from "./graphics";
import { clampedBlur, type BlurCache } from "./rendereffect";
import { defineException, mkEnumSet } from "../jvm/natives/jlang";

class JBaseObj extends JObj {}
class JAllocation extends JBaseObj {
  constructor(public w = 0, public h = 0, public pixels: OffscreenCanvas | null = null) { super(); }
  raster(): OffscreenCanvas { return this.pixels ??= new OffscreenCanvas(this.w, this.h); }
}
class JType extends JBaseObj { constructor(public w = 0, public h = 0) { super(); } }
class JBlur extends JBaseObj implements BlurCache {
  radius = 5; input: JAllocation | null = null;
  padded: OffscreenCanvas | null = null; blurred: OffscreenCanvas | null = null;
}

function fromBitmap(_rs: unknown, bmp: JBitmap): JAllocation {
  const a = new JAllocation(bmp.w, bmp.h);
  a.raster().getContext("2d")!.drawImage(bmp.canvas, 0, 0);
  return a;
}
rt.register({
  name: "android/renderscript/BaseObj", ctor: JBaseObj,
  methods: noops("destroy()V"),
});
rt.register({
  name: "android/renderscript/RenderScript", ctor: class extends JObj {},
  methods: {
    "static create(Landroid/content/Context;)Landroid/renderscript/RenderScript;": () => rt.make("android/renderscript/RenderScript"),
    ...noops("static releaseAllContexts()V", "setMessageHandler(Landroid/renderscript/RenderScript$RSMessageHandler;)V",
      "setErrorHandler(Landroid/renderscript/RenderScript$RSErrorHandler;)V", "destroy()V", "finish()V"),
  },
});
rt.register({ name: "android/renderscript/RenderScript$RSMessageHandler", ctor: class extends JObj {}, methods: noops("<init>()V") });
rt.register({ name: "android/renderscript/RenderScript$RSErrorHandler", ctor: class extends JObj {}, methods: noops("<init>()V") });
class JElement extends JBaseObj {}
const u84 = new JElement();
rt.register({
  name: "android/renderscript/Element", ctor: JElement, sup: "android/renderscript/BaseObj",
  methods: { "static U8_4(Landroid/renderscript/RenderScript;)Landroid/renderscript/Element;": () => u84 },
});
rt.register({
  name: "android/renderscript/Type", ctor: JType, sup: "android/renderscript/BaseObj",
  methods: { "getX()I": function (this: JType) { return this.w; }, "getY()I": function (this: JType) { return this.h; } },
});
rt.register({
  name: "android/renderscript/Allocation", ctor: JAllocation, sup: "android/renderscript/BaseObj",
  statics: { USAGE_SCRIPT: 1, USAGE_SHARED: 128 },
  methods: {
    "static createFromBitmap(Landroid/renderscript/RenderScript;Landroid/graphics/Bitmap;)Landroid/renderscript/Allocation;": fromBitmap,
    "static createFromBitmap(Landroid/renderscript/RenderScript;Landroid/graphics/Bitmap;Landroid/renderscript/Allocation$MipmapControl;I)Landroid/renderscript/Allocation;": fromBitmap,
    "static createTyped(Landroid/renderscript/RenderScript;Landroid/renderscript/Type;)Landroid/renderscript/Allocation;": (_rs: unknown, t: JType) => new JAllocation(t.w, t.h),
    "getType()Landroid/renderscript/Type;": function (this: JAllocation) { return new JType(this.w, this.h); },
    "copyFrom(Landroid/graphics/Bitmap;)V": function (this: JAllocation, bmp: JBitmap) {
      const ctx = this.raster().getContext("2d")!;
      ctx.clearRect(0, 0, this.w, this.h); ctx.drawImage(bmp.canvas, 0, 0);
    },
    "copyTo(Landroid/graphics/Bitmap;)V": function (this: JAllocation, bmp: JBitmap) {
      const ctx = bmp.ctx;
      ctx.clearRect(0, 0, bmp.w, bmp.h); ctx.drawImage(this.raster(), 0, 0);
    },
  },
});
mkEnumSet("android/renderscript/Allocation$MipmapControl", ["MIPMAP_NONE", "MIPMAP_FULL", "MIPMAP_ON_SYNC_TO_TEXTURE"]);
defineException("android/renderscript/RSRuntimeException", "java/lang/RuntimeException", ["(Ljava/lang/String;)V"]);
defineException("android/renderscript/RSIllegalArgumentException", "android/renderscript/RSRuntimeException", ["(Ljava/lang/String;)V"]);
rt.register({
  name: "android/renderscript/ScriptIntrinsicBlur", ctor: JBlur, sup: "android/renderscript/BaseObj",
  methods: {
    "static create(Landroid/renderscript/RenderScript;Landroid/renderscript/Element;)Landroid/renderscript/ScriptIntrinsicBlur;": () => new JBlur(),
    "setRadius(F)V": function (this: JBlur, r: number) {
      if (!(r > 0 && r <= 25)) throw rt.mkThrowable("android/renderscript/RSIllegalArgumentException", "Radius out of range (0 < r <= 25).");
      this.radius = r;
    },
    "setInput(Landroid/renderscript/Allocation;)V": function (this: JBlur, a: JAllocation) { this.input = a; },
    "forEach(Landroid/renderscript/Allocation;)V": function (this: JBlur, out: JAllocation) {
      if (!this.input) return;
      // the Gaussian RenderScript's blur applies, sigma = 0.4 r + 0.6, edges clamped
      const sigma = 0.4 * this.radius + 0.6, pad = Math.ceil(3 * sigma);
      const blurred = clampedBlur(this.input.raster(), sigma, this), o = out.raster().getContext("2d")!;
      o.clearRect(0, 0, out.w, out.h); o.drawImage(blurred, -pad, -pad);
    },
  },
});
