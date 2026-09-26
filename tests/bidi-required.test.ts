import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
const chars = (s: string) => Uint16Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const requires = (s: string, start = 0, limit = s.length) => vcall(rt.link("java/text/Bidi").ctor, "requiresBidi", "([CII)Z", chars(s), start, limit);
test("bidi analysis detects RTL scripts, numbers, embeddings and supplementary characters", async () => {
  for (const text of ["Ferry Building", "", "東京 123", "A😀B"]) expect(await requires(text)).toBe(0);
  for (const text of ["AאB", "العربية", "١", "\u202b", "\u202e", "𞤀"]) expect(await requires(text)).toBe(1);
  expect(await requires("אabcא", 1, 4)).toBe(0);
  expect(await requires("𞤀", 0, 1)).toBe(0);
});
test("bidi analysis validates the requested range", async () => {
  await expect((async () => requires("abc", -1, 2))()).rejects.toMatchObject({ msg: "Invalid text range" });
  await expect((async () => requires("abc", 2, 1))()).rejects.toMatchObject({ msg: "Invalid text range" });
  await expect((async () => requires("abc", 0, 4))()).rejects.toMatchObject({ msg: "Invalid text range" });
});
