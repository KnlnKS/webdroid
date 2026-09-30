// android.text: TextPaint, TextUtils' plain-text parcel form, and AndroidCharacter's natives.
import { type JParcel, writeInt, readInt, writeString8, readString8 } from "./parcel";

import { rt, driven, type Gen } from "../jvm/runtime";
import { after } from "../jvm/natives/jlang";
import { uchar } from "../jvm/natives/jicu";
import { JPaint, copyPaint } from "./graphics";
import { device } from "../shell/config";
import { csText } from "../jvm/natives/jchars";

export class JTextPaint extends JPaint {
  linkColor = -16776961;
  /** AOSP's StaticLayout reads these off the paint directly, so they are real fields rather
   *  than accessors: a BackgroundColorSpan writes bgColor and the layout draws from it */
  bgColor = 0;
  baselineShift = 0;
  drawableState: Int32Array | null = null;
  underlineColor = 0;
  underlineThickness = 0;
  /** dp/sp-based span math (updateDrawState/updateMeasureState) reads this to scale —
   *  shares the one device-density constant, not a magic literal. */
  density = device.density;
}
function copyTextPaint(src: JTextPaint, dst: JTextPaint): void {
  copyPaint(src, dst);
  dst.linkColor = src.linkColor;
  dst.bgColor = src.bgColor;
  dst.baselineShift = src.baselineShift;
  dst.drawableState = src.drawableState;
  dst.density = src.density;
  dst.underlineColor = src.underlineColor;
  dst.underlineThickness = src.underlineThickness;
}
rt.register({
  name: "android/text/TextPaint", ctor: JTextPaint, sup: "android/graphics/Paint",
  fields: ["linkColor", "bgColor", "baselineShift", "drawableState", "density", "underlineColor", "underlineThickness"],
  methods: {
    "<init>()V": function () {},
    "<init>(I)V": function (this: JTextPaint, f: number) { this.flags = f; },
    "<init>(Landroid/graphics/Paint;)V": function (this: JTextPaint, p: JPaint) {
      if (p) copyPaint(p, this);
    },
    "set(Landroid/text/TextPaint;)V": function (this: JTextPaint, p: JTextPaint) {
      if (p) copyTextPaint(p, this);
    },
  },
});

export const writeText = driven(function* writeText(text: unknown, parcel: JParcel): Gen<void> {
  if (text !== null && rt.iof(text, "android/text/Spanned")) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Spanned text parcel");
  writeInt(parcel, 1); writeString8(parcel, text === null ? null : yield csText(text));
});
export function readText(parcel: JParcel) {
  const kind = readInt(parcel), text = readString8(parcel);
  if (text !== null && kind !== 1 && readInt(parcel) !== 0) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Spanned text parcel");
  return text;
}

// android_text_AndroidCharacter.cpp: u_charDirection, u_getIntPropertyValue(UCHAR_EAST_ASIAN_WIDTH)
// and u_charMirror, answered by ICU4J's UCharacter over the same ICU data
const icuDirection = uchar("getDirection", "(I)I"), icuProperty = uchar("getIntPropertyValue", "(II)I"), icuMirror = uchar("getMirror", "(I)I");
/** ICU's UCharDirection as Character.DIRECTIONALITY_*; the isolates (19-22) are outside the map
 *  and read as PROPERTY_UNDEFINED, as on the device */
const DIRECTIONALITY = [0, 1, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15, 2, 16, 17, 18, 8, 9];
const directionality = (c: number) => after(icuDirection(c), (d) => DIRECTIONALITY[d as number] ?? -1);
const eastAsianWidth = (c: number) => icuProperty(c, 0x1004);
function checkRange(length: number, start: number, count: number) {
  if (start < 0 || count < 0 || length < start + count) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", null);
}
/** each unit of a surrogate pair gets its code point's value */
const perCodePoint = driven(function* perCodePoint(src: Uint16Array, start: number, count: number, dest: Int8Array, value: (c: number) => unknown): Gen {
  for (let i = 0; i < count; i++) {
    const c = src[start + i], next = i + 1 < count ? src[start + i + 1] : 0;
    if (c >= 0xd800 && c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      dest[i] = dest[i + 1] = yield value(0x10000 + ((c - 0xd800) << 10) + (next & 0x3ff));
      i++;
    } else dest[i] = yield value(c);
  }
});
rt.registerJnis("android/text/AndroidCharacter", {
  "getDirectionalities([C[BI)V": (src: Uint16Array | null, dest: Int8Array | null, count: number) => {
    if (!src || !dest) return rt.npe();
    checkRange(Math.min(src.length, dest.length), 0, count);
    return perCodePoint(src, 0, count, dest, directionality);
  },
  "getEastAsianWidths([CII[B)V": (src: Uint16Array | null, start: number, count: number, dest: Int8Array | null) => {
    if (!src || !dest) return rt.npe();
    checkRange(src.length, start, count); checkRange(dest.length, 0, count);
    return perCodePoint(src, start, count, dest, eastAsianWidth);
  },
  "getEastAsianWidth(C)I": eastAsianWidth,
  "getMirror(C)C": icuMirror,
  "mirror([CII)Z": driven(function* (chars: Uint16Array | null, start: number, count: number): Gen {
    if (!chars) return rt.npe();
    checkRange(chars.length, start, count);
    let changed = 0;
    for (let i = start; i < start + count; i++) {
      const mirrored: number = yield icuMirror(chars[i]);
      if (mirrored !== chars[i]) { chars[i] = mirrored; changed = 1; }
    }
    return changed;
  }),
});
