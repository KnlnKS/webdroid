import { expect, test } from "bun:test";
import { ServiceRecords, type ServiceRestart, type ServiceState } from "./servicerecords";
import { uptimeMillis } from "../guest-clock";

const intent = { bytes: new Uint8Array(0), objects: [] };
const state = (s: Partial<ServiceState>): ServiceState => ({ intent, startRequested: true, stopIfKilled: false, lastStartId: 1, starts: [], foreground: false, ...s });
function records() {
  const restarts: ServiceRestart[] = [], gone: string[] = [], attached: string[] = [];
  const r = new ServiceRecords((_pkg, _process, restart) => restarts.push(restart), (binding) => gone.push(binding.key), (_pkg, _process, cls, binding) => attached.push(cls + " " + binding.key));
  const record = (cls: string) => (r as any).records.get("p/" + cls);
  const delay = (cls: string) => Math.round((record(cls).nextRestart - uptimeMillis()) / 100) * 100;
  return { r, restarts, gone, attached, record, delay, dispose: () => { for (const x of (r as any).records.values()) clearTimeout(x.timer); } };
}

test("a killed process's services restart as killServicesLocked decides, spaced and backed off", () => {
  const { r, restarts, gone, record, delay, dispose } = records();
  r.report("p", "p", "Sticky", state({}));
  r.report("p", "p", "NotSticky", state({ stopIfKilled: true }));
  r.report("p", "p", "Bound", state({ startRequested: false }));
  r.bind("p", "p", "Bound", { client: 2, key: "2/a", intent, flags: 1 });
  r.report("p", "p", "Unwanted", state({ startRequested: false }));
  r.bind("p", "p", "Unwanted", { client: 2, key: "2/b", intent, flags: 0 });
  r.processDied("p", "p");
  expect([delay("Sticky"), delay("Bound")]).toEqual([1000, 11000]);
  expect([record("NotSticky"), record("Unwanted")]).toEqual([undefined, undefined]);
  expect(gone).toEqual(["2/b"]);
  // the process starting again brings them up: a sticky start, a binding
  r.processStarted("p", "p");
  expect(restarts.map((x) => [x.state?.startRequested, x.binds.map((b) => b.key)])).toEqual([[true, []], [false, ["2/a"]]]);
  // dying again within a minute of the restart quadruples the delay
  r.report("p", "p", "Sticky", state({}));
  r.processDied("p", "p");
  expect(delay("Sticky")).toBe(4000);
  // the last auto-create binding going cancels its restart
  r.unbind("2/a");
  expect(record("Bound")).toBeUndefined();
  dispose();
});

test("an unfinished start is redelivered after twice the time it ran", () => {
  const { r, restarts, delay, dispose } = records();
  r.report("p", "p", "Redeliver", state({ stopIfKilled: true, starts: [{ id: 1, intent, deliveries: 1, done: 1, delivered: uptimeMillis() - 3000 }] }));
  r.report("p", "p", "Spent", state({ stopIfKilled: true, starts: [{ id: 1, intent, deliveries: 3, done: 0, delivered: uptimeMillis() }] }));
  r.processDied("p", "p");
  expect(delay("Redeliver")).toBe(6000);
  expect((r as any).records.has("p/Spent")).toBe(false);
  r.processStarted("p", "p");
  expect(restarts[0].state?.starts.map((si) => si.delivered)).toEqual([null]);
  dispose();
});

test("a force stop brings the package's services down for good", () => {
  const { r, restarts, gone, record, dispose } = records();
  r.report("p", "p", "Sticky", state({}));
  r.bind("p", "p", "Sticky", { client: 2, key: "2/a", intent, flags: 1 });
  r.forceStop("p");
  r.processDied("p", "p");
  r.processStarted("p", "p");
  expect([record("Sticky"), restarts.length, gone]).toEqual([undefined, 0, ["2/a"]]);
  dispose();
});

test("crashes count against a process's services until they stop being restarted", () => {
  const { r, record, delay, dispose } = records();
  r.report("p", "p", "Sticky", state({}));
  r.report("p", "p", "Foreground", state({ foreground: true }));
  r.processDied("p", "p", { crashed: true, repeated: false });
  expect([record("Sticky").crashCount, delay("Sticky")]).toEqual([1, 1000]);
  // a crash again within MIN_CRASH_INTERVAL of the restart: BOUND_SERVICE_CRASH_RESTART_DURATION per crash
  r.processStarted("p", "p");
  r.processDied("p", "p", { crashed: true, repeated: false });
  expect([record("Sticky").crashCount, delay("Sticky")]).toEqual([2, 30 * 60_000]);
  // AppErrors' repeated crash removes the process without restarts, unless a foreground service was started
  r.processStarted("p", "p");
  r.report("p", "p", "Sticky", state({}));
  r.processDied("p", "p", { crashed: true, repeated: true });
  expect(record("Sticky").timer).not.toBeNull();
  for (let crashes = record("Foreground").crashCount; crashes < 16; crashes++) {
    r.processStarted("p", "p");
    r.processDied("p", "p", { crashed: true, repeated: true });
  }
  expect([record("Foreground"), record("Sticky")]).toEqual([undefined, undefined]);
  dispose();
});

test("a process starting takes the bindings waiting on its services, as they were left", () => {
  const { r, attached, record, dispose } = records();
  r.bind("p", "p", "Lazy", { client: 2, key: "2/a", intent, flags: 0 });
  r.processStarted("p", "p");
  r.processDied("p", "p");
  r.processStarted("p", "p");
  expect(attached).toEqual(["Lazy 2/a", "Lazy 2/a"]);
  expect(record("Lazy").bindings.size).toBe(1);
  dispose();
});
