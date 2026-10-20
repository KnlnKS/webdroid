// The browser fixtures' Worker halves: each Worker plays the role its URL names (fixture-calls.ts).
import { callProxy, serveCalls, serveProcess, processProxy } from "../../../src/shell/process-port.ts";
import { remoteProcessLife } from "../../../src/shell/process-life.ts";
import { attachGuestClockPort, bootTime, guestClockControl, setGuestTimeout, uptimeMillis, wallMillis } from "../../../src/guest-clock.ts";
import { attachWorkerBootstrap, serveWorkerEndpoint } from "../../../src/shell/worker-bootstrap.ts";
import { exitProcess } from "../../../src/process-exit.ts";
import { RemoteFile } from "../../../src/shell/remote-file.ts";
import { existingAotProfile } from "../../../src/shell/aot-profile.ts";
import { bootstrapTransfers } from "../../../src/shell/process-bootstrap-data.ts";
import type { ProcessWorkerMessage, ProcessWorkerStatus } from "../../../src/shell/process-host.ts";
import type { ClockBootstrap } from "../../../src/shell/clock-port.ts";
import type { BrokerCalls } from "../../../src/shell/broker-contract.ts";
import type { ImeView } from "../../../src/shell/input-port.ts";
import type { BinderHandle, ParcelData, TransactionReply } from "../../../src/android/binder.ts";
import { stubEndpoint, type BrokerInit, type PointerCalls } from "./fixture-calls.ts";

const post = (message: unknown, transfer: Transferable[] = []) => self.postMessage(message, { transfer });
const brokerCalls = ({ broker, methods }: BrokerInit) => callProxy<BrokerCalls>(broker, methods).endpoint;
type Start = Extract<ProcessWorkerMessage, { kind: "start" }>;
function originatingHostFailure(): never { throw new TypeError("undefined.hasTransform"); }

