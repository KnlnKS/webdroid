import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("LocalServerSocket accepts an in-process LocalSocket and streams bytes both ways", async () => {
  const server = await newObj("android/net/LocalServerSocket", "(Ljava/lang/String;)V", "wd.test.sock");
  await expect(newObj("android/net/LocalServerSocket", "(Ljava/lang/String;)V", "wd.test.sock")).rejects.toMatchObject({ constructor: rt.link("java/io/IOException").ctor });
  const accepted = vcall(server, "accept", "()Landroid/net/LocalSocket;");
  const client = await newObj("android/net/LocalSocket");
  await vcall(client, "connect", "(Landroid/net/LocalSocketAddress;)V", await newObj("android/net/LocalSocketAddress", "(Ljava/lang/String;)V", "wd.test.sock"));
  const peer = await accepted;
  expect(await vcall(client, "isConnected", "()Z")).toBe(1);
  const out = await vcall(client, "getOutputStream", "()Ljava/io/OutputStream;");
  await vcall(out, "write", "([B)V", Int8Array.from([1, 2, 3]));
  const input = await vcall(peer, "getInputStream", "()Ljava/io/InputStream;");
  const buf = new Int8Array(8);
  expect(await vcall(input, "read", "([BII)I", buf, 0, 8)).toBe(3);
  expect([...buf.subarray(0, 3)]).toEqual([1, 2, 3]);
  const back = await vcall(peer, "getOutputStream", "()Ljava/io/OutputStream;");
  await vcall(back, "write", "(I)V", 0x41);
  expect(await vcall(await vcall(client, "getInputStream", "()Ljava/io/InputStream;"), "read", "()I")).toBe(0x41);
  await vcall(client, "close", "()V");
  expect(await vcall(input, "read", "([BII)I", buf, 0, 8)).toBe(-1);
  await vcall(server, "close", "()V");
  const late = await newObj("android/net/LocalSocket");
  await expect(vcall(late, "connect", "(Landroid/net/LocalSocketAddress;)V", await newObj("android/net/LocalSocketAddress", "(Ljava/lang/String;)V", "wd.test.sock"))).rejects.toMatchObject({ constructor: rt.link("java/io/IOException").ctor });
});

test("collections are instances of their abstract supers", async () => {
  expect(rt.iof(await newObj("java/util/HashSet"), "java/util/AbstractCollection")).toBe(1);
  expect(rt.iof(await newObj("java/util/HashSet"), "java/util/AbstractSet")).toBe(1);
  expect(rt.iof(await newObj("java/util/ArrayList"), "java/util/AbstractList")).toBe(1);
  expect(rt.iof(await newObj("java/util/HashMap"), "java/util/AbstractMap")).toBe(1);
  expect(rt.iof(await newObj("java/util/Stack"), "java/util/Vector")).toBe(1);
});
