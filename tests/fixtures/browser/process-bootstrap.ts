import { processBroker, type ProcessEndpoint } from "../../../src/shell/processes";
import { packages, PackageRecord } from "../../../src/android/packages";
import { Resources } from "../../../src/android/res";
import { TV } from "../../../src/android/axml";
import { vfs } from "../../../src/shell/vfs";
import { packedArchives } from "../../../src/shell/packedarchive";
import { RemoteFile } from "../../../src/shell/remote-file";
import { NOT_CRASHED } from "../../../src/android/server/appexitinfo";

export async function bootstrapOwnership() {
  let reads = 0, began!: () => void;
  const waiting = new Promise<void>(resolve => began = resolve);
  for (const [i, pkg] of ["test.archive.one", "test.archive.two"].entries()) {
    const path = `/data/app/${pkg}/base.apk`;
    const root = { name: "manifest", attrs: [{ ns: "", name: "package", resId: 0, type: TV.STRING, data: 0, str: pkg }], children: [] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), path, 12000 + i, async () => []));
    vfs.mount(path, { size: 64 << 20, read(offset) {
      reads++;
      if (offset === 7) { began(); return new Promise<Uint8Array>(() => {}); }
      return Uint8Array.of(i + 10);
    } });
  }
  const broker = processBroker();
  broker.connect("test.archive.one", "test.archive.one", 7001);
  broker.connect("test.archive.two", "test.archive.two", 7002);
  const file = (data: Awaited<ReturnType<typeof broker.bootstrap>>) => {
    const source = data.registry[0].source;
    if (!("port" in source)) throw new Error("expected lazy archive port");
    return new RemoteFile(source);
  };
  const first = file(await broker.bootstrap(7001)), other = file(await broker.bootstrap(7002));
  const eagerReads = reads;
  const replacement = file(await broker.bootstrap(7001));
  const superseded = await first.read(0, 1).catch(error => error.message);
  // A failed handoff must dispose its new exports while retaining the published owner set.
  const clone = globalThis.structuredClone;
  const unpublished: RemoteFile[] = [];
  let failed = false;
  try {
    globalThis.structuredClone = value => {
      const data = value as Awaited<ReturnType<typeof broker.bootstrap>>;
      for (const record of data.registry) if ("port" in record.source) unpublished.push(new RemoteFile(record.source));
      throw new DOMException("handoff failed", "DataCloneError");
    };
    await broker.bootstrap(7001);
  } catch (error) { failed = error instanceof DOMException && error.name === "DataCloneError"; }
  finally { globalThis.structuredClone = clone; }
  const discarded = await Promise.all(unpublished.map(file => file.read(0, 1).catch(error => error.message)));
  const retained = Array.from(await replacement.read(0, 1));
  const pending = replacement.read(7, 1).catch(error => error.message);
  await waiting;
  broker.fail(7001, "fixture process exit", NOT_CRASHED);
  const ended = await pending;
  const isolated = Array.from(await other.read(0, 1));
  broker.fail(7002, "fixture process exit", NOT_CRASHED);
  packages.clear(); packedArchives.clear();
  return { eagerReads, superseded, failed, discarded, retained, ended, isolated };
}

export async function endpointOwnership() {
  const broker = processBroker();
  const names = ["test.endpoint.one", "test.endpoint.two"];
  const entries = names.map((pkg, i) => {
    const root = { name: "manifest", attrs: [{ ns: "", name: "package", resId: 0, type: TV.STRING, data: 0, str: pkg }], children: [] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), `/data/app/${pkg}/base.apk`, 13000 + i, async () => []));
    return broker.connect(pkg, pkg, 8001 + i);
  });
  let entered!: () => void, killed = false, removed = false;
  const waiting = new Promise<void>(resolve => entered = resolve);
  const endpoint = (pid: number): ProcessEndpoint => ({
    activity: async () => {}, transact: async (request, caller) => {
      if (request.code === 2) { await other.clipboardChanged(); return {handled:caller.pid,data:{bytes:Uint8Array.of(caller.uid & 255),objects:[]}}; }
      entered(); return new Promise(() => {});
    },
    service: async () => ({ pid, id: 1 }), serviceConnected: async () => {}, contentProvider: async () => null,
    broadcast: async (_intent, _component, _ordered, result) => result, clipboardChanged: async () => {},
    packageRemoved: async () => { await new Promise(resolve => setTimeout(resolve, 10)); removed = true; },
    kill: () => { setTimeout(() => { killed = true; broker.fail(pid, "fixture kill delivered", NOT_CRASHED); }, 10); },
  });
  const workerCode = `import {serveProcess,callProxy} from ${JSON.stringify(location.origin + "/process-port.js")};
    let removed = false, clips = 0;
    self.onmessage = ({data}) => {
      const broker = callProxy(data.broker,["transact","service","contentProvider","broadcast"]).endpoint;
      serveProcess(data.port, {
      activity:async()=>{}, transact:async()=>new Promise(()=>{}),
      service:async(request)=>{
        if(request.intent?.bytes[0]===42){const reply=await broker.transact({handle:{pid:8001,id:1},code:2,flags:0,data:request.intent,caller:{pid:9999,uid:9999}});return {pid:reply.handled,id:clips};}
        return {pid:8002,id:removed?2:1};
      }, serviceConnected:async()=>{}, contentProvider:async()=>null,
      broadcast:async(_i,_c,_o,r)=>r, clipboardChanged:async()=>{clips++;}, kill:()=>{},
      packageRemoved:async()=>{await new Promise(r=>setTimeout(r,10));removed=true;}
    });};`;
  const url = URL.createObjectURL(new Blob([workerCode], {type:"text/javascript"}));
  const worker = new Worker(url, {type:"module"}), channel = new MessageChannel();
  const reverse = broker.brokerPort(8002);
  worker.postMessage({port:channel.port1,broker:reverse}, [channel.port1,reverse]);
  broker.ready(8001, endpoint(8001)); broker.readyPort(8002, channel.port2);
  broker.ready(8001, endpoint(9999));
  const first = await entries[0].ready, other = await entries[1].ready;
  const request = { kind: "peek" as const, intent: { bytes: new Uint8Array(0), objects: [] } };
  const repeatedReady = (await first.service(request))?.pid === 8001;
  const reverseCaller = await other.service({...request,intent:{bytes:Uint8Array.of(42),objects:[]}});
  const pending = broker.transact(8002, { handle: { pid: 8001, id: 1 }, code: 1, flags: 0, data: request.intent })
    .catch(error => error.msg);
  await waiting;
  await broker.forceStop(names[0]);
  const pendingCause = await pending;
  const otherAlive = broker.alive(8002) && (await other.service(request))?.pid === 8002;
  await broker.packageRemoved("test.removed.package");
  removed = (await other.service(request))?.id === 2;
  broker.fail(8002, "fixture cleanup", NOT_CRASHED);
  worker.terminate(); URL.revokeObjectURL(url);
  return { repeatedReady, reverseCaller, killed, alive: broker.alive(8001), pendingCause, otherAlive, removed };
}
