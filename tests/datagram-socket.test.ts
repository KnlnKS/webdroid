import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

test("DatagramSocket delivers loopback packets and preserves source metadata", async () => {
  const receiver = await newObj("java/net/DatagramSocket", "()V");
  const sender = await newObj("java/net/DatagramSocket", "()V");
  const port = await vcall(receiver, "getLocalPort", "()I") as number;
  const loopback = await vcall(rt.link("java/net/InetAddress").ctor, "getByName", "(Ljava/lang/String;)Ljava/net/InetAddress;", "localhost");
  const outgoing = await newObj("java/net/DatagramPacket", "([BILjava/net/InetAddress;I)V", new Int8Array([4, 5, 6]), 3, loopback, port);
  await vcall(sender, "send", "(Ljava/net/DatagramPacket;)V", outgoing);
  const incoming = await newObj("java/net/DatagramPacket", "([BI)V", new Int8Array(8), 8);
  await vcall(receiver, "receive", "(Ljava/net/DatagramPacket;)V", incoming);
  expect(await vcall(incoming, "getLength", "()I")).toBe(3);
  expect(Array.from((await vcall(incoming, "getData", "()[B") as Int8Array).subarray(0, 3))).toEqual([4, 5, 6]);
  expect(await vcall(incoming, "getPort", "()I")).toBe(await vcall(sender, "getLocalPort", "()I"));
  await vcall(sender, "close", "()V");
  await vcall(receiver, "close", "()V");
});
