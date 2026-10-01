// A TextView's compound drawables (AOSP TextView.Drawables): set and bounded, called back to the
// view, tinted and given its state, and the paddings they add around the text.
import { type NativeSpec, driven, noops, type Gen } from "../jvm/runtime";
import { jarray, mangleMethod, jmethod } from "../jvm/abi";
import { after, curThread, vcall, vcallOn } from "../jvm/natives/jlang";
import { invalidate } from "./view";
import { type JColorStateList, type JDrawable, loadDrawable, drawableSize, drawableBounds, setDrawableCallback } from "./drawable";
import { relayout } from "./textview-layout";
import type { JTextView } from "./textview";

export const compoundWidth = (d: JDrawable | null) => { if (!d) return 0; const b = drawableBounds(d); return Math.max(0, b.right - b.left); };
export const compoundHeight = (d: JDrawable | null) => { if (!d) return 0; const b = drawableBounds(d); return Math.max(0, b.bottom - b.top); };

/** AOSP: the old drawables let go, the new ones called back to this view, given its state and tint */
const setCompoundDrawables = driven(function* setCompoundDrawables(this: JTextView, l: JDrawable | null, t: JDrawable | null, r: JDrawable | null, b: JDrawable | null): Gen {
  const next = [l, t, r, b];
  for (const d of [this.drawableL, this.drawableT, this.drawableR, this.drawableB]) if (d && !next.includes(d)) yield setDrawableCallback(d, null);
  this.drawableL = l; this.drawableT = t; this.drawableR = r; this.drawableB = b;
  for (const d of next) if (d) yield setDrawableCallback(d, this);
  if (this.drawableTint) yield applyCompoundTint(this);
  yield syncCompoundStates(this);
  yield relayout(this);
});
/** AOSP applyCompoundDrawableTint: each compound drawable mutated and given the tint list */
const applyCompoundTint = driven(function* applyCompoundTint(tv: JTextView): Gen {
  for (const d of [tv.drawableL, tv.drawableT, tv.drawableR, tv.drawableB]) if (d) {
    yield vcall(d, "mutate", "()Landroid/graphics/drawable/Drawable;");
    yield vcall(d, "setTintList", "(Landroid/content/res/ColorStateList;)V", tv.drawableTint);
  }
  yield syncCompoundStates(tv);
  invalidate(tv);
});
/** AOSP hands the compound drawables the view's state when they arrive and on every change:
 *  a single-choice row's radio is a drawableStart that shows state_checked. On a state change
 *  it invalidates each drawable the new state changed. */
export const syncCompoundStates = driven(function* syncCompoundStates(tv: JTextView, changed = false): Gen {
  if (!tv.drawableL && !tv.drawableT && !tv.drawableR && !tv.drawableB) return;
  const state = Int32Array.from(tv.drawableState());
  for (const d of [tv.drawableL, tv.drawableT, tv.drawableR, tv.drawableB]) {
    if (d && (yield vcall(d, "setState", "([I)Z", state)) && changed)
      yield vcall(tv, "invalidateDrawable", "(Landroid/graphics/drawable/Drawable;)V", d);
  }
});
const intrinsicBounds = driven(function* intrinsicBounds(drawables: (JDrawable | null)[]): Gen {
  for (const d of drawables) if (d) {
    const width = yield drawableSize(d, false), height = yield drawableSize(d, true);
    yield vcall(d, "setBounds", "(IIII)V", 0, 0, width, height);
  }
});
export const setIntrinsicDrawables = driven(function* setIntrinsicDrawables(this: JTextView, l: JDrawable | null, t: JDrawable | null, r: JDrawable | null, b: JDrawable | null): Gen {
  yield intrinsicBounds([l, t, r, b]);
  yield setCompoundDrawables.call(this, l, t, r, b);
});
const loadCompound = (tv: JTextView, ids: number[]) => Promise.all(ids.map((id) => (id ? loadDrawable(tv.jres!, id, tv.theme) : null)));
const DRAWABLES4 = "(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V";

function compoundDrawables(this: JTextView) {
  return jarray([this.drawableL, this.drawableT, this.drawableR, this.drawableB], "Landroid/graphics/drawable/Drawable;");
}
export function compoundPadL(this: JTextView) { return this.padL + (this.drawableL ? compoundWidth(this.drawableL) + this.drawablePad : 0); }
export function compoundPadR(this: JTextView) { return this.padR + (this.drawableR ? compoundWidth(this.drawableR) + this.drawablePad : 0); }
function compoundPadT(this: JTextView) { return this.padT + (this.drawableT ? compoundHeight(this.drawableT) + this.drawablePad : 0); }
function compoundPadB(this: JTextView) { return this.padB + (this.drawableB ? compoundHeight(this.drawableB) + this.drawablePad : 0); }
const M_padL = mangleMethod("getCompoundPaddingLeft", "()I"), M_padR = mangleMethod("getCompoundPaddingRight", "()I");
const M_padT = mangleMethod("getCompoundPaddingTop", "()I"), M_padB = mangleMethod("getCompoundPaddingBottom", "()I");
/** native getCompoundPadding* bodies that answer synchronously from fields */
export const syncCompoundPads = new WeakSet<Function>([compoundPadL, compoundPadT, compoundPadR, compoundPadB]);
/** reused by the synchronous path; callers read it before they can suspend */
const padScratch = [0, 0, 0, 0];
/**
 * AOSP measures and draws text within the virtual compound paddings: Switch and SwitchCompat
 * reserve their track there. Only a Java override pays for the calls.
 */
