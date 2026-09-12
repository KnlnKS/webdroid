import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
import { dialName, syntheticAddress } from "../src/shell/relay";

rt.linkNatives();
const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);

test("InetAddress hands out the resolver's synthetic address, which dials the name again", async () => {
  const a = await scall("java/net/InetAddress", "getByName", "(Ljava/lang/String;)Ljava/net/InetAddress;", "v16m.example.com");
  const text = await vcall(a, "getHostAddress", "()Ljava/lang/String;");
  expect(text).toMatch(/^198\.1[89]\.\d+\.\d+$/);
  expect(text).toBe(syntheticAddress("v16m.example.com").join("."));
  expect(await vcall(a, "toString", "()Ljava/lang/String;")).toBe("v16m.example.com/" + text);
  expect(rt.iof(a, "java/net/Inet4Address")).toBeTruthy();
  const bytes = await vcall(a, "getAddress", "()[B");
  const back = await scall("java/net/InetAddress", "getByAddress", "([B)Ljava/net/InetAddress;", bytes);
  expect(await vcall(back, "getHostName", "()Ljava/lang/String;")).toBe("v16m.example.com");
  expect(await vcall(back, "equals", "(Ljava/lang/Object;)Z", a)).toBe(1);
  expect(dialName(text)).toBe("v16m.example.com");
  expect(dialName("93.184.216.34")).toBe("93.184.216.34");
  const literal = await scall("java/net/InetAddress", "getByName", "(Ljava/lang/String;)Ljava/net/InetAddress;", "127.0.0.1");
  expect(await vcall(literal, "isLoopbackAddress", "()Z")).toBe(1);
  expect(await vcall(literal, "getHostAddress", "()Ljava/lang/String;")).toBe("127.0.0.1");
});
