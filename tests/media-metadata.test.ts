import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("MediaMetadata builder preserves text and long values", async () => {
  const builder = await newObj("android/media/MediaMetadata$Builder");
  await vcall(builder, "putText", "(Ljava/lang/String;Ljava/lang/CharSequence;)Landroid/media/MediaMetadata$Builder;", "title", "Big Buck Bunny");
  await vcall(builder, "putLong", "(Ljava/lang/String;J)Landroid/media/MediaMetadata$Builder;", "duration", 636000n);
  const metadata = await vcall(builder, "build", "()Landroid/media/MediaMetadata;");
  expect(await vcall(metadata, "getText", "(Ljava/lang/String;)Ljava/lang/CharSequence;", "title")).toBe("Big Buck Bunny");
  expect(await vcall(metadata, "getLong", "(Ljava/lang/String;)J", "duration")).toBe(636000n);
  expect(await vcall(metadata, "containsKey", "(Ljava/lang/String;)Z", "missing")).toBe(0);
});
