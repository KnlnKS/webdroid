import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
const stringify = (a: unknown[] | null) => vcall(rt.link("java/util/Arrays").ctor, "deepToString", "([Ljava/lang/Object;)Ljava/lang/String;", a);
test("deep array strings distinguish cycles from shared arrays and format primitive elements", async () => {
  const shared = ["value"], a: unknown[] = [shared, shared];
  a.push(a, new Uint16Array([65, 66]), new Uint8Array([1, 0]), new Float32Array([1.5, 2]), new BigInt64Array([9n]), null);
  expect(await stringify(a)).toBe("[[value], [value], [...], [A, B], [true, false], [1.5, 2.0], [9], null]");
  expect(await stringify(null)).toBe("null");
});
