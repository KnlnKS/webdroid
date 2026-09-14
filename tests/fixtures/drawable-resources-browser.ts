import "../../src/natives";
import { rt } from "../../src/jvm/runtime";
import { vcall } from "../../src/jvm/natives/jlang";
import { zipTree } from "../../src/jvm/natives/jzip";
import { Arsc } from "../../src/android/arsc";
import { Resources, JTheme, setFramework } from "../../src/android/res";
import { loadDrawable, JLayerDrawable, ST } from "../../src/android/drawable";
import { JCanvas } from "../../src/android/graphics";

async function probe() {
  const zip = zipTree(new Uint8Array(await (await fetch("/framework.apk")).arrayBuffer()));
  const arsc = new Arsc(zip["resources.arsc"], path => zip[path] ?? null);
  setFramework(arsc); rt.linkNatives();
  const res = new Resources(null, {}), theme = new JTheme();
  theme.res = res; theme.apply(arsc.findId("style", "Theme.Material"));
  const track = await loadDrawable(res, arsc.findId("drawable", "seekbar_track_material"), theme);
  if (!(track instanceof JLayerDrawable)) throw new Error("Invalid track");
  await vcall(track, "setState", "([I)Z", Int32Array.of(ST.enabled));
  await vcall(track, "setBounds", "(IIII)V", 0, 0, 300, 54);
  const progress = await vcall(track, "findDrawableByLayerId", "(I)Landroid/graphics/drawable/Drawable;", 0x0102000d);
  await vcall(progress, "setLevel", "(I)Z", 5000);
  const ctx = new OffscreenCanvas(300, 54).getContext("2d")!;
  await vcall(track, "draw", "(Landroid/graphics/Canvas;)V", JCanvas.wrap(ctx, 300, 54));
  const heights = track.layers.map(x => x.d.bounds.bottom - x.d.bounds.top);
  const pixel = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
  const before = pixel(50, 27), after = pixel(250, 27), above = pixel(50, 15);
  const thumb = await loadDrawable(res, arsc.findId("drawable", "seekbar_thumb_material_anim"), theme);
  await vcall(thumb, "setBounds", "(IIII)V", 0, 0, 54, 54);
  ctx.clearRect(0, 0, 300, 54); ctx.globalAlpha = 0.5;
  await vcall(thumb, "setState", "([I)Z", Int32Array.of(ST.enabled));
  await vcall(thumb, "draw", "(Landroid/graphics/Canvas;)V", JCanvas.wrap(ctx, 300, 54));
  const center = pixel(27, 27), outside = pixel(2, 2);
  return { heights, before, after, above, center, outside, restored: ctx.getTransform().isIdentity };
}
Object.defineProperty(window, "drawableResourcesProbe", { value: probe() });
