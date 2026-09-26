import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { onMain } from "../src/android/mainloop";

rt.linkNatives();

class InitListener extends JObj {
  statuses: number[] = [];
  [mangleMethod("onInit", "(I)V")](status: number) { this.statuses.push(status); }
}

test("TextToSpeech reports the unavailable browser service", async () => {
  const init = new InitListener();
  const tts = await newObj("android/speech/tts/TextToSpeech",
    "(Landroid/content/Context;Landroid/speech/tts/TextToSpeech$OnInitListener;Ljava/lang/String;)V", null, init, null);
  await new Promise((resolve) => setTimeout(resolve, 0)); await onMain(() => {});
  expect(init.statuses).toEqual([-1]);
  expect(await vcall(tts, "setLanguage", "(Ljava/util/Locale;)I", null)).toBe(-1);
  expect(await vcall(tts, "speak", "(Ljava/lang/CharSequence;ILandroid/os/Bundle;Ljava/lang/String;)I", "hello", 1, null, "one")).toBe(-1);
});
