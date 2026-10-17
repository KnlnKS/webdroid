import { expect, test } from "vite-plus/test";
import { nodeCommand, run } from "../scripts/node.ts";

// Each fixture drives the activity manager in a process of its own, whose app identity and
// registered binders it sets up from scratch.
async function fixture(name: string): Promise<unknown> {
  const { stdout } = await run(...nodeCommand(new URL(`fixtures/${name}.ts`, import.meta.url).pathname));
  return JSON.parse(stdout.toString().trim().split("\n").at(-1)!);
}

test("the activity manager drives a process's services and ordered receivers through its IApplicationThread", async () => {
  expect(await fixture("activity-manager")).toEqual({
    started: "org.webdroid.test.am.Svc", bound: 1,
    // created once, its start delivered, the binding the client waits on requested
    up: ["create org.webdroid.test.am.Svc", "args 1", "bind 0"],
    // the second client of the same intent hears the published binder without another onBind
    connected: ["published 0", "published 0"],
    // still started: only the binding goes, and only the last start id stops it
    unbound: ["unbind"], staleStop: 0, stop: 1, down: ["stop"],
    concurrent: { second: 1, firstFinished: false, creates: 1 },
    ordered: { calls: ["receive a", "receive b", "receive abort"], code: 3, data: "ababort", aborted: true },
    foreign: [],
    copied: { proxy: "android/app/IActivityManager$Stub$Proxy", same: false, size: 0 },
    tooLarge: "android/os/TransactionTooLargeException: data parcel size 2097512 bytes",
  });
}, 120_000);

test("another process's provider is reached through the binder it publishes", async () => {
  expect(await fixture("remote-provider")).toEqual({
    owner: true,
    // the package manager's provider, from the owner's process
    asked: ["org.webdroid.test.owner org.webdroid.test.owner org.webdroid.test.owner.data"],
    proxy: "android/content/ContentProviderProxy",
    // rows cross in a CursorWindow beside an IBulkCursor binder
    columns: ["key", "value"], rows: [["a", "1"], ["b", "null"]],
    // a writable descriptor crosses as its bytes; its writes return to the provider's
    read: "hello", written: ["bye"],
  });
}, 120_000);


test("routed back awaits its process acknowledgment and preserves queue order after failure", async () => {
  const { ActivityStack } = await import("../src/shell/activitystack.ts");
  const entry = {pid:1001} as import("../src/shell/processes.ts").Entry;
  const first = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let calls = 0, available = true;
  const stack = new ActivityStack({entry:()=>{if(!available)throw new Error("target died");return entry;},alive:()=>true,entries:()=>[entry],connect:()=>entry,rotate:async()=>{},
    activity:async (_entry,request)=>{expect(request.kind).toBe("back");calls++;
      if(calls===1){entered.resolve();await first.promise;} else if(calls===2)throw new Error("owner back failure");}},false);
  stack.setForeground(entry.pid);
  expect(stack.back(entry.pid)).toBeNull();
  let done=false;
  const back=stack.back(1000)!.then(()=>{done=true;});
  await entered.promise;
  const failed=stack.back(1000)!;
  const rejection=failed.then(()=>"unexpected success",error=>error.message);
  expect(done).toBe(false);expect(calls).toBe(1);
  first.resolve();await back;expect(await rejection).toBe("owner back failure");
  available=false;
  expect(await stack.back(1000)!.then(()=>"unexpected success",error=>error.message)).toBe("target died");
  expect(calls).toBe(2);
  expect(await stack.bringToFront(1002).then(()=>"unexpected success",error=>error.message)).toBe("target died");
  available=true;await stack.back(1000);expect(calls).toBe(3);expect(done).toBe(true);
});

test("a physical rotation reaches the process whose activity fills the display, and the display follows its turn", async () => {
  const { ActivityStack } = await import("../src/shell/activitystack.ts");
  const app = {pid:1001,landscape:false} as import("../src/shell/processes.ts").Entry;
  const followed: boolean[] = [], requests: unknown[] = [];
  const turned = Promise.withResolvers<void>();
  const stack: InstanceType<typeof ActivityStack> = new ActivityStack({entry:()=>app,alive:()=>true,entries:()=>[app],connect:()=>app,
    rotate:async(entry)=>{await turned.promise;followed.push(entry.landscape!);},
    activity:async(_entry,request)=>{requests.push(request);
      // the app's own display turns, and it reports that before it answers
      if(request.kind==="rotate")stack.orientation(app.pid,request.landscape);}},false);
  stack.setForeground(app.pid);
  expect(stack.rotate(app.pid,true)).toBeNull();
  let done=false;
  const rotated=stack.rotate(1000,true)!.then(()=>{done=true;});
  await Promise.resolve();await Promise.resolve();
  expect(requests).toEqual([{kind:"rotate",landscape:true}]);
  expect(done).toBe(false);
  turned.resolve();await rotated;
  expect(followed).toEqual([true]);
});

