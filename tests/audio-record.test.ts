import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("AudioRecord reports supported PCM buffer sizes without fabricating an input device", async () => {
  const audioRecord = rt.link("android/media/AudioRecord").ctor;
  expect(await vcall(audioRecord, "getMinBufferSize", "(III)I", 44100, 16, 2)).toBeGreaterThan(0);
  expect(await vcall(audioRecord, "getMinBufferSize", "(III)I", 44100, 0, 2)).toBe(-2);
  const record = await newObj("android/media/AudioRecord", "(IIIII)V", 6, 44100, 16, 2, 8820);
  expect(await vcall(record, "getState", "()I")).toBe(0);
  expect(await vcall(record, "getRecordingState", "()I")).toBe(1);
});
