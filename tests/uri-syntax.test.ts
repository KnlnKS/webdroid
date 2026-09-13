import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
test("URI syntax exceptions preserve input, reason and optional index", async () => {
  const error = await newObj("java/net/URISyntaxException", "(Ljava/lang/String;Ljava/lang/String;I)V", "a b", "Illegal character", 1);
  expect(await vcall(error, "getMessage", "()Ljava/lang/String;")).toBe("Illegal character at index 1: a b");
  expect(await vcall(error, "getInput", "()Ljava/lang/String;")).toBe("a b");
  expect(await vcall(error, "getReason", "()Ljava/lang/String;")).toBe("Illegal character");
  expect(await vcall(error, "getIndex", "()I")).toBe(1);
});
test("URI parses relative authorities without URL normalization", async () => {
  for (const [text, host, port, path] of [
    ["//API.example.com:443/a%20b", "API.example.com", 443, "/a b"],
    ["//example.com:0", "example.com", 0, ""],
    ["//[::1]:443/", "[::1]", 443, "/"],
    ["dns:///example.com", null, -1, "/example.com"],
    ["mailto:a@example.com", null, -1, null],
  ]) {
    const uri = await newObj("java/net/URI", "(Ljava/lang/String;)V", text);
    expect(await vcall(uri, "getHost", "()Ljava/lang/String;")).toBe(host);
    expect(await vcall(uri, "getPort", "()I")).toBe(port);
    expect(await vcall(uri, "getPath", "()Ljava/lang/String;")).toBe(path);
  }
});
test("URI component construction quotes delimiters and retains empty query and fragment", async () => {
  const uri = await newObj("java/net/URI", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V", "https", "example.com:443", "/a b?c", "", "");
  expect(await vcall(uri, "toString", "()Ljava/lang/String;")).toBe("https://example.com:443/a%20b%3Fc?#");
  expect(await vcall(uri, "getPath", "()Ljava/lang/String;")).toBe("/a b?c");
  expect(await vcall(uri, "getQuery", "()Ljava/lang/String;")).toBe("");
});
