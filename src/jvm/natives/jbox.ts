// java.lang's boxes run from libcore. TS makes and reads them through these helpers, over each
// class's own `value` field.
import { mangleField } from "../abi.ts";
import { classNameOf } from "./jentry.ts";

type Obj = Record<string, any>;
export type BoxDesc = "I" | "J" | "F" | "D" | "Z" | "C" | "B" | "S";
const CLASS: Record<BoxDesc, string> = {
  I: "java/lang/Integer", J: "java/lang/Long", F: "java/lang/Float", D: "java/lang/Double",
  Z: "java/lang/Boolean", C: "java/lang/Character", B: "java/lang/Byte", S: "java/lang/Short",
};
const DESC = new Map(Object.entries(CLASS).map(([d, c]) => [c, d as BoxDesc]));
const VALUE = Object.fromEntries(Object.entries(CLASS).map(([d, c]) => [d, mangleField(c, "value")])) as Record<BoxDesc, string>;

/** the primitive descriptor of a box, null for anything else */
export function boxDesc(o: unknown): BoxDesc | null {
  if (typeof o !== "object" || o === null) return null;
  return DESC.get(classNameOf(o) ?? "") ?? null;
}
/** a box's primitive value (a Boolean's as 0/1), undefined for anything else */
export function unbox(o: unknown): number | bigint | undefined {
  const d = boxDesc(o);
  return d === null ? undefined : (o as Obj)[VALUE[d]];
}

/** Java's own boxes, which valueOf makes without suspending (wasm/host/boot.ts) */
export const wasmBox = { make: null as ((desc: BoxDesc, v: number | bigint) => unknown) | null };
/** the box `valueOf(v)` of the `desc` class gives */
export function box(desc: BoxDesc, v: number | bigint | boolean): Obj {
  return wasmBox.make!(desc, typeof v === "boolean" ? +v : v) as Obj;
}
export const boxInt = (v: number) => box("I", v);
export const boxLong = (v: bigint) => box("J", v);
export const boxFloat = (v: number) => box("F", v);
export const boxDouble = (v: number) => box("D", v);
export const boxBool = (v: number | boolean) => box("Z", v);