export function compoundPads(tv: JTextView): number[] | Promise<number[]> {
  const l = jmethod(tv, M_padL)!, t = jmethod(tv, M_padT)!, r = jmethod(tv, M_padR)!, b = jmethod(tv, M_padB)!;
  if (syncCompoundPads.has(l) && syncCompoundPads.has(t) && syncCompoundPads.has(r) && syncCompoundPads.has(b)) {
    padScratch[0] = l.call(tv) as number; padScratch[1] = t.call(tv) as number;
    padScratch[2] = r.call(tv) as number; padScratch[3] = b.call(tv) as number;
    return padScratch;
  }
  return Promise.all([l, t, r, b].map((f) => f.call(tv) as number | Promise<number>)).then((a) => a.map(Number));
}
function compoundPadRelative(view: JTextView, start: boolean) {
  const thread = curThread;
  return after(vcallOn(thread, view, "getLayoutDirection", "()I"), direction =>
    vcallOn(thread, view, start !== (direction === 1) ? "getCompoundPaddingLeft" : "getCompoundPaddingRight", "()I"));
}

export const compoundDrawableMethods: NonNullable<NativeSpec["methods"]> = {
  // AOSP chains these through the overridable forms: an (IIII) call reaches the Drawable form,
  // and that one the plain setter (AppCompat and Material hook the drawables there)
  "setCompoundDrawablesWithIntrinsicBounds(IIII)V": driven(function* (this: JTextView, l: number, t: number, r: number, b: number): Gen {
    const [dl, dt, dr, db] = yield loadCompound(this, [l, t, r, b]);
    yield vcall(this, "setCompoundDrawablesWithIntrinsicBounds", DRAWABLES4, dl, dt, dr, db);
  }),
  "setCompoundDrawablesWithIntrinsicBounds(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": driven(function* (this: JTextView, l: JDrawable | null, t: JDrawable | null, r: JDrawable | null, b: JDrawable | null): Gen {
    yield intrinsicBounds([l, t, r, b]);
    yield vcall(this, "setCompoundDrawables", DRAWABLES4, l, t, r, b);
  }),
  "setCompoundDrawables(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setCompoundDrawables,
  "getCompoundDrawables()[Landroid/graphics/drawable/Drawable;": compoundDrawables,
  "getCompoundDrawablesRelative()[Landroid/graphics/drawable/Drawable;": compoundDrawables,
  "setCompoundDrawablesRelative(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": setCompoundDrawables,
  "setCompoundDrawablesRelativeWithIntrinsicBounds(Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V": driven(function* (this: JTextView, l: JDrawable | null, t: JDrawable | null, r: JDrawable | null, b: JDrawable | null): Gen {
    yield intrinsicBounds([l, t, r, b]);
    yield vcall(this, "setCompoundDrawablesRelative", DRAWABLES4, l, t, r, b);
  }),
  "setCompoundDrawablesRelativeWithIntrinsicBounds(IIII)V": driven(function* (this: JTextView, l: number, t: number, r: number, b: number): Gen {
    const [dl, dt, dr, db] = yield loadCompound(this, [l, t, r, b]);
    yield vcall(this, "setCompoundDrawablesRelativeWithIntrinsicBounds", DRAWABLES4, dl, dt, dr, db);
  }),
  "setCompoundDrawableTintList(Landroid/content/res/ColorStateList;)V": function (this: JTextView, csl: JColorStateList | null) {
    this.drawableTint = csl;
    return applyCompoundTint(this);
  },
  "getCompoundDrawableTintList()Landroid/content/res/ColorStateList;": function (this: JTextView) { return this.drawableTint; },
  ...noops("setCompoundDrawableTintMode(Landroid/graphics/PorterDuff$Mode;)V"),
  "setCompoundDrawablePadding(I)V": function (this: JTextView, p: number) { this.drawablePad = p; return relayout(this); },
  "getCompoundDrawablePadding()I": function (this: JTextView) { return this.drawablePad; },
  "getCompoundPaddingLeft()I": compoundPadL,
  "getCompoundPaddingRight()I": compoundPadR,
  "getCompoundPaddingTop()I": compoundPadT,
  "getCompoundPaddingBottom()I": compoundPadB,
  "getCompoundPaddingStart()I": function (this: JTextView) { return compoundPadRelative(this, true); },
  "getCompoundPaddingEnd()I": function (this: JTextView) { return compoundPadRelative(this, false); },
  "getTotalPaddingLeft()I": function (this: JTextView) { return vcall(this, "getCompoundPaddingLeft", "()I"); },
  "getTotalPaddingRight()I": function (this: JTextView) { return vcall(this, "getCompoundPaddingRight", "()I"); },
  "getTotalPaddingTop()I": compoundPadT,
  "getTotalPaddingBottom()I": compoundPadB,
};
