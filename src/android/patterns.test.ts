import { rt } from "../jvm/runtime";
import { expect, test } from "bun:test";
import { mangleStaticField } from "../jvm/abi";
import { linkInit, vcall } from "../jvm/natives/jlang";
import "../jvm/natives/jtime";
import "./util";

test("Patterns.WEB_URL agrees with Java on the paired framework expression", async () => {
  const cls = (await linkInit("android/util/Patterns")).ctor;
  await linkInit("java/util/regex/Matcher");
  const pattern = Reflect.get(cls, mangleStaticField("WEB_URL"));
  // OpenJDK 26 Pattern.matches with the paired framework's unmodified expression.
  for (const [input, expected] of [
    ["https://example.com/a?b=c", true],
    ["HTTP://example.com", true],
    ["www.example.com", true],
    ["example.com", true],
    ["ftp://user:pass@example.com:1234/a", true],
    ["rtsp://example.com/a", true],
    ["https://例子.中国/a", true],
    ["https://example.com/💩", true],
    ["https://foo.💩", false],
    ["https://foo.\u2000com", false],
    ["https://foo.\u00a0com", false],
    ["127.0.0.1", true],
    ["256.1.2.3", false],
    ["hello@example.com", false],
    ["https://localhost", false],
    ["example.x", false],
    ["a".repeat(64) + ".com", false],
    ["https://foo.bar/a b", false],
    ["https://foo.bar:99999", true],
    ["https://foo.bar:100000", false],
    ["http://", false],
  ]) {
    const matcher = await vcall(pattern, "matcher", "(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;", input);
    expect(await vcall(matcher, "matches", "()Z")).toBe(expected ? 1 : 0);
  }
});

test("Patterns exposes the framework email and IP expressions", async () => {
  const cls = (await linkInit("android/util/Patterns")).ctor;
  await linkInit("java/util/regex/Matcher");
  for (const [name, good, bad] of [
    ["EMAIL_ADDRESS", "hello@example.com", "hello@"],
    ["IP_ADDRESS", "192.168.0.1", "256.168.0.1"],
  ]) {
    const pattern = Reflect.get(cls, mangleStaticField(name));
    for (const [input, expected] of [[good, 1], [bad, 0]]) {
      const matcher = await vcall(pattern, "matcher", "(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;", input);
      expect(await vcall(matcher, "matches", "()Z")).toBe(expected);
    }
  }
});

test("Matcher and its snapshot implement MatchResult without sharing subsequent matches", async () => {
  const cls = (await linkInit("java/util/regex/Pattern")).ctor;
  await linkInit("java/util/regex/Matcher");
  const pattern = await vcall(cls, "compile", "(Ljava/lang/String;)Ljava/util/regex/Pattern;", "[a-z]+");
  const matcher = await vcall(pattern, "matcher", "(Ljava/lang/CharSequence;)Ljava/util/regex/Matcher;", "first second");
  expect(await vcall(matcher, "find", "()Z")).toBe(1);
  const result = await vcall(matcher, "toMatchResult", "()Ljava/util/regex/MatchResult;");
  expect(rt.iof(matcher, "java/util/regex/MatchResult")).toBe(1);
  expect(rt.iof(result, "java/util/regex/MatchResult")).toBe(1);
  expect(await vcall(matcher, "find", "()Z")).toBe(1);
  expect(await vcall(result, "group", "()Ljava/lang/String;")).toBe("first");
  expect(await vcall(matcher, "group", "()Ljava/lang/String;")).toBe("second");
});
