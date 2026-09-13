import { expect, test } from "bun:test";
import "../src/natives";
import { systemService } from "../src/android/context";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("network stats expose an empty supported query", async () => {
  const context = rt.make("android/content/Context");
  const manager = systemService(context, "netstats");
  expect(rt.iof(manager, "android/app/usage/NetworkStatsManager")).toBe(1);
  const stats = await vcall(manager, "querySummary", "(ILjava/lang/String;JJ)Landroid/app/usage/NetworkStats;", 1, null, 0n, 1n);
  expect(await vcall(stats, "hasNextBucket", "()Z")).toBe(0);
  const bucket = await newObj("android/app/usage/NetworkStats$Bucket");
  expect(await vcall(stats, "getNextBucket", "(Landroid/app/usage/NetworkStats$Bucket;)Z", bucket)).toBe(0);
  expect(await vcall(bucket, "getUid", "()I")).toBe(-1);
  expect(await vcall(bucket, "getRxBytes", "()J")).toBe(0n);
  expect(await vcall(bucket, "getTxBytes", "()J")).toBe(0n);
});
