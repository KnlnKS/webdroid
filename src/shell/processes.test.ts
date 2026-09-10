import { expect, test } from "bun:test";
import "../natives";
import { ProcessBroker, type ProcessEndpoint } from "./processes";
import { packages, PackageRecord } from "../android/packages";
import { Resources } from "../android/res";
import { TV, type XmlNode } from "../android/axml";
import { rt } from "../jvm/runtime";

test("process broker allows nested transactions and rejects pending work on process death", async () => {
  const broker = new ProcessBroker(), names = ["test.process.first", "test.process.second"];
  for (const [i, pkg] of names.entries()) {
    const root: XmlNode = { name: "manifest", attrs: [{ name: "package", ns: "", resId: 0, type: TV.STRING, data: 0, str: pkg }], children: [] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), "/" + pkg, 20000 + i, async () => []));
    broker.connect(pkg, pkg, 30000 + i);
  }
  const data = { bytes: new Uint8Array(), objects: [] }, events: number[] = [];
  const endpoint = (pid: number): ProcessEndpoint => ({
    activity: async () => {},
    service: async () => null,
    provider: async () => { throw new Error("Unused provider"); },
    broadcast: async (_intent, _component, _ordered, result) => result,
    transact: async (request, caller) => {
      events.push(caller.uid);
      if (request.code === 1) return broker.transact(pid, { handle: { pid: 30000, id: 1 }, code: 2, flags: 0, data });
      if (request.code === 3) return new Promise(() => {});
      return { handled: 1, data };
    },
  });
  try {
    broker.ready(30000, endpoint(30000)); broker.ready(30001, endpoint(30001));
    const result = await broker.transact(30000, { handle: { pid: 30001, id: 1 }, code: 1, flags: 0, data });
    expect(result.handled).toBe(1); expect(events).toEqual([20000, 20001]);
    let deaths = 0; broker.watch(30001, () => deaths++);
    const pending = broker.transact(30000, { handle: { pid: 30001, id: 1 }, code: 3, flags: 0, data });
    const failure = pending.catch((error: unknown) => rt.iof(error, "android/os/DeadObjectException"));
    await Promise.resolve(); broker.fail(30001, "Fixture process stopped");
    expect(await failure).toBe(1); expect(broker.alive(30001)).toBe(false); expect(deaths).toBe(1);
    broker.fail(30001, "Repeated stop"); expect(deaths).toBe(1);
    await expect(broker.transact(30000, { handle: { pid: 30001, id: 1 }, code: 2, flags: 0, data })).rejects.toBeTruthy();
  } finally { for (const pkg of names) packages.delete(pkg); broker.fail(30000, "Fixture complete"); }
});

test("remote activity lifecycle and Back return a serialized result to the caller", async () => {
  const broker = new ProcessBroker(), names = ["test.activity.first", "test.activity.second"], events: string[] = [];
  for (const [i, pkg] of names.entries()) {
    const root: XmlNode = { name: "manifest", attrs: [{ name: "package", ns: "", resId: 0, type: TV.STRING, data: 0, str: pkg }], children: [] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), "/" + pkg, 21000 + i, async () => []));
    broker.connect(pkg, pkg, 31000 + i);
  }
  const intent = { action: "test", component: null, componentPkg: null, dataUri: null, typeStr: null, pkg: null, flags: 0, categories: [], extras: { bytes: new Uint8Array(), objects: [] } };
  let finish!: () => void;
  const result = new Promise<void>((resolve) => { finish = resolve; });
  let id = 0;
  const endpoint = (pid: number): ProcessEndpoint => ({
    service: async () => null, provider: async () => { throw new Error("Unused provider"); },
    broadcast: async (_intent, _component, _ordered, data) => data,
    transact: async () => ({ handled: 0, data: intent.extras }),
    activity: async (request) => {
      events.push(pid + ":" + (request.kind === "visibility" ? request.phase : request.kind));
      if (request.kind === "launch") {
        id = request.id;
        expect(request.intent).toEqual(intent);
        expect(request.caller).toEqual({ pkg: names[0], cls: "test/Caller" });
      } else if (request.kind === "back") broker.finishActivity(pid, id, -1, intent);
      else if (request.kind === "result") {
        expect(request.request).toBe(7); expect(request.code).toBe(-1); expect(request.data).toEqual(intent);
        setTimeout(finish, 0);
      }
    },
  });
  try {
    broker.foreground(31000);
    broker.ready(31000, endpoint(31000)); broker.ready(31001, endpoint(31001));
    await broker.launchActivity(31000, names[1], names[1], "test/Activity", intent, 7, "test/Caller");
    expect(broker.back(31000)).toBe(true);
    await result;
    expect(events).toEqual(["31000:pause", "31001:launch", "31000:stop", "31001:back", "31000:resume", "31000:result"]);
    expect(broker.back(31000)).toBe(false);
  } finally { for (const [i, pkg] of names.entries()) { broker.fail(31000 + i, "Fixture complete"); packages.delete(pkg); } }
});

test("device boot reaches eligible non-exported receivers once", async () => {
  const broker = new ProcessBroker(), names = ["test.boot.allowed", "test.boot.denied"], reached: string[] = [];
  for (const [i, pkg] of names.entries()) {
    const attribute = (name: string, str: string) => ({ name, ns: "", resId: 0, type: TV.STRING, data: 0, str });
    const receiver: XmlNode = { name: "receiver", attrs: [attribute("name", pkg + ".Receiver"), { name: "exported", ns: "", resId: 0, type: TV.BOOLEAN, data: 0, str: null }], children: [
      { name: "intent-filter", attrs: [], children: [{ name: "action", attrs: [attribute("name", "android.intent.action.BOOT_COMPLETED")], children: [] }] },
    ] };
    const root: XmlNode = { name: "manifest", attrs: [attribute("package", pkg)], children: [
      { name: "application", attrs: [], children: [receiver] },
      ...(i ? [] : [{ name: "uses-permission", attrs: [attribute("name", "android.permission.RECEIVE_BOOT_COMPLETED")], children: [] }]),
    ] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), "/" + pkg, 22000 + i, async () => []));
    broker.connect(pkg, pkg, 32000 + i);
    broker.ready(32000 + i, {
      activity: async () => {}, service: async () => null, provider: async () => { throw new Error("Unused provider"); },
      transact: async () => ({ handled: 0, data: { bytes: new Uint8Array(), objects: [] } }),
      broadcast: async (intent, component, _ordered, result) => {
        expect(intent.action).toBe("android.intent.action.BOOT_COMPLETED");
        if (component) reached.push(component);
        return result;
      },
    });
  }
  try {
    await broker.boot(); await broker.boot();
    expect(reached).toEqual([names[0] + ".Receiver"]);
  } finally { for (const [i, pkg] of names.entries()) { broker.fail(32000 + i, "Fixture complete"); packages.delete(pkg); } }
});
