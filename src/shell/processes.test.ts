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
