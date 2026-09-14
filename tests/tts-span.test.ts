import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();

test("TtsSpan builders preserve pronunciation arguments and parcel values", async () => {
  for (const name of ["Text", "Verbatim"]) {
    const builder = await newObj(`android/text/style/TtsSpan$${name}Builder`, "(Ljava/lang/String;)V", "Golden Gate Bridge");
    const span = await vcall(builder, "build", "()Landroid/text/style/TtsSpan;");
    expect(await vcall(span, "getType", "()Ljava/lang/String;")).toBe("android.type." + name.toLowerCase());
    const args = await vcall(span, "getArgs", "()Landroid/os/PersistableBundle;");
    expect(await vcall(args, "getString", "(Ljava/lang/String;)Ljava/lang/String;", "android.arg." + name.toLowerCase())).toBe("Golden Gate Bridge");
    const parcel = await vcall(rt.link("android/os/Parcel").ctor, "obtain", "()Landroid/os/Parcel;");
    await vcall(span, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
    await vcall(parcel, "setDataPosition", "(I)V", 0);
    const copy = await newObj("android/text/style/TtsSpan", "(Landroid/os/Parcel;)V", parcel);
    const copyArgs = await vcall(copy, "getArgs", "()Landroid/os/PersistableBundle;");
    expect(await vcall(copyArgs, "getString", "(Ljava/lang/String;)Ljava/lang/String;", "android.arg." + name.toLowerCase())).toBe("Golden Gate Bridge");
    await vcall(parcel, "recycle", "()V");
  }
});
