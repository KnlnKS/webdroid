import { expect, test } from "vite-plus/test";
import { chromium } from "playwright";
import { serveModules } from "./browser.ts";

test("lazy archive reads cross a Worker without sharing buffers and fail on process teardown", async () => {
  const server = await serveModules(["src/shell/remote-file.ts", "tests/fixtures/browser/process-bootstrap.ts", "tests/fixtures/browser/process-worker-fixture.ts"]);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url.href + "?testClock=controlled");
    const result = await page.evaluate(async () => {
      const { serveFile } = await import(location.origin + "/remote-file.js") as typeof import("../src/shell/remote-file.ts");
      const source = Uint8Array.of(10, 11, 12, 13);
      let served!: ReturnType<typeof serveFile>;
      const requests: number[] = [];
      served = serveFile({ size: source.length, async read(offset, length) {
        requests.push(offset);
        if (offset === 99) throw new RangeError("archive unavailable");
        if (offset === 100) { served.close(); return new Promise<Uint8Array>(() => {}); }
        // Complete the first concurrent read after the second one.
        if (offset === 0) await new Promise(resolve => setTimeout(resolve, 30));
        return source.subarray(offset, offset + length);
      } });
      const code = `import { RemoteFile } from ${JSON.stringify(location.origin + "/remote-file.js")};
        self.onmessage = async ({data}) => {
          const file = new RemoteFile(data);
          const [a, b] = await Promise.all([file.read(0, 2), file.read(2, 2)]);
          const bytes = [Array.from(a), Array.from(b)]; a[0] = 90;
          const readAgain = Array.from(await file.read(0, 1));
          const failure = await file.read(99, 1).catch(e => [e.name, e.message]);
          const closed = await file.read(100, 1).catch(e => e.message);
          const later = await file.read(0, 1).catch(e => e.message);
          self.postMessage({size:file.size,bytes,readAgain,failure,closed,later});
        };`;
      const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      const worker = new Worker(url, { type: "module" });
      try {
        const reply = new Promise<{ size: number; bytes: number[][]; readAgain: number[]; failure: string[]; closed: string; later: string }>((resolve, reject) => {
          worker.onmessage = ({ data }) => resolve(data);
          worker.onerror = event => reject(new Error(event.message));
        });
        // The broker first creates a snapshot; its endpoint must transfer the ports again.
        const snapshot = structuredClone(served.data, { transfer: [served.data.port] });
        worker.postMessage(snapshot, [snapshot.port]);
        return { ...await reply, source: Array.from(source), requests };
      } finally { worker.terminate(); URL.revokeObjectURL(url); served.close(); }
    });
    expect(errors).toEqual([]);
    expect(result).toEqual({ size: 4, bytes: [[10, 11], [12, 13]], readAgain: [10],
      failure: ["RangeError", "archive unavailable"], closed: "Archive source closed", later: "Archive source closed",
      source: [10, 11, 12, 13], requests: [0, 2, 0, 99, 100] });
    const ownership = await page.evaluate(async () => {
      const { bootstrapOwnership } = await import(location.origin + "/process-bootstrap.js") as typeof import("./fixtures/browser/process-bootstrap.ts");
      return bootstrapOwnership();
    });
    expect(ownership).toEqual({ eagerReads: 0, failed: "DataCloneError: handoff failed", discarded: ["Archive source closed", "Archive source closed"],
      imeOwners:{deadClosed:true,peerSurvives:true},retained: [10], ended: "Archive source closed", isolated: [10], callersClosed: true,displaysClosed:3 });
    const clock = await page.evaluate(async () => {
      const { clockBootstrapOwnership } = await import(location.origin + "/process-bootstrap.js") as typeof import("./fixtures/browser/process-bootstrap.ts");
      return clockBootstrapOwnership();
    });
    expect(clock).toEqual({crash:{expected:false,reason:4,error:true,fatal:{exceptionClassName:"fixture.FatalException",exceptionMessage:"fatal fixture",throwFileName:"Fixture.java",throwLineNumber:17,stackTrace:"fixture.FatalException: fatal fixture\n at fixture.run(Fixture.java:17)"},copied:true},terminals:[{expected:true,reason:1,status:0,error:false,copied:true},{expected:false,reason:1,status:7,error:true,copied:true},{expected:true,reason:10,status:9,error:false,copied:true}],display:true,exit:{pid:8201,uid:15000,process:"test.clock.worker",pkg:"test.clock.worker",reason:4,status:0,dialog:true,description:"crash"}, controlled: true, archive: [31], origin: true, wall: true, uptime: true, identity: [8201,15000,"test.clock.worker"], commands: {cookies:false}, ticks: ["first", "nested"],
      advanced: 2, pendingBeforeDeath: 2, pendingAfterDeath: 1, brokerTimer: 1, pendingAfterAdvance: 0 });
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); }
}, 30_000);
