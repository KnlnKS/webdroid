// Throwables a handler discards skip their stack capture (src/jvm/discard.ts).
import { expect, test } from "bun:test";
import "../src/natives";
import { mangleMethod } from "../src/jvm/abi";
import { DexFile } from "../src/jvm/dex";
import { rt } from "../src/jvm/runtime";
import { loadLibcore } from "./java";

rt.linkNatives();
await loadLibcore();

test("a throwable its handler discards skips its capture; one read or escaping keeps it", async () => {
  const R = rt.fork();
  R.loadDex(new DexFile(new Uint8Array(await Bun.file(import.meta.dir + "/fixtures/DiscardProbe.dex").arrayBuffer())));
  const info = R.link("DiscardProbe");
  await R.initClass(info);
  // Past 32 calls a method compiles hot, once what it reaches is linked. Whether the last call's
  // throwables took their stacks:
  const captured = async (name: string, desc: string) => {
    for (let i = 0; i < 40; i++) await info.ctor[mangleMethod(name, desc)]("x");
    rt.throwables = [];
    await info.ctor[mangleMethod(name, desc)]("x");
    return rt.throwables.map((t) => (t as { jsErr: unknown }).jsErr !== null);
  };
  try {
    expect(await captured("ignored", "(Ljava/lang/String;)I")).toEqual([false]);
    expect(await captured("traced", "(Ljava/lang/String;)Ljava/lang/String;")).toEqual([true]);
    expect(await captured("escaped", "(Ljava/lang/String;)Ljava/lang/String;")).toEqual([true]);
    expect(rt.quiet.types).toBeNull();
  } finally { rt.throwables = null; }
});
