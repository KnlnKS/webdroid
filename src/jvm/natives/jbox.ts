// java.lang's boxes run from libcore. TS makes and reads them through these helpers, over each
// class's own `value` field.
import { PRIMS, mangleField } from "../abi.ts";
import { classNameOf } from "./jentry.ts";
import { java } from "../javahost.ts";

type Obj = Record<string, any>;
export type BoxDesc = "I" | "J" | "F" | "D" | "Z" | "C" | "B" | "S";
const DESC = new Map(Object.entries(PRIMS).map(([d, p]) => [p.box, d as BoxDesc]));
const VALUE = Object.fromEntries(Object.entries(PRIMS).map(([d, p]) => [d, mangleField(p.box, "value")])) as Record<BoxDesc, string>;

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

/** the box `valueOf(v)` of the `desc` class gives, made without suspending */
export function box(desc: BoxDesc, v: number | bigint | boolean): Obj {
  return java.box(desc, typeof v === "boolean" ? +v : v) as Obj;
}
export const boxInt = (v: number) => box("I", v);
export const boxLong = (v: bigint) => box("J", v);
export const boxFloat = (v: number) => box("F", v);
export const boxDouble = (v: number) => box("D", v);
export const boxBool = (v: number | boolean) => box("Z", v);
