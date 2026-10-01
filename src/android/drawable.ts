// android.graphics.drawable runs from AOSP bytecode; this is the TS view stack's side of it.
// Drawables and colour lists come from the Java Resources as an app's do (ResourcesImpl's
// caches and inflaters), and the view stack uses them only through their Java API.

import { type JObj, declaredField, driven, type Gen } from "../jvm/runtime";
import { vcall, vcallOn, scall, curThread, callOn, after, construct } from "../jvm/natives/jlang";
import { mangleMethod, jmethod } from "../jvm/abi";
import { TV } from "./axml";
import { type Resources, type RV, type JTheme, rvColor } from "./res";
import { type JRect } from "./graphics";
import type { JView } from "./view";

export type JDrawable = JObj;
export type JColorStateList = JObj;

/** android.R.attr's state attributes */
export const ST = {
  pressed: 0x010100a7, enabled: 0x0101009e, selected: 0x010100a1, checked: 0x010100a0,
  focused: 0x0101009c, activated: 0x010102fe, window_focused: 0x0101009d, checkable: 0x0101009f,
  hovered: 0x01010367, last: 0x010100a6, expanded: 0x010100a8, empty: 0x010100a9,
};

const D = "Landroid/graphics/drawable/Drawable;", THEME = "Landroid/content/res/Resources$Theme;";
const CSL = "android/content/res/ColorStateList";
type Maybe<T> = T | Promise<T>;

/** Resources.getDrawable(id, theme); no drawable for id 0 */
export function loadDrawable(res: Resources, id: number, theme: JTheme | null): Maybe<JDrawable | null> {
  return id ? vcall(res.jobj, "getDrawable", `(I${THEME})${D}`, id, theme?.jobj ?? null) : null;
}
/** a drawable attribute's value as TypedArray.getDrawable reads it: a resource loads, a colour is a
 *  ColorDrawable, a theme attribute resolves first */
export function loadDrawableRV(res: Resources, v: RV | null, theme: JTheme | null): Maybe<JDrawable | null> {
  if (!v || v.t === TV.NULL) return null;
  if (v.t === TV.ATTRIBUTE) return loadDrawableRV(res, theme?.lookup(v.d) ?? null, theme);
  if (v.t === TV.REFERENCE) return loadDrawable(res, v.d, theme);
  if (v.t >= TV.INT_DEC && v.t <= TV.COLOR_RGB4) return construct("android/graphics/drawable/ColorDrawable", "(I)V", v.d);
  return v.r ? loadDrawable(res, v.r, theme) : null;
}

export const drawableSize = (d: JDrawable, vertical: boolean, thread = curThread): Maybe<number> =>
  vcallOn(thread, d, vertical ? "getIntrinsicHeight" : "getIntrinsicWidth", "()I") as Maybe<number>;
const M_draw = mangleMethod("draw", "(Landroid/graphics/Canvas;)V"), M_setBounds = mangleMethod("setBounds", "(IIII)V");
/** Drawable.draw(Canvas), virtually: an app's own Drawable subclass is what gets drawn */
export function drawChild(d: JDrawable, cv: unknown, thread = curThread): unknown {
  return callOn(thread, () => jmethod(d, M_draw)!.call(d, cv));
}
/** Drawable.setBounds, then draw(Canvas) */
export function drawAt(d: JDrawable, cv: unknown, l: number, t: number, r: number, b: number, thread = curThread): unknown {
  const bounded = callOn(thread, () => jmethod(d, M_setBounds)!.call(d, l, t, r, b));
  return bounded instanceof Promise ? bounded.then(() => drawChild(d, cv, thread)) : drawChild(d, cv, thread);
}
export const setDrawableCallback = (d: JDrawable, callback: unknown): unknown =>
  vcall(d, "setCallback", "(Landroid/graphics/drawable/Drawable$Callback;)V", callback);
/** the steps an AOSP drawable setter takes besides swapping the callback: the old drawable's
 *  scheduled work dropped (View.unscheduleDrawable), the new one given the view's layout direction
 *  and, when stateful, its drawable state */
export const Adopt = { UNSCHEDULE: 1, DIRECTION: 2, STATE: 4, ALL: 7 } as const;
/** a view lets `old` go and takes `d` as AOSP's setters do: `old` called back no more, `d` called
 *  back to the view, with the `steps` (Adopt) that setter takes */
export const adoptDrawable = driven(function* adoptDrawable(v: JView, old: JDrawable | null, d: JDrawable | null, steps: number): Gen {
  if (old) {
    yield setDrawableCallback(old, null);
    if (steps & Adopt.UNSCHEDULE) yield vcall(v, "unscheduleDrawable", "(Landroid/graphics/drawable/Drawable;)V", old);
  }
  if (!d) return;
  yield setDrawableCallback(d, v);
  if (steps & Adopt.DIRECTION) yield vcall(d, "setLayoutDirection", "(I)Z", yield vcall(v, "getLayoutDirection", "()I"));
  if (steps & Adopt.STATE && (yield vcall(d, "isStateful", "()Z"))) yield vcall(d, "setState", "([I)Z", Int32Array.from(v.drawableState()));
});
let boundsField = "";
/** Drawable.getBounds() (final): the drawable's own Rect, which callers must not change */
export const drawableBounds = (d: JDrawable): JRect =>
  (d as unknown as Record<string, JRect>)[boundsField ||= declaredField("android/graphics/drawable/Drawable", "mBounds")];

/** A colour or a ColorStateList, as a view keeps a colour attribute. AOSP keeps
 *  ColorStateList.valueOf of a plain colour; the number itself needs no Java call to draw with. */
export type Colors = JColorStateList | number;
/** the colour for these states: ColorStateList.getColorForState(states, getDefaultColor()) */
export function colorFor(c: Colors, states: ArrayLike<number>): Maybe<number> {
  if (typeof c === "number") return c;
  return after(vcall(c, "getDefaultColor", "()I"), (dflt: number) => vcall(c, "getColorForState", "([II)I", Int32Array.from(states), dflt));
}
const mkCsl = (color: number): Maybe<JColorStateList> => scall(CSL, "valueOf", `(I)L${CSL};`, color);
/** the ColorStateList a getter hands out */
export const colorList = (c: Colors | null): Maybe<JColorStateList | null> => typeof c === "number" ? mkCsl(c) : c;
/** a colour attribute's value: a resource loads as a list (a selector or one colour), a literal is the colour */
export function rvColors(res: Resources, v: RV, theme: JTheme | null, dflt = 0): Maybe<Colors> {
  if (v.t === TV.ATTRIBUTE) { const t = theme?.lookup(v.d); if (t) return rvColors(res, t, theme, dflt); }
  const id = v.t === TV.REFERENCE ? v.d : v.r;
  return id ? vcall(res.jobj, "getColorStateList", `(I${THEME})L${CSL};`, id, theme?.jobj ?? null) : rvColor(res, v, dflt);
}
/** the same as a ColorStateList, which is what a tint takes */
export const rvCsl = (res: Resources, v: RV, theme: JTheme | null): Maybe<JColorStateList> =>
  after(rvColors(res, v, theme), (c) => typeof c === "number" ? mkCsl(c) : c);
