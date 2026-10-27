// java.util's collections run from libcore. TS builds and reads the ones it exchanges with Java
// through their Java API, an ArrayMap by its own fields.
import { mangleField } from "../abi.ts";
import { driven, type Gen } from "../runtime.ts";
import { vcall, newObj } from "./jentry.ts";

type Obj = Record<string, any>;

/** a Java collection of class `cls` holding `items`, added in order; a sized one is made with their count as its capacity */
const newCollection = driven(function* newCollection(cls: string, items: unknown[], sized: boolean): Gen<Obj> {
  const c = yield (sized ? newObj(cls, "(I)V", items.length) : newObj(cls, "()V"));
  for (const item of items) yield vcall(c, "add", "(Ljava/lang/Object;)Z", item);
  return c;
});
/** A java.util.ArrayList containing `items` in order. */
export const newArrayList = (items: unknown[] = []): PromiseOrVal<Obj> => newCollection("java/util/ArrayList", items, true);
export const newLinkedHashSet = (items: Iterable<unknown>) => newCollection("java/util/LinkedHashSet", [...items], false);

/** a Java Collection's elements, in its iteration order; their type, which Java's generics erase,
 *  is the caller's to assert */
export function toJsArray(c: unknown): PromiseOrVal<unknown[]> {
  return c === null || c === undefined ? [] : iterateAll(c);
}
const iterateAll = driven(function* iterateAll(c: unknown): Gen<unknown[]> {
  const out: unknown[] = [];
  const it = yield vcall(c, "iterator", "()Ljava/util/Iterator;");
  while (yield vcall(it, "hasNext", "()Z")) out.push(yield vcall(it, "next", "()Ljava/lang/Object;"));
  return out;
});

const AM = "android/util/ArrayMap", AM_ARRAY = mangleField(AM, "mArray"), AM_SIZE = mangleField(AM, "mSize");
/** an android.util.ArrayMap's entries, by its own fields */
export function arrayMapEntries(map: Obj): [unknown, unknown][] {
  const array = map[AM_ARRAY], out: [unknown, unknown][] = [];
  for (let i = 0; i < map[AM_SIZE]; i++) out.push([array[2 * i], array[2 * i + 1]]);
  return out;
}
