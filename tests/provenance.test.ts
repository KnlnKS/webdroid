import { expect, test } from "bun:test";
import { rt } from "../src/jvm/runtime";
import { TS_SPECS, tsSpecAllowance } from "../src/jvm/provenance";
import "../src/natives";

// §2: in libcore's namespaces AOSP's bytecode answers unless a TS spec is allowed there
const LIBCORE = /^(java|javax|jdk|sun|libcore|dalvik|android\/icu|org\/(json|xml|w3c|xmlpull)|com\/android\/(okhttp|org))\//;

test("TS specs in libcore's namespaces are on the allowlist, and every entry is used", () => {
  const specs = [...rt.natives.keys()];
  expect(specs.filter((n) => LIBCORE.test(n) && !tsSpecAllowance(n))).toEqual([]);
  const used = new Set(specs.map(tsSpecAllowance));
  expect(Object.keys(TS_SPECS).filter((k) => !used.has(k))).toEqual([]);
});
