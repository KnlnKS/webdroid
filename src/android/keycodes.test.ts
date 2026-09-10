import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";

test("KeyEvent parses platform names, optional prefixes and bounded numeric key codes", () => {
  const cls = rt.link("android/view/KeyEvent").ctor;
  const from = cls[mangleMethod("keyCodeFromString", "(Ljava/lang/String;)I")];
  for (const name of ["KEYCODE_ENTER", "ENTER", "66", "+066"]) expect(from(name)).toBe(66);
  expect(from("SCREENSHOT")).toBe(318);
  for (const name of ["enter", " 66", "-1", "319", "2147483648", "missing"]) expect(from(name)).toBe(0);
  expect(() => from(null)).toThrow();
  const normalize = cls[mangleMethod("normalizeMetaState", "(I)I")];
  expect(normalize(0x80 | 0x20 | 0x4000 | 0x40000)).toBe(0x550a3);
  expect(normalize(0x100 | 0x200 | 0x400 | 0x800)).toBe(0x100006);
  expect(normalize(0x80000000)).toBe(0);
});

test("KeyEvent combines dead keys and retains Android stroke compositions", () => {
  const dead = rt.link("android/view/KeyEvent").ctor[mangleMethod("getDeadChar", "(II)I")];
  expect(dead(96, 101)).toBe(232);
  expect(dead(94, 32)).toBe(94);
  expect(dead(94, 94)).toBe(94);
  expect(dead(39, 101)).toBe(233);
  expect(dead(45, 79)).toBe(216);
  expect(dead(45, 105)).toBe(0x268);
  expect(dead(94, 49)).toBe(0);
  expect(dead(0, 101)).toBe(0);
});
