import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
const scall = (cls: string, name: string, desc: string, ...args: unknown[]) =>
  (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);

test("URI.getRawAuthority preserves escaped authority text", async () => {
  const uri = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://user%20name@example.com:8443/a?q=1");
  expect(await vcall(uri, "getRawAuthority", "()Ljava/lang/String;")).toBe("user%20name@example.com:8443");
  expect(await vcall(uri, "getAuthority", "()Ljava/lang/String;")).toBe("user name@example.com:8443");
  const relative = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "//example.test/path");
  expect(await vcall(relative, "getRawAuthority", "()Ljava/lang/String;")).toBe("example.test");
  const opaque = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "mailto:user@example.test");
  expect(await vcall(opaque, "getRawAuthority", "()Ljava/lang/String;")).toBeNull();
  const empty = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "file:///tmp/video.mp4");
  expect(await vcall(empty, "getRawAuthority", "()Ljava/lang/String;")).toBeNull();
  expect(await vcall(empty, "getAuthority", "()Ljava/lang/String;")).toBeNull();
});

test("URI.getRawUserInfo preserves escaped credentials", async () => {
  const uri = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://user%20name:p%40ss@example.com/path");
  expect(await vcall(uri, "getRawUserInfo", "()Ljava/lang/String;")).toBe("user%20name:p%40ss");
  expect(await vcall(uri, "getUserInfo", "()Ljava/lang/String;")).toBe("user name:p@ss");
  const anonymous = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://example.com/path");
  expect(await vcall(anonymous, "getRawUserInfo", "()Ljava/lang/String;")).toBeNull();
});

test("URI.getRawQuery preserves the hierarchical query component", async () => {
  const escaped = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://example.test/a?name=a%20b&path=%2F#fragment");
  expect(await vcall(escaped, "getRawQuery", "()Ljava/lang/String;")).toBe("name=a%20b&path=%2F");
  const relative = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "a/b?x=1");
  expect(await vcall(relative, "getRawQuery", "()Ljava/lang/String;")).toBe("x=1");
  const empty = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://example.test/path?#fragment");
  expect(await vcall(empty, "getRawQuery", "()Ljava/lang/String;")).toBe("");
  const opaque = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "mailto:user@example.test?subject=hello");
  expect(await vcall(opaque, "getRawQuery", "()Ljava/lang/String;")).toBeNull();
});

test("URI.getRawFragment preserves escaped and empty fragments", async () => {
  const escaped = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "https://example.test/a?q=1#section%202%2F3");
  expect(await vcall(escaped, "getRawFragment", "()Ljava/lang/String;")).toBe("section%202%2F3");
  const opaque = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "mailto:user@example.test#contact%20card");
  expect(await vcall(opaque, "getRawFragment", "()Ljava/lang/String;")).toBe("contact%20card");
  const empty = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "relative#");
  expect(await vcall(empty, "getRawFragment", "()Ljava/lang/String;")).toBe("");
  const absent = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "relative");
  expect(await vcall(absent, "getRawFragment", "()Ljava/lang/String;")).toBeNull();
});
