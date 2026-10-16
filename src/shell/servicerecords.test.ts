import { expect, test } from "vite-plus/test";
import { ServiceRecords, type ServiceBinding, type StartItem } from "./servicerecords.ts";
import { uptimeMillis } from "../guest-clock.ts";

const intent = { bytes: new Uint8Array(0), objects: [] };
const NOT_CRASHED = { crashed: false, repeated: false };
function records() {
  const restarts: ServiceBinding[][] = [], gone: string[] = [], attached: string[] = [];
  const r = new ServiceRecords({
    send: (_client, _pkg, _process, request) => {
      if (request.kind === "restart") restarts.push(request.binds);
      if (request.kind === "bind") attached.push(request.cls + " " + request.key);
      return null;
    },
    connected: (client, key) => gone.push(client + "/" + key),
    persistent: () => false,
  });
  const starts = r.starts("p", "p");
  const record = (cls: string) => (r as any).records.get("p/" + cls);
  /** the hosting process created `cls`, with this start state */
  const report = (cls: string, state: { startRequested?: boolean; stopIfKilled?: boolean; foreground?: boolean; starts?: StartItem[] } = {}) => {
    starts.created(cls, intent);
    Object.assign(record(cls), { startRequested: true, lastStartId: 1, starts: [], ...state });
  };
  const bind = (cls: string, key: string, flags: number) => void r.request(2, "p", "p", { kind: "bind", cls, intent, key, flags });
  const delay = (cls: string) => Math.round((record(cls).nextRestart - uptimeMillis()) / 100) * 100;
  return { r, starts, restarts, gone, attached, record, report, bind, delay, dispose: () => { for (const x of (r as any).records.values()) clearTimeout(x.timer); } };
}

test("a killed process's services restart as killServicesLocked decides, spaced and backed off", () => {
  const { r, starts, restarts, gone, record, report, bind, delay, dispose } = records();
  report("Sticky");
  report("NotSticky", { stopIfKilled: true });
  report("Bound", { startRequested: false });
  bind("Bound", "a", 1);
  report("Unwanted", { startRequested: false });
  bind("Unwanted", "b", 0);
  r.processDied("p", "p", NOT_CRASHED);
  expect([delay("Sticky"), delay("Bound")]).toEqual([1000, 11000]);
  expect([record("NotSticky"), record("Unwanted")]).toEqual([undefined, undefined]);
  expect(gone).toEqual(["2/b"]);
  // the process starting again brings them up: a sticky start with a null intent, a binding
  r.processStarted("p", "p");
  expect(restarts.map((binds) => binds.map((b) => b.key))).toEqual([[], ["2/a"]]);
  expect(starts.deliver("Sticky").map((si) => [si.id, si.intent])).toEqual([[2, null]]);
  // dying again within a minute of the restart quadruples the delay
  report("Sticky");
  r.processDied("p", "p", NOT_CRASHED);
  expect(delay("Sticky")).toBe(4000);
  // the last auto-create binding going cancels its restart
  void r.request(2, "p", "p", { kind: "unbind", key: "a" });
  expect(record("Bound")).toBeUndefined();
  dispose();
});

test("an unfinished start is redelivered after twice the time it ran", () => {
  const { r, starts, report, delay, record, dispose } = records();
  report("Redeliver", { stopIfKilled: true, starts: [{ id: 1, intent, deliveries: 1, done: 1, delivered: uptimeMillis() - 3000 }] });
  report("Spent", { stopIfKilled: true, starts: [{ id: 1, intent, deliveries: 3, done: 0, delivered: uptimeMillis() }] });
  r.processDied("p", "p", NOT_CRASHED);
  expect(delay("Redeliver")).toBe(6000);
  expect(record("Spent")).toBeUndefined();
  r.processStarted("p", "p");
  expect(starts.deliver("Redeliver").map((si) => [si.id, si.deliveries])).toEqual([[1, 2]]);
  dispose();
});

test("a start finishes as onStartCommand's result and stopSelf decide", () => {
  const { starts, record, dispose } = records();
  starts.created("S", intent);
  const ids = [starts.start("S", intent), starts.start("S", intent), starts.start("S", intent)];
  expect(starts.deliver("S").map((si) => si.id)).toEqual(ids);
  expect([starts.done("S", 1, 1), starts.done("S", 2, 3), starts.done("S", 3, 7)]).toEqual([true, true, false]);
  expect([record("S").starts.map((si: StartItem) => [si.id, si.done]), record("S").stopIfKilled]).toEqual([[[2, 1], [3, 0]], true]);
  // stopSelf drops the starts delivered up to its id, and stops only at the last
  expect([starts.stopSelf("S", 2), record("S").starts.length, starts.requested("S")]).toEqual([false, 1, true]);
  expect([starts.stopSelf("S", 3), starts.requested("S")]).toEqual([true, false]);
  dispose();
});

test("a force stop brings the package's services down for good", () => {
  const { r, restarts, gone, record, report, bind, dispose } = records();
  report("Sticky");
  bind("Sticky", "a", 1);
  r.forceStop("p");
  r.processDied("p", "p", NOT_CRASHED);
  r.processStarted("p", "p");
  expect([record("Sticky"), restarts.length, gone]).toEqual([undefined, 0, ["2/a"]]);
  dispose();
});

test("crashes count against a process's services until they stop being restarted", () => {
  const { r, record, report, delay, dispose } = records();
  report("Sticky");
  report("Foreground", { foreground: true });
  r.processDied("p", "p", { crashed: true, repeated: false });
  expect([record("Sticky").crashCount, delay("Sticky")]).toEqual([1, 1000]);
  // a crash again within MIN_CRASH_INTERVAL of the restart: BOUND_SERVICE_CRASH_RESTART_DURATION per crash
  r.processStarted("p", "p");
  r.processDied("p", "p", { crashed: true, repeated: false });
  expect([record("Sticky").crashCount, delay("Sticky")]).toEqual([2, 30 * 60_000]);
  // AppErrors' repeated crash removes the process without restarts, unless a foreground service was started
  r.processStarted("p", "p");
  report("Sticky");
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
  const { r, attached, record, bind, dispose } = records();
  bind("Lazy", "a", 0);
  r.processStarted("p", "p");
  r.processDied("p", "p", NOT_CRASHED);
  r.processStarted("p", "p");
  expect(attached).toEqual(["Lazy 2/a", "Lazy 2/a", "Lazy 2/a"]);
  expect(record("Lazy").bindings.size).toBe(1);
  dispose();
});
