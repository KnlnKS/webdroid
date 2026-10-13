import { expect, test } from "bun:test";
import { rt } from "../src/jvm/runtime";
import { TS_SPECS, tsSpecAllowance, tsSpecViolation } from "../src/jvm/provenance";
import "../src/natives";

test("TS specs in libcore's namespaces are on the allowlist, and every entry is used", () => {
  const specs = [...rt.natives.keys()];
  expect(specs.filter((n) => tsSpecViolation(n, false))).toEqual([]);
  const used = new Set(specs.map(tsSpecAllowance));
  expect(Object.keys(TS_SPECS).filter((k) => !used.has(k))).toEqual([]);
});
