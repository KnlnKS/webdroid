import { expect, test } from "bun:test";

// Each fixture drives the activity manager in a process of its own, whose app identity and
// registered binders it sets up from scratch.
async function fixture(name: string): Promise<unknown> {
  const run = Bun.spawn(["bun", new URL(`fixtures/${name}.ts`, import.meta.url).pathname], { stdout: "pipe", stderr: "ignore" });
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
