import { expect, test } from "vite-plus/test";
import { chromium } from "playwright";
import { serveModules } from "./browser.ts";

test("process endpoints preserve Parcel isolation, reentrant callbacks, errors and death across Workers", async () => {
  const server = await serveModules(["src/perf.ts", "src/shell/process-port.ts", "tests/fixtures/browser/process-bootstrap.ts", "tests/fixtures/browser/process-worker-fixture.ts",
    "tests/fixtures/browser/fixture-calls.ts"]);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url.href);
    const counterReceipt = await page.evaluate(async () => {
      const previous = location.href, absent = window.__wdCounterReceipt === undefined;
      history.replaceState(null, "", "?perfProbe=1");
      const { perf, perfReset } = await import(location.origin + "/perf.js") as typeof import("../src/perf.ts");
      const first = window.__wdCounterReceipt!();
      perf.wasmCompileMs = 7;
      const second = window.__wdCounterReceipt!();
      perfReset();
      const reset = window.__wdCounterReceipt!();
      const readonly = !Reflect.set(window, "__wdCounterReceipt", () => null) && Object.isFrozen(first) && Object.isFrozen(first.counters) && Object.isFrozen(first.initial);
      history.replaceState(null, "", previous);
      return { absent, readonly, initial: first.initial.wasmCompileMs, first: first.counters.wasmCompileMs, second: second.counters.wasmCompileMs,
        resets: [first.resets, second.resets, reset.resets], reset: reset.counters.wasmCompileMs, ordered: first.at <= second.at && first.sequence < second.sequence };
    });
    expect(counterReceipt).toEqual({ absent: true, readonly: true, initial: 0, first: 0, second: 7, resets: [0, 0, 1], reset: 0, ordered: true });
    const profileOwnership = await page.evaluate(async () => {
      const { fixtureWorker } = await import(location.origin + "/fixture-calls.js") as typeof import("./fixtures/browser/fixture-calls.ts");
      const worker = fixtureWorker("aot");
      try { return await new Promise((resolve,reject)=>{worker.onmessage=e=>resolve(e.data);worker.onerror=e=>reject(new Error(e.message));}); }
      finally {worker.terminate();}
    });
    expect(profileOwnership).toEqual({absent:null,untouched:true,copiedKey:"build-key",
      fresh:{key:"build-key",wanted:["c1.wasm"],worlds:[{linked:["LExample;"],called:["LCalled;"]}]}});
    const pendingRights = await page.evaluate(async()=>{
      const {pendingDescriptorRights}=await import(location.origin+"/process-bootstrap.js") as typeof import("./fixtures/browser/process-bootstrap.ts");
      return pendingDescriptorRights();
    });
    expect(pendingRights).toEqual({pendingRejected:true});
    const result = await page.evaluate(async () => {
      const { processProxy, serveProcess, processError } = await import(location.origin + "/process-port.js") as typeof import("../src/shell/process-port.ts");
      const endpointPorts = new MessageChannel(), callbacks = new MessageChannel();
      const { fixtureWorker, stubEndpoint } = await import(location.origin + "/fixture-calls.js") as typeof import("./fixtures/browser/fixture-calls.ts");
      const worker = fixtureWorker("parcel");
      const proxy = processProxy(endpointPorts.port1, fault => fault.javaClass ? Object.assign(new Error(fault.message ?? ""), { javaClass: fault.javaClass, name: fault.name }) : processError(fault));
      const empty = { bytes: new Uint8Array(0), objects: [] };
      const stopCallbacks = serveProcess(callbacks.port1, stubEndpoint({ transact: async () => {
        await proxy.endpoint.cookiesChanged();
        return { handled: 1, data: { ...empty, bytes: Uint8Array.of(21) } };
      } }));
      try {
        worker.postMessage({ endpoint: endpointPorts.port2, callback: callbacks.port2 }, [endpointPorts.port2, callbacks.port2]);
        const source = Uint8Array.of(1, 2), caller = { pid: 10, uid: 12000 };
        const request = { handle: { pid: 20, id: 1 }, flags: 0, data: { bytes: source, objects: [[0, { pid: 10, id: 4 }]] } } as const;
        const call = (code: number) => proxy.endpoint.transact({ ...request, code, data: { bytes: source, objects: [[0, { pid: 10, id: 4 }]] } }, caller);
        const copied = await call(1), callback = await call(2);
        const failure = await call(3).catch(error => ({ javaClass: error.javaClass, message: error.message }));
        const cloneError = await call(4).catch(error => error.name);
        const hostError = await call(6).catch(error => ({ name:error.name, message:error.message,
          origin:error.stack.includes("originatingHostFailure"), caller:error.stack.includes("processError") }));
        const entered = new Promise<void>(resolve => worker.onmessage = () => resolve());
        const pending = call(5).catch(error => error.javaClass);
        await entered;
        proxy.close();
        const death = await pending, later = await call(1).catch(error => error.javaClass);
        return { source: Array.from(source), copied: { handled: copied.handled, bytes: Array.from(copied.data.bytes), objects: copied.data.objects },
          callback: Array.from(callback.data.bytes), failure, cloneError, hostError, death, later };
      } finally { proxy.close(); stopCallbacks(); worker.terminate(); }
    });
    expect(result).toEqual({ source: [1, 2], copied: { handled: 12000, bytes: [99, 2], objects: [[0, { pid: 10, id: 4 }]] },
      callback: [21, 1], failure: { javaClass: "java/lang/SecurityException", message: "denied" }, cloneError: "DataCloneError",
      hostError:{name:"TypeError",message:"undefined.hasTransform",origin:true,caller:false},
      death: "android/os/DeadObjectException", later: "android/os/DeadObjectException" });
    const ownership = await page.evaluate(async () => {
      const { endpointOwnership } = await import(location.origin + "/process-bootstrap.js") as typeof import("./fixtures/browser/process-bootstrap.ts");
      return endpointOwnership();
    });
    expect(ownership).toEqual({ repeatedReady: true, reverseCaller: {pid:8002,id:1}, killed: true, alive: false, pendingCause: "fixture kill delivered", otherAlive: true, removed: true,
      lifecycle:{read:{pid:3,id:1},dead:{pid:1,id:0},signalOwn:true,signalForeign:true,watcherCleaned:true},
      fileDescriptors:{opened:true,foreign:-13,written:55,read:{pid:66,id:1},binder:{pid:77,id:1},survivor:{pid:77,id:1}} });
    const cookies = await page.evaluate(async () => {
      const { cookieOwnership } = await import(location.origin + "/process-bootstrap.js") as typeof import("./fixtures/browser/process-bootstrap.ts");
      return cookieOwnership();
    });
    expect(cookies).toEqual({ session: true, persisted: true, read: "session=one; saved=two", isolatedRead: "",
      document: ["saved=two"], network: "session=one; saved=two", accept: false, denied: false, removed: true, afterSession: "saved=two",
      saved: ["saved"], dead: true, pendingDead: true, survivor: "saved=two", empty: false, changes: 4 });
    const stores = await page.evaluate(async () => {
      const { storeOwnership } = await import(location.origin + "/process-bootstrap.js") as typeof import("./fixtures/browser/process-bootstrap.ts");
      return storeOwnership();
    });
    expect(stores).toEqual({prefs:{ack:true,fresh:["one"],keys:["array","other"],foreignDenied:true,emptyForeignDenied:true,publicPolicy:"test.stores.shared",policyDenied:true,files:["worker"]},paths:{made:0,repeated:-17,directory:true,copied:true,foreignPath:-13,metadata:true,retainedMetadata:true,changedMode:true,restoredMetadata:true},permissions:{before:[false],own:[true],foreignDenied:true,privileged:[true]},
      settings:{written:true,read:"shared",sameKey:true,survivor:"shared"}});
    const pointers = await page.evaluate(async () => {
      const {pointerInputOwnership} = await import(location.origin+"/process-bootstrap.js") as typeof import("./fixtures/browser/process-bootstrap.ts");
      return pointerInputOwnership();
    });
    expect(pointers).toEqual({samples:[[1,0,20,40],[2,0,10,12],[2,3,10,12],[1,2,60,80],[1,1,80,100]],closed:true});
    const diagnostic = await page.evaluate(async () => {
      const {workerDiagnosticOwnership} = await import(location.origin+"/process-bootstrap.js") as typeof import("./fixtures/browser/process-bootstrap.ts");
      return workerDiagnosticOwnership();
    });
    expect(diagnostic).toEqual({pendingTerminal:{expected:true,reason:1,status:0,pid:8403},healthy:true,rejected:"owned diagnostic failure",hung:"Worker diagnostic timeout",phase:"Worker is not ready: packages",
      profilePending:"Worker is not ready: packages",profileIdentity:"Worker AOT profile identity mismatch",
      secondHealthy:true,hungCalls:1,queueBlocked:true,live:true,aliveCalls:2,retained:"actual diagnostic fixture exit",identity:8401});
    const ime = await page.evaluate(async () => {
      const {imeOwnership} = await import(location.origin+"/process-bootstrap.js") as typeof import("./fixtures/browser/process-bootstrap.ts");
      return imeOwnership();
    });
    expect(ime).toEqual({inputs:["a","abc"],switched:"new editor",inactive:true,closed:true});
    expect(errors).toEqual([]);
  } finally { await browser.close(); server.stop(true); }
}, 30_000);
