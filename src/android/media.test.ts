import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { mangleMethod } from "../jvm/abi";

test("default ringtone URIs identify settings with Android type-mask precedence", async () => {
  const manager = rt.link("android/media/RingtoneManager").ctor;
  const get = manager[mangleMethod("getDefaultUri", "(I)Landroid/net/Uri;")];
  for (const [type, setting] of [[1, "ringtone"], [2, "notification_sound"], [4, "alarm_alert"], [7, "ringtone"], [6, "notification_sound"]] as const) {
    const uri = get(type);
    expect(await vcall(uri, "toString", "()Ljava/lang/String;")).toBe("content://settings/system/" + setting);
  }
  expect(get(0)).toBeNull(); expect(get(8)).toBeNull();
});

test("audio attribute builds are independent values with normalized notification usage", async () => {
  rt.link("android/media/AudioAttributes");
  const builder = await newObj("android/media/AudioAttributes$Builder");
  const build = () => vcall(builder, "build", "()Landroid/media/AudioAttributes;");
  await vcall(builder, "setUsage", "(I)Landroid/media/AudioAttributes$Builder;", 14);
  await vcall(builder, "setContentType", "(I)Landroid/media/AudioAttributes$Builder;", 4);
  const game = await build(), copy = await build();
  expect(await vcall(game, "equals", "(Ljava/lang/Object;)Z", copy)).toBe(1);
  expect(await vcall(game, "hashCode", "()I")).toBe(await vcall(copy, "hashCode", "()I"));
  await vcall(builder, "setUsage", "(I)Landroid/media/AudioAttributes$Builder;", 8);
  const notification = await build();
  expect(await vcall(notification, "getUsage", "()I")).toBe(5);
  expect(await vcall(game, "getUsage", "()I")).toBe(14);
  expect(await vcall(game, "getContentType", "()I")).toBe(4);
  expect(await vcall(game, "equals", "(Ljava/lang/Object;)Z", notification)).toBe(0);
  await expect(vcall(builder, "setUsage", "(I)Landroid/media/AudioAttributes$Builder;", 17)).rejects.toMatchObject({ msg: "Invalid usage 17" });
  await expect(vcall(builder, "setContentType", "(I)Landroid/media/AudioAttributes$Builder;", -1)).rejects.toMatchObject({ msg: "Invalid content type -1" });
  const poolBuilder = await newObj("android/media/SoundPool$Builder");
  expect(await vcall(poolBuilder, "setAudioAttributes", "(Landroid/media/AudioAttributes;)Landroid/media/SoundPool$Builder;", game)).toBe(poolBuilder);
  const pool = await vcall(poolBuilder, "build", "()Landroid/media/SoundPool;");
  expect(pool.audioAttributes).toBe(game);
  rt.link("android/media/SoundPool");
  await vcall(pool, "release", "()V");
});
