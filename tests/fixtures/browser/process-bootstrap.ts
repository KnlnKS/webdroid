import { processBroker, type ProcessEndpoint } from "../../../src/shell/processes";
import { packages, PackageRecord } from "../../../src/android/packages";
import { Resources } from "../../../src/android/res";
import { TV } from "../../../src/android/axml";
import { vfs } from "../../../src/shell/vfs";
import { packedArchives } from "../../../src/shell/packedarchive";
import { RemoteFile } from "../../../src/shell/remote-file";
import { bootstrapTransfers } from "../../../src/shell/process-bootstrap-data";
import { connectClock } from "../../../src/shell/clock-port";
import { guestClockControl, setSystemTimeout, wallMillis, bootTime } from "../../../src/guest-clock";
import { callProxy } from "../../../src/shell/process-port";
import { brokerMethods, type BrokerCalls } from "../../../src/shell/processes";
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
  const broker = processBroker(), clocks: Promise<void>[] = [];
  let fired = 0;
  const watchClock = (data: Awaited<ReturnType<typeof broker.bootstrap>>) => {
    const port = data.clock?.port;
    if (!port) throw new Error("expected controlled clock port");
    clocks.push(new Promise<void>(resolve => port.addEventListener("message", ({data}) => { if (data.kind === "close") resolve(); })));
    connectClock(data.clock!)!.schedule(() => fired++, 5);
  };
  broker.connect("test.archive.one", "test.archive.one", 7001);
  broker.connect("test.archive.two", "test.archive.two", 7002);
  const file = (data: Awaited<ReturnType<typeof broker.bootstrap>>) => {
    watchClock(data);
    const source = data.registry[0].source;
    if (!("port" in source)) throw new Error("expected lazy archive port");
    return new RemoteFile(source);
  };
  const first = file(await broker.bootstrap(7001, true)), other = file(await broker.bootstrap(7002, true));
  const eagerReads = reads;
  const replacement = file(await broker.bootstrap(7001, true));
  const superseded = await first.read(0, 1).catch(error => error.message);
  // A failed handoff must dispose its new exports while retaining the published owner set.
  const clone = globalThis.structuredClone;
  const unpublished: RemoteFile[] = [];
  let failed = false;
  try {
    globalThis.structuredClone = value => {
      const data = value as Awaited<ReturnType<typeof broker.bootstrap>>;
      watchClock(data);
      for (const record of data.registry) if ("port" in record.source) unpublished.push(new RemoteFile(record.source));
      throw new DOMException("handoff failed", "DataCloneError");
    };
    await broker.bootstrap(7001, true);
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
  await Promise.all(clocks);
  const clockPending = guestClockControl.pending();
  packages.clear(); packedArchives.clear();
  return { eagerReads, superseded, failed, discarded, retained, ended, isolated, clocksClosed: clocks.length, clockPending, fired };
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

/** Real Worker CookieManager commands share the page's WebView jar and survive a sibling's death. */
export async function cookieOwnership() {
  const broker = processBroker(), pkg = "test.cookies.shared", isolated = "test.cookies.other";
  for (const [i, name] of [pkg, isolated].entries()) {
    const root = {name:"manifest",attrs:[{ns:"",name:"package",resId:0,type:TV.STRING,data:0,str:name}],children:[]};
    packages.set(name, new PackageRecord(root, new Resources(null, {}), `/data/app/${name}/base.apk`, 14000 + i, async () => []));
  }
  for (const [i, name] of [pkg, pkg, isolated].entries()) broker.connect(name, name + ":" + i, 8101 + i);
  const peers = [8102, 8103].map(pid => callProxy<BrokerCalls>(broker.brokerPort(pid), brokerMethods));
  const jar = await broker.cookies(pkg), otherJar = await broker.cookies(isolated);
  jar.remove(); otherJar.remove();
  let changes = 0;
  const unwatch = jar.watch(() => changes++);
  const code = `import {callProxy} from ${JSON.stringify(location.origin + "/process-port.js")};
    let client;
    self.onmessage = async ({data}) => {
      if(data.port) { client=callProxy(data.port,${JSON.stringify(brokerMethods)}); self.postMessage('ready'); return; }
      try { self.postMessage({value:await client.endpoint[data.method](...data.args)}); }
      catch(error) { self.postMessage({error:error.message}); }
    };`;
  const url = URL.createObjectURL(new Blob([code], {type:"text/javascript"})), worker = new Worker(url, {type:"module"});
  const ask = (method: keyof BrokerCalls, ...args: unknown[]) => new Promise<{value?: unknown; error?: string}>(resolve => {
    worker.onmessage = ({data}) => resolve(data);
    worker.postMessage({method,args});
  });
  try {
    await new Promise<void>(resolve => {
      worker.onmessage = () => resolve();
      const port = broker.brokerPort(8101); worker.postMessage({port}, [port]);
    });
    const url = "https://cookies.example/dir/index";
    const session = await ask("cookieSet", url, "session=one; Path=/; HttpOnly");
    const persisted = await ask("cookieSet", url, "saved=two; Path=/; Max-Age=86400");
    const read = await peers[0].endpoint.cookieGet(url), isolatedRead = await peers[1].endpoint.cookieGet(url);
    const document = jar.document(url).map(cookie => cookie.text);
    await peers[0].endpoint.cookieAccept(false);
    const accept = await ask("cookieAccept"), denied = await ask("cookieSet", url, "denied=three");
    await peers[0].endpoint.cookieAccept(true);
    const removed = await ask("cookieRemove", true), afterSession = await peers[0].endpoint.cookieGet(url);
    await ask("cookieFlush");
    const saved = JSON.parse(localStorage.getItem("wd:web-cookies:" + pkg) ?? "{}").cookies.map((cookie: {key: string}) => cookie.key);
    const original = broker.cookies;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => entered = resolve), blocked = new Promise<void>(resolve => release = resolve);
    broker.cookies = async name => { entered(); await blocked; return original.call(broker, name); };
    let pending: {value?: unknown; error?: string};
    try {
      const write = ask("cookieSet", url, "late=no");
      await waiting;
      broker.fail(8101, "cookie fixture death", NOT_CRASHED);
      release(); pending = await write;
    } finally { release(); broker.cookies = original; }
    const dead = await ask("cookieSet", url, "afterdeath=no");
    const survivor = await peers[0].endpoint.cookieGet(url);
    await peers[0].endpoint.cookieRemove(false);
    const empty = await peers[0].endpoint.cookieHas();
    return {session, persisted, read, isolatedRead, document, accept, denied, removed, afterSession, saved,
      dead: !!dead.error, pendingDead: !!pending.error, survivor, empty, changes};
  } finally {
    unwatch(); for (const client of peers) client.close();
    for (const pid of [8101, 8102, 8103]) broker.fail(pid, "cookie fixture cleanup", NOT_CRASHED);
    worker.terminate(); URL.revokeObjectURL(url); jar.forget(); otherJar.forget(); packages.delete(pkg); packages.delete(isolated);
  }
}

