import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { newObj, vcall } from "../jvm/natives/jlang";
import { JContext } from "./context";
import { JIntent } from "./intent";
import { registerReceiver, unregisterReceiver } from "./broadcast";
import { uptimeMillis } from "./os";
import { onMain } from "./mainloop";

test("alarms deliver broadcasts on both clocks, replace equivalent operations and honor cancellation", async () => {
  const context = new JContext(), intent = new JIntent(); intent.action = "test.ALARM";
  const events: unknown[] = [], receiver = await newObj("android/content/BroadcastReceiver");
  receiver[mangleMethod("onReceive", "(Landroid/content/Context;Landroid/content/Intent;)V")] = (_context: JContext, delivered: JIntent) => {
    events.push(delivered.extras.map.get("android.intent.extra.ALARM_COUNT"));
  };
  registerReceiver(context, receiver, { actions: [intent.action] });
  const manager = await newObj("android/app/AlarmManager");
  const get = () => vcall(rt.link("android/app/PendingIntent").ctor, "getBroadcast", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 71, intent, 0x2000000);
  const operation = await get();
  const set = (type: number, time: number, pending = operation) => vcall(manager, "setExactAndAllowWhileIdle", "(IJLandroid/app/PendingIntent;)V", type, BigInt(Math.floor(time)), pending);
  const drain = async () => { await Bun.sleep(40); await onMain(() => {}); };
  try {
    await set(2, uptimeMillis() + 5000);
    await set(2, uptimeMillis(), await get());
    await drain(); expect(events).toEqual([1]);
    await set(1, Date.now());
    await drain(); expect(events).toEqual([1, 1]);
    await set(3, uptimeMillis() + 20);
    await vcall(manager, "cancel", "(Landroid/app/PendingIntent;)V", await get());
    await drain(); expect(events).toHaveLength(2);
    await set(0, Date.now() + 20);
    await vcall(operation, "cancel", "()V");
    await drain(); expect(events).toHaveLength(2);
    await expect(set(4, Date.now())).rejects.toMatchObject({ msg: "Invalid alarm type" });
  } finally {
    await vcall(manager, "cancel", "(Landroid/app/PendingIntent;)V", operation);
    await vcall(operation, "cancel", "()V"); unregisterReceiver(receiver);
  }
});
