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

test("an activity launched by a background service restores the previous foreground process", async () => {
  const broker = new ProcessBroker(), names = ["test.foreground.app", "test.background.service", "test.permission.activity"], events: string[] = [];
  for (const [i, pkg] of names.entries()) {
    const root: XmlNode = { name: "manifest", attrs: [{ name: "package", ns: "", resId: 0, type: TV.STRING, data: 0, str: pkg }], children: [] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), "/" + pkg, 25000 + i, async () => []));
    broker.connect(pkg, pkg, 35000 + i);
  }
  const data = { bytes: new Uint8Array(), objects: [] }, finished = Promise.withResolvers<void>();
  let activityId = 0;
  for (let pid = 35000; pid <= 35002; pid++) broker.ready(pid, {
    service: async () => null, provider: async () => { throw new Error("unused"); },
    transact: async () => ({ handled: 0, data }), broadcast: async (_i, _c, _o, result) => result,
    activity: async request => {
      events.push(pid + ":" + (request.kind === "visibility" ? request.phase : request.kind));
      if (request.kind === "launch") activityId = request.id;
      if (request.kind === "result") finished.resolve();
    },
  });
  try {
    broker.foreground(35000);
    const intent = { action: "test", component: null, componentPkg: null, dataUri: null, typeStr: null, pkg: null, flags: 0, categories: [], extras: data };
    await broker.launchActivity(35001, names[2], names[2], "test.PermissionActivity", intent, 7);
    await broker.finishActivity(35002, activityId, -1, null);
    await finished.promise;
    expect(events).toEqual(["35000:pause", "35002:launch", "35000:stop", "35000:resume", "35001:result"]);
    expect(broker.back(35000)).toBe(false);
  } finally { for (const [i, pkg] of names.entries()) { broker.fail(35000 + i, "fixture complete"); packages.delete(pkg); } }
});

test("system PendingIntents and alarms survive creator death and retain creator identity", async () => {
  const broker = new ProcessBroker(), names = ["test.pending.creator", "test.pending.holder"];
  for (const [i, pkg] of names.entries()) {
    const root: XmlNode = { name: "manifest", attrs: [{ name: "package", ns: "", resId: 0, type: TV.STRING, data: 0, str: pkg }], children: [] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), "/" + pkg, 26000 + i, async () => []));
    broker.connect(pkg, pkg, 36000 + i);
  }
  const data = { bytes: new Uint8Array(), objects: [] }, delivered = Promise.withResolvers<void>();
  const intent = { action: "test.PENDING", component: null, componentPkg: null, dataUri: null, typeStr: null, pkg: null, flags: 0, categories: [], extras: data };
  const endpoint: ProcessEndpoint = {
    activity: async () => {}, provider: async () => { throw new Error("unused"); },
    transact: async () => ({ handled: 0, data }), broadcast: async (_i, _c, _o, result) => result,
    service: async request => {
      if (request.kind !== "pending") throw new Error("unexpected service request");
      expect(request.operation.uid).toBe(26000);
      expect(request.operation.pkg).toBe(names[0]);
      expect(request.operation.intent.action).toBe("test.PENDING");
      expect(request.alarmCount).toBe(1);
      delivered.resolve(); return null;
    },
  };
  let restarted = 0;
  try {
    broker.ready(36000, endpoint); broker.ready(36001, endpoint);
    expect(() => broker.createPending(36001, names[0], "broadcast", 1, 0, intent)).toThrow();
    const id = broker.createPending(36000, names[0], "broadcast", 1, 0, intent)!;
    expect(() => broker.cancelPending(36001, id)).toThrow();
    intent.action = "changed after creation";
    broker.alarms.schedule(id, 1, Date.now(), 0);
    broker.fail(36000, "creator stopped");
    const descriptor = await broker.transact(36001, { handle: { pid: 0, id }, code: 0x5f4e5446, flags: 0, data });
    expect(descriptor.handled).toBe(1);
    expect(await broker.transact(36001, { handle: { pid: 0, id }, code: 42, flags: 0, data })).toEqual({ handled: 0, data });
    const replacement = broker.connect(names[0], names[0], 36002); restarted = replacement.pid;
    expect(restarted).not.toBe(36000);
    broker.ready(restarted, endpoint);
    await delivered.promise;
    broker.cancelPending(restarted, id);
    expect(await broker.intents.send(id)).toBe(false);
    const stale = broker.createPending(restarted, names[0], "broadcast", 2, 0, intent)!;
    packages.delete(names[0]);
    await expect(broker.intents.send(stale)).rejects.toBeTruthy();
    broker.intents.cancel(stale);
  } finally {
    for (const pid of [36000, 36001, restarted]) if (pid) broker.fail(pid, "fixture complete");
    for (const pkg of names) packages.delete(pkg);
  }
});

test("client process death releases remote service bindings", async () => {
  const broker = new ProcessBroker(), names = ["test.binding.client", "test.binding.server"], events: string[] = [];
  const released = Promise.withResolvers<void>(), data = { bytes: new Uint8Array(), objects: [] };
  for (const [i, pkg] of names.entries()) {
    const root: XmlNode = { name: "manifest", attrs: [{ name: "package", ns: "", resId: 0, type: TV.STRING, data: 0, str: pkg }], children: [] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), "/" + pkg, 28000 + i, async () => []));
    broker.connect(pkg, pkg, 38000 + i);
    broker.ready(38000 + i, {
      activity: async () => {}, provider: async () => { throw new Error("unused"); },
      transact: async () => ({ handled: 0, data }), broadcast: async (_i, _c, _o, result) => result,
      service: async request => { events.push(request.kind); if (request.kind === "unbind") setTimeout(released.resolve, 0); return null; },
    });
  }
  try {
    const intent = { action: "test.BIND", component: null, componentPkg: null, dataUri: null, typeStr: null, pkg: null, flags: 0, categories: [], extras: data };
    await broker.service(38000, names[1], names[1], { kind: "bind", key: "38000:1", intent });
    broker.fail(38000, "client stopped");
    await released.promise;
    expect(events).toEqual(["bind", "unbind"]); expect(broker.alive(38001)).toBe(true);
  } finally { for (const [i, pkg] of names.entries()) { broker.fail(38000 + i, "fixture complete"); packages.delete(pkg); } }
});
