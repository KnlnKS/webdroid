import { expect, test } from "bun:test";

// ActivityThread's services and receivers are AOSP's under Stage D, so the activity manager is
// driven in a process that serves android/app from bytecode.
test("the activity manager drives a process's services and ordered receivers through its IApplicationThread", async () => {
  const run = Bun.spawn(["bun", new URL("fixtures/activity-manager.ts", import.meta.url).pathname],
    { env: { ...process.env, WEBDROID_BYTECODE: "stage-d" }, stdout: "pipe", stderr: "ignore" });
  const out = JSON.parse((await new Response(run.stdout).text()).trim().split("\n").at(-1)!);
  expect(out).toEqual({
    started: "org.webdroid.test.am.Svc", bound: 1,
    // created once, its start delivered, the binding the client waits on requested
    up: ["create org.webdroid.test.am.Svc", "args 1", "bind 0"],
    // the second client of the same intent hears the published binder without another onBind
    connected: ["published 0", "published 0"],
    // still started: only the binding goes, and only the last start id stops it
    unbound: ["unbind"], staleStop: 0, stop: 1, down: ["stop"],
    ordered: { calls: ["receive a", "receive b", "receive abort"], code: 3, data: "ababort", aborted: true },
    foreign: [],
  });
}, 120_000);
