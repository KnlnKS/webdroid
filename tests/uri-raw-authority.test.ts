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
  const relative = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "//example.test/path");
  expect(await vcall(relative, "getRawAuthority", "()Ljava/lang/String;")).toBe("example.test");
  const opaque = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "mailto:user@example.test");
  expect(await vcall(opaque, "getRawAuthority", "()Ljava/lang/String;")).toBeNull();
  const empty = scall("java/net/URI", "create", "(Ljava/lang/String;)Ljava/net/URI;", "file:///tmp/video.mp4");
  expect(await vcall(empty, "getRawAuthority", "()Ljava/lang/String;")).toBeNull();
});
