import { expect, test } from "bun:test";
import "../src/natives";
import { JIntent } from "../src/android/intent";
import { encodeIntent } from "../src/android/intentipc";
import { PendingIntents } from "../src/shell/pendingintents";
import { JContext } from "../src/android/context";
import { vcall } from "../src/jvm/natives/jlang";
import { rt } from "../src/jvm/runtime";

const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => vcall(rt.link(cls).ctor, name, desc, ...args);

rt.linkNatives();

test("activity-stack pending intents match on the final intent and retain the preceding stack", async () => {
  const root = new JIntent(); root.component = "RootActivity";
  const detail = new JIntent(); detail.component = "DetailActivity";
  const rootData = await encodeIntent(root), detailData = await encodeIntent(detail);
  const sent: string[][] = [];
  const store = new PendingIntents(async operation => {
    sent.push([...operation.preceding.map(intent => intent.component ?? ""), operation.intent.component ?? ""]);
  });
  const operation = { pkg: "example", process: "example", uid: 10000, kind: "activity" as const,
    code: 7, flags: 0, intent: detailData, preceding: [rootData] };
  const first = store.create(operation);
  expect(first).not.toBeNull();
  expect(store.create({ ...operation, preceding: [] })).toBe(first);
  expect(await store.send(first ?? 0)).toBe(true);
  expect(sent).toEqual([["RootActivity", "DetailActivity"]]);
});

test("PendingIntent reports its stored operation type", async () => {
  const context = new JContext(), intent = new JIntent();
  const activity = await scall("android/app/PendingIntent", "getActivity", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 1, intent, 0x4000000);
  const broadcast = await scall("android/app/PendingIntent", "getBroadcast", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 1, intent, 0);
  const foreground = await scall("android/app/PendingIntent", "getForegroundService", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 1, intent, 0);
  expect(await vcall(activity, "isActivity", "()Z")).toBe(1);
  expect(await vcall(activity, "isBroadcast", "()Z")).toBe(0);
  expect(await vcall(activity, "isImmutable", "()Z")).toBe(1);
  expect(await vcall(broadcast, "isActivity", "()Z")).toBe(0);
  expect(await vcall(broadcast, "isBroadcast", "()Z")).toBe(1);
  expect(await vcall(foreground, "isForegroundService", "()Z")).toBe(1);
  expect(await vcall(foreground, "isService", "()Z")).toBe(0);
});
