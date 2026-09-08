import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { openApk } from "../../scripts/lib";

test("browser layouts measure real Mihon placeholders and preserve replacement span geometry and callbacks", async () => {
  const path = (relative: string) => new URL(relative, import.meta.url).pathname;
  const bundle = await Bun.build({ entrypoints: ["replacement-probe"], target: "browser", plugins: [{ name: "probe", setup(build) {
    build.onResolve({ filter: /^replacement-probe$/ }, () => ({ path: "probe", namespace: "probe" }));
    build.onLoad({ filter: /.*/, namespace: "probe" }, () => ({ loader: "ts", contents: `
      import ${JSON.stringify(path("../natives.ts"))};
      import {rt} from ${JSON.stringify(path("../jvm/runtime.ts"))};
      import {newObj,vcall,linkInit} from ${JSON.stringify(path("../jvm/natives/jlang.ts"))};
      import {dexesIn} from ${JSON.stringify(path("../jvm/dex.ts"))};
      import {mangleMethod} from ${JSON.stringify(path("../jvm/abi.ts"))};
      globalThis.probe={rt,newObj,vcall,linkInit,mangleMethod};
      for(const file of await (await fetch('/dexes')).json())for(const dex of dexesIn(new Uint8Array(await (await fetch('/'+file)).arrayBuffer())))rt.loadDex(dex);
      globalThis.ready=true;` }));
  } }] });
  if (!bundle.success) throw new Error(bundle.logs.join("\n"));
  const zip = await openApk(path("../../apks/mihon-v0.20.4.apk"));
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/probe.js") return new Response(bundle.outputs[0], { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/dexes") return Response.json(Object.keys(zip).filter((name) => /^classes\d*\.dex$/.test(name)));
    if (/^\/classes\d*\.dex$/.test(url.pathname)) return new Response(zip[url.pathname.slice(1)] as Uint8Array<ArrayBuffer>);
    return new Response('<script type="module" src="/probe.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); await page.goto(server.url.href);
    await page.waitForFunction(() => (globalThis as any).ready);
    const result = await page.evaluate(async () => {
      try {
      const { rt, newObj, vcall, linkInit, mangleMethod } = (globalThis as any).probe;
      const call = async (cls: string, name: string, desc: string, ...args: unknown[]) => (await linkInit(cls)).ctor[mangleMethod(name, desc)](...args);
      const paint = await newObj("android/text/TextPaint"); await vcall(paint, "setTextSize", "(F)V", 10);
      const layout = async (text: unknown, width: number, start = 0, end = String(text).length) => {
        const builder = await call("android/text/StaticLayout$Builder", "obtain", "(Ljava/lang/CharSequence;IILandroid/text/TextPaint;I)Landroid/text/StaticLayout$Builder;", text, start, end, paint, width);
        await vcall(builder, "setIncludePad", "(Z)Landroid/text/StaticLayout$Builder;", 0);
        return vcall(builder, "build", "()Landroid/text/StaticLayout;");
      };
      const density = await newObj("androidx/compose/ui/unit/DensityImpl", "(FF)V", 1, 1);
      const placeholder = await newObj("androidx/compose/ui/text/android/style/PlaceholderSpan", "(FIFILandroidx/compose/ui/unit/Density;I)V", 2, 1, 3, 1, density, 0);
      const text = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "X#");
      await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", placeholder, 1, 2, 33);
      const plainWidth = await call("android/text/Layout", "getDesiredWidth", "(Ljava/lang/CharSequence;Landroid/text/TextPaint;)F", "X", paint);
      const desired = await call("android/text/Layout", "getDesiredWidth", "(Ljava/lang/CharSequence;Landroid/text/TextPaint;)F", text, paint);
      const laid = await layout(text, 100);
      const placeholderSize = [await vcall(placeholder, "getWidthPx", "()I"), await vcall(placeholder, "getHeightPx", "()I")];
      const spanWidth = await vcall(laid, "getLineWidth", "(I)F", 0) - plainWidth;
      const Base = rt.link("android/text/style/ReplacementSpan").ctor;
      let measured = 0, drawn = 0, measuredSize = 0, range: number[] = [], box: number[] = [];
      rt.register({ name: "webdroid/ReplacementProbe", ctor: class extends Base {}, sup: "android/text/style/ReplacementSpan", methods: {
        "getSize(Landroid/graphics/Paint;Ljava/lang/CharSequence;IILandroid/graphics/Paint$FontMetricsInt;)I": async (p: any, _text: unknown, start: number, end: number, fm: any) => {
          await Promise.resolve(); measured++; measuredSize = p.textSize; range = [start, end];
          Object.assign(fm, { ascent: -25, descent: 7, top: -26, bottom: 8 }); return 40;
        },
        "draw(Landroid/graphics/Canvas;Ljava/lang/CharSequence;IIFIIILandroid/graphics/Paint;)V": async (canvas: unknown, _text: unknown, _start: number, _end: number, x: number, top: number, y: number, bottom: number, p: unknown) => {
          drawn++; box = [x, top, y, bottom]; await vcall(canvas, "drawRect", "(FFFFLandroid/graphics/Paint;)V", x, top, x + 40, bottom, p);
        },
      } });
      const custom = await newObj("webdroid/ReplacementProbe"), source = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "AxyB");
      await vcall(source, "setSpan", "(Ljava/lang/Object;III)V", custom, 1, 3, 33);
      const size = await newObj("android/text/style/AbsoluteSizeSpan", "(I)V", 12);
      await vcall(source, "setSpan", "(Ljava/lang/Object;III)V", size, 1, 3, 33);
      const wrapped = await layout(source, 20), starts = [];
      for (let i = 0; i < await vcall(wrapped, "getLineCount", "()I"); i++) starts.push(await vcall(wrapped, "getLineStart", "(I)I", i));
      const clipped = await layout(source, 100, 1, 3);
      const canvas = await newObj("android/graphics/Canvas"); canvas.ctx = new OffscreenCanvas(100, 100).getContext("2d");
      await vcall(clipped, "draw", "(Landroid/graphics/Canvas;)V", canvas);
      const plain = (await linkInit("android/text/Layout")).ctor[mangleMethod("getDesiredWidth", "(Ljava/lang/CharSequence;Landroid/text/TextPaint;)F")]("plain", paint);
      return { placeholderSize, spanWidth, desiredSpanWidth: desired - plainWidth, starts, measured, drawn, measuredSize, paintSize: paint.textSize, range, box,
        pixels: canvas.ctx.getImageData(10, 10, 1, 1).data[3], plainSync: !(plain instanceof Promise), missing: [...rt.missing] };
      } catch (error: any) { throw new Error((error.msg ?? String(error)) + "\n" + (error.jsStack ?? "")); }
    });
    expect(result).toEqual({ placeholderSize: [20, 30], spanWidth: 20, desiredSpanWidth: 20, starts: [0, 1, 3], measured: 2, drawn: 1, measuredSize: 12, paintSize: 10,
      range: [0, 2], box: [0, 0, 25, 32], pixels: 255, plainSync: true, missing: [] });
  } finally { await browser.close(); server.stop(true); }
}, 30000);
