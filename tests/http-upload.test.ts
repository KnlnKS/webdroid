import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
test("HTTP connect leaves the upload writable and response accessors share one request", async () => {
  const original = globalThis.fetch;
  const requests: { method: string; body: number[] }[] = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push({ method: init!.method!, body: [...init!.body as Uint8Array] });
    await Promise.resolve();
    return new Response("ok", { status: 200, statusText: "OK", headers: { "Content-Type": "application/binary", "X-Example": "value" } });
  }) as typeof fetch;
  try {
    const url = await newObj("java/net/URL", "(Ljava/lang/String;)V", "https://example.test/upload");
    const connection = await vcall(url, "openConnection", "()Ljava/net/URLConnection;");
    await vcall(connection, "setDoOutput", "(Z)V", 1);
    const output = await vcall(connection, "getOutputStream", "()Ljava/io/OutputStream;");
    await vcall(connection, "connect", "()V");
    expect(requests).toEqual([]);
    await vcall(output, "write", "([BII)V", Int8Array.of(0, 1, -1, 2), 1, 2);
    await vcall(output, "close", "()V");
    expect(await Promise.all([
      vcall(connection, "getResponseCode", "()I"),
      vcall(connection, "getResponseMessage", "()Ljava/lang/String;"),
    ])).toEqual([200, "OK"]);
    expect(requests).toEqual([{ method: "POST", body: [1, 255] }]);
    const headers = new Map<string, string>();
    expect(await vcall(connection, "getHeaderFieldKey", "(I)Ljava/lang/String;", 0)).toBeNull();
    expect(await vcall(connection, "getHeaderField", "(I)Ljava/lang/String;", 0)).toBe("HTTP/1.1 200 OK");
    for (let i = 1; ; i++) {
      const key = await vcall(connection, "getHeaderFieldKey", "(I)Ljava/lang/String;", i);
      if (key === null) break;
      headers.set(key.toLowerCase(), await vcall(connection, "getHeaderField", "(I)Ljava/lang/String;", i));
    }
    expect(headers.get("content-type")).toBe("application/binary");
    expect(headers.get("x-example")).toBe("value");
    expect(await vcall(connection, "getHeaderField", "(Ljava/lang/String;)Ljava/lang/String;", null)).toBe("HTTP/1.1 200 OK");
    await expect(vcall(connection, "getOutputStream", "()Ljava/io/OutputStream;")).rejects.toMatchObject({ msg: "Cannot write output after reading input" });
  } finally { globalThis.fetch = original; }
});