export async function clockBootstrapOwnership() {
  const broker = processBroker(), pkg = "test.clock.worker", pid = 8201;
  const root = {name:"manifest",attrs:[{ns:"",name:"package",resId:0,type:TV.STRING,data:0,str:pkg}],children:[]};
  const path = `/data/app/${pkg}/base.apk`;
  packages.set(pkg, new PackageRecord(root, new Resources(null, {}), path, 15000, async () => []));
  vfs.mount(path, {size:1,read:()=>Uint8Array.of(31)});
  broker.connect(pkg, pkg, pid);
  const data = await broker.bootstrap(pid, true), start = guestClockControl.now(), wall = wallMillis();
  const code = `import {attachGuestClockPort,guestClockControl,uptimeMillis,wallMillis,bootTime,setGuestTimeout} from ${JSON.stringify(location.origin + "/guest-clock.js")};
    self.onmessage = async ({data}) => {
      attachGuestClockPort(data.clock);
      const {RemoteFile} = await import(${JSON.stringify(location.origin + "/file.js")});
      const file = new RemoteFile(data.registry.find(record=>record.pkg===data.pkg).source);
      const archive = Array.from(await file.read(0,1));
      setGuestTimeout(()=>{
        self.postMessage({tick:'first',now:uptimeMillis(),wall:wallMillis()});
        queueMicrotask(()=>setGuestTimeout(()=>self.postMessage({tick:'nested',now:uptimeMillis()}),0));
        setGuestTimeout(()=>self.postMessage({tick:'dead'}),5);
      },10);
      self.postMessage({ready:true,archive,controlled:guestClockControl.controlled,bootTime});
    };`;
  const url = URL.createObjectURL(new Blob([code], {type:"text/javascript"})), worker = new Worker(url, {type:"module"});
  const ticks: {tick:string;now:number;wall?:number}[] = [];
  try {
    const ready = await new Promise<{archive:number[];controlled:boolean;bootTime:number}>((resolve,reject) => {
      worker.onerror = event => reject(new Error(event.message));
      worker.onmessage = ({data}) => { if(data.ready) resolve(data); else ticks.push(data); };
      worker.postMessage(data, bootstrapTransfers(data));
    });
    let brokerTimer = 0;
    setSystemTimeout(()=>brokerTimer++,20);
    const advanced = await guestClockControl.advanceBy(10), pendingBeforeDeath = guestClockControl.pending();
    worker.terminate(); broker.fail(pid, "terminated Worker fixture", NOT_CRASHED);
    const pendingAfterDeath = guestClockControl.pending();
    await guestClockControl.advanceBy(10);
    return {controlled:ready.controlled,archive:ready.archive,origin:ready.bootTime===bootTime,
      wall:ticks[0]?.wall===wall+10,uptime:ticks.every(tick=>tick.now===start+10),ticks:ticks.map(tick=>tick.tick),advanced,pendingBeforeDeath,pendingAfterDeath,
      brokerTimer,pendingAfterAdvance:guestClockControl.pending()};
  } finally { worker.terminate(); broker.fail(pid,"clock fixture cleanup",NOT_CRASHED); URL.revokeObjectURL(url); packages.delete(pkg); }
}
