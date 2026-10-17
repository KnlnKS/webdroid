import { expect, test } from "vite-plus/test";
import { JThread } from "../jvm/natives/jentry.ts";
import { Cpu, setA64 } from "./cpu.ts";
import { defineHost, ldp } from "./host.ts";
import { libCalls } from "./calls.testkit.ts";
import { mem } from "./mem.ts";
import { aaudioInit } from "./aaudio.ts";

test("AAudio copies builder settings and exposes actual stream state at either pointer width", async () => {
  for (const a64 of [false, true]) {
    setA64(a64); aaudioInit();
    const cpu = new Cpu(new JThread(), "aaudio-test"), out = mem.malloc(16);
    const call = libCalls(cpu, "libaaudio.so");
    let stream = 0, builder = 0;
    try {
      expect(await call("AAudio_createStreamBuilder", out)).toBe(0); builder = ldp(out);
      await call("AAudioStreamBuilder_setDirection", builder, 1);
      expect(await call("AAudioStreamBuilder_openStream", builder, out + 8)).toBe(-889);
      expect(ldp(out + 8)).toBe(0);
      await call("AAudioStreamBuilder_setDirection", builder, 0);
      await call("AAudioStreamBuilder_setDataCallback", builder, defineHost("test:audio", () => 1), 0);
      await call("AAudioStreamBuilder_setSampleRate", builder, 24000);
      await call("AAudioStreamBuilder_setSessionId", builder, 0);
      expect(await call("AAudioStreamBuilder_openStream", builder, out + 8)).toBe(0); stream = ldp(out + 8);
      await call("AAudioStreamBuilder_setSampleRate", builder, 48000);
      expect(await call("AAudioStream_getSampleRate", stream)).toBe(24000);
      expect(await call("AAudioStream_getSessionId", stream)).toBeGreaterThan(0);
      expect(await call("AAudioStream_waitForStateChange", stream, 3, out, 0n)).toBe(0);
      expect(mem.ld32(out)).toBe(2);
      expect(await call("AAudioStream_waitForStateChange", stream, 2, out, 0n)).toBe(-885);
    } finally {
      if (stream) await call("AAudioStream_close", stream);
      if (builder) await call("AAudioStreamBuilder_delete", builder);
      mem.free(out); cpu.dispose();
    }
  }
  setA64(false);
});