/** each role's handler of the messages the page posts it */
const roles: Record<string, () => (data: never) => void> = {
  /** a process whose services step through the broker calls endpointOwnership checks */
  endpoint: () => ({ port, ...init }: BrokerInit & { port: MessagePort }) => {
    const broker = brokerCalls(init), life = remoteProcessLife(() => broker.process, error => { throw error; });
    let removed = false, notices = 0, fd = -1, received = -1, deaths = 0;
    // The port binds the caller's identity; the one this request names must not count.
    const forged = { caller: { pid: 9999, uid: 9999 } };
    const descriptor = ({ data }: TransactionReply) => {
      const right = data.objects[0]?.[1];
      if (!right || !("descriptor" in right)) throw new Error("missing driver FD right");
      return right.descriptor;
    };
    const steps: Record<number, (intent: ParcelData) => Promise<BinderHandle>> = {
      42: async intent => ({ pid: (await broker.transact({ handle: { pid: 8001, id: 1 }, code: 2, flags: 0, data: intent, ...forged })).handled, id: notices }),
      43: async () => {
        fd = (await broker.descriptors.fileDescriptor({ kind: "open", path: "/data/data/test.endpoint.two/fd.bin", flags: 2 }) as { token: number }).token;
        const foreign = await broker.descriptors.fileDescriptor({ kind: "open", path: "/data/data/test.endpoint.one/fd.bin", flags: 2 }) as number;
        await broker.descriptors.fileDescriptor({ kind: "write", fd, bytes: Uint8Array.of(55), offset: 0 });
        return { pid: fd, id: foreign };
      },
      44: async () => {
        const reply = await broker.descriptors.fileDescriptor({ kind: "read", fd, length: 1, offset: 0 }) as Uint8Array;
        return { pid: reply[0] ?? -1, id: reply.length };
      },
      45: async () => {
        const stage = await broker.descriptors.fileDescriptor({ kind: "stage", fd });
        received = descriptor(await broker.transact({ handle: { pid: 8001, id: 1 }, code: 3, flags: 0,
          data: { bytes: new Uint8Array(0), objects: [[0, { descriptor: stage }]] } }));
        const read = await broker.descriptors.fileDescriptor({ kind: "read", fd: received, length: 1 }) as Uint8Array;
        const position = await broker.descriptors.fileDescriptor({ kind: "seek", fd, offset: 0, whence: 1 });
        await broker.descriptors.fileDescriptor({ kind: "close", fd });
        return { pid: read[0], id: position };
      },
      46: async () => {
        const read = await broker.descriptors.fileDescriptor({ kind: "read", fd: received, length: 1, offset: 0 }) as Uint8Array;
        await broker.descriptors.fileDescriptor({ kind: "close", fd: received });
        return { pid: read[0], id: read.length };
      },
      47: async () => {
        const live = await life.alive(8001), system = await life.alive(0), absent = await life.alive(9999);
        (await life.watch(8001, () => { deaths += 100; }))();
        await life.watch(8001, () => { deaths++; });
        const denied = await life.watch(9999, () => { deaths += 1000; }).then(() => false, () => true);
        return { pid: +live + 2 * +system + 4 * +absent, id: +denied };
      },
      48: async () => ({ pid: deaths, id: +await life.alive(8001) }),
      49: async () => { await life.signal(8001, 9); await life.signal(8003, 9); return { pid: deaths, id: 1 }; },
    };
    serveProcess(port, stubEndpoint({
      transact: () => new Promise(() => {}),
      service: async request => {
        const intent = "intent" in request ? request.intent : null, step = intent && steps[intent.bytes[0]];
        return step ? step(intent!) : { pid: 8002, id: removed ? 2 : 1 };
      },
      processDied: async token => life.died(token), cookiesChanged: async () => { notices++; },
      packageRemoved: async () => { await new Promise(resolve => setTimeout(resolve, 10)); removed = true; },
    }));
  },
  /** a process relaying the page's broker calls */
  client: () => {
    let broker: unknown;
    return (data: BrokerInit | { id: number; method: string; args: unknown[] }) => {
      if ("broker" in data) {
        broker = brokerCalls(data);
        return post({ ready: true });
      }
      const { id, method, args } = data;
      void (async () => (method.split(".").reduce((methods, name) => (methods as Record<string, unknown>)[name], broker) as (...args: unknown[]) => unknown)(...args))().then(value => post({ id, value }), (error: Error) => post({ id, error: error.message }));
    };
  },
  /** a process booted from the page's bootstrap, on a guest clock the page drives when it sends one */
  clock: () => (data: { clock: ClockBootstrap } | { finish: number } | Start) => {
    if ("clock" in data) attachGuestClockPort(data.clock);
    else if ("finish" in data) exitProcess({ code: data.finish });
    else void clockProcess(data);
  },
  /** a process Worker that posts back the bootstrap it is started with */
  echo: () => ({ bootstrap }: Start) => post({ bootstrap }, bootstrapTransfers(bootstrap)),
  /** a process whose first owner's DOWN holds its input queue until the page releases it */
  pointer: () => ({ port }: { port: MessagePort }) => {
    let release = () => {};
    const samples: number[][] = [];
    serveCalls(port, {
      pointer: async (owner, action, x, y) => {
        samples.push([owner, action, x, y]);
        if (owner === 1 && action === 0) await new Promise<void>(resolve => release = resolve);
      },
      release: async () => release(), samples: async () => samples,
    } satisfies PointerCalls);
  },
  /** Worker controls answering diagnostics as each `mode` names */
  control: () => {
    let hungCalls = 0, aliveCalls = 0;
    return (data: { count: true } | { port: MessagePort; mode: string; pid: number; pkg: string; process: string }) => {
      if ("count" in data) return post({ hungCalls, aliveCalls });
      const { port, mode, pid, pkg, process } = data, phase = mode === "queueHang" ? "ready" : mode;
      serveCalls(port, {
        snapshot: async () => {
          if (mode === "hang") { hungCalls++; return new Promise(() => {}); }
          if (mode === "reject") throw new Error("owned diagnostic failure");
          return { phase, dead: false, identity: { pid } };
        },
        aotProfile: async () => ({ phase, dead: false, identity: { pid, pkg: mode === "ready" ? pkg : null, process }, profile: null }),
        alive: async () => { aliveCalls++; return mode === "queueHang" ? new Promise(() => {}) : true; },
      });
      post({ ready: true });
    };
  },
  /** an editor whose first edit holds its input until the page releases it */
  ime: () => {
    let generation = 1, release = () => {}, page: ImeView;
    const state = (text: string, start: number, end: number, active: boolean) =>
      page.state({ generation, text, start, end, active, hasAction: false });
    return (data: { input: MessagePort; view: MessagePort } | { kind: "release" | "switch" | "hide" }) => {
      if ("input" in data) {
        page = callProxy<ImeView>(data.view, ["state"], ["state"]).endpoint;
        serveCalls(data.input, {
          input: async (edit: number, text: string, start: number, end: number) => {
            if (edit !== generation) return;
            post({ input: text });
            if (text === "a") await new Promise<void>(resolve => release = resolve);
            state(text, start, end, true);
          },
          selection: async () => {}, finish: async () => {}, action: async () => true,
        });
        state("", 0, 0, true);
      } else if (data.kind === "release") release();
      else {
        if (data.kind === "switch") generation = 2;
        state("new editor", 10, 10, data.kind === "switch");
      }
    };
  },
  /** a process whose transactions exercise Parcel copies, a reentrant callback and each failure kind */
  parcel: () => ({ endpoint, callback }: { endpoint: MessagePort; callback: MessagePort }) => {
    const peer = processProxy(callback);
    let notices = 0;
    serveProcess(endpoint, stubEndpoint({
      cookiesChanged: async () => { notices++; },
      transact: async (request, caller) => {
        if (request.code === 1) { request.data.bytes[0] = 99; return { handled: caller.uid, data: request.data }; }
        if (request.code === 2) {
          const reply = await peer.endpoint.transact(request, caller);
          reply.data.bytes = Uint8Array.of(reply.data.bytes[0], notices);
          return reply;
        }
        if (request.code === 3) throw { $javaClass: "java/lang/SecurityException", msg: "denied" };
        if (request.code === 4) return { handled: 1, data: (() => {}) as never };
        if (request.code === 6) originatingHostFailure();
        post("entered");
        return new Promise(() => {});
      },
    }));
  },
  /** reads of the AOT profile owner this realm's global holds */
  aot: () => {
    void (async () => {
      const absent = await existingAotProfile(), untouched = globalThis.__wdAot === undefined;
      const linked = ["LExample;"], called = ["LCalled;"];
      // an owner whose startup prefetch never ends: the read must not wait for it
      globalThis.__wdAot = Promise.resolve({ key: "build-key", wanted: new Set(["c1.wasm"]), worlds: new Set([() => ({ linked, called })]),
        ready: new Promise<void>(() => {}) }) as unknown as typeof globalThis.__wdAot;
      const copied = (await existingAotProfile())!;
      copied.wanted.push("foreign"); copied.worlds[0].linked.push("foreign");
      post({ absent, untouched, copiedKey: copied.key, fresh: await existingAotProfile() });
    })();
    return () => {};
  },
};

