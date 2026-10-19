// android.text: AndroidCharacter's natives.
import { rt, driven, waits, type Gen } from "../jvm/runtime.ts";
import { after } from "../jvm/natives/jentry.ts";
import { isLead, isTrail } from "../jvm/natives/jstring.ts";
import { uchar } from "../jvm/natives/jicu.ts";

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
    if (isLead(c) && isTrail(next)) {
      dest[i] = dest[i + 1] = yield value(0x10000 + ((c - 0xd800) << 10) + (next & 0x3ff));
      i++;
    } else dest[i] = yield value(c);
  }
});
rt.registerJnis("android/text/AndroidCharacter", {
  "getDirectionalities([C[BI)V": waits((src: Uint16Array | null, dest: Int8Array | null, count: number) => {
    if (!src || !dest) return rt.npe();
    checkRange(Math.min(src.length, dest.length), 0, count);
    return perCodePoint(src, 0, count, dest, directionality);
  }),
  "getEastAsianWidths([CII[B)V": waits((src: Uint16Array | null, start: number, count: number, dest: Int8Array | null) => {
    if (!src || !dest) return rt.npe();
    checkRange(src.length, start, count); checkRange(dest.length, 0, count);
    return perCodePoint(src, start, count, dest, eastAsianWidth);
  }),
  "getEastAsianWidth(C)I": waits(eastAsianWidth),
  "getMirror(C)C": waits(icuMirror),
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