test("every process records a physical rotation, and the one that comes to fill the display resolves it", async () => {
  const { ActivityStack } = await import("../src/shell/activitystack.ts");
  const { rotationForRequest } = await import("../src/shell/config.ts");
  type Entry = import("../src/shell/processes.ts").Entry;
  // a process: the orientation its activity requests, whether that is visible, and its rotation state
  type Process = { entry: Entry; request: number; visible: boolean; sensor: boolean; natural: boolean };
  const processes = new Map<number, Process>(), log: string[] = [], followed: [number,boolean][] = [];
  // the page's main loop, busy until the end: nothing in the queue may wait on it
  const pageMain = Promise.withResolvers<void>();
  // as device.ts does: the activity that sets the orientation resolves the rotation state, and a Worker reports a turn
  const resolve = (p: Process) => {
    const landscape = rotationForRequest(p.visible ? p.request : null, p);
    if (landscape !== null && p.entry.landscape !== undefined && landscape !== p.entry.landscape) stack.orientation(p.entry.pid, landscape);
  };
  const stack: InstanceType<typeof ActivityStack> = new ActivityStack({entry:pid=>processes.get(pid)!.entry,alive:()=>true,
    entries:()=>[...processes.values()].map(p=>p.entry),connect:()=>{throw new Error("no launches");},
    rotate:async entry=>{if(entry.landscape!==undefined)followed.push([entry.pid,entry.landscape]);},
    activity:async(entry,request)=>{
      const p = processes.get(entry.pid)!;
      if (request.kind === "visibility") {
        if (request.phase === "stop") p.visible = false;
        else if (request.phase !== "pause") p.visible = true;
        if (request.phase === "resume") resolve(p);
      } else if (request.kind === "rotate") {
        log.push(`${entry.pid} ${request.landscape}`);
        p.sensor = request.landscape;
        if (entry.landscape === undefined) return pageMain.promise;
        resolve(p);
      }
    }},false);
  const add = (pid: number, request: number, landscape?: boolean) => {
    const p: Process = { entry: {pid,translucent:false,landscape} as Entry, request, visible: false, ...stack.rotation };
    processes.set(pid, p);
    return p;
  };
  // the page's process, an app with an unspecified request and one fixed to portrait
  const page = add(1000, -1), app = add(1001, -1, false), fixed = add(1002, 1, false);
  stack.setForeground(app.entry.pid); app.visible = true;
  await stack.bringToFront(fixed.entry.pid);
  expect(log).toEqual(["1002 false"]);
  // rotated while the fixed activity fills the display, which keeps portrait; the app, stopped,
  // records the sensor's rotation without turning, and so does the page
  await stack.rotate(page.entry.pid, true);
  expect(log.slice(1).sort()).toEqual(["1000 true", "1001 true", "1002 true"]);
  expect([fixed.entry.landscape, app.entry.landscape, app.sensor, page.sensor]).toEqual([false, false, true, true]);
  expect(followed.at(-1)).toEqual([1002, false]);
  // a process started now starts with it
  expect(stack.rotation).toEqual({ sensor: true, natural: false });
  // the app comes back to the display and takes the sensor's landscape; the display follows
  await stack.bringToFront(app.entry.pid);
  expect(app.entry.landscape).toBe(true);
  expect(followed.at(-1)).toEqual([1001, true]);
  // the fixed activity keeps portrait when it fills the display again
  await stack.bringToFront(fixed.entry.pid);
  expect(fixed.entry.landscape).toBe(false);
  expect(followed.at(-1)).toEqual([1002, false]);
  // the page's own process resolves it too, and the queue goes on while its main loop is busy
  await stack.bringToFront(page.entry.pid);
  expect(log.at(-1)).toBe("1000 true");
  // the page turns its own display: the others only record the rotation
  log.length = 0;
  expect(stack.rotate(page.entry.pid, false)).toBeNull();
  expect(log.sort()).toEqual(["1001 false", "1002 false"]);
  expect(app.entry.landscape).toBe(true);
  await stack.bringToFront(app.entry.pid);
  expect(app.entry.landscape).toBe(false);
  expect(followed.at(-1)).toEqual([1001, false]);
  // the same process showing again is no change of owner
  log.length = 0;
  await stack.bringToFront(app.entry.pid);
  expect(log).toEqual([]);
  pageMain.resolve();
});

test("the activity that sets the display's orientation resolves the rotation as DisplayRotation does", async () => {
  const { orientationRequest } = await import("../src/android/server/atm.ts");
  const { rotationForRequest } = await import("../src/shell/config.ts");
  type Record = NonNullable<Parameters<typeof orientationRequest>[0]>[number];
  const r = (orientation: number, translucent = false, state: Record["state"] = "resumed", finishing = false): Record => ({ orientation, translucent, state, finishing });
  // from the top, the first visible activity that asks for an orientation or covers what is beneath
  expect(orientationRequest([])).toBeNull();
  expect(orientationRequest([r(0), r(-1)])).toBe(-1);
  expect(orientationRequest([r(1, false, "paused"), r(-1, true, "launching")])).toBe(1);
  expect(orientationRequest([r(0, false, "paused"), r(1, true)])).toBe(1);
  expect(orientationRequest([r(0, false, "paused"), r(-1, false, "paused", true)])).toBe(0);
  // stopped, or translucent over another process's activity: another process sets it
  expect(orientationRequest([r(0, false, "stopped"), r(-1, false, "stopping")])).toBeNull();
  expect(orientationRequest([r(-1, true)])).toBeNull();
  // a fixed request keeps its own, nosensor takes the natural rotation, locked and none keep the display
  const held = { sensor: true, natural: false };
  expect([0, 1, 6, 7, 11, 12].map(request => rotationForRequest(request, held))).toEqual([true, false, true, false, true, false]);
  expect([-1, 2, 3, 4, 10, 13].map(request => rotationForRequest(request, held))).toEqual([true, true, true, true, true, true]);
  expect(rotationForRequest(5, held)).toBe(false);
  expect(rotationForRequest(14, held)).toBeNull();
  expect(rotationForRequest(null, held)).toBeNull();
});
