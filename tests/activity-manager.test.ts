import { expect, test } from "bun:test";

/** a fixture runs Java on the Wasm tier, so under node as the unit tests do */
const UNDER_NODE = new URL("../scripts/wasm/undernode.ts", import.meta.url).pathname;

// Each fixture drives the activity manager in a process of its own, whose app identity and
// registered binders it sets up from scratch.
async function fixture(name: string): Promise<unknown> {
  const run = Bun.spawn(["bun", UNDER_NODE, new URL(`fixtures/${name}.ts`, import.meta.url).pathname], { stdout: "pipe", stderr: "ignore" });
  return JSON.parse((await new Response(run.stdout).text()).trim().split("\n").at(-1)!);
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
  const { ActivityStack } = await import("../src/shell/activitystack");
  const entry = {pid:1001} as import("../src/shell/processes").Entry;
  const first = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  let calls = 0, available = true;
  const stack = new ActivityStack({entry:()=>{if(!available)throw new Error("target died");return entry;},alive:()=>true,entries:()=>[entry],connect:()=>entry,rotate:async()=>{},
    activity:async (_entry,request)=>{expect(request.kind).toBe("back");calls++;
      if(calls===1){entered.resolve();await first.promise;} else if(calls===2)throw new Error("owner back failure");}});
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
  const { ActivityStack } = await import("../src/shell/activitystack");
  const app = {pid:1001,landscape:false} as import("../src/shell/processes").Entry;
  const followed: boolean[] = [], requests: unknown[] = [];
  const turned = Promise.withResolvers<void>();
  const stack: InstanceType<typeof ActivityStack> = new ActivityStack({entry:()=>app,alive:()=>true,entries:()=>[app],connect:()=>app,
    rotate:async(entry)=>{await turned.promise;followed.push(entry.landscape!);},
    activity:async(_entry,request)=>{requests.push(request);
      // the app's own display turns, and it reports that before it answers
      if(request.kind==="rotate")stack.orientation(app.pid,request.landscape);}});
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
