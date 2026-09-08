import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";
import { newObj, vcall } from "../jvm/natives/jlang";

test("network detail states and capabilities describe the same modeled Wi-Fi connection", async () => {
  const manager = await newObj("android/net/ConnectivityManager");
  const info = await vcall(manager, "getActiveNetworkInfo", "()Landroid/net/NetworkInfo;");
  expect(await vcall(info, "isConnected", "()Z")).toBe(1);
  expect(await vcall(info, "getType", "()I")).toBe(1);
  expect(await vcall(info, "getSubtype", "()I")).toBe(0);
  expect(await vcall(info, "getTypeName", "()Ljava/lang/String;")).toBe("WIFI");
  expect(await vcall(info, "getSubtypeName", "()Ljava/lang/String;")).toBe("");
  expect(await vcall(info, "getExtraInfo", "()Ljava/lang/String;")).toBeNull();
  const detailed = await vcall(info, "getDetailedState", "()Landroid/net/NetworkInfo$DetailedState;");
  expect(await vcall(detailed, "name", "()Ljava/lang/String;")).toBe("CONNECTED");
  expect(await vcall(detailed, "ordinal", "()I")).toBe(5);
  expect(await vcall(await vcall(info, "getState", "()Landroid/net/NetworkInfo$State;"), "name", "()Ljava/lang/String;")).toBe("CONNECTED");
  const active = await vcall(manager, "getActiveNetwork", "()Landroid/net/Network;");
  const handle = await vcall(active, "getNetworkHandle", "()J");
  const fromHandle = rt.link("android/net/Network").ctor[mangleMethod("fromNetworkHandle", "(J)Landroid/net/Network;")];
  const copy = fromHandle(handle), unknown = fromHandle(handle + (1n << 32n));
  expect(await vcall(copy, "equals", "(Ljava/lang/Object;)Z", active)).toBe(1);
  expect(await vcall(copy, "getNetworkHandle", "()J")).toBe(handle);
  expect(await vcall(manager, "getNetworkInfo", "(Landroid/net/Network;)Landroid/net/NetworkInfo;", unknown)).toBeNull();
  expect(await vcall(manager, "getNetworkCapabilities", "(Landroid/net/Network;)Landroid/net/NetworkCapabilities;", null)).toBeNull();
  const caps = await vcall(manager, "getNetworkCapabilities", "(Landroid/net/Network;)Landroid/net/NetworkCapabilities;", copy);
  expect(await vcall(caps, "hasTransport", "(I)Z", 1)).toBe(1);
  expect(await vcall(caps, "hasTransport", "(I)Z", 0)).toBe(0);
  expect(await vcall(caps, "hasCapability", "(I)Z", 12)).toBe(1);
  for (const capability of [0, 4, 16, 999]) expect(await vcall(caps, "hasCapability", "(I)Z", capability)).toBe(0);
  expect(await vcall(manager, "bindProcessToNetwork", "(Landroid/net/Network;)Z", unknown)).toBe(0);
  expect(await vcall(manager, "bindProcessToNetwork", "(Landroid/net/Network;)Z", copy)).toBe(1);
  expect(await vcall(manager, "getBoundNetworkForProcess", "()Landroid/net/Network;")).toBe(copy);
  await vcall(manager, "bindProcessToNetwork", "(Landroid/net/Network;)Z", null);
  expect(await vcall(manager, "getBoundNetworkForProcess", "()Landroid/net/Network;")).toBeNull();
});

class Callback extends rt.link("android/net/ConnectivityManager$NetworkCallback").ctor {
  events: string[] = []; done = Promise.withResolvers<void>();
}
rt.register({ name: "webdroid/NetworkTestCallback", ctor: Callback, sup: "android/net/ConnectivityManager$NetworkCallback", methods: {
  "onAvailable(Landroid/net/Network;)V": function (this: Callback) { this.events.push("available"); },
  "onCapabilitiesChanged(Landroid/net/Network;Landroid/net/NetworkCapabilities;)V": function (this: Callback) { this.events.push("capabilities"); this.done.resolve(); },
} });

test("network callback overload posts through the supplied handler and honors unregistration", async () => {
  const manager = await newObj("android/net/ConnectivityManager"), handler = await newObj("android/os/Handler");
  const callback = await newObj("webdroid/NetworkTestCallback") as Callback;
  const queued: unknown[] = [];
  handler[mangleMethod("post", "(Ljava/lang/Runnable;)Z")] = (task: unknown) => { queued.push(task); return 1; };
  await vcall(manager, "registerDefaultNetworkCallback", "(Landroid/net/ConnectivityManager$NetworkCallback;Landroid/os/Handler;)V", callback, handler);
  expect(callback.events).toEqual([]); expect(queued.length).toBe(1);
  await vcall(queued.shift(), "run", "()V"); await callback.done.promise;
  expect(callback.events).toEqual(["available", "capabilities"]);
  await vcall(manager, "registerDefaultNetworkCallback", "(Landroid/net/ConnectivityManager$NetworkCallback;Landroid/os/Handler;)V", callback, handler);
  await vcall(manager, "unregisterNetworkCallback", "(Landroid/net/ConnectivityManager$NetworkCallback;)V", callback);
  await vcall(queued.shift(), "run", "()V");
  expect(callback.events).toEqual(["available", "capabilities"]);
});
