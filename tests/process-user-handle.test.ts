import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("Process returns the canonical handle for its Android user", async () => {
  const process = rt.link("android/os/Process").ctor;
  const userHandle = rt.link("android/os/UserHandle").ctor;
  const current = await vcall(process, "myUserHandle", "()Landroid/os/UserHandle;");
  const byUid = await vcall(userHandle, "getUserHandleForUid", "(I)Landroid/os/UserHandle;", 10001);
  expect(current).toBe(byUid);
  expect(await vcall(current, "getIdentifier", "()I")).toBe(0);
  const secondary = await vcall(userHandle, "getUserHandleForUid", "(I)Landroid/os/UserHandle;", 1_012_345);
  expect(await vcall(secondary, "getIdentifier", "()I")).toBe(10);
});
