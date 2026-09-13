import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

let failure: { serviceType: string; code: number } | null = null;
let finish: (() => void) | null = null;
class DiscoveryListener extends JObj {}
rt.register({
  name: "test/DiscoveryListener", ctor: DiscoveryListener,
  ifaces: ["android/net/nsd/NsdManager$DiscoveryListener"],
  methods: {
    "onStartDiscoveryFailed(Ljava/lang/String;I)V": (serviceType: string, code: number) => {
      failure = { serviceType, code };
      finish?.();
    },
  },
});
rt.linkNatives();

test("NSD reports unavailable multicast discovery without fabricated services", async () => {
  const context = rt.make("android/content/Context");
  const manager = await vcall(context, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "servicediscovery");
  expect(manager).not.toBeNull();
  const callback = new Promise<void>((resolve) => { finish = resolve; });
  await vcall(manager, "discoverServices", "(Ljava/lang/String;ILandroid/net/nsd/NsdManager$DiscoveryListener;)V",
    "_googlecast._tcp.", 1, rt.make("test/DiscoveryListener"));
  await callback;
  expect(failure).toEqual({ serviceType: "_googlecast._tcp.", code: 0 });
});
