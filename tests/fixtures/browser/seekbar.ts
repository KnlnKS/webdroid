import "../../../src/natives";
import { rt } from "../../../src/jvm/runtime";
import { mangleMethod } from "../../../src/jvm/abi";
import { newObj, vcall, vcallOn, curThread, JThread } from "../../../src/jvm/natives/jlang";
import { JCanvas } from "../../../src/android/graphics";
import { JView } from "../../../src/android/view";
import { JMotionEvent } from "../../../src/android/motionevent";

async function probe() {
  rt.linkNatives();
  const view = rt.make("android/widget/SeekBar");
  if (!(view instanceof JView)) throw new Error("Invalid SeekBar");
  view.right = 100; view.bottom = 40;
  const thumb = await newObj("android/graphics/drawable/ColorDrawable", "(I)V", 0xff00ff00);
  Object.assign(thumb, {
    [mangleMethod("getIntrinsicWidth", "()I")]: async () => 10,
    [mangleMethod("getIntrinsicHeight", "()I")]: () => 10,
  });
  await vcall(view, "setThumb", "(Landroid/graphics/drawable/Drawable;)V", thumb);
  const background = await newObj("android/graphics/drawable/ColorDrawable", "(I)V", 0xff333333);
  const fill = await newObj("android/graphics/drawable/ColorDrawable", "(I)V", 0xff0000ff);
  const progress = await newObj("android/graphics/drawable/ScaleDrawable", "(Landroid/graphics/drawable/Drawable;IFF)V", fill, 3, 1, 0);
  const track = await newObj("android/graphics/drawable/LayerDrawable", "([Landroid/graphics/drawable/Drawable;)V", [background, progress]);
  for (let i = 0; i < 2; i++) {
    await vcall(track, "setId", "(II)V", i, i ? 0x0102000d : 0x01020000);
    await vcall(track, "setLayerSize", "(III)V", i, -1, 4);
    await vcall(track, "setLayerGravity", "(II)V", i, 0x17);
  }
  await vcall(view, "setProgressDrawable", "(Landroid/graphics/drawable/Drawable;)V", track);
  await vcall(view, "setProgress", "(I)V", 50);
  const ctx = new OffscreenCanvas(100, 40).getContext("2d")!;
  await vcall(view, "onDraw", "(Landroid/graphics/Canvas;)V", JCanvas.wrap(ctx, 100, 40));
  const pixel = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data];
  const thread = new JThread(), events: unknown[] = [];
  const listener = rt.make("java/lang/Object");
  Object.assign(listener, {
    [mangleMethod("onStartTrackingTouch", "(Landroid/widget/SeekBar;)V")]: async () => { events.push(["start", curThread === thread]); await Promise.resolve(); },
    [mangleMethod("onProgressChanged", "(Landroid/widget/SeekBar;IZ)V")]: async (_v: unknown, p: number, user: number) => { events.push([p, user, curThread === thread]); await Promise.resolve(); },
    [mangleMethod("onStopTrackingTouch", "(Landroid/widget/SeekBar;)V")]: () => events.push(["stop", curThread === thread]),
  });
  await vcall(view, "setOnSeekBarChangeListener", "(Landroid/widget/SeekBar$OnSeekBarChangeListener;)V", listener);
  for (const [action, x] of [[0, 75], [2, 90], [1, 90]]) await vcallOn(thread, view, "onTouchEvent", "(Landroid/view/MotionEvent;)Z", Object.assign(new JMotionEvent(), { action, x, y: 20 }));
  return { before: pixel(20, 20), thumb: pixel(50, 20), after: pixel(80, 20), above: pixel(20, 5),
    restored: ctx.getTransform().isIdentity, events, progress: await vcall(view, "getProgress", "()I"), pressed: view.pressed };
}
export default probe;