async function clockProcess({ bootstrap: data, endpoint }: Start) {
  const broker = await attachWorkerBootstrap(data);
  const { appCrashed } = await import("../../../src/android/server/appexitinfo.ts");
  const fatal = { exceptionClassName: "fixture.FatalException", exceptionMessage: "fatal fixture", throwFileName: "Fixture.java", throwLineNumber: 17,
    stackTrace: "fixture.FatalException: fatal fixture\n at fixture.run(Fixture.java:17)" };
  // The broker keeps the report it was sent, not this realm's object.
  if (data.pid === 8201) { appCrashed(fatal, false); fatal.exceptionMessage = "changed local report"; }
  await serveWorkerEndpoint(endpoint);
  const { PROCESS_PID, PROCESS_UID, PROCESS_NAME } = await import("../../../src/android/os.ts");
  const source = data.registry.find(record => record.pkg === data.pkg)!.source;
  if (!("port" in source)) throw new Error("expected lazy archive port");
  const archive = Array.from(await new RemoteFile(source).read(0, 1));
  setGuestTimeout(() => {
    post({ tick: "first", now: uptimeMillis(), wall: wallMillis() });
    queueMicrotask(() => setGuestTimeout(() => post({ tick: "nested", now: uptimeMillis() }), 0));
    setGuestTimeout(() => post({ tick: "dead" }), 5);
  }, 10);
  const commands = { cookies: await broker.cookieHas() };
  post({ kind: "ready" } satisfies ProcessWorkerStatus);
  post({ report: { display: !!data.display, archive, controlled: guestClockControl.controlled, bootTime, identity: [PROCESS_PID, PROCESS_UID, PROCESS_NAME], commands } });
}

const handle = roles[new URLSearchParams(location.search).get("role")!]!();
self.onmessage = ({ data }: MessageEvent) => handle(data as never);
