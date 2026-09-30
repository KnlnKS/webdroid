// android.view.animation's interpolators run from AOSP bytecode; the TS view stack's animations
// load them as AnimationUtils does, and fall back to the default curve without one.

import { scall } from "../jvm/natives/jlang";
import { attr, TV, type XmlNode } from "./axml";
import { type Resources, type JTheme } from "./res";

/** AOSP's AccelerateDecelerateInterpolator, the default for animators and view animations */
export function accelDecel(t: number) { return Math.cos((t + 1) * Math.PI) / 2 + 0.5; }

/** AnimationUtils.loadInterpolator(Resources, Theme, id) */
export const loadInterpolator = (res: Resources, theme: JTheme | null, id: number): unknown =>
  scall("android/view/animation/AnimationUtils", "loadInterpolator",
    "(Landroid/content/res/Resources;Landroid/content/res/Resources$Theme;I)Landroid/view/animation/Interpolator;", res.jobj, theme?.jobj ?? null, id);
/** an element's android:interpolator, which names a resource */
export function interpolatorAttr(res: Resources, theme: JTheme | null, node: XmlNode): unknown {
  const a = attr(node, "interpolator");
  return a?.type === TV.REFERENCE && a.data ? loadInterpolator(res, theme, a.data) : null;
}
