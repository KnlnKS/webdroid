import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
const cases = [
['2025-01-02T17:05:00Z','2025-01-02T17:05:00Z',65,'America/New_York'],
['2025-01-02T17:05:00Z','2025-01-02T17:05:00Z',129,'UTC'],
['2025-01-02T17:00:00Z','2025-01-02T19:00:00Z',16449,'UTC'],
['2025-01-02T17:00:00Z','2025-01-02T17:00:00Z',65558,'UTC'],
['2025-01-02T17:00:00Z','2025-01-04T17:00:00Z',65556,'UTC'],
['2025-01-02T17:00:00Z','2025-01-04T17:00:00Z',131092,'UTC'],
['2025-01-02T00:00:00Z','2025-01-03T00:00:00Z',20,'UTC'],
['2025-01-02T21:00:00Z','2025-01-03T00:00:00Z',65,'UTC'],
['2025-01-02T00:00:00Z','2025-01-03T00:00:00Z',65,'UTC'],
['2025-01-02T17:05:00Z','2025-01-02T17:05:00Z',8257,'America/New_York'],
] as const;
const expected = ["12:05 PM", "17:05", "5 – 7 PM", "Thursday, Jan 2, 2025", "Jan 2 – 4, 2025", "1/2/2025 – 1/4/2025", "January 2, 2025", "9:00 PM – 12:00 AM", "January 2, 2025 at 12:00 AM – January 3, 2025 at 12:00 AM", "5:05 PM"];
test("DateUtils matches Android date-range fields, zones and exclusive midnight ends", async () => {
  for (const [i, [a, b, flags, zone]] of cases.entries()) {
    const buffer = await newObj("java/lang/StringBuilder", "(Ljava/lang/String;)V", "prefix:");
    const formatter = await newObj("java/util/Formatter", "(Ljava/lang/Appendable;)V", buffer);
    const result = await vcall(rt.link("android/text/format/DateUtils").ctor, "formatDateRange", "(Landroid/content/Context;Ljava/util/Formatter;JJILjava/lang/String;)Ljava/util/Formatter;", null, formatter, BigInt(Date.parse(a)), BigInt(Date.parse(b)), flags, zone);
    expect(result).toBe(formatter);
    const text = await vcall(formatter, "toString", "()Ljava/lang/String;");
    if (typeof text !== "string") throw new Error("Formatter did not return text");
    // Android 35 fixtures; ICU versions differ in narrow versus ordinary spaces.
    expect(text.replace(/\s/g, " ")).toBe("prefix:" + expected[i]);
  }
});
