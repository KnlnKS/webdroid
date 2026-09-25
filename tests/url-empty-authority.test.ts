import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("URL preserves Android's empty HTTP authority", async () => {
  for (const [spec, path, query] of [
    ["http://", "", null],
    ["http:///path", "/path", null],
    ["http://?query", "", "query"],
  ] as const) {
    const url = await newObj("java/net/URL", "(Ljava/lang/String;)V", spec);
    expect(await vcall(url, "getAuthority", "()Ljava/lang/String;")).toBe("");
    expect(await vcall(url, "getHost", "()Ljava/lang/String;")).toBe("");
    expect(await vcall(url, "getPath", "()Ljava/lang/String;")).toBe(path);
    expect(await vcall(url, "getQuery", "()Ljava/lang/String;")).toBe(query);
    expect(await vcall(url, "toString", "()Ljava/lang/String;")).toBe(spec);
  }
});
