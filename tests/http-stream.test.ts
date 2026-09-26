import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
rt.linkNatives();

test("HTTP headers and incremental reads do not await the entire response, and timed-out reads remain usable", async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream<Uint8Array>({
    start(c) { controller = c; c.enqueue(Uint8Array.of(1, 2, 3)); },
  }), { headers: { "content-type": "application/octet-stream", "x-wd-content-length": "7", "x-wd-final-url": "https://example.test/stream" } }) });
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    original(new URL(String(input), server.url), init), { preconnect: original.preconnect });
  try {
    const url = await newObj("java/net/URL", "(Ljava/lang/String;)V", "https://example.test/stream");
    const connection = await vcall(url, "openConnection", "()Ljava/net/URLConnection;");
    await vcall(connection, "setReadTimeout", "(I)V", 30);
    expect(await vcall(connection, "getResponseCode", "()I")).toBe(200);
    expect(await vcall(connection, "getContentLength", "()I")).toBe(7);
    const stream = await vcall(connection, "getInputStream", "()Ljava/io/InputStream;");
    const out = new Int8Array(5);
    expect(await vcall(stream, "read", "([BII)I", out, 1, 2)).toBe(2);
    expect([...out]).toEqual([0, 1, 2, 0, 0]);
    expect(await vcall(stream, "available", "()I")).toBe(1);
    expect(await vcall(stream, "read", "()I")).toBe(3);
    await expect(vcallAsync(stream, "read", "()I")).rejects.toMatchObject({ msg: "Read timed out" });
    if (!controller) throw new Error("No response stream");
    controller.enqueue(Uint8Array.of(4, 5, 6, 7));
    expect(await vcall(stream, "skip", "(J)J", 2n)).toBe(2n);
    expect(await vcall(stream, "read", "()I")).toBe(6);
    expect(await vcall(stream, "read", "()I")).toBe(7);
    controller.close();
    expect(await vcall(stream, "read", "()I")).toBe(-1);
    expect(await vcall(stream, "read", "([BII)I", out, 0, 0)).toBe(0);
    expect(await vcall(stream, "markSupported", "()Z")).toBe(0);
    await vcall(connection, "disconnect", "()V");
    await expect(vcallAsync(stream, "read", "()I")).rejects.toMatchObject({ msg: "Stream closed" });
  } finally { globalThis.fetch = original; server.stop(true); }
}, 5000);

test("HttpURLConnection preserves a redirect when following is disabled", async () => {
  const seen: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const query = new URL(request.url).searchParams;
    seen.push(query.get("manual") ?? "");
    return new Response(null, { headers: {
      "x-wd-status": "302", "x-wd-status-text": "Found", "x-wd-final-url": "https://example.test/start",
      location: "/next",
    } });
  } });
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    original(new URL(String(input), server.url), init), { preconnect: original.preconnect });
  try {
    const url = await newObj("java/net/URL", "(Ljava/lang/String;)V", "https://example.test/start");
    const connection = await vcall(url, "openConnection", "()Ljava/net/URLConnection;");
    await vcall(connection, "setInstanceFollowRedirects", "(Z)V", 0);
    expect(await vcall(connection, "getResponseCode", "()I")).toBe(302);
    expect(await vcall(connection, "getResponseMessage", "()Ljava/lang/String;")).toBe("Found");
    expect(await vcall(connection, "getHeaderField", "(Ljava/lang/String;)Ljava/lang/String;", null)).toBe("HTTP/1.1 302 Found");
    expect(await vcall(connection, "getHeaderField", "(Ljava/lang/String;)Ljava/lang/String;", "location")).toBe("/next");
    expect(await vcall(connection, "getHeaderField", "(Ljava/lang/String;)Ljava/lang/String;", "x-wd-status")).toBeNull();
    expect(seen).toEqual(["1"]);
  } finally { globalThis.fetch = original; server.stop(true); }
});
