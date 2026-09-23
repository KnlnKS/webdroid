import { expect, test } from "bun:test";
import { isWebdroidProcessFrame } from "./lib/processes";

test("only live webdroid frames require diagnostics", () => {
  const origin = "http://localhost:4197";
  expect(isWebdroidProcessFrame("", origin)).toBe(false);
  expect(isWebdroidProcessFrame("about:blank", origin)).toBe(false);
  expect(isWebdroidProcessFrame("https://example.com/", origin)).toBe(false);
  expect(isWebdroidProcessFrame(`${origin}/process?pid=1001`, origin)).toBe(true);
  expect(isWebdroidProcessFrame(`${origin}/?screen=1080x2160`, origin)).toBe(true);
});
