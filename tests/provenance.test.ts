import { expect, test } from "vite-plus/test";
import { rt } from "../src/jvm/runtime.ts";
import { TS_SPECS, tsSpecAllowance, tsSpecViolation } from "../src/jvm/provenance.ts";
import "../src/natives.ts";

test("TS specs in libcore's namespaces are on the allowlist, and every entry is used", () => {
  const specs = [...rt.natives.keys()];
  expect(specs.filter((n) => tsSpecViolation(n, false))).toEqual([]);
  const used = new Set(specs.map(tsSpecAllowance));
  expect(Object.keys(TS_SPECS).filter((k) => !used.has(k))).toEqual([]);
});
