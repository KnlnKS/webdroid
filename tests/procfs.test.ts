import { expect, test } from "bun:test";
import "../src/natives";
import { setProcessIdentity, setProcessName } from "../src/android/os";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("Java and native-facing procfs expose the current process cmdline", async () => {
  setProcessIdentity(2468, 10001);
  setProcessName("com.example.app");
  for (const path of ["/proc/self/cmdline", "/proc/2468/cmdline"]) {
    const file = await newObj("java/io/File", "(Ljava/lang/String;)V", path);
    expect(await vcall(file, "exists", "()Z")).toBe(1);
    const stream = await newObj("java/io/FileInputStream", "(Ljava/io/File;)V", file);
    const bytes = new Int8Array(64);
    const length = await vcall(stream, "read", "([B)I", bytes);
    expect(new TextDecoder().decode(new Uint8Array(bytes.buffer, 0, length))).toBe("com.example.app\0");
  }
  expect(await vcall(await newObj("java/io/File", "(Ljava/lang/String;)V", "/proc/9999/cmdline"), "exists", "()Z")).toBe(0);
});
