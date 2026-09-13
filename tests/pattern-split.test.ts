import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
const compile = (source: string) => rt.link("java/util/regex/Pattern").ctor[mangleMethod("compile", "(Ljava/lang/String;)Ljava/util/regex/Pattern;")](source);
const split = (pattern: unknown, input: string, limit: number) =>
  vcall(pattern, "split", "(Ljava/lang/CharSequence;I)[Ljava/lang/String;", input, limit);

test("Pattern.split honors positive, zero, and negative limits", async () => {
  const colon = compile(":"), letterO = compile("o");
  expect(Array.from(await split(colon, "boo:and:foo", 2))).toEqual(["boo", "and:foo"]);
  expect(Array.from(await split(colon, "one:two:three", 2))).toEqual(["one", "two:three"]);
  expect(Array.from(await split(letterO, "boo:and:foo", 0))).toEqual(["b", "", ":and:f"]);
  expect(Array.from(await vcall(letterO, "split", "(Ljava/lang/CharSequence;)[Ljava/lang/String;", "boo:and:foo"))).toEqual(["b", "", ":and:f"]);
  expect(Array.from(await split(letterO, "boo:and:foo", -1))).toEqual(["b", "", ":and:f", "", ""]);
  expect(Array.from(await split(colon, "boo:and:foo", 1))).toEqual(["boo:and:foo"]);
});

test("Pattern.split excludes captures and skips an initial zero-width match", async () => {
  expect(Array.from(await split(compile("(:)"), "a:b", -1))).toEqual(["a", "b"]);
  expect(Array.from(await split(compile("(?=b)"), "boo", -1))).toEqual(["boo"]);
  expect(Array.from(await split(compile("(?=o)"), "boo", -1))).toEqual(["b", "o", "o"]);
  expect(Array.from(await split(compile(":"), ":a", -1))).toEqual(["", "a"]);
});
