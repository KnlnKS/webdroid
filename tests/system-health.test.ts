import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { PROCESS_UID } from "../src/android/os";

rt.linkNatives();

test("system health exposes an empty UID snapshot without invented measurements", async () => {
  const context = rt.make("android/content/Context");
  const manager = await vcall(context, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "systemhealth");
  expect(manager).not.toBeNull();
  const snapshot = await vcall(manager, "takeUidSnapshot", "(I)Landroid/os/health/HealthStats;", PROCESS_UID);
  expect(await vcall(snapshot, "getDataType", "()Ljava/lang/String;")).toBe("UidHealthStats");
  expect(await vcall(snapshot, "hasMeasurement", "(I)Z", 10001)).toBe(0);
  expect(vcall(manager, "takeUidSnapshot", "(I)Landroid/os/health/HealthStats;", PROCESS_UID + 1)).rejects.toBeDefined();
});
