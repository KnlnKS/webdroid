import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("sweep gradients start at the right and preserve stops and shader matrices", async () => {
  const path = (p: string) => new URL(p, import.meta.url).pathname;
  const bundle = await Bun.build({ entrypoints: ["gradient-probe"], target: "browser", plugins: [{ name: "probe", setup(build) {
    build.onResolve({ filter: /^gradient-probe$/ }, () => ({ path: "probe", namespace: "probe" }));
    build.onLoad({ filter: /.*/, namespace: "probe" }, () => ({ loader: "ts", contents: `
      import ${JSON.stringify(path("../natives.ts"))};
      import {rt} from ${JSON.stringify(path("../jvm/runtime.ts"))};
      import ${JSON.stringify(path("../jvm/abi.ts"))};
      import {newObj,vcall} from ${JSON.stringify(path("../jvm/natives/jlang.ts"))};
      const canvas=await newObj("android/graphics/Canvas"), paint=await newObj("android/graphics/Paint");
      canvas.ctx=new OffscreenCanvas(100,100).getContext("2d");
      const colors=Int32Array.of(0xffff0000,0xff00ff00,0xff0000ff,0xffff0000);
      const shader=await newObj("android/graphics/SweepGradient","(FF[I[F)V",50,50,colors,Float32Array.of(0,.25,.5,1));
      await vcall(paint,"setShader","(Landroid/graphics/Shader;)Landroid/graphics/Shader;",shader);
      await vcall(canvas,"drawRect","(FFFFLandroid/graphics/Paint;)V",0,0,100,100,paint);
      const pixel=(x,y)=>[...canvas.ctx.getImageData(x,y,1,1).data];
      const samples=[pixel(90,50),pixel(50,90),pixel(10,50)];
      const matrix=await newObj("android/graphics/Matrix");
      await vcall(matrix,"setRotate","(FFF)V",90,50,50);
      await vcall(shader,"setLocalMatrix","(Landroid/graphics/Matrix;)V",matrix);
      canvas.ctx.clearRect(0,0,100,100);
      await vcall(canvas,"drawRect","(FFFFLandroid/graphics/Paint;)V",0,0,100,100,paint);
      let rejected=false;
      try { await newObj("android/graphics/SweepGradient","(FF[I[F)V",0,0,colors,Float32Array.of(0,1)); } catch { rejected=true; }
      const rotated=pixel(50,90);
      const normal=rt.link("android/graphics/BlurMaskFilter$Blur").ctor.s$NORMAL;
      const blur=await newObj("android/graphics/BlurMaskFilter","(FLandroid/graphics/BlurMaskFilter$Blur;)V",6,normal);
      await vcall(paint,"setShader","(Landroid/graphics/Shader;)Landroid/graphics/Shader;",null);
      await vcall(paint,"setMaskFilter","(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;",blur);
      const copy=await newObj("android/graphics/Paint","(Landroid/graphics/Paint;)V",paint);
      canvas.ctx.clearRect(0,0,100,100);
      await vcall(canvas,"drawRect","(FFFFLandroid/graphics/Paint;)V",30,30,70,70,copy);
      const fringe=pixel(27,50)[3], center=pixel(50,50)[3], restored=canvas.ctx.filter;
      await vcall(copy,"setMaskFilter","(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;",null);
      canvas.ctx.clearRect(0,0,100,100);
      await vcall(canvas,"drawRect","(FFFFLandroid/graphics/Paint;)V",30,30,70,70,copy);
      globalThis.result={samples,rotated,rejected,fringe,center,restored,sharp:pixel(27,50)[3]};` }));
  } }] });
  if (!bundle.success) throw new Error(bundle.logs.join("\n"));
  const server = Bun.serve({ port: 0, fetch: (r) => new URL(r.url).pathname === "/probe.js"
    ? new Response(bundle.outputs[0], { headers: { "content-type": "text/javascript" } })
    : new Response('<script type="module" src="/probe.js"></script>', { headers: { "content-type": "text/html" } }) });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(); await page.goto(server.url.href);
    await page.waitForFunction(() => "result" in globalThis);
    const result = await page.evaluate(() => Reflect.get(globalThis, "result"));
    for (let i = 0; i < 3; i++) {
      expect(result.samples[i][i]).toBeGreaterThan(245);
      expect(result.samples[i][3]).toBe(255);
    }
    expect(result.rotated[0]).toBeGreaterThan(245);
    expect(result.rejected).toBe(true);
    expect(result.fringe).toBeGreaterThan(0);
    expect(result.fringe).toBeLessThan(128);
    expect(result.center).toBeGreaterThan(245);
    expect(result.restored).toBe("none");
    expect(result.sharp).toBe(0);
  } finally { await browser.close(); server.stop(true); }
}, 30000);
