import { rt, type Gen } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { curThread, mainThread } from "../jvm/natives/jlang";
import type { NativeSpec } from "../jvm/runtime";
import type { JActivity } from "./app";
import { appHost } from "./apphost";
import { onMain } from "./mainloop";
import { reportUncaught } from "./os";

export type ActivityLifecycleCallback = object;
type LifecycleOwner = { lifecycleCbs: ActivityLifecycleCallback[] | null };
export type LifecyclePhase = "Created" | "Started" | "Resumed" | "Paused" | "Stopped" | "Destroyed";

const phaseBit: Record<LifecyclePhase, number> = {
  Created: 1,
  Started: 2,
  Resumed: 4,
  Paused: 8,
  Stopped: 16,
  Destroyed: 32,
};
const deliveries = new WeakMap<ActivityLifecycleCallback, WeakMap<JActivity, number>>();

function wasDelivered(callback: ActivityLifecycleCallback, activity: JActivity, phase: LifecyclePhase): boolean {
  return !!((deliveries.get(callback)?.get(activity) ?? 0) & phaseBit[phase]);
}

function markDelivered(callback: ActivityLifecycleCallback, activity: JActivity, phase: LifecyclePhase): void {
  let activities = deliveries.get(callback);
  if (!activities) deliveries.set(callback, activities = new WeakMap());
  activities.set(activity, (activities.get(activity) ?? 0) | phaseBit[phase]);
}

function invokeVariant(callback: ActivityLifecycleCallback, variant: string, signature: string, args: unknown[]): void | Promise<void> { return rt.drive(invokeVariant$(callback, variant, signature, args)); }
function* invokeVariant$(callback: ActivityLifecycleCallback, variant: string, signature: string, args: unknown[]): Gen<void> {
  const fn: unknown = Reflect.get(callback, mangleMethod(variant, signature));
  if (typeof fn !== "function") return;
  try {
    const result: unknown = Reflect.apply(fn, callback, args);
    if (result instanceof Promise) yield result;
  } catch (error) {
    reportUncaught(error);
  }
}

function catchUp(callback: ActivityLifecycleCallback, activity: JActivity, phase: "Started" | "Resumed"): void | Promise<void> { return rt.drive(catchUp$(callback, activity, phase)); }
function* catchUp$(callback: ActivityLifecycleCallback, activity: JActivity, phase: "Started" | "Resumed"): Gen<void> {
  markDelivered(callback, activity, phase);
  for (const variant of [`onActivityPre${phase}`, `onActivity${phase}`, `onActivityPost${phase}`])
    yield invokeVariant(callback, variant, "(Landroid/app/Activity;)V", [activity]);
}

/** Dispatch each framework stage to a fresh snapshot, matching Application's three dispatch passes. */
export function fireActivityLifecycle(activity: JActivity, phase: LifecyclePhase, bundle: unknown = null): void | Promise<void> { return rt.drive(fireActivityLifecycle$(activity, phase, bundle)); }
function* fireActivityLifecycle$(activity: JActivity, phase: LifecyclePhase, bundle: unknown = null): Gen<void> {
  const signature = phase === "Created"
    ? "(Landroid/app/Activity;Landroid/os/Bundle;)V"
    : "(Landroid/app/Activity;)V";
  const args = phase === "Created" ? [activity, bundle] : [activity];
  for (const variant of [`onActivityPre${phase}`, `onActivity${phase}`, `onActivityPost${phase}`]) {
    const callbacks = [
      ...(activity.$host?.application?.lifecycleCbs ?? []),
      ...(activity.lifecycleCbs ?? []),
    ];
    for (const callback of callbacks) {
      markDelivered(callback, activity, phase);
      yield invokeVariant(callback, variant, signature, args);
    }
  }
}

export const lifecycleCallbackMethods: NativeSpec["methods"] = {
  "registerActivityLifecycleCallbacks(Landroid/app/Application$ActivityLifecycleCallbacks;)V": function (this: LifecycleOwner, callback: ActivityLifecycleCallback) {
    (this.lifecycleCbs ??= []).push(callback);
    const activity = appHost?.currentActivity();
    // Cooperative background execution can finish after the corresponding main-queue transition.
    if (!activity || curThread === mainThread || (!activity.resumed && !activity.started)) return;
    void onMain(async () => {
      if (activity !== appHost?.currentActivity() || !this.lifecycleCbs?.includes(callback)) return;
      const phase = activity.resumed ? "Resumed" : "Started";
      if (!wasDelivered(callback, activity, phase)) await catchUp(callback, activity, phase);
    }).catch(reportUncaught);
  },
  "unregisterActivityLifecycleCallbacks(Landroid/app/Application$ActivityLifecycleCallbacks;)V": function (this: LifecycleOwner, callback: ActivityLifecycleCallback) {
    if (this.lifecycleCbs) this.lifecycleCbs = this.lifecycleCbs.filter((registered) => registered !== callback);
  },
};
