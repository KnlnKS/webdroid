import { expect, test } from "bun:test";
import { androidGroupId } from "./identity";
import { rt } from "../jvm/runtime";
import { linkInit } from "../jvm/natives/jlang";
import { mangleMethod } from "../jvm/abi";
import "../natives";

test("Android group lookup resolves numeric and platform identities without inventing unknown groups", () => {
  for (const [name, gid] of [["root", 0], ["system", 1000], ["media_rw", 1023], ["mediadrm", 1031], ["mediaex", 1040], ["mediacodec", 1046], ["inet", 3003], ["nobody", 9999], ["overflowuid", 65534], ["00042", 42], ["2147483648", -2147483648], ["4294967296", 0], ["99999999999999999999", -1]] as const) expect(androidGroupId(name)).toBe(gid);
  for (const name of ["", " ", "-1", "+1", "42x", "42\n", "42\u2028", "SYSTEM", "unknown", "constructor", "__proto__", "app", "app_start", "unused1", "media_codec"]) expect(androidGroupId(name)).toBe(-1);
});

test("Android group names respect multi-user group ranges and platform restrictions", () => {
  for (const [name, gid] of [["u0_a1234", 11234], ["u1_a1234", 111234], ["u0_a1234_cache", 21234], ["u2_a1234_ext", 231234], ["u2_a1234_ext_cache", 241234], ["all_a1234", 51234], ["u2_i1000", 291000], ["u1_system", 101000], ["u1000_a0", 100010000], ["u0_a10000", 20000], ["oem_2900", 2900], ["oem_5999", 5999], ["oem_2900suffix", 2900]] as const) expect(androidGroupId(name)).toBe(gid);
  for (const name of ["u0_system", "u1_root", "u1_audio", "u1001_a0", "u0_a", "u0_a0\n", "u1_a0_extra", "all_a10000", "all_a0_cache", "u1_a40000", "u0_a50000", "u0_i10000", "oem_3000", "oem_6000"]) expect(androidGroupId(name)).toBe(-1);
});

test("Process.getGidForName exposes lookup and preserves Java null failure", async () => {
  const process = (await linkInit("android/os/Process")).ctor;
  const get = process[mangleMethod("getGidForName", "(Ljava/lang/String;)I")];
  expect(get("")).toBe(-1); expect(get("inet")).toBe(3003);
  expect(() => get(null)).toThrow(rt.link("java/lang/NullPointerException").ctor);
});
